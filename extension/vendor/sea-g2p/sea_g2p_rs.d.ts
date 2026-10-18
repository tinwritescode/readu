/* tslint:disable */
/* eslint-disable */

export class SeaG2p {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Takes the bytes of `sea_g2p.bin`. They are kept for the life of the page and shared by both stages.
     */
    constructor(dict: Uint8Array);
    /**
     * Normalisation alone.
     */
    normalize(text: string, punc_norm: boolean): string;
    /**
     * Text to phonemes: normalise, then phonemise.
     */
    phonemize(text: string, punc_norm: boolean): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_seag2p_free: (a: number, b: number) => void;
    readonly seag2p_new: (a: number, b: number) => [number, number, number];
    readonly seag2p_normalize: (a: number, b: number, c: number, d: number) => [number, number];
    readonly seag2p_phonemize: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
