import Flatbush from 'flatbush';
import { SharedMap } from './shared-map.ts';
import { json, type JsonType } from './types.ts';
import { checkBounds, packedBoundsXY, type BoundsXY } from './xy-bounds.ts';
import { lineStringPresent, validateLineStringBuffersXY, type LineStringBuffersXY } from './line-string-buffers.ts';
import { checkSpatialId } from './spatial-id.ts';

export interface SpatialFeature { readonly id: number; readonly bounds: BoundsXY }
export interface SpatialLineStringBatch {
  readonly paths: LineStringBuffersXY;
  /** A stable uint32 feature handle for each row, including missing and empty paths. */
  readonly ids: Uint32Array | readonly number[];
}
export interface SpatialEdit { readonly id: number; readonly bounds: BoundsXY | null }
export interface SpatialChange { readonly revision: number; readonly bounds: BoundsXY | null }
export type SpatialChanges = SharedMap<JsonType<SpatialChange>>;

/** Structured-clone this sidecar to readers. Its backing bytes are shared and must stay immutable. */
export interface SpatialIndex {
  readonly format: 1;
  readonly revision: number;
  readonly ids: Uint32Array<SharedArrayBuffer>;
  readonly buffer: SharedArrayBuffer | null;
}

/** Immutable sidecar for repeated viewport searches of one edited tile snapshot. */
export interface PreparedSpatialQuery {
  readonly format: 'spatial-query-v1';
  readonly revision: number;
  readonly base: SpatialIndex;
  /** Sorted stable IDs of all features that shadow an entry in the base, including deletions. */
  readonly changedIds: Uint32Array<SharedArrayBuffer>;
  /** Bounds of live changes at the captured revision. */
  readonly updates: SpatialIndex;
}

function checkRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Expected a nonnegative safe spatial revision');
}

const trees = new WeakMap<SpatialIndex, Flatbush>();

function finishIndex(tree: Flatbush | undefined, ids: Uint32Array<SharedArrayBuffer>, revision: number): SpatialIndex {
  tree?.finish();
  const base: SpatialIndex = Object.freeze({ format: 1, revision, ids, buffer: tree ? tree.data as SharedArrayBuffer : null });
  if (tree) trees.set(base, tree);
  return base;
}

/** Build a packed, read-only base over finite planar bounding boxes. */
export function buildSpatialIndex(features: readonly SpatialFeature[], revision = 0): SpatialIndex {
  checkRevision(revision);
  const ids = new Uint32Array(new SharedArrayBuffer(features.length * 4));
  const tree = features.length ? new Flatbush(features.length, 16, Float64Array, SharedArrayBuffer) : undefined;
  const seen = new Set<number>();
  for (const { id, bounds } of features) {
    checkSpatialId(id);
    checkBounds(bounds, true);
    if (seen.has(id)) throw new RangeError('Duplicate spatial feature ID: ' + id);
    seen.add(id);
    ids[tree!.add(...bounds)] = id;
  }
  return finishIndex(tree, ids, revision);
}

/** Build a shared base directly from packed XY batches. Only complete finite vertices contribute to each envelope. */
export function buildLineStringIndex(batches: readonly SpatialLineStringBatch[], revision = 0): SpatialIndex {
  checkRevision(revision);
  // Flatbush needs the exact number of boxes. Stop counting each present row
  // at its first finite vertex, then write its bounds directly into the tree.
  let count = 0;
  for (const { paths, ids } of batches) {
    validateLineStringBuffersXY(paths);
    const { offsets, coordinates, validity } = paths;
    if (ids.length !== offsets.length - 1) throw new RangeError('Expected one spatial feature ID per LineString row');
    for (let row = 0; row < ids.length; row++) {
      if (!lineStringPresent(validity, row)) continue;
      const end = offsets[row + 1] * 2;
      for (let i = offsets[row] * 2; i < end; i += 2) {
        if (Number.isFinite(coordinates[i]) && Number.isFinite(coordinates[i + 1])) {
          count++;
          break;
        }
      }
    }
  }
  const handles = new Uint32Array(new SharedArrayBuffer(count * 4));
  const tree = count ? new Flatbush(count, 16, Float64Array, SharedArrayBuffer) : undefined;
  const seen = new Set<number>();
  for (const { paths: { offsets, coordinates, validity }, ids } of batches) {
    for (let row = 0; row < ids.length; row++) {
      const id = ids[row];
      checkSpatialId(id);
      if (seen.has(id)) throw new RangeError('Duplicate spatial feature ID: ' + id);
      seen.add(id);
      if (!tree || offsets[row] === offsets[row + 1] || !lineStringPresent(validity, row)) continue;
      const bounds = packedBoundsXY(coordinates, offsets[row] * 2, offsets[row + 1] * 2, true);
      if (bounds[0] !== Infinity) handles[tree.add(...bounds)] = id;
    }
  }
  return finishIndex(tree, handles, revision);
}

