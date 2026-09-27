# Optional typed tasks

[Documentation](README.md) · [Direct state access](getting-started.md) · [Workers and pools](workers.md)

Use tasks to ask a worker to run a calculation and return a result. Tasks are not required to read a shared value. A direct `.get()` on an attached collection is synchronous and local.

This small lookup demonstrates request/response mechanics. In an application, use tasks for whole calculations, such as route assessment, rather than wrapping each lookup in a remote call.

Follow the [source installation and browser setup](getting-started.md) first. These are three files in the same directory.

## Define the task

**tasks.ts**

<!-- example: dx-tasks -->
```ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

export interface Model { limits: SharedMap<'number'> }
export const tasks = defineTasks<Model>()({
  speedLimit({ state }, laneId: string) {
    return state.limits.get(laneId);
  },
});
export type Tasks = typeof tasks;
```

## Expose it in the worker

**limits.worker.ts**

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
  limits: new SharedMap('number').set('lane-1', 30),
});
try {
  const compute = await spawn<Tasks>(
    () => new Worker(new URL('./limits.worker.ts', import.meta.url), {
      type: 'module',
    }),
    { state },
  );
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
    state.update('limits', limits => limits.set('lane-1', 50));
    console.log(await compute.run.speedLimit('lane-1')); // 50
  } finally {
    compute.dispose(); // Disconnect and terminate the owned worker.
  }
} finally {
  state.dispose();
}
```

The result is `Promise<number | undefined>`. This example reads `30`, updates the owner state, then reads `50`. The task client handles publication before dispatch; you do not write an application message protocol.

A task waits for at least the publication it requests. It can use a newer snapshot if delivery coalesces updates. Once the handler starts, its snapshot stays fixed. This is not exact invocation-time snapshot pinning.

`spawn()` owns the worker it creates. The example disposes the executor before the state, including after a failed call. Task arguments and ordinary results use structured cloning.

Reuse `tasks.ts` and `limits.worker.ts` with the [local, existing-worker, and pool examples](workers.md). That guide also covers cancellation, shared ports, and the full API contract.
