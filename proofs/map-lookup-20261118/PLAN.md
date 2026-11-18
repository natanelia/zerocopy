# Short ASCII map lookup measurement protocol

**Status: rejected after measurement. Do not merge the map optimization.** The final candidate improved Node short-key reads but introduced material Bun regressions. Two isolated refinements were also rejected. The fixed protocol below remains intact; see [the complete results and verdict](README.md).

Every completed report is preserved losslessly as a `.json.gz` archive beside this file. The original uncompressed JSON files remain in the local workspace and are not duplicated in the commit.

Baseline: `1242908762b554e3574365c486d5a6c52d5e568f`.

Measured candidate: `56337fa7aa6dda4eed4dfcc22ecd7edf073cd082`.

The final runs use the shared driver in `../performance-20261118/`. Each report fingerprints the source, installed direct dependency versions, harness, and immutable copies of the actual built JavaScript. Both revisions use the same pinned build tools and installed dependencies.

## Fixed final runs

- `map-formal.json`: seven alternating baseline/candidate pairs in each of Node and Bun, eight warmups, batch scale 2, every `map` case.
- `map-identical-control.json`: the same matrix comparing the baseline with itself. These samples expose variation; they are never subtracted from or pooled with the before/after samples.
- `map-large.json`: seven pairs per runtime at 100,000 keys, eight warmups, batch scale 2. Cases are cold numeric reads for 8/16/32-byte ASCII keys, Unicode keys, and repeated 16-byte reads beyond cache capacity. This checks the effect of bypassing prefix-directory reuse in a larger trie.

The main matrix includes 8/16/32-byte ASCII keys, Unicode keys, missing keys, warm hits, full object `.get()` reads, retained/updated roots, and 32,768-key fresh and repeated scans beyond cache limits. Its ordinary dataset size is 10,000 keys; the warm working set is 1,024 keys. Each case records its exact count, timed operations, and iterations.

Inputs, owner construction, shared attachment, warmup, garbage collection when available, and verification are outside timing. Each cold pass gets a separately attached reader whose local caches are empty. Warm and repeated-overflow cases deliberately reuse a primed reader and are labelled separately. Timed checksums are consumed, then every returned value, deep freezing, arena capacity/allocation and every byte of the shared prefix are verified.

These measurements cover public API operations in a loaded runtime, not process startup, worker transport, or overall application startup. The integrity snapshot can warm CPU caches. Shared arena bytes are measured; JavaScript heap and peak process memory are not. Node and Bun consume the same portable build. Browser correctness is checked in CI; no local browser timing is claimed.

Each variant/pair runs in a fresh process. Order alternates A/B and B/A, case order rotates by pair, and all timing runs are sequential on one host without concurrent project builds or tests. All samples are retained; existing output files are refused. The median of matched candidate/baseline ratios is distinct from the ratio of the separate time medians. No confidence-interval or significance claim is inferred.

## Reproduce

Create clean worktrees at the two commits above. Install the pinned dependencies and run `bun run build:wasm && bun run build:browser` in each. From the candidate checkout:

```sh
node proofs/performance-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --runtimes node,bun --group map --pairs 7 --warmups 8 \
  --batch-scale 2 --output /absolute/new-map-formal.json

node proofs/performance-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/baseline \
  --runtimes node,bun --group map --pairs 7 --warmups 8 \
  --batch-scale 2 --output /absolute/new-map-identical-control.json

node proofs/performance-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --runtimes node,bun --group map --pairs 7 --warmups 8 \
  --count 100000 --batch-scale 2 \
  --only map.number.ascii8.cold,map.number.ascii16.cold,map.number.ascii32.cold,map.number.unicode.cold,map.number.ascii16.beyond-cache-repeated \
  --output /absolute/new-map-large.json
```

Use `--bun /absolute/bun` or `--node /absolute/node` for specific executables. Runtime versions and CPU metadata are recorded in every report. Existing real-worker growth proofs complement these local-attachment timings.
