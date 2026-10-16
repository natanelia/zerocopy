# Prerequisite authentication contract (source only)

This is a proposed schema and implementation, not evidence that correctness or performance passed. No execution approval, successful audit receipt, terminal correctness receipt, or prepared artifact binding is supplied here. The controller cannot start a target without all of them. Do not create receipts by copying schema examples or changing a failed run's status.

The authority chain is: exact independently audited terminal correctness evidence → exact preserved ordinary build and bounded preparation → independent review of this complete driver/controller/analyzer, those artifacts and the bounded transport recipe → verified release of the exact binding digest under the existing authorized optimization scope. The operator supplies both the binding SHA-256 and execution-approval SHA-256 through that exact released invocation. Files supplied without those externally reviewed pins are not authority. SHA-256 authenticates bytes relative to trusted pins; it does not prove who wrote a receipt. The independent audit and authorization must be established outside this source packet. The release receipt records applicable existing authorization; this contract does not require a new user confirmation when that authorization already covers the exact single attempt. Mandatory tool approval review still applies.

## Binding manifest

The required object has schemaVersion 1 and kind `native-reader-performance-prerequisites`.

| Field | Contract |
| --- | --- |
| methodSHA256 | Exact METHOD-v2 digest in specification.py |
| methodPath, methodSealPath | Absolute regular-file paths to exact sealed v2 method/seal |
| candidateDiffSHA256, candidateDiffPath | Exact method-pinned production diff digest and bytes |
| baselineInventoryPath | Exact reviewed 502-entry baseline inventory, SHA-256 `9a68795d3c96706ddcad035e7e0cf37c8635753eeb18afe128dbf32ac27f5b59` |
| caseSHA256, sequenceSHA256 | SHA-256 of sorted-key compact ASCII JSON for parsed cases.json and specification.SEQUENCE |
| correctnessEvidenceRoot | Absolute directory containing the entire terminal correctness evidence tree and original evidence-sha256.json |
| correctnessAuditPath, correctnessAuditSHA256 | Independent terminal correctness audit document and exact externally bound digest |
| correctnessTerminalReceiptPath | Independently obtained terminal controller result, pinned by the audit's receiptSHA256 |
| performanceReviewPath, performanceReviewSHA256 | Independent implementation-and-bound-artifact review and digest |
| preparationReceiptPath, preparationReceiptSHA256 | Separately bounded, reviewed prerequisite preparation result and digest |
| readyInputArchivePath, readyInputInventoryPath | Absolute paths to the unchanged prepared archive and exact file/mode/contained-link inventory |
| transportMethodPath | Absolute path to the prospectively reviewed transport-method.json recipe |
| transportReceiptPath, transportReceiptSHA256 | Fresh separately bounded transport result and exact release-bound digest |
| transportEvidenceRoot | Absolute directory containing the fresh complete transport raw evidence and raw-evidence-seal.json |
| proofFiles | Exact relative-path → SHA-256 inventory of this entire immutable proof directory, including JS, Python, cases, schemas, tests and docs |
| artifactRoots | `baseline` and `candidate` absolute import roots, containing exactly original audited build files plus byte-identical audited source package.json |
| sourceRoots | `baseline` and `candidate` absolute source-only snapshots containing exactly every audited source file |
| dependencyRoot | Absolute exact locked dependency tree retained from correctness/preparation |
| lockPath | Absolute lockfile whose digest matches correctness inputs.json |
| runtimePaths | Absolute resolved executable files for `node` and `bun`, matching method-fixed Linux x64 hashes |

All named files/directories must already exist. Unresolved path aliases, unapproved symlinks, missing files and extra files in exact inventories fail admission. Dependency symlinks are permitted only when they resolve within the dependency tree and match the audited inventory. The correctness dependency inventory excludes only `.vite`, `.vite-temp`, and `.cache`, matching the reviewed correctness controller. Both runtime binaries are identified by exact hashes, not a mutable PATH lookup or an extra `--version` process.

Original correctness `builds/baseline` and `builds/candidate` remain unchanged and match outputs.json. Import roots preserve those exact bytes and the original package.json so Node uses the original `type: module` package context. A generated package.json, a rebuild, a bundle optimization or a new compiler setting is rejected. Source snapshots are separate immutable copies of all audited tracked bytes; they contain no .git metadata or installed dependencies. The independent audit must establish that all portable imports are closed over these files and supported built-ins, with no unresolved package dependency or unauthenticated external import.

