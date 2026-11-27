import { SharedList } from 'zerocopy';
import { bboxXY, lineStringViewXY, pathIntersectsBoxXY, type BoundsXY } from 'zerocopy/geometry';
import { fromGeoArrowTable, packLineStringsXY, toGeoArrowTable } from 'zerocopy/geoarrow';
import { buildLineStringIndex, buildLineStringLookup, getLineStringById, querySpatialIndex } from 'zerocopy/spatial';
const bounds: BoundsXY = bboxXY(new SharedList('number').pushMany([0, 0, 2, 3]));
const laneBounds: BoundsXY = bboxXY(new SharedList('number').pushMany([0, 0, 2, 3]), { start: 2, end: 4 });
const minimum: number = bounds[0];
// @ts-expect-error The input must be numeric.
bboxXY(new SharedList('string'));
// @ts-expect-error The result is a readonly tuple.
bounds[0] = minimum;
const hit: boolean = pathIntersectsBoxXY(new SharedList('number'), bounds, { start: 0 });
// @ts-expect-error The input must be numeric.
pathIntersectsBoxXY(new SharedList('string'), bounds);
// @ts-expect-error All four viewport bounds are required.
pathIntersectsBoxXY(new SharedList('number'), [0, 0]);
const batch = packLineStringsXY([new SharedList('number'), null]);
const coordinates: Float64Array<SharedArrayBuffer> = batch.coordinates;
const x: number | undefined = toGeoArrowTable(batch).getChild('geometry')?.get(0)?.get(0)?.get(0) ?? undefined;
void coordinates; void x;
const imported = fromGeoArrowTable(toGeoArrowTable(batch, { crs: 'EPSG:3857', crs_type: 'authority_code' }));
interface ExportOptions { crs: Readonly<Record<string, unknown>> }
const options: ExportOptions = { crs: { name: 'test' } };
toGeoArrowTable(batch, options);
for (const chunk of imported.batches) {
  const row: Float64Array<SharedArrayBuffer> | null = lineStringViewXY(chunk, 0);
  if (row && pathIntersectsBoxXY(row, bounds)) {
    const batches = [{ paths: chunk, ids: Uint32Array.of(12, 14) }];
    const byId = buildLineStringLookup(batches);
    const borrowed: Float64Array<SharedArrayBuffer> | null | undefined = getLineStringById(byId, 14);
    // @ts-expect-error Feature handles are uint32 numbers.
    getLineStringById(byId, '14');
    void borrowed;
    const index = buildLineStringIndex(batches);
    querySpatialIndex(index, bboxXY(row));
  }
  toGeoArrowTable(chunk, imported.metadata);
}
// @ts-expect-error The XY path adapter supports planar edges.
toGeoArrowTable(batch, { edges: 'spherical' });
// @ts-expect-error GeoArrow XY export requires numeric snapshots.
packLineStringsXY([new SharedList('boolean')]);
// @ts-expect-error Packed geometry kernels require Float64 coordinates.
bboxXY(new Float32Array(2));
