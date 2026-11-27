import { SharedList } from 'zerocopy';
import { fromFloat64 } from 'zerocopy/numeric';

const values = fromFloat64(new Float64Array([1, 2, -0]));
const numeric: SharedList<'number'> = values;
const value: number | undefined = values.get(0);
const materialized: number[] = values.toArray();
values.push(3).pushMany([4, 5]).set(0, 9);
fromFloat64(new Float64Array(new SharedArrayBuffer(32)));
// @ts-expect-error The explicit raw numeric importer requires Float64Array.
fromFloat64([1, 2]);
// @ts-expect-error Other element widths need explicit conversion by the caller.
fromFloat64(new Float32Array([1, 2]));
// @ts-expect-error Integer bit patterns must not be interpreted as numeric values.
fromFloat64(new BigUint64Array([1n, 2n]));
// @ts-expect-error DataView does not carry the required numeric element type.
fromFloat64(new DataView(new ArrayBuffer(16)));
// @ts-expect-error The result always stores numbers.
values.push('3');
// @ts-expect-error The optional factory does not add a method to SharedList.
SharedList.fromFloat64(new Float64Array());
void numeric; void value; void materialized;
