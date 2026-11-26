// spatial-id.ts
function checkSpatialId(id) {
  if (!Number.isInteger(id) || id < 0 || id > 4294967295)
    throw new RangeError("Expected a uint32 feature ID");
}

export { checkSpatialId };
