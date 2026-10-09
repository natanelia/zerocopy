# Heap repair screen: Vitest results-cache audit
Completed 2026-10-09. This audit reads the installed implementation in `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules`, the repository config, and the existing shared cache. It does not import/run Vitest, run repository tests, launch browsers, or modify shared dependencies/cache. The separately requested helper tests use Node's built-in test runner against temporary fake dependency/arm directories.
## Finding
The installed Vitest is exactly 4.1.11. Its normalized cache directory is `resolve(root, cacheDir, "vitest", sha1(projectName || ""))`. This repository sets `cacheDir: "node_modules/.vite"`, has no test project name, and uses the default `BaseSequencer`. The resulting file is `node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`.
The folder hash does not contain the source revision, arm name, source-root path, or test content. Root only affects the filesystem location. When separate roots symlink their entire `node_modules` to the same directory, both roots reach the same physical cache. Results map keys are `${projectName}:${relative(root, testPath)}`; therefore the same root-level test has the same key in each unnamed arm, such as `:workers.test.ts`. Earlier arm results can change later arm scheduling.
BaseSequencer first sorts by group order, project name and isolation. For two tests with cached results it then puts failures first and otherwise longer prior durations first. If either result is absent, it uses file stat size, larger first, with unknown stat entries first. An empty results map therefore removes inherited failure/duration influence; it preserves Vitest's existing file-size ordering, discovery tie order, and concurrency. It does not promise deterministic worker completion order.
At startup Vitest reads this cache before resolving projects. At the end of a run it updates file results and writes the whole map back. Read/write errors are caught by Vitest, making an external exact-byte prerequisite guard valuable. Disk results cannot simply be cleared after process startup because Vitest already loaded them into memory.
## Existing shared-cache snapshot (read only)
- Absolute/physical file: `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`
- Version: `4.1.11`
- Bytes: 5198
- SHA-256: `eaceab50ee8705c52a08d9378bfe068e843c7d4cd36355c62d0b9002758ac2b5`
- mtime UTC: 2026-10-09T06:01:37.404309+00:00
- Result entries: 68
- Failed entries: [[":workers.test.ts", {"duration": 4482.845508000002, "failed": true}]]
This was also observed at 06:04 UTC with the same 5,198 bytes and SHA-256. The presence of mixed root-level and `.proof-baseline/` entries proves the shared file contains historical state; the snapshot alone cannot attribute any individual duration or failure to an exact prior run. No historical result is reclassified based on this finding.
Exact cache bytes (the fence adds presentation newlines, which are not part of the 5,198-byte file):

