# Shared product catalog

Use a string-keyed `SharedMap` when several workers need selected records from a large, changing catalog. The benchmark stores generated product records as JSON objects. Workers look up selected IDs and validate prices, stock and availability.

## Try the replacement

Open [Benchmarks](../README.md#catalog-benchmark) and select **Run on my device**. It builds the catalog, replaces 100 products, and checks current and retained revisions automatically:

1. Revision 0 has a zero price. The validation worker reports an invalid record.
2. After replacement, the product gets a price of 2,500 cents, unavailable status and zero stock.
3. Both workers check the retained initial revision, including the invalid price.
4. The current revision keeps the changed attributes.

The same workload runs across SharedMap, native Map, Immutable.js Map and Immer Map. Each path has a real owning worker and two real reader workers. Every result is checked against a separate generated reference. For hands-on editing and independent snapshot pins, use [Snapshot Studio](../README.md#playground).

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

Each `.get(id)` is a local read. JSON values decode into deeply frozen JavaScript objects in the reading thread. They are not direct binary field views. The current implementation can retain up to 2,048 decoded objects and 2 MiB of encoded object content in each arena's read cache. That byte budget is not a limit on decoded JavaScript heap. The benchmark separates first and repeated queries because the selected IDs can fit that cache. `getView(id)` is an explicitly different API for reading selected fields from bytes; a faster view query does not demonstrate faster `.get()`.

## Give every design equivalent work

The four baseline cases generate the same ID/object pairs and use **incremental copy** for native Map, Immutable.js Map and Immer Map. Initial publication clones a native Map to each native or Immer reader, and entry pairs to each Immutable.js reader. Later incremental publications clone only the 100 changed pairs. SharedMap sends new root descriptors backed by existing shared memory.

Every owner and reader keeps initial and current revisions. Native makes one shallow `new Map(initial)` when the first edit must preserve the initial collection. It then mutates its exclusively owned current Map on later edits. Changed objects are replaced, never mutated. Immutable.js uses `withMutations`; Immer uses one `produce` batch. These local update mechanisms are separate from data copying between workers. Sharing unchanged objects or collection structure within one worker does not share that worker’s JavaScript heap with another worker.

The benchmark's preserved legacy control measures the four baseline implementations across all phases and adds the three full-copy cases **only** for **Publish the edited revision** and **Replace and publish 100 products**:

- **Incremental copy:** clone the full catalog at load, then only the 100 changed ID/object pairs per edit.
- **Full copy:** clone the full catalog at load and the entire updated catalog to each reader on every edit, including unchanged objects. Readers rebuild or freeze the received collection and preserve their retained initial revision.

SharedMap publishes shared descriptors and appears first. For the two edited-publication phases, full-copy Native Map, Immutable.js and Immer appear immediately after SharedMap, followed by the three incremental-copy baselines. Other phases show SharedMap and incremental-copy baselines only. Full-copy samples still load identical data and verify current and retained reader snapshots; they do not duplicate construction or query measurements. The owner performs the same collection update for both copy strategies.

SharedMap uses generic object `setMany` for initial construction and replacement. This exercises object serialization and bulk object staging. The example uses the current production runtime; no unmerged optimization is included.

## Read the measurements

The browser benchmark starts fresh owner and reader workers for every sample and API. Its primary charts distinguish full-object `.get()`, the immediate cached repeat, and an identical selective projection using either `.get()` or `getView()`. The selective query returns ID, name, price and revision for available books; it never computes a full-record fingerprint. Explicit mutable and frozen `toObject()` materialization appears separately.

Local read times include output capture and exclude messaging. Both readers run in parallel; the chart uses the slower local duration and exports both. Construction through first answer adds construction, publication and the first complete worker round-trip **within each sample**, then computes the median. It excludes input generation and separately reported worker/module startup. Correctness checks inspect captured first and repeat answers only after both timings, then verify current and retained revisions after 100 edits.

The legacy control retains four baseline cases across input generation, construction, initial publication, first/repeated queries, owner edits and edit publication. Three additional full-copy cases measure **only** edited publication and the directly measured edit-plus-publication duration. Two warm-ups and seven measured samples per case run in rotating order: 49 measured legacy samples across seven cases. The version 4 export includes all 63 legacy records under a nested v3 workload, plus 99 records for eleven read cases. Unrelated full-copy metrics remain absent. Build and workload hashes, exact APIs, timer boundaries, raw order and failures accompany the results.

The same 1,000 IDs, 100 edits and two readers apply to every path within each workload. Baseline first queries use fresh attachments; repeated queries can use local caches. All paths, including full-copy cases, verify current and retained records against the independent reference after measured operations. Legacy fingerprints cover every requested ID and all relevant record fields; **fingerprint generation is timed**, while the independent comparison is untimed. Browser timings exclude DOM painting and do not measure memory.

The separate [recorded memory report](../../docs/feature-map-memory.md) preserves the earlier synthetic-record fixture with **incremental copy only** for native, Immutable.js and Immer replicas. It does not measure this product catalog or full-copy updates. It uses fresh Node processes, 100,000 records, zero/two/four readers plus a separate eight-reader cohort and three trials per case. It reports JavaScript retention, tracked buffers, unique backing capacity, arena-used bytes and RSS separately. The original [SharedList memory report](../../docs/memory-comparison.md) remains historical evidence for its log-column workload.

## Keep the limits visible

The benchmark accepts no uploads. Choose 1,000, 10,000, or 100,000 generated products under **Run options**. Each sample uses fresh workers and retains its initial and edited revision. Stop and navigation terminate the owner and reader workers. Releasing references permits collection; it does not promise immediate GC or per-node arena reclamation.

One allocating owner writes each arena. Compare a single native owner first if the UI only needs small answers and other workers do not need local data access.

## Read the live timings

The page opens with clearly labelled recorded results. **Run on my device** measures the explicit read workloads and preserved catalog control locally, then replaces the performance charts after all cases complete. The result label shows the actual environment, source and dataset size; the default is 10,000 products. Cancellation or failure keeps the previous completed charts and their label; the interrupted run remains separately downloadable with its partial samples and failure reason.

The charts distinguish cold and cached full-object reads, selective queries, explicit object materialization, and construction through the first answer. The legacy catalog control retains all nine original phases, including replacement plus publication, in a separate disclosure on the same page. Download the v4 JSON for all read and legacy samples, exact APIs, correctness checks, source hashes and environment. The legacy combined replacement-and-publication duration still comes from its own direct timer; it does not add parallel worker times.
