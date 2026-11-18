# JSON array cursor: raw-value confirmation

This is a new confirmation of the same baseline and candidate runtime source and built JavaScript used by the original JSON array cursor measurement. It changes the benchmark's correctness checks, not the library. The original harness and recordings remain separate and unchanged.

The original numeric output buffers could convert an incorrect `null`, `false`, or string result into a number before comparison. This version stores returned values in ordinary preallocated Arrays and compares every actual value with `Object.is`. It also reads the retained view's final element before testing its boundary, backward access, and resumed forward access. These checks occur outside timing.

## Frozen protocol

- **Formal comparison:** all seven cases below, seven alternating baseline/candidate pairs in each of Node and Bun, eight warmup passes, batch scale **2**.
- **Identical-build control:** only reverse access to 4,096 elements and the object-field control, seven alternating pairs per runtime, eight warmups, batch scale **4**. Both labels use the baseline build. This repeats the original control scope and counts.
- Each label/pair/runtime runs in a fresh process. Workload order rotates by pair. Benchmark processes run sequentially without concurrent builds, tests, or other benchmark jobs.
- Preserve all samples and all controls. Do not subtract or divide out the identical-build results. Ratios summarize paired observations; they are not a significance test or a cross-platform guarantee.

| Case | Array size | Selected values per iteration |
| --- | ---: | ---: |
| `json-array.sequential.1024` | 1,024 | 1,024, in order |
| `json-array.sequential.4096` | 4,096 | 4,096, in order |
| `json-array.stride.4096` | 4,096 | 1,024, at indexes 0, 4, 8, … |
| `json-array.reverse.4096` | 4,096 | 4,096, in reverse order |
| `json-array.random.4096` | 4,096 | 4,096, in a fixed seeded permutation |
| `json-array.repeated.4096` | 4,096 | 4,096 repetitions of index 1,023 |
| `json-array.fields.control` | 4,096 | 4,096 reads of the enclosing object's numeric `id` |

Reverse and random cases target 8,192 calls times the batch scale; other cases target 262,144 calls times the scale. Iterations are rounded upward to complete passes. The verifier independently derives dimensions, operation counts, and expected checksums from this fixed case catalog.

## Runtime identity

Before this plan was committed, all 62 recorded source files and all 12 built JavaScript files in each checkout matched their original report fingerprints. The new reports must retain these source/build manifest identities; proof and test-only commits may change the recorded Git commit without changing runtime bytes.

| Variant | Original runtime evidence commit | Source manifest SHA-256 | Bundle manifest SHA-256 |
| --- | --- | --- | --- |
| Baseline | `1242908762b554e3574365c486d5a6c52d5e568f` | `a6fe0f6a55ad98294c9f36b7ae2e3c39abd493a1e9816259a152383fd2876d68` | `4f36bad25773ea0d159439f77037b933d9c8fccc2f658230ccfa20a0897c46b1` |
| Candidate | `75409acb6d9eab2b26b693c1d690568cd1cedb11` | `89bf5294834d19399892c1640bd26ef4fe1447e9d89a25661908a90b40b0fba0` | `f21451691687a1f34251b7de6a950e0b78c2217b721f34b6aa08c309b5a2ab9e` |

The driver stages the exact bytes captured for the source, bundle, driver, and workload hashes. Output files are created exclusively; existing evidence is never overwritten. Reports record actual runtime versions, platform metadata, workload configuration, raw durations, and all fingerprints.

## Exact commands for this checkout

Run these only after other CPU-intensive work has stopped. For another machine, substitute the checkout and executable paths while retaining all workload options and pinned build tools.

```sh
node /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/benchmark.mjs \
  --baseline /workspace/scratch/240add2fd2cb/zerocopy \
  --candidate /workspace/scratch/240add2fd2cb/zerocopy-json \
  --runtimes node,bun \
  --bun /workspace/scratch/240add2fd2cb/tools/node_modules/.bin/bun \
  --group json-array --pairs 7 --warmups 8 --batch-scale 2 \
  --output /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/formal.json

node /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/benchmark.mjs \
  --baseline /workspace/scratch/240add2fd2cb/zerocopy \
  --candidate /workspace/scratch/240add2fd2cb/zerocopy \
  --runtimes node,bun \
  --bun /workspace/scratch/240add2fd2cb/tools/node_modules/.bin/bun \
  --group json-array --pairs 7 --warmups 8 --batch-scale 4 \
  --only json-array.reverse.4096,json-array.fields.control \
  --output /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/identical-control.json

node /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/verify.mjs \
  /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/formal.json \
  /workspace/scratch/240add2fd2cb/zerocopy-json/proofs/json-array-cursor-20261118/confirmation-v2/identical-control.json
```

The verifier also accepts losslessly compressed `.json.gz` reports. It rejects incomplete or duplicate sample coverage, unknown/malformed case names, dimension or checksum mismatches, missing raw-value/cursor assertions, nonpositive or nonfinite timings, invalid manifests, and summaries inconsistent with the raw samples.

## Interpretation and limits

Timing covers selection into the raw result array. Input creation, attachment, view preparation, warmup, collection, and verification are excluded. Every timed pass starts with a fresh view, while code is warmed. Shared-byte integrity copies can warm CPU caches. These are local attached-reader queries, not process startup, worker-message latency, ordinary full-object `.get()`, or browser measurements.

Keep normalized median durations and paired ratios distinct. The verifier recomputes both and prints every control. Batches below 20 ms remain explicitly flagged; they do not support a precise speed claim. Read verification covers exact values, shared used bytes/capacity, all bytes in the used shared-memory prefix, and retained/updated records. It does not measure JavaScript heap allocation or peak RSS.
