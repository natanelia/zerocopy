# Packed-pointer focused correctness: terminal audit

2026-10-15. **Accepted as a completed focused correctness gate.** All twelve exact planned commands passed: two pinned runtime versions, two portable builds, two no-emit typechecks, four 34-case unit runs and two two-case real Node worker runs. Raw evidence supports 136 unit case executions and four real-worker case executions. This does not establish full-suite clearance, performance benefit or publication approval.

The focused correctness supervisor exited 0. Independent audit authenticated the terminal files, exact commands/environments, raw reports, all stdout/stderr hashes and saved ownership/cleanup receipts. Every command exited 0 with no failure, cleanup signal or leftover descendant, and its original leader was reaped after inspection. A subsequent read-only process-group check found no members of those original groups. Saved per-command, metadata, cleanup, memory and whole-gate safety limits passed; these resource values are not comparative performance data.

## Evidence identity

Root: `zerocopy-packed-order-prototype-20261015/correctness-v1`.

| File | SHA-256 |
| --- | --- |
| `TERMINAL-MANIFEST.json` | `ca7a01cb63dfcf41ce751a8ae34d855b6034635af4698eb7b8ccbbc16ccae659` |
| `TERMINAL-AUDIT.json` | `2edcdb89df6bdbab206dc7d692eeede3c8edbc026ed7531066d7c4588d623b10` |
| `result.json` | `7c75a1b3b093bdc1c7a1dbabd51a25a2208b3a386f0c2b95aeb64c1f32c737f6` |
| `command-receipts.json` | `d435741712ba420a4c5fa96ac4600b434ac532b63acc139136a4706a7207520d` |
| `EXECUTION-PINS.json` | `2021271d2ecea8bfcb2b4452310c1333069b0546b4b89b3537cd71b5b89bf86e` |
| `INPUT-SEAL.json` | `8123473130701d6248ab039cad3eb1b2028f60a3006fa9f0f53036d349bcbf3b` |

All fifty terminal-manifest entries matched their hashes and sizes. Current input/source seals still match the previously approved runner and plan. Both 504-file source inventories, the 502-file pristine baseline, twelve native artifacts per arm, all 2,272 pinned dependency files, 22 symlink targets, toolchain package/lock and Node/Bun/Python executable identities authenticate unchanged.

Both portable builds contain twelve authenticated outputs. Independent static decoding verifies all four embedded WASM identities and that the single persistent-core embedding is reachable from shared.js. Complete current output inventories match the captured build manifests. No product or generated module was imported during this audit.

Each unit report has exactly the two planned test suites and all 34 exact expected assertion names passed, with zero failed/pending/todo cases. The four reports total 136 executions across baseline/candidate and Node/Bun. Both worker TAP logs contain the two exact shared/copied-case names, two passes, no failures/cancellations/skips/todos and empty stderr. All twelve stderr streams are empty. The actual-worker proof source remains the previously reviewed shared/copied map/set suspension across growth/reset and read-only checks.

`VERIFIED.json` records the independently checked inventory sizes, command identities, outcomes and terminal pins. The runtime compatibility boundary remains ordinary module-initial native intrinsics, native-contract unsigned pointer results and private storage as set out in the earlier design/source review. Evidence for the earlier provisional plan is unavailable; the completed gate is supported by the exact terminal identities listed above, not that earlier plan.

No retry, target execution, test, build, benchmark, install or external change was performed by the auditor. The prospective performance method and any later ordinary full-suite gate remain separate decisions.
