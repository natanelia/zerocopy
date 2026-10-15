# Hosted provisioning plan v2 review

Disposition: clear for implementing the minimal prospective wrapper. This is not publication or subject-execution release.

The only concrete v1 blocker was first-run activation: GitHub requires a workflow_dispatch workflow to exist on the default branch. V2 uses the established single proof-branch push, with final exact-packet release before publication, branch/event/attempt checks, checked head = event SHA, fixed sole parent, exact reviewed payload/source authentication and deterministic head/path-only release substitution. The v1 bytes remain unchanged and the recorded successor diff is exact.

The five fixed builds and single locked installation remain bounded. Listed command caps total 590 seconds, leaving 250 seconds inside the 840-second preparation work allowance for finite authentication and runtime identity checks; the final 60 seconds of the separate 900-second budget are reserved for cleanup and preservation. The screen retains its independent 400-child/600-second limits. The 35-minute outer job allocation sums correctly and does not extend either inner deadline. No additional subject import, probe, calibration, ordinary-test rerun, retry or fallback is authorized by this plan.

Static provenance checks independently confirm that the reused 502-source baseline manifest is byte-identical to the current ordinary baseline, the prior production-output manifest contains the pinned 25 outputs, its 13 native rows exactly match the common current native manifest, and both ordinary stages have the same pinned 66-output candidate manifest. Only those production input/output manifests were read; no prior measurement payload was examined. This check establishes manifest equality, not a replacement audit of the separate ordinary correctness receipts.

Remaining concrete gate: review the exact adapted wrapper, release-template substitution, complete source/output/closure/evidence bindings and final coordinator release before the push. Enforce the global preparation work deadline during in-process extraction, hashing and final authentication as well as child commands. Preserve original failed ordinary-stage evidence when composing the passing coverage. Fresh output mismatches must stop, never repin.

Official trigger reference: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

No subject code was imported, built, tested, calibrated or measured during this review.
