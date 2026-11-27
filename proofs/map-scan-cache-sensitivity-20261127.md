# Map scan cache-budget sensitivity (proof only)

Production baseline: 84ad23a76ee197f45cbc7316017f28b5bbe93d6c. [48 raw CPU profiles](https://github.com/natanelia/zerocopy/actions/runs/45922473750) cover 10k and 100k, two readers, four phases, three trials. At 100k repeat, sampled exclusive time is 44.6% decodeAt, 14.0% freezeJSON, 10.4% UTF-8 decode, 16.1% leaves/forEach. Updated and retained have similar distributions. Inspector overhead is included; profiles are diagnostic, not latency measurements. At 10k repeat the corresponding fractions are 36.7%, 11.0%, 7.1%, 10.5%.

Do not transplant #68 traversal, #79 freeze walker or #86 field index/flat-object candidate. The current arena admits at most 2,048 decoded records and 2 MiB serialized payload, then never replaces admitted objects. Increasing limits could reduce repeated scan decoding but also retain two large decoded object graphs per reader after an edit. This experiment only measures that trade-off; it is not a proposal to raise default limits. Existing identity and cache-bound tests remain authoritative.

The runner builds one baseline and two temporary variants (16,384 records/2 MiB and 100,000 records/16 MiB), using only temporary modifications of arena.ts restored before execution. One excluded round, eight balanced rounds, A/A uses the exact baseline binary. Each sample starts a fresh parent and two actual workers, measuring initial publication + scan, five repeated scans, five after sparse edits, five historical scans and 1,000 interleaved old/new point reads per worker. All query digests, iteration order, old/new values and read-only behavior must match. Raw artifacts include per-phase per-reader heapUsed, parent RSS snapshots and process peak RSS (KiB); these are not per-worker RSS or exclusive JS heap. Peak RSS includes verification. Original native Map control remains separate. Keep this single proof lane; no preview, runtime PR, merge or deployment. Only a subsequent bounded design with real gains and memory/lifetime checks could be considered for production.

## Completed sensitivity (2026-11-27)

[Run 45928346996](https://github.com/natanelia/zerocopy/actions/runs/45928346996): all three jobs passed, 96 measured fresh-process two-reader trials, plus warmups. All per-row and ordered query fingerprints matched. Median phase round trips (five scans in repeat/updated/retained, not per-scan latency):

| Records | Cache | Initial ms | Repeat ms | Updated ms | Retained ms | Point ms | Peak process RSS MiB |
|---|---|---:|---:|---:|---:|---:|---:|
| 10k | baseline | 76.30 | 53.47 | 44.00 | 37.02 | 5.73 | 118.98 |
| 10k | mid | 75.04 | 21.72 | 29.10 | 15.09 | 4.62 | 140.26 |
| 100k | baseline | 155.16 | 515.05 | 511.75 | 501.32 | 6.21 | 239.33 |
| 100k | mid | 167.47 | 469.58 | 481.93 | 446.57 | 6.69 | 249.75 |
| 100k | high | 211.67 | 181.10 | 279.27 | 165.08 | 5.68 | 316.09 |

At 100k high, paired repeat ratio 0.350, first 1.376, peak RSS 1.320. Mid saves only ~10% repeat, worsens first and point reads. At 10k mid, repeat ratio 0.415, peak RSS 1.179. Small 1k timings are noisy (A/A point ratio 0.803); no useful cache increase there. Reject changing global defaults. No production changes or PR. A narrow remaining methodological question: existing initWorker(data, {previous:{map:old}}) was omitted from the trial and can reuse immutable decoded objects across revisions. Test this public option against no previous using identical builds and fixtures before deciding whether the larger-cache tradeoff deserves any further work. Do not treat initial/repeat differences as caused by the previous option, since it is only passed on updated attachments.
