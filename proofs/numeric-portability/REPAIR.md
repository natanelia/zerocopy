# Bounded admission and ownership repair

This inactive successor repairs the four P1 findings against packet commit
`7df9a6cdc162949e29c8116334ca2c4288a579e8` (tree
`7ee4ddee4042f82d6e3d8bafebe8e325712a504a`, packet SHA-256
`f7eaec95264315219b59d16e1aaf90093f1130bba8abf4cc21251a242738ff46`).
The original packet and independent counterexamples remain separate retained
evidence. This repair supplies no measured performance or portability result.

The protocol, source/test commits, eight-line production patch, fixture bytes,
112/10/14 subject counts, six browser semantics subjects, schedule, startup
boundaries, clocks, operation bodies, calibration choices, uncertainty formulas,
thresholds and budgets are unchanged. Source gate commands and the inherited
math, controller, build-verification and correctness files are unchanged.

- B1: `artifact_admission.py` requires the current clean activated checkout,
  sealed packet and original run identity; exact unique inventories and phase
  file sets; pinned source trees reconstructed from archived bytes; all retained
  output/fixture bytes; both complete source gates; and all linked configs,
  ledgers, raw rows, process, cleanup and ownership receipts. The final aggregate
  independently recomputes the exact ordered 46 cells and compares the saved
  reports. An invalid lane makes the aggregate fail with no promoted cells.
- B2: `evidence.py` validates the complete ordered raw protocol and independently
  derives fixed fixture counts, calibrated work and diagnostics. Startup retains
  one observation per subject and has no warm-duration, warmup or MAD machinery.
  Existing semantic observations and selection counts are now retained in raw
  rows rather than represented only by completion flags. No public operation or
  timed body was added. Supported relative startup losses remain losses even
  below the 50 microsecond absolute reporting scale.
- B3: A browser's fsynced spawn intent and PID/start identity are consumed by the
  controller, including after adapter failure. A process-local Linux subreaper
  owns orphaned descendants, and verified shutdown requires final kernel
  `ECHILD`, captured births and a closed spawn journal. PID-bound signals avoid
  directing cleanup to a recycled PID. Missing/unsealed receipts, an uncertain
  spawn or interrupted cleanup retain unknown quiescence and block admission
  and stable-preservation claims. Polling alone is never proof of ownership.
- B4: RSS reads distinguish a confirmed exit or zombie from an unreadable live
  birth identity. Unknown live subject, descendant or controller RSS fails the
  lane. Positive sampled observations and their maxima are required; these are
  sampled maxima, with no peak-memory claim.

The new tests use artificial records, fixed synthetic timing values and mocked
process/kernel interfaces. Full artifact models include actual pinned source
archives and retained emitted bytes, but contain no new library execution.
Negative tests retain the original malformed-row and empty/duplicated-admission
counterexamples and add missing, duplicate, mistyped and mislinked evidence,
forged diagnostics, detached ownership, interrupted spawn and unknown-RSS cases.
Synthetic positive cases demonstrate acceptance only of the complete model.

Actual Linux subreaper/pidfd support, fresh browser profiles and all browser/ARM
compatibility remain future run prerequisites. Runtime executables are bound by
the existing tool-digest receipts; executable payloads are not archived. Fresh
processes/profiles do not establish globally cold OS or engine caches, and local
HTTP import timing is not a universal deployment cost. Activation stays false;
independent review and separate execution authorization are still required.
