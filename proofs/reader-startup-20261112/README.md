# Construction and first reader query

Build the baseline and candidate independently with the same dependencies and
`build:wasm` / `build:browser` commands, then run this harness under each runtime:

```sh
node proofs/reader-startup-20261112/run.mjs /path/to/baseline /path/to/candidate /tmp/reader-node.json
bun proofs/reader-startup-20261112/run.mjs /path/to/baseline /path/to/candidate /tmp/reader-bun.json
```

The default cohort has six alternating before/after process pairs per workload
and size (1,000, 10,000, 100,000). A final positional argument changes the pair
count; `SIZES=1000` selects a smaller diagnostic cohort. All samples are retained.
Do not compare concurrently with another CPU-heavy task or rerun unchanged
cohorts to select a favorable result.

Every sample has a fresh owner process and two fresh reader workers. Library
imports, worker startup, deterministic input generation, and result checking
are outside the timed regions. Construction includes arena creation. There is
no query warmup: the first query exercises empty reader caches and fresh reader
code. The repeated query is reported separately.

The primary catalog Map workload uses the website's original `calculate`
functions: 1,000 requested IDs, 910 hits, 90 misses, nested product fields, a
lookup reader, and a validation reader. Fingerprint generation remains inside
the timed work; comparison with the independent reference is outside. Requests,
reply cloning, and both acknowledgements are included. Publication includes
descriptor creation and reader attachment. Updating 100 products and querying
the current and retained revisions checks cache and snapshot behavior.

An object List stores the same records and exposes an ID-to-index adapter to
the same query functions. A numeric Map is the primitive control. These are
secondary workloads, not additional website benchmarks. Full initial output
and nested freezing are also checked after all timed operations.

`readyMs` is construction + publication + first query **within each sample**.
It exposes work shifted between phases. It excludes input generation, module
imports, and the harness's out-of-timer verification and is not launch-to-ready
wall time. Summaries contain medians, paired after/before ratios, faster-pair
counts, and ranges. Raw records, source/distribution hashes, fixture hashes,
runtime, and hardware metadata accompany them. A ratio below one means faster;
small changes with overlapping ranges should not be treated as established wins.

This Node/Bun harness does not establish browser performance or a general win
over native Map, Immutable.js, or Immer. Use the original browser workload for
those comparisons. Existing recorded website timings are not a fresh baseline.
