// VieNeu v3 Turbo running in this browser with onnxruntime-web: the same steps as the vieneu package's
// torch-free engine (vieneu/_v3_turbo_engine/onnx_runtime_lite.py, 3.8.3). The backbone reads the prompt and then
// one frame at a time; for each frame a one-layer acoustic decoder picks the 16 codes of the MOSS audio codec,
// channel by channel; the codec turns the codes into 48 kHz audio at the end. Embeddings, the speaker anchor,
// the output heads and the sampling run here in JavaScript, as they run in NumPy there.
import * as ort from 'onnxruntime-web/webgpu';
import { storedEntries } from '../archive/storedZip';
import { ByteLevelBpe, type TokenizerJson } from '../../domain/byteLevelBpe';
import { parseNpy } from '../../domain/npy';
import { ChannelWindow, sampleCode } from '../../domain/vieneuSampling';
import { GAP_SILENCE, maxExpectedFrames, phonemizeChunk, toChunks } from '../../domain/vieneuText';
import type { SeaG2pStages } from '../../domain/kokoroText';

export const VIENEU_SAMPLE_RATE = 48_000;
const MAX_NEW_FRAMES = 300;

interface Config {
  n_vq: number;
  hidden_size: number;
  num_hidden_layers: number;
  local_num_attention_heads: number;
  audio_pad_token_id: number;
  text_prompt_start_token_id: number;
  text_prompt_end_token_id: number;
  speech_generation_start_token_id: number;
  speech_generation_end_token_id: number;
  audio_ref_slot_token_id: number;
  default_style_token_id: number;
}

/** A preset voice: its x-vector and the codec codes of its reference clip, [frames][n_vq]. */
export interface VieneuVoice {
  speakerEmb: Float32Array;
  codes: number[][];
}

/** Everything the engine reads, as bytes: the graphs from the model's onnx_int8 folder, and the codec. */
export interface VieneuFiles {
  prefill: Uint8Array;
  decodeStep: Uint8Array;
  acoustic: Uint8Array;
  backboneData: Uint8Array;
  heads: ArrayBuffer;
  config: Config;
  tokenizer: TokenizerJson;
  codec: Uint8Array;
  codecData: Uint8Array;
}

export type Backend = 'webgpu' | 'wasm';

type Feeds = Record<string, ort.Tensor>;
const f32 = (data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims);
const i64 = (values: number[], dims: number[]) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);

export class VieneuEngine {
  private textEmb: Float32Array;
  private audioEmb: Float32Array;
  private xvec: { w: Float32Array; b: Float32Array; lnW: Float32Array; lnB: Float32Array; eps: number };
  private H: number;
  private nVq: number;
  private textVocab: number;
  private audioVocab: number;
  private L: number;
  private headsLoc: number;
  private headDimLoc: number;
  private tokenizer: ByteLevelBpe;

  private constructor(
    private cfg: Config,
    heads: ArrayBuffer,
    tokenizer: TokenizerJson,
    private pre: ort.InferenceSession,
    private dec: ort.InferenceSession,
    private ac: ort.InferenceSession,
    private codec: ort.InferenceSession,
    private g2p: SeaG2pStages,
    readonly backend: Backend,
  ) {
    const arrays = storedEntries(heads, n => n.endsWith('.npy'));
    const npy = (name: string) => {
      const bytes = arrays.get(`${name}.npy`);
      if (!bytes) throw new Error(`heads have no ${name}`);
      return parseNpy(bytes);
    };
    const text = npy('text_emb');
    const audio = npy('audio_emb');
    this.textEmb = text.data;
    this.audioEmb = audio.data;
    [this.textVocab, this.H] = text.shape;
    [this.nVq, this.audioVocab] = audio.shape;
    this.xvec = { w: npy('xvec_w').data, b: npy('xvec_b').data, lnW: npy('xvec_ln_w').data, lnB: npy('xvec_ln_b').data, eps: npy('xvec_ln_eps').data[0] };
    this.L = cfg.num_hidden_layers;
    this.headsLoc = cfg.local_num_attention_heads;
    this.headDimLoc = this.H / this.headsLoc;
    this.tokenizer = new ByteLevelBpe(tokenizer);
  }

