# Empty-prefix ordinary correctness continuation

This packet prepares one candidate-only continuation against main `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. The fixed candidate loads an already-valid exact-root prefix child once and returns zero when that child is zero. Its complete source patch is pinned in `SOURCE-PINS.json`; native inputs and all other runtime behavior are unchanged. The eight focused public-API cases are the independently reviewed v2 tests.

## Retained outcome

The focused gate passed all eight cases on both current main and the candidate under both Node 22.16.0 and Bun 1.4.2: four commands, 32 case executions. The subsequent local ordinary gate passed native build, portable build, declarations and all five configured type checks. Its full Bun command used `--maxWorkers=1` and stopped when sampled process-group RSS reached 1,083,371,520 bytes against a 1,073,741,824-byte guard. It exited by SIGKILL without a terminal test report. The nine later checks did not run.

That stopped record remains intact. It establishes neither a runtime regression nor a preexisting failure. A prior hosted full suite used default scheduling and passed 1,058 cases, but recorded no RSS and is not evidence for this candidate. `prior-evidence.json` retains the relevant provenance and seal digests without private local host metadata.

## One hosted attempt

The workflow uses pinned official checkout, setup-node and artifact actions on `ubuntu-24.04`, with read-only repository permissions. It accepts only the exact proof branch and first workflow attempt, authenticates its sole parent as pinned main, installs the unchanged locked toolchain once with scripts disabled, and checks actual Node/Bun executable hashes, sizes, versions and identity. It materializes main plus the exact candidate patch in an isolated directory and checks all 503 source files. The historical hosted bulk-test overlay is not used.

The ordinary commands run sequentially through the existing repository entry points:

1. Native build, 90 seconds
2. Portable build, 60 seconds
3. Declarations, 60 seconds
4. Full Bun Vitest suite, 300 seconds, with verbose and JSON reporters and unchanged repository scheduling
5. Documentation script tests, 60 seconds
6. Documentation links, 60 seconds
7. Documentation examples, 90 seconds
8. Node worker integration, 60 seconds
9. Node Redux integration, 60 seconds
10. Node typed-JSON worker integration, 60 seconds
11. Package dry run, 60 seconds
12. Package archive, 60 seconds
13. Existing package consumer check, 180 seconds

The five successful local type checks carry forward under identical source/toolchain pins. Native, portable and declaration outputs are rebuilt and authenticated; the full suite must report all 51 root test files, including all eight focused cases, with no failures, pending cases or unhandled errors. Real-worker integrations and the package consumer use the freshly built portable entry points. The existing package consumer stays in npm offline mode after bootstrap and stops on a cache miss.

The controller has a 1,500-second total budget: preparation is capped at 300 seconds; correctness is capped at 1,200 seconds and clipped to retain 60 seconds for cleanup and preservation. The 35-minute workflow budget also bounds checkout, official runtime setup and artifact upload. Every command has a sampled 4 GiB process-group RSS guard; startup requires at least 5 GiB available memory. This is a sampled guard, not a hard cgroup cap. Operational duration and memory receipts are not benchmark results or memory-regression clearance.

The existing process-ownership pattern retains each leader with `waitid(WNOWAIT)` until descendants are inspected and cleaned. Signal authority is cleared before the leader is reaped. Logs, exact argv, terminal reports, source/generated inventories, executable identities, cleanup receipts and the package archive are retained on success or failure. The first unexpected failure stops the gate; there are no retries or source/test repairs.

This packet does not clear every additional CI proof or browser check, historical scope limitations, performance claims, or a PR/release. Preparation and review do not authorize publication or execution.
