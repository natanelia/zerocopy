# Independent audit: original numeric two-way SIMD screen

**Do not advance this screen.** The original attempt failed its mandatory untimed admission. Bun 1.4.2 resolved the fixed numeric query alias to the same exported `countInRange` function, so the first alias-isolation assertion stopped Bun baseline before any case or start record. Node baseline and candidate completed. Bun candidate was explicitly not run. Calibration and all four-block performance measurements were skipped.

The official [run 37946676323, attempt 1](https://github.com/natanelia/zerocopy/actions/runs/37946676323) concluded **failure** at 14:48:50 UTC on 2026-10-09. Its [original artifact](https://github.com/natanelia/zerocopy/actions/runs/37946676323/artifacts/11624007266) was uploaded successfully. A successful preservation or report workflow step is not a performance pass: the report step's conditional did not generate a screen report because no screen ledger exists.

The independent audit passed **9,322 checks**, with its first invocation retained in `attempt-01.json`. It did not import or execute the subject, invoke a compiler, sample a library operation, change source, retry the workflow, or mutate GitHub. The archived run remains unchanged.

## What actually ran

| Original stage | Baseline | Candidate |
|---|---|---|
| Fresh standard plus numeric gates | 32/32 commands passed | 32/32 commands passed |
| Unmodified full Vitest suite | 41 files; 774 tests passed | 41 files; 774 tests passed |
| Fresh source, output and tool freeze | Passed | Passed |
| Node 22.23.3 untimed subject | 18/18 rows, complete | 18/18 rows, complete |
| Bun 1.4.2 untimed subject | Failed before first output | Not run |
| Calibration | Not run | Not run |
| Measurement | Not run | Not run |

All nine cases remain accounted for: automatic range sizes 1, 3, 4, 32, 4,096, 32,768 and 32,769; forced-scalar range size 32,768; and the 16,384-point spatial control. Each surviving Node arm has exactly two untimed rows per case, using the literal minimum and maximum ladder counts. Thus **36 of the required 72 semantic rows survive**, and zero operation-duration samples exist. Every one of the 18 runtime/case performance cells is unmeasured. No ratios, confidence intervals, A/A comparisons, or supported gain/loss classifications can be calculated.

Both Node subjects recorded distinct automatic/scalar closures, one successful automatic probe, one forced-false scalar probe, no new probe on repeated cached calls, and restoration of `WebAssembly.validate`. The independent audit reconstructs all nine fixture digests and query count vectors, checks all 36 exact checksums and final counts, verifies matching retained descriptors and memory digests before/after, and reconciles tree/tail sizes, capacity and resource limits. These are actual archived Node records; the auditor did not re-execute the library. Full backing-memory bytes were not separately archived, so the matching memory digest values are subject assertions rather than independently reconstructed memory images.

The Bun stderr is precise: `AssertionError: Alias must have an independent module closure`, at `selectionGuard`, subject line 53, before the guard replaces `WebAssembly.validate` or the subject emits its start record. The already-successful standalone forced-scalar corpus is a separate process design and does not establish the mixed-process query-alias isolation required by this subject. This failure is a harness/runtime admission failure; it is not an observed numeric result mismatch or measured candidate slowdown.

The prior row-buffering scope limitation is still relevant to the general harness. In this run, no operation clocks began, and Bun failed before the first case. There is therefore no evidence of lost interrupted body durations; none are claimed to have been preserved.

## Identity and artifact integrity

- Baseline source: `f4fad3a850cb544ff9440d263eeec464a31dd123`, tree `b5cf2c9362b09d442056cd9edce944446bba8c6c`.
- Candidate source: `50d91158eeff95456dd2945cba2140ab08e9f029`, tree `de653792a52f64a76723bc4a4a82c3b0fd3ec051`, sole baseline child.
- Reviewed inactive packet: `f06799727dcd1008d86fb6321b972c711c9357dc`.
- Activation: `963774efba94515e7a2005f36d743ff20fa9cffc`, tree `b287843987345fb3d8475dd9b6e99fad344a24ac`. It is the exact inactive packet's sole child, changing only activation intent.
- Packet SHA-256: `ab0fcdb75028106aad505db261f010109315767b2885a73fe068a456721d31c7`.
- Frozen manifest SHA-256: `31ec240d113af28fea1d8abe5f3064527db031b434df35dc44e4101a11db9077`.
- Official ZIP SHA-256: `c6f841e7c138cfaf52c8c99dd34128d5229206b91fa2ae19b8b6b89068b7e903`.

The ZIP digest matched the official GitHub record **before extraction**. All 312 ZIP paths are unique, relative, traversal-free, and free of symlinks or special files; extracted bytes match the original archive. Inventory coverage, hashes, byte counts and preservation status reconcile. Both source tar archives contain exactly 453 tracked files whose Git blob IDs and modes match the pinned trees; only `numeric-kernels.as.ts` differs between arms. The accepted 40-file packet and all available frozen harness bytes match the inactive proof commit. The later main `52d5fb0` does not relabel either source arm or these results.

Each arm's 65 fresh output files were independently rehashed: 12 WASM files, 12 portable JS files and 41 declarations. Only `numeric-kernels-simd.wasm` and its embedded numeric JS loader differ. An independent binary parser confirms only code section/body 2 changes: body 140→232 bytes and module 782→874 bytes, a 92-byte increase. The scalar numeric WASM, other ten WASM files, eleven other JS files and every declaration remain byte-identical. Embedded scalar and SIMD binary bytes match their corresponding standalone WASM files.

Both compiler paths appear in the final manifest: 272 AssemblyScript/Binaryen/long/TypeScript package files per arm, plus three shared runtime/tool executables. Both compiler inventories agree and match before/after-gate records; each executed subject and the final ledger attest successful verification. **Those runtime/compiler files were not archived.** Their hashes and subsequent verification are attested checks, not bytes the auditor independently rehashed. Sources, generated builds, harness, raw stdout/stderr, gates and receipts were independently rehashed.

## Gates, cleanup and interpretation

All 64 fresh gate commands match their fixed ordered commands and source working directories, with successful exit codes, raw log hashes and quiescent owned groups. Full-arm gate envelopes were 54.60 and 53.09 seconds, inside the unchanged 900-second limits. Setup used frozen dependency installs. The fresh corpus, consumer typecheck, worker proofs and standard suite precede the first untimed launch. Both arm gates and all three executed untimed subjects have clean owned-process termination; the failed Bun subject exited normally with code 1 and left no owned writers. Final preservation reports no unresolved writers.

The original focused baseline 44/45 and candidate 43/45 outcomes, candidate-specific timeout, and subsequent diagnostic baseline timeout remain historical evidence. These fresh passes neither erase those failures nor establish their cause. The fixed first-import, first-call, decode/compile/first-instance and spatial-only startup questions remain unresolved despite the fresh output comparison. The real 92-byte SIMD growth remains a cold-use risk. Browser, ARM and Apple Silicon performance also remain unmeasured.

The admission guard correctly prevented timing after its original Bun prerequisite failed. The original attempt must remain failed and complete as evidence; repairing alias isolation, if authorized, belongs to a separately reviewed successor. No extra samples, selected-slot resumption or effect-driven retry was performed.

## Audit files

- `audit.py`: read-only independent byte, source, gate, row and cleanup verifier.
- `result.json` and `attempt-01.json`: machine-readable audit checks and nine reconstructed fixture oracles.
- `../materialization.json`: transfer failure/success and digest-before-extraction receipt. The first urllib client returned HTTP 403/Cloudflare 1010; normal curl obtained the same unchanged tool-issued URL successfully. No URL rewrite, credential change or permission bypass occurred.
- `../github-run-terminal.json`, `../github-jobs-terminal.json`, `../github-artifacts.json`, `../github-job.log`: official terminal evidence.
- `../artifact/`: unchanged extracted original evidence.
