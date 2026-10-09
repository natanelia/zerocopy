# Changes from reviewed native CI packet 3bdd45c

No production code is edited. The new proof packet is based on candidate 0c5524.

| File | Change and reason |
| --- | --- |
| `controller.py` | Byte-identical. Process ownership, cleanup, deadlines, raw samples, verification, schedule and failure behavior are preserved. Hosted admission is still supplied by the adapter. |
| `math.mjs` | Byte-identical. Formulas, common calibration and decision rules are preserved. |
| `dependencies.bun.lock` | Byte-identical. Both arms use the same frozen original dependencies. |
| `activation.json` | Byte-identical disabled state with empty reviewed commit/digest. |
| `ci.test.py` | Original 23 adapter admission/cleanup tests preserved; queue source-pair guard tests added. |
| `ci.py` | Rename branch/path/labels to queue; replace the two-line Arena source guard with exact baseline/candidate/runtime trees and the three-file queue diff/hash guard. Extract that guard for deterministic testing. Fresh standard gates, owned-process handling, hashing, bounded finalization and artifact preservation are unchanged. |
| `subject.mjs` | Queue-specific eight-cell public setup/loops/checksums/cache and retained-byte checks; symmetric extra post-setup GC; literal minimum ladder count; correct drain units. Existing warmup/calibration/diagnostic formulas retained. Pure fixture/loop exports allow small deterministic accounting tests without importing the candidate. |
| `protocol.json` | Replace native workloads with eight prospectively accepted queue workloads, fixed ladders, explicit units/exclusions. Runtimes, blocks/order, calibration/warmups/samples, statistics, resource/deadline bounds unchanged. |
| `protocol.test.mjs` | Replace native case-count/shape assertions with eight-cell queue assertions; original mathematical checks retained. |
| `controller.test.py` | Rename one gate test and update only case/peek counts. All 18 controller/gate/deadline tests retained. |
| `report.mjs` | Read exact workload unit and items-per-operation from protocol; replace historical ad2 wording. Ratios, intervals, diagnostics and whole-run admission remain unchanged. |
| `ci-report.test.mjs` | Queue temp prefix, 16 runtime/workload cells instead of 20, and assert unit/item metadata. Original synthetic final-admission cases retained. |
| `origin.json` | Queue baseline/runtime/test-bearing source identities and three exact changed-file hashes; accepted plan and reused native packet provenance. |
| `packet.json` | Regenerated complete proof-input inventory and queue activation path. No timing result is embedded. |
| `README.md` | Queue workload/setup/units/limits/activation documentation. |
| `PLAN.md` | Unchanged accepted prospective design. |
| `ADAPTER_CHANGES.md` | This explicit adaptation inventory. |
| `subject.test.mjs` | New small public-call accounting, independent checksum and fixed-input/ladder tests. |
| `.github/workflows/queue-prefix-cache-ci.yml` | New isolated default-off queue branch/workflow/artifact paths; adds the queue subject contract check to freeze validation. Existing job/stage/resource budgets, actions and publication permissions remain unchanged. |

Separate local preparation receipts, historical-build verification and untimed
results live outside this packet. They do not substitute for fresh hosted gates.
