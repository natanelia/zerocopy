# Preserved verification correction

`worker-prefix-guard.mjs` is the original worker proof, with its original fixture
file beside it. Its failed output is retained in
`../validation/node-workers-prefix-guard-failed.txt`.

It incorrectly required every arena byte below the old used length to remain
unchanged across owner writes. That range includes mutable writer scratch.
All returned values, entry order, keyed reads, freezing, and readonly checks
passed before the hash assertion failed after owner growth. The corrected proof
hashes immediately before and after each read phase instead, while keeping the
same complete retained-snapshot assertions across owner changes.

No production or benchmark code changed, and no benchmark samples had been
collected when this verification bug was corrected. To replay the original
proof, provide `TANSTACK_VALUES_BUILD` with the absolute built repository path.

`benchmark-empty-checksum.mjs` preserves the initial benchmark driver. The first
empty-input calibration stopped before recording a timing pair: its arithmetic
checksum oracle produced negative zero for `0 * (0 - 1)`, while the verified
empty result accumulated positive zero. Strict equality correctly distinguished
them. `../results/pilot-01.json` and `empty-checksum-progress.txt` preserve that
failure. The corrected driver explicitly expects positive zero for empty input;
all nonempty checks and the production source are unchanged. The complete pilot
uses the new `pilot-02.json` path.
