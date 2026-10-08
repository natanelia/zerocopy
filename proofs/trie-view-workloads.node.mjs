// Node-only untimed fixture checks and synthetic protocol tests. No pilot or
// measured workload may run from this test file, even when CI variables exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, fixture, runChecks, verifyFixture, snapshot, hashKey, normalizeSink } from './trie-view-workloads.mjs';
import { CONFIG } from './trie-view-protocol.mjs';
import { parseRequest, validateEntry, requireTimingAuthorization, runFixedMeasure, runPilot } from './trie-view-subject.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = new URL('../dist/shared.js', import.meta.url).href;
const api = await import(process.env.TRIE_VIEW_WORKLOAD_ENTRY ?? entry);

test('the frozen public catalogue has exactly fourteen controls and six targets', () => {
  assert.equal(CASES.length, 20);
  assert.equal(new Set(CASES.map(c => c.name)).size, 20);
  assert.equal(CASES.filter(c => c.category === 'control').length, 14);
  assert.equal(CASES.filter(c => c.target).length, 6);
  assert.ok(Object.isFrozen(CASES) && CASES.every(Object.isFrozen));
  assert.deepEqual(CASES.map(c => [c.kind, c.trie, c.type, c.size, c.shape, c.operation]), [
    ['map', 'hamt', 'number', 0, 'canonical', 'entries'],
    ['map', 'radix', 'number', 0, 'canonical', 'entries'],
    ['map', 'hamt', 'number', 1, 'canonical', 'entries'],
    ['map', 'radix', 'number', 1, 'canonical', 'entries'],
    ['set', 'hamt', 'number', 0, 'canonical', 'values'],
    ['set', 'radix', 'number', 0, 'canonical', 'values'],
    ['set', 'hamt', 'number', 1, 'canonical', 'values'],
    ['set', 'radix', 'number', 1, 'canonical', 'values'],
    ['map', 'hamt', 'number', 2, 'collision', 'entries'],
    ['map', 'hamt', 'number', 32, 'patched', 'entries'],
    ['map', 'hamt', 'number', 4096, 'canonical', 'first'],
    ['map', 'radix', 'number', 4096, 'canonical', 'first'],
    ['map', 'hamt', 'number', 4096, 'canonical', 'get'],
    ['map', 'radix', 'number', 4096, 'canonical', 'get'],
    ['map', 'hamt', 'number', 4096, 'canonical', 'entries'],
    ['map', 'hamt', 'number', 4096, 'patched', 'entries'],
    ['map', 'radix', 'number', 4096, 'canonical', 'entries'],
    ['map', 'radix', 'number', 4096, 'journal', 'entries'],
    ['map', 'hamt', 'object', 4096, 'canonical', 'keys'],
    ['map', 'radix', 'object', 4096, 'canonical', 'keys'],
  ]);
  assert.equal(hashKey('costarring'), hashKey('liquid'));
  assert.ok(CASES.every(c => typeof c.description === 'string' && c.description.length > 30));
  assert.throws(() => fixture(api, { ...CASES[0], size: 9 }), /Workload definition changed/);
});

test('all twenty workloads match independent content/order models and immutable-byte/allocation guards', () => {
  const results = runChecks(api);
  assert.equal(results.length, 20);
  for (const result of results) {
    assert.equal(result.expectedDigest, result.actualDigest);
    assert.match(result.expectedDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.before, result.after);
    assert.equal(result.allocatedSharedBytes, 0);
    assert.equal(result.immutableBytes, true);
  }
  const journal = results.find(r => r.name.includes('/journal/'));
  assert.equal(journal.shape.tag, 0xffffffff);
  assert.equal(journal.shape.pendingEdits, 4);
  for (const patched of results.filter(r => r.name.includes('/patched/'))) assert.ok(patched.shape.tag & 0x80000000);
});

test('full output oracles reject content/order corruption even when terminal values match', () => {
  const f = fixture(api, 'map/hamt/number/32/patched/entries');
  [f.expected[0], f.expected[1]] = [f.expected[1], f.expected[0]];
  assert.deepEqual(normalizeSink(f.execute(1)), f.expectedSink);
  assert.throws(() => verifyFixture(f), /complete content\/order/);
});

test('read guards detect shared allocations and published payload mutations outside timing', () => {
  const allocating = fixture(api, 'map/hamt/number/1/canonical/entries');
  const operation = allocating.execute;
  allocating.execute = repeat => { allocating.item.set('extra', 4); return operation(repeat); };
  assert.throws(() => verifyFixture(allocating), /changed published payload or shared allocation/);
  const mutating = fixture(api, 'map/hamt/number/1/canonical/entries');
  const original = mutating.execute, arena = api.getWorkerData({ item: mutating.item }, { copy: false }).arenas[0];
  mutating.execute = repeat => {
    const sink = original(repeat);
    new Uint8Array(arena.memory.buffer)[arena.used - 1] ^= 1;
    return sink;
  };
  assert.throws(() => verifyFixture(mutating), /changed published payload or shared allocation/);
});

