import { SharedList } from 'zerocopy';
import { bboxXY, type BoundsXY, preparePolygonXY, pointsWithinPolygonXY, type PreparedPolygonXY } from 'zerocopy/geometry';
const bounds: BoundsXY = bboxXY(new SharedList('number').pushMany([0, 0, 2, 3]));
const minimum: number = bounds[0];
// @ts-expect-error The input must be numeric.
bboxXY(new SharedList('string'));
// @ts-expect-error The result is a readonly tuple.
bounds[0] = minimum;
const ring = new SharedList('number').pushMany([0,0,1,0,1,1,0,0]);
const polygon: PreparedPolygonXY = preparePolygonXY([ring]);
const indices: Uint32Array = pointsWithinPolygonXY(ring, polygon);
// @ts-expect-error Prepared polygons cannot be forged as plain metadata.
const invalid: PreparedPolygonXY = { bounds, ringCount: 1, edgeCount: 3 };
// @ts-expect-error Rings must be numeric.
preparePolygonXY([new SharedList('string')]);
// @ts-expect-error Query points must be numeric.
pointsWithinPolygonXY(new SharedList('string'), polygon);