  /** Creates the sessions, on WebGPU or on WebAssembly. Both backbone graphs share one weights file. */
  static async load(files: VieneuFiles, g2p: SeaG2pStages, backends: Backend[] = ['wasm']): Promise<VieneuEngine> {
    const failures: string[] = [];
    for (const backend of backends) {
      if (backend === 'webgpu' && !('gpu' in navigator)) continue;
      try {
        const opts = (data: Uint8Array, path: string): ort.InferenceSession.SessionOptions => ({
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          externalData: [{ path, data }],
        });
        // One at a time: onnxruntime-web copies each graph's weights into its own memory as it builds it.
        const pre = await ort.InferenceSession.create(files.prefill, opts(files.backboneData, 'vieneu_backbone_shared.data'));
        const dec = await ort.InferenceSession.create(files.decodeStep, opts(files.backboneData, 'vieneu_backbone_shared.data'));
        const ac = await ort.InferenceSession.create(files.acoustic, { executionProviders: [backend], graphOptimizationLevel: 'all' });
        const codec = await ort.InferenceSession.create(files.codec, opts(files.codecData, 'moss_audio_tokenizer_decode_shared.data'));
        return new VieneuEngine(files.config, files.heads, files.tokenizer, pre, dec, ac, codec, g2p, backend);
      } catch (e) {
        failures.push(`${backend}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`VieNeu would not load (${failures.join('; ')})`);
  }

  /** How many seconds of speech this computer makes per second, on a typical caption sentence. */
  async benchmark(voice: VieneuVoice): Promise<number> {
    const text = 'Hôm nay mình sẽ cùng nhau tìm hiểu cách máy chủ này hoạt động, từng bước một.';
    await this.synthesize(text, voice); // the first run warms caches
    const t0 = performance.now();
    const samples = await this.synthesize(text, voice);
    return samples.length / VIENEU_SAMPLE_RATE / ((performance.now() - t0) / 1000);
  }

  /** Vietnamese text to 48 kHz mono samples, chunk by chunk with the pause each boundary needs. */
  async synthesize(text: string, voice: VieneuVoice): Promise<Float32Array> {
    const { chunks, gaps } = toChunks(text, this.g2p);
    const anchor = this.speakerAnchor(voice.speakerEmb);
    const parts: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const wav = await this.synthesizeChunk(phonemizeChunk(chunks[i], this.g2p), voice.codes, anchor);
      if (i > 0) {
        const pad = pausePadSamples(parts.at(-1)!, wav, GAP_SILENCE[gaps[i - 1]]);
        if (pad > 0) parts.push(new Float32Array(pad));
      }
      parts.push(wav);
    }
    return concat(parts);
  }

  private async synthesizeChunk(phonemes: string, refCodes: number[][], anchor: Float32Array): Promise<Float32Array> {
    const { nVq, H } = this;
    const pad = this.cfg.audio_pad_token_id;
    const sgs = this.cfg.speech_generation_start_token_id;
    const maxFrames = Math.min(MAX_NEW_FRAMES, maxExpectedFrames(phonemes));

    // The prompt: style, text start, phoneme tokens, text end, then the reference clip's frames.
    const textIds = [this.cfg.default_style_token_id, this.cfg.text_prompt_start_token_id, ...this.tokenizer.encode(phonemes), this.cfg.text_prompt_end_token_id];
    const rows: number[][] = textIds.map(id => [id, ...new Array<number>(nVq).fill(pad)]);
    for (const frame of refCodes) rows.push([this.cfg.audio_ref_slot_token_id, ...frame]);
    const prompt = this.embedRows(rows, anchor);

    const out = await this.pre.run({ inputs_embeds: f32(prompt, [1, rows.length, H]) });
    let past = this.pastOf(out, this.L);
    let hidden = out.hidden.data as Float32Array;
    let h = hidden.slice((rows.length - 1) * H, rows.length * H);
    const recent = Array.from({ length: nVq }, () => new ChannelWindow());
    const frames: number[][] = [];
    for (let t = 0; t < maxFrames; t++) {
      const { codes, eos } = await this.acousticFrame(h, recent);
      frames.push(codes);
      if (eos) break;
      const feed: Feeds = { inputs_embeds: f32(this.embedRows([[sgs, ...codes]], anchor), [1, 1, H]), position_ids: i64([rows.length + t], [1, 1]) };
      for (let i = 0; i < this.L; i++) {
        feed[`past_k_${i}`] = past.k[i];
        feed[`past_v_${i}`] = past.v[i];
      }
      const step = await this.dec.run(feed);
      past = this.pastOf(step, this.L);
      hidden = step.hidden.data as Float32Array;
      h = hidden.slice(0, H);
    }
    return this.decode(frames);
  }

  /** One frame's 16 codes, channel by channel, and whether the model asked to stop. */
  private async acousticFrame(h: Float32Array, recent: ChannelWindow[]): Promise<{ codes: number[]; eos: boolean }> {
    const H = this.H;
    const tok = new Float32Array(2 * H);
    tok.set(h);
    tok.set(this.textEmb.subarray(this.cfg.speech_generation_start_token_id * H, (this.cfg.speech_generation_start_token_id + 1) * H), H);
    const empty = f32(new Float32Array(0), [1, this.headsLoc, 0, this.headDimLoc]);
    let out = await this.ac.run({ token_emb: f32(tok, [1, 2, H]), position_ids: i64([0, 1], [1, 2]), past_k_0: empty, past_v_0: empty });
    let hidden = out.hidden.data as Float32Array;
    const slot0 = hidden.slice(0, H);
    const codes: number[] = [this.pick(0, hidden.subarray(H, 2 * H), recent[0])];
    for (let ch = 1; ch < this.nVq; ch++) {
      const emb = this.audioRow(ch - 1, codes[ch - 1]).slice();
      out = await this.ac.run({ token_emb: f32(emb, [1, 1, H]), position_ids: i64([ch + 1], [1, 1]), past_k_0: out.present_k_0, past_v_0: out.present_v_0 });
      hidden = out.hidden.data as Float32Array;
      codes.push(this.pick(ch, hidden.subarray(0, H), recent[ch]));
    }
    // The text head on the first slot says whether speech is over.
    const eos = argmaxDot(slot0, this.textEmb, this.textVocab, H) === this.cfg.speech_generation_end_token_id;
    return { codes, eos };
  }

  private pick(ch: number, vec: Float32Array, recent: ChannelWindow): number {
    const H = this.H;
    const V = this.audioVocab;
    const base = ch * V * H;
    const logits = new Float32Array(V);
    dotRows(vec, this.audioEmb, base, V, H, logits);
    const code = sampleCode(logits, recent);
    recent.add(code);
    return code;
  }

  private audioRow(ch: number, code: number): Float32Array {
    const o = (ch * this.audioVocab + code) * this.H;
    return this.audioEmb.subarray(o, o + this.H);
  }

  /** Rows of [text id, code per channel] to embeddings: text embedding plus each non-pad code's, plus the anchor. */
  private embedRows(rows: number[][], anchor: Float32Array): Float32Array {
    const H = this.H;
    const out = new Float32Array(rows.length * H);
    rows.forEach((row, r) => {
      const dst = out.subarray(r * H, (r + 1) * H);
      dst.set(this.textEmb.subarray(row[0] * H, (row[0] + 1) * H));
      for (let ch = 0; ch < this.nVq; ch++) {
        const id = row[ch + 1];
        if (id === this.cfg.audio_pad_token_id) continue;
        const e = this.audioRow(ch, id);
        for (let i = 0; i < H; i++) dst[i] += e[i];
      }
      for (let i = 0; i < H; i++) dst[i] += anchor[i];
    });
    return out;
  }

  /** The 192-d x-vector through xvec_proj: a linear layer, then layer norm. */
  private speakerAnchor(emb: Float32Array): Float32Array {
    const { w, b, lnW, lnB, eps } = this.xvec;
    const H = this.H;
    const D = emb.length;
    const v = new Float32Array(H);
    for (let o = 0; o < H; o++) {
      let s = b[o];
      for (let i = 0; i < D; i++) s += emb[i] * w[o * D + i];
      v[o] = s;
    }
    let mean = 0;
    for (const x of v) mean += x;
    mean /= H;
    let variance = 0;
    for (const x of v) variance += (x - mean) ** 2;
    variance /= H;
    const sd = Math.sqrt(variance + eps);
    for (let o = 0; o < H; o++) v[o] = ((v[o] - mean) / sd) * lnW[o] + lnB[o];
    return v;
  }

  private pastOf(out: ort.InferenceSession.OnnxValueMapType, layers: number) {
    const k: ort.Tensor[] = [];
    const v: ort.Tensor[] = [];
    for (let i = 0; i < layers; i++) {
      k.push(out[`present_k_${i}`] as ort.Tensor);
      v.push(out[`present_v_${i}`] as ort.Tensor);
    }
    return { k, v };
  }

  /** Codes [frames][n_vq] to audio: the codec returns two channels, which are averaged. */
  private async decode(frames: number[][]): Promise<Float32Array> {
    if (!frames.length) return new Float32Array();
    const codes = Int32Array.from(frames.flat());
    const out = await this.codec.run({
      audio_codes: new ort.Tensor('int32', codes, [1, frames.length, this.nVq]),
      audio_code_lengths: new ort.Tensor('int32', Int32Array.of(frames.length), [1]),
    });
    const audio = out.audio;
    const [, channels, length] = audio.dims;
    const n = Number((out.audio_lengths.data as Int32Array | BigInt64Array)[0]);
    const data = audio.data as Float32Array;
    const wav = new Float32Array(Math.min(n, length));
    for (let c = 0; c < channels; c++) for (let i = 0; i < wav.length; i++) wav[i] += data[c * length + i] / channels;
    return wav;
  }
}

/** out[r] = vec · table[base + r*H ..], with four running sums so the loop is not one long dependency chain. */
function dotRows(vec: Float32Array, table: Float32Array, base: number, rows: number, H: number, out: Float32Array) {
  for (let r = 0; r < rows; r++) {
    const o = base + r * H;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let i = 0; i < H; i += 4) {
      s0 += vec[i] * table[o + i];
      s1 += vec[i + 1] * table[o + i + 1];
      s2 += vec[i + 2] * table[o + i + 2];
      s3 += vec[i + 3] * table[o + i + 3];
    }
    out[r] = s0 + s1 + s2 + s3;
  }
}

function argmaxDot(vec: Float32Array, table: Float32Array, rows: number, H: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    const o = r * H;
    for (let i = 0; i < H; i++) s += vec[i] * table[o + i];
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// core_utils.edge_silence and pause_pad_samples: silence counts as a 10 ms window whose mean |x| is under -45 dB.
function edgeSilence(wav: Float32Array, sr = VIENEU_SAMPLE_RATE): [number, number] {
  const win = Math.max(1, Math.floor(0.01 * sr));
  const nWin = Math.floor(wav.length / win);
  if (nWin === 0) return [wav.length, 0];
  const thresh = 10 ** (-45 / 20);
  let first = -1;
  let last = -1;
  for (let w = 0; w < nWin; w++) {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win; i++) s += Math.abs(wav[i]);
    if (s / win > thresh) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return [wav.length, 0];
  return [first * win, wav.length - (last + 1) * win];
}

/** Zeros to put between two chunks so the silence there, counting what each already has, lasts `pauseS`. */
export function pausePadSamples(prev: Float32Array, next: Float32Array, pauseS: number, sr = VIENEU_SAMPLE_RATE): number {
  const [leadPrev, tailPrev] = edgeSilence(prev, sr);
  const tail = leadPrev === prev.length ? prev.length : tailPrev;
  const [lead] = edgeSilence(next, sr);
  return Math.max(0, Math.floor(pauseS * sr) - tail - lead);
}
