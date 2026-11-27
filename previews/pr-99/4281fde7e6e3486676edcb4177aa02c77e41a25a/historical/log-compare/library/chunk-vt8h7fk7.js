// spatial-id.ts
function checkSpatialId(id) {
  if (!Number.isInteger(id) || id < 0 || id > 4294967295)
    throw new RangeError("Expected a uint32 feature ID");
}
function lowerBoundUint32(values, target) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target)
      low = mid + 1;
    else
      high = mid;
  }
  return low;
}

export { checkSpatialId, lowerBoundUint32 };
