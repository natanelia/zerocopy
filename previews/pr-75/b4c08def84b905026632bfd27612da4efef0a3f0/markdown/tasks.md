# Optional typed tasks

[Documentation](README.md) · [Direct state access](getting-started.md) · [Workers and pools](workers.md)

Use tasks to ask a worker to run a calculation and return a result. Tasks are not required to read a shared value. A direct `.get()` on an attached collection is synchronous and local.

A catalog worker filters a group of candidate products. Headphones and a keyboard start in stock; a mouse is sold out. After a stock update, the same filter returns only the keyboard.

The small dataset makes the result easy to check. Keep small filters on the main thread; use a worker when the real calculation is large enough to justify dispatch.

Follow the [package installation and browser setup](getting-started.md) first. These are three files in the same directory.

## Define the task

**tasks.ts**

<!-- example: dx-tasks -->
```ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

export interface Model { stock: SharedMap<'number'> }
export const tasks = defineTasks<Model>()({
  findAvailable({ state }, productIds: readonly string[]) {
    return productIds.filter(id => (state.stock.get(id) ?? 0) > 0);
  },
});
export type Tasks = typeof tasks;
```

## Expose it in the worker

**catalog.worker.ts**

<!-- example: dx-worker -->
```ts
import { serve } from 'zerocopy/worker';
import { tasks } from './tasks';

await serve(tasks);
```

## Call it from the main thread

**main.ts**

<!-- example: dx-main -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { spawn } = await import('zerocopy/worker');

const state = createState({
  stock: new SharedMap('number')
    .set('headphones', 12).set('keyboard', 8).set('mouse', 0),
});
try {
  const compute = await spawn<Tasks>(
    () => new Worker(new URL('./catalog.worker.ts', import.meta.url), {
      type: 'module',
    }),
    { state },
  );
  try {
    console.log(await compute.run.findAvailable(['headphones', 'keyboard', 'mouse'])); // ['headphones', 'keyboard']
    state.update('stock', stock => stock.set('headphones', 0));
    console.log(await compute.run.findAvailable(['headphones', 'keyboard', 'mouse'])); // ['keyboard']
  } finally {
    compute.dispose(); // Disconnect and terminate the owned worker.
  }
} finally {
  state.dispose();
}
```

The result is `Promise<string[]>`. The first result is `['headphones', 'keyboard']`. After the headphones sell out, it is `['keyboard']`. Missing products and zero stock are excluded. The task client handles publication before dispatch; you do not write an application message protocol.

A task waits for at least the publication it requests. It can use a newer snapshot if delivery coalesces updates. Once the handler starts, its snapshot stays fixed. This is not exact invocation-time snapshot pinning.

`spawn()` owns the worker it creates. The example disposes the executor before the state, including after a failed call. Task arguments and ordinary results use structured cloning.

Reuse `tasks.ts` and `catalog.worker.ts` with the [local, existing-worker, and pool examples](workers.md). That guide also covers cancellation, shared ports, and the full API contract.
