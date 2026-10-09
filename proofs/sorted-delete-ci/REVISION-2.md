# Prospective revision 2

The original Node baseline untimed minimum failed at the final validation oracle: output.has(deletedKey) moved a shared ReadCache slot to a result root, and entries() did not re-prime it. Arena.sameValue requires an exact-root positive slot. The original attempt and default-off packet de808ca9465da4450251128cdc3508fb13d51234 are preserved unchanged.

The parent explicitly authorized this minimal correction: after all post-body cache, output, payload and input checks, call source.get(key), verify its expected value, then assert source.set(key, sameValue) returns the source. This is untimed validation only. The measured delete loops, fixtures, query schedules, cases, counts, ladders, thresholds, resource limits, deadlines, fail-fast behavior, controller and math are unchanged.

A deterministic validator-order test models output.has moving a cache slot and verifies that retained payload checking precedes the final get/set pair. It imports no collection arm and reads no operation clock. Independent review and the parent's go-ahead are required before one new four-subject untimed attempt. No automatic retry is authorized.
