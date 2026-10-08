// Some runtimes reject shared views in TextDecoder. Probe once per module, not
// once per value. Only the bytes needed for decoding are copied in that case.
const acceptsSharedInput = (() => {
  try {
    new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(1)));
    return true;
  } catch {
    return false;
  }
})();

export function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {
  const input = !acceptsSharedInput && bytes.buffer instanceof SharedArrayBuffer
    ? bytes.slice()
    : bytes;
  return decoder.decode(input);
}

const supportsEncodeInto = typeof TextEncoder.prototype.encodeInto === 'function';
let writeScratch: Uint8Array | undefined;

/** Temporary bytes for one synchronous writer call. Finish all serialization
 * callbacks before calling this helper, then copy its result before another
 * call. The normal buffer works in engines that reject shared encoder output.
 * Large text and engines without encodeInto keep the allocating native path.
 */
export function encodeUtf8ForWrite(encoder: TextEncoder, text: string): Uint8Array {
  if (!supportsEncodeInto || text.length > 49152) return encoder.encode(text);
  const scratch = writeScratch ??= new Uint8Array(49152);
  const result = encoder.encodeInto(text, scratch);
  return result.read === text.length ? scratch.subarray(0, result.written) : encoder.encode(text);
}
