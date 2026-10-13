# Shared product catalog

Use a string-keyed `SharedMap` when several workers need selected records from a large, changing catalog. The live comparison stores generated product records as JSON objects. Workers look up selected IDs and validate prices, stock and availability.

## Try the replacement

Open the [live comparison](../README.md#product-catalog-comparison), load the sample and inspect `product/000000`.

1. Revision 0 has a zero price. The validation worker reports an invalid record.
2. Select **Replace 100 products**. The product gets a price of 2,500 cents, unavailable status and zero stock.
3. Select **Initial · retained**. Both workers read the original revision, including the invalid price.
4. Return to **Current**. The changed attributes are still present.

The same controls work across SharedMap, native Map, Immutable.js Map and Immer Map. Each path has a real owning worker and two real reader workers. Every result is checked against a separate generated reference. The UI receives at most 12 product records and 12 validation issues, plus counts and fingerprints.

## Store objects at stable keys

The example uses the current object codec and public batch API:

<!-- example: catalog-snapshots -->
```ts
import { SharedMap, getWorkerData, json } from 'zerocopy';

type Product = {
  name: string;
  status: 'available' | 'unavailable';
  revision: number;
  attributes: { priceCents: number; stock: number };
};

const ProductValue = json<Product>();
const initial = new SharedMap(ProductValue).setMany([
  ['product/000000', {
    name: 'Product 0', status: 'available', revision: 0,
    attributes: { priceCents: 0, stock: 12 },
  }],
]);
const current = initial.setMany([
  ['product/000000', {
    name: 'Product 0', status: 'unavailable', revision: 1,
    attributes: { priceCents: 2500, stock: 0 },
  }],
]);

console.log(initial.get('product/000000')?.attributes.priceCents); // 0
console.log(current.get('product/000000')?.attributes.priceCents); // 2500

// Send this message with an existing Worker or MessagePort.
const message = getWorkerData({ products: current }, { copy: false });
```

A reader worker can attach to the supplied shared memory:

```js
import { initWorker } from 'zerocopy';

self.onmessage = async ({ data }) => {
  const { products } = await initWorker(data);
  const product = products.get('product/000000');
  self.postMessage({ priceCents: product?.attributes.priceCents });
};
```

Each `.get(id)` is a local read. JSON values decode into deeply frozen JavaScript objects in the reading thread. They are not direct binary field views. The current implementation can retain up to 2,048 decoded objects and 2 MiB of encoded object content in each arena's read cache. The benchmark separates first and repeated queries because the selected IDs can fit that cache.

## Give every design equivalent work

The comparison generates the same ID/object pairs for all four implementations. Its initial publication clones a native Map to each native or Immer reader, and entry pairs to each Immutable.js reader. Later publications clone only the 100 changed pairs. SharedMap sends new root descriptors backed by existing shared memory.

Every owner and reader keeps initial and current revisions. Native makes one shallow `new Map(initial)` when the first edit must preserve the initial collection. It then mutates its exclusively owned current Map on later edits. Changed objects are replaced, never mutated. Immutable.js uses `withMutations`; Immer uses one `produce` batch. Replica paths do not clone the full dataset on sparse publication.

SharedMap uses generic object `setMany` for initial construction and replacement. This exercises object serialization and bulk object staging. The example uses the current production runtime; no unmerged optimization is included.

## Read the measurements

The browser benchmark starts fresh owner and reader workers for every sample. Startup and module loading are outside the phase timers. Input generation, construction, initial publication, first query, repeat query, owner edits and edit publication have separate values. The page and raw export also show a directly measured edit-plus-publication duration. Two warm-ups and seven measured samples per implementation run in rotating order.

The same 1,000 IDs, 100 edits and two reader jobs apply to every path. First queries use fresh attachments; repeated queries can use local caches. Fingerprints cover every requested ID and all relevant record fields. Visible rows and validation results receive exact checks. Verification runs after the query timer. Browser timings exclude DOM painting and do not measure memory.

The separate [recorded memory report](../../docs/feature-map-memory.md) preserves the earlier synthetic-record fixture, not this product catalog. It uses fresh Node processes, 100,000 records, zero/two/four readers plus a separate eight-reader cohort and three trials per case. It reports JavaScript retention, tracked buffers, unique backing capacity, arena-used bytes and RSS separately. The original [SharedList memory report](../../docs/memory-comparison.md) remains historical evidence for its log-column workload.

## Keep the limits visible

The sample accepts no uploads. It has at most 100,000 products and 12 sparse edit revisions per session. Stop and navigation terminate the owner and reader workers. Releasing references permits collection; it does not promise immediate GC or per-node arena reclamation.

One allocating owner writes each arena. Compare a single native owner first if the UI only needs small answers and other workers do not need local data access.

## Read the live timings

The comparison highlights milliseconds for one selected phase: the latest read and validation, collection construction, initial handoff, or replacing 100 products and handing the revision to readers. Each relative result compares that phase with native Map in the same operation. “Less time” and “more time” describe this observation only; all four implementations run concurrently. Initial-load values remain labeled revision 0 after later edits.

Worker startup and module loading are excluded. Build and handoff have separate timers. The combined replace-and-handoff value comes from its own direct timer; it does not add parallel worker times. Reads include the lookup and validation replies, but exclude the owner’s reference check and UI rendering. Matching counts and fingerprints appear under the verification details. Use the separate benchmark for repeated samples.
