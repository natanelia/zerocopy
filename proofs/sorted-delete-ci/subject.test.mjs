// Deterministic schedule, clock guard and accounting tests. No arm imports.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {untimedCounts, key, missKey, longKey, expectedPool, sourceIndex, queryIndex,
  performDeletes, arenaFootprint, validateOutputs, digest, bytesDigest} from './fixtures.mjs';
import {bodyWithClock, requireTimedAdmission} from './subject.mjs';
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
let checks = 0;
function check(fn) { fn(); checks++; }
check(() => { let called = 0; assert.equal(bodyWithClock('untimed', () => called++, () => { throw Error('Operation clock read'); }), null); assert.equal(called, 1); });
check(() => assert.throws(() => bodyWithClock('other', () => {})));
// Synthetic arithmetic only: a fixed injected sequence, no platform clock.
check(() => { const values = [10, 15]; assert.equal(bodyWithClock('measure', () => {}, () => values.shift()), 5); assert.equal(values.length, 0); });
for (const spec of protocol.cases) check(() => {
  assert.deepEqual(untimedCounts(spec), [spec.ladder[0], spec.ladder.at(-1)]);
  assert(spec.ladder[0] > 1); assert.equal(spec.operation, 'delete');
});
check(() => {
  const small = Array.from({length: 128}, (_, group) => Array.from({length: 16}, (_, i) => key(i, group))).flat();
  assert.equal(new Set(small).size, 2048); assert(small.every(k => k.length === 11));
  assert.equal(small.reduce((n, k) => n + k.length, 0), 22528);
});
check(() => { const misses = Array.from({length: 2048}, (_, i) => missKey(i)); assert.equal(new Set(misses).size, 2048); assert(misses.every(k => k.length === 12 && k[8] === '/')); });
check(() => { assert.equal(longKey(0).length, 16385); assert.notEqual(longKey(0), longKey(1)); });
check(() => assert.deepEqual(expectedPool('cold-small', 65536), {owners: 32, sources: 4096, sourceEntries: 65536}));
check(() => assert.deepEqual(expectedPool('cold-large', 65536), {owners: 16, sources: 16, sourceEntries: 65536}));
check(() => assert.deepEqual(expectedPool('cold-miss', 65536), {owners: 32, sources: 32, sourceEntries: 131072}));
check(() => {
  const template = {memory: {buffer: {byteLength: 131072}}, used: 70000};
  const measured = {memory: {buffer: {byteLength: 262144}}, used: 140000};
  const got = arenaFootprint([template, measured, measured], [measured], 4194304, 67108864);
  assert.equal(got.liveOwners, 2); assert.equal(got.summedArenaCapacity, 393216);
  assert.equal(got.summedArenaUsed, 210000); assert.equal(got.measuredArenaCapacity, 262144);
  assert.equal(got.outputReferenceBytesAt8PerSlot, 33554432);
  assert.equal(got.arenaCapacityPlusOutputReferencesAt8, 33947648);
});
check(() => assert.throws(() => arenaFootprint([{memory: {buffer: {byteLength: 65537}}, used: 1}], [], 0, 65536)));
check(() => {
  const calls = [], bytes = new Uint8Array(65536); let cachedRoot = 100;
  const arena = {used: 65536, memory: {buffer: bytes.buffer}, dv: {getUint32() { return 1; }},
    get buf() { calls.push('retained-payload-check'); return bytes; }};
  const source = {root: 100, size: 2, arena,
    entries() { calls.push('source.entries'); return [['a', 1], ['b', 2]][Symbol.iterator](); },
    get(k) { calls.push('source.get'); assert.equal(k, 'a'); cachedRoot = 100; return 1; },
    set(k, value) { calls.push('source.set'); assert.equal(cachedRoot, 100, 'A positive exact-source cache must be re-established'); assert.equal(k, 'a'); assert.equal(value, 1); return source; }};
  const result = {root: 200, size: 1, arena,
    has(k) { calls.push('result.has'); assert.equal(k, 'a'); cachedRoot = 200; return false; },
    entries() { calls.push('result.entries'); return [['b', 2]][Symbol.iterator](); }};
  const entries = [['a', 1], ['b', 2]], inputs = [entries], queries = ['a'];
  const bundle = {sources: [source], records: [{snapshot: source, entries, model: new Map(entries)}], retained: [], queries, queryDigest: digest(queries)};
  const retained = new Map([[arena, {used: 65536, capacity: 65536, payload: bytesDigest(new Uint8Array())}]]);
  validateOutputs({kind: 'warm', size: 2}, {inputs, inputDigest: digest(inputs)}, bundle, [result], retained);
  assert.deepEqual(calls.slice(-2), ['source.get', 'source.set']);
  assert(calls.indexOf('result.has') < calls.indexOf('source.get'));
  assert(calls.indexOf('retained-payload-check') < calls.indexOf('source.get'));
  assert(calls.indexOf('source.entries') < calls.indexOf('source.get'));
});
// Record the real loop's selected sources/queries using data-only fake deletes.
for (const spec of protocol.cases) check(() => {
  const operations = spec.kind.startsWith('cold-') ? spec.ladder.at(-1) : spec.ladder[0];
  const pool = expectedPool(spec.kind, operations), calls = [], marker = Object.freeze({observable: true});
  let queries;
  if (spec.kind === 'cold-small') queries = Array.from({length: 2048}, (_, i) => key(i & 15, i >>> 4));
  else if (spec.kind === 'cold-miss') queries = Array.from({length: 2048}, (_, i) => missKey(i));
  else queries = Array.from({length: spec.kind === 'cold-large' ? 4096 : spec.kind === 'cached-miss' ? 16 : ['journal','long'].includes(spec.kind) ? 1 : 1024}, (_, i) => key(i));
  const sources = Array.from({length: pool.sources}, (_, index) => ({delete(query) { calls.push([index, query]); return marker; }}));
  const outputs = new Array(operations).fill(null);
  performDeletes(spec, {sources, queries}, outputs);
  assert.equal(calls.length, operations); assert(outputs.every(x => x === marker));
  for (let i = 0; i < operations; i++) assert.deepEqual(calls[i], [sourceIndex(spec.kind, i), queries[queryIndex(spec.kind, i)]]);
  if (spec.kind.startsWith('cold-')) {
    const seen = new Set();
    for (const [source, query] of calls) {
      const owner = spec.kind === 'cold-small' ? source >>> 7 : source;
      const label = `${owner}/${query}`; assert(!seen.has(label)); seen.add(label);
    }
  }
  if (spec.kind === 'stale') {
    const lastRoot = new Map(queries.map(k => [k, 0]));
    for (const [source, query] of calls) { assert.notEqual(lastRoot.get(query), source); lastRoot.set(query, source); }
  }
});
const temporary = mkdtempSync(path.join(tmpdir(), 'sorted-delete-admission-test-'));
try {
  check(() => requireTimedAdmission({mode: 'untimed'}, temporary));
  check(() => assert.throws(() => requireTimedAdmission({mode: 'calibrate'}, temporary)));
  writeFileSync(path.join(temporary, 'admission.json'), JSON.stringify({mode: 'historical', promotionAllowed: false}));
  writeFileSync(path.join(temporary, 'manifest.json'), '{}');
  check(() => assert.throws(() => requireTimedAdmission({mode: 'measure'}, temporary)));
  writeFileSync(path.join(temporary, 'admission.json'), JSON.stringify({mode: 'ci-screen', promotionAllowed: false, fullStandardGateStatus: {baseline: 'passed-fresh-exact-source', candidate: 'passed-fresh-exact-source'}}));
  writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({sources: {baseline: {path: '/exact/baseline'}}}));
  check(() => requireTimedAdmission({mode: 'measure', arm: 'baseline', entrypoint: '/exact/baseline/dist/shared.js'}, temporary));
  check(() => assert.throws(() => requireTimedAdmission({mode: 'measure', arm: 'baseline', entrypoint: '/other/dist/shared.js'}, temporary)));
} finally { rmSync(temporary, {recursive: true, force: true}); }
console.log(JSON.stringify({deterministicSubjectChecks: checks, passed: true, armImports: false, operationClocks: false}));
