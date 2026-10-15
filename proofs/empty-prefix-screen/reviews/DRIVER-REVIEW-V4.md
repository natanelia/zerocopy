# Empty-prefix driver review, v4 against method v5

Disposition: **narrow v5 decision and child binding clear**. This is static/inert driver review only. Final ordinary-composite authentication, generated/source/native execution pins, finite provisioning review and explicit execution release remain separate. No subject import, build, calibration, performance measurement or publication occurred during this review.

The reviewed packet is `/workspace/scratch/e7ec22ef2609/zerocopy-empty-prefix-20261015/screen-implementation-v4`.

- PREPARATION.json: `fdeef92eb386d52b2f3437786be44107da055cfb61736cc9c3e0ca0a6903bb51`
- SHA256SUMS: `f9517a9a1e3b8ed80e491f427bd4207de8c5b75b1e865f8aa2259fd5fb0da536`
- SUCCESSOR.diff: `6d9291f54c100ae1825c928b63a50d7d54634e7efaf0c5c55c7232ac58e2128c`
- Child: `0119bf61d8db4e1889662b6f6e875fbafe0fdd04ce74bdbea46bb2c6a6df481b`
- METHOD v5: `86214bef6beb0eddb320d1240cab3d535736c10ae944305da1b3bf16a7b9f3c8`

## Corrected binding failure

V3 changed the supervisor's method binding to v5 but preserved a child constant requiring v4. Every child would have rejected its configuration before importing the subject. This was found statically, before execution. V4 preserves v3, changes only the child METHOD_SHA constant to the reviewed v5 hash, and adds an inert cross-file consistency test. Exact diff inspection confirms all other child bytes remain unchanged.

## Decision semantics

Both protocol mirrors now require P1-local measurement quality in both engines plus shared full schedule, process-completion, batch/count/checksum and startup-observation integrity for primaryQualified. Unrelated control readiness or resolution failure does not suppress a reliable primary result. Material harm requires a quality-valid endpoint with lower ratio bound above 1.02. PromisingLead and diagnosticFollowOnEligible require a qualified primary and no valid harm veto. RegressionClearance additionally requires all strict controls to clear.

Startup quality is evaluated using the corresponding startup clock and process completion, independently of later read readiness. Its raw timings and sixteen-round block analysis are unchanged. Unresolved controls and descriptive adverse observations remain visible. The legacy eligible alias stays strict regression clearance; the supervisor's explicitly named follow-on field maps to diagnostic eligibility only after terminal integrity passes.

All new decision fields and strict aliases initialize false, remain suppressed before terminal verification, and are cleared in both result and analysis by the shared late-failure invalidation path. The prior interruption/deadline and sampled-descendant corrections remain unchanged. No diagnostic flag authorizes execution, publication, resampling or a broader performance claim.

## Verification and limits

Independent v3 reruns passed 22 protocol tests each in pinned Node 22.16.0, Bun 1.4.2 and Python, plus ten controller tests. Those protocol implementations and tests are byte-identical in v4, so their 66 passing cases carry forward. Independent v4 reruns passed all eleven controller tests, including the new method-binding regression; the Node child parser and Python AST checks passed. This gives 77 passing inert cases for the final file set without repeating unchanged protocol tests.

All eighteen final integrity checks passed. The v3-to-v4 delta contains only the child constant, one controller test and explanatory README metadata. V1–v3 packet seals remain intact. The v5 method, fixture payloads, measured loops, canonical schedule, counts, intervals, margins, clocks, feasibility and resource limits are unchanged. Candidate source remains exactly 503 files matching the sealed manifest, with no symlinks or extras.

The separate ordinary-completion run and provisioning artifacts are not certified by this driver-only report. No execution readiness or release is implied.
