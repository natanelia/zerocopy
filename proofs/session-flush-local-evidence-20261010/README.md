# Retained session-flush evidence archive

This archive preserves the recorded 10 October 2026, 07:15–07:16 UTC session-flush latency study. It contains exactly 90 public files, including the original manifest, 80 original JSON results, raw batches, sanitized receipts, provenance, scientific summary, full README, and standalone verifier. Every archived file is byte-identical to the reviewed public export. The MANIFEST.json alongside this wrapper is an identical copy of the archived manifest.

The primary workload is one changed publication over 128 names followed by 31 unchanged explicit flushes. Median paired reductions were 59.7% on Node and 38.6% on Bun across that 32-operation mix. All eight endpoint/runtime cells are noisy and unresolved; controls include eight adverse pairs. These retained observations do not establish general performance, equivalence, no regressions, or completed current-source CI. See the archived README for the complete method and limitations.

## Integrity

- Archive: session-flush-local-evidence-20261010.tar.gz
- Archive size: 109224 bytes
- Archive SHA-256: c983fe72db8afde67837f43b17583e700e5d2d6cc3db1df2ad74e406da5475cb
- Original MANIFEST.json SHA-256: 14393b4199a3f6a67558be9137ff02d2c8219dee1493c699f8713774aab5144e
- Archived files: exactly 90; no directory entries, symlinks, or additional files

The archive uses sorted filenames, fixed zero timestamps and owner IDs, empty owner names, fixed file modes, and a gzip header without a filename. Read-back verified all 90 entries and bytes against the reviewed public export. Hashes establish integrity, not an independent signature.

## Extract and verify

Download the archive from this commit and run these commands in the download directory:

```sh
printf '%s  %s\n' c983fe72db8afde67837f43b17583e700e5d2d6cc3db1df2ad74e406da5475cb session-flush-local-evidence-20261010.tar.gz | sha256sum --check
mkdir session-flush-local-evidence-20261010
tar -xzf session-flush-local-evidence-20261010.tar.gz -C session-flush-local-evidence-20261010
python3 session-flush-local-evidence-20261010/verify.py
```

Use a fresh extraction directory: the verifier rejects extra files. It uses only Python's standard library, checks the whitelist and hashes, reconciles retained raw rows and receipts, and recomputes the scientific summary. It does not import the subject or run benchmarks. Archive creation performed no new timing, builds, tests, or CI runs.
