# Prospective primitive measurement ceiling

This is the preserved prospective cap assessment made before executable preparation. Its preparation-status statements refer to that review stage. Accounting qualification: 805,306,368 is the maximum recorded phase-loop total; fixture and before/after validation add 88 untimed hook calls, for 805,306,456 total hook calls in a successful maximum-count primitive measurement child. The executable results label cumulativeCalls as phase-loop operations only.

Propose a primitive-only common-count and measurement ceiling of 2^29 (536,870,912 calls), identically for both arms and both engines of the new private-Map cohort. Keep every calibration probe/pilot at the existing 2^27 per-batch cap, keep its 2^31 cumulative cap, and keep every other endpoint's measurement ceiling at 2^27. This is the narrowest change addressing the observed limitation after valid calibrations. It is written for review only; no driver/configuration has been changed or executed.

## Prior limitation, preserved

The original shared-helper Bun primitive calibrations both passed. Their recorded cumulative calls were 759,452,672 baseline and 237,488,128 candidate, below 2^31. The fixed fastest-six-pilot formula required common N=253,214,720, greater than the original 134,217,728 ceiling. All sixteen measurement slots correctly stayed not-run. Those absent observations remain absent; calibration rates are not inferential performance results and are not reused to size the new cohort. The Bun unfrozen regression and both descriptive cold limitations remain unchanged historical evidence.

The proposed limit admits that numeric count without changing the 1.5-second common target, 500-ms measurement floor, four N/8 warmups, 350-ms warmup floor, observations or decisions. Its headroom is bounded; it does not guarantee future sizing success. Although 2^28 would also contain the old count, 2^29 is the explicitly reviewed upper bound proposed for this new cohort, fixed before its calibrations. At a 1.5-second target, counts still exceed this ceiling for sufficiently small fastest-pilot rates (roughly below 2.793967724 ns/call before quantum rounding). Such a cell remains unresolved. No count clipping, lowered duration target or additional sample is allowed.

## Integer, loop and checksum safety

The existing driver uses a Number loop index `i`, increments completedCalls once per iteration, indexes the prebuilt eight-value array with `i & 7`, and adds the accepted boolean as numeric one. At N <= 2^29, index, completedCalls and primitive phase checksum remain exact integers, below 2^53; i is also below the signed 32-bit boundary. The low-three-bit sequence cycles all eight values unchanged. N is rounded to a multiple of 1024, so every N/8 warmup is an integer multiple of 128 and preserves the same cyclic model.

Each primitive phase starts checksum at zero; `(checksum + 1) >>> 0` is exact throughout this range and cannot wrap within a <=2^29 phase. The independent BigInt multiplication/modulo checksum expectation remains unchanged. The old generic modulo model remains valid for all other unchanged endpoint units. Counter/validation work stays outside or inside the same timer locations as before; no unrolling, batched-call substitution, new wrapper or kernel change is proposed.

Four N/8 warmups plus N measurement total 3N/2. At the proposed maximum, this is 805,306,368 calls, safely exact and below 2^31. At the historical missing count, it would be 379,822,080 calls; this is arithmetic only, not an executed observation. The driver records measurement cumulativeCalls without the calibration-only cumulative guard, so the 805,306,368 bound is derived from its unchanged five-phase structure and the new N ceiling, not a claim that a calibration guard covers measurement.

Calibration behavior is wholly unchanged: geometric count progression, 2^27 per-batch ceiling, warmup/pilot sizing, maximum 128 warm batches and 2^31 cumulative limit. Its pre-phase sum/check remains exact well below 2^53. Any cumulative, count, duration or deadline failure remains unresolved. Retaining the old calibration ceiling also avoids introducing new high-count probe paths that could not complete eight warm batches under the existing cumulative limit.

## Unchanged resource and inference budgets

Measurement/cold children keep 15 seconds and 1536 MiB; calibrations keep 25 seconds and 1536 MiB. The primitive fixture still has eight values and no arena admission or per-call retained output. Raising a loop count does not resize the fixture or create a per-operation results array, but no new memory or runtime estimate is claimed. The supervisor's original-group RSS and deadline enforcement remain authoritative.

The planned maximum was already four smokes, twenty calibrations, 160 warm observations, 32 cold observations and one analysis: 217 children. The absent sixteen prior slots were part of this original budget. No processes, endpoints, blocks, warmup batches or observations are added. The target-time planning remains 360 seconds warm work plus reserves 144 calibration/smoke, 64 cold, 120 overhead, 30 analysis and 15 cleanup: 733 seconds within the same 900-second cap, leaving 167 seconds. The outer 41-minute allocation and 45-minute job limit stay fixed.

These are planning allowances, not a proof every child will finish. Individual child maxima already exceed the whole window in aggregate; the existing hard whole-window/cleanup rule still limits the cohort. A higher primitive count can encounter the same deadline or exhaust the same remaining window, producing preserved incomplete/not-run rows. It does not authorize a larger wall budget or retries.

Both primary bounds, all pointwise warm regression bounds, drift gates, conservative gain test, four-block requirement, separately descriptive cold veto and aggregate-label caveat remain byte-for-byte scientific rules from the prior method. No loss can be removed by the cap change. The new candidate needs its own reviewed cohort.

## Required later executable review

A future runnable packet must distinguish calibration operation admission from common-count/measurement admission. The primitive override must reach common-N eligibility, measurement request validation, actual measurement phase validation and independent raw-count checks consistently. N/8 warmup counts remain derived and <=2^26. Every other endpoint and every calibration check must retain the original limits. Endpoint/engine/arm identities, checksum models, configured limits, fixed schedule and raw caps/not-run reasons must remain authenticated. A global replacement of the old operation cap would be a different, unapproved method.

This assessment uses retained JSON, driver/controller source and exact integer arithmetic only. No old or new timing driver, analyzer, calibration, measurement, subject import or benchmark was executed.
