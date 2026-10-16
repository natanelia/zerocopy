# Lazy freezeJSON bundle preparation

This branch runs only the separately bounded artifact-preparation gate. It does
not run calibration, measurement, a benchmark, or an automatic follow-on job.
The source packet and prospective method remain unchanged.

The original local attempt stopped before launching any child because the
environment exposed neither a cgroup mount nor memory-controller files. Host
memory availability could not establish the effective container limit. Its
unchanged incomplete admission is retained at
`lazy-freeze-worklist/prior-attempt/local-admission.json`. No local guard was
relaxed or bypassed.

The dedicated preparation workflow uses a standard GitHub-hosted Linux runner
and the same exact Node 22.16.0 and Bun 1.4.2 executable hashes, source hashes,
compiler flags and resource guards. The runner must still satisfy effective
host/container memory admission. A missing mapping or insufficient headroom is
an incomplete result, not permission to fall back to host memory.

There are at most six owned preparation children: two identical-arm Bun builds
and four compiled-bundle regression invocations. The caps remain 30 seconds per
child, 240 seconds overall, 1 GiB sampled owned-group RSS, and at least 2 GiB
effective available memory. No retry or replacement command is allowed. The
workflow rejects GitHub rerun attempts and retains all source and partial or
complete outputs for 30 days.

The output must receive a separate review of emitted bundle differences,
source/runtime bindings, regression results and cleanup/cap receipts. Only then
can the artifact inventory be sealed for a separately authorized measurement
study. This workflow never creates that seal or invokes the study controller.

The branch adds this dedicated read-only workflow; it does not modify existing
workflows or repository settings and does not create a pull request. Hosted
run/job identifiers and the retained artifact provide the execution provenance.
No performance or memory benefit is claimed by successful preparation.
