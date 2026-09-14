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
