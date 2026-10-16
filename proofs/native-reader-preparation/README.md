# Source-only preparation and transport adapter

Status: source-only implementation awaiting exact sealed-byte review and future successful correctness evidence. The two binding templates are sealed:false and contain null future values. The workflow's binding hash is unresolved. Nothing here is an execution release.

The immutable performance consumer remains the separate v2 implementation with seal 4624c4a2908980f2cacc218b45e2641776760be41e97cd80ede44fee48e331ed. Its exact PREREQUISITES.md/schema/authentication contract controls final admission. authentication.py, specification.py and cases.json here are unmodified copies used only for shared provenance checks. bounded_process.py and headroom.py are unmodified reviewed guard bytes.

prepare.py is the separately bounded 600-second producer; transport.py is the separate 180-second final-host materializer. download.py alone can receive the ephemeral artifact token and calls official gh api for the exact same-repository run/artifact/digest. Runtime downloads occur in tokenless runtime.py. assemble.py restores bytes and runs no target code. npm is invoked only with lifecycle scripts disabled. scratch.py accounts for setup scratch and makes no package/leak claim.

The ready archive contains sources/{baseline,candidate}, artifacts/{baseline,candidate}, runtimes/{node,bun}, dependencies/{package.json,package-lock.json,node_modules}, correctness/, correctness-audit.json and correctness-terminal.json. All source files come from the successful audited inputs.json map. Each artifact arm has exactly its preserved builds plus original package.json.

The final consumer paths, relative to the transport output, are:

- correctnessEvidenceRoot: ready/correctness
- correctnessAuditPath: ready/correctness-audit.json
- correctnessTerminalReceiptPath: ready/correctness-terminal.json
- preparationReceiptPath: preparation-receipt.json (original immutable bytes)
- readyInputArchivePath: ready-inputs.tar (outside restored roots)
- readyInputInventoryPath: raw/ready-inventory.json
- transportMethodPath: raw/transport-method.json
- transportReceiptPath: transport-receipt.json
- transportEvidenceRoot: raw
- artifactRoots: ready/artifacts/baseline and ready/artifacts/candidate
- sourceRoots: ready/sources/baseline and ready/sources/candidate
- dependencyRoot: ready/dependencies/node_modules
- lockPath: ready/dependencies/package-lock.json
- runtimePaths: ready/runtimes/node and ready/runtimes/bun

The release also supplies the unchanged performance proof directory, method/seal/diff/baseline inventory, exact independent implementation review and execution approval. The producer does not synthesize them. Their absolute paths and every SHA-256 must be authenticated by the existing external release process. Keep bindings/receipts outside proof inventories to avoid self-reference.

Before preparation release, review the successful official run/attempt and artifact identity, exact ZIP contents/seal, independent correctness audit and terminal receipt, original runtime/archive/npm identities, exact proof inventory, the reviewed finite 1 GiB byte ceilings and the single-attempt authorization reference. The baseline 502-file inventory and four fixed production/test changes are pinned. Additional correctness proof sources must follow the future audited map. The present incomplete run 38863704317 cannot be used even though its executed commands passed.

Exact ready-tree and runtime-provisioning sizes are established during bounded preparation and recorded before the receipt; no extra restoration pass is required. Before transport release, preparation must have finished successfully and its complete raw evidence, receipt, archive and inventory must already be independently audited. Review transport-method.json and the whole producer/helper source, then bind the archive/inventory/recipe and original receipt digests in the implementation review. The fresh transport receipt is checked at study admission; prospective recipe review does not require future receipt bytes. The same final hosted allocation must remain reserved for the later screen. The integration fragment is not a workflow and does not launch the screen.

All scratch, staging and outputs are below fresh RUNNER_TEMP directories. Source checkout and evidence upload use official Actions; job-level permissions are only contents: read plus actions: read on the existing ephemeral token. No credential or repository setting is created. No target build/import/execution, calibration or timing occurs in this adapter. A failed phase is terminal and is not retried. Raw evidence and terminal external outcomes must be retained even on failure.

Local verification is limited to AST parsing, byte/hash comparisons and standard-library synthetic fixtures: python3 -B test_synthetic.py. These tests never create a child process, contact the network, import target code, or use local cgroup accounting as evidence of hosted readiness.
