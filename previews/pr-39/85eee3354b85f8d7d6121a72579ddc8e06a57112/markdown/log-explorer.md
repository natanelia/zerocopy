# A live log explorer

[All use cases](../../docs/use-cases.md) · [Try the explorer](../README.md#log-explorer) · [Compare architectures](../README.md#investigation-benchmark)

Search application events, inspect an error spike, and retain an investigation while new events arrive. This is a working example of zerocopy's shared-data model, not a claim that zerocopy is a log-specific library.

## What the demo runs

The sample contains up to 100,000 generated events across four services. A payment timeout spike appears in the full dataset. You can search message text, filter level and service, select a time bucket, inspect rows, and page through results.

Start live events to append 2,000 events every 1.5 seconds. Freeze an investigation to retain the displayed snapshot. The live count continues to grow while your selected view stays fixed. Search and page navigation still work on the retained version.

No production data is loaded or uploaded. Data generation is deterministic. This site is not a production log viewer, persistence service, or advertised maximum-capacity test.

## One writer, three readers

```text
Ingestion worker (allocating owner)
           │ shared snapshot session
           ▼
UI (read-only snapshot and visible rows)
           │ same captured root descriptors
           ├───────────────┐
           ▼               ▼
     Search worker    Summary worker
       row indices      small aggregates
           └───────────────┘
             one view revision
```

The owner creates five shared columns: time, service, level, latency, and message. It publishes the columns as one root group, so readers never receive mismatched column versions.

Search and summary workers receive the exact same captured collection record for each query. They do not allocate in the owner's arena. Their replies contain a page of at most 50 row indices, counts, and 60 timeline buckets. The UI uses its retained snapshot to read the selected rows directly.

Numeric columns let a summary avoid decoding messages when there is no text filter. A text search still reads strings and can allocate decoded values. This is a deliberate representation choice, not a claim that arbitrary JSON becomes zero-allocation shared records.

## The code behind the view

The simple [getting-started example](../../docs/getting-started.md) uses a list of event messages to teach connection and direct reads. The live application uses columns so each calculation reads the fields it needs.

<!-- example: log-columns -->
```ts
import { SharedList } from 'zerocopy';

const before = {
  level: new SharedList('number').push(0).push(2),
  message: new SharedList('string')
    .push('Request completed')
    .push('Upstream timeout'),
};
const next = {
  level: before.level.push(2),
  message: before.message.push('Retry failed'),
};

// A local read from an earlier immutable snapshot.
before.message.get(1); // 'Upstream timeout'
before.message.size;   // 2
next.message.size;     // 3
```

The runtime modules are [owner](../assets/explorer-owner.mjs), [shared column storage](../assets/explorer-storage.mjs), [reader operations](../assets/explorer-reader.mjs), and [UI](../assets/explorer.mjs). The UI never calls a task to fetch one field.

This example uses its own small message protocol for whole search/summary requests and the library's snapshot transport. It does not require `defineTasks()`. The optional [task API](../../docs/task-quickstart.md) is another way to schedule calculations.

## Freeze without an imaginary API

Freeze retains the actual collection record and its revision. Each calculation receives those handles. New snapshots can still arrive on the live session without replacing the retained record.

This does not use a task `.at(snapshot)` method. That method is not implemented. The ordinary task executor only guarantees at least the requested publication revision; this application's explicit snapshot transport establishes a fixed calculation input.

The UI allows one search/summary pair in flight and keeps only the latest pending request. It applies a completed result only when the user intent still matches. A new filter cannot display an old filter's late result. New live snapshots may coalesce; the displayed revision shows which one the result actually used.

## Bound the lifetime

The demo stops at 200,000 events. It retains at most one frozen investigation, one displayed result, one running query, and one pending query. A stop or reset terminates all three workers, disposes the reader connection, and drops retained handles. It does not force garbage collection or reclaim individual nodes.

The shared arena can grow while a snapshot is pinned. Retaining an earlier root does not keep memory use equal to the earlier dataset size. A production stream needs rotated segments, retention limits, and planned compaction; the demo intentionally uses a bounded session instead of pretending to solve indefinite retention.

## Measure the alternatives

The investigation benchmark compares:

- Shared columns with two independent readers and local visible-row reads.
- Immutable.js List replicas, with batched persistent appends and only new values sent on updates.
- Native array replicas, with only appended events sent on updates.
- One native-data-owning worker that returns the results and visible rows.

It measures initial sharing, a query on an attached dataset, and append + publish + query. Construction, worker startup, and DOM rendering are reported separately or excluded explicitly. Every answer is checked against an independent native-array reference. The raw export includes all samples and the build source.

For append-only arrays, an earlier view can also be retained by a length boundary. This workload does not establish that zerocopy is uniquely necessary for freezing logs. It demonstrates the uniform shared-collection model and lets you compare costs.

## Apply the pattern elsewhere

Replace events with document nodes, table rows, product records, or graph edges. The ownership model remains: one producer publishes immutable versions; multiple components read locally. See [all use cases and alternatives](../../docs/use-cases.md), not just this example.

## Watch all three implementations

Open the [three-way comparison](../README.md#side-by-side-comparison) to apply the same controls to shared snapshots, Immutable.js Lists, and native arrays. Both replica baselines send incremental deltas by default. All three answers are independently checked. Immutable.js queries read real Lists directly; publication includes column encoding and List reconstruction. Frozen views retain real List roots, not converted arrays. Transport counters count logical event copies, not memory bytes. Use the [investigation benchmark](../README.md#investigation-benchmark) for rotated timing samples.