```json
{"version":"4.1.11","results":[[":immutable-proof.test.ts",{"duration":1874.5786260000004,"failed":false}],[":worker.test.ts",{"duration":435.29415400000005,"failed":false}],[":workers.test.ts",{"duration":4482.845508000002,"failed":true}],[":utf8-write.test.ts",{"duration":17277.922138,"failed":false}],[":redux.test.ts",{"duration":308.89262000000235,"failed":false}],[":typed-values.test.ts",{"duration":13035.216335,"failed":false}],[":redux-rtk.test.ts",{"duration":310.1864199999982,"failed":false}],[":nested.test.ts",{"duration":35.10670200000095,"failed":false}],[":redux-checkpoint.test.ts",{"duration":27560.040761,"failed":false}],[":shared-doubly-linked-list.test.ts",{"duration":78.76660099999935,"failed":false}],[":performance-revision.test.ts",{"duration":18195.989369,"failed":false}],[":map-set-path.test.ts",{"duration":1303.7810390000013,"failed":false}],[":map-memory.test.ts",{"duration":2326.449979000001,"failed":false}],[":map-set-index.test.ts",{"duration":2995.2133999999987,"failed":false}],[":shared-linked-list.test.ts",{"duration":41.29121200000009,"failed":false}],[":hot-path.test.ts",{"duration":1505.7676729999985,"failed":false}],[":tanstack-db-collection.test.ts",{"duration":16.574649999998655,"failed":false}],[":shared-queue.test.ts",{"duration":46.84914199999912,"failed":false}],[":shared-stack.test.ts",{"duration":84.9918370000014,"failed":false}],[":shared-priority-queue.test.ts",{"duration":25.93890100000135,"failed":false}],[":shared-list.test.ts",{"duration":55.36700799999744,"failed":false}],[":redux-regression.test.ts",{"duration":41.414261999998416,"failed":false}],[":descriptor-validation.test.ts",{"duration":308.476627,"failed":false}],[":map-set-utf8.test.ts",{"duration":94.41877899999963,"failed":false}],[":numeric-spatial.test.ts",{"duration":5243.5877470000005,"failed":false}],[":typed-json-redux.test.ts",{"duration":22.61863000000085,"failed":false}],[":numeric.test.ts",{"duration":1843.2152569999998,"failed":false}],[":shared-map.test.ts",{"duration":27.774256000000605,"failed":false}],[":redux-jsan.test.ts",{"duration":16.947752000000037,"failed":false}],[":worker-tasks.test.ts",{"duration":125.9487509999999,"failed":false}],[":shared-sorted.test.ts",{"duration":27.003625000001193,"failed":false}],[":shared-set.test.ts",{"duration":52.001172000000224,"failed":false}],[":worker-records.test.ts",{"duration":29.658557999999175,"failed":false}],[":geometry.test.ts",{"duration":3326.9645759999994,"failed":false}],[":ordered-empty-regression.test.ts",{"duration":3.597249999998894,"failed":false}],[":redux-wide-json.test.ts",{"duration":3407.2701469999993,"failed":false}],[":core-word-copy.test.ts",{"duration":1897.7940230000022,"failed":false}],[":core-key-compare.test.ts",{"duration":468.03279899999995,"failed":false}],[":map-projection.test.ts",{"duration":1475.614365,"failed":false}],[":core-link-range.test.ts",{"duration":7270.189113999993,"failed":false}],[":freeze-json.test.ts",{"duration":847.8073100000001,"failed":false}],[":json-read-cache.test.ts",{"duration":420.44671000000017,"failed":false}],[":map-entry-scans.test.ts",{"duration":2039.2459690000105,"failed":false}],[":utf8-key.test.ts",{"duration":1573.7468219999996,"failed":false}],[":primitive-compaction.test.ts",{"duration":17513.60684,"failed":false}],[":worker-attachment.test.ts",{"duration":3667.173798,"failed":false}],[":primitive-sequence-scan.test.ts",{"duration":759.7123520000023,"failed":false}],[":primitive-scan-portability.test.ts",{"duration":152.6222540000017,"failed":false}],[":trie-iterator-setup.test.ts",{"duration":1927.1398210000002,"failed":false}],[":.proof-baseline/immutable-proof.test.ts",{"duration":8185.173905000001,"failed":false}],[":.proof-baseline/performance-revision.test.ts",{"duration":76147.97199199999,"failed":false}],[":.proof-baseline/map-set-path.test.ts",{"duration":7702.610174000001,"failed":false}],[":.proof-baseline/map-set-index.test.ts",{"duration":4501.669173000002,"failed":false}],[":.proof-baseline/hot-path.test.ts",{"duration":1602.932488999999,"failed":false}],[":.proof-baseline/map-set-utf8.test.ts",{"duration":357.9194140000036,"failed":false}],[":.proof-baseline/shared-map.test.ts",{"duration":23.30645299999742,"failed":false}],[":.proof-baseline/shared-set.test.ts",{"duration":68.67955899998196,"failed":false}],[":ordered-churn.test.ts",{"duration":8042.739566,"failed":false}],[":compaction-pointer-cache.test.ts",{"duration":3374.3826280000003,"failed":false}],[":block-traversal-view.test.ts",{"duration":1824.490629,"failed":false}],[":shared-list-noop-set.test.ts",{"duration":973.8705740000005,"failed":false}],[":trie-view-capture.test.ts",{"duration":6685.758794000001,"failed":false}],[":heap-entry-views.test.ts",{"duration":145.6468739999982,"failed":false}],[":shared-priority-queue-insert.test.ts",{"duration":2504.6934829999996,"failed":false}],[":cached-object-read.test.ts",{"duration":978.3589800000001,"failed":false}],[":radix-empty-delegation.test.ts",{"duration":101.83715799999482,"failed":false}],[":block-rotation.test.ts",{"duration":1675.73423,"failed":false}],[":radix-helper-review.test.ts",{"duration":11.018719000000146,"failed":false}]]}
```
## Prospective integration
Use a fresh task-owned real `node_modules` directory in each prerequisite arm, with top-level package/scope and `.bin` symlinks into the existing installed dependencies. Keep `.vite` physically inside that arm. This preserves repository config bytes, package test command, compiler/test implementation bytes, test assertions, timeouts, worker count, fileParallelism and isolation. It avoids replacing or deleting the shared cache and avoids changing project names (which itself influences sort order).
Each arm starts with task-generated UTF-8 bytes exactly as follows, without a trailing LF:

