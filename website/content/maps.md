# Feature attributes by ID

Use a string-keyed `SharedMap` when several workers need selected records from a large, changing registry. The live example stores generated road attributes as JSON objects. It performs keyed lookup and validation. It does not render a map or perform spatial search.

## Try the replacement

Open the [feature example](../README.md#feature-attribute-example), load the sample and inspect `road/000000`.

1. Revision 0 has zero lanes. The validation worker reports an invalid record.
2. Select **Replace 100 features**. The road gets two lanes, a closed status and a zero speed limit.
3. Select **Initial · retained**. Both workers read the original revision, including the zero-lane error.
4. Return to **Current**. The changed attributes are still present.

The same controls work across SharedMap, native Map, Immutable.js Map and Immer Map. Each path has a real owning worker and two real reader workers. Every result is checked against a separate generated reference. The UI receives at most 12 feature records and 12 validation issues, plus counts and fingerprints.

## Store objects at stable keys

The example uses the current object codec and public batch API:

<!-- example: feature-map-snapshots -->
```ts
import { SharedMap, getWorkerData, json } from 'zerocopy';

type Road = {
  name: string;
  status: 'open' | 'closed';
  revision: number;
  attributes: { lanes: number; speedLimit: number };
};

const RoadValue = json<Road>();
const initial = new SharedMap(RoadValue).setMany([
  ['road/000000', {
    name: 'Road 0', status: 'open', revision: 0,
    attributes: { lanes: 0, speedLimit: 30 },
  }],
]);
const current = initial.setMany([
  ['road/000000', {
    name: 'Road 0', status: 'closed', revision: 1,
    attributes: { lanes: 2, speedLimit: 0 },
  }],
]);

console.log(initial.get('road/000000')?.attributes.lanes); // 0
console.log(current.get('road/000000')?.attributes.lanes); // 2

// Send this message with an existing Worker or MessagePort.
const message = getWorkerData({ features: current }, { copy: false });
```

In `feature-reader.mjs`, the worker attaches to the supplied shared memory:

```js
import { initWorker } from 'zerocopy';

self.onmessage = async ({ data }) => {
  const { features } = await initWorker(data);
  const road = features.get('road/000000');
  self.postMessage({ lanes: road?.attributes.lanes });
};
```

Each `.get(id)` is a local read. JSON values decode into deeply frozen JavaScript objects in the reading thread. They are not direct binary field views. The current implementation can retain up to 2,048 decoded objects and 2 MiB of encoded object content in each arena's read cache. The benchmark separates first and repeated queries because the selected IDs can fit that cache.

## Give every design equivalent work

The comparison generates the same ID/object pairs for all four maps. Its initial publication clones a native Map to each native or Immer reader, and entry pairs to each Immutable.js reader. Later publications clone only the 100 changed pairs. SharedMap sends new root descriptors backed by existing shared memory.

Every owner and reader keeps initial and current revisions. Native makes one shallow `new Map(initial)` when the first edit must preserve the initial map. It then mutates its exclusively owned current Map on later edits. Changed objects are replaced, never mutated. Immutable.js uses `withMutations`; Immer uses one `produce` batch. Replica paths do not clone the full dataset on sparse publication.

SharedMap uses generic object `setMany` for initial construction and replacement. This exercises object serialization and bulk map staging. The example uses the current production runtime; no unmerged optimization is included.

## Read the measurements

The browser benchmark starts fresh owner and reader workers for every sample. Startup and module loading are outside the phase timers. Input generation, construction, initial publication, first query, repeat query, owner edits and edit publication have separate values. The page and raw export also show a directly measured edit-plus-publication duration. Two warm-ups and seven measured samples per map run in rotating order.

The same 1,000 IDs, 100 edits and two reader jobs apply to every path. First queries use fresh attachments; repeated queries can use local caches. Fingerprints cover every requested ID and all relevant record fields. Visible rows and validation results receive exact checks. Verification runs after the query timer. Browser timings exclude DOM painting and do not measure memory.

The [recorded memory report](../../docs/feature-map-memory.md) uses fresh Node processes, 100,000 records, zero/two/four readers and three trials per case. It reports JavaScript retention, tracked buffers, unique backing capacity, arena-used bytes and RSS separately. The original [SharedList memory report](../../docs/memory-comparison.md) remains historical evidence for its log-column workload.

## Keep the limits visible

The sample accepts no uploads and uses no map service. It has at most 100,000 features and 12 sparse edit revisions per session. Stop and navigation terminate the owner and reader workers. Releasing references permits collection; it does not promise immediate GC or per-node arena reclamation.

One allocating owner writes each arena. Bounds are ordinary attributes, not a spatial index. Use a spatial index, geometry engine, database or GPU buffer when required. Compare a single native owner first if the UI only needs small answers and other workers do not need local data access.
