import { mapChild } from './persistent-core.as';
// The caller checks full key bytes after this read-only hash stage.
export function mapHashCandidateFrom(root: u32, hash: u32, shift: u32): u32 {
  while (root) {
    const kind = load<u32>(root);
    if (kind == 0 || kind == 2) return load<u32>(root + 4) == hash ? root : 0;
    root = mapChild(root, (hash >> shift) & 15); shift += 4;
  }
  return 0;
}
export function mapHashCandidate(root: u32, hash: u32): u32 { return mapHashCandidateFrom(root, hash, 0); }
// Resolve a bounded prefix of the hash once per active snapshot and hash prefix.
// A leaf reached early is valid at any remaining shift, including collisions.
export function mapHashPrefix(root: u32, hash: u32, bits: u32): u32 {
  for (let shift: u32 = 0; shift < bits && root; shift += 4) {
    const kind = load<u32>(root);
    if (kind == 0 || kind == 2) break;
    root = mapChild(root, (hash >> shift) & 15);
  }
  return root;
}
