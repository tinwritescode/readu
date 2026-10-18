import io, os, subprocess, threading
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
import soundfile as sf
import torch
from kokoro_vietnamese.core import DEFAULT_HF_REPO_ID, SAMPLE_RATE, _download_or_resolve, resolve_voicepack_filename
from kokoro_vietnamese.onnx_cli import KokoroVietnameseONNX

app = FastAPI()
TOKEN = os.environ.get("WORKER_TOKEN", "")
DEFAULT_VOICE = "mai_loan"
# Keep in sync with kokoroVoices in ../voices.go. storyvert is left out: its gender is unknown.
VOICES = ["diem_trinh", "hung_thinh", "mai_linh", "mai_loan", "manh_dung", "my_yen", "ngoc_huyen",
          "phat_tai", "thanh_dat", "thuc_trinh", "tuan_ngoc", "duc_an", "duc_duy"]
MODEL_VERSION = os.environ.get("MODEL_VERSION", "kokoro-vietnamese-a249afe")
# Loading the model takes seconds and ~1 GB, so it happens once; the lock keeps one inference at a time.
TTS = KokoroVietnameseONNX(voice=DEFAULT_VOICE)
# Voicepacks are ~0.5 MB each, so all are kept in memory and swapped per request.
PACKS = {v: torch.load(_download_or_resolve(DEFAULT_HF_REPO_ID, "", resolve_voicepack_filename(v, None)), map_location="cpu", weights_only=True)
         for v in VOICES}
LOCK = threading.Lock()

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
    if not LOCK.acquire(timeout=120): raise HTTPException(503, "worker busy")
    try:
        TTS.voicepack = PACKS[req.voice]
        audio, _ = TTS.synthesize(req.text, speed=req.speed)
    finally:
        LOCK.release()
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