test('early-exit operations close the generator and get controls use a warmed existing key', () => {
  for (const trie of ['hamt', 'radix']) {
    const f = fixture(api, `map/${trie}/number/4096/canonical/first`);
    assert.deepEqual(normalizeSink(f.execute(2)), f.expectedSink);
    assert.deepEqual(snapshot(f), verifyFixture(f).after);
    const get = fixture(api, `map/${trie}/number/4096/canonical/get`);
    assert.equal(get.execute(2), 2048.25);
    assert.equal(get.item.has('key2048'), true);
  }
});

test('CLI fixes phase, work counts, alignment and caps before import or timing', () => {
  const name = CASES[0].name;
  assert.deepEqual(parseRequest([entry, name, 'verify']), { entryUrl: entry, name, phase: 'verify' });
  assert.deepEqual(parseRequest([entry, name, 'measure', '10', '130']),
    { entryUrl: entry, name, phase: 'measure', repeat: 10, warmupOperations: 130 });
  for (const args of [
    [entry, name, 'verify', '1', '1'], [entry, name, 'pilot', '1', '1'],
    [entry, name, 'measure'], [entry, 'unknown', 'verify'], [entry, name, 'other'],
    [entry, name, 'measure', '1e2', '1000'], [entry, name, 'measure', '0', '100'],
    [entry, name, 'measure', '10', '131'],
    [entry, name, 'measure', String(CONFIG.maxRepeat + 1), String(CONFIG.maxRepeat + 1)],
    [entry, name, 'measure', '1', String(CONFIG.maxWarmupCalls + 1)],
  ]) assert.throws(() => parseRequest(args));
});

test('timing authorization requires both CI markers and permits untimed verification anywhere', () => {
  requireTimingAuthorization('verify', {});
  for (const phase of ['pilot', 'measure']) {
    assert.throws(() => requireTimingAuthorization(phase, {}), /No local timings/);
    assert.throws(() => requireTimingAuthorization(phase, { GITHUB_ACTIONS: 'true' }), /explicit clean-CI/);
    assert.throws(() => requireTimingAuthorization(phase, { TRIE_VIEW_GATE_TIMING: '1' }), /No local timings/);
    requireTimingAuthorization(phase, { GITHUB_ACTIONS: 'true', TRIE_VIEW_GATE_TIMING: '1' });
  }
});

test('measured work is fixed even when every invented batch and warmup misses a floor', () => {
  const request = { repeat: 10, warmupOperations: 130 }, calls = [], result = { flags: [] };
  runFixedMeasure(request, result, repeat => { calls.push(repeat); return 0.001; });
  assert.deepEqual(calls, Array(13 + 21).fill(10));
  assert.equal(result.warmup.operations, 130);
  assert.equal(result.warmup.batches.length, 13);
  assert.equal(result.samples.length, 21);
  assert.equal(result.belowFloorBatches, 21);
  assert.deepEqual(result.flags, ['warmup below floor', 'batch below floor']);
  const good = { flags: [] }, goodCalls = [];
  runFixedMeasure(request, good, repeat => { goodCalls.push(repeat); return 50; });
  assert.deepEqual(goodCalls, calls);
  assert.deepEqual(good.flags, []);
  assert.equal(good.warmup.elapsedMs, 650);
  assert.equal(good.repeat, result.repeat);
});

test('synthetic pilot prewarms before calibration and includes the final qualifying sample in its rate', () => {
  const result = { flags: [] }; let clock = 0;
  runPilot(result, repeat => {
    const probe = result.probes.at(-1);
    const ms = probe?.repeat >= 400 ? [45, 43, 40][probe.samples.length] : repeat * 0.1;
    clock += ms; return ms;
  }, () => clock);
  assert.ok(result.prewarm.elapsedMs >= CONFIG.pilotWarmupMs);
  assert.ok(result.prewarm.operations >= CONFIG.pilotWarmupMinCalls);
  assert.equal(result.prewarm.capped, false);
  assert.equal(result.probes.at(-1).samples.length, 3);
  assert.equal(result.estimateMsPerOperation, 40 / result.probes.at(-1).repeat);
  assert.equal(result.estimateMsPerOperation,
    Math.min(...result.probes.flatMap(p => p.samples.map(ms => ms / p.repeat))));
  assert.deepEqual(result.flags, []);
});

test('synthetic pilot time, work, repeat and step caps fail with partial evidence instead of retuning', () => {
  for (const kind of ['time', 'work', 'repeat', 'step']) {
    const result = { flags: [] }; let clock = 0;
    assert.throws(() => runPilot(result, repeat => {
      const calibrating = result.probes.length > 0;
      const ms = kind === 'time' ? CONFIG.pilotWarmupMaxMs + 1
        : kind === 'work' ? repeat * 1e-8 : !calibrating ? repeat
          : kind === 'repeat' ? 0.001 : 39;
      clock += ms; return ms;
    }, () => clock), /cap/);
    assert.equal(result.flags.length, 1);
    assert.match(result.flags[0], new RegExp(kind));
    assert.ok(result.prewarm.batches.length > 0);
    if (kind === 'time' || kind === 'work') assert.equal(result.prewarm.capped, true);
    else {
      assert.ok(result.probes.length > 0);
      assert.ok(result.probes.every(p => p.samples.length === 3));
      if (kind === 'repeat') assert.equal(result.probes.at(-1).repeat, CONFIG.maxRepeat);
      if (kind === 'step') assert.equal(result.probes.length, CONFIG.pilotCalibrationSteps);
    }
  }
});

