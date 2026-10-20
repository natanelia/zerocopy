# Stage 13 and Stage 14 evidence recovery

Recovery date: 20 October 2026.

Status: **Neither candidate has performance clearance. Do not merge.**

This proof branch retains the Stage 10 production source. Recovery commits add evidence only. They do not apply Stage 13 or Stage 14 to the production kernel, change the numerical acceptance thresholds, repeat a timing cohort, or clear the original 63-endpoint acceptance gate.

## Verified retained input

Conversation archive: `zerocopy-stage13-stage14-evidence-20261018.zip`.

Archive SHA-256: `92ae391f8b57be4faa0c72de4ce3ed3537fa2e9ff7c12deffaf13b0eb7063dc9`.

All 25 entries in its EVIDENCE-MANIFEST.json match their recorded byte lengths and SHA-256 hashes. Both retained Python audit scripts were rerun on a separate copy of the archive. They verified all 48 child reports and their journals. The regenerated JSON reports are byte-identical to the retained reports:

- Stage 13 audit: `ac0729827f0069a43a60d33034b1d1028d1ec8938711fd0a6f58ce36e110575c`.
- Stage 14 audit: `cf7c3c6863690e1e7dee158df36ce0e666ad55b04e0da031dfe21932b2d9126c`.

The audit is replay of existing measurements, not a new benchmark. The original runtime is Node 22.16.0 on x64. The local replay runtime is also Node 22.16.0 on x64; this does not establish identical hardware.

## Decisions remain unchanged

Stage 13: A/A passes 3 of 3 checks; A/B passes 0 of 3.

Stage 14: A/A passes 2 of 3 checks; A/B passes 2 of 3. Its large-input A/B results do not override the failed identical-build control and the size-1025 failure. No sample was excluded and no threshold was changed.

These screens compare direct WebAssembly calls against Stage 10, not against current main. Public API performance, Bun, ARM64, browsers, workers and full regression clearance remain unverified for these candidates.

## Publication scope

This initial recovery record contains the input identity and completed replay results. It is not a claim that the full source and raw archives are already committed. Subsequent evidence entries, when present, must retain the exact original bytes and their hashes. The original archive remains unchanged.

No merge, package release, dependency update, force-push or benchmark rerun is part of this recovery.
