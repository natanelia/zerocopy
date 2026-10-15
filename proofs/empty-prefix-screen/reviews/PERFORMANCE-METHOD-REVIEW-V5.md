# Empty-prefix method review, v5

Disposition: **prospective decision amendment clear**. No wording blocker remains. This review covers method definitions only; it does not approve future driver bytes, subject execution, diagnostics, publication or a performance claim. The publication/ordinary-completion holds remain independent prerequisites.

Reviewed METHOD.md SHA-256: `86214bef6beb0eddb320d1240cab3d535736c10ae944305da1b3bf16a7b9f3c8`.
Exact v4-to-v5 delta SHA-256: `d2f03ef185290d31b79c6b49aa00892355f9bcc22c0d8efb9f22578717ad4f43`.
REVISION-PINS.json SHA-256: `243bd51819ede5950e2c92a7299c060d6d8f0ceeec752aa5230364c7d2f55824`.

The amendment explicitly separates permission to propose diagnostics from the strict regression-clearance condition. Both P1 engine endpoints must retain their existing local correctness/source/readiness/resolution requirements and upper 95% ratio bound at or below 0.95. Shared source/correctness and complete fixed-schedule integrity still apply. Unrelated control quality no longer masks a reliable P1 result.

A valid measured endpoint with lower 95% ratio bound above 1.02 retains the material-harm veto. Invalid adverse estimates remain visible and unresolved; they cannot establish confident harm or clearance. Diagnostic-lead eligibility requires a qualified primary and no valid material-harm veto. Strict regression clearance additionally requires every supporting/control endpoint in both engines to be valid, have point ratio at or below 1.00 and upper bound at or below 1.02. Absence of a valid harm veto is explicitly not evidence of absence of harm.

Thus qualified P1 plus unresolved controls can be labeled a promising lead with unresolved controls, while regressionClearance remains false. A valid confident loss blocks that diagnostic eligibility. A failed primary criterion yields no qualifying lead. Every adverse/unresolved observation and interval stays in the report. Diagnostics require their own purpose/scope review and may not add, replace or resample this screen's observations.

Integrity checks verify all announced hashes and exact deltas, preserved v1–v4 packets, and byte-identical FIXTURES.json, SOURCE-PINS.json and STATIC-COVERAGE.json. All pre-decision method text, samples, endpoints, clocks, intervals, margins, counts, scheduling, feasibility and resource limits are unchanged. Candidate remains exactly 503 source files matching its sealed manifest, without symlinks or extras. Only static inspection, arithmetic and opaque hashing occurred.

Future code binding must use P1-local quality for primaryQualified, quality-gated material harm, separate diagnostic and regression-clearance fields, and terminal invalidation of all new decision/eligibility fields. The v4-bound driver review remains separately preserved; no unreviewed driver amendment is covered here.
