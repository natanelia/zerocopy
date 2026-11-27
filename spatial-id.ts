export function checkSpatialId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RangeError('Expected a uint32 feature ID');
}

/** First position whose unsigned value is at least the target, or length. */
export function lowerBoundUint32(values: Uint32Array, target: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
