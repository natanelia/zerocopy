import { SharedList } from 'zerocopy';
import { bboxXY, pathIntersectsBoxXY, type BoundsXY } from 'zerocopy/geometry';
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
