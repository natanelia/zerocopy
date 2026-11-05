# Queue front cache: fixed initial screen

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`, built independently in
`zerocopy-r4-base`. The candidate changes only the committed-tree branch of
`SharedQueue.peek`: call the existing `Arena.vectorValue` instead of `wasm.vecGet`.
That cache identifies a leaf by immutable root, depth and 32-value block. Queue
dequeues preserve those coordinates, allowing adjacent fronts to reuse a lookup.
The tail path, constructor/dequeue wrappers, codec and WASM remain unchanged.

The potential weakness is extra cache checks when roots alternate. Complete
drains may also be dominated by snapshot construction. Those costs remain timed;
repeated-peek results alone do not establish a faster FIFO drain.

| Case | Fixture | Complete timed operation | Role |
| --- | --- | --- | --- |
| empty-peek | Empty numeric queue | One peek | Empty control |
| tail-drain | 32-number queue | Peek/dequeue until empty | Unchanged tail path |
| first-block-drain | 33-number queue | Peek/dequeue until empty | First committed block |
| tree-drain | 4,097-number queue | Peek/dequeue until empty | Normal FIFO target |
| deep-drain | 65,537-number queue | Peek/dequeue until empty | Deeper FIFO target |
| repeat-peek | 4,097-number queue | 256 peeks of the same front | Repeated-read target |
| alternating-roots | Four 1,025-number queues in one arena | Drain round-robin, switching roots each peek | Cache-miss adverse control |
| string-drain | 4,097 distinct Unicode strings | Peek/dequeue until empty | Decode-cache overflow |
| object-drain | 1,057 nested JSON values | Peek/dequeue until empty | Warm generic decode |
| unchanged-stack | 4,097-number stack | Peek/pop until empty | Unchanged collection control |

Construct fixtures outside timing, with one private Arena per subject. Every
complete operation starts from the same retained immutable fixture. For drains,
all new queue/stack wrappers and ordinary garbage collection remain timed.
Caller output buffers and round-robin cursor arrays are prepared once per
repetition count and reused; initialization of cursor references stays timed.
Full output values and actual counts are checked after every batch. Prepared
oracle arrays contain every expected value for every repeated operation; stale
slots cannot hide a missing traversal because actual counts must also match.
Every batch must leave shared arena usage unchanged. Normal bounded decode
caches remain active; the JSON fixture fits the cache, the strings exceed it.

The initial screen uses two balanced AB/BA process pairs per runtime/case,
seven measured batches, common repetition counts and at least 150 ms of timed
warm-up (eight batches). Empty has a documented 256-batch warm-up cap. Common
repetitions target an 8 ms batch, capped at 524,288 retained values (131,072 for
JSON). Coarse and fixed-count disposable calibrations are saved separately.
Every process loads one build and one workload from the same neutral import
path, with all bundle chunks replaced between processes. All heavy work holds
the common perf.lock; benchmark processes inherit CPU 2 affinity.

Freeze and commit source before timing. Preserve every pilot, unfavorable case,
driver, source/bundle hash and failure artifact. Only if the screen supports a
worthwhile complete-operation win without a clear adverse-path loss, proceed to
six balanced confirmation pairs per engine/case, nine batches, at least 500 ms
warm-up and the same cases. Otherwise reject this candidate transparently and
consider the separately scoped priority-queue view hypothesis. No source tuning
or workload exclusions are planned to make this screen pass.
