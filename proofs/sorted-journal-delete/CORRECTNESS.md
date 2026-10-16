# Sorted pending-delete focused correctness result

The original focused gate passed on the pending-journal prototype based on commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. Both baseline and candidate received fresh native and portable builds and passed production typechecks. The candidate changes only the native pending-journal deletion path; existing source fixtures remain unchanged.

Node 22.16.0 and Bun 1.4.2 each passed the same 81 named tests for both arms, totaling 324 case executions. Each run included 20 new cases plus 61 existing sorted, revision, and allocation-failure cases. All selected cases passed, with no skips or retries. Two Node worker proof commands completed four real worker round trips using shared and copied transport against the fresh portable builds.

The cases cover pending counts 1–4, every deletion position, new and replacement keys, duplicate synthetic journal entries, stale size metadata, canonical output and ordering, query-pointer fallbacks, key encoding boundaries, caches, comparator ties, old snapshots and paused iterators, memory growth, nested attachment and checkpoint round trips, and allocation failure after partial construction. Single-collection and record session tests preserved root-equality notification decisions. The nested child in the record notification case remained unchanged; nested-value replacement parity is not claimed by that fixture.

Untimed allocation accounting confirmed the small mechanism on both engines: deleting `b` after `set('a', 1).set('b', 2)` consumed 24 arena bytes in baseline and zero in candidate, while returning the same surviving leaf. The singleton replacement control consumed zero deletion bytes in both arms. This establishes these specific allocation examples, without implying a general allocation reduction or latency improvement.

All twelve commands exited successfully, and their process groups had no remaining descendants at cleanup. Source, executable, and pinned dependency hashes remained unchanged. Fresh native outputs and their embedded portable bindings were authenticated.

This is focused correctness evidence. It does not establish a speedup, full-suite compatibility, or a performance recommendation.

## Canonical-dispatch repair

The subsequent dispatch repair moves only the materialization assignment into the JOURNAL fallback branch. It passed a fresh native build and the unchanged 81 focused cases on each of Node 22.16.0 and Bun 1.4.2, totaling 162 case executions. All four commands, including static disassembly, exited zero; all original process groups were cleaned and reaped. No assertions or helpers changed.

Static decoding of the fresh binary confirms that canonical roots bypass materializeJournal. Every decoded function outside radixDelete is identical to the archived rejected candidate. The repaired source SHA256 is `6a0e16e08270221c581e2604adac842aeaed221256dd03d9792c45359299018d`; the focused native binary SHA256 is `df003aca74389bfd9c726f05a10709ff54216db5729b1d623da2650e1b4f29a3`. This establishes the intended compiled path and focused correctness, not a performance benefit. Fresh ordinary full admissions remain mandatory before this repair's separate study.