```json
{"version":"4.1.11","results":[]}
```
- Bytes: 33
- SHA-256: `c5cccc1249cd01f91863c9163b69695d817f7039eb87d55989699edf9976ad13`
- Per-arm destination: `<arm>/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`
An empty string, `[]`, or `{}` is not an equivalent seed: the reader destructures `version` and calls `version.split(".")`. The chosen seed matches Vitest's own serialization structure while containing no inherited observations. Do not copy the old shared file into the arm. Do not use `--cache.dir`: this exact CLI throws `--cache.dir is deprecated`. Disabling cache also changes the cache policy and yields no retained seeded file, so it is unnecessary here.
Integration API, implemented in the new worktree:

1. Create `<arm>/node_modules` as a real directory (not a symlink).
2. Call `prepareCache(root, sharedNodeModules, freshReceiptDirectory)` once. It requires the exact installed source/config hashes, makes package symlinks, archives the shared cache read-only, retains audited source bytes and config, and exclusively creates the arm-local seed. Save its returned receipt.
3. Immediately before launching the unchanged ordinary package test command, call `verifyCacheStart(root, receipt)`. It rereads the exact seed bytes, config/source pins, dependency links and real cache ancestry. Do not start the command on rejection.
4. After the command terminates, call `archiveCacheEnd(root, receiptDirectory)` in `finally` to retain cache output on success/failure/timeout. It archives even invalid JSON or an absent file, without resetting cache state. Persist its returned result with command evidence.
5. If the test command needs a new attempt, make another fresh arm/receipt. Never clear or reseed the already-run arm to erase its history. Each baseline/candidate invocation gets its own identical initial seed.
All writes are exclusive; existing cache results or evidence fail closed. A node_modules or cache-ancestor symlink is rejected. Shared dependency contents are only read and linked, never written. The helper does not provide filesystem sandbox enforcement against unrelated package scripts; this audit establishes Vitest results-cache behavior and uses source/path guards to keep its own mutations local.
Prepared receipt artifacts are `prepare.json`, `fresh-results.json`, `repository-vitest.config.ts`, `installed-source/<audited Vitest path>`, and `shared-results-before.json` if present. Final receipt artifacts are `end.json` and `results-after.json` if present. Retain them with the prerequisite logs.
## Implementation and verification
Owned implementation files:
- `/workspace/scratch/e7ec22ef2609/zerocopy-heap-repair-screen-20261009/proofs/heap-repair-screen-cache.mjs` (11502 bytes; SHA-256 `d1db9e3258e32116219c3f2647ad8f6906c9b697e36bf4e412e28813f02d43a4`)
- `/workspace/scratch/e7ec22ef2609/zerocopy-heap-repair-screen-20261009/proofs/heap-repair-screen-cache-tests.mjs` (7393 bytes; SHA-256 `d4efccf328c7109144a56059defadff5801ae635e38935da70ffdc918d92afd7`)

