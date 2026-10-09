# Prospective radix helper frame screen

This is one bounded causal diagnostic, not an adoption or full-catalogue gate.
The historical WebKit current/baseline empty-radix loss remains +3.204%, with
95% CI [+2.490%, +3.923%]. It is neither rerun nor pooled with this study.

## Fixed sources and scope

- Baseline B: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Historical PR24 C: `cda6f639faab0ef627fb97ed199864fc4cc2468a`.
- Helper H: `e15597748144bf92439a88a2d0405f038e1cc833`, direct child of C,
  committed tree `871dc245dcb420254f99b5d77a6b99785eb89a40`. This contains the
  reviewed helper and two tests; its runtime-only projection remains
  `fa9fbea9011ae8e6109db874493e720fd6b6278b`.
- Source, compiler-package, all 12 WASM inputs, all 12 emitted JavaScript
  bundles, original package metadata, engine revisions and native installation
  manifests are checked. All variants run through identical neutral paths.
- Current main `ad2a19d65a836985a2364b181bc9bd8dce6e42ad` integration, journal
  performance, PR24 metadata and readiness are outside this screen.

The only timed cells are empty radix, singleton radix, canonical 4096-entry
radix, and empty HAMT, using the unchanged audited public-operation workloads.
Engines are Linux x64 Bun 1.4.2, revision
`744846f844374847c902b5e7fd59b4342a51ef99`, and Playwright 1.63.0 WebKit revision
2359 (26.6), with default JIT flags. Node 22.23.3 is a controller and correctness
runtime only.

Every cell has direct H/B and H/C comparisons and separately executed matched
B/B and C/C controls. Each mode has four balanced ABBA/BAAB quartets, two of
each orientation, with a fresh process per subject and a fresh browser per
WebKit subject. Each subject has 21 measured batches. There are 256 measured
subjects and 5,376 batches per engine: 512 subjects and 10,752 batches total.
No measured subject is shared between contrasts.

## Prerequisites and execution

A shared prerequisite job first builds all three exact sources and runs their
unmodified full Bun unit suites, root/value/Redux/geometry type checks, type
builds and package checks. It also runs the helper's 17 focused semantic tests
on Node and WebKit. The browser test-only adapter precompiles the pinned
baseline oracle and replaces only environment/test registration helpers; it
preserves every semantic test body and leaves production bundles untouched.
The WebKit semantic run uses the same corrected browser lifecycle as timing.

Both timing lanes depend on that job and validate its complete sealed evidence,
same workflow run/commit, source receipts, compiler identities and output pins.
They rebuild the three pinned bundles and check exact equality against those
prerequisite inputs. Each lane then performs 12 fixture checks and six real
shared/copy worker checks before any pilot. Any failed prerequisite prevents
timing admission.

Local preparation of H produced 763 unit passes and seven 5-second timeouts.
That result is unresolved; unchanged test sources do not prove a pre-existing
failure. No local rerun or timeout change was made. The shared CI stage must
provide the same-condition B/C/H comparison and a complete source-specific pass
before either lane is admitted. Partial preparation logs remain separately
retained and are not timing evidence.

One disposable pilot per build/case yields 12 pilots per engine. All 12 pilots
and all four common plans finish before measurement. The common work plan uses
the fastest valid retained post-prewarm rate across B, C and H. This is an
explicit, tested three-build extension; the original two-key validator is
unchanged. All cases, pilot order and interleaved mode/quartet schedules are
seeded and frozen in `radix-frame-screen-manifest.json` before a pilot.

Keep 40 ms planning batches, 500 ms prewarm/warmup targets, 1.25 safety cushion,
10 ms measured-batch and 150 ms warmup floors, and the audited calibration/call
caps. The browser calibration starts with the final retained positive prewarm
repeat. Native Bun retains its audited repeat=1 calibration start. The exact
worker-close barrier completes before browser close; browser/server closure
and outer process-group cleanup are independently checked. The corrected
transport comes from `8b8e6d78ee444ce07b1ee59a652106e0221c7a69`, reviewed tree
`b3fa6631efbec2f926b153ca69ff837262622285`, successful archived run 37882888216.

The Playwright executablePath digest is labeled as the launcher. A separate
manifest hashes the installed native ELF files, all regular distribution files
and internal symlink targets. This does not claim identity of every host system
library loaded by WebKit. Engine and installation guards are frozen before
runtime correctness/pilots and rechecked for every fresh subject.

Each controller has a fixed 75-minute ceiling, retaining the original subject,
launch, worker-close, browser-close and cleanup limits. Workflow ceilings leave
bounded setup and archive time. The scoped push requires a direct proof commit
on C, an existing branch whose prior head is C, run attempt one and a non-forced
push. There is no dispatch input or retry path.

## Interpretation and stopping

Process medians form adjacent-pair log ratios, averaged within each quartet.
Four quartet means determine pointwise two-sided 95% Student-t intervals with
df=3; batches are not independent replicates. Ratios are right/left latency.
Lower CI >1.02 means detected material loss; upper CI <=1.02 means within margin;
otherwise the result is inconclusive. An AA estimate outside [1/1.02, 1.02]
whose interval excludes one invalidates only its matched direct contrast. AA
does not adjust estimates, and absence of a drift flag does not imply equivalence.

A promising selected-cell repair requires every H/B and H/C contrast usable
and within margin on both engines; WebKit empty-radix H/C upper CI <1; and
canonical-4096 H/B upper CI <1 on each engine. Gains never cancel independent
singleton, target or unchanged-control losses. All selected cells are reported.

Any source, correctness, duration, floor, lifecycle, cleanup or completeness
failure stops the affected run immediately and retains partial records. No
clipping, sample rejection, extra quartets, reruns, substitutions or
timing-informed edits are admitted. Stop after the one fixed run; any recovery
or broader study requires another prospective review.

## Mechanism and compatibility limits

The retained Bun empty generator environment grew from 112 to 160 bytes when
saved registers grew from nine to ten. The helper wrapper retains 48 bytes.
These mechanism observations support a possible cause; they do not prove a
warmed timing repair or equivalent WebKit allocation behavior.

Every nonempty walk adds an internal generator and `yield*` delegation,
including journal recursion. Modifying shared generator intrinsics can observe
an extra GeneratorPrototype `Symbol.iterator` call and affect behavior; error
stacks gain a frame. This is an ordinary-intrinsics diagnostic, not universal
observational equivalence. Journal performance remains unmeasured here. No
adoption or PR update follows without evaluating the complete results and the
remaining compatibility and coverage limits.
