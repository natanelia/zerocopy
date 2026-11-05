# Independent audit of the interrupted V1 pilot

The original `results/pilot.json` remains byte-for-byte unchanged, with its original `status: running`. It contains **63 of 64 planned subjects**, **567 measured batches**, **31 complete before/after pairs**, and one unpaired candidate. The final missing subject is the Node baseline for `decode-array-8192`, pair index 1. The unpaired candidate is retained but excluded from paired estimates.

The independent Python audit verifies that all retained subjects are an exact, unique prefix of the declared schedule. It checks runtime identities, CPU affinity, each warmup and measured batch, complete-output verification counts, process medians, and every available paired estimate. It also checks the saved source snapshots against their launch-time hashes and the archived V1 source/workload files. All these checks passed.

**This remains an incomplete experiment.** The recording has no completion or structured failure record; the interruption cause is unknown. The saved evidence does not verify the driver's end-of-study source/build identity checks. The missing subject and final checks cannot be inferred from the saved observations. Nothing in this audit repairs the study, promotes its estimates to confirmation, or changes the normal verifier's requirement for a completed experiment.

The retained pilot is analyzed separately from V2. Its adverse observations remain available. No timing was rerun for this audit.

- [Machine-readable audit, raw hash and all retained pair estimates](interrupted-pilot-audit.json)
- [Independent audit script](audit-interrupted-pilot.py)
- [Archived V1 source](archive/redux-checkpoint-v1.ts.txt)
- [Archived V1 workload](archive/workloads-v1.mjs)

Reproduce the audit without running timings:

```sh
python proofs/checkpoint-validation-20261105/audit-interrupted-pilot.py
```

The script accepts the original JSON or a losslessly compressed `results/pilot.json.gz` and never modifies that recording.