Verification command:

```sh
HEAP_REPAIR_CACHE_TEST_DEPENDENCIES=/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules node --test proofs/heap-repair-screen-cache-tests.mjs
```
8/8 Node tests passed, no failures/skips. Coverage includes equal seeds across arms, package overlay links, shared-cache preservation, node_modules/.vite symlink rejection, refusal to overwrite previous results/evidence, installed-source/config drift, altered seed/receipt rejection, and post-run preservation of normal, invalid and missing results. The source fixtures are copied read-only from installed files; test mutations remain in temporary fixture directories. No actual Vitest or browser execution occurred.
## Pinned source files
- `/workspace/scratch/e7ec22ef2609/zerocopy-perf/vitest.config.ts`: 557 bytes, SHA-256 `6bae9f4e513173dec6c089c4fcaf3957c5cb9aa3195173f1d5ace6a60140a489`
- `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules/vitest/package.json`: 5932 bytes, SHA-256 `a28126d97bcaf567da5bed69443b7f3bcd9a7a8c38c8b66e554686b6bb2c10e0`
- `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js`: 498779 bytes, SHA-256 `a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e`
- `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js`: 54974 bytes, SHA-256 `e509f3cc1bd81ae6426265253fa926cbde02be5cebfe35b1df422017bffdca31`
- `/workspace/scratch/e7ec22ef2609/zerocopy-perf/node_modules/vitest/dist/chunks/cac.uFydS1Z4.js`: 96007 bytes, SHA-256 `27cc9365d180bee3da005fe6c4d485868caf9d8f54280759eea28842836af549`

## Exact installed-source excerpts

Each excerpt digest is SHA-256 of the raw original UTF-8 source bytes from the inclusive line range, including the original line terminators. The numbered display below adds line labels.

### Repository configuration

`vitest.config.ts:1-19`; excerpt SHA-256 `6bae9f4e513173dec6c089c4fcaf3957c5cb9aa3195173f1d5ace6a60140a489`.

```text
    1 import { defineConfig } from 'vitest/config';
    2
    3 export default defineConfig({
    4   cacheDir: 'node_modules/.vite',
    5   test: {
    6     bundler: 'rolldown',
    7     pool: 'threads',
    8     isolate: false,
    9     fileParallelism: true,
   10     globals: true,
   11     testTimeout: 5000,
   12     teardownTimeout: 1000,
   13     minWorkers: 1,
   14     maxWorkers: 4,
   15     // The website uses node:test against a generated site, in its own CI job.
   16     // Do not discover those suites before the site's build dependencies exist.
   17     exclude: ['**/node_modules/**', '**/demo/**', '**/website/**'],
   18   },
   19 });
```

### Installed version

`node_modules/vitest/package.json:1-8`; excerpt SHA-256 `6fac9d89d5891f0335159d32d7dff02e0c2abefb3d34621073cd723b56853db6`.

```text
    1 {
    2   "name": "vitest",
    3   "type": "module",
    4   "version": "4.1.11",
    5   "description": "Next generation testing framework powered by Vite",
    6   "author": "Anthony Fu <anthonyfu117@hotmail.com>",
    7   "license": "MIT",
    8   "funding": "https://opencollective.com/vitest",
```

