import Flatbush from 'flatbush';
import { SharedMap } from './shared-map.ts';
import { json, type JsonType } from './types.ts';
import type { BoundsXY } from './geometry.ts';

export interface SpatialFeature { readonly id: number; readonly bounds: BoundsXY }
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

function checkRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Expected a nonnegative safe spatial revision');
}

function checkId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RangeError('Expected a uint32 feature ID');
}

function checkBounds(box: BoundsXY, finite: boolean): void {
  if (!Array.isArray(box) || box.length !== 4) throw new TypeError('Expected four XY bounds');
  for (const value of box) {
    if (typeof value !== 'number') throw new TypeError('Expected numeric XY bounds');
    if (Number.isNaN(value) || (finite && !Number.isFinite(value))) throw new RangeError('Invalid XY bounds');
  }
  if (box[0] > box[2] || box[1] > box[3]) throw new RangeError('Reversed XY bounds');
}

const trees = new WeakMap<SpatialIndex, Flatbush>();

/** Build a packed, read-only base over finite planar bounding boxes. */
export function buildSpatialIndex(features: readonly SpatialFeature[], revision = 0): SpatialIndex {
  checkRevision(revision);
  const ids = new Uint32Array(new SharedArrayBuffer(features.length * 4));
  const tree = features.length ? new Flatbush(features.length, 16, Float64Array, SharedArrayBuffer) : undefined;
  const seen = new Set<number>();
  for (const { id, bounds } of features) {
    checkId(id);
    checkBounds(bounds, true);
    if (seen.has(id)) throw new RangeError('Duplicate spatial feature ID: ' + id);
    seen.add(id);
    ids[tree!.add(...bounds)] = id;
  }
  tree?.finish();
  const base: SpatialIndex = Object.freeze({ format: 1, revision, ids, buffer: tree ? tree.data as SharedArrayBuffer : null });
  if (tree) trees.set(base, tree);
  return base;
}

/** Stage one edit batch. A null box deletes a feature, and the last edit to an ID in a batch wins. */
export function applySpatialEdits(previous: SpatialChanges | undefined, revision: number, edits: readonly SpatialEdit[]): SpatialChanges {
  checkRevision(revision);
  const changes = previous ?? new SharedMap(json<SpatialChange>());
  const batch = new Map<string, SpatialChange>();
  for (const { id, bounds } of edits) {
    checkId(id);
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

/** Return candidate feature IDs in ascending order. Touching edges intersect. */
export function querySpatialIndex(base: SpatialIndex, box: BoundsXY, changes?: SpatialChanges): number[] {
  checkBounds(box, false);
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

/** Drop overlay entries already incorporated into the replacement base from the same tile history. */
export function pruneSpatialEdits(changes: SpatialChanges, baseRevision: number): SpatialChanges {
  checkRevision(baseRevision);
  const obsolete: string[] = [];
  for (const [key, edit] of changes.entries()) if (edit.revision <= baseRevision) obsolete.push(key);
  return obsolete.length ? changes.deleteMany(obsolete) : changes;
}