The complete proof directory must contain no Python bytecode/cache outputs. Invoke Python with `-B`; controller and analyzer also suppress bytecode generation. Store bindings, approvals, audit receipts and output directories outside the proof directory to avoid circular inventories. The pinned review covers the whole source inventory; a source change requires a new review and binding, not an override.

## Independent correctness audit

Required fields:

- schemaVersion: 1; kind: `native-reader-terminal-correctness-audit`; disposition: `successful-terminal-correctness`; independent: true
- baselineCommit, candidateCommit (40 hex characters), candidateDiffSHA256, candidateSources (`arena.ts` and `worker.ts`) matching the fixed candidate
- evidenceSealSHA256 identifying the complete original correctness evidence tree, including preserved builds
- controllerExitIndependentlyVerified: true
- terminalControllerReceipt: exitCode 0, conclusion `success`, finished true, receiptSHA256, and verified HTTPS sourceURL
- checks: exactSource, fullCorrectnessCoverage, perViewCacheRegistryIsolation, rawPromotionFailureRetry, completeBuildProvenance, allEmittedFiles, nativeBytesAcrossArms, runtimeIdentity, emptyOwnedGroups, portableImportClosureReviewed, all explicitly true
- buildProvenance: commandReceiptsSHA256 over the six original baseline/candidate build-wasm/build-browser/build-types receipt objects in original command order; dependencyInventorySHA256 for original dependencies.json; lockSHA256; nonempty compilerIdentity, compilerOptions and buildScripts objects; ordinaryRepositoryBuild and identicalSettingsAcrossArms true

The separately pinned terminal receipt must have schemaVersion 1, kind `native-reader-correctness-controller-exit`, exitCode 0, conclusion `success`, finished true, matching candidateCommit, evidenceSealSHA256 and sourceURL. This is not synthesized from status.json. A terminal exit/job result must actually have been obtained and independently verified. Source review clearance, incomplete correctness output, an interrupted job, or an unsuccessful controller exit cannot substitute.

The controller independently rejects incomplete correctness status, incorrect candidate/runtime/source inventories, missing preserved outputs, failed command exits, surviving owned groups, unequal native bytes, or altered raw evidence. It also checks exact native byte embedding in portable JavaScript. The audit adds semantic coverage and compiler/import-closure review that cannot be established merely by a hash match.

## Preparation and implementation review

Preparation is a distinct prerequisite, outside the 900-second study. This packet contains no preparation launcher. If original artifacts/dependencies need retrieval, copying or environment provisioning, first design/review a separately bounded preparation with resource/cleanup receipts. Do not quietly run preparation in the study or hide its cost.

The preparation receipt requires schemaVersion 1, status `complete`, bounded true, correctnessAuditSHA256, exact original builds maps, noRebuild true, positive elapsedSeconds no greater than wholeCapSeconds, ownedGroupsEmpty true, reviewedPreparationMethodSHA256, rawEvidenceSealSHA256, readyInputArchiveSHA256 and readyInputInventorySHA256. Its independently reviewed raw evidence must establish its resource accounting, costs, preparation authorization and cleanup. The performance review binds its exact receipt digest. The archive and inventory are produced before that receipt; they do not recursively contain the final receipt.

The independent performance review requires schemaVersion 1, kind `native-reader-performance-implementation-audit`, disposition `source-clear-for-exact-bound-execution`, independent true, methodSHA256, caseSHA256, sequenceSHA256, correctnessAuditSHA256, preparationReceiptSHA256, readyInputArchiveSHA256, readyInputInventorySHA256, reviewedTransportMethodSHA256, exact proofFiles, builds and fixed runtimes. Required true checks are completeDriverAnalyzerReview, unmodifiedSupervision, exactMeasurementProtocol, prerequisiteAuthentication, boundedPreparationReviewed and boundedTransportReviewed. The preparation evidence and all reviewed source/artifact bytes must already exist and be checked; the current implementation source review alone cannot satisfy it. The later transport receipt is checked at admission and final audit, so its future bytes need not exist during prospective recipe review.

## Separate artifact transport

The later hosted job may materialize the exact ready-input archive with a separately reviewed bounded transport recipe before the 900-second study clock starts. This is transport with a new custody and cost record, not another preparation or a substitute preparation receipt. The original preparation receipt remains byte-identical. No rebuild, target import, target execution, calibration or timing is permitted in transport.

