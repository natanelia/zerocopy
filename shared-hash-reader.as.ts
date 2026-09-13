// Read-only first stage for a cold lookup. Return the matching hash leaf or
// collision bucket; the caller MUST still compare the complete key bytes.
// It uses no shared scratch and is safe in independent attached workers.
export function mapHashCandidate(root: u32, hash: u32): u32 {
  let shift: u32 = 0;
  while (root) {
    const kind = load<u32>(root);
    if (kind == 0 || kind == 2) return load<u32>(root + 4) == hash ? root : 0;
    const bitmap = load<u32>(root + 4), bit: u32 = 1 << ((hash >> shift) & 15);
    if (!(bitmap & bit)) return 0;
    root = load<u32>(root + 16 + (<u32>popcnt(bitmap & (bit - 1))) * 4);
    shift += 4;
  }
  return 0;
}
