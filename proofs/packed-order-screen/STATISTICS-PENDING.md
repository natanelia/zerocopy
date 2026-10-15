# Packed ordered storage: statistical specification and validation

The mathematical constants and source/synthetic checks described here have passed. No packed-candidate scientific observations have been collected. The independent mathematical work used no scientific samples; the subsequent analysis tests used synthetic arrays only.

The prospective method is assessment revision 2, SHA-256
`2ac7f4c1979eef5bf41cb798c4d9a1deb7f3312d987ada61d87b1ded13f65267`.
The method review requires two-sided Student-t intervals with eight independent
process pairs and seven degrees of freedom. The families are separately 95%:

- Ordinary pointwise harm: `t(7, 1 - 0.05/2)`.
- Latency clearance: `t(7, 1 - 0.05/(2*38))` across 38 fixed controls.
- Memory decisions: `t(7, 1 - 0.05/(2*22))` across 22 fixed contrasts.

These are not one joint 95% guarantee across 60 tests. Ordinary harm vetoes are
not family-error controlled. Invalid endpoints do not shrink either family.
Old 28-control and 10-contrast critical constants do not apply.

## Independently verified critical values

The independent mathematical audit verified these
binary64 literals, now fixed in `analysis.py`:

- Ordinary m=1: `2.3646242515927853`, upper-tail probability `1/40`.
- Memory m=22: `4.6755214023824`, upper-tail probability `1/880`.
- Latency m=38: `5.155633357451718`, upper-tail probability `1/1520`.

The audit used 75-digit Decimal positive-tail series and an independent
transformed-tail quadrature, with root agreement within
`8.881784197001252e-16`. It used no scientific observations. The retained
`statistics/REVIEW.md` and `statistics/VALUES.json` explain the bounded methods
and numerical residuals. Their identities and numerical findings are retained below.

Verified source hashes are:

- `statistics/REVIEW.md`: `ac1658592bd93a2a96849c557aad8b43295cc52fccb9e397def935e29867780d`.
- `statistics/VALUES.json`: `dfce433ed5ba8ce44ff2450a0319889dc49a96ebb9a5a568206095afdcb740cc`.
- `statistics/SHA256SUMS`: `f7b3d7535e2f1887519e9867e07c585d920c04ffecb3cedd662ebb43885b6752`.

`CRITICAL_PROVENANCE_SHA256` binds that SHA256SUMS file. The production function
only copies these fixed literals; it does not calculate or fit critical values.
The completed source/synthetic gate authenticated these values and passed all 24 analysis tests.

## Prepared secondary mathematical checks

