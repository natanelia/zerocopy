# Analysis & filtering

A dashboard can ask several questions of one dataset. Workers can read shared collections while the owner publishes new input versions.

This is an implementation pattern, not a measured application speedup.

## Send the question, not the dataset

Put the large collections in bound state. Pass small query parameters to an optional task: a threshold, selected IDs, or a range. Return the small result.

For example, a task can count speed-limit records above a threshold:

```ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

type Model = { limits: SharedMap<'number'> };
export const tasks = defineTasks<Model>()({
  countAbove({ state }, threshold: number) {
    let count = 0;
    state.limits.forEach(value => {
      if (value > threshold) count++;
    });
    return count;
  },
});
```

The collection scan runs inside the worker. Individual reads do not cause remote calls. Connect this task with the [task quickstart](../../docs/task-quickstart.md), or keep your existing scheduler and use a [state session](../../docs/worker-sessions.md).

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