The transport-method.json recipe binds its exact transport/download/file helpers and unchanged guard hashes. Its wholeCapSeconds is 180, with a 90-second download allowance, 60-second restoration allowance, sampledGroupRssLimitBytes 4 GiB and minimumEffectiveAvailableBytes 6 GiB. These are separate prerequisite limits; they do not replace or enlarge any study limit. Exact producer/recipe review is required before transport is released. This screen packet contains only the consumer/schema and does not supply a transport launcher.

The fresh receipt requires schemaVersion 1, kind `native-reader-performance-transport`, status `complete`, bounded true, preparationReceiptSHA256, readyInputArchiveSHA256, readyInputInventorySHA256, reviewedTransportMethodSHA256, rawEvidenceSealSHA256, positive elapsedSeconds no greater than wholeCapSeconds 180, ownedGroupsEmpty true, noRebuild true, noTargetImports true and extractionVerified true. Preparation, independent review and transport must agree on archive/inventory digests; review and transport must agree on the recipe digest. The final binding pins the actual transport receipt, and its release establishes external custody under the existing authorization. A file's self-asserted success flags do not establish that release.

readyInputArchivePath identifies the downloaded original ready-inputs.tar outside restored roots; readyInputInventoryPath identifies retained ready-inventory.json. The transport producer validates the exact file, mode and contained-link map before extraction. The controller independently rehashes both original files, the recipe and receipt, verifies the complete transport raw seal, and performs all existing source/import/dependency/runtime inventory checks. The raw seal is raw-evidence-seal.json containing `{relativePath:{sha256}}`, excluding only itself. Raw custody evidence individually pins the original preparation receipt, archive, inventory and recipe, plus actual bounded command, resource, cost and cleanup records.

The study retains the transport receipt, recipe, inventory and raw evidence, and discloses preparation and transport costs separately. Admission hashing/copying and final reauthentication are inside the unchanged 900-second study budget. Failure or missing producer review, receipt, custody evidence, inventory, cost or cleanup leaves execution held. The actual transport is not pre-approved merely by this source schema.

## Exact execution release

The required approval object has schemaVersion 1; kind `native-reader-performance-execution-approval`; authorized true; exact bindingSHA256, methodSHA256, correctnessAuditSHA256, performanceReviewSHA256; maximumGroups 80; wholeStudySeconds 900; singleAttempt true; exclusiveStudyHost true; and a nonempty authorizationReference to the actual authorized instruction/approval. It approves one complete predeclared attempt. It does not approve retries, replacement processes, automatic rebuilding, artifact changes, publication, or performance claims.

`exclusiveStudyHost` must reflect a real reserved hosted Linux x64 allocation with no concurrent build/test/study work. The controller's cooperative flock prevents overlapping copies of this controller but cannot prove a globally idle host. The independent execution setup review must establish that condition. Affinity, OS, CPU quota and memory limits are recorded without GC tuning.

A future approved invocation has the shape `python3 -B controller.py --binding <absolute-path> --binding-sha256 <reviewed-digest> --approval <absolute-path> --approval-sha256 <approved-digest> --output <fresh-absolute-directory>`. This is documentation, not a request or authorization to run it. The output must not overlap authenticated inputs.

## Final evidence

Original raw driver reports are never rewritten. A separate controller observation records pre/post executable-source authentication; the driver deliberately reports sourceAuthenticated false and merely echoes its binding identity. Every group has its exact configuration, raw stdout/stderr and exit/cleanup receipt, prelaunch headroom record and durable partial report. Untimed mechanism reports have null endpoint timings and untimed true.

The controller copies the method, binding, approval, audits, terminal correctness receipt and build/dependency provenance into the raw evidence. It retains every batch, validation, cold event, calibration trial and count, rehearsal lifetime, order, process mean, block log ratio, interval and quality flag. Analysis never deletes an observation to improve quality. A source/value-valid full-sample adverse finding remains visible when another endpoint makes the study incomplete.

FINAL-SEAL.json records the exact inventory of every raw evidence file except itself. The controller rereads and verifies it and emits its digest, verified status, successful/unsuccessful controller exit code and complete supervisor lifetime on terminal stdout. That terminal result must itself be retained externally. Completion requires all 80 groups, no owned survivors, no cap/interruption failure, a verified raw seal and a successful terminal controller exit. An independent reconstruction and unchanged-rule audit is still required before any performance claim. A seal alone does not turn an incomplete or unauthorized study into an admitted one.
