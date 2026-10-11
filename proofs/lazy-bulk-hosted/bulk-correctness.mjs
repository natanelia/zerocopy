import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const GROUPS = ['table-states-and-aliases', 'public-input-trace', 'partial-failure-boundaries', 'reentry-and-set-dispatch', 'collision-and-growth'];
const encode = new TextEncoder(), decode = new TextDecoder('utf-8', { ignoreBOM: true });
const normalized = value => decode.decode(encode.encode(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const equalMetadata = (a, b) => assert.deepEqual(plain(a), plain(b));
const numberValue = value => Object.is(value, -0) ? '-0' : String(value);
const tagged = value => [typeof value, typeof value === 'number' ? numberValue(value) : value];
const compareKeys = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const rows = map => [...map.entries()].map(([key, value]) => [key, tagged(value)]).sort(compareKeys);
const compareTagged = (a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
const setRows = set => [...set.values()].map(tagged).sort(compareTagged);
function expectedRows(type, entries) {
  const values = new Map();
  for (const [key, value] of entries) values.set(normalized(key), value);
  return [...values].map(([key, value]) => {
    assert.equal(typeof value, type);
    return [key, tagged(type === 'string' ? normalized(value) : value)];
  }).sort(compareKeys);
}
function stringFixture(kind, position) {
  const entries = [['a', 'one'], ['b', 'two'], ['c', 'three'], ['alias', 'old'], ['alias', 'final'], ['replaced', '🙂'], ['replaced', 'ASCII'], ['overwritten-invalid', false], ['overwritten-invalid', 'valid']];
  const index = position === 'first' ? 0 : entries.length - 1;
  if (kind === 'key-only' || kind === 'both') {
    if (position === 'first') entries[0][0] = '\ufeff界🙂';
    else { entries[7][0] = 'alias-\ud800'; entries[8][0] = 'alias-\ufffd'; }
  }
  if (kind === 'value-only' || kind === 'both') entries[index][1] = position === 'first' ? '\0界🙂\ufeff' : 'tail\udc00';
  const latest = new Map();
  for (const [key, value] of entries) latest.set(normalized(key), value);
  const survivors = [...latest], selected = position === 'first' ? 0 : survivors.length - 1;
  const keys = [], values = [];
  for (let i = 0; i < survivors.length; i++) {
    assert.equal(typeof survivors[i][1], 'string');
    if (/[^\x00-\x7f]/.test(survivors[i][0])) keys.push(i);
    if (/[^\x00-\x7f]/.test(survivors[i][1])) values.push(i);
  }
  assert.deepEqual(keys, kind === 'key-only' || kind === 'both' ? [selected] : []);
  assert.deepEqual(values, kind === 'value-only' || kind === 'both' ? [selected] : []);
  return entries;
}
function smoke() {
  const structures = Object.assign(Object.create(null), { map: { type: 'SharedMap', arena: 'fixture', data: { root: 0, valueType: 'string', size: 0 } } });
  const fixture = { schema: 1, groups: GROUPS, structures };
  equalMetadata(fixture, plain(fixture));
  const changed = plain(fixture); changed.structures.map.data.size = 1;
  assert.throws(() => equalMetadata(fixture, changed));
  assert.throws(() => equalMetadata(fixture, { ...plain(fixture), groups: GROUPS.slice(1) }));
  assert.deepEqual(expectedRows('string', [['\ud800', 'obsolete'], ['\ufffd', 'kept'], ['x', false], ['x', 'ok']]), [['x', ['string', 'ok']], ['\ufffd', ['string', 'kept']]]);
  for (const kind of ['ascii', 'key-only', 'value-only', 'both']) for (const position of ['first', 'last']) stringFixture(kind, position);
  assert.equal(new Set(GROUPS).size, 5);
  return { schema: 1, kind: 'bulk-fixture-smoke', passed: true, groups: GROUPS, metadataMutationRejections: 2 };
}

async function corpus(S) {
  const groups = [];
  const fresh = type => { S.resetMap(); return new S.SharedMap(type); };
  const arena = map => {
    const payload = S.getWorkerData({ map }, { copy: false });
    assert.equal(payload.arenas.length, 1);
    return payload.arenas[0];
  };
  const bytes = (map, end) => {
    const a = arena(map);
    return Buffer.from(new Uint8Array(a.memory.buffer, 65536, (end ?? a.used) - 65536));
  };
  const record = (name, map) => {
    const a = arena(map), values = rows(map);
    return { name, type: map.valueType, root: map.root, size: map.size, used: a.used,
      capacity: a.memory.buffer.byteLength, payloadSHA256: digest(bytes(map)), rowsSHA256: digest(JSON.stringify(values)) };
  };
  const check = (map, type, entries) => { assert.equal(map.size, expectedRows(type, entries).length); assert.deepEqual(rows(map), expectedRows(type, entries)); };
  const state = map => ({ used: arena(map).used, bytes: bytes(map) });
  const unchanged = (map, before) => assert.deepEqual(bytes(map, before.used), before.bytes);

  {
    const results = [];
    for (const kind of ['ascii', 'key-only', 'value-only', 'both']) for (const position of ['first', 'last']) {
      const entries = stringFixture(kind, position);
      const old = fresh('string'), before = state(old), next = old.setMany(entries);
      check(next, 'string', entries); check(old, 'string', []); unchanged(old, before);
      const fork = old.setMany([['fork', 'independent']]); check(fork, 'string', [['fork', 'independent']]); check(next, 'string', entries);
      results.push(record(`string-${kind}-position-${position}`, next));
    }
    for (const type of ['number', 'boolean']) for (const unicode of [false, true]) {
      const good = type === 'number' ? -0 : false, other = type === 'number' ? 7.25 : true;
      const entries = [['a', good], ['duplicate', 'invalid'], ['duplicate', other], [unicode ? '\ud800' : 'last', good], [unicode ? '\ufffd' : 'last', other]];
      if (type === 'number') entries.push(['nan', NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity], ['negative-zero', -0], ['positive-zero', 0]);
      const old = fresh(type), next = old.setMany(entries); check(next, type, entries); check(old, type, []);
      if (type === 'number') for (const [key, value] of entries.slice(-5)) assert(Object.is(next.get(key), value));
      results.push(record(`${type}-${unicode ? 'unicode' : 'ascii'}`, next));
    }
    groups.push({ name: GROUPS[0], results });
  }
  {
    const base = fresh('string').setMany([['kept', 'old']]), before = state(base), observations = [];
    assert.equal(base.setMany([]), base);
    for (const lengths of [[1, 1], [1, 0]]) {
      const trace = []; let index = 0;
      const input = { get length() { trace.push('length'); return lengths[index++]; }, *[Symbol.iterator]() { trace.push('iterator'); } };
      const next = base.setMany(input);
      assert.notEqual(next, base); assert.equal(next.root, base.root); assert.equal(arena(base).used, before.used);
      assert.deepEqual(trace, lengths[1] ? ['length', 'length', 'iterator'] : ['length', 'length']);
      observations.push({ lengths, trace, sameRoot: true, newWrapper: true });
    }
    const trace = [];
    const tuple = { *[Symbol.iterator]() { trace.push('tuple-open'); try { trace.push('key'); yield 'new'; trace.push('value'); yield 'value'; trace.push('unused'); yield 'unused'; } finally { trace.push('tuple-close'); } } };
    const input = { get length() { trace.push('length'); return 1; }, *[Symbol.iterator]() { trace.push('input-open'); yield tuple; trace.push('input-end'); } };
    const next = base.setMany(input);
    assert.deepEqual(trace, ['length', 'length', 'input-open', 'tuple-open', 'key', 'value', 'tuple-close', 'input-end']);
    check(next, 'string', [['kept', 'old'], ['new', 'value']]); observations.push({ trace, result: record('tuple-input', next) });
    const thrownTrace = [], failure = new Error('tuple failure');
    const badTuple = { *[Symbol.iterator]() { thrownTrace.push('tuple-open'); try { yield 'bad'; throw failure; } finally { thrownTrace.push('tuple-close'); } } };
    const badInput = { get length() { thrownTrace.push('length'); return 1; }, *[Symbol.iterator]() { thrownTrace.push('input-open'); try { yield badTuple; } finally { thrownTrace.push('input-close'); } } };
    const failedBefore = state(base);
    assert.throws(() => base.setMany(badInput), error => error === failure);
    assert.deepEqual(thrownTrace, ['length', 'length', 'input-open', 'tuple-open', 'tuple-close', 'input-close']);
    assert.equal(arena(base).used, failedBefore.used); unchanged(base, failedBefore);
    observations.push({ thrownTrace, error: failure.message });
    const reader = (await S.initWorker(S.getWorkerData({ map: base }, { copy: false }))).map;
    assert.equal(reader.setMany([]), reader);
    const readerTrace = [];
    const readonlyInput = { get length() { readerTrace.push('length'); return 1; }, *[Symbol.iterator]() { readerTrace.push('iterator'); yield ['x', 'y']; } };
    assert.throws(() => reader.setMany(readonlyInput), /read-only/); assert.deepEqual(readerTrace, ['length']);
    observations.push({ readerTrace }); unchanged(base, before); check(base, 'string', [['kept', 'old']]);
    groups.push({ name: GROUPS[1], observations });
  }
  {
    const results = [];
    for (const type of ['string', 'number', 'boolean']) for (const position of [0, 1]) {
      const valid = type === 'string' ? 'valid' : type === 'number' ? 1 : true;
      const base = fresh(type).setMany([['keep', valid]]), before = state(base);
      const entries = [['a', valid], ['z', valid]]; entries[position][1] = type === 'string' ? 123 : 'invalid';
      let error; try { base.setMany(entries); } catch (caught) { error = caught; }
      assert(error instanceof TypeError); assert.equal(error.message, `Expected a ${type}`);
      const a = arena(base), delta = a.used - before.used;
      const total = type === 'number' ? 72 : 56;
      assert.equal(delta, type === 'string' ? 0 : ((before.used + 7) & ~7) - before.used + total);
      unchanged(base, before); check(base, type, [['keep', valid]]);
      results.push({ type, position, error: { name: error.name, message: error.message }, delta, state: record('partial-failure', base) });
    }
    S.configureMemory({ maximumBytes: 131072 });
    try {
      const base = fresh('string').setMany([['keep', 'old']]), before = state(base); let error;
      try { base.setMany([['large', 'x'.repeat(80000)]]); } catch (caught) { error = caught; }
      assert(error instanceof WebAssembly.RuntimeError); assert.equal(arena(base).used, before.used); unchanged(base, before);
      check(base, 'string', [['keep', 'old']]);
      results.push({ name: 'bounded-allocation-failure', errorType: 'WebAssembly.RuntimeError', runtimeMessage: error.message, state: record('allocation-failure', base) });
    } finally { S.configureMemory({ maximumBytes: 268435456 }); }
    groups.push({ name: GROUPS[2], results });
  }
  {
    const base = fresh('string').setMany([['keep', 'old']]), before = state(base), trace = []; let inner;
    const input = { length: 2, *[Symbol.iterator]() { trace.push('outer-first'); yield ['outer-a', 'A']; trace.push('inner'); inner = base.setMany([['inner', '界🙂']]); trace.push('outer-last'); yield ['outer-b', 'B']; } };
    const outer = base.setMany(input);
    check(inner, 'string', [['keep', 'old'], ['inner', '界🙂']]); check(outer, 'string', [['keep', 'old'], ['outer-a', 'A'], ['outer-b', 'B']]);
    check(base, 'string', [['keep', 'old']]); unchanged(base, before);
    const calls = [];
    class ObservedSet extends S.SharedSet { has(value) { calls.push(tagged(value)); return super.has(value); } }
    const seed = fresh('number').setMany([['n:1', 0]]), observed = new ObservedSet(seed);
    const values = [1, 'new', '界', 'new'], next = observed.addMany(values);
    assert.deepEqual(calls, values.map(tagged)); assert.deepEqual(setRows(observed), [tagged(1)]);
    assert.deepEqual(setRows(next), [tagged(1), tagged('new'), tagged('界')].sort(compareTagged));
    groups.push({ name: GROUPS[3], trace, inner: record('inner', inner), outer: record('outer', outer), setCalls: calls, setValues: setRows(next) });
  }
  {
    const results = [];
    // Existing immutable-proof.test.ts:275-287 collision scenario, narrowed to maps.
    const a = 'costarring', b = 'liquid';
    for (const nonempty of [false, true]) {
      const empty = fresh('number'), seed = nonempty ? empty.set('other', 0) : empty;
      const old = seed.set(a, 1).set(b, 2), before = state(old);
      const bulk = seed.setMany([[a, 1], [b, 2], [a, 3]]);
      assert.equal(old.get(a), 1); assert.equal(old.get(b), 2); assert.equal(bulk.get(a), 3); assert.equal(bulk.get(b), 2);
      assert.equal(bulk.delete(a).get(b), 2); assert.equal(bulk.delete(b).get(a), 3);
      assert.equal(old.setMany([[b, 4], ['third', 5]]).get(a), 1); unchanged(old, before);
      results.push(record(`collision-${nonempty}`, bulk));
    }
    const base = fresh('string').setMany([['keep', 'old']]), before = state(base), capacity = arena(base).memory.buffer.byteLength;
    const attached = (await S.initWorker(S.getWorkerData({ map: base }, { copy: false }))).map;
    const entries = Array.from({ length: 128 }, (_, i) => [`k${i}`, `v${i}`]); entries.push(['large', 'x'.repeat(70000)]);
    const grown = base.setMany(entries);
    assert(arena(grown).memory.buffer.byteLength > capacity); unchanged(base, before);
    check(grown, 'string', [['keep', 'old'], ...entries]); check(base, 'string', [['keep', 'old']]); check(attached, 'string', [['keep', 'old']]);
    results.push(record('grown', grown));
    groups.push({ name: GROUPS[4], results });
  }
  assert.deepEqual(groups.map(group => group.name), GROUPS);
  return groups;
}

function workerCheck(S, attached, expected) {
  const results = [];
  for (const [name, values] of Object.entries(expected)) {
    const snapshot = attached[name]; assert(snapshot && Object.isFrozen(snapshot));
    if (name === 'set') {
      assert.deepEqual(setRows(snapshot), values); assert.throws(() => snapshot.add('blocked'), /read-only/);
      results.push({ name, size: snapshot.size, valuesSHA256: digest(JSON.stringify(setRows(snapshot))) });
    } else {
      assert.deepEqual(rows(snapshot), values); assert.equal(snapshot.setMany([]), snapshot);
      const value = snapshot.valueType === 'string' ? 'blocked' : snapshot.valueType === 'number' ? 5 : true;
      assert.throws(() => snapshot.setMany([['blocked', value]]), /read-only/);
      results.push({ name, size: snapshot.size, valuesSHA256: digest(JSON.stringify(rows(snapshot))) });
    }
  }
  return results;
}
async function realWorkers(S, entry) {
  S.resetMap();
  const snapshots = {}, expected = {};
  for (const type of ['string', 'number', 'boolean']) {
    const value = type === 'string' ? 'old' : type === 'number' ? -0 : false;
    const replacement = type === 'string' ? '界🙂' : type === 'number' ? 7.25 : true;
    const old = new S.SharedMap(type).setMany([['a', value], ['\ufeff界', value]]);
    const next = old.setMany([['a', replacement], ['new', replacement]]);
    snapshots[`${type}-old`] = old; snapshots[`${type}-new`] = next;
    expected[`${type}-old`] = expectedRows(type, [['a', value], ['\ufeff界', value]]);
    expected[`${type}-new`] = expectedRows(type, [['a', replacement], ['\ufeff界', value], ['new', replacement]]);
  }
  snapshots.set = new S.SharedSet().addMany([1, 'ascii', '界', 1]);
  expected.set = [tagged(1), tagged('ascii'), tagged('界')].sort(compareTagged);
  const results = [];
  for (const copy of [false, true]) {
    const data = S.getWorkerData(snapshots, { copy });
    assert(data.arenas.every(item => copy ? item.copy && !item.memory : item.memory && !item.copy));
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'primitive-bulk-worker', entry, data, expected } });
    const received = await new Promise((resolve, reject) => {
      let answer, failure;
      const deadline = setTimeout(() => { failure = new Error('Worker deadline'); worker.terminate().catch(reject); }, 10000);
      worker.on('message', value => { if (answer !== undefined) failure = new Error('Multiple worker results'); answer = value; });
      worker.on('error', error => { failure = error; });
      worker.once('exit', code => { clearTimeout(deadline); if (failure) reject(failure); else if (code !== 0 || !answer) reject(new Error(`Worker exit ${code} without result`)); else resolve(answer); });
    });
    assert.equal(received.schema, 1); assert.equal(received.kind, 'primitive-bulk-worker'); assert.equal(received.thread, 'worker');
    assert.deepEqual(received.results, workerCheck(S, await S.initWorker(data), expected));
    results.push({ copy, collectionCount: 7, results: received.results });
  }
  return results;
}

if (!isMainThread) {
  assert.equal(workerData.kind, 'primitive-bulk-worker');
  const S = await import(workerData.entry);
  const attached = await S.initWorker(workerData.data);
  parentPort.postMessage({ schema: 1, kind: 'primitive-bulk-worker', thread: 'worker', results: workerCheck(S, attached, workerData.expected) });
  parentPort.close();
} else if (process.argv[2] === '--smoke') {
  assert.equal(process.argv.length, 3); console.log(JSON.stringify(smoke()));
} else {
  const [entryPath, engine, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 5); assert(['node-portable', 'bun-source'].includes(engine));
  const entry = pathToFileURL(entryPath).href, S = await import(entry);
  const result = { schema: 1, kind: 'primitive-bulk-correctness', engine, groups: await corpus(S), workers: engine === 'node-portable' ? await realWorkers(S, entry) : [] };
  // Validate the saved representation too; never compare JSON-restored data to
  // null-prototype live descriptors without explicitly normalizing metadata.
  equalMetadata(result, plain(result));
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ schema: 1, kind: result.kind, engine, passed: true, groups: GROUPS, workerCases: result.workers.length, outputSHA256: digest(JSON.stringify(result, null, 2) + '\n') }));
}
