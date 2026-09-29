/** WebAssembly pages are 64 KiB. Keep reservations bounded on mobile engines. */
const PAGE_BYTES = 65536;
const MINIMUM_BYTES = 2 * PAGE_BYTES;
const MAXIMUM_BYTES = 0x7fff0000; // The allocator's existing address limit.
let maximumBytes = 256 * 1024 * 1024;

/** Set the growth limit for future arenas in this thread, before constructing data.
 * Existing arenas and attached shared memory keep their original limits.
 * A larger limit can reserve address space even when the initial buffer is small.
 */
export function configureMemory(options: { maximumBytes: number }): void {
  const value = options?.maximumBytes;
  if (!Number.isSafeInteger(value) || value < MINIMUM_BYTES || value > MAXIMUM_BYTES || value % PAGE_BYTES !== 0) {
    throw new RangeError('maximumBytes must be a multiple of 65536, between 131072 and 2147418112');
  }
  maximumBytes = value;
}

/** Internal: copy-only readers need no unused growth reservation. */
export function memoryDescriptor(copyBytes = 0, readOnly = false): WebAssembly.MemoryDescriptor {
  const initial = Math.max(2, Math.ceil(copyBytes / PAGE_BYTES));
  const maximum = readOnly && copyBytes ? initial : maximumBytes / PAGE_BYTES;
  if (initial > maximum || initial * PAGE_BYTES > MAXIMUM_BYTES) {
    throw new RangeError('Snapshot exceeds the configured arena memory limit');
  }
  return { initial, maximum, shared: true };
}
