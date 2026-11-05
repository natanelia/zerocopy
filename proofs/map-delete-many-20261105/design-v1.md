# Private paths for bulk map deletion

Frozen source baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.

`SharedMap.deleteMany` currently performs a complete persistent deletion for every key. No intermediate root escapes this public operation. The candidate retains the existing iterator and key-validation order, but allows the native deletion to update dense path nodes allocated by this call.

The ownership watermark is acquired on the first nonempty deletion. All nodes reachable from the input snapshot predate it. Only newly allocated paths become reachable from the private root. Reentrant iterator/getter callbacks can allocate and publish unrelated roots, but those roots never enter this private tree. Original snapshots, foreign snapshots, and all of their previously published bytes remain immutable. The native routine uses an explicit deletion flag because a changed private child can keep its address.

Ordinary `delete()` keeps its existing JavaScript and native paths. Keys too large for the writer scratch retain the existing scalar fallback. That fallback may cache a lookup against the current private root, so the watermark advances past all existing allocations immediately afterward; no subsequent deletion may mutate those cache-referenced roots.

## Evaluation declared before the pilot

- Targets: delete 1,024 of 4,096 ASCII keys; delete 4,096 of 16,384 keys in a scalar-built map with persistent overlays; delete 256 of 2,048 Unicode keys.
- Boundaries and controls: four removals, all misses, empty input, long-key fallback, unchanged scalar delete, unchanged bulk insert/update.
- Benchmark complete public calls, with identical inputs/repetitions, not an isolated native helper or a scalar-loop comparison inside the candidate.
- Before every timed batch, construct a fresh equivalent input snapshot outside timing. This bounds append-only allocation and keeps batch starts comparable. Retain every output until its complete entry order/values are checked. No-op outputs must retain identity. Verify the original published byte range after each batch.
- Retain raw warmup and measured samples, all allocation observations, negative controls and pilot results. Declared native-WASM differences are limited to the core and its byte-identical legacy aliases. Record all source and portable build hashes.
- Primary acceptance requires at least 10% less paired time with the interval excluding parity in both Node and Bun. A substantiated control loss above 5% blocks acceptance unless explicitly resolved. Pilot results do not establish final performance.
- Final confirmation uses six fresh process pairs with alternating AB/BA order, at least 500 ms actual timed warmup and nine measured batches. Separate A/A controls use four pairs. Use the shared exclusive timing lock and one CPU. Intervals use process pairs, not batches as independent samples.

No public API, binary node layout, descriptor version, release version or dependency changes are proposed.
