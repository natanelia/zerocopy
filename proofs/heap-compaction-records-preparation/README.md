# Preserved preparation receipts

These are historical evidence, not a successful full-gate receipt and not inputs
that authorize timing. `standard-gates.json` is deliberately incomplete/failed.
Its final stage is the unmodified baseline's standard unit suite: 762 passed,
12 default 5-second timeout failures. The controller stopped there, before
candidate units or subsequent standard worker/package checks. No broad local
rerun followed. Earlier build and type successes remain recorded for both arms.

`standard-gates/` preserves complete stdout/stderr logs, including the baseline
failure. `run-standard-gates.py` is the exact historical local capture script;
its absolute local paths are provenance, and it must not be used as a CI runner.
The future controlled job uses the separately reviewed portable
`heap-compaction-records-gates.mjs` instead.

`initial-preparation-failures.md` preserves the earlier fixture, TypeScript,
proof-build and reviewer-capacity failures. The initial Node 24 result and its
original worker script remain supplemental; they are not relabeled Node 22.
Initial Node 22 worker results and source pins are retained separately.

`focused-fixtures.json` covers 41 deterministic checks including all eight
prospective screen cases. `subject-checks-node22.json` records all eight
uninstrumented production subject cases with a measurement-clock tripwire.
`package-dry-run.json` is only an npm archive-content dry run; it is **not** a
passed install/package gate. Proof outputs were moved under the existing
npm-excluded `.proof-tools/` directory so they are absent from that archive.

Production arena IDs are unchanged in the subject checks. Fixed target IDs are
used only in the explicit test-only Compactor byte-comparison copies documented
in the protocol. No timing pilot or measured sample has run.
