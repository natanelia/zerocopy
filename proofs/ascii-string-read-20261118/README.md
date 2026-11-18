# Rejected experiment: grouped short-ASCII decoding

**Not recommended for merging. No PR was created.** The frozen candidate passes
all four Node ASCII performance targets, but it fails the predeclared Bun
Unicode control gates. This directory preserves the failed experiment and its
evidence; correctness checks and Node wins do not override that rejection.

## Change and comparison

The candidate changes only `Arena.string`'s short-string read path: it reads four
bytes from the byte array, checks their combined high bit, and constructs four
ASCII characters at a time. The 32-byte cutoff, scalar tail, full UTF-8 fallback,
cache limits, and ordinary collection APIs stay the same. No WASM format changes
are part of this candidate.

| Identity | Commit |
|---|---|
| Current-main baseline | `4c69aef6e37b6bc955fc708d671e33b5a066ac7a` |
| Measured candidate, with frozen plan/harness | `10bebf25d2a6ad01bb8203a19facc33c75c03190` |
| Candidate implementation commit | `97cced8c52ffde8f4be5ca6810526c723911b9e4` |

The measured candidate tree is
`21e1cb17a7d4a6af7132d774c7381dfacee5c649`, on
`perf/ascii-string-decode-20261118`. Both variants include the previously merged
JSON changes from PRs #81 and #83. Earlier exploratory screens used baseline
`1242908`; their measurements were not pooled with these current-main studies.
Exact source/bundle manifests are inside the raw reports, and [source identity](validation/source-identity.json)
records the unchanged transplanted Arena/test patch. Existing build/typecheck/test
results are retained in [validation commands](validation/commands.json).

## Fixed method

The [plan](PLAN.md) predates measurement. Separate A/A and A/B studies each ran
seven alternating pairs on Node 24.22.3 and Bun 1.4.2, all 13 cases, batch scale 2,
and eight warmups. Every controller and worker was bound to CPU 2 on Linux x64
(AMD EPYC 9V45). Each study contains 28 fresh worker processes, 364 workload rows,
and 26 runtime/case summaries; each case sample performs 524,288 reads or yielded
keys.

The engine is warm. A "cold" case means a fresh attached reader and local read
cache, not a cold CPU or engine. Construction, attachment, GC, and verification
are outside timing. Actual timed strings are retained in ordinary Arrays and
checked afterward. Every distinct reader Arena/WASM instance is checked, and
shared-byte comparisons deduplicate common memory. These are reads within the
writer process, not cross-worker transport or startup measurements; JavaScript
heap size, RSS, and GC attribution are not measured.

## Results and frozen gate decision

Ratios below are the **median of candidate/baseline paired elapsed-time ratios**;
less than 1 means less elapsed time. The count after each ratio is faster pairs
out of seven. `*` marks at least one batch below 20 ms. Full precision and every
pair remain in the reports.

| Case | Node ratio / faster pairs | Bun ratio / faster pairs |
|---|---:|---:|
| list.string.get.ascii16.cold **primary in Node** | 0.5706 / 7/7 | 0.7445 / 6/7 |
| list.string.get.ascii32.cold **primary in Node** | 0.5627 / 7/7 | 0.6997 / 7/7 |
| list.string.get.ascii16.over-cap | 0.6565 / 7/7 | 0.4650 / 7/7 |
| list.string.get.ascii16.warm | 0.8769 / 6/7 * | 1.1670 / 2/7 * |
| list.string.get.boundaries.cold | 0.5569 / 7/7 | 0.6693 / 7/7 |
| list.string.get.unicode.cold | 0.9221 / 5/7 | 1.1110 / 1/7 |
| list.string.get.ascii64.cold | 1.0027 / 3/7 | 1.0663 / 3/7 |
| map.keys.ascii16.cold **primary in Node** | 0.7347 / 6/7 | 0.7303 / 6/7 |
| map.keys.ascii32.cold **primary in Node** | 0.3432 / 7/7 | 0.6887 / 7/7 |
| map.keys.ascii16.over-cap | 0.8842 / 6/7 | 0.4267 / 7/7 |
| map.keys.ascii16.warm | 0.8925 / 6/7 | 1.0591 / 3/7 |
| map.keys.boundaries.cold | 0.5729 / 7/7 | 0.5025 / 7/7 |
| map.keys.unicode.cold | 0.8980 / 4/7 | 1.2598 / 1/7 |

All four Node primaries meet both requirements: ratio <=0.90 and at least six
faster pairs. The controls independently reject the candidate:

- **Bun Unicode List reads:** ratio **1.1110**, about **11.1% more elapsed time**,
  slower in **6/7** pairs; minimum batch **120.25 ms**.