The synthetic-check specialization uses the standard Student-t density
`16/(5*pi*sqrt(7))*(1+t*t/7)**(-4)` and the substitution
`t=sqrt(7)*tan(theta)`. Integration gives
`F7(t)=1/2+[theta+3*sin(2theta)/4+3*sin(4theta)/20+sin(6theta)/60]/pi`.
The reference formula is [NIST's Student-t distribution](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3664.htm).
This CDF inversion is a secondary synthetic check. It uses a fixed bracket and 96 bisections and compares
against the independently verified literals.

The synthetic source also includes a separate composite-Simpson integral of the
density at all three fixed critical values, using 20,000 panels and a CDF
residual tolerance of `1e-12`. It also checks the known ordinary 95% df=7 value,
family ordering and exact quantile formulas. These checks passed as part of the 24-test synthetic analysis gate.

## Source authentication and interpretation

The controller authenticates the exact statistics review, values and SHA256SUMS file before loading analysis. The fixed literals are not estimated from experiment data. The completed synthetic gate retained exact commands, outputs and terminal identities without importing the target or measuring a workload.

All numerical eligibility flags in analyze(data) are conditional analysis outputs. The controller separately enforces admission, calibration, source/runtime identity, resource limits and terminal preservation. A synthetic pass is not a full target-correctness pass or performance result.

## Fixed observations and decisions

Per engine there are 19 latency endpoints: the original 14, lifecycle controls
at N4096/N4097/N8193/P, and one fresh-process public-module import. Iteration
observations average all six measured chunks after division by the frozen K;
the import is one bracket, K=1, no warmup, no cached repeat and no invented 5 ms
import floor. Every relevant warmup/measured bracket must satisfy both 0.5%
resolution and overhead rules. The supervisor propagates a baseline calibration
floor/clock/overhead failure through endpoint eligibility, optionally reinforced
by `calibration_eligible=false`. One invalid pair/chunk invalidates the entire
eight-pair endpoint. Raw records, errors and all fixed endpoint rows remain.

Per engine there are 11 memory contrasts: three P benefit targets, seven
nonprimary margins and startup import footprint. Node uses heapUsed+external,
charging ArrayBuffer storage once. Bun uses heapSize, which includes extra
memory; other buckets remain separate. P's two signed cycle increments average
into one process observation; all other cases use one cycle. Released-minus-
before is guarded separately and is never subtracted. Component release guards
apply independently, including where opposite drifts cancel in the total.
Fixed raw-pause rows are retained for P and the four boundary cases.

P requires simultaneous lower bounds strictly above 512 KiB baseline, 128 KiB
saving and zero for 0.8 times baseline minus candidate. Nonprimary margins are
1 KiB at E0/N1/N32 and 4 KiB at N4096/N4097/N8192/N8193; startup is 4 KiB.
Valid ordinary memory lower bounds above these margins or valid ordinary
latency ratio lower bounds above 1.02 veto this unchanged candidate. Equality
is not harm; simultaneous upper bounds at the control margin clear it.

Every fixed case/contrast/control is reported. Independently valid adverse
evidence survives incomplete later work, invalid unrelated endpoints and
accounting uncertainty. No former candidate's harm, result or calibration is
pooled into this new study. An unexpected nonempty prior-evidence input is
reported as an analysis issue and cannot supply either a current benefit or
a current veto.

A complete valid Node P benefit can support a scoped Node provisional lead
while valid wide controls or an unmet Bun benefit remain prominently unresolved.
Node P must have all eight valid process pairs and valid attribution. Process
identity/correctness/custody failures or missing processes prevent positive
terminal eligibility. Failed Bun or Node nonprimary attribution remains
invalid, supplies no inference or control clearance, and requires explicit
review of the raw states before it may coexist with a Node-only provisional
lead. This pre-data clarification is recorded in METHOD-IMPLEMENTATION-NOTE.md;
the scientific definitions and conditions are unchanged in this editorial edition. Strong scoped clearance
additionally needs all attribution, all 22 memory contrasts and all 38 latency
controls. Neither result is a total-RAM, peak-memory, machine-cold startup,
all-platform or general no-regression claim.

Positive component, RSS and high-water shifts are retained as pointwise
diagnostic signals outside the decision families. Expected typed-backing growth
is not treated as a material-memory regression merely because it grows; it must
still receive an explicit explanation. A review can resolve an exact signal via
`accounting_shift_reviews` entries with `signal`, `explained:true`, nonempty
`rationale`, and a review `source`. This source does not authenticate such a
review: its custody belongs to the supervisor and independent terminal audit.
Every invalid memory case adds its own review-required signal, even though its
invalidity prevents component confidence intervals. Unreviewed signals block
both scoped-lead and strong-clearance terminal flags. Review never makes that
case valid or passing, and never overrides valid harm.

Final positive terminal eligibility also requires explicit review of the current
raw accounting, even if no positive-shift signal exists. The input carries a
64-character lowercase hexadecimal `raw_evidence_sha256` and a
`raw_accounting_review` object with `accepted:true`, this `method_sha256`, the
same `raw_evidence_sha256`, and nonempty `source` and `rationale`. The supervisor
and terminal auditor must authenticate that evidence seal and review. Missing,
stale or mismatched review leaves the numerical benefit visible but the final
disposition at `node_benefit_accounting_review_required`. No publication,
merge-readiness or PR authorization is produced by these flags.

## Prepared synthetic coverage

The 24 passing synthetic tests cover fixed family counts, independent density integration,
strong versus scoped results, missing/duplicate/invalid observations, ordinary
harm versus simultaneous uncertainty, all-six-chunk weighting, frozen K, every
timer bracket, import's single observation, storage overlap, signed P cycles,
component attribution cancellation and exact boundaries, strict materiality,
non-strict control clearance, accounting-review gates, terminal custody failure,
cross-case backing integrity, raw-pause rows and rejection of prior pooling.

The independent mathematical audit and synthetic validation are documented above. No scientific result is implied by those checks.
