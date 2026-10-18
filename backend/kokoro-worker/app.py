import io, os, re, subprocess, threading
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
import soundfile as sf
import torch
from kokoro_vietnamese.core import DEFAULT_CROSSFADE_MS, DEFAULT_HF_REPO_ID, SAMPLE_RATE, _download_or_resolve, merge_audio_chunks, resolve_voicepack_filename, split_text
import kokoro_vietnamese.onnx_cli as onnx_cli
from kokoro_vietnamese.onnx_cli import KokoroVietnameseONNX
from kokoro_vietnamese.onnx_utils import phonemes_to_input_ids, select_voice_style, speed_input
from sea_g2p import Normalizer
from vig2p.core import WORD_RE, _backend_output_to_text, create_backend, fix_phonemes, phonemize_text, tokenize_text

app = FastAPI()
TOKEN = os.environ.get("WORKER_TOKEN", "")
DEFAULT_VOICE = "mai_loan"
# Keep in sync with kokoroVoices in ../voices.go. storyvert is left out: its gender is unknown.
VOICES = ["diem_trinh", "hung_thinh", "mai_linh", "mai_loan", "manh_dung", "my_yen", "ngoc_huyen",
          "phat_tai", "thanh_dat", "thuc_trinh", "tuan_ngoc", "duc_an", "duc_duy"]
MODEL_VERSION = os.environ.get("MODEL_VERSION", "kokoro-vietnamese-a249afe-norm2")
# Loading the model takes seconds and ~1 GB, so it happens once and every request shares it: an ONNX Runtime
# session can run several inferences at once. PARALLEL sentences are read together, each with an equal share
# of the CPUs, which keeps the cores busy while another request is phonemizing or encoding MP3.
PARALLEL = max(1, int(os.environ.get("PARALLEL", "2")))
TTS = KokoroVietnameseONNX(voice=DEFAULT_VOICE)
_options = ort.SessionOptions()
_options.intra_op_num_threads = max(1, (os.cpu_count() or 1) // PARALLEL)
TTS.session = ort.InferenceSession(str(TTS.onnx_path), sess_options=_options, providers=["CPUExecutionProvider"])
# Voicepacks are ~0.5 MB each, so all are kept in memory and swapped per request.
PACKS = {v: torch.load(_download_or_resolve(DEFAULT_HF_REPO_ID, "", resolve_voicepack_filename(v, None)), map_location="cpu", weights_only=True)
         for v in VOICES}
SLOTS = threading.BoundedSemaphore(PARALLEL)
# vig2p reads digits as nothing, so numbers, dates, times, money and percents are spelled out first
# ("12/3/2024" -> "mười hai tháng ba năm hai nghìn không trăm hai mươi bốn"). This is the same
# sea-g2p normalizer the on-device voices use. It wraps foreign words in <en> tags, which are dropped.
NORMALIZER = Normalizer(lang="vi")

def normalize(text: str) -> str:
    return re.sub(r"</?en>", "", NORMALIZER.normalize(text))

G2P = create_backend()

def phonemize(text: str) -> str:
    """vig2p phonemizes word by word, so an unmarked word such as "do", "to" or "in" has no context
    and is read as English ("do" -> "đu"). sea-g2p picks the Vietnamese reading when it sees the
    whole sentence, so the words go through it together and each result is then fixed up the way
    vig2p does. If the word counts do not line up, plain vig2p is used."""
    tokens = tokenize_text(text)
    words = [t for t in tokens if WORD_RE.match(t)]
    raw = _backend_output_to_text(G2P.run(" ".join(words))).split() if words else []
    if len(raw) != len(words):
        return phonemize_text(text, backend=G2P)
    pairs = iter(zip(words, raw))
    out = []
    for t in tokens:
        if t.isspace():
            out.append(" ")
        elif WORD_RE.match(t):
            word, ph = next(pairs)
            out.append(fix_phonemes(ph, source_text=word))
        else:
            out.append(fix_phonemes(t))
    return "".join(out).strip()

# KokoroVietnameseONNX.synthesize looks phonemize up in its own module.
onnx_cli.phonemize = phonemize

def synthesize_audio(text: str, pack, speed: float) -> np.ndarray:
    """KokoroVietnameseONNX.synthesize with the voicepack passed in instead of set on the shared model, so
    requests in different voices can run at once."""
    chunks = []
    for chunk in split_text(text):
        ps = phonemize(chunk)
        if not ps:
            continue
        input_ids = phonemes_to_input_ids(ps, TTS.config["vocab"], context_length=TTS.context_length)
        waveform, _ = TTS.session.run(None, {"input_ids": input_ids, "ref_s": select_voice_style(pack, len(ps)), "speed": speed_input(speed)})
        chunks.append(np.asarray(waveform, dtype=np.float32).reshape(-1))
    return merge_audio_chunks(chunks, round(SAMPLE_RATE * DEFAULT_CROSSFADE_MS / 1000))

class Request(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.1, le=1.9)
    format: str = "mp3"

@app.get("/healthz")
def healthz(): return {"ok": True, "model": MODEL_VERSION, "voices": VOICES}

@app.post("/synthesize")
def synthesize(req: Request, x_worker_token: str | None = Header(default=None)):
    if TOKEN and x_worker_token != TOKEN: raise HTTPException(401, "unauthorized")
    if req.voice not in PACKS: raise HTTPException(400, "voice is not available")
    if req.format != "mp3": raise HTTPException(400, "format must be mp3")
    if not SLOTS.acquire(timeout=120): raise HTTPException(503, "worker busy")
    try:
        audio = synthesize_audio(normalize(req.text), PACKS[req.voice], req.speed)
    finally:
        SLOTS.release()
    if len(audio) == 0: raise HTTPException(422, "no audio generated")
    wav = io.BytesIO()
    sf.write(wav, audio, SAMPLE_RATE, format="WAV")
    mp3 = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"],
                         input=wav.getvalue(), capture_output=True, check=True, timeout=30).stdout
    return Response(content=mp3, media_type="audio/mpeg", headers={"X-Model-Version": MODEL_VERSION})

if __name__ == "__main__":
    import socket, uvicorn
    # One dual-stack socket: IPv6 for private networks, IPv4 for platform health checks.
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("::", int(os.environ.get("PORT", "8080"))))
    uvicorn.run(app, fd=sock.fileno())
