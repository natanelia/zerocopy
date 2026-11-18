# Predeclared ASCII byte-load confirmation plan

## Decision and scope

This plan is fixed before the formal measurements. It evaluates the existing
four-byte ASCII grouping candidate without further runtime variants.

The intended claim is a measured improvement in the four named **Node ASCII
workloads** below. It is not a promise of universal improvement, faster Unicode
decoding, or a Bun speedup. Material adverse controls in **either runtime** block
an unconditional pass. Publishing the source branch preserves the experiment;
it does not authorize a performance PR before this plan's gates pass.

## Frozen identities

- Baseline runtime commit: `1242908762b554e3574365c486d5a6c52d5e568f`.
- Candidate runtime commit: `639335f59306ff532371cd84ad31c453f0680b56`.
- Candidate parent: `8144fbd39d486ce04f7d935011be978f81c6848d`, the original
  packed-DataView experiment, which remains preserved with its rejection evidence.
- Baseline checkout: `/workspace/scratch/240add2fd2cb/zerocopy`.
- Candidate checkout: `/workspace/scratch/240add2fd2cb/zerocopy-ascii-byte-loads`.

The following SHA-256 identities were read from the current files when this plan
was saved. Formal artifacts are in
`zerocopy-ascii-byte-loads/proofs/ascii-string-read-20261118`. The formal controller
adds recorded and checked CPU affinity; the screen controller remains untouched.
Copies must retain the respective exact bytes. If the formal verifier receives
its planned affinity assertion before freezing, update its digest below to the
final copied bytes before any formal study starts.

| Artifact | SHA-256 |
|---|---|
| Formal `benchmark.mjs` | `c21ef9efd67b0c98cd7ac9fcce155d2682300eb0063462a6c55c783ffb2389e0` |
| Preserved screen `benchmark.mjs` | `49451ba38c70ea8b3177b8f1cfe93d4d82854d47ab40e2b6ad6bc1788abb7151` |
| `ascii-workloads.mjs` | `1e3403bb2fa941f7e066af6950c2b34c130a860922c60fce14fb48cb5c8f544b` |
| `ascii-verify.mjs` | `b91d5c9cd89feb01eaa4c97fda4b123ade836f1dcad6a6cfe1e3fcea26d90e90` |
| Baseline `arena.ts` | `84ec482a8fd1ee95f912fb2b095074ce6b5294e01afe215cd75c57851cf57e41` |
| Candidate `arena.ts` | `1086868a41a1d7f12ec9a4704e4b5131018edac8653c6e7a834201fc4431ac5c` |

An archival commit may add this plan, the frozen harness, and evidence. The actual
measured checkout commit must be recorded by the controller. Such a commit must
not change the runtime bytes identified above. The controller also captures the
complete source and portable-bundle manifests; those captured manifests, not a
later rebuild, identify the measured artifacts. All source outside `arena.ts`,
all WASM bytes, and dependencies must match between variants.

## Fixed primary studies

Run A/A first, then A/B. Both studies are serial, with no competing builds, tests,
or benchmarks.

Bind each formal controller with **`taskset -c 2`**. CPU 2 is within the observed
available CPU set 0-8. Worker processes inherit that binding. Require the
controller's recorded `environment.allowedCpus` and every sample's `allowedCpus`
to equal the exact string `2`; the controller also asserts that child and parent
bindings match. A mismatch invalidates the study. The copied formal verifier must
enforce this same condition. Formal results describe this fixed single-CPU
execution environment; screen results from the earlier scheduling configuration
remain visible and are not adjusted or normalized into the formal results.

| Study | Comparison | Pairs per runtime | Runtimes | Cases | Batch scale | Warmups |
|---|---|---:|---|---:|---:|---:|
| A/A control | Baseline against identical baseline artifacts | 7 | Node and Bun | All 13 | 2 | 8 |
| A/B confirmation | Baseline against the frozen byte-load candidate | 7 | Node and Bun | All 13 | 2 | 8 |

Each report contains 28 fresh worker processes. For each runtime, variant order
is A-B, B-A, A-B, B-A, A-B, B-A, A-B. Workload order rotates by pair index
identically for both variants. The runtime order is Node, then Bun.

