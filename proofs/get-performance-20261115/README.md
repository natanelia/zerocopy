# Standard `.get()` performance investigation

Track A landed separately as [PR #78](https://github.com/natanelia/zerocopy/pull/78), commit `1242908762b554e3574365c486d5a6c52d5e568f`. This is the runtime baseline and fixed website harness. Track B started from that then-current main; repository instructions were checked again, with no applicable `AGENTS.md` file present.

## Candidate awaiting the fixed study

The candidate replaces ordinary-object `Object.values` traversal during deep freezing with `Object.keys` and indexed value reads. It preserves every required freeze, iterative traversal, native JSON parsing, existing caches and ordinary `.get()` return types. Arrays keep their existing direct scan. A regression covers 20,000 nested objects alongside the existing deep-array and special-property tests. This still allocates an array of keys; it is not an allocation-free decoder.

Six exploratory hypotheses were kept separate: ordinary-object type dispatch; own-key traversal; `for…in` with an own-property check; lazy worklist allocation; split ASCII/encoded key verification; and combined keys/lazy traversal. Each received two alternating pairs in Node/Bun and Firefox against unchanged workloads. Their timing variation and mixed results are not a final speedup claim. Own-key traversal is the selected candidate for the predetermined seven-pair study. The other changes are excluded, including the combined variant that was slower in the Firefox primary query and the `for…in` variant with unresolved default-timeout failures.

The [study plan](study/PLAN.md) fixes the sample counts, fixtures, timer boundaries and guardrails. Formal runs will use all 33 local cases plus the exact frozen website workers, with a separate seven-pair identical-build control because the pilot showed material host variation. A roughly twofold cold-read gain remains an aspiration, not a measured result or promise. No hosted-site timing is used as evidence.

## Completed preparation

The initial study tools were committed before measurements. The first correctness pilot exposed two tool errors: nested maps use `valueType`, and fixture metadata had overwritten the NDJSON event discriminator. All eight failed processes are preserved separately. The corrected pilot passed every case in Node, Bun and Firefox.

Native sampling and separate source-instrumented profiles retain native parsing and decoding. They identify ordinary-object enumeration as one source of work, while showing no UTF-8 fallback copying for these Node/Bun inputs. Instrumented times overlap and are not speedup evidence. The unchanged warm cache already skips decoding and freezing for admitted values.

The browser adapter now records that it does not set CPU affinity, separately from its source Node/Bun manifest. That metadata correction changes no query, fixture, timer or launch behavior. All raw pilots, rejected variants, profiles, final measurements and validation logs will accompany the completed report. Historical evidence and the Track A website workloads remain untouched.
