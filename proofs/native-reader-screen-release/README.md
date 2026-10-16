# Exact transport and screen composition

Source-only integration. SCREEN-RELEASE.json is unresolved and sealed:false;
the workflow contains an unresolved release digest. It cannot authorize or run
the screen in this state. Actual preparation evidence and the combined exact
implementation/artifact audit must be independently checked before the release
is finalized and its SHA-256 is inserted in both workflow commands.

All 23 performance files are byte-identical to implementation seal
4624c4a2908980f2cacc218b45e2641776760be41e97cd80ede44fee48e331ed.
All preparation/transport proof files are copied unchanged from the reviewed
restoration adapter. This directory supplies only composition and pure tests.

The workflow accepts one push advancing
proof/native-reader-reuse-performance-20261016 directly from
afdffdcfcbd61013f120de82411c0c4a6b2d1e0e. Each stage requires run attempt 1.
It uses one exclusive hosted allocation and serial steps: path resolution,
unchanged 180-second transport, receipt/path resolution, and the unchanged
900-second screen. A failure prevents subsequent execution. No rerun, build,
extra target group, calibration change or second allocation is added.

The release is hash-bound in the workflow and covers the exact composer,
performance/transport proof inventories, support documents and transport
binding. Its scientific, source, runtime, correctness and review pins are fixed
before publication. Existing authorization supplies the exact single-attempt
release; the composer cannot create authority or waive missing audit evidence.

The transformation whitelist is:

- Resolve only the fixed performance-review path in the existing transport
  binding to the actual checkout root. Every other field is copied unchanged.
- Construct the existing performance binding using the fixed documented paths
  under the checkout and RUNNER_TEMP/native-reader-transport-output. No release
  field supplies an arbitrary replacement path.
- Insert the SHA-256 of the actual fresh transport-receipt.json after successful
  transport, check its scope/pins and terminal state, then derive the exact
  existing approval object and binding digest from the released scope.

Unknown release/transport fields, altered scope, unsealed future values, a
different review path, traversal, changed source inventories and mismatched
receipt pins fail closed. Preparation receipt bytes are preserved and hashed
against their original reviewed digest. Full source/build/dependency/runtime,
archive/inventory and raw custody authentication remains inside the unchanged
900-second controller. Small composition steps have one-minute outer limits;
their official step outcomes are retained separately, with no target timing.

Only the transport step receives the existing ephemeral same-repository token,
with contents:read/actions:read. Checkout disables credential persistence.
Composition and target steps receive no token. All temporary paths are resolved
from RUNNER_TEMP in their executing steps. No credential or setting is created.

The always-run artifact step retains release bindings/context and terminal logs,
transport raw custody/cleanup evidence and both original/fresh receipts, and all
complete or partial screen evidence. The original prepared archive is retained
in its separately audited preparation artifact; this upload does not duplicate
the large unchanged archive or restored input trees. Official job/step terminal
outcomes are separate required audit evidence. The final performance claim still
requires independent reconstruction of the unchanged rules.
