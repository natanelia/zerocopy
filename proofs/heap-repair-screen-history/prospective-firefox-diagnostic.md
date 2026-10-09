# Proposed focused Firefox generator-slot diagnostic

Status: proposal only. No timing, pilot, Firefox launch, browser installation, proof publication, PR edit or merge was performed. The runtime repair is frozen locally at 4cc59aa8b0e68e61e8d53c09d356227f9e793aac (tree 84c0f4135f3292bebf72100588aff432abefea45), parent/public PR25 head 994c0fc3929f64df6303739c79f71d45252350d9. The initial three-contrast proposal is retained in superseded-three-contrast-* and was narrowed before any timing at the parent’s direction. Independent source/protocol review and an implementation of this proposal are still required before any timing authorization.

## Question and fixed scope

Does reusing the dead parent node binding for the right child remove the Firefox empty-next loss while retaining the existing large-consumption gains? Use exactly three immutable arms: historical baseline 3773c6e519c7c0958da13727ed1082f449f3ee25 (tree 10a9555df506cb9d57d7a8ad71e96f8bb947acd2), current PR25 994c0fc3929f64df6303739c79f71d45252350d9 (tree 7eac99fc07b61f7731ec68cede2a2e878432f46e), and the repair above. Runtime/source, bundle, WASM and compiler manifests are in source-build-manifest.json and compiler-manifests.json.

Use only Firefox 155.0, Playwright 1.63.0 Firefox revision 1543, Linux x64, ordinary Playwright headless defaults. No JIT/tiering/GC knobs, custom Firefox preferences, profiler/debugger instrumentation, exposed GC or flags in timed subjects. The controller uses Node 22.23.3. No Chromium, WebKit, ARM or Bun timing belongs in this first causal screen.

Keep the exact retained fdaed105 proof workloads:

- empty-next: new item.entries().next() on the empty queue, including generator creation and first resumption
- number-1057-min: full public consumption of the existing 1,057-entry number fixture
- string-4097-min-ties: full public consumption of the existing 4,097-entry string fixture

The initial delegation mistakenly called the two large workloads “8192”. The parent explicitly corrected this to the audited 1,057-number and 4,097-string cases. No 8,192-entry workload is introduced. Preserve fixture construction, original scan and result sink, shared-memory setup and timed-region boundaries byte-for-byte from the audited helpers.

## Untimed prerequisites and mechanism observations

1. Materialize all three immutable sources, verify tree/per-file digests, use one pinned toolchain, and rebuild WASM, browser JavaScript and declarations separately. Compare each fresh output with the prospective pinned output. Hash and archive exact bytes actually served; method overlays are prohibited.
2. Run the prescribed Bun Vitest suite, all declared type-check targets and the actual built Node worker checks independently for every arm under identical CI conditions. No timing after any failure. Preserve the local aggregate failures: Bun 745/758 passed with 13 five-second timeouts in five files; the extra direct Node suite 749/758 passed with nine raw TypeScript worker module-resolution failures. Neither local aggregate is green, and no local baseline/current full-suite equivalence has been established. Do not increase timeouts, filter tests, substitute a different test command or label historical CI as a new three-arm prerequisite pass.
3. Run actual-bundle semantic fixtures for each of the three workloads and shared/copied worker semantics for each arm (15 fresh correctness browser subjects). Reuse the working fdaed105 transport/lifecycle implementation, including isolated loopback serving, exact worker-count barrier before browser close, and outer process-group cleanup. Require matching output/fixture bytes and state/descriptors, lazy native generator behavior, and expected per-entry view counts. Compare current/repair rows exactly and baseline/repair expected getter reduction.
4. Review actual emitted entries() source and the retained Node 22 V8 observations separately. The baseline/current/repair V8 register counts are 15/16/15; frame bytes 120/128/120; created-before-next register-array bytes 136/144/136; generator objects are 160 bytes throughout. These corroborate a storage mechanism only on V8.
5. Before timing, attempt only an untimed exact-Firefox-build nfixed/nslots inspection if a matching, supported inspection route is available. Bind any shell/debug build to the shipped revision and report its differences. Stock Playwright Firefox has not supplied these measurements here. If exact slot counts remain unavailable, retain null/unmeasured values; independent review must explicitly accept an effect-only diagnostic with the mechanism still a hypothesis. Do not substitute V8 counts or old upstream source for Firefox measurements, or require instrumented flags in timed subjects.

## Actual launched browser provenance

The earlier proof hashed engine.executablePath(); that was insufficient for the actual launched Chromium headless shell and WebKit native distribution. For this Firefox screen, bind the actual launched distribution, not just a launcher path or browser.version():

