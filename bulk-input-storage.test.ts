import { afterAll, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Arena, arenaOf, HEAP_START, normalizeKey } from './arena';
import { SharedMap, SharedSet, SharedList, getWorkerData, initWorker } from './shared';
import collisions from './proofs/bulk-input-collisions.json';

const candidate = (process.env.BULK_INPUT_ARM ?? 'candidate') === 'candidate';
const rows: any[] = [];
const A = (n: number) => Math.ceil(n / 8) * 8;
const key = (i: number) => `k${String(i).padStart(7, '0')}`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payload = (a: Arena, end = a.used) => a.buf.slice(HEAP_START, end);
const fresh = (type: string, a = new Arena()) => new SharedMap(type, 0, 0, a);
const logical = (m: SharedMap<any>) => [...m.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function poison(a: Arena) { a.buf.fill(0xa5, 16384, 65536); }
function staged(a: Arena) { return a.dv.getUint32(16384, true) !== 0xa5a5a5a5; }
function fnv(key: string) {
  let n = 2166136261n;
  for (const b of new TextEncoder().encode(key)) n = ((n ^ BigInt(b)) * 16777619n) & 0xffffffffn;
  return Number(n);
}
function record(name: string, a: Arena, extra: any = {}) {
  rows.push({ name, used: a.used, backing: a.memory.buffer.byteLength, payload: hash(payload(a)), ...extra });
}
afterAll(() => {
  if (process.env.BULK_INPUT_RUNTIME === 'bun') expect(process.versions.bun).toBe('1.4.2');
  if (process.env.BULK_INPUT_RUNTIME === 'node') { expect(process.versions.bun).toBeUndefined(); expect(process.versions.node).toBe('22.23.3'); }
  if (process.env.BULK_INPUT_REPORT) writeFileSync(process.env.BULK_INPUT_REPORT, JSON.stringify({ arm: candidate ? 'candidate' : 'baseline', runtime: process.versions, rows }, null, 2) + '\n');
});

for (const type of ['string', 'object']) for (const n of [0, 1, 4, 5, 4096, 12287, 12288, 12289]) {
  test(`bulk input boundary ${type}/${n}`, () => {
    const a = new Arena(), empty = fresh(type, a), entries = Array.from({ length: n }, (_, i) => [key(i), type === 'string' ? 'v' : {}] as const);
    poison(a);
    const next = empty.setMany(entries as any);
    expect(next.size).toBe(n); expect(empty.size).toBe(0);
    if (!n) expect(next).toBe(empty);
    for (let i = 0; i < n; i++) expect(next.get(key(i))).toEqual(type === 'string' ? 'v' : {});
    expect(staged(a)).toBe(candidate && type === 'object' && n > 0 && n <= 12288);
    record(`boundary/${type}/${n}`, a, { root: next.root, size: next.size, logical: hash(new TextEncoder().encode(JSON.stringify(logical(next)))) });
    // Reuse every staging byte only after collecting the allocation observation.
    a.buf.fill(0x5a, 16384, 65536);
    const reader = new SharedMap(type, next.root, next.size, new Arena({ memory: a.memory, used: a.used, readOnly: true }));
    for (let i = 0; i < n; i++) expect(reader.get(key(i))).toEqual(type === 'string' ? 'v' : {});
  });
}

for (const type of ['string', 'object']) for (const n of [12288, 12289]) {
  test(`normalized boundary ${type}/${n}`, () => {
    const a = new Arena(), value = type === 'string' ? 'v' : {};
    const entries: any[] = Array.from({ length: n - 1 }, (_, i) => [key(i), value]);
    entries.push(['\ud800', type === 'string' ? 'old' : { old: true }], ['\ufffd', value]);
    poison(a); const next = fresh(type, a).setMany(entries);
    expect(next.size).toBe(n); expect(next.get('\ud800')).toEqual(value); expect(next.get('\ufffd')).toEqual(value);
    expect(staged(a)).toBe(candidate && type === 'object' && n === 12288);
    record(`normalized/${type}/${n}`, a, { size: next.size, staged: staged(a) });
  });
}

test('Unicode, duplicate validation, long values and source callback order', () => {
  const a = new Arena(), old = fresh('string', a).setMany([['kept', 'old']]);
  const end = a.used, bytes = payload(a), events: string[] = [];
  const pairs: any[] = [['\0', 'nul'], ['\ufeff', 'bom'], ['\ud800', 17], ['\ufffd', 'last'], ['界🙂', 'é\ud800'], ['long', '🙂'.repeat(17000)]];
  const entries = new Proxy({ length: 6, *[Symbol.iterator]() { events.push('iterate'); yield* pairs; } }, {
    get(target, name, receiver) { if (name === 'length') events.push('length'); return Reflect.get(target, name, receiver); },
  });
  const next = old.setMany(entries as any);
  expect(events).toEqual(['length', 'length', 'iterate']);
  expect(next.get('\ud800')).toBe('last'); expect(next.get('界🙂')).toBe('é\ufffd'); expect(next.get('long')).toBe('🙂'.repeat(17000));
  expect(next.size).toBe(6); expect(payload(a, end)).toEqual(bytes); expect(old.get('kept')).toBe('old');
  record('unicode', a, { events, values: logical(next) });
});

for (const type of ['number', 'boolean']) for (const badAt of [0, 1, 2]) {
  test(`legacy invalid primitive ${type}/${badAt}`, () => {
    const a = new Arena(), entries: any[] = [0, 1, 2].map(i => [key(i), type === 'number' ? i : !!i]);
    entries[badAt][1] = 'invalid'; poison(a);
    expect(() => fresh(type, a).setMany(entries)).toThrow(new TypeError(`Expected a ${type}`));
    expect(staged(a)).toBe(false); record(`invalid/${type}/${badAt}`, a);
  });
}

test('legacy numeric, boolean and set allocation controls', () => {
  for (const type of ['number', 'boolean']) {
    const a = new Arena(); poison(a);
    const next = fresh(type, a).setMany(Array.from({ length: 33 }, (_, i) => [key(i), type === 'number' ? i : !!(i & 1)]) as any);
    expect(staged(a)).toBe(false); expect(next.size).toBe(33); record(`control/${type}`, a, { values: logical(next) });
  }
  const a = new Arena(), empty = new SharedSet(fresh('number', a) as SharedMap<'number'>); poison(a);
  const next = empty.addMany(['a', 'a', 0, -0, 1, '1']);
  expect(next.size).toBe(4); expect(staged(a)).toBe(false); record('control/set', a, { values: [...next.values()] });
});

test('string validation and object serialization errors precede table staging', () => {
  const a = new Arena(); poison(a);
  expect(() => fresh('string', a).setMany([['x', 1]] as any)).toThrow(new TypeError('Expected a string'));
  expect(a.used).toBe(HEAP_START); expect(staged(a)).toBe(false);
  let calls = 0;
  expect(() => fresh('object', a).setMany([[7, { toJSON() { calls++; return {}; } }]] as any)).toThrow(/Map keys must be strings/);
  expect(calls).toBe(0); expect(a.used).toBe(HEAP_START);
  const failure = new Error('bulk serialization fixture');
  expect(() => fresh('object', a).setMany([['good', {}], ['bad', { toJSON() { calls++; throw failure; } }]] as any)).toThrow(failure);
  expect(calls).toBe(1); expect(staged(a)).toBe(false); record('error/serialization', a);
  expect(() => fresh('object', a).setMany([['bad', { toJSON() { return undefined; } }]] as any)).toThrow(/JSON-serializable/);
  expect(() => fresh('object', a).setMany([['bad', 1n]] as any)).toThrow(TypeError);
  const next = fresh('string', a).setMany([['after', 'ok']]); expect(next.get('after')).toBe('ok');
});

test('object callbacks can reenter scratch, grow memory, retain side results and fail', () => {
  const a = new Arena(), old = fresh('object', a).setMany([['held', { kept: true }]] as any);
  const end = a.used, before = payload(a), events: string[] = []; let side: any;
  const next = old.setMany([
    ['first', { toJSON() { events.push('first'); side = fresh('object', a).setMany(Array.from({ length: 5 }, (_, i) => [key(i), { side: i }])); return { first: true }; } }],
    ['second', new Proxy({ get text() { events.push('getter'); return 'outer'; } }, { get(target, p, receiver) {
      if (p === 'toJSON') { events.push('proxy'); side = side.set('large', { text: 'g'.repeat(200000) }); }
      return Reflect.get(target, p, receiver);
    } })],
  ] as any);
  expect(events).toEqual(['first', 'proxy', 'getter']); expect(a.memory.buffer.byteLength).toBeGreaterThan(131072);
  a.buf.fill(0x77, 16384, 65536);
  expect(next.get('first')).toEqual({ first: true }); expect(next.get('second')).toEqual({ text: 'outer' });
  expect(side.get('large').text).toHaveLength(200000); expect(old.get('held')).toEqual({ kept: true }); expect(payload(a, end)).toEqual(before);
  const failure = new Error('reentrant tail fixture'); let retained: any;
  expect(() => old.setMany([['x', {}], ['y', { toJSON() { retained = side.setMany([['retained', { yes: true }]]); throw failure; } }]] as any)).toThrow(failure);
  expect(retained.get('retained')).toEqual({ yes: true }); expect(payload(a, end)).toEqual(before);
  expect(old.setMany([['recovery', { ok: true }]] as any).get('recovery')).toEqual({ ok: true });
  rows.push({ name: 'callbacks', events, retained: retained.get('retained').yes, old: old.get('held') });
});

test('nested descriptors, unchanged leaf aliases and attached read-only guards', async () => {
  const child = new SharedList('string').pushMany(['a', '界🙂']);
  const a = new Arena(); poison(a);
  const old = fresh('SharedList<string>', a).setMany([['a', child], ['b', child]] as any);
  expect(staged(a)).toBe(candidate);
  const value = old.get('a') as any, leaf = a.find(old.root, 'a'), end = a.used, before = payload(a);
  const next = old.setMany([['c', child.push('c')]] as any);
  a.buf.fill(0x77, 16384, 65536);
  expect(a.find(next.root, 'a')).toBe(leaf); expect(next.get('a')).toBe(value);
  expect((next.get('b') as any).toWorkerData()).toEqual(value.toWorkerData());
  for (const copy of [false, true]) {
    const restored = await initWorker(getWorkerData({ old, next }, { copy }));
    expect((restored.old.get('a') as any).toArray()).toEqual(['a', '界🙂']);
    expect((restored.next.get('c') as any).toArray()).toEqual(['a', '界🙂', 'c']);
    expect(restored.next.setMany([])).toBe(restored.next);
    let called = false;
    expect(() => (restored.next as any).setMany([['bad', { toJSON() { called = true; return {}; } }]])).toThrow(/read-only/);
    expect(called).toBe(false);
  }
  expect(payload(a, end)).toEqual(before); rows.push({ name: 'nested', sameLeaf: true, sameCachedValue: true });
});

function journal(type: string, a: Arena) {
  let base = fresh(type, a);
  for (let i = 0; i < 16; i++) base = base.set(key(i), (type === 'string' ? 'old' : {}) as never);
  const leaf = a.leaf(type, 'pending', type === 'string' ? 'pending' : { pending: true });
  // Valid legacy descriptor fixture; current scalar APIs do not create journals.
  const p = a.alloc(24), dv = a.dv;
  dv.setUint32(p, 0xffffffff, true); dv.setUint32(p + 4, base.root, true); dv.setUint32(p + 8, 17, true);
  dv.setUint32(p + 12, 1, true); dv.setUint32(p + 16, leaf, true); dv.setUint32(p + 20, 0, true);
  expect(dv.getUint32(p, true)).toBe(0xffffffff);
  return new SharedMap(type, p, undefined, a);
}
for (const type of ['string', 'object']) {
  test(`tagged journal, empty iterator and real overlay ${type}`, () => {
    const a = new Arena(), old = journal(type, a), oldValues = logical(old);
    a.leaf('string', 'alignment', ''); // 28 bytes, forcing a 4-mod-8 frontier.
    expect(a.used % 8).toBe(4);
    const end = a.used, before = payload(a), requests: number[] = [], alloc = a.alloc.bind(a);
    a.alloc = (n: number) => { requests.push(n); return alloc(n); };
    const emptyIterator = { length: 1, *[Symbol.iterator]() {} };
    const next = old.setMany(emptyIterator as any);
    expect(requests).toEqual([0]); expect(next).not.toBe(old); expect(next.root).not.toBe(old.root);
    expect(logical(next)).toEqual(oldValues); expect(payload(a, end)).toEqual(before);
    record(`zero/journal/${type}`, a, { root: next.root, requests: [...requests] });
    const changed = old.setMany(Array.from({ length: 5 }, (_, i) => [key(i), type === 'string' ? 'changed' : { changed: true }]) as any);
    expect(rows[rows.length - 1].requests).toEqual([0]);
    expect(changed.size).toBe(17); expect(logical(old)).toEqual(oldValues); expect(payload(a, end)).toEqual(before);
    const b = new Arena(), base = fresh(type, b).setMany(Array.from({ length: 64 }, (_, i) => [key(i), type === 'string' ? 'v' : {}]) as any);
    const overlay = base.set(key(0), (type === 'string' ? 'w' : { w: true }) as never), tag = b.dv.getUint32(overlay.root, true);
    expect(tag).not.toBe(0xffffffff); expect(tag >>> 31).toBe(1);
    const kept = payload(b), keptEnd = b.used, output = overlay.setMany([[key(1), type === 'string' ? 'x' : { x: true }], ['new', type === 'string' ? 'y' : { y: true }]] as any);
    expect(output.size).toBe(65); expect(payload(b, keptEnd)).toEqual(kept); expect(base.get(key(0))).toEqual(type === 'string' ? 'v' : {});
    rows.push({ name: `overlay/${type}`, tag, size: output.size });
  });
}

test('eight full FNV collisions reach terminal buckets and preserve forks', () => {
  expect(collisions.keys.length).toBe(8); expect(new Set(collisions.keys).size).toBe(8);
  for (const k of collisions.keys) expect(fnv(k)).toBe(collisions.target);
  for (const type of ['string', 'object']) {
    const a = new Arena(), old = fresh(type, a).setMany(collisions.keys.map((k, i) => [k, type === 'string' ? `v${i}` : { i }]) as any);
    let p = old.root;
    for (let depth = 0; depth < 8; depth++) { expect(a.dv.getUint32(p, true) & 3).toBe(1); p = a.dv.getUint32(p + 8, true); }
    expect(a.dv.getUint32(p, true)).toBe(2); expect(a.dv.getUint32(p + 8, true)).toBe(8);
    const end = a.used, before = payload(a), next = old.setMany(collisions.keys.map((k, i) => [k, type === 'string' ? `n${i}` : { n: i }]) as any);
    expect(next.size).toBe(8); expect(payload(a, end)).toEqual(before);
    for (const [i, k] of collisions.keys.entries()) { expect(old.get(k)).toEqual(type === 'string' ? `v${i}` : { i }); expect(next.get(k)).toEqual(type === 'string' ? `n${i}` : { n: i }); }
    record(`collision/${type}`, a, { size: next.size });
  }
});

for (const type of ['string', 'object']) for (const budget of [96, 160]) test(`fixed recursive allocation failure/recovery ${type}/${budget}`, () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }), a = new Arena({ memory });
  const retained = fresh('string', a).set('held', 'yes'); expect(retained.get('held')).toBe('yes');
  const end = a.used, before = payload(a), entries = collisions.keys.map(k => [k, type === 'string' ? 'v' : {}] as const);
  const data = A(entries.reduce((sum, [k]) => sum + Math.ceil((16 + k.length + (type === 'string' ? 1 : 2)) / 4) * 4, 0));
  const start = memory.buffer.byteLength - data - budget;
  a.alloc(start - A(a.used)); expect(a.used).toBe(start);
  const builderStart = start + data + (candidate && type === 'object' ? 0 : 32);
  let output: any, error: any;
  try { output = fresh(type, a).setMany(entries as any); } catch (caught) { error = caught; }
  const succeeds = candidate && type === 'object' && budget === 160;
  if (succeeds) { expect(error).toBeUndefined(); expect(output.size).toBe(8); }
  else {
    expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
    // A completed 48-byte bucket plus at least one 12-byte ancestor proves
    // failure happened while unwinding recursive batchAt, after input/leaves.
    expect(a.dv.getUint32(builderStart, true)).toBe(2); expect(a.dv.getUint32(builderStart + 8, true)).toBe(8);
    const completedBranches = (a.used - builderStart - 48) / 12;
    expect(Number.isInteger(completedBranches)).toBe(true); expect(completedBranches).toBeGreaterThanOrEqual(1); expect(completedBranches).toBeLessThan(8);
  }
  expect(payload(a, end)).toEqual(before); expect(retained.get('held')).toBe('yes'); expect(retained.set('held', 'yes')).toBe(retained);
  rows.push({ name: `oom/${type}/${budget}`, success: succeeds, used: a.used, builderStart, completedBranches: (a.used - builderStart - 48) / 12, error: error && { name: error.name, message: error.message } });
});