- **Bun Unicode Map-key iteration:** ratio **1.2598**, about **26.0% more elapsed
  time**, slower in **6/7** pairs; minimum batch **126.39 ms**.

Both exceed the control limit of 1.10 with the required consistency. Neither
regression is a short-batch issue. The intended claim was limited to Node ASCII
improvements, but the plan also required acceptable controls in both runtimes.

The separate A/A study has a Bun warm-List validity HOLD: ratio **1.1475**, slower
in **6/7**, minimum batch **5.70 ms**. A/B's same warm case is also adverse
(**1.1670**, slower **5/7**, minimum **5.61 ms**) and remains a short-batch HOLD.
The [pre-interpretation addendum](WARM-VALIDITY-ADDENDUM.md) allowed a fixed
longer-batch warm study only if all other gates remained eligible. The two
independent Unicode regressions cancel that follow-up. **It was not run.**

A/A was never used to normalize or excuse A/B. The original addendum is preserved
byte-for-byte, including its initially communicated A/A ratio of 1.1468; the
completed raw A/A report recomputes to **1.1474994501625524**. This small recording
correction changes no gate. The [machine-readable decision](decision.json)
records every A/B gate, all A/A flags, and the cancelled follow-up. These are
engineering acceptance rules, not a claim of statistical significance.

## Evidence and verification

- [A/A raw report](results/ascii-current-aa.json.gz) and [verification output](results/ascii-current-aa-verified.json).
- [A/B raw report](results/ascii-current-confirmation.json.gz) and [verification output](results/ascii-current-confirmation-verified.json).
- [Archive manifest](archive-manifest.json): original JSON hashes, compressed
  hashes, byte counts, and exact-copy identities for verification outputs and the
  addendum. Gzip uses level 9 with timestamp zero; decompression preserves the
  original report bytes exactly.

Both reports passed the frozen verifier, including actual source/bundle bytes,
harness hashes, CPU affinity, dimensions, every ratio, and every summary. An
independent calculation from the raw samples also reproduced all 52 summaries.
Verification checks recorded integrity claims; it does not rerun timed reads.

From the repository root, verify archive consistency and frozen harness bytes:

```sh
ASCII_PROOF_DIR=proofs/ascii-string-read-20261118
node "$ASCII_PROOF_DIR/ascii-verify.mjs" "$ASCII_PROOF_DIR/results/ascii-current-aa.json.gz" --manifest-only
node "$ASCII_PROOF_DIR/ascii-verify.mjs" "$ASCII_PROOF_DIR/results/ascii-current-confirmation.json.gz" --manifest-only
```

For full file verification, provide checkouts containing the exact recorded source
and portable bundles. The A/A candidate path is the baseline checkout:

```sh
ASCII_BASELINE_CHECKOUT=/path/to/baseline
ASCII_CANDIDATE_CHECKOUT=/path/to/candidate
node "$ASCII_PROOF_DIR/ascii-verify.mjs" "$ASCII_PROOF_DIR/results/ascii-current-aa.json.gz" --baseline "$ASCII_BASELINE_CHECKOUT" --candidate "$ASCII_BASELINE_CHECKOUT"
node "$ASCII_PROOF_DIR/ascii-verify.mjs" "$ASCII_PROOF_DIR/results/ascii-current-confirmation.json.gz" --baseline "$ASCII_BASELINE_CHECKOUT" --candidate "$ASCII_CANDIDATE_CHECKOUT"
```

To reproduce the measurement method independently, use the recorded runtime
versions, those frozen builds, an otherwise quiet CPU slot, and **new output
paths**. These commands are documentation; no new study was run to write this
archive:

```sh
ASCII_BUN_BIN=/path/to/bun-1.4.2
taskset -c 2 node "$ASCII_PROOF_DIR/benchmark.mjs" --workloads "$ASCII_PROOF_DIR/ascii-workloads.mjs" --baseline "$ASCII_BASELINE_CHECKOUT" --candidate "$ASCII_BASELINE_CHECKOUT" --bun "$ASCII_BUN_BIN" --runtimes node,bun --pairs 7 --batch-scale 2 --warmups 8 --output new-ascii-aa.json
taskset -c 2 node "$ASCII_PROOF_DIR/benchmark.mjs" --workloads "$ASCII_PROOF_DIR/ascii-workloads.mjs" --baseline "$ASCII_BASELINE_CHECKOUT" --candidate "$ASCII_CANDIDATE_CHECKOUT" --bun "$ASCII_BUN_BIN" --runtimes node,bun --pairs 7 --batch-scale 2 --warmups 8 --output new-ascii-confirmation.json
```

The rejected runtime change is retained for review only. No additional runtime
variant, performance PR, or warm-cache follow-up is proposed.
