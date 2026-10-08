# Focused Bun ARM64 compaction diagnostic

This is a single diagnostic study, not another optimization or a performance acceptance gate. It changes no runtime source. It asks whether the previously observed small-compaction differences remain specific to a candidate when work counts, warmup calls and comparison order are controlled more closely.

## Exact subjects

- Main: `3331f2f0e9e0c3c61832e5f04b12e18c1889d96c`
- Original span-copy candidate: `c5a242cd641e4ee96005296fab485e332a1394b7`
- Narrowed candidate: `b1e3d9d27b55ce5c4a0267f99b72c6862a58bf59`

The measured worktrees must be clean and match these commits. Guards compare the union of root production TypeScript/WASM files, package.json and build scripts, including additions and deletions. Only compaction.ts may differ between main and either candidate. All generated WASM binaries must match. Source and build guards run again after the study.

Every serial child imports the same canonical temporary `dist/shared.js` path. Before each pilot or measured subject, the parent copies the selected verified dist contents into that one directory, removing the previous contents. Bundles are regular copied files; symlink roots and entries are rejected. The parent and child verify all copied file hashes before and after the subject, and the parent rechecks the source bundle. The common, unchanged package.json is copied above the neutral dist directory to preserve the ES-module context and is also checked around each child.

The selected variant label, role, source checkout path and Git pin stay in parent-side provenance. The child request is allowlisted, and the source-directory environment variables are removed. The child executes the same harness, whose fixed constants list all study pins, but neither the selected provenance nor those constants are inputs to the measurement kernel. The measurement kernel receives only its neutral entry, workload and fixed work/sample counts. Fresh processes avoid reusing a module cache when the neutral directory is replaced. Content-hashed chunk filenames inside the verified bundles remain unchanged; this controls the checkout root and entry URL without rewriting build bytes.

The diagnostic harness has a separately recorded Git head and checksum. Its own commit must not be presented as the source commit of a measured library.

## Four cases only

- `list/number/0`: allocation and empty-snapshot construction floor
- `linked/number/31`
- `doubly/number/32`
- `linked/boolean/32`

The fixture values and complete output checks follow the earlier validated diagnostic. All three libraries receive the same inputs. Numbers include negative zero when the case is nonempty. Every batch's final result and retained source are checked outside the timed region. The source arena copy is checked byte-for-byte at subject completion.

## Predeclared protocol

The job runs Bun 1.4.2 on one Linux ARM64 runner, with no matrix and no per-variant runtime flags. Timing parameters are constants in the harness, not environment overrides.

1. Build all three exact commits with the same installed dependencies and build tools.
2. Run three disposable pilot processes per case and library. Each pilot uses exactly 512 one-call warmup batches, then five batches of 64 compactions.
3. For each library/case, take the median of its three pilot-process medians. Use the fastest of the three library rates to choose one common per-case batch size: round `ceil(20ms / rate)` up to a power of two, capped at 2,048 compactions. Retain all pilots, the calculation and any cap flag.
4. Freeze and hash that work plan. Every subsequent subject for that case, including both A/A roles, uses the same count. Measured subjects do not calibrate or adjust it.
5. Each measured subject runs in a fresh process importing one build from the same neutral entry URL. It makes one pre-warm correctness call, exactly 512 warmup calls and 15 measured batches. There is no time-based warmup exit condition.
6. Run six cycles of three comparisons: main/original, main/narrowed and main/main A/A. All comparisons are interleaved on the same runner. Each case/comparison receives three ABBA and three BAAB quartets. Both orientations occur once at each comparison-order position. Case order also changes between cycles.

This yields 36 disposable pilot processes and 288 measured processes. A quartet contains four fresh processes. It compares the mean of its two A subject medians with the mean of its two B subject medians; the median of six quartet ratios is the summary. All individual timings and quartet ratios remain available. No sample or short batch is discarded.

Full compact, including fresh Arena construction, is timed. Fixture creation, imports, correctness checks, explicit GC and JSON reporting are outside the timed region. Synchronous `Bun.gc(true)` runs after every 32 warmup calls and before every measured or pilot batch. Explicit GC durations are recorded. Automatic GC may still occur within a timed batch and is included in that duration.

The report retains hardware/runtime details, exact source/build hashes, fixed protocol, pilot results, common work counts, warmup counts/durations, GC policy/durations, memory observations, raw batch and per-operation timings, and flags for batches below the 20ms target. Atomic checkpoints retain completed subjects and identify an interrupted or failed subject. A capped or unexpectedly short batch stays flagged; the study does not retry it with a more favorable count.

## What this can distinguish

- If either candidate remains slower than main across balanced quartets while main/main stays near one, the difference is more plausibly candidate-specific under this workload and protocol.
- If the original differs but the narrowed version tracks main, that supports recovery from narrowing in these selected cases. It does not establish recovery in unmeasured cases.
- If the empty-list control also differs, creation/allocation or compiled-code effects deserve attention; this study cannot attribute the result specifically to span copying.
- If candidate comparisons and A/A drift together, or short-batch flags remain material, the data remains inconclusive. It does not justify changing flags or rerunning until a favorable ratio appears.

## Limits and interpretation

One runner is not a population of machines. Shared-runner scheduling, allocator behavior, JIT compilation and automatic GC remain possible sources of variation. Equal warmup calls do not prove that every internal JIT tier reached the same state. Pilot-based counts may be imperfect for later conditions; flags expose this rather than silently retuning. Explicit full GC creates a controlled but application-specific allocation regime.

The numeric and Boolean cases have different shapes and one different size, so this is not a clean experiment isolating value type alone. The empty case includes descriptor and arena creation, not only a native allocation primitive. Import/startup time is excluded. There are no browser, x64, throughput-at-large-size or whole-application claims from this study.

The workflow succeeds when its source, output and protocol checks succeed. It has no wall-clock speed threshold. Publication of a diagnostic artifact is not approval of an optimization, a merge, or a release.

## Run and retain

The workflow `primitive-compaction-focused.yml` builds the three detached worktrees and supplies `FOCUSED_MAIN_DIR`, `FOCUSED_OLD_DIR` and `FOCUSED_NARROW_DIR`. `OUTPUT` selects a new report path. These are path settings only; timing parameters remain fixed.

The pure protocol checks run with `node --test proofs/primitive-compaction-focused.test.mjs`; they use synthetic timings and never import or benchmark a collection. Actual study execution rejects a runtime other than Bun 1.4.2 on Linux ARM64. Preserve this run and any inconclusive result separately from earlier evidence.
