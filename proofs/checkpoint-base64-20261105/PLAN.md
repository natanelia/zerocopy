# Checkpoint byte-oriented Base64 experiment

Fixed baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.

Hypothesis: checkpoint export spends avoidable time spreading each 24 KiB byte
chunk into `String.fromCharCode` and encoding intermediate strings. Engines
with the standard `Uint8Array.prototype.toBase64` method can encode the bytes
directly. Keep the existing algorithm verbatim on other engines. Do not change
decoding, validation, wire format, checkpoint compaction, or dependencies.

This host has Bun 1.4.2 with the native method and Node 24.22.1 without it. The
Node comparison is a fallback control, not an expected native speedup.

Fixed cases: plain state without collections; checkpoint a 32-number list;
checkpoint a 32,768-number list; serialize that large list to JSON; checkpoint
2,048 distinct Unicode strings; decode a large numeric checkpoint (unchanged
control). Inputs are built once outside timing. Each timed operation performs
the complete public checkpoint operation, including compaction, allocation,
checksum, Base64, and freezing, plus JSON serialization for that case.

Run a two-pair screen, then a separate six-pair confirmation if worthwhile.
Each subject is a fresh process importing one complete portable build from the
same neutral directory. Replace every bundle chunk between subjects. Alternate
AB/BA by pair and case order by pair. Use CPU 2 and the shared performance lock.
Warm each case for at least 500 ms of actual timed operations and at least eight
batches before nine measured batches. Keep fixed repetitions per case and both
builds, recorded in the driver. Each batch retains its outputs until verification
outside timing. Verify every exported arena's bytes against the independently
checked initial checkpoint, and every decoded value for the read control.

Preserve all calibration-free warm-up and measured batches. Use process medians,
paired after/before ratios and an unadjusted 95% Student-t interval on paired log
ratios; independent units are the six process pairs. Include every case in the
report. Freeze source before confirmation and record all source/bundle/driver
hashes. Record failed attempts without overwriting their evidence.

Correctness proof: public checkpoint round trips in fresh Node and Bun processes,
including forced fallback, empty and boundary sizes, all byte values, Unicode,
special numbers, nested references, and immutable old snapshots. Compare encoded
bytes with an independent Base64 implementation. Preserve existing malformed
checkpoint validation and exercise shared/copy attachment after restoration.
