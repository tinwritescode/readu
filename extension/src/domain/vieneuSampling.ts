// How VieNeu v3 Turbo picks each audio code (onnx_runtime_lite._sample and rep_history): a repetition penalty on
// codes the channel used in its last 64 frames, then temperature, top-k and top-p.

export const SAMPLING = { temperature: 0.8, topK: 25, topP: 0.95, repetitionPenalty: 1.2, repetitionWindow: 64 };

/** The codes one codebook produced in its last `window` frames, with how often each appears. */
export class ChannelWindow {
  private seen = new Map<number, number>();
  private order: number[] = [];

  constructor(private window = SAMPLING.repetitionWindow) {}

  add(code: number) {
    this.seen.set(code, (this.seen.get(code) ?? 0) + 1);
    if (this.window <= 0) return;
    this.order.push(code);
    if (this.order.length > this.window) {
      const old = this.order.shift()!;
      const n = this.seen.get(old)!;
      if (n <= 1) this.seen.delete(old);
      else this.seen.set(old, n - 1);
    }
  }

  codes(): Iterable<number> {
    return this.seen.keys();
  }
}

/** Picks a code from `logits` (changed in place). `random` returns [0, 1). */
export function sampleCode(logits: Float32Array, recent: ChannelWindow | null, random: () => number = Math.random): number {
  const { temperature, topK, topP, repetitionPenalty } = SAMPLING;
  if (recent && repetitionPenalty !== 1) {
    for (const i of recent.codes()) logits[i] = logits[i] < 0 ? logits[i] * repetitionPenalty : logits[i] / repetitionPenalty;
  }
  // The k best, best first. k is small, so an insertion pass beats sorting the whole vocabulary.
  const k = Math.min(topK, logits.length);
  const idx = new Int32Array(k).fill(-1);
  const val = new Float32Array(k).fill(-Infinity);
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i];
    if (v <= val[k - 1]) continue;
    let j = k - 1;
    while (j > 0 && val[j - 1] < v) {
      val[j] = val[j - 1];
      idx[j] = idx[j - 1];
      j--;
    }
    val[j] = v;
    idx[j] = i;
  }
  const p = new Float64Array(k);
  let sum = 0;
  for (let j = 0; j < k; j++) {
    p[j] = Math.exp((val[j] - val[0]) / temperature);
    sum += p[j];
  }
  // Nucleus: keep a candidate while the probability before it is under topP.
  let kept = 0;
  let before = 0;
  for (let j = 0; j < k; j++) {
    const pj = p[j] / sum;
    if (before < topP) kept += p[j];
    else p[j] = 0;
    before += pj;
  }
  let r = random() * kept;
  for (let j = 0; j < k; j++) {
    r -= p[j];
    if (r < 0 && p[j] > 0) return idx[j];
  }
  return idx[0];
}