for (const type of ['string', 'object']) test(`terminal collision failure/recovery ${type}`, () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }), a = new Arena({ memory });
  const entries = collisions.keys.map(k => [k, type === 'string' ? 'v' : {}] as const), old = fresh(type, a).setMany(entries as any);
  const end = a.used, before = payload(a); expect(old.get(collisions.keys[0]!)).toEqual(type === 'string' ? 'v' : {});
  const data = A(entries.reduce((sum, [k]) => sum + Math.ceil((16 + k.length + (type === 'string' ? 1 : 2)) / 4) * 4, 0));
  const start = memory.buffer.byteLength - data - 120;
  a.alloc(start - A(a.used)); expect(a.used).toBe(start);
  const builderStart = start + data + (candidate && type === 'object' ? 0 : 32);
  expect(() => old.setMany(entries.map(([k]) => [k, type === 'string' ? 'n' : []]) as any)).toThrow(WebAssembly.RuntimeError);
  const completedBuckets = (a.used - builderStart) / 48;
  expect(completedBuckets).toBe(candidate && type === 'object' ? 2 : 1);
  for (let i = 0; i < completedBuckets; i++) { expect(a.dv.getUint32(builderStart + i * 48, true)).toBe(2); expect(a.dv.getUint32(builderStart + i * 48 + 8, true)).toBe(8); }
  const remaining = memory.buffer.byteLength - a.used;
  expect(remaining).toBe(candidate && type === 'object' ? 24 : 40); expect(payload(a, end)).toEqual(before);
  for (const [k, v] of entries) expect(old.get(k)).toEqual(v);
  const recovery = fresh(type, a).setMany([['', type === 'string' ? 'v' : {}]] as any);
  expect(recovery.get('')).toEqual(type === 'string' ? 'v' : {}); expect(payload(a, end)).toEqual(before);
  rows.push({ name: `oom/recovery/${type}`, completedBuckets, remaining, recoverySize: recovery.size, oldSize: old.size });
});

test('normalization reference remains replacement-character based', () => {
  expect(normalizeKey('\ud800')).toBe('\ufffd'); expect(normalizeKey('\udfff')).toBe('\ufffd');
  expect(arenaOf(fresh('string'))).toBeInstanceOf(Arena);
});
