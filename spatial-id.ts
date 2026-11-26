export function checkSpatialId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RangeError('Expected a uint32 feature ID');
}
