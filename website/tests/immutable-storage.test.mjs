import test from 'node:test';
import assert from 'node:assert/strict';
import { List } from '../_site/compare/vendor/immutable.mjs';
import { immutableVersion } from '../_site/compare/vendor/version.mjs';
import { fromColumns, appendImmutable, immutableView, transportColumns } from '../_site/compare/assets/immutable-storage.mjs';
import { fromColumns as fromImmerColumns, appendImmer, immerView } from '../_site/compare/assets/immer-storage.mjs';
import { emptyShared, appendShared } from '../_site/compare/assets/explorer-storage.mjs';
import { FIELDS, MAX_EVENTS, SERVICES, generateColumns, nativeView, sharedView, rowAt, search, summarizeEvents } from '../assets/explorer-core.mjs';
import { reference, verifyAnswer } from '../assets/explorer-reference.mjs';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
test('browser uses the pinned upstream Immutable.js package and real Lists', () => {
  assert.equal(immutableVersion, pkg.devDependencies.immutable);
  const input = generateColumns(0, 33), snapshot = fromColumns(input);
  for (const field of FIELDS) assert.ok(List.isList(snapshot[field]));
  assert.deepEqual(transportColumns(snapshot), input);
  input.latency[0] = -123;
  assert.notEqual(snapshot.latency.get(0), -123, 'List construction must not retain a mutable input array');
});
test('retained roots survive appends and replacement values; transport encodes only the delta', () => {
  const input = generateColumns(0, 1024), snapshot = fromColumns(input), delta = generateColumns(1024, 33);
  const next = appendImmutable(snapshot, delta);
  assert.equal(snapshot.time.size, 1024); assert.equal(next.time.size, 1057);
  assert.deepEqual(transportColumns(snapshot), input);
  assert.deepEqual(transportColumns(next, 1024), delta);
  assert.equal(next.latency.set(0, -1).get(0), -1);
  assert.equal(snapshot.latency.get(0), input.latency[0]);
  const replica = appendImmutable(fromColumns(structuredClone(transportColumns(snapshot))), structuredClone(transportColumns(next, 1024)));
  assert.deepEqual(transportColumns(replica), transportColumns(next));
  assert.deepEqual(transportColumns(next, next.time.size), Object.fromEntries(FIELDS.map(field => [field, []])));
});
test('invalid columns, capacity, and delta boundaries are rejected', () => {
  const base = generateColumns(0, 1), snapshot = fromColumns(base);
  assert.throws(() => fromColumns({ ...base, time: [] }));
  assert.throws(() => immutableView(base));
  assert.throws(() => appendImmutable(snapshot, { ...base, latency: [] }));
  for (const value of [-1, 2, .5, NaN, Infinity]) assert.throws(() => transportColumns(snapshot, value));
  const full = Object.fromEntries(FIELDS.map(field => [field, List().setSize(MAX_EVENTS)]));
  assert.throws(() => appendImmutable(full, base), /capacity/);
});
test('seeded random data produces exact native, Immutable.js, Immer, shared, and reference results', async () => {
  let state = 0x51f15e;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const sizes = [0, 1, 31, 32, 33, 1023, 1024, 1025, ...Array.from({ length: 32 }, () => random() % 257)];
  const messages = ['TIMEOUT café', 'request 日本語', 'retry 🚦', 'e\u0301 cache', 'Καλημέρα', 'nul\0value', '<script>not HTML</script>'];
  for (const size of sizes) {
    const columns = Object.fromEntries(FIELDS.map(field => [field, []]));
    for (let i = 0; i < size; i++) {
      const event = { time: 1_700_000_000_000 + i * 17, service: random() % SERVICES.length, level: random() % 3, latency: random() % 6000, message: messages[random() % messages.length] };
      for (const field of FIELDS) columns[field].push(event[field]);
    }
    const cut = size >>> 1;
    const first = Object.fromEntries(FIELDS.map(field => [field, columns[field].slice(0, cut)]));
    const delta = Object.fromEntries(FIELDS.map(field => [field, columns[field].slice(cut)]));
    const saved = fromColumns(first), immutable = appendImmutable(saved, delta);
    const savedImmer = fromImmerColumns(first), immer = appendImmer(savedImmer, delta);
    const shared = appendShared(emptyShared(), columns);
    const query = { term: ['', 'timeout', '日本', '🚦'][random() % 4], service: random() % (SERVICES.length + 1) - 1, level: random() % 4 - 1, offset: random() % 3, limit: 13 };
    const queries = [{}, query, { term: 'absent' }, { from: 1_700_000_000_017, to: 1_700_000_000_170, offset: 1, limit: 3 }];
    for (const q of queries) {
      const expected = reference(columns, q);
      for (const view of [nativeView(columns), immutableView(immutable), immerView(immer), sharedView(shared)]) {
        const found = await search(view, q), summary = await summarizeEvents(view, q);
        verifyAnswer({ search: found, summary, rows: found.indices.map(index => rowAt(view, index)) }, expected);
      }
    }
    assert.deepEqual(transportColumns(saved), first, 'Random append changed a retained root');
    assert.deepEqual(transportColumns(immutable), columns);
    assert.deepEqual(savedImmer, first, 'Random append changed a retained Immer root');
    assert.deepEqual(immer, columns);
  }
});