- Record pinned Playwright/playwright-core package and browsers.json hashes, Firefox revision/version, runtime executable identities, launch options, actual spawned executable/argv and resolved realpath.
- Hash a sorted recursive distribution manifest, including paths, file sizes, modes, symlink targets and file SHA-256s, before subjects and after the lane. Include Firefox native executables and libxul.so, supporting native libraries, application.ini and platform.ini; retain build IDs and version receipts. Resolve symlink targets within the pinned installation and fail if a launched target escapes that verified distribution.
- Have the process supervisor bind the actual browser process tree and /proc executable paths to that manifest before work begins. Retain the observed executable identities for the browser and child processes; where available, bind loaded distribution libraries from process mappings. Missing linkage is an invalid provenance result, not a substitute path checksum.
- No runtime install/update between subjects. Source, served-byte and distribution manifests must stay unchanged, and browser/worker/process-group closure must be observed for every subject.

The diagnostic implementation must make these records before timing and fail closed on an identity mismatch. An independent review should verify this launched-distribution path, along with source/transport, before publication or dispatch.

## Prospective experiment and stopping rule

Use the original four balanced AB quartets and four matched AA quartets per pair/case, 21 batches per subject, seed 20261008, confidence 95%, df=3, t=3.182446305284263, loss margin 1.02 and gain threshold 0.98. Every subject gets a fresh supervised Node child, fresh Firefox process, page and neutral source directory. No coexistence, bundle hot-swap or repeated measurement within a reused browser. Timed subjects contain exactly one prescribed cell.

Two direct pairwise contrasts for every workload:

- repair/baseline, with independent matched baseline/baseline AA
- repair/current, with independent matched current/current AA

This is six paired cells, 48 quartets, 192 measured browser subjects and 4,032 retained measured batches. Nine calibration-pilot browser subjects (one per immutable arm/case) plus 15 correctness subjects give 216 total planned browser launches, before build/check commands. Generate and hash a deterministic balanced schedule before pilots. Pilot order is balanced across three arms. No subject/cell/source spelling may be selected after seeing times.

For each case, retain all three pilots and freeze one common repeat and warmup count across both contrasts, taking the maximum required repeat and the fastest observed pilot per-iteration time. Use the audited rule: warmupScans = ceil((500 ms × 1.25 / fastestPilotMsPerIteration) / repeat) × repeat. Original batch target 40 ms, batch floor 10 ms, warmup target 500 ms, warmup floor 150 ms, pilot warmup limit 10,000 ms and repeat limit 10,000,000 remain fixed. If the three-arm adaptation cannot meet a floor within these bounds, retain the failure and stop; do not trim slow or fast arms or choose new budgets. Warmup counts and timed work must match exactly for every pair.

Retain the working per-process timeouts and teardown limits: browser subject 240,000 ms; launch/close/worker-close 30,000 ms each; correctness 90,000 ms; no retries. Prospectively allow a 60-minute total lane budget because there are twice as many measured subjects as the original single Firefox lane; expiration produces incomplete evidence without replacement. Full prerequisites have their own fixed reviewed budget, and cannot consume measured warmup budget.

Use the original estimator: median of each process's 21 batches divided by common repeat; adjacent right/left log ratios; mean of two pair effects per quartet; four quartet effects form the pointwise Student-t interval. Preserve the AA rule: invalidate the paired cell only when AA's point estimate lies outside [1/1.02, 1.02] and its interval excludes 1. AA is a validity diagnostic, never a denominator adjustment; report wide AA intervals and do not claim AA equivalence. No cross-case pooling, outlier deletion, extra quartet, timing-selected source revision, rerun or replacement attempt.

Both direct contrasts and all failure records are mandatory. A valid repair/baseline upper interval <=1.02 for all three cases, with established retained large gains (upper <0.98 for both large cases), is the minimum positive selected-case effect result. The empty repair/current interval tests whether the repair improves the current arm; an upper bound <1 establishes an improvement, and <0.98 establishes a material gain under the fixed threshold. The historical current/baseline result is already audited and is not rerun as a bridge. These two direct comparisons answer the fixed repair question without claiming contemporaneous replication of that historical effect. A material loss, invalid control, missing cell or interval crossing the required boundary stays a hold/inconclusive result.

The historical 2.8264% empty-next regression is never edited or replaced. A positive screen supports review of this single repair only. It does not clear PR25's other unresolved controls or broader platform integration. Keep public PR ready state and body unchanged until separately authorized. Stop after this one frozen attempt regardless of outcome.
