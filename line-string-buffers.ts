import { typedArrayTag } from './memory';

/** One native GeoArrow LineString column with interleaved Float64 XY vertices. */
export interface LineStringBuffersXY<B extends ArrayBufferLike = ArrayBufferLike> {
  readonly offsets: Int32Array<B>;
  readonly coordinates: Float64Array<B>;
  /** Arrow's least-significant-bit-first row validity, or null when all rows exist. */
  readonly validity: Uint8Array<B> | null;
}

/** Borrow one row of a packed column. Treat the returned coordinate view as read-only. */
export function lineStringViewXY<B extends ArrayBufferLike>(
  { offsets, coordinates, validity }: LineStringBuffersXY<B>, row: number,
): Float64Array<B> | null {
  if (!Number.isSafeInteger(row) || row < 0 || row >= offsets.length - 1) {
    throw new RangeError('LineString row is outside the batch');
  }
  if (!lineStringPresent(validity, row)) return null;
  return coordinates.subarray(offsets[row] * 2, offsets[row + 1] * 2);
}

export function lineStringPresent(validity: Uint8Array | null, row: number): boolean {
  return validity === null || (validity[Math.floor(row / 8)] & (1 << (row % 8))) !== 0;
}

/** Check the packed XY layout before handing it to an Arrow or spatial index writer. */
export function validateLineStringBuffersXY({ offsets, coordinates, validity }: LineStringBuffersXY): number {
  if (typedArrayTag.call(coordinates) !== 'Float64Array' || typedArrayTag.call(offsets) !== 'Int32Array' ||
      (validity !== null && typedArrayTag.call(validity) !== 'Uint8Array')) {
    throw new TypeError('Expected Float64 coordinates, Int32 offsets and an optional Uint8 validity bitmap');
  }
  const length = offsets.length - 1;
  if (length < 0 || offsets[0] !== 0 || offsets[length] * 2 !== coordinates.length) {
    throw new RangeError('LineString offsets must span all XY vertices');
  }
  if (validity && validity.length < Math.ceil(length / 8)) throw new RangeError('Incomplete LineString validity bitmap');
  let nullCount = 0;
  for (let i = 0; i < length; i++) {
    if (offsets[i] > offsets[i + 1]) throw new RangeError('LineString offsets must be nondecreasing');
    if (!lineStringPresent(validity, i)) nullCount++;
  }
  return nullCount;
}
