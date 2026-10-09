# One fresh hosted bulk-input latency study

This proof runs the fixed 80-subject study once on a new hosted runner. It reuses the exact audited builds from correctness run [37990109064](https://github.com/natanelia/zerocopy/actions/runs/37990109064), attempt 1, head 18819a29da0436d2e7449072428a8eb601261a2e, artifact 11644597826. The complete downloaded ZIP must be 2,063,613 bytes with SHA-256 8aa0a338543bea260ce2b5d96286b4b215c56fb19a62f7a9a7f3d8bed74d1416. All 205 retained source, lock, build and receipt files must match ARTIFACT-FILES.json before any subject. Missing/expired/mismatched inputs stop preparation. There is no build, installation, correctness-matrix repeat or fallback.

Baseline is main52d5fb012eb1f568e11807b7cb2a66c4566589e2, tree 0bc8d2425fe82e0b70bbb8558deb175536f90e9d. Candidate runtime is the local dc7ed0a5ee0aca2f54d1da34e4c3fbeef7938468 identity, tree 1dcb5301fdeddedef5f885eb13b868c9167b2736. Removing this workflow and proof directory from the actual published transport must recover that runtime tree. The local runtime commit need not be remotely reachable.

The publisher creates proof/bulk-input-latency-20261009 at main52, then advances it once to the reviewed complete tree with sole main52 parent. Job and helper admission require this exact push branch, event.before=main52, event.after=GITHUB_SHA, no forced push/deletion, and run attempt 1. Subsequent pushes do not silently rerun the study. Publication/activation follows independent source review and coordinator release.

## Fixed scientific method

bulk-input-case.mjs, bulk-input-analysis.mjs, math.mjs and supervise.py are byte-identical to the reviewed local study. The controller changes only its supervisor path. Invocation templates change only executable/supervisor path placeholders. New metadata prospectively corrects the previously unused nested supervisor.seconds descriptor from 30 to 60; the two original local attempts retain their original files and invalid/incomplete outcomes.

Keep all 80 fresh subjects, original order/pair counts, 20 warmups, ten measured blocks, public setMany timer boundaries, retained roots and fresh-reader verification. Do not reuse local rows, calculate partial effects or pool environments. MATRIX.json retains the exact process-level interval model, 2% margins/diagnostics and separate statistical/PR decision layer. Completion of CI is distinct from a latency margin pass or eligibility for promotion.

Each child and the final read-only analysis have 60 seconds, a one-GiB supervisor RSS safety cap, and the separate 128-MiB observed WASM-backing invariant. Admission requires 68 remaining seconds. The controller still has 2,700 seconds total, with a 2,692-second active cutoff and eight-second cleanup reserve. Those ceilings can leave the schedule incomplete; no child is shortened, replaced or retried.

## Hosted identity and retention

One Linux x64 job uses ubuntu-24.04, Node 22.23.3 and Bun 1.4.2. Before subjects, it records and binds the actual runner image, kernel/CPU details, full runtime versions, executable hashes, source hashes, ZIP/file inventories and exact resolved schedule. Standard hosted runners do not promise a fixed CPU model or immutable image. This is a separate environment and whole-run identity, not a continuation of either local attempt.

The measurement step allows 47 minutes around the unchanged 45-minute controller. A 75-minute job leaves separately bounded preparation, finalization, archive and upload steps. Wrapper signals enter bounded owned-controller cleanup: eight seconds for TERM, then two for KILL, with unresolved handles explicitly unreferenced and cleanup reported unknown. This transport-only bound changes no subject or controller budget. Original controller/supervisor receipts alone establish subject-group cleanup.

Raw controller output is written directly to its retained log. Launch, owner, actual terminal and cleanup/error records are separate. Final status can say complete only after successful original step/terminal conditions, all 81 command receipts and final input verification. Otherwise retain invalid/incomplete and the original validation error. Missing records are not reconstructed.

Finalization, tar.gz/digest packaging and upload use always(), including partial evidence. Packaging prevents archive member names from violating artifact-upload filename restrictions. VM loss, hard job termination or artifact-service failure can still prevent upload; no absolute durability claim is made. RSS and process-lifetime fields remain supervisor safety metadata, not heap or setMany latency results.
