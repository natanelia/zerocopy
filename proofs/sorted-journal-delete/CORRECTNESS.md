# Sorted pending-delete focused correctness result

The focused gate passed on the prototype based on commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. Both baseline and candidate received fresh native and portable builds and passed production typechecks. The candidate changes only the native pending-journal deletion path; existing source fixtures remain unchanged.

Node 22.16.0 and Bun 1.4.2 each passed the same 81 named tests for both arms, totaling 324 case executions. Each run included 20 new cases plus 61 existing sorted, revision, and allocation-failure cases. All selected cases passed, with no skips or retries. Two Node worker proof commands completed four real worker round trips using shared and copied transport against the fresh portable builds.

The cases cover pending counts 1–4, every deletion position, new and replacement keys, duplicate synthetic journal entries, stale size metadata, canonical output and ordering, query-pointer fallbacks, key encoding boundaries, caches, comparator ties, old snapshots and paused iterators, memory growth, nested attachment and checkpoint round trips, and allocation failure after partial construction. Single-collection and record session tests preserved root-equality notification decisions. The nested child in the record notification case remained unchanged; nested-value replacement parity is not claimed by that fixture.

Untimed allocation accounting confirmed the small mechanism on both engines: deleting `b` after `set('a', 1).set('b', 2)` consumed 24 arena bytes in baseline and zero in candidate, while returning the same surviving leaf. The singleton replacement control consumed zero deletion bytes in both arms. This establishes these specific allocation examples, without implying a general allocation reduction or latency improvement.

All twelve commands exited successfully, and their process groups had no remaining descendants at cleanup. Source, executable, and pinned dependency hashes remained unchanged. Fresh native outputs and their embedded portable bindings were authenticated.

This is focused correctness evidence. It does not establish a speedup, full-suite compatibility, or a performance recommendation.