### Stat-cache keys and complete results-cache implementation

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:493-609`; excerpt SHA-256 `b4f1dae5deaeb446fedf086dd89343602b25e1be6d90fbaaaf720348a53bfcc1`.

```text
  493 class FilesStatsCache {
  494 	cache = /* @__PURE__ */ new Map();
  495 	getStats(key) {
  496 		return this.cache.get(key);
  497 	}
  498 	async populateStats(root, specs) {
  499 		const promises = specs.map((spec) => {
  500 			const key = `${spec.project.name}:${relative(root, spec.moduleId)}`;
  501 			return this.updateStats(spec.moduleId, key);
  502 		});
  503 		await Promise.all(promises);
  504 	}
  505 	async updateStats(fsPath, key) {
  506 		if (!fs.existsSync(fsPath)) return;
  507 		const stats = await fs.promises.stat(fsPath);
  508 		this.cache.set(key, { size: stats.size });
  509 	}
  510 	removeStats(fsPath) {
  511 		this.cache.forEach((_, key) => {
  512 			if (key.endsWith(fsPath)) this.cache.delete(key);
  513 		});
  514 	}
  515 }
  516
  517 class ResultsCache {
  518 	cache = /* @__PURE__ */ new Map();
  519 	workspacesKeyMap = /* @__PURE__ */ new Map();
  520 	cachePath = null;
  521 	version;
  522 	root = "/";
  523 	constructor(logger) {
  524 		this.logger = logger;
  525 		this.version = Vitest.version;
  526 	}
  527 	getCachePath() {
  528 		return this.cachePath;
  529 	}
  530 	setConfig(root, config) {
  531 		this.root = root;
  532 		if (config) this.cachePath = resolve(config.dir, "results.json");
  533 	}
  534 	getResults(key) {
  535 		return this.cache.get(key);
  536 	}
  537 	async clearCache() {
  538 		if (this.cachePath && existsSync(this.cachePath)) {
  539 			await rm(this.cachePath, {
  540 				force: true,
  541 				recursive: true
  542 			});
  543 			this.logger.log("[cache] cleared results cache at", this.cachePath);
  544 		}
  545 	}
  546 	async readFromCache() {
  547 		if (!this.cachePath) return;
  548 		if (!fs.existsSync(this.cachePath)) return;
  549 		const resultsCache = await fs.promises.readFile(this.cachePath, "utf8");
  550 		const { results, version } = JSON.parse(resultsCache || "[]");
  551 		const [major, minor] = version.split(".");
  552 		// handling changed in 0.30.0
  553 		if (major > 0 || Number(minor) >= 30) {
  554 			this.cache = new Map(results);
  555 			this.version = version;
  556 			results.forEach(([spec]) => {
  557 				const [projectName, relativePath] = spec.split(":");
  558 				const keyMap = this.workspacesKeyMap.get(relativePath) || [];
  559 				keyMap.push(projectName);
  560 				this.workspacesKeyMap.set(relativePath, keyMap);
  561 			});
  562 		}
  563 	}
  564 	updateResults(files) {
  565 		files.forEach((file) => {
  566 			const result = file.result;
  567 			if (!result) return;
  568 			const duration = result.duration || 0;
  569 			// store as relative, so cache would be the same in CI and locally
  570 			const relativePath = relative(this.root, file.filepath);
  571 			this.cache.set(`${file.projectName || ""}:${relativePath}`, {
  572 				duration: duration >= 0 ? duration : 0,
  573 				failed: result.state === "fail"
  574 			});
  575 		});
  576 	}
  577 	removeFromCache(filepath) {
  578 		this.cache.forEach((_, key) => {
  579 			if (key.endsWith(filepath)) this.cache.delete(key);
  580 		});
  581 	}
  582 	async writeToCache() {
  583 		if (!this.cachePath) return;
  584 		const results = Array.from(this.cache.entries());
  585 		const cacheDirname = dirname(this.cachePath);
  586 		if (!fs.existsSync(cacheDirname)) await fs.promises.mkdir(cacheDirname, { recursive: true });
  587 		const cache = JSON.stringify({
  588 			version: this.version,
  589 			results
  590 		});
  591 		await fs.promises.writeFile(this.cachePath, cache);
  592 	}
  593 }
  594
  595 class VitestCache {
  596 	results;
  597 	stats = new FilesStatsCache();
  598 	constructor(logger) {
  599 		this.results = new ResultsCache(logger);
  600 	}
  601 	getFileTestResults(key) {
  602 		return this.results.getResults(key);
  603 	}
  604 	getFileStats(key) {
  605 		return this.stats.getStats(key);
  606 	}
  607 	static resolveCacheDir(root, dir, projectName) {
  608 		return resolve(root, slash(dir || "node_modules/.vite"), "vitest", hash("sha1", projectName || "", "hex"));
  609 	}
```

### Default sequencer reads historical failures/durations

`node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:29-77`; excerpt SHA-256 `891699f95971af2d8c233ecd97edd255e839b763580a12d87a1c71cc8cb51665`.

```text
   29 class BaseSequencer {
   30 	ctx;
   31 	constructor(ctx) {
   32 		this.ctx = ctx;
   33 	}
   34 	// async so it can be extended by other sequencers
   35 	async shard(files) {
   36 		const { config } = this.ctx;
   37 		const { index, count } = config.shard;
   38 		const [shardStart, shardEnd] = this.calculateShardRange(files.length, index, count);
   39 		return [...files].map((spec) => {
   40 			const specPath = resolve(slash(config.root), slash(spec.moduleId))?.slice(config.root.length);
   41 			return {
   42 				spec,
   43 				hash: hash("sha1", specPath, "hex")
   44 			};
   45 		}).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0).slice(shardStart, shardEnd).map(({ spec }) => spec);
   46 	}
   47 	// async so it can be extended by other sequencers
   48 	async sort(files) {
   49 		const cache = this.ctx.cache;
   50 		return [...files].sort((a, b) => {
   51 			// "sequence.groupOrder" is higher priority
   52 			const groupOrderDiff = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
   53 			if (groupOrderDiff !== 0) return groupOrderDiff;
   54 			// Projects run sequential
   55 			if (a.project.name !== b.project.name) return a.project.name < b.project.name ? -1 : 1;
   56 			// Isolated run first
   57 			if (a.project.config.isolate && !b.project.config.isolate) return -1;
   58 			if (!a.project.config.isolate && b.project.config.isolate) return 1;
   59 			const keyA = `${a.project.name}:${relative(this.ctx.config.root, a.moduleId)}`;
   60 			const keyB = `${b.project.name}:${relative(this.ctx.config.root, b.moduleId)}`;
   61 			const aState = cache.getFileTestResults(keyA);
   62 			const bState = cache.getFileTestResults(keyB);
   63 			if (!aState || !bState) {
   64 				const statsA = cache.getFileStats(keyA);
   65 				const statsB = cache.getFileStats(keyB);
   66 				// run unknown first
   67 				if (!statsA || !statsB) return !statsA && statsB ? -1 : !statsB && statsA ? 1 : 0;
   68 				// run larger files first
   69 				return statsB.size - statsA.size;
   70 			}
   71 			// run failed first
   72 			if (aState.failed && !bState.failed) return -1;
   73 			if (!aState.failed && bState.failed) return 1;
   74 			// run longer first
   75 			return bState.duration - aState.duration;
   76 		});
   77 	}
```

### Vite cache directory normalization

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:10082-10095`; excerpt SHA-256 `3fa0828827737de96d4ca44bd0bd88f11ec55122f6298d9c15172b06e189c236`.

```text
10082 function VitestOptimizer() {
10083 	return {
10084 		name: "vitest:normalize-optimizer",
10085 		config: {
10086 			order: "post",
10087 			handler(viteConfig) {
10088 				const testConfig = viteConfig.test || {};
10089 				const root = resolve(viteConfig.root || process.cwd());
10090 				const name = viteConfig.test?.name;
10091 				const label = typeof name === "string" ? name : name?.label || "";
10092 				viteConfig.cacheDir = VitestCache.resolveCacheDir(resolve(root || process.cwd()), testConfig.cache != null && testConfig.cache !== false ? testConfig.cache.dir : viteConfig.cacheDir, label);
10093 			}
10094 		}
10095 	};
```

### Config resolves cache and default sequencer

`node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:465-478`; excerpt SHA-256 `8ff4392d4b8374186d4dda1ba6952b1d22d1d5ecf263017ede60728dbfa675f4`.

```text
  465 	if (resolved.cache !== false) {
  466 		if (resolved.cache && typeof resolved.cache.dir === "string") vitest.logger.deprecate(`"cache.dir" is deprecated, use Vite's "cacheDir" instead if you want to change the cache director. Note caches will be written to "cacheDir\/vitest"`);
  467 		resolved.cache = { dir: viteConfig.cacheDir };
  468 	}
  469 	resolved.sequence ??= {};
  470 	if (resolved.sequence.shuffle && typeof resolved.sequence.shuffle === "object") {
  471 		const { files, tests } = resolved.sequence.shuffle;
  472 		resolved.sequence.sequencer ??= files ? RandomSequencer : BaseSequencer;
  473 		resolved.sequence.shuffle = tests;
  474 	}
  475 	if (!resolved.sequence?.sequencer)
  476  // CLI flag has higher priority
  477 	resolved.sequence.sequencer = resolved.sequence.shuffle ? RandomSequencer : BaseSequencer;
  478 	resolved.sequence.groupOrder ??= 0;
