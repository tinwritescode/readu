// Reads files stored uncompressed in a zip archive, which is how torch saves a .pt file and numpy a .npz.

/** The bytes of every stored (uncompressed) entry whose name passes `wanted`, by name. */
export function storedEntries(buf: ArrayBuffer, wanted: (name: string) => boolean): Map<string, Uint8Array> {
  const view = new DataView(buf);
  // The end-of-central-directory record is in the last 64 KiB plus 22 bytes.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buf, p + 46, nameLen));
    if (wanted(name)) {
      if (method !== 0) throw new Error(`${name} is compressed`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      out.set(name, new Uint8Array(buf, start, size));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