Every case performs 524,288 timed reads or yielded keys per sample at scale 2.
Inputs, construction, attachment, priming, explicit GC, and verification remain
outside timing. Every actual timed string is retained in an ordinary Array and
checked afterward. The workload checks every distinct attached Arena and WASM
instance, while shared-byte comparisons deduplicate only common memory.

Use separate, non-overwritten output files, for example `ascii-aa.json` and
`ascii-confirmation.json`. Independently verify both completed reports against
the frozen harness and artifacts before interpreting their summaries.

## Primary Node gate

For pair i, define R_i as candidate elapsed time divided by baseline elapsed
time. A faster pair has R_i < 1. Use the **median of paired ratios**, not a ratio
of independently calculated medians.

All four workloads must satisfy both requirements individually:

| Primary workload | Median paired ratio | Faster pairs |
|---|---:|---:|
| `list.string.get.ascii16.cold` | <= 0.90 | >= 6 of 7 |
| `list.string.get.ascii32.cold` | <= 0.90 | >= 6 of 7 |
| `map.keys.ascii16.cold` | <= 0.90 | >= 6 of 7 |
| `map.keys.ascii32.cold` | <= 0.90 | >= 6 of 7 |

The threshold means at least a 10% reduction in median paired elapsed time.
Missing any primary condition rejects promotion on this primary study. A later
favorable repetition does not replace that failed primary result.

## Control gate: both runtimes

The control set consists of all 13 Bun rows and the nine non-primary Node rows.
It includes Unicode, mixed byte-length boundaries, unchanged long-string
decoding, warm caches, and scans beyond cache capacity.

- **Any control median > 1.10 is at least a HOLD and blocks an unconditional
  pass**, even if fewer than six pairs are slower.
- If its median is > 1.10 and the candidate is slower in >= 6 of 7 pairs, treat
  that as a replicated material regression and reject this candidate.
- A median > 1.10 with fewer than six slower pairs is inconclusive adverse
  evidence, not a passing result. Surface it prominently and keep the PR held.
- An unconditional pass requires every control median <= 1.10, with no unresolved
  measurement-validity or adverse short-batch issue.

The existing concrete risk is **Bun `map.keys.unicode.cold`**. If its >10%
regression repeats in at least six confirmation pairs, reject the candidate
outright. A median above 1.10 with weaker consistency still blocks promotion.
The Node primary wins cannot compensate for this regression. There are no more
runtime variants.

## A/A handling

A/A measures noise and ordering effects separately. Never subtract it, divide
A/B ratios by it, or use it to convert a failing A/B result into a pass.

An A/A row outside the 0.90-1.10 band with >= 6 of 7 pairs pointing in the same
direction flags unreliable measurement conditions for that row. The affected
acceptance conclusion is held, not numerically corrected. A/A does not excuse a
confirmed A/B Unicode or other control regression.

## Predeclared short-batch follow-up

Retain the existing 20 ms minimum-batch warning. If either warm-cache case in
either runtime has a median ratio > 1.10 and any batch below 20 ms, one focused
longer-batch study may adjudicate that timing limitation:

- Run **both warm-cache cases on both runtimes**, not only the favorable rows.
- Use seven alternating pairs, batch scale 16, and eight warmups.
- Use separate matching A/A and A/B reports and the same frozen artifacts.
- Keep the original short-batch report and warning visible.
- Apply the same 1.10 control threshold and six-of-seven consistency rule to
  the longer-batch report. A remaining adverse or inconclusive result stays held
  or rejected; do not keep changing batch size.

This exception applies only to warm-cache timing. It does not defer or excuse a
confirmed Unicode cold-read regression, and it does not rescue failed Node
primary gains.

## Repetition and reporting discipline

A fixed repetition may investigate inconclusive noise, but it cannot erase a
failed primary report, replace a confirmed regression, or normalize against A/A.
Before such a repetition, fix its complete configuration and reason in a dated
addendum. Run the entire declared block, preserve every result, and show the
original and repetition side by side. Never select the best run or silently
relabel the original report as passing. Any revised interpretation must account
for both reports explicitly; until then the candidate remains held.

Preserve the shorter screens, original failed smoke report and historical
workload file, original rejected packed-load candidate, A/A reports, A/B reports,
any follow-up, and any incomplete/error output. Preserve raw paired ratios and
all control rows, not only the primary Node gains. These are engineering
acceptance rules, not a claim of statistical significance or universal speedup.

No new measurement, runtime code change, build, or test was run to save this plan.