```

### Startup reads results into memory

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:13213-13217`; excerpt SHA-256 `6105e73cdba792b3951af92275bf63da3927bc8f12a11fa5f6e1d6db469840ee`.

```text
13213 		this.cache.results.setConfig(resolved.root, resolved.cache);
13214 		try {
13215 			await this.cache.results.readFromCache();
13216 		} catch {}
13217 		const projects = await this.resolveProjects(this._cliOptions);
```

### Stats populated before execution

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:13543-13546`; excerpt SHA-256 `20dc350cf9e8ca0b5718497103b7b5291287d347a7ca7733f089b8c996cac271`.

```text
13543 			if (specifications.length) {
13544 				// populate once, update cache on watch
13545 				await this.cache.stats.populateStats(this.config.root, specifications);
13546 				testModules = await this.runFiles(specifications, true);
```

### Sequencer invoked before grouping

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:3681-3695`; excerpt SHA-256 `5dea074d546245b2c2f2b5a8aa702186d58c1421041e426cc846f945a7fa8543`.

```text
 3681 	const options = resolveOptions(ctx);
 3682 	const Sequencer = ctx.config.sequence.sequencer;
 3683 	const sequencer = new Sequencer(ctx);
 3684 	let browserPool;
 3685 	async function executeTests(method, specs, invalidates) {
 3686 		ctx.onCancel(() => pool.cancel());
 3687 		if (ctx.config.shard) {
 3688 			if (!ctx.config.passWithNoTests && ctx.config.shard.count > specs.length) throw new Error(`--shard <count> must be a smaller than count of test files. Resolved ${specs.length} test files for --shard=${ctx.config.shard.index}/${ctx.config.shard.count}.`);
 3689 			specs = await sequencer.shard(Array.from(specs));
 3690 		}
 3691 		const taskGroups = [];
 3692 		let workerId = 0;
 3693 		const sorted = await sequencer.sort(specs);
 3694 		const { environments, tags } = await getSpecificationsOptions(specs);
 3695 		const groups = groupSpecs(sorted, environments);
```

### End of run updates and writes results

`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:13661-13665`; excerpt SHA-256 `ba4270d13bbee4d12da18fc2324619e3e7fab25312561c5f0d08a454f4601dfe`.

```text
13661 					const files = this.state.getFiles();
13662 					this.cache.results.updateResults(files);
13663 					try {
13664 						await this.cache.results.writeToCache();
13665 					} catch {}
```

### Deprecated CLI cache.dir is rejected

`node_modules/vitest/dist/chunks/cac.uFydS1Z4.js:1127-1137`; excerpt SHA-256 `edde393d87dbf2dba860b422440ae437ddf164e2865efa3a31a23a648481d579`.

```text
 1127 	cache: {
 1128 		description: "Enable cache",
 1129 		argument: "",
 1130 		subcommands: { dir: null },
 1131 		default: true,
 1132 		transform(cache) {
 1133 			if (typeof cache !== "boolean" && cache) throw new Error("--cache.dir is deprecated");
 1134 			if (cache) return {};
 1135 			return cache;
 1136 		}
 1137 	},
```
