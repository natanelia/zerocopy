# Maps & spatial tools

Keep your map editable while workers inspect it. This is an implementation pattern, not a claim that a specific production application uses zerocopy.

## The problem

A map editor may have lane records, route metadata, selection state, and derived indexes. Copying all of that into every analysis worker can make data movement part of every operation.

Put the large, shareable collections in the data layer. Keep small UI state, such as open panels and pointer position, in the normal application store.

## Share the inputs. Return the answer.

The main thread owns the editable collections. Dedicated workers receive snapshots and run independent checks. Results can be small: invalid lane IDs, counts, or route warnings.

Start with the [direct-read quickstart](../../docs/getting-started.md). Inside its connected worker, a complete calculation can read one captured snapshot:

```ts
// Inside the connected worker from the quickstart.
const snapshot = shared.current;
const laneIds = ['lane-1', 'lane-2'];
const unknown: string[] = [];

for (const id of laneIds) {
  if (snapshot.limits.get(id) === undefined) unknown.push(id);
}
```

There is no RPC inside this loop. Your existing worker can call it directly. An optional task executor can schedule the whole calculation.

## Keep edits and results in order

Capture an application edit revision when you request an assessment. Before applying its result, check that the relevant inputs have not changed. Do not infer exact input pinning from a task Promise or from a pool batch.

Independent workers can receive the same root group with `state.connect([workerA, workerB])`. Use a pool when interchangeable jobs need scheduling. Keep separate workers when they have distinct roles or long-lived local indexes.

## Divide the dataset deliberately

A tile or layer can be a useful unit of work. However, objects near a tile boundary may need neighboring data. Share the required input roots together and make the dependency explicit.

Do not assume that dividing work into tiles automatically gives one writer per arena. Logical partitioning and memory ownership are separate design choices. Measure retained memory and snapshot lifetime before choosing a compaction policy.

## When to use another tool

Zerocopy does not replace a spatial database, coordinate system, geometry algorithm, or GPU buffer pipeline. It supplies shared immutable collections and optional worker execution.

Use typed arrays when a packed numeric buffer is the right representation. Use a spatial index when the query needs one. Compare the full workflow, including conversion and attachment, rather than one lookup in isolation.

[Try real worker reads](../README.md#playground) or [connect your existing workers](../../docs/workers.md#connect-an-existing-worker).