/** Stage one edit batch. A null box deletes a feature, and the last edit to an ID in a batch wins. */
export function applySpatialEdits(previous: SpatialChanges | undefined, revision: number, edits: readonly SpatialEdit[]): SpatialChanges {
  checkRevision(revision);
  const changes = previous ?? new SharedMap(json<SpatialChange>());
  const batch = new Map<string, SpatialChange>();
  for (const { id, bounds } of edits) {
    checkSpatialId(id);
    if (bounds !== null) checkBounds(bounds, true);
    batch.set(String(id), { revision, bounds });
  }
  const writes: [string, SpatialChange][] = [];
  for (const [key, change] of batch) {
    const last = changes.get(key);
    if (last && last.revision >= revision) {
      if (last.revision === revision && (last.bounds === change.bounds ||
          (last.bounds && change.bounds && last.bounds.every((v, i) => v === change.bounds![i])))) continue;
      throw new RangeError('Conflicting or older spatial edit for feature ' + key);
    }
    writes.push([key, change]);
  }
  return changes.setMany(writes);
}

function treeFor(base: SpatialIndex): Flatbush | undefined {
  let tree = trees.get(base);
  if (!tree) {
    checkRevision(base.revision);
    if (base.format !== 1 || !(base.ids instanceof Uint32Array) || !(base.ids.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError('Invalid shared spatial index');
    }
    if (base.buffer !== null) {
      if (!(base.buffer instanceof SharedArrayBuffer)) throw new TypeError('Expected shared Flatbush storage');
      tree = Flatbush.from(base.buffer);
      if (tree.numItems !== base.ids.length) throw new RangeError('Spatial index and feature ID count differ');
      trees.set(base, tree);
    } else if (base.ids.length) throw new RangeError('Missing spatial index for feature IDs');
  }
  return tree;
}

function collectChanges(base: SpatialIndex, changes: SpatialChanges, revision: number) {
  checkRevision(revision);
  if (revision < base.revision) throw new RangeError('Cannot capture changes before the base revision');
  const edits = new Map<number, BoundsXY | null>();
  let liveCount = 0;
  for (const [key, change] of changes.entries()) {
    checkRevision(change.revision);
    if (change.revision > revision) throw new RangeError('Spatial overlay is newer than the requested revision');
    if (change.revision <= base.revision) continue;
    const id = Number(key);
    checkSpatialId(id);
    if (String(id) !== key) throw new TypeError('Expected a canonical spatial feature ID');
    if (change.bounds !== null) {
      checkBounds(change.bounds, true);
      liveCount++;
    }
    edits.set(id, change.bounds);
  }
  return { edits, liveCount };
}

/** Index just the edits for repeated queries. The packed base buffers are reused. */
export function prepareSpatialQuery(base: SpatialIndex, changes: SpatialChanges, revision: number): PreparedSpatialQuery {
  treeFor(base);
  const { edits, liveCount } = collectChanges(base, changes, revision);
  const changedIds = new Uint32Array(new SharedArrayBuffer(edits.size * 4));
  const liveIds = new Uint32Array(new SharedArrayBuffer(liveCount * 4));
  const tree = liveCount ? new Flatbush(liveCount, 16, Float64Array, SharedArrayBuffer) : undefined;
  let i = 0;
  for (const [id, bounds] of edits) {
    changedIds[i++] = id;
    if (bounds) liveIds[tree!.add(...bounds)] = id;
  }
  changedIds.sort();
  return Object.freeze({ format: 'spatial-query-v1', revision, base, changedIds, updates: finishIndex(tree, liveIds, revision) });
}

function containsId(ids: Uint32Array, id: number): boolean {
  let low = 0, high = ids.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ids[mid] < id) low = mid + 1;
    else high = mid;
  }
  return ids[low] === id;
}

