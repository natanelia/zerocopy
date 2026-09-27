import { SharedList } from 'zerocopy';
import { bboxXY, type BoundsXY, simplifyLineXY } from 'zerocopy/geometry';
const bounds: BoundsXY = bboxXY(new SharedList('number').pushMany([0, 0, 2, 3]));
const minimum: number = bounds[0];
// @ts-expect-error The input must be numeric.
bboxXY(new SharedList('string'));
// @ts-expect-error The result is a readonly tuple.
bounds[0] = minimum;
const retained: Uint32Array = simplifyLineXY(new SharedList('number'), .1);
// @ts-expect-error A numeric list is required.
simplifyLineXY(new SharedList('string'), 1);
// @ts-expect-error Tolerance must be a number.
simplifyLineXY(new SharedList('number'), '1');
