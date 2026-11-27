# Current-main selective JSON read baseline — 27 November 2026

Baseline 84ad23a76ee197f45cbc7316017f28b5bbe93d6c. No production source changes. Successor to the retired shared-session lazy kernel candidate ([decision](https://github.com/natanelia/zerocopy/commit/f65f987ebcf881c88f515460e6cb99df171f7084)). #86 combined field index and flat-object freeze, with adverse 10k/100k cold selected-field query results; #93 already isolated the flat freeze investigation. Main now has native field scanning and a cursor, so do not rebase the old combined PR or assume its gains survive. #75's packed leaf construction is already present in main. Existing #99 remains separate proof-only and unqualified.

Use the existing website owner and two real Node worker readers, identical-build A/A alternating pairs (six measured plus two warmups) at 1k/10k/100k, and fixed selected-field workload, with equivalent projected output via getView, ordinary get, and native Map. The existing driver is reused from #86 with per-sample logging. Report cold and repeat query phases separately from initial transport, first useful answer, publication and verification; retain raw reports, hashes, and all correctness checks. The two A/A labels intentionally point to the same built checkout, not to distinct runtime changes. API/control comparisons are descriptive, not candidate speedup evidence. If repeat selected-field scanning still has meaningful room, identify which work is repeated (map lookup, field traversal, nested token reads) before implementing a bounded independent optimization; measure cold/scatter/retained-heap controls, not just repeat hits. If no useful opportunity, reject and move to another bottleneck. No public API/format changes or deployment; no PR at this stage.

## Baseline result and next diagnostic

[Run 45890920052](https://github.com/natanelia/zerocopy/actions/runs/45890920052) completed all three sizes. Pooled medians over 12 measured same-build samples per case (two labels × six pairs), milliseconds:

| Records | getView first / repeat | get first / repeat | native get first / repeat | shared / native initial publication (get) |
|---|---:|---:|---:|---:|
| 1k | 18.583 / 7.726 | 19.571 / 0.766 | 0.623 / 0.271 | 1.638 / 13.746 |
| 10k | 16.207 / 5.908 | 17.502 / 0.717 | 1.096 / 0.620 | 2.792 / 108.037 |
| 100k | 9.258 / 5.276 | 10.422 / 0.550 | 1.229 / 0.408 | 1.379 / 654.642 |

All 108 measured cases passed the website's complete projected-result verification, plus 36 warmups. Each queries 1,000 IDs in two real readers, including updated and retained snapshots. Native Map pays clone/attachment costs; ordinary shared get can reuse decoded objects; getView deliberately avoids a decoded-value cache. These are API tradeoffs, not candidate gains. A/A median repeat-query ratios for view were 0.966, 0.833 and 1.025 respectively: do not interpret small changes as improvements. Separate runners may differ across sizes.

Code inspection: each selected ID constructs a view, the per-view last-field cursor is lost on the next query, long fields use hash/candidate/verification, and decimals/strings may decode. The website query selects category/status, then name, nested attributes.priceCents and revision. No attribution yet; do not assume a shared index is the best fix. Profile the unchanged 100k website workload in real reader threads with Node inspector at 100 µs interval, four measured pairs plus two warmups, capture all four phases in both readers and compare getView vs get. Profiles are diagnostic only, not performance timings; separate self/inclusive stacks and check sample counts. Preserve raw profiles, per-phase outputs and hashes. Only after attribution choose a minimal independent candidate. No production changes; no preview or deployment.

## CPU attribution and bounded candidate (unverified)

[Profile run 45898325054](https://github.com/natanelia/zerocopy/actions/runs/45898325054), [192 raw profiles](https://github.com/natanelia/zerocopy/actions/runs/45898325054/artifacts/15154532968). Aggregate `timeDeltas` of samples with `runReadQuery` in the ancestor chain, excluding inspector start/stop, dispatch, and other non-query stacks; 24 profiles per API/phase (warmups and measured, both labels/readers). The raw profiles contain substantial inspector overhead; no wall-time or GC inference from these stacks.

| getView phase | in-query samples | sampled query ms | self-time share getView + JsonView constructor | find + findUncached | #field |
|---|---:|---:|---:|---:|---:|
| first | 724 | 206.4 | 9.9% | 24.9% | 5.5% |
| repeat | 267 | 55.7 | 27.7% | 2.8% | 4.3% |
| updated | 561 | 176.7 | 8.2% | 24.8% | 12.6% |
| retained | 125 | 29.1 | 14.6% | 4.4% | 4.6% |

Ordinary cold get instead shows decodeAt 25%, readObject 20%, freezeJSON 15.4% and findUncached 10.9% of sampled in-query time (716 samples). The profile does not support reviving #86's broad per-record index. Candidate targets avoidable view setup work: map header and bytes use one refresh; nested views use the parent's immutable range and do not calculate a root end only to discard it. Same public constructor, distinct views, range validation, no record cache, no format or WASM changes. Not a claim that all sampled view creation cost disappears.

Screen against pinned main with original website verification, 12 alternating pairs and independent same-run A/A controls, three sizes, ordinary get and explicit frozen materialization controls. Gate: meaningful repeat or updated query gain (at least ~15% paired median in larger relevant sizes, consistent across pairs and outside A/A noise), no material adverse cold/control or p95 results. If no clear gain, retire rather than tune. If positive, qualify random/scatter, more realistic query sequences, Bun/Chromium/Firefox, retained memory and exact-head CI before PR. No deployment or merge.


## Decision: retire view-setup candidate (2026-11-27)

[Screen 45911087783](https://github.com/natanelia/zerocopy/actions/runs/45911087783), exact baseline `84ad23a76ee197f45cbc7316017f28b5bbe93d6c`, candidate `4f56579e0d1f22c0f849dc025f17852e0c658030`. All 324 measured executions (including 108 A/A and 216 A/B) passed the website verification. Each size used six A/A and twelve alternating A/B pairs per API. Recomputed paired median baseline/candidate ratios from raw JSON lines (separate controls, no excluded samples):

| Records | View repeat A/A | View repeat A/B | View updated A/B | View retained A/B |
|---:|---:|---:|---:|---:|
| 1k | 1.008 | 1.010 | 1.049 | 1.187 |
| 10k | 0.826 | 1.160 | 0.996 | 0.852 |
| 100k | 0.770 | 0.932 | 1.017 | 0.683 |

100k retained view query median 4.395→6.433 ms, 0/12 faster pairs; retained round trip 6.148→7.961 ms, 2/12 faster. A/A paired retained ratios 1.082 (query), 0.977 (round trip). Frozen materialization repeat 3.200→4.911 ms, paired 0.747 versus A/A 0.994. 10k repeat win only 7/12 faster; 100k repeat and updated do not meet gate. No retained-memory advantage was established. Correctness pass is not a performance pass. Reject the candidate rather than tune noise; no more qualification or PR. Preserve exact branch and raw [1k](https://github.com/natanelia/zerocopy/actions/runs/45911087783/artifacts/15159614088), [10k](https://github.com/natanelia/zerocopy/actions/runs/45911087783/artifacts/15160061962), [100k](https://github.com/natanelia/zerocopy/actions/runs/45911087783/artifacts/15159789484). Do not revive #86 or #79 solely from these measurements. Main unchanged; no publication.