function checkChangedIds(ids: Uint32Array): void {
  if (!(ids instanceof Uint32Array) || !(ids.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError('Expected shared spatial change IDs');
  }
}

/** Build a replacement from a captured base and overlay without decoding feature metadata. */
export function rebuildSpatialIndex(base: SpatialIndex, changes: SpatialChanges, revision: number): SpatialIndex {
  const tree = treeFor(base);
  const { edits, liveCount } = collectChanges(base, changes, revision);
  if (!edits.size) {
    if (revision === base.revision) return base;
    const next = Object.freeze({ ...base, revision });
    if (tree) trees.set(next, tree);
    return next;
  }
  // Replaced base entries are omitted. Each live edit contributes one entry.
  let count = base.ids.length + liveCount;
  for (const id of base.ids) if (edits.has(id)) count--;
  const ids = new Uint32Array(new SharedArrayBuffer(count * 4));
  const next = count ? new Flatbush(count, 16, Float64Array, SharedArrayBuffer) : undefined;
  if (next) {
    tree?.search(-Infinity, -Infinity, Infinity, Infinity, (slot, x0, y0, x1, y1) => {
      const id = base.ids[slot];
      if (!edits.has(id)) ids[next.add(x0, y0, x1, y1)] = id;
      return false; // Consume each leaf without also collecting a result array.
    });
    for (const [id, bounds] of edits) if (bounds) ids[next.add(...bounds)] = id;
  }
  return finishIndex(next, ids, revision);
}

/** Return candidate feature IDs in ascending order. Touching edges intersect. */
export function querySpatialIndex(snapshot: SpatialIndex | PreparedSpatialQuery, box: BoundsXY): number[];
export function querySpatialIndex(base: SpatialIndex, box: BoundsXY, changes?: SpatialChanges): number[];
export function querySpatialIndex(index: SpatialIndex | PreparedSpatialQuery, box: BoundsXY, changes?: SpatialChanges): number[] {
  checkBounds(box, false);
  if (index.format === 'spatial-query-v1') {
    if (changes !== undefined) throw new TypeError('A prepared spatial query already includes its changes');
    const { base, updates, changedIds } = index;
    checkChangedIds(changedIds);
    const result: number[] = [];
    for (const slot of treeFor(base)?.search(...box) ?? []) {
      const id = base.ids[slot];
      if (!containsId(changedIds, id)) result.push(id);
    }
    for (const slot of treeFor(updates)?.search(...box) ?? []) result.push(updates.ids[slot]);
    return result.sort((a, b) => a - b);
  }
  const base = index;
  const tree = treeFor(base);
  const result: number[] = [];
  if (tree) {
    for (const slot of tree.search(...box)) {
      const id = base.ids[slot], edit = changes?.get(String(id));
      if (!edit || edit.revision <= base.revision) result.push(id);
    }
  }
  if (changes) {
    for (const [key, { revision, bounds }] of changes.entries()) {
      if (revision > base.revision && bounds && bounds[0] <= box[2] && bounds[1] <= box[3] &&
          bounds[2] >= box[0] && bounds[3] >= box[1]) result.push(Number(key));
    }
  }
  return result.sort((a, b) => a - b);
}

type SpatialSnapshot = SpatialIndex | PreparedSpatialQuery;
type JoinPart = { tree: Flatbush; ids: Uint32Array; hidden: Uint32Array | undefined };
export type SpatialPair = readonly [leftId: number, rightId: number];
type JoinFilter = (leftId: number, rightId: number) => boolean;

export interface SpatialJoinFrame {
  readonly left: SpatialSnapshot;
  readonly right: SpatialSnapshot;
  readonly filter?: JoinFilter;
}

export interface SpatialBoundsChange {
  readonly id: number;
  readonly before: BoundsXY | null;
  readonly after: BoundsXY | null;
}

export interface SpatialJoinDelta {
  readonly added: readonly SpatialPair[];
  readonly removed: readonly SpatialPair[];
}

function pairOrder(a: SpatialPair, b: SpatialPair): number {
  return a[0] - b[0] || a[1] - b[1];
}

function included(filter: JoinFilter | undefined, left: number, right: number): boolean {
  if (!filter) return true;
  const result = filter(left, right);
  if (typeof result !== 'boolean') throw new TypeError('Spatial join filters must return a boolean');
  return result;
}

function checkFilter(filter: JoinFilter | undefined): void {
  if (filter !== undefined && typeof filter !== 'function') throw new TypeError('Expected a spatial join filter function');
}

function joinParts(snapshot: SpatialSnapshot): JoinPart[] {
  const parts: JoinPart[] = [];
  const add = (index: SpatialIndex, hidden?: Uint32Array) => {
    const tree = treeFor(index);
    if (tree) parts.push({ tree, ids: index.ids, hidden });
  };
  if (snapshot.format === 'spatial-query-v1') {
    checkChangedIds(snapshot.changedIds);
    add(snapshot.base, snapshot.changedIds);
    add(snapshot.updates);
  } else add(snapshot);
  return parts;
}

/** Return overlapping bounds as ordered (left ID, right ID) pairs, sorted by both IDs. */
export function querySpatialJoin(left: SpatialSnapshot, right: SpatialSnapshot, options: {
  bounds?: BoundsXY;
  filter?: JoinFilter;
} = {}): SpatialPair[] {
  const { bounds = [-Infinity, -Infinity, Infinity, Infinity], filter } = options;
  checkBounds(bounds, false);
  const [xMin, yMin, xMax, yMax] = bounds;
  checkFilter(filter);
  const result: SpatialPair[] = [];
  const leftParts = joinParts(left), rightParts = joinParts(right);
  for (const l of leftParts) for (const r of rightParts) {
    const reverse = r.tree.numItems < l.tree.numItems;
    const outer = reverse ? r : l, inner = reverse ? l : r;
    const minX = Math.max(xMin, outer.tree.minX, inner.tree.minX);
    const minY = Math.max(yMin, outer.tree.minY, inner.tree.minY);
    const maxX = Math.min(xMax, outer.tree.maxX, inner.tree.maxX);
    const maxY = Math.min(yMax, outer.tree.maxY, inner.tree.maxY);
    if (minX > maxX || minY > maxY) continue;
    // Probe the larger tree with each live outer leaf clipped to the query region.
    // Returning false from Flatbush's filters avoids retaining arrays of tree slots.
    outer.tree.search(minX, minY, maxX, maxY, (slot, x0, y0, x1, y1) => {
      const outerId = outer.ids[slot];
      if (outer.hidden && containsId(outer.hidden, outerId)) return false;
      inner.tree.search(Math.max(x0, minX), Math.max(y0, minY), Math.min(x1, maxX), Math.min(y1, maxY), innerSlot => {
        const innerId = inner.ids[innerSlot];
        if (inner.hidden && containsId(inner.hidden, innerId)) return false;
        const leftId = reverse ? innerId : outerId, rightId = reverse ? outerId : innerId;
        if (included(filter, leftId, rightId)) result.push([leftId, rightId]);
        return false;
      });
      return false;
    });
  }
  return result.sort(pairOrder);
}

function changedBounds(edits: readonly SpatialBoundsChange[] = []): Map<number, SpatialBoundsChange> {
  const changes = new Map<number, SpatialBoundsChange>();
  for (const { id, before, after } of edits) {
    checkSpatialId(id);
    if (before !== null) checkBounds(before, true);
    if (after !== null) checkBounds(after, true);
    const first = changes.get(id);
    changes.set(id, { id, before: first ? first.before : before, after });
  }
  return changes;
}

/** Changes to a fixed join, given every edited feature's bounds in the two frames. */
export function diffSpatialJoin(previous: SpatialJoinFrame, next: SpatialJoinFrame, changes: {
  readonly left?: readonly SpatialBoundsChange[];
  readonly right?: readonly SpatialBoundsChange[];
  readonly bounds?: BoundsXY;
}): SpatialJoinDelta {
  const { bounds = [-Infinity, -Infinity, Infinity, Infinity] } = changes;
  checkBounds(bounds, false);
  const [x0, y0, x1, y1] = bounds;
  checkFilter(previous.filter);
  checkFilter(next.filter);
  const left = changedBounds(changes.left), right = changedBounds(changes.right);
  const added: SpatialPair[] = [], removed: SpatialPair[] = [];

  function neighbors(frame: SpatialJoinFrame, id: number, box: BoundsXY | null, fromLeft: boolean) {
    const matches = new Set<number>();
    if (!box) return matches;
    const clipped: BoundsXY = [Math.max(x0, box[0]), Math.max(y0, box[1]), Math.min(x1, box[2]), Math.min(y1, box[3])];
    if (clipped[0] > clipped[2] || clipped[1] > clipped[3]) return matches;
    for (const other of querySpatialIndex(fromLeft ? frame.right : frame.left, clipped)) {
      // If both endpoints changed, the left endpoint owns the pair in both frames.
      if (!fromLeft && left.has(other)) continue;
      if (included(frame.filter, fromLeft ? id : other, fromLeft ? other : id)) matches.add(other);
    }
    return matches;
  }
  function compare(edit: SpatialBoundsChange, fromLeft: boolean) {
    const before = neighbors(previous, edit.id, edit.before, fromLeft);
    const after = neighbors(next, edit.id, edit.after, fromLeft);
    for (const id of before) if (!after.has(id)) removed.push(fromLeft ? [edit.id, id] : [id, edit.id]);
    for (const id of after) if (!before.has(id)) added.push(fromLeft ? [edit.id, id] : [id, edit.id]);
  }
  for (const edit of left.values()) compare(edit, true);
  for (const edit of right.values()) compare(edit, false);
  return { added: added.sort(pairOrder), removed: removed.sort(pairOrder) };
}

/** Drop overlay entries already incorporated into the replacement base from the same tile history. */
export function pruneSpatialEdits(changes: SpatialChanges, baseRevision: number): SpatialChanges {
  checkRevision(baseRevision);
  const obsolete: string[] = [];
  for (const [key, edit] of changes.entries()) if (edit.revision <= baseRevision) obsolete.push(key);
  return obsolete.length ? changes.deleteMany(obsolete) : changes;
}
