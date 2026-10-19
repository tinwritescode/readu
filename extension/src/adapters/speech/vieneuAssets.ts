// The files VieNeu v3 Turbo needs to read on this computer, downloaded once into Cache Storage: the int8
// graphs from the model's onnx_int8 folder, the MOSS audio codec's decoder, and the sea-g2p dictionary
// (shared with Kokoro, so it is downloaded once for both). The preset voices ship with the extension.
import voicesFile from '../../../vendor/vieneu/voices_v3_turbo.json';
import { AssetSet } from './assetCache';
import { DICT_URL } from './kokoroAssets';
import type { VieneuFiles, VieneuVoice } from './vieneuEngine';

const MODEL = 'https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/resolve/61b85e3d937fbbacb387714180e8182823512523/onnx_int8';
const CODEC = 'https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX/resolve/ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae';

const URLS = {
  prefill: `${MODEL}/vieneu_prefill.onnx`,
  decodeStep: `${MODEL}/vieneu_decode_step.onnx`,
  acoustic: `${MODEL}/vieneu_acoustic_cached.onnx`,
  backboneData: `${MODEL}/vieneu_backbone_shared.data`,
  heads: `${MODEL}/vieneu_v3_heads.npz`,
  config: `${MODEL}/config.json`,
  tokenizer: `${MODEL}/tokenizer.json`,
  codec: `${CODEC}/moss_audio_tokenizer_decode_full.onnx`,
  codecData: `${CODEC}/moss_audio_tokenizer_decode_shared.data`,
};

export const VIENEU = new AssetSet('readu-vieneu-v1', [
  { url: URLS.prefill, bytes: 1_090_823 },
  { url: URLS.decodeStep, bytes: 1_062_040 },
  { url: URLS.acoustic, bytes: 7_207_223 },
  { url: URLS.backboneData, bytes: 103_891_968 },
  { url: URLS.heads, bytes: 52_219_622 },
  { url: URLS.config, bytes: 2_152 },
  { url: URLS.tokenizer, bytes: 22_320 },
  { url: URLS.codec, bytes: 681_902 },
  { url: URLS.codecData, bytes: 44_198_912 },
  { url: DICT_URL, bytes: 62_829_820 },
]);

/** The engine's files, read from Cache Storage. */
export async function readVieneuFiles(): Promise<VieneuFiles> {
  const bytes = async (url: string) => new Uint8Array(await VIENEU.read(url));
  const json = async (url: string) => JSON.parse(new TextDecoder().decode(await VIENEU.read(url)));
  return {
    prefill: await bytes(URLS.prefill),
    decodeStep: await bytes(URLS.decodeStep),
    acoustic: await bytes(URLS.acoustic),
    backboneData: await bytes(URLS.backboneData),
    heads: await VIENEU.read(URLS.heads),
    config: await json(URLS.config),
    tokenizer: await json(URLS.tokenizer),
    codec: await bytes(URLS.codec),
    codecData: await bytes(URLS.codecData),
  };
}

interface Preset {
  speaker_emb: number[];
  codes: number[][];
}

/** The codebook-0 code the old encoder left on a padded last frame; the package drops that frame on load. */
const ENCODER_PAD_CODE = 455;

/** A preset voice by name, as the vieneu package loads it (strip_encoder_pad_frame). */
export function vieneuVoice(name: string): VieneuVoice {
  const preset = (voicesFile.presets as Record<string, Preset>)[name];
  if (!preset) throw new Error(`VieNeu has no voice ${name}`);
  let codes = preset.codes;
  if (codes.length > 1 && codes.at(-1)![0] === ENCODER_PAD_CODE) codes = codes.slice(0, -1);
  return { speakerEmb: Float32Array.from(preset.speaker_emb), codes };
}
