import {
  SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap, SharedPriorityQueue,
  SharedSet, SharedOrderedSet, SharedSortedSet, json, list, map, stack, queue,
  linkedList, doublyLinkedList, orderedMap, sortedMap, priorityQueue,
  set, orderedSet, sortedSet, getWorkerData, initWorker, compact, compactMany,
  type DeepReadonly, type ValueOf, type JsonType, type WorkerData,
} from '../dist/types/shared';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;

interface Lane {
  id: string;
  speedLimit: number;
  direction: 'forward' | 'reverse';
  label?: string;
  centerline: Array<readonly [number, number]>;
  metadata: { source: string; revision: number | null };
}
const LaneValue = json<Lane>();
const input: Lane = {
  id: 'lane-1', speedLimit: 50, direction: 'forward',
  centerline: [[103.85, 1.29]], metadata: { source: 'survey', revision: null },
};
const lanes = new SharedMap(LaneValue).set('lane-1', input);
const lane = lanes.get('lane-1');
type MapRead = Assert<Equal<typeof lane, DeepReadonly<Lane> | undefined>>;
type NoAny = Assert<Equal<IsAny<NonNullable<typeof lane>>, false>>;
type Descriptor = Assert<Equal<typeof LaneValue, JsonType<Lane>>>;

// @ts-expect-error Required fields must be supplied.
lanes.set('bad', { id: 'bad' });
// @ts-expect-error Wrong field type.
lanes.set('bad', { ...input, speedLimit: 'fast' });
// @ts-expect-error A literal union must remain narrow.
lanes.set('bad', { ...input, direction: 'sideways' });
// @ts-expect-error Excess fields in a fresh object must be checked.
lanes.set('bad', { ...input, unknown: true });
// @ts-expect-error Unknown input requires validation or narrowing first.
lanes.set('bad', {} as unknown);
if (lane) {
  // @ts-expect-error Decoded fields are read-only.
  lane.speedLimit = 70;
  // @ts-expect-error Nested records are read-only.
  lane.metadata.source = 'changed';
  // @ts-expect-error Nested arrays are read-only.
  lane.centerline.push([0, 0]);
  // @ts-expect-error Tuples keep their element positions and readonly modifier.
  lane.centerline[0]![0] = 9;
  const tuple: readonly [number, number] = lane.centerline[0]!;
  const label: string | undefined = lane.label;
  void tuple; void label;
}

const batch = lanes.setMany([['lane-2', input] as const]);
type Batch = Assert<Equal<typeof batch, typeof lanes>>;
const many: Array<DeepReadonly<Lane> | undefined> = lanes.getMany(['lane-1']);
const entries: Array<[string, DeepReadonly<Lane>]> = [...lanes.entries()];
const values: DeepReadonly<Lane>[] = [...lanes.values()];
lanes.forEach(value => {
  const speed: number = value.speedLimit;
  // @ts-expect-error Callback values must also be read-only.
  value.metadata.revision = speed;
});
// @ts-expect-error Bulk writes are checked.
lanes.setMany([['bad', { ...input, speedLimit: false }]]);

const laneList = new SharedList(LaneValue).push(input).pushMany([input]).set(0, input);
const tiles = new SharedMap(list(LaneValue)).set('tile', laneList);
const regions = new SharedMap(map(list(LaneValue))).set('region', tiles);
const nestedLane = regions.get('region')?.get('tile')?.get(0);
type NestedRead = Assert<Equal<typeof nestedLane, DeepReadonly<Lane> | undefined>>;
// @ts-expect-error Nested collection types cannot be replaced by an unrelated collection.
tiles.set('tile', new SharedList('number').push(1));
// @ts-expect-error Updates on an extracted nested list still check the object shape.
tiles.get('tile')!.push({ nope: true });
// @ts-expect-error List bulk operations check field types.
laneList.pushMany([{ ...input, speedLimit: 'fast' }]);
// @ts-expect-error Array results contain deeply read-only objects.
laneList.toArray()[0]!.centerline.push([0, 0]);

const laneStack = new SharedStack(LaneValue).push(input);
const laneQueue = new SharedQueue(LaneValue).enqueue(input);
const laneLinked = new SharedLinkedList(LaneValue).append(input).prepend(input);
const laneDoubly = new SharedDoublyLinkedList(LaneValue).append(input);
const laneOrdered = new SharedOrderedMap(LaneValue).set('lane-1', input);
const laneSorted = new SharedSortedMap(LaneValue).set('lane-1', input);
const laneHeap = new SharedPriorityQueue(LaneValue).enqueue(input, 1);
const reads: Array<DeepReadonly<Lane> | undefined> = [
  laneStack.peek(), laneQueue.peek(), laneLinked.getFirst(), laneDoubly.getLast(),
  laneOrdered.get('lane-1'), laneSorted.get('lane-1'), laneHeap.peek(),
];
new SharedMap(stack(LaneValue)).set('stack', laneStack);
new SharedMap(queue(LaneValue)).set('queue', laneQueue);
new SharedMap(linkedList(LaneValue)).set('linked', laneLinked);
new SharedMap(doublyLinkedList(LaneValue)).set('doubly', laneDoubly);
new SharedMap(orderedMap(LaneValue)).set('ordered', laneOrdered);
new SharedMap(sortedMap(LaneValue)).set('sorted', laneSorted);
new SharedMap(priorityQueue(LaneValue)).set('heap', laneHeap);
new SharedMap(set('string')).set('set', new SharedSet<string>());
new SharedMap(orderedSet('number')).set('set', new SharedOrderedSet<number>());
new SharedMap(sortedSet('string')).set('set', new SharedSortedSet<string>());
// @ts-expect-error Sets still only support strings and numbers, not objects.
set(LaneValue);
// @ts-expect-error Sorted sets still only support strings and numbers.
sortedSet('boolean');
// @ts-expect-error Unknown storage descriptors are rejected.
list('not-a-type');

