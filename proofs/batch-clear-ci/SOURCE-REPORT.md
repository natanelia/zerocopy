# Revision 2 source integration

Baseline is f4fad3a850cb544ff9440d263eeec464a31dd123, complete tree b5cf2c9362b09d442056cd9edce944446bba8c6c. Git verifies its sole parent 2e88bc4a53871476da9ca1ec4e6c374b61512436 and exactly seven README/website changes listed in SOURCE-INTEGRATION.json. Runtime, tests, dependency inputs and runtime build scripts are unchanged by that main advance.

Candidate 028a5b4f315e84ff9bc4ba59a48d582f7b2e27b0, complete tree c2eb5558e7c79236b3dbc86b2cb03758ca24b70e, is the new baseline's direct child. Its only changes are persistent-core.as.ts and batch-scratch.test.ts, byte-identical to prior current-main candidate 48b9334788794a561f131c6619e5280748f32b08 and original reviewed candidate 2ee42fdac4020d637d9909db25297ba978b0aeaa. Full candidate-to-candidate diff exactly equals the seven-file main-to-main diff.

SOURCE-REPORT.original.md retains the original detailed scratch/ABI/contract review and original 2e88 integration identity. Historical ad2/2ee42fd baseline four/candidate sixteen full-suite timeouts remain unresolved. No historical gate or focused evidence is relabeled as a run of this new source. The original packet, original source histories and all failure logs remain untouched.

Revision 2 changes the proof's reporting/schema and both-arm compiler-path inventory only; controller, math, fixture inputs, measured loops, cases, caps and scientific rules are unchanged. No source subject, build, full gate, operation clock or external mutation was performed. See REVISION-2.md for the bounded R1/R2 fixes and prerequisites for independent rereview.
