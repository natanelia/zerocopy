# Backward and random reads on JSON arrays

`JsonView.at(i)` now builds a sparse list of byte offsets after a backward read at index 32 or higher. Later seeks begin at a known element close to the target. Forward-only readers keep their existing cursor. The index holds at most 256 offsets per used view and thins itself as it covers larger prefixes. The read path writes no shared bytes. JavaScript heap usage was not measured.

## Paired results

The existing [array confirmation driver](../json-array-cursor-20261118/confirmation-v2/benchmark.mjs) compared `4c69aef` with `9af905c`. The latter is the measured runtime revision. The fixture and measurement code are identical on both sides. Linux x64, Intel Xeon Platinum 8573C, Node 24.22.3 and Bun 1.4.2. Seven alternating pairs in fresh processes, one process at a time, six warm-ups and batch scale four. Each timed traversal starts with a fresh view of a shared record and stores all results. The driver verifies every returned value and the shared bytes after timing.

| Runtime | Traversal of 4,096 values | Baseline ms | Candidate ms | Median paired speedup | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | Reverse | 93.26 | 2.20 | 40.48× | 7/7 |
| Node | Random | 66.14 | 2.23 | 27.70× | 7/7 |
| Bun | Reverse | 121.15 | 2.22 | 50.98× | 7/7 |
| Bun | Random | 82.42 | 1.86 | 42.11× | 7/7 |

The two time columns are separate medians. Speedup uses the median paired time ratio. The shortest timed batches for the four primary rows were 11–16 ms on the candidate. Absolute durations vary across runtimes and machines.

| Control | Node candidate / baseline | Bun candidate / baseline |
| --- | ---: | ---: |
| sequential.1024 | 0.933 | 0.927 |
| sequential.4096 | 0.901 | 0.897 |
| stride.4096 | 0.774 | 1.002 |
| repeated.4096 | 1.006 | 0.964 |
| fields.control | 0.985 | 1.112 |

For controls, a ratio above one means slower. The unrelated field-read control took about 11% longer by the Bun paired median, with the candidate faster in three of seven pairs. No general speedup is claimed for field selection.

## Reproduction

Build the portable `dist` bundles in both checkouts with the pinned toolchain. From the candidate checkout run the command below with `BASE` pointing at the built baseline checkout.

```sh
node proofs/json-array-cursor-20261118/confirmation-v2/benchmark.mjs \
  --baseline "$BASE" --candidate . --pairs 7 --runtimes node,bun \
  --warmups 6 --batch-scale 4 --output /tmp/array-seeks.json
```

[Raw samples, build and source hashes, host, workloads and verification](paired.json.gz).
