import { lineStringViewXY, validateLineStringBuffersXY, type LineStringBuffersXY } from './line-string-buffers.ts';
import { checkSpatialId, lowerBoundUint32 } from './spatial-id.ts';

export interface SpatialLineStringBatch<B extends ArrayBufferLike = ArrayBufferLike> {
  readonly paths: LineStringBuffersXY<B>;
  /** A stable uint32 feature handle for each row, including missing and empty paths. */
  readonly ids: Uint32Array | readonly number[];
}

/** Immutable handle directory paired with the geometry batches used to build it. */
export interface LineStringLookup<B extends ArrayBufferLike = ArrayBufferLike> {
  readonly batches: readonly LineStringBuffersXY<B>[];
  readonly ids: Uint32Array<SharedArrayBuffer>;
  /** Source row ordinals in sorted ID order. Null when the source was already sorted. */
  readonly rows: Uint32Array<SharedArrayBuffer> | null;
  /** Exclusive end ordinal of each batch, including empty batches. */
  readonly batchEnds: Uint32Array<SharedArrayBuffer>;
}

export function checkLineStringBatch({ paths, ids }: SpatialLineStringBatch): void {
  validateLineStringBuffersXY(paths);
  if (ids.length !== paths.offsets.length - 1) throw new RangeError('Expected one spatial feature ID per LineString row');
}

/** Build once on the owner. ID storage is shared, and coordinate, validity and offset buffers are borrowed. */
export function buildLineStringLookup<B extends ArrayBufferLike>(
  batches: readonly SpatialLineStringBatch<B>[],
): LineStringLookup<B> {
  const batchEnds = new Uint32Array(new SharedArrayBuffer(batches.length * 4));
  let total = 0;
  for (let i = 0; i < batches.length; i++) {
    checkLineStringBatch(batches[i]);
    total += batches[i].ids.length;
    if (total > 0xffffffff) throw new RangeError('Too many rows for a uint32 LineString lookup');
    batchEnds[i] = total;
  }

  const ids = new Uint32Array(new SharedArrayBuffer(total * 4));
  let offset = 0, sorted = true;
  for (const batch of batches) {
    for (const id of batch.ids) {
      checkSpatialId(id);
      if (offset > 0 && id < ids[offset - 1]) sorted = false;
      ids[offset++] = id;
    }
  }
  let rows: Uint32Array<SharedArrayBuffer> | null = null;
  if (!sorted) {
    rows = new Uint32Array(new SharedArrayBuffer(total * 4));
    for (let i = 0; i < total; i++) rows[i] = i;
    rows.sort((a, b) => ids[a] - ids[b]);
    ids.sort();
  }
  for (let i = 1; i < total; i++) {
    if (ids[i] === ids[i - 1]) throw new RangeError('Duplicate spatial feature ID: ' + ids[i]);
  }
  const geometry = batches.map(({ paths: { offsets, coordinates, validity } }) =>
    Object.freeze({ offsets, coordinates, validity }));
  return Object.freeze({ batches: Object.freeze(geometry), ids, rows, batchEnds });
}

/** Borrow XY coordinates by stable handle. A missing ID returns undefined, and a null geometry returns null. */
export function getLineStringById<B extends ArrayBufferLike>(lookup: LineStringLookup<B>, id: number): Float64Array<B> | null | undefined {
  checkSpatialId(id);
  const slot = lowerBoundUint32(lookup.ids, id);
  if (lookup.ids[slot] !== id) return undefined;
  const ordinal = lookup.rows === null ? slot : lookup.rows[slot];
  const batch = lowerBoundUint32(lookup.batchEnds, ordinal + 1);
  const start = batch === 0 ? 0 : lookup.batchEnds[batch - 1];
  return lineStringViewXY(lookup.batches[batch], ordinal - start);
}
