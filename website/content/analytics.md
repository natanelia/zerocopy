# Product catalogs & filtering

A catalog page shows stock, search results, and recommendations from the same product data. A large catalog can use workers for filtering without copying the dataset into every worker.

This is an implementation pattern, not a measured application speedup.

## Send the question, not the dataset

Put the large collections in bound state. Pass small query parameters to an optional task: a threshold, selected IDs, or a range. Return the small result.

For example, a stock dashboard can count available products that need restocking. The threshold is the only task argument; the catalog stays in bound state:

```ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

type Model = { stock: SharedMap<'number'> };
export const tasks = defineTasks<Model>()({
  countLowStock({ state }, threshold: number) {
    let count = 0;
    state.stock.forEach(value => {
      if (value > 0 && value <= threshold) count++;
    });
    return count;
  },
});
```

The collection scan runs inside the worker. Individual reads do not cause remote calls. Connect this task with the [task quickstart](../../docs/task-quickstart.md), or keep your existing scheduler and use a [state session](../../docs/worker-sessions.md).

## From in stock to sold out

The [quickstart](../../docs/getting-started.md) follows one product: headphones with 12 units in stock. The owner applies an inventory update to zero. The UI can immediately show **Sold out**. A connected worker receives the new snapshot asynchronously, while its retained first snapshot still reads 12.

Use direct reads for product cards. Use the [catalog filter task](../../docs/task-quickstart.md) when background work is useful. It filters candidate product IDs in one call, excludes missing or sold-out products, and returns the available IDs.

These examples model a local catalog view, not a checkout system. The server remains responsible for stock validation and reservations. A snapshot can be old; zerocopy does not prevent overselling or coordinate purchases across customers.

## Use a pool for independent work

A pool is useful when independent calculations can use any worker. It keeps a bounded waiting queue and feeds large batches incrementally.

A pool batch can see different state revisions when the owner changes during execution. To use fixed inputs, bind a retained plain collection record rather than a changing source, and do not replace its handles during the calculation. This is not a cross-worker transaction.

Do not send huge result arrays back for every query without measuring that cost. Ordinary results use structured cloning. Shared collection results need a separate snapshot transport; task replies do not automatically reconstruct them.

## Measure the operation your user waits for

Measure input construction, data movement, attachment, calculation, and the result. A faster warm lookup does not prove a faster first query.

The [live benchmark](../README.md#benchmark-lab) measures one end-to-end scenario: sending a numeric map to dedicated readers, attaching it, and looking up every key. It includes per-publication attachment cost. Native Map can win. The [recorded report](../../docs/benchmarks.md) measures other collection workloads separately.

## Know when columnar data is a better fit

Packed numeric processing, SQL, compression, and columnar scans can call for typed arrays or a database engine. Zerocopy is a collection and snapshot tool, not an automatic replacement for those systems.

Start with your access pattern. Use sharing where repeated dataset copies are the problem, and keep the representation that suits the calculation.
