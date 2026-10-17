# Workspace recovery

## Status

This branch is a recovery checkpoint. The production idea is still a draft. No performance clearance is claimed.

The workspace connection failed near 03:58 UTC on 17 October 2026. The restored local filesystem contained an older state. Recent uncommitted files and raw records were absent. Published GitHub revisions were still available.

The Stage 3 production source, benchmark, cases, and protocol survived with their exact recorded SHA-256 values. The final test file was recovered from the exact transcript edits. Its hash also matches the value recorded before the reset.

## Available evidence

The archive beside this note contains every surviving file under the local vector-compaction results directory. Its manifest contains each file size and SHA-256. Every archive entry was read back and checked. The original surviving files were not changed.

The archive includes the first failed identical-build checks, Stage 1 and Stage 2 records, failed launches, and partial Stage 3 validation. It does not contain the later Stage 3 screen or the revised identical-build cohorts.

## Missing evidence

Before the reset, a 2,779-file archive had been made and verified. Its recorded SHA-256 was e4062207c8a23a64132a58b8bd778afbdf2b33262b93b87e6daf3206c79b9430. That archive is no longer available locally. It had not yet been published. Do not treat this surviving-file archive as an equivalent replacement.

The conversation retains the Stage 3 summary, the previous full-suite result, and worker results. Those summaries are transcript evidence. Their original raw files are missing. No raw samples or logs will be invented. Any new validation will have a new output directory and its own date.

The lost Stage 3 fixed screen had two process pairs for all 14 cases in Node and Bun. Its reported primary combined speed ratios were 3.470 and 1.265. These observations were exploratory. The fixed local revised identical-build check had already failed for 11 of 14 Node cases and 7 of 14 Bun cases. Small and generic cases remained unresolved. The reset does not remove these failures or improve the conclusion.

The local eight-pair acceptance comparison had not run. The first hosted method check had not run. Both statements remain true at this checkpoint.

## Next work

Recover the proof files from retained source text. Verify all available prior hashes. Label other reconstructed files. Run new correctness checks on the recovered tree. Validate the CI acceptance gate before opening the draft PR. Keep the original fixed limits and all surviving failed evidence.
