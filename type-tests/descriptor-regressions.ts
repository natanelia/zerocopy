import {
  SharedMap, SharedList, json, list, map, getWorkerData, initWorker, compactMany,
  type DeepReadonly, type JsonType, type JsonObject, type JsonValue,
  type ValueOf, type WireType, type WorkerData,
} from '../dist/types/shared';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
interface Lane { id: string; speedLimit: number; label?: string; points: Array<[number, number]> }
const LaneValue = json<Lane>();
const lanes = new SharedMap(LaneValue);
const lines = new SharedList(LaneValue);
const nested = map(list(LaneValue));
const wire: 'SharedMap<SharedList<object>>' = nested;
type Wire = Assert<Equal<WireType<typeof nested>, 'SharedMap<SharedList<object>>'>>;
type PrimitiveWire = Assert<Equal<WireType<'number'>, 'number'>>;
type Read = Assert<Equal<ValueOf<typeof LaneValue>, DeepReadonly<Lane>>>;
type NestedRead = Assert<Equal<ValueOf<typeof nested>, SharedMap<ReturnType<typeof list<typeof LaneValue>>>>>;
type InvalidLeaf = Assert<Equal<ValueOf<'SharedList<invalid>'>, never>>;
type InvalidNestedSet = Assert<Equal<ValueOf<'SharedList<SharedSet<object>>'>, never>>;
// @ts-expect-error Check the entire literal, not just the outer collection name.
list('SharedList<invalid>');
// @ts-expect-error A set cannot contain another collection.
map('SharedSet<SharedList<number>>');
// @ts-expect-error A nested set cannot contain boolean values.
list('SharedList<SharedSet<boolean>>');
// @ts-expect-error Malformed closing brackets are rejected statically.
list('SharedList<number>>');

// Closed state interfaces must work without adding a broad string index signature.
interface State { lanes: typeof lanes; lines: typeof lines }
const state: State = { lanes, lines };
const payload = getWorkerData(state);
const restored = await initWorker(payload);
type WorkerState = Assert<Equal<typeof restored, Readonly<State>>>;
const owned = compactMany(state);
type CompactedState = Assert<Equal<typeof owned, Readonly<State>>>;
const metadata = payload.structures.lanes.data;
type MetadataType = Assert<Equal<typeof metadata.valueType, typeof LaneValue>>;
type MetadataIsNotAny = Assert<Equal<IsAny<typeof metadata>, false>>;
// @ts-expect-error Transport metadata retains the collection's actual fields.
metadata.missingField;
// @ts-expect-error Transport metadata does not accept a different descriptor.
const wrongDescriptor: 'number' = metadata.valueType;
// @ts-expect-error Typed payload keys are known.
payload.structures.missingCollection;
// @ts-expect-error Published worker records are read-only.
restored.lanes = lanes;
// Preserve the documented explicit assertion for legacy untyped payloads.
const untyped: WorkerData = payload;
const legacy = await initWorker<State>(untyped);
type LegacyState = Assert<Equal<typeof legacy, Readonly<State>>>;
// @ts-expect-error Every transported property must be a collection.
getWorkerData({ lanes, count: 1 });
// @ts-expect-error Arrays are not worker state records.
getWorkerData([lanes]);
declare const symbol: unique symbol;
// @ts-expect-error Symbol keys are not serialized.
getWorkerData({ [symbol]: lanes });
// @ts-expect-error Compaction uses the same string-keyed record contract.
compactMany({ [symbol]: lanes });

// Run this file with exactOptionalPropertyTypes both enabled and disabled.
// @ts-expect-error Never cannot describe an insertable value.
json<never>();
// @ts-expect-error Any must not disable shape checking.
json<any>();
// @ts-expect-error Optional any is unsafe in ordinary strict mode too.
json<{ value?: any }>();
// @ts-expect-error Optional any nested below an optional object is unsafe too.
json<{ nested?: { value?: any } }>();
// @ts-expect-error Check every array element's declared shape.
json<Array<{ value?: any }>>();
// @ts-expect-error Check every discriminated-union member.
json<{ kind: 'safe'; x: number } | { kind: 'unsafe'; x?: any }>();
// @ts-expect-error An index signature must not disable validation.
json<Record<string, any>>();
// @ts-expect-error Unknown needs application validation.
json<{ value?: unknown }>();
// @ts-expect-error Object is not a JSON-compatible shape.
json<object>();
// @ts-expect-error The empty structural type also admits non-JSON values.
json<{}>();
// @ts-expect-error Broad object fields cannot guarantee JSON-compatible values.
json<{ value: object }>();
// @ts-expect-error Undefined array members are serialized as null.
json<Array<string | undefined>>();
// @ts-expect-error Optional tuple slots can contain holes/undefined, which become null.
json<[name?: string]>();
// @ts-expect-error Array properties do not survive JSON serialization.
json<string[] & { metadata: string }>();
// @ts-expect-error Required undefined fields disappear on serialization.
json<{ value: undefined }>();
// @ts-expect-error Symbol-named fields are not serialized.
json<{ [symbol]: string }>();
// @ts-expect-error Optional functions are still not JSON data.
json<{ callback?: () => void }>();
// @ts-expect-error Optional bigints are still not JSON data.
json<{ count?: bigint }>();
// @ts-expect-error Dates do not decode to Date objects.
json<{ date?: Date }>();
// @ts-expect-error Typed arrays do not decode to typed arrays.
json<{ bytes: Uint8Array }>();
// @ts-expect-error A toJSON hook can change the stored type.
json<{ toJSON(): string }>();

interface Tree { id: string; children: Tree[]; note?: { text?: string } }
type Expression = { kind: 'literal'; value: number } | { kind: 'sum'; children: Expression[] };
json<Tree>();
json<Expression>();
json<Record<string, JsonValue>>();
json<{ payload: JsonValue }>();
const generic = json();
type Generic = Assert<Equal<typeof generic, JsonType<JsonObject | readonly JsonValue[]>>>;
new SharedList(generic).push({ items: [1, null, { ok: true }] }).push([1, 'a', null]);
// @ts-expect-error The default descriptor is JSON-safe, not any.
new SharedList(generic).push({ invalid: 1n });
// @ts-expect-error Optional any must also be found inside a recursive shape.
json<{ children: Tree[]; metadata?: any }>();
type BadTree = { kind: 'leaf'; value: bigint } | { kind: 'branch'; children: BadTree[] };
// @ts-expect-error Recursive unions must still validate all leaves.
json<BadTree>();

type ArrayRead = Assert<Equal<DeepReadonly<Array<{ x: number }>>, readonly { readonly x: number }[]>>;
type TupleRead = Assert<Equal<DeepReadonly<[string, { x: number }]>, readonly [string, { readonly x: number }]>>;
type VariadicRead = Assert<Equal<DeepReadonly<[string, ...Array<{ x: number }>]>, readonly [string, ...{ readonly x: number }[]]>>;
type TrailingRead = Assert<Equal<DeepReadonly<[...Array<{ x: number }>, string]>, readonly [...{ readonly x: number }[], string]>>;
type OptionalRead = Assert<Equal<DeepReadonly<[x?: { y: number }]>, readonly [x?: { readonly y: number }]>>;
const variadic = json<[string, ...Array<{ x: number }>]>();
new SharedList(variadic).push(['label', { x: 1 }]);
declare const idBrand: unique symbol;
type Id = string & { readonly [idBrand]: true };
json<{ id: Id }>();
void wire;
