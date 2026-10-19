// numpy's .npy format, for the arrays VieNeu ships in its .npz: little-endian float32, C order.

export interface NpyArray {
  shape: number[];
  data: Float32Array;
}

/** A .npy file's array. Only '<f4' in C order is read; anything else is an error. */
export function parseNpy(bytes: Uint8Array): NpyArray {
  const magic = String.fromCharCode(...bytes.subarray(1, 6));
  if (bytes[0] !== 0x93 || magic !== 'NUMPY') throw new Error('not a .npy file');
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = new TextDecoder().decode(bytes.subarray(major === 1 ? 10 : 12, start));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  if (descr !== '<f4') throw new Error(`.npy dtype ${descr} is not float32`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error('.npy in Fortran order');
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  // Copied out so the array is aligned and does not keep the whole archive alive.
  const data = new Float32Array(bytes.slice(start, start + count * 4).buffer);
  return { shape, data };
}
