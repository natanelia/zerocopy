import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, SERVICES, LEVELS, MAX_EVENTS, generateColumns, sampleEvent, normalizeQuery, validateSize, validateColumns, nativeView, sharedView, search, summarizeEvents, rowAt, appendNative, assertSameAnswer } from '../assets/explorer-core.mjs';
import { reference, verifyAnswer } from '../assets/explorer-reference.mjs';
import { SharedList, getWorkerData, initWorker } from '../../dist/shared.js';
function toShared(columns) {
  return Object.fromEntries(FIELDS.map(field => {
    let list = new SharedList(field === 'message' ? 'string' : 'number');
    for (const value of columns[field]) list = list.push(value);
    return [field, list];
  }));
}

test('sample events are deterministic, bounded, and contain a visible payment timeout spike', () => {
  assert.deepEqual(sampleEvent(58201), sampleEvent(58201));
  let spikeErrors = 0, ordinaryErrors = 0;
  for (let i = 0; i < 1000; i++) {
    const spike = sampleEvent(55000 + i), ordinary = sampleEvent(i);
    assert.equal(spike.service, 2);
    if (spike.level === 2) { spikeErrors++; assert.match(spike.message, /timeout/); }
    if (ordinary.level === 2) ordinaryErrors++;
  }
  assert.ok(spikeErrors > ordinaryErrors * 5);
  assert.throws(() => sampleEvent(-1)); assert.throws(() => sampleEvent(MAX_EVENTS));
});

test('query input is bounded, literal, and validates numeric selectors and pages', () => {
  assert.equal(normalizeQuery({ term: ' TIMEOUT ' }).term, 'timeout');
  assert.equal(normalizeQuery({ term: '[.*]' }).term, '[.*]');
  for (const query of [null, { term: 'x'.repeat(129) }, { service: 4 }, { level: 3 }, { offset: -1 }, { offset: .5 }, { limit: 101 }, { to: Infinity }, { from: 2, to: 1 }]) assert.throws(() => normalizeQuery(query));
  for (const size of [0, '1000', 100001, NaN]) assert.throws(() => validateSize(size));
});

test('columns cannot publish different lengths or append past the session capacity', () => {
  const columns = generateColumns(0, 10); columns.level.pop();
  assert.throws(() => validateColumns(columns));
  assert.throws(() => nativeView(columns));
  const full = Object.fromEntries(FIELDS.map(field => [field, Array(MAX_EVENTS).fill(0)]));
  assert.throws(() => appendNative(full, generateColumns(0, 1)));
});

test('native and actual attached shared reads exactly match an independent oracle', async () => {
  const columns = generateColumns(55000, 2048), original = toShared(columns);
  const snapshot = await initWorker(getWorkerData(original, { copy: false }));
  const shared = sharedView(snapshot), native = nativeView(columns);
  const queries = [{}, { term: 'TIMEOUT', level: 2 }, { service: 2, offset: 50 }, { term: '<script>alert(1)</script>' }, { offset: 9999 }, { limit: 1 }, { from: columns.time[400], to: columns.time[1200] }];
  let seed = 7331;
  for (let i = 0; i < 24; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    queries.push({ service: seed % 5 - 1, level: (seed >>> 6) % 4 - 1, term: ['timeout', 'retry', '', 'missing'][(seed >>> 10) % 4], offset: seed % 100, limit: 1 + seed % 100 });
  }
  for (const query of queries) {
    const expected = reference(columns, query);
    for (const view of [native, shared]) {
      const found = await search(view, query), summary = await summarizeEvents(view, query);
      verifyAnswer({ search: found, summary, rows: found.indices.map(index => rowAt(view, index)) }, expected);
      assertSameAnswer(found, summary);
      assert.ok(found.indices.length <= (query.limit ?? 50));
    }
  }
});

test('native and shared empty states produce checked empty output', async () => {
  const columns = generateColumns(0, 0);
  for (const view of [nativeView(columns), sharedView(toShared(columns))]) {
    const found = await search(view, {}), summary = await summarizeEvents(view, {});
    verifyAnswer({ search: found, summary, rows: [] }, reference(columns));
    assert.throws(() => rowAt(view, 0));
  }
});

test('a retained shared column record remains readable after immutable appends', async () => {
  const columns = generateColumns(0, 100), original = toShared(columns), next = { ...original };
  const delta = generateColumns(100, 40);
  for (const field of FIELDS) for (const value of delta[field]) next[field] = next[field].push(value);
  const oldAttached = await initWorker(getWorkerData(original, { copy: false }));
  const newAttached = await initWorker(getWorkerData(next, { copy: false }));
  assert.equal(sharedView(oldAttached).length, 100); assert.equal(sharedView(newAttached).length, 140);
  assert.deepEqual(rowAt(sharedView(oldAttached), 99), rowAt(sharedView(newAttached), 99));
});

test('cancellation and reference mismatches fail instead of showing false results', async () => {
  const view = nativeView(generateColumns(0, 10000));
  await assert.rejects(search(view, {}, () => true), /cancelled/);
  await assert.rejects(summarizeEvents(view, {}, () => true), /cancelled/);
  assert.throws(() => assertSameAnswer({ total: 1, checksum: 1 }, { total: 1, checksum: 2 }));
  const expected = reference(generateColumns(0, 5));
  assert.throws(() => verifyAnswer({ ...expected, rows: [] }, expected));
});

test('cooperative scheduling yields a task, coalesces concurrent callers, and allows Node to exit', async () => {
  const { yieldToEvents } = await import('../assets/explorer-core.mjs');
  let completed = false;
  const pending = yieldToEvents().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false, 'A microtask is not a cancellation checkpoint');
  await Promise.all([pending, ...Array.from({ length: 32 }, () => yieldToEvents())]);
  assert.equal(completed, true);
  const { spawnSync } = await import('node:child_process');
  const core = new URL('../assets/explorer-core.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const {yieldToEvents} = await import(${JSON.stringify(core)}); await yieldToEvents(); console.log('finished');`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /finished/);
});
