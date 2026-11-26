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
