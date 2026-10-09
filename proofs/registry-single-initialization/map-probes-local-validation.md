# Local validation receipts

Current integrated-controller positive run: `map-probes-direct-files/summary.json` in the registry timing-gate local evidence bundle.

This rerun uses the verified Node 22 preflight package bytes but executes on local Node 24.19.0 x64. All 54 cells passed after the controller was changed to write stdout/stderr directly to evidence files. The subjects and instrumentation are unchanged. The original standalone positive run remains `local-evidence-02/summary.json` in the separate map-probe evidence bundle.

- Runtime actually used: Node 24.19.0, Linux x64. This is local mechanism/test
  evidence, not a Node 22 ARM/x64 prerequisite receipt.
- All 54 fresh-process subjects passed. Original built inputs, original copied
  archives, instrumented copied archives and archived harness hashes passed
  final integrity checks.
- Old → cleanup at 512 attached arenas, for both copy settings: 2049 → 1537
  completed native Map-expression evaluations, with 1537 settled live Maps in
  both. All 512 removed allocations were attributed to discarded Arena
  dependency initialization Maps. The objects/keys/strings Maps remained 512
  each and alive.
- At singleton attachment: 5 evaluations and 4 settled Maps in both. At 512
  owned Arenas: 2048 evaluations and 2048 settled Maps in both.
- Old/cleanup topology, ordered own-property descriptors, retained-view
  behavior, independent attachment isolation, collection after release,
  read-only behavior, reexport and one-owner compatibility materialization
  matched exactly. Each had 37 observable own properties. No physical V8
  instance-size or in-object-slot assertion was attempted.
- Traversal operations were separately counted and asserted; retained heap
  observations are separate descriptive process memory receipts without byte
  thresholds.

Negative integration: `local-evidence-wrong-cleanup/summary.json`.

The old built root was deliberately supplied in the cleanup position without
changing any built files. All 54 cells were attempted; both cleanup 512-attach
allocation subjects failed on 2049 versus expected 1537. The CLI exited 1,
summary remained `passed: false`, independent evidence remained archived, and
input/archive integrity still passed. This confirms the allocation gate fails
hard and retains failed evidence.

Focused unit/contract tests: `map-probes.node.mjs`, explicitly run with
`node --test`; `focused-tests.tap` records 10 passed after the rename from
`map-probes.test.mjs` to avoid ordinary Vitest discovery. The production probe
HARNESS excludes this test file, so the 54-cell receipt remains unchanged.
Coverage includes
AST parsing and exact native-expression preservation, nested Map expressions,
argument side effects, non-code text, malformed/already-instrumented source,
the complete matrix, wrong allocation and settled counts, changed
layout/lifetime, failed/missing/duplicated children and refusal to overwrite
evidence. No broad repository tests or installs were run.

`local-evidence-01` is an earlier passing local run retained for traceability.
The earlier `local-evidence-02` adds allocation-site purpose assertions and single-owner compatibility-getter coverage. The integrated direct-file run retains those assertions. Deterministic synthetic subprocess tests additionally prove that already-emitted JSONL survives interruption of its controller.
