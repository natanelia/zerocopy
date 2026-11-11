# Decision after the optional-entry pilot

The pilot completed and passed the independent audit: 72 fresh processes,
648 measured batches, 2,977 warmup batches and 12,183,552 verified outputs.
There were no measured batches below two milliseconds. The audit verified all
source/workload/runner identities, exact shared-module graph isolation, unchanged
WASM, the full schedule and the actual Node-worker evidence.

Proceed with the already planned 12 cases and six pairs, followed by the six-case
four-pair baseline-versus-baseline study. **No production source, workload, runner,
repetition count or measurement setting changes between these phases.**

The pilot supports a full comparison because the 65,536-element imports improved
in both pairs on both runtimes under each encoding history. Paired ratios were
0.208/0.827 (Node/Bun) for mixed history and 0.870/0.753 for typed-only history.
Shared input also improved in both pairs on both runtimes. This is exploratory
evidence, not the final performance claim.

Limitations and adverse controls remain visible:

- 32-element imports were slower: Node ratio 1.862; Bun 2.818, zero faster pairs.
  This optional API must not be described as faster for every input size.
- Bun's typed-only 4,096-element import was slightly slower in both pilot pairs:
  ratio 1.015. Confirmation includes this case unchanged.
- The existing numeric box reader had an adverse Node estimate of 1.207, with
  pair ratios 1.464 and 0.996. Because this reader imports the changed optional
  entry, its six-pair result requires direct scrutiny.
- The ordinary scalar-push control had a Bun ratio of 1.216. That case never
  imports the optional module and its full loaded graph is byte-identical across
  labels. It remains a same-code repeatability observation, not a correction
  factor for other results. No timing is subtracted or normalized by this result.

All 18 pilot rows and every process remain in the raw record and independent
audit. Pilot samples will not be pooled with confirmation or A/A. Publication
depends on the complete confirmation evidence and disclosed scope, including
the unchanged-entry and changed-entry controls.
