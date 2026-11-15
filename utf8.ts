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

const nativeDecode = TextDecoder.prototype.decode;
const READ_SCRATCH_BYTES = 65536;
let readScratch: Uint8Array | undefined;
let readingShared = false;

function decodeSharedUtf8(decoder: TextDecoder, bytes: Uint8Array): string {
  if (readingShared || bytes.byteLength > READ_SCRATCH_BYTES) {
    const input = bytes.slice();
    return decoder.decode(input);
  }
  readingShared = true;
  try {
    const scratch = readScratch ??= new Uint8Array(READ_SCRATCH_BYTES);
    scratch.set(bytes);
    const input = scratch.subarray(0, bytes.byteLength);
    // Preserve the original copy-before-getter order. A replaced decoder may
    // retain its argument or reenter; only the native method borrows scratch.
    const decode = decoder.decode;
    return Reflect.apply(decode, decoder, [decode === nativeDecode ? input : input.slice()]);
  } finally {
    readingShared = false;
  }
}

export function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {
  if (!acceptsSharedInput && bytes.buffer instanceof SharedArrayBuffer) return decodeSharedUtf8(decoder, bytes);
  return decoder.decode(bytes);
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
