# Confirmation decision

The complete two-pair pilot is retained as `results/pilot-01.json` (packaged
losslessly as `.json.gz`). No source or benchmark case was changed after seeing
it. The large numeric vector improved in both pairs on both engines. Other
cases were mixed, including adverse numeric-queue and small-vector observations
and substantial variation in unchanged string/object controls. Two pairs do not
establish a stable effect for these smaller cases.

Proceed with the already declared six-pair confirmation using the same source,
driver, repetitions, eight cases, engines, timed scope and verification. Do not
combine pilot and confirmation estimates. Report every confirmation row and all
pilot ratios, including slower pairs. Claim benefits only for supported cases;
do not infer neutrality from an interval that includes one or discard an
adverse result. No optional favorable rerun is planned.

The original focused test attempts are also retained. The first exposed a test
fixture that passed array values instead of indices to the number factory; the
second exceeded Vitest's default five-second limit because many large boundary
checks shared a single test. Corrected fixtures and separate boundary cases
passed 76 focused tests without changing production code or test timeouts.
