import { SharedMap, json, list, type JsonType, type ValueOf } from '../dist/types/shared';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
interface Lane { id: string; speedLimit: number }
const LaneValue = json<Lane>();
const objectWire: 'object' = LaneValue;
const lanes = new SharedMap(LaneValue);
type Branded = Assert<Equal<typeof LaneValue, JsonType<Lane>>>;
type Read = Assert<Equal<ReturnType<typeof lanes.get>, Readonly<Lane> | undefined>>;
type LegacyRead = Assert<Equal<ValueOf<'object'>, object>>;
type NoJsonWire = Assert<Equal<ValueOf<'json'>, never>>;
// @ts-expect-error The helper does not introduce another runtime codec name.
list('json');
// @ts-expect-error Object storage must not widen the application's field types.
lanes.set('bad', { unrelated: true });
void objectWire;
