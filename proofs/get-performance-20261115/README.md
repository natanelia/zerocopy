# Standard `.get()` performance investigation

The benchmark-only change landed as [PR #78](https://github.com/natanelia/zerocopy/pull/78), commit `1242908762b554e3574365c486d5a6c52d5e568f`. This is both the initial runtime baseline and the fixed website harness commit. Track B started from that then-current main. Repository instructions were checked again; no applicable `AGENTS.md` file is present.

This first commit contains measurement and profiling tools only. It makes no production runtime change and reports no speedup. The [study plan](study/PLAN.md) fixes the samples, fixtures, API contracts, timer boundaries, evidence format and regression checks before candidate measurements. The primary browser measurements run the exact committed website workers; the supplementary matrix covers map/list objects, scalars, cache limits, misses, nested descriptors and retained revisions.

Sequence: correctness pilot and fresh baseline; sampling and source-instrumented profiles; separate runtime hypotheses; seven alternating uninstrumented process pairs on each available runtime/engine; independent raw verification and a report. Source instrumentation is diagnostic only and is never included in the distributed library or in speedup evidence.

All ordinary `.get()` contracts remain required: native JavaScript return values, deep freezing, bounded cache admission and identity behavior, Unicode/number semantics, retained snapshots, and reader isolation. A roughly twofold cold-read gain is a research target, not a promised result.

The first correctness pilot found two study-tool errors before any runtime changes: a nested-map check used `type` instead of `valueType`, and that same field name replaced the NDJSON sample discriminator. All eight pilot processes failed and remain unusable as performance evidence. The tools now preserve distinct event/value-type metadata and validate the actual nested-map property. A new pilot is required; its results will not be pooled with the failed run.
