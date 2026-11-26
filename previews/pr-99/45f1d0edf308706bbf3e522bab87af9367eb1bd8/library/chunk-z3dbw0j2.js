// xy-bounds.ts
function checkBounds(box, finite) {
  if (!Array.isArray(box) || box.length !== 4)
    throw new TypeError("Expected four XY bounds");
  for (const value of box) {
    if (typeof value !== "number")
      throw new TypeError("Expected numeric XY bounds");
    if (Number.isNaN(value) || finite && !Number.isFinite(value))
      throw new RangeError("Invalid XY bounds");
  }
  if (box[0] > box[2] || box[1] > box[3])
    throw new RangeError("Reversed XY bounds");
}

export { checkBounds };
