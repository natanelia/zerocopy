/** Instrumented diagnostic queries only; never use output in an A/B comparison. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  assert.ok(process.argv[i].startsWith('--'), `Unexpected argument: ${process.argv[i]}`);
  const name = process.argv[i].slice(2); args[name] = process.argv[++i];
}
for (const name of ['repo', 'harness', 'fixtures', 'out']) assert.equal(typeof args[name], 'string', `Missing --${name}`);
const repo = resolve(args.repo), harness = resolve(args.harness), fixtures = resolve(args.fixtures), output = resolve(args.out);
assert.ok(!existsSync(output), 'Output exists; keep historical profiling evidence');
const iterations = Number(args.iterations ?? 4);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 64, 'Invalid --iterations');
const hash = value => createHash('sha256').update(value).digest('hex');
const importAt = (root, name) => import(pathToFileURL(resolve(root, name)).href);
const manifest = JSON.parse(readFileSync(resolve(repo, 'profile-manifest.json'), 'utf8'));
assert.equal(manifest.schema, 'zerocopy-get-stage-profile-source/v1');
assert.equal(manifest.build.success, true, 'Build the diagnostic source copy first');
for (const [file, expected] of Object.entries(manifest.build.sha256)) assert.equal(hash(readFileSync(resolve(repo, 'dist', file))), expected, `Diagnostic build changed: ${file}`);
for (const [file, expected] of Object.entries(manifest.source.sha256)) {
  const instrumented = manifest.instrumentation.sha256[file];
  assert.equal(hash(readFileSync(resolve(repo, file))), instrumented ?? expected, `Diagnostic source changed after build: ${file}`);
}
for (const [file, expected] of Object.entries(manifest.instrumentation.sha256)) assert.equal(hash(readFileSync(resolve(repo, file))), expected, `Instrumentation source changed after build: ${file}`);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harness, encoding: 'utf8' }).trim(), manifest.harness.commit, 'Pinned harness checkout moved');
for (const [file, expected] of Object.entries(manifest.harness.sha256)) assert.equal(hash(readFileSync(resolve(harness, 'website/assets', file))), expected, `Pinned harness changed: ${file}`);
const { CASES, FIXTURE_VERSION, makeFixture, expectedPlain } = await importAt(fixtures, 'fixtures.mjs');
const { exact, buildOwner, verifyPlainCapture } = await importAt(fixtures, 'study-core.mjs');
const requested = new Set((args.cases ?? 'catalog-full-get,catalog-legacy-lookup,catalog-legacy-validate,map-shallow,list-shallow,map-deep,list-deep,map-coordinates,list-coordinates,map-entries-above,list-entries-above,map-bytes-above,list-bytes-above').split(','));
assert.ok([...requested].every(id => CASES.some(definition => definition.id === id)), 'Unknown --cases value');
const selected = CASES.filter(definition => requested.has(definition.id));
const [catalog, reads, reference, legacyReference, api] = await Promise.all([
  importAt(harness, 'website/assets/catalog-core.mjs'), importAt(harness, 'website/assets/catalog-read-workloads.mjs'),
  importAt(harness, 'website/assets/catalog-read-reference.mjs'), importAt(harness, 'website/assets/catalog-reference.mjs'),
  importAt(repo, 'dist/shared.js'),
]);
const profiler = globalThis[Symbol.for('zerocopy.get.profile.v1')];
assert.ok(profiler?.begin && profiler?.stop, 'Instrumented bundle did not register diagnostic counters');
const result = {
  schema: 'zerocopy-get-stage-profile/v1', diagnosticOnly: true, status: 'running', startedAt: new Date().toISOString(),
  manifest, runtime: { name: globalThis.Bun ? 'Bun' : 'Node', version: globalThis.Bun?.version ?? process.version, versions: process.versions, platform: process.platform, arch: process.arch },
  fixtures: { directory: fixtures, version: FIXTURE_VERSION, sha256: Object.fromEntries(['fixtures.mjs', 'study-core.mjs'].map(name => [name, hash(readFileSync(resolve(fixtures, name)))])) },
  config: { iterations, caseIds: selected.map(item => item.id), warmups: 0, reads: 'First and immediate repeat on each newly attached reader; constructors/attachment and all validation excluded from instrument counters. Pre-query byte-canary hashing touches payload bytes and can warm CPU caches; no collection decoding occurs.' },
  stageAttribution: {
    timerMeaning: 'Every named stage reports inclusive time; child stages overlap their parents. No exclusive/uninstrumented cost is inferred.',
    coverage: 'Named stages do not cover every operation. Unlisted type dispatch, branches, view/header work, result assembly, legacy fingerprinting and instrumentation overhead remain within the query/API totals.',
    parents: {
      'arena.valueDispatchInclusive': 'api.SharedMap.get',
      'map.readObject': 'arena.valueDispatchInclusive',
      'lookup.findUncached': 'map.readObject or lookup.findWithLeafCache',
      'lookup.keyHashAndEncoding': 'lookup.findUncached',
      'lookup.prefixAndWasmCandidate': 'lookup.findUncached',
      'lookup.fullKeyVerification': 'lookup.findUncached',
      'map.objectHeader': 'map.readObject',
      'arena.leafValueInclusive': 'map.readObject or arena.valueDispatchInclusive',
      'arena.decode': 'api.SharedList.get',
      'arena.decodeAt': 'arena.leafValueInclusive or arena.decode',
      'json.utf8AndSubview': 'arena.decodeAt',
      'utf8.totalInclusive': 'json.utf8AndSubview or other string read paths',
      'utf8.sharedFallback': 'utf8.totalInclusive',
      'utf8.independentCopy': 'utf8.sharedFallback',
      'utf8.scratchCopy': 'utf8.sharedFallback',
      'utf8.decoderCallInclusive': 'utf8.sharedFallback or utf8.totalInclusive; overridden decoder fallback may include its required defensive input copy',
      'json.nativeParse': 'arena.decodeAt',
      'json.descriptor': 'arena.decodeAt',
      'json.nestedFactory': 'arena.decodeAt',
      'freeze.traversalInclusive': 'arena.decodeAt for JSON values',
      'freeze.nativeObjectFreeze': 'freeze.traversalInclusive',
      'freeze.objectValues': 'freeze.traversalInclusive',
      'memory.refresh': 'context dependent; appears in several parent stages',
    },
  },
  warnings: [
    'This is a source-instrumented diagnostic build, not benchmark speedup evidence. Do not combine its times with uninstrumented samples.',
    'Named stages overlap and report inclusive time. Do not sum them or subtract unrelated medians to infer an exclusive stage cost.',
    'Per-call timestamps, counter dictionaries, local variables and try/finally blocks alter optimization and allocation. Counts are more reliable than tiny stage durations.',
    'The first and repeat results are retained and checked only after both measurements. The readers start with empty decoded-value caches; compiled code may already be warm.',
    'Each sample is a local synchronous query with no worker request/reply messaging. Website fixture/query functions are reused exactly for catalog cases.',
  ],
  rows: [], failures: [],
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
function save() { writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
function capture(run) {
  profiler.begin();
  const started = performance.now();
  let value, failure;
  try { value = run(); } catch (error) { failure = error; }
  const instrumentedQueryMs = performance.now() - started;
  const profile = profiler.stop();
  if (failure) { failure.profile = { instrumentedQueryMs, ...profile }; throw failure; }
  return { value, instrumentedQueryMs, ...profile };
}
function frozenCount(answer, definition) {
  const pending = definition.workload === 'full-object-get' ? answer.rows.map(row => row.value)
    : definition.workload === 'legacy-lookup' ? answer.lookup.rows.map(row => row.value)
    : definition.workload === 'legacy-validate' ? [] : [...answer];
  const seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    assert.ok(Object.isFrozen(value), 'Standard .get() returned an unfrozen object'); seen.add(value);
    pending.push(...Object.values(value));
  }
  return seen.size;
}
try {
  for (const definition of selected) {
    const fixture = makeFixture(definition, catalog);
    const fixtureSHA256 = hash(JSON.stringify({ definition, entries: fixture.entries, requests: fixture.requests }));
    const owner = buildOwner(api, definition, fixture);
    const payload = api.getWorkerData({ data: owner }, { copy: false });
    assert.ok(payload.arenas.every(arena => arena.memory?.buffer instanceof SharedArrayBuffer && !arena.copy), 'Shared attachment required');
    const publishedBefore = payload.arenas.map(arena => ({ bytes: arena.used, sha256: hash(new Uint8Array(arena.memory.buffer, 0, arena.used)) }));
    const run = reader => definition.workload === 'full-object-get' ? reads.runReadQuery(reader, fixture.requests, reads.readCase('full-shared-get'))
      : definition.workload.startsWith('legacy-') ? catalog.calculate(reader, fixture.requests, definition.workload === 'legacy-lookup' ? 'lookup' : 'validate')
      : fixture.requests.map(key => reader.get(key));
    for (let iteration = 0; iteration < iterations; iteration++) {
      const reader = (await api.initWorker(payload)).data;
      const row = { caseId: definition.id, iteration, definition, fixtureSHA256, requested: fixture.requests.length,
        uniqueRequested: new Set(fixture.requests).size, uniqueLookupKeys: fixture.uniqueLookupKeys, serializedValueBytes: fixture.serializedBytes, status: 'running' };
      result.rows.push(row);
      let phase = 'first';
      try {
        const first = capture(() => run(reader));
        const { value: firstValue, ...firstProfile } = first; row.first = firstProfile;
        phase = 'repeat';
        const repeat = capture(() => run(reader));
        const { value: repeatValue, ...repeatProfile } = repeat; row.repeat = repeatProfile;
        phase = 'verification';
        const expected = definition.workload === 'full-object-get' ? reference.readReference(definition.size, 0, fixture.requests, reads.readCase('full-shared-get'))
          : definition.workload.startsWith('legacy-') ? (() => {
            const all = legacyReference.reference(definition.size, 0, fixture.requests);
            return definition.workload === 'legacy-lookup' ? { lookup: all.lookup } : { validation: all.validation };
          })() : expectedPlain(fixture, definition);
        if (definition.workload === 'ordinary-get') {
          verifyPlainCapture(api, definition, firstValue, expected); verifyPlainCapture(api, definition, repeatValue, expected);
        } else { exact(firstValue, expected); exact(repeatValue, expected); }
        row.correctness = { first: true, repeat: true, frozenObjects: definition.type === 'object' ? frozenCount(firstValue, definition) + frozenCount(repeatValue, definition) : 0 };
        const publishedAfter = payload.arenas.map(arena => ({ bytes: arena.used, sha256: hash(new Uint8Array(arena.memory.buffer, 0, arena.used)) }));
        assert.deepEqual(publishedAfter, publishedBefore, 'Reader changed published arena bytes');
        row.correctness.publishedBytesUnchanged = true;
        row.status = 'passed';
      } catch (error) {
        row.status = 'failed'; row.failure = { phase, name: error.name, message: error.message, stack: error.stack, profile: error.profile };
        result.failures.push({ caseId: definition.id, iteration, ...row.failure }); throw error;
      } finally { profiler.stop(); save(); }
    }
  }
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  if (!result.failures.length) result.failures.push({ name: error.name, message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally { result.finishedAt = new Date().toISOString(); save(); }
console.log(JSON.stringify({ output, status: result.status, rows: result.rows.length, diagnosticOnly: true }));