const legacyNested = new SharedMap('SharedList<SharedMap<number>>');
const legacyRead = legacyNested.get('list')?.get(0)?.get('key');
type LegacyNested = Assert<Equal<typeof legacyRead, number | undefined>>;
// @ts-expect-error String-form nested collections no longer leak any.
legacyNested.get('list')?.missingMethod();
// @ts-expect-error String-form nested writes are checked too.
legacyNested.set('list', new SharedList('string'));
type StringSet = Assert<Equal<ValueOf<'SharedSet<string>'>, SharedSet<string>>>;
type InvalidSet = Assert<Equal<ValueOf<'SharedSet<object>'>, never>>;
const numberMap = new SharedMap('number').set('n', 1);
type PrimitiveRead = Assert<Equal<ReturnType<typeof numberMap.get>, number | undefined>>;
new SharedMap('object').set('legacy', { unrestricted: true });

const compacted = compact(lanes);
type Compacted = Assert<Equal<typeof compacted, typeof lanes>>;
const group = compactMany({ lanes, tiles, laneHeap });
type CompactedGroup = Assert<Equal<typeof group.tiles, typeof tiles>>;
const payload = getWorkerData({ lanes, tiles, laneList, laneHeap });
const restored = await initWorker(payload);
type WorkerRead = Assert<Equal<ReturnType<typeof restored.lanes.get>, DeepReadonly<Lane> | undefined>>;
type WorkerNested = Assert<Equal<typeof restored.tiles, typeof tiles>>;
// Retain the legacy explicit type assertion for an untyped worker message.
const untyped: WorkerData = payload;
const legacyWorker = await initWorker<{ lanes: typeof lanes }>(untyped);
const legacySpeed: number | undefined = legacyWorker.lanes.get('lane-1')?.speedLimit;
void legacySpeed;
// @ts-expect-error Worker result records are frozen.
restored.lanes = lanes;
// @ts-expect-error Restored reads keep field types.
const wrongWorkerValue: string = restored.lanes.get('lane-1')!.speedLimit;

interface Recursive { name: string; children: Recursive[] }
const tree = new SharedMap(json<Recursive>()).set('tree', { name: 'root', children: [] });
const treeName: string | undefined = tree.get('tree')?.children[0]?.name;
const tupleDescriptor = json<readonly [string, { x: number }]>();
const tupleList = new SharedList(tupleDescriptor).push(['point', { x: 1 }]);
type TupleRead = Assert<Equal<ReturnType<typeof tupleList.get>, readonly [string, { readonly x: number }] | undefined>>;
const variant = json<{ kind: 'a'; x: number } | { kind: 'b'; name: string }>();
new SharedList(variant).push({ kind: 'a', x: 1 });
// @ts-expect-error A union member must match its discriminant.
new SharedList(variant).push({ kind: 'a', name: 'wrong' });

// @ts-expect-error A JSON descriptor must not silently disable checking.
json<any>();
// @ts-expect-error Nested any must not silently disable checking.
json<{ value: any }>();
// @ts-expect-error Every union member must be JSON-compatible.
json<{ valid: number } | { invalid: Date }>();
// @ts-expect-error A field of unknown type cannot promise a JSON round trip.
json<{ unvalidated: unknown }>();
// @ts-expect-error Date instances do not round-trip as dates.
json<{ createdAt: Date }>();
// @ts-expect-error Map instances do not round-trip as maps.
json<{ lookup: Map<string, number> }>();
// @ts-expect-error Methods are not JSON data.
json<{ calculate(): number }>();
// @ts-expect-error Bigints are not JSON values.
json<{ count: bigint }>();
// @ts-expect-error Symbol values are not JSON values.
json<{ marker: symbol }>();
// @ts-expect-error Required undefined properties are not JSON data.
json<{ missing: undefined }>();
// @ts-expect-error A nested shared collection is not a JSON object field.
json<{ lines: SharedList<'number'> }>();
// @ts-expect-error The root must be an object or array.
json<string>();

void many; void entries; void values; void reads; void treeName;
