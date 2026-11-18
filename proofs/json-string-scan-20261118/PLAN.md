# Selected JSON string scan: fixed measurement protocol

This protocol is frozen before the seven-pair study. The baseline is
`1242908762b554e3574365c486d5a6c52d5e568f`. The candidate changes only the
selected-string boundary reader, `jsonStringEnd`; the ordinary byte scanner
used to skip keys and unrelated values remains unchanged. The raw reports
record the published candidate commit and exact source/build fingerprints.

The first two exploratory variants also changed the skip scanner. Both were
rejected for escape-heavy regressions and are preserved separately. The v3
pilot narrowed the optimization to selected strings. Its results choose this
candidate for confirmation; they are not pooled with the formal study.

## Frozen workload and runs

- Use the pinned project dependencies, Rust 1.100.0, Node 24.22.3 and Bun 1.4.2.
- Run all 25 cases in `workloads.mjs`, seven alternating baseline/candidate
  pairs per runtime, eight warmups, and batch scale 2.
- Run the same complete matrix with the baseline on both sides as an
  identical-build control. This reports host/runtime variation separately.
- Run one process at a time. Do not overlap with builds, tests or another
  performance experiment. Rotate case order by pair. Preserve every sample.
- Snapshot and fingerprint the actual portable JavaScript builds before
  timing. Node and Bun both consume these builds; the Bun source entry is
  outside this measurement scope.

The cases select ASCII strings with 0, 4, 8, 16, 64, 256 and 4096 serialized
payload bytes; Unicode and densely escaped strings with 256 and 4096 bytes;
numeric fields after each of those strings; first numeric fields with two-
and eight-byte keys; and a missing field in a small record.

Each case uses 64 separately prepared views of one retained record. The
operation count is fixed from the payload size and batch scale. Every returned
value is retained in a plain JavaScript Array and compared with `Object.is`
after timing, preserving both value and type. Shared used/capacity values and
every byte of the previously used shared arena are checked. Retained and
updated records are checked separately.

Inputs, construction, shared attachment, view preparation, warmup, optional
garbage collection and result verification are outside timing. The timed
operation is repeated `JsonView.get` scalar selection, including the normal
string decoding and string allocation. This is a warm-engine, single-record
measurement; no cold-cache, process startup, worker transport, ordinary
full-object `.get()`, browser speed or whole-application claim is implied.

## Acceptance decision

The primary cases are selected 4096-byte ASCII and Unicode strings. Each must
have a median paired candidate/baseline time ratio at most 0.90 and be faster
in at least 6/7 pairs, in both runtimes. All correctness and evidence checks
must pass. Any control with a ratio at least 1.10 and at least 6/7 slower
pairs blocks acceptance pending a separately recorded focused confirmation.

Adverse rows remain visible even when they do not cross that rule. The
identical-build control is never used to normalize, subtract from or erase a
candidate result. Time medians and medians of paired ratios are different
statistics and are reported separately. No significance or confidence-interval
claim is made. Batches below 20 ms are flagged and retained. JavaScript heap,
peak process memory and garbage-collection attribution are not measured.

## Reproduce

Build separate baseline and candidate checkouts using the pinned dependencies
with `bun run build:wasm` and `bun run build:browser`. Then run:

```sh
node proofs/json-string-scan-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --runtimes node,bun --bun /absolute/bun \
  --group json-string --pairs 7 --warmups 8 --batch-scale 2 \
  --output /absolute/new-string-formal.json

node proofs/json-string-scan-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/baseline \
  --runtimes node,bun --bun /absolute/bun \
  --group json-string --pairs 7 --warmups 8 --batch-scale 2 \
  --output /absolute/new-string-identical-control.json

node proofs/json-string-scan-20261118/verify.mjs \
  /absolute/new-string-formal.json /absolute/new-string-identical-control.json
```

Existing output files are refused. The verifier independently recomputes the
summary and checks the fixed workload catalog, operation counts, pair
coverage, source/build manifests and read-only assertions. Its role is
internal consistency checking, not proof of authenticity.
