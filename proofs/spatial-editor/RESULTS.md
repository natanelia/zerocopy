# Shared-memory editor replay results

Rebuilding from packed bounds shortened median worker index construction from
**22.3 to 2.6 ms** on TanStack DB 1.0.0-rc.1.5. Four-reader validation on
commands that started a rebuild fell from **26.2 to 11.3 ms**. The adoption
targets are a 25% reduction in peak browser memory and a median trial p95
frame time at least as fast as the copy control. No recorded comparison has
met both targets in the same run.

## Four-reader packed rebuild comparison on 1.0.0-rc.1.5

Nine fresh Chromium trials rotated the order of the three editors across
three rounds. All used the same bundles, tile, commands, validators and
renderer. The shared editors differed only in how the worker rebuilt the
index. The copy control rebuilt from native JavaScript rows in every trial.

| Four-reader metric | Copy, native rows | Shared, decoded rows | Shared, packed bounds |
| --- | ---: | ---: | ---: |
| Median worker rebuild (ms) | 2.3 | 22.3 | 2.6 |
| Median validation on commands starting a rebuild (ms) | 6.8 | 26.2 | 11.3 |
| Median trial p95 validation, all commands (ms) | 15.8 | 24.0 | 17.5 |
| Median trial p95 frame (ms) | 587.3 | 193.3 | 269.0 |
| Median peak browser PSS (MiB) | 429.7 | 339.1 | 338.8 |

The first two rows pool 12 measured rebuilds or rebuild-start commands per
editor. The other rows use three trial summaries each. The packed editor used
21.1% less peak browser memory than the copy control and passed the frame
target in this run. Individual trial frame p95s ranged from 235.8 to 1540.8 ms
for copy, 180.7 to 629.1 ms for shared rows, and 113.2 to 1163.8 ms for packed
bounds. Worker timing isolates the rebuild improvement. The observed frame
variation limits conclusions about rendering speed.

One additional four-reader packed run completed 1,024 measured commands
and 65 rebuild requests including warmup. It reached revision 728 with
zero viewport, revision or retained-geometry mismatches and peaked at
339.6 MiB PSS. [Long-run samples](results/rebuild-packed-soak.json.gz)

Verify the recorded comparisons with the following commands. [Measured source](https://github.com/natanelia/zerocopy/commit/9c44dcadd510776a10ed6271b11e515912803c97) · [Packed and copy samples](results/rebuild-packed-readers-4.json.gz) · [Shared row samples](results/rebuild-rows-readers-4.json.gz)

```sh
node proofs/spatial-editor/summarize.mjs --readers=4 proofs/spatial-editor/results/rebuild-packed-readers-4.json.gz
node proofs/spatial-editor/summarize.mjs --readers=4 --mode=shared proofs/spatial-editor/results/rebuild-rows-readers-4.json.gz
```

## Earlier four-reader row rebuild check on 1.0.0-rc.1.5

The upgraded editor completed three paired trials of the same synthetic
workload. Every command passed the worker revision and viewport checks.
Peak process-tree PSS was 473.5 MiB for copy and 336.5 MiB for shared.
The median trial p95 was 161.5 → 197.2 ms for frames and 12.4 → 18.1 ms
for validation. Individual trial frame p95s ranged from 132.1 to 182.5 ms
for copy and from 144.9 to 244.1 ms for shared. Both editors in this
comparison used the release candidate. The experiment compares storage
strategies within that version. [Measured source](https://github.com/natanelia/zerocopy/commit/21dba3a6da7c21e548a8568aa05afb8b4b87c861) · [Raw samples](results/tanstack-1.0.0-rc.1.5-readers-4.json.gz)

```sh
node proofs/spatial-editor/summarize.mjs --readers=4 proofs/spatial-editor/results/tanstack-1.0.0-rc.1.5-readers-4.json.gz
```

## Browser measurements on 0.15.2

Each cell shows **copy → shared**. Memory is the median of three per-trial
peak process-tree PSS measurements. Latencies are medians of three per-trial
p95s. Each trial measured 64 commands after 16 warmups in a fresh browser.

| Dedicated readers | Peak PSS (MiB) | Memory saved | Command to completed frame (ms) | Command to all validation replies (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 353.2 → 324.3 | 8.2% | 193.5 → 313.8 | 7.1 → 19.7 |
| 4 | 473.4 → 336.5 | 28.9% | 152.5 → 162.6 | 9.9 → 18.8 |
| 8 | 630.9 → 352.2 | 44.2% | 128.6 → 163.3 | 8.8 → 21.3 |

Four-reader frame p95s ranged from 152.5 to 250.0 ms for the copy control
and from 160.2 to 232.3 ms for shared storage. The middle of three trials
determines the gate. The overlapping ranges and one host limit the conclusions
about interactive latency. At four readers, both editors uploaded 66,848 bytes
at p95. Their p95 CPU packing times were 0.34 and 0.51 ms respectively.

## Longer editing session on 0.15.2

One additional four-reader trial per editor ran 1,024 measured commands after
16 warmups, with 65 base-index rebuilds each. Both reached revision 728 with
zero viewport, revision or retained-geometry mismatches. The copy control
peaked at 471.6 MiB and shared storage at 353.5 MiB. Frame p95 was 243.4
and 262.5 ms respectively, and validation p95 was 9.4 and 18.3 ms. These
single runs check sustained editing separately from the three-trial gate.
[Copy samples](results/soak-copy.json.gz) · [Shared samples](results/soak-shared.json.gz)

## Workload and measurement boundaries

The synthetic tile has 4,096 lanes, 256 XY vertices per lane and 16 MiB of
input coordinates. Both editors use a TanStack live join, a shared Flatbush
base, the same deck.gl renderer, and a fresh set of dedicated workers. The
copy control sends only sparse edits after the initial tile. Each command
checks viewport membership against a full scan and checks the row and
geometry revision seen by readers. The opening cycle also checks GPU picking
through a vertex drag and undo.

The replays ran on 2026-11-26 on Linux with an AMD EPYC-Milan Processor and
Chromium 156.0.8078.4 using SwiftShader. Frame timing starts at command
dispatch and ends when WebGL finishes the first updated draw. Display
presentation and hardware GPU timing require separate measurements. PSS
covers the complete Chromium process tree and was sampled approximately
every 100 ms. The 16 MiB input is only one part of that footprint.

## Library direction

Keep the spatial index optional and keep TanStack responsible for live joins
and optimistic UI state. Multiple readers showed the clearest memory benefit.
Before recommending the shared editor as a default for latency-sensitive
workloads, profile the command-to-frame interval and worker publication and
validation separately, then run the same paired gate on a hardware GPU.
The current results give no performance reason to build a second reactive
engine or to standardize a GeoArrow rendering adapter.

## Reproduce the comparison

The source for the 0.15.2 trials is at
[`7ab181b`](https://github.com/natanelia/zerocopy/commit/7ab181b480b70cde3f683a61641dea8a42558f7a).
The [replay instructions](README.md) describe the build and browser setup.
The compressed reports contain the bundle hashes, per-command samples and
PSS time series. From the repository root, verify all 18 trials and
recalculate the table with the following command.

```sh
node proofs/spatial-editor/summarize.mjs proofs/spatial-editor/results/readers-{1,4,8}.json.gz
```