test('synthetic measured failures retain completed batches and reject caps without doing work', () => {
  const partial = { flags: [] }; let count = 0;
  assert.throws(() => runFixedMeasure({ repeat: 1, warmupOperations: 2 }, partial,
    () => { if (++count === 6) throw new Error('invented failure'); return 100; }), /invented failure/);
  assert.equal(partial.warmup.operations, 2);
  assert.deepEqual(partial.samples, [100, 100, 100]);
  for (const request of [
    { repeat: 0, warmupOperations: 1 }, { repeat: 1, warmupOperations: 0 },
    { repeat: CONFIG.maxRepeat + 1, warmupOperations: CONFIG.maxRepeat + 1 },
    { repeat: 1, warmupOperations: CONFIG.maxWarmupCalls + 1 }, { repeat: 10, warmupOperations: 11 },
  ]) assert.throws(() => runFixedMeasure(request, { flags: [] }, () => assert.fail('Capped work executed')));
});

test('entry paths bind the sibling original package and reject aliases, wrappers and second builds', () => {
  const receipt = validateEntry(entry);
  assert.equal(receipt.physicalEntry, fileURLToPath(entry));
  assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/);
  for (const changed of [entry + '?cache=1', entry + '#alias', new URL('../dist/worker.js', import.meta.url).href,
    'https://example.test/shared.js', pathToFileURL('/tmp/comparison/dist/shared.js').href]) {
    assert.throws(() => validateEntry(changed));
  }
  const directory = mkdtempSync(join(tmpdir(), 'trie-view-neutral-test-'));
  try {
    mkdirSync(join(directory, 'proofs')); mkdirSync(join(directory, 'dist'));
    const subjectPath = join(directory, 'proofs', 'trie-view-subject.mjs'), entryPath = join(directory, 'dist', 'shared.js');
    writeFileSync(subjectPath, ''); writeFileSync(entryPath, 'export const fixture = true;');
    writeFileSync(join(directory, 'package.json'), '{"name":"zerocopy","type":"module"}\n');
    const subjectUrl = pathToFileURL(subjectPath).href, entryUrl = pathToFileURL(entryPath).href;
    validateEntry(entryUrl, subjectUrl);
    writeFileSync(join(directory, 'package.json'), '{"name":"wrapper","type":"module"}\n');
    assert.throws(() => validateEntry(entryUrl, subjectUrl), /original zerocopy/);
    writeFileSync(join(directory, 'package.json'), '{"name":"zerocopy","type":"module"}\n');
    rmSync(entryPath); symlinkSync(fileURLToPath(entry), entryPath);
    assert.throws(() => validateEntry(entryUrl, subjectUrl), /symlink/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('fresh-process verify emits complete guards and a rejected local pilot emits a partial record', () => {
  const file = join(here, 'trie-view-subject.mjs'), name = CASES[0].name;
  const env = { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '' };
  delete env.GITHUB_ACTIONS; delete env.TRIE_VIEW_GATE_TIMING;
  const verified = spawnSync(process.execPath, [file, entry, name, 'verify'], { env, encoding: 'utf8', cwd: resolve(here, '..') });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.phase, 'verify'); assert.equal(result.status, 'completed');
  assert.equal(result.runtime.name, 'node');
  assert.equal(result.expectedDigest, result.actualDigest);
  assert.equal(result.guards.beforeDigest, result.guards.afterDigest);
  assert.deepEqual(Object.keys(result.sourceSha256).sort(), ['trie-view-protocol.mjs', 'trie-view-subject.mjs', 'trie-view-workloads.mjs']);
  assert.ok(!Object.hasOwn(result, 'samples') && !Object.hasOwn(result, 'prewarm'));
  const rejected = spawnSync(process.execPath, [file, entry, name, 'pilot'], { env, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  const denied = JSON.parse(rejected.stdout);
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /No local timings/);
  assert.ok(!Object.hasOwn(denied, 'probes') && !Object.hasOwn(denied, 'guards'));
});

test('subject source dependencies are explicitly closed over the three frozen helpers', () => {
  const source = readFileSync(join(here, 'trie-view-subject.mjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/from '(\.\/[^']+)'/g)].map(match => match[1]).sort(),
    ['./trie-view-protocol.mjs', './trie-view-workloads.mjs']);
  assert.equal([...source.matchAll(/await import\(/g)].length, 1);
  assert.doesNotMatch(source, /gc\(|expose-gc|random-seed|jitless/);
});
