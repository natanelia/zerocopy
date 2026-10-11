import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData, threadId } from 'node:worker_threads';

const GROUPS = ['shape-and-public-order', 'generator-and-continuations', 'observer-and-exception-order', 'empty-public-boundaries'];
const sha = value => createHash('sha256').update(value).digest('hex');
const byKey = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const arena = map => map.arena; // The existing protected getter, available in source and portable JS.
const snapshot = a => ({ used: a.used, bytes: Buffer.from(a.buf.slice(65536, a.used)) });
const unchanged = (a, before) => assert.deepEqual(Buffer.from(a.buf.subarray(65536, before.used)), before.bytes);

// Independent native child resolution, not the JS iterator's scratch reconstruction.
function inspect(map) {
  const a = arena(map), dv = a.dv, events = [], wasm = a.wasm;
  function visit(p, journalDepth = 0) {
    if (!p) return [];
    const tag = dv.getUint32(p, true);
    if (tag === 0) { events.push(['leaf', p]); return [p]; }
    if (tag === 0xffffffff) {
      events.push(['journal', p, journalDepth + 1]);
      const edits = Array.from({ length: dv.getUint32(p + 12, true) }, (_, i) => dv.getUint32(p + 16 + 4 * i, true));
      const keys = new Set(edits.map(leaf => a.leafKey(leaf)));
      return edits.concat(visit(dv.getUint32(p + 4, true), journalDepth + 1).filter(leaf => !keys.has(a.leafKey(leaf))));
    }
    if (tag === 2) {
      events.push(['collision', p]);
      return Array.from({ length: dv.getUint32(p + 8, true) }, (_, i) => dv.getUint32(p + 16 + 4 * i, true)).flatMap(leaf => visit(leaf, journalDepth));
    }
    const overlay = !!(tag & 0x80000000);
    assert.ok(overlay || (tag & 3) === 1, 'valid HAMT branch');
    events.push([overlay ? 'overlay' : 'canonical', p]);
    const bitmap = overlay ? dv.getUint32(p + 8, true) >>> 16 : dv.getUint32(p + 4, true);
    const result = [];
    for (let digit = 0; digit < 16; digit++) if (bitmap & (1 << digit)) {
      const child = wasm.mapChild(p, digit) >>> 0;
      assert.ok(child); result.push(...visit(child, journalDepth));
    }
    return result;
  }
  const pointers = visit(map.root), overlayIndexes = events.flatMap((event, i) => event[0] === 'overlay' ? [i] : []);
  return { pointers, overlayNodes: events.filter(e => e[0] === 'overlay').map(e => e[1]),
    overlayBitmaps: events.filter(e => e[0] === 'overlay').map(e => dv.getUint32(e[1] + 8, true) >>> 16),
    canonicalCount: events.filter(e => e[0] === 'canonical').length,
    collisionCount: events.filter(e => e[0] === 'collision').length,
    journalDepth: Math.max(0, ...events.filter(e => e[0] === 'journal').map(e => e[2])),
    leavesBeforeFirstOverlay: overlayIndexes.length ? events.slice(0, overlayIndexes[0]).filter(e => e[0] === 'leaf').length : pointers.length };
}
function fnv(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function selectedKeys() {
  const wanted = [0, ...Array.from({ length: 8 }, (_, i) => (i << 4) | 8),
    ...Array.from({ length: 8 }, (_, i) => ((i + 8) << 4) | 12), ...Array.from({ length: 5 }, (_, i) => (i << 4) | 15)];
  const found = new Map();
  for (let i = 0; i < 65536 && found.size < wanted.length; i++) {
    const key = `lane${i}`, prefix = fnv(key) & 255;
    if (wanted.includes(prefix) && !found.has(prefix)) found.set(prefix, key);
  }
  assert.equal(found.size, wanted.length, 'bounded key fixture found every requested prefix');
  return wanted.map(prefix => { const key = found.get(prefix); assert.equal(fnv(key) & 255, prefix); return key; });
}
function makeJournal(S, base, edits, expected) {
  const a = arena(base), leaves = edits.map(([key, value]) => a.leaf('number', key, value));
  const root = a.alloc(16 + leaves.length * 4), dv = a.dv, model = new Map(expected);
  for (const [key, value] of edits) model.set(key, value);
  dv.setUint32(root, 0xffffffff, true); dv.setUint32(root + 4, base.root, true);
  dv.setUint32(root + 8, model.size, true); dv.setUint32(root + 12, leaves.length, true);
  leaves.forEach((leaf, i) => dv.setUint32(root + 16 + 4 * i, leaf, true));
  return [new S.SharedMap('number', root, model.size, a), [...model]];
}
function fixtures(S) {
  S.resetMap();
  const empty = new S.SharedMap('number'), single = empty.set('only', 1);
  const largeRows = Array.from({ length: 4096 }, (_, i) => [`key${i}`, i]);
  const large = empty.setMany(largeRows), collisionRows = [['costarring', 1], ['liquid', 2]], collision = empty.setMany(collisionRows);
  S.resetMap();
  const keys = selectedKeys(), initial = keys.slice(0, 17).map((key, i) => [key, i]);
  const old = new S.SharedMap('number').setMany(initial);
  const changed = old.set(keys[1], -1).delete(keys[8]).set(keys[9], -9);
  const additions = keys.slice(17).map((key, i) => [key, 100 + i]);
  const late = changed.setMany(additions), lateModel = new Map(initial);
  lateModel.set(keys[1], -1); lateModel.delete(keys[8]); lateModel.set(keys[9], -9); additions.forEach(([k, v]) => lateModel.set(k, v));
  const fork = old.set(keys[2], -2), forkModel = new Map(initial); forkModel.set(keys[2], -2);
  const [journal, journalRows] = makeJournal(S, late, [[keys[1], 41], ['journal-new', 42]], lateModel);
  const [nested, nestedRows] = makeJournal(S, journal, [['journal-new', 43], ['nested-new', 44]], journalRows);
  const cases = [
    ['empty', empty, []], ['single', single, [['only', 1]]], ['canonical-large', large, largeRows],
    ['collision', collision, collisionRows], ['canonical-old', old, initial], ['late-repeated-overlay', late, [...lateModel]],
    ['fork', fork, [...forkModel]], ['journal', journal, journalRows], ['nested-journal', nested, nestedRows],
  ];
  const shapes = Object.fromEntries(cases.map(([name, map]) => [name, inspect(map)]));
  assert.equal(empty.root, 0); assert.equal(arena(single).dv.getUint32(single.root, true), 0);
  assert.equal(arena(collision).dv.getUint32(collision.root, true), 2); assert.equal(shapes.collision.collisionCount, 1);
  for (const name of ['empty', 'single', 'canonical-large', 'collision', 'canonical-old']) assert.equal(shapes[name].overlayNodes.length, 0, name);
  assert.equal(shapes['canonical-large'].pointers.length, 4096); assert.ok(shapes['canonical-large'].canonicalCount > 0);
  assert.equal(arena(late).dv.getUint32(late.root, true) & 0x80000000, 0, 'late fixture root is canonical');
  assert.equal(shapes['late-repeated-overlay'].leavesBeforeFirstOverlay, 1, 'one leaf precedes first overlay');
  assert.ok(new Set(shapes['late-repeated-overlay'].overlayNodes).size >= 2, 'at least two distinct overlay visits');
  assert.equal(shapes['late-repeated-overlay'].overlayBitmaps[0] & shapes['late-repeated-overlay'].overlayBitmaps[1], 0, 'reused scratch sees disjoint branch bitmaps');
  assert.equal(shapes.journal.journalDepth, 1); assert.equal(shapes['nested-journal'].journalDepth, 2);
  return { cases, shapes, old, late, fork, journal, nested, empty, single, collision };
}
function checkPublic(name, map, expected, pointers = inspect(map).pointers) {
  const a = arena(map), before = snapshot(a), used = a.used;
  const expectedOrder = pointers.map(p => [a.leafKey(p), a.leafValue(map.valueType, p)]);
  assert.deepEqual([...a.leaves(map.root)], pointers, `${name}: leaf pointer order`);
  assert.deepEqual([...map.entries()], expectedOrder, `${name}: entry order`);
  assert.deepEqual([...map.entries()].sort(byKey), [...expected].sort(byKey), `${name}: independent entry values`);
  assert.deepEqual([...map.keys()], expectedOrder.map(([key]) => key), `${name}: key order`);
  assert.deepEqual([...map.values()], expectedOrder.map(([, value]) => value), `${name}: value order`);
  const callbacks = []; map.forEach((value, key) => callbacks.push([key, value]));
  assert.deepEqual(callbacks, expectedOrder, `${name}: callback order`); assert.equal(map.size, expected.length, `${name}: size`);
  // Hand-built journals exercise traversal; recursive journal lookup is not a public-writer fixture contract.
  if (name !== 'journal' && name !== 'nested-journal') {
    for (const [key, value] of expected) assert.deepEqual(map.get(key), value, `${name}: get(${JSON.stringify(key)})`);
  }
  assert.equal(a.used, used, `${name}: arena allocation`); unchanged(a, before);
  return { root: map.root, used, pointers, entries: expectedOrder, payloadSHA256: sha(before.bytes) };
}
function generatorChecks(f) {
  const a = arena(f.late), method = Object.getPrototypeOf(a).leaves;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a), 'leaves');
  assert.equal(method.name, 'leaves'); assert.equal(method.length, 1);
  assert.equal(Object.getPrototypeOf(method).constructor.name, 'GeneratorFunction');
  assert.deepEqual([descriptor.enumerable, descriptor.configurable, descriptor.writable], [false, true, true]);
  const pre = a.leaves(f.late.root); assert.equal(Object.getPrototypeOf(pre), method.prototype); assert.equal(pre[Symbol.iterator](), pre);
  const first = a.leaves(f.late.root);
  const sentinel = new Error('getter-stop'); let reads = 0;
  Object.defineProperty(a, 'dv', { configurable: true, get() { reads++; throw sentinel; } });
  try {
    assert.deepEqual(pre.return(17), { done: true, value: 17 });
    const thrown = a.leaves(f.late.root); assert.throws(() => thrown.throw(sentinel), e => e === sentinel);
    assert.equal(thrown.next().done, true); assert.equal(reads, 0);
    assert.equal(reads, 0);
    assert.throws(() => first.next(), e => e === sentinel); assert.equal(reads, 1); assert.equal(first.next().done, true);
    assert.deepEqual(a.leaves(0).next(), { done: true, value: undefined }); assert.equal(reads, 1);
  } finally { delete a.dv; }
  const maps = [f.late, f.old, f.fork], expected = maps.map(map => inspect(map).pointers), before = snapshot(a);
  const iterators = maps.map(map => a.leaves(map.root));
  let buffer = a.memory.buffer; a.memory.grow(1); assert.notEqual(a.memory.buffer, buffer);
  const results = iterators.map(it => [it.next().value]);
  buffer = a.memory.buffer; a.memory.grow(1); assert.notEqual(a.memory.buffer, buffer);
  let active = true;
  while (active) { active = false; iterators.forEach((it, i) => { const step = it.next(); if (!step.done) { results[i].push(step.value); active = true; } }); }
  assert.deepEqual(results, expected); unchanged(a, before); assert.equal(a.used, before.used);
  for (const action of ['return', 'throw']) {
    const iterator = a.leaves(f.late.root); assert.equal(iterator.next().value, expected[0][0]);
    if (action === 'return') assert.deepEqual(iterator.return(23), { value: 23, done: true });
    else assert.throws(() => iterator.throw(sentinel), e => e === sentinel);
    assert.equal(iterator.next().done, true);
  }
  const nested = a.leaves(f.nested.root), prefix = nested.next(); a.memory.grow(1);
  assert.deepEqual([prefix.value, ...nested], inspect(f.nested).pointers);
  const entries = [...f.late.entries()], visited = [];
  f.late.forEach((value, key) => { assert.deepEqual([...f.late.entries()], entries); visited.push([key, value]); });
  assert.deepEqual(visited, entries); assert.equal(Object.getPrototypeOf(a).leaves, method); unchanged(a, before);
  return { method: { name: method.name, length: method.length, generator: true }, creationGetterReads: reads,
    interleavedPointers: results, closeBeforeOverlay: ['return', 'throw'], nestedPointers: inspect(f.nested).pointers, callbackReentry: visited };
}
function observe(map, mode) {
  const a = arena(map), proto = Object.getPrototypeOf(a), dvGetter = Object.getOwnPropertyDescriptor(proto, 'dv').get;
  const saved = new Map(), views = new Map(), trace = [], sentinel = new Error('observer-stop');
  let fail = null;
  const event = (...row) => { trace.push(row); if (fail === row[0]) { fail = null; throw sentinel; } };
  function replace(name, descriptor) { saved.set(name, Object.getOwnPropertyDescriptor(a, name)); Object.defineProperty(a, name, { configurable: true, ...descriptor }); }
  const leaves = a.leaves, wasm = a.wasm, key = a.leafKey, value = a.leafValue;
  replace('dv', { get() {
    event('dv'); const view = dvGetter.call(a);
    if (!views.has(view)) {
      views.set(view, Object.getOwnPropertyDescriptor(view, 'getUint32'));
      const get = view.getUint32;
      Object.defineProperty(view, 'getUint32', { configurable: true, value(...args) { event('getUint32', ...args); return get.apply(this, args); } });
    }
    return view;
  } });
  const forwardingWasm = Object.create(wasm);
  Object.defineProperty(forwardingWasm, 'journalFind', { get() { event('journalFind-get'); return function(...args) { event('journalFind-call', ...args); return wasm.journalFind(...args); }; } });
  replace('wasm', { get() { event('wasm-get'); return forwardingWasm; } });
  replace('leaves', { get() { event('leaves-get'); return leaves; } });
  replace('leafKey', { get() { event('leafKey-get'); return function(...args) { event('leafKey-call', ...args); return key.apply(this, args); }; } });
  replace('leafValue', { get() { event('leafValue-get'); return function(...args) { event('leafValue-call', ...args); return value.apply(this, args); }; } });
  let output;
  try {
    const iterator = map.entries(); assert.equal(trace.length, 0);
    const first = iterator.next(); assert.equal(first.done, false);
    if (mode === 'full') output = [first.value, ...iterator];
    else if (mode === 'close') {
      assert.equal(iterator.return().done, true); const count = trace.length;
      assert.equal(iterator.next().done, true); assert.equal(trace.length, count); output = [first.value];
    } else {
      fail = mode === 'getter-error' ? 'dv' : 'leafValue-call';
      assert.throws(() => iterator.next(), e => e === sentinel);
      const count = trace.length; assert.equal(iterator.next().done, true); assert.equal(trace.length, count); output = [first.value, 'observer-stop'];
    }
  } finally {
    for (const [view, descriptor] of views) descriptor ? Object.defineProperty(view, 'getUint32', descriptor) : delete view.getUint32;
    for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(a, name, descriptor) : delete a[name];
  }
  return { mode, output, trace };
}
function emptyBoundaryChecks(S, f) {
  const removedMap = f.single.delete('only'), freshSet = new S.SharedSet(), retainedSet = freshSet.add('only');
  const removedSet = retainedSet.delete('only');
  assert.equal(f.empty.root, 0); assert.equal(removedMap.root, 0);
  assert.equal(freshSet.toWorkerData().root, 0); assert.equal(removedSet.toWorkerData().root, 0);
  const rows = [
    ['fresh-map', f.empty, 'map'], ['removed-map', removedMap, 'map'],
    ['fresh-set', freshSet, 'set'], ['removed-set', removedSet, 'set'],
  ].map(([name, item, kind]) => {
    const a = arena(item), before = snapshot(a), used = a.used;
    const checks = emptyPublicChecks(item, kind);
    unchanged(a, before); assert.equal(a.used, used);
    return { name, kind, checks };
  });
  assert.deepEqual([...f.single.entries()], [['only', 1]]);
  assert.deepEqual([...retainedSet.values()], ['only']);

  // Borrowed public methods retain receiver/getter/call order; no collection
  // constructor, intrinsic constructor, Array method or allocator is intercepted.
  const borrowed = [], a = arena(f.empty), leaves = a.leaves;
  for (const name of ['entries', 'keys', 'values', 'forEach']) {
    const trace = [], unexpected = new Error('empty decoder accessed');
    const forwarding = {
      get leaves() { trace.push('leaves-get'); return function(root) { assert.equal(this, forwarding); trace.push(['leaves-call', root]); return leaves.call(a, root); }; },
      get leafKey() { throw unexpected; }, get leafValue() { throw unexpected; },
    };
    const receiver = {
      get arena() { trace.push('arena-get'); return forwarding; },
      get root() { trace.push('root-get'); return 0; },
      get valueType() { throw unexpected; },
    };
    let calls = 0;
    if (name === 'forEach') assert.equal(S.SharedMap.prototype[name].call(receiver, () => calls++), undefined);
    else {
      const iterator = S.SharedMap.prototype[name].call(receiver);
      assert.deepEqual(trace, []); assert.deepEqual(iterator.next(), { done: true, value: undefined });
      assert.deepEqual(iterator.next(), { done: true, value: undefined });
    }
    assert.equal(calls, 0);
    assert.deepEqual(trace, ['arena-get', 'leaves-get', 'root-get', ['leaves-call', 0]]);
    borrowed.push({ kind: 'map', method: name, trace, callbacks: calls });
  }
  for (const name of ['values', 'forEach']) {
    const trace = [], mapReceiver = {
      get arena() { trace.push('arena-get'); return a; },
      get root() { trace.push('root-get'); return 0; },
    };
    const mapProxy = { get keys() { trace.push('keys-get'); return function() { assert.equal(this, mapProxy); trace.push('keys-call'); return S.SharedMap.prototype.keys.call(mapReceiver); }; } };
    const receiver = { get _map() { trace.push('map-get'); return mapProxy; },
      get values() { trace.push('values-get'); return S.SharedSet.prototype.values; } };
    let calls = 0;
    if (name === 'forEach') assert.equal(S.SharedSet.prototype.forEach.call(receiver, () => calls++), undefined);
    else {
      const iterator = S.SharedSet.prototype.values.call(receiver);
      assert.deepEqual(trace, []); assert.deepEqual(iterator.next(), { done: true, value: undefined });
      assert.deepEqual(iterator.next(), { done: true, value: undefined });
    }
    assert.equal(calls, 0);
    assert.deepEqual(trace, [...(name === 'forEach' ? ['values-get'] : []), 'map-get', 'keys-get', 'keys-call', 'arena-get', 'root-get']);
    borrowed.push({ kind: 'set', method: name, trace, callbacks: calls });
  }

  const lazyErrors = [];
  for (const [kind, names, prototype, property] of [
    ['map', ['entries', 'keys', 'values'], S.SharedMap.prototype, 'arena'],
    ['set', ['values'], S.SharedSet.prototype, '_map'],
  ]) for (const name of names) {
    let reads = 0; const sentinel = new Error('receiver-stop');
    const receiver = { get [property]() { reads++; throw sentinel; } };
    const closed = prototype[name].call(receiver); assert.equal(reads, 0);
    assert.deepEqual(closed.return(17), { done: true, value: 17 }); assert.equal(reads, 0);
    const thrown = prototype[name].call(receiver); assert.throws(() => thrown.throw(sentinel), error => error === sentinel);
    assert.deepEqual(thrown.next(), { done: true, value: undefined }); assert.equal(reads, 0);
    const advanced = prototype[name].call(receiver); assert.equal(reads, 0);
    assert.throws(() => advanced.next(), error => error === sentinel); assert.equal(reads, 1);
    assert.deepEqual(advanced.next(), { done: true, value: undefined }); assert.equal(reads, 1);
    lazyErrors.push({ kind, method: name, firstNextGetterReads: reads, closedBeforeNextReads: 0, thrownBeforeNextReads: 0 });
  }
  for (const [kind, prototype, property] of [['map', S.SharedMap.prototype, 'arena'], ['set', S.SharedSet.prototype, 'values']]) {
    const sentinel = new Error('foreach-receiver-stop'); let reads = 0, callbacks = 0;
    const receiver = { get [property]() { reads++; throw sentinel; } };
    assert.throws(() => prototype.forEach.call(receiver, () => callbacks++), error => error === sentinel);
    assert.equal(reads, 1); assert.equal(callbacks, 0);
    lazyErrors.push({ kind, method: 'forEach', synchronousGetterReads: reads, callbacks });
  }

  // The guard is root-based, not metadata-based. Keep inconsistent internal
  // metadata and malformed nonzero pointers as explicit, bounded boundaries.
  const nonemptyWithZeroSize = new S.SharedMap('number', f.single.root, 0, arena(f.single));
  assert.deepEqual([...nonemptyWithZeroSize.entries()], [['only', 1]]);
  const zeroWithNonzeroSize = new S.SharedMap('number', 0, 1, a);
  assert.deepEqual([...zeroWithNonzeroSize.entries()], []);
  const malformed = [], badRoot = a.memory.buffer.byteLength;
  const badMap = new S.SharedMap('number', badRoot, 1, a);
  const badSet = new S.SharedSet(badMap);
  for (const [kind, item, names] of [['map', badMap, ['entries', 'keys', 'values']], ['set', badSet, ['values']]]) {
    for (const name of names) {
      const closed = item[name](); assert.deepEqual(closed.return(23), { done: true, value: 23 });
      const iterator = item[name](); assert.throws(() => iterator.next(), RangeError);
      assert.deepEqual(iterator.next(), { done: true, value: undefined });
      malformed.push({ kind, method: name, error: 'RangeError', firstNext: true });
    }
    let callbacks = 0; assert.throws(() => item.forEach(() => callbacks++), RangeError); assert.equal(callbacks, 0);
    malformed.push({ kind, method: 'forEach', error: 'RangeError', callbacks });
  }
  const direct = [];
  const saved = Object.getOwnPropertyDescriptor(a, 'dv'), sentinel = new Error('empty-view-stop'); let reads = 0;
  Object.defineProperty(a, 'dv', { configurable: true, get() { reads++; throw sentinel; } });
  try {
    for (const [label, root] of [['zero', 0], ['negative-zero', -0], ['nan', NaN]]) {
      const iterator = a.leaves(root); assert.equal(reads, 0);
      assert.deepEqual(iterator.next(), { done: true, value: undefined }); assert.deepEqual(iterator.next(), { done: true, value: undefined });
      assert.equal(reads, 0); direct.push({ label, completed: true, viewReads: reads });
    }
    const nonzero = a.leaves(badRoot); assert.equal(reads, 0);
    assert.throws(() => nonzero.next(), error => error === sentinel); assert.equal(reads, 1);
    assert.deepEqual(nonzero.next(), { done: true, value: undefined });
  } finally { saved ? Object.defineProperty(a, 'dv', saved) : delete a.dv; }
  return { rows, borrowed, lazyErrors, malformed, direct,
    retainedNonemptySnapshots: true, rootRatherThanSize: true, nonzeroFirstNextViewReads: reads };
}
async function corpus(S) {
  const f = fixtures(S), results = f.cases.map(([name, map, expected]) => ({ name, shape: f.shapes[name], ...checkPublic(name, map, expected, f.shapes[name].pointers) }));
  const continuations = generatorChecks(f);
  const observers = [
    ...['full', 'close', 'getter-error', 'decoder-error'].map(mode => ({ fixture: 'late', ...observe(f.late, mode) })),
    { fixture: 'nested-journal', ...observe(f.nested, 'full') },
  ];
  const emptyBoundaries = emptyBoundaryChecks(S, f);
  return { groups: [{ name: GROUPS[0], results }, { name: GROUPS[1], ...continuations }, { name: GROUPS[2], observations: observers },
    { name: GROUPS[3], ...emptyBoundaries }], fixtures: f };
}
function request(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Traversal worker timed out')), 10000);
    const receive = result => result.type === 'error' ? finish(new Error(result.error)) : finish(null, result);
    const fail = error => finish(error), exit = code => finish(new Error(`Worker exited before replying (${code})`));
    function finish(error, value) { clearTimeout(timer); worker.off('message', receive); worker.off('error', fail); worker.off('exit', exit); error ? reject(error) : resolve(value); }
    worker.once('message', receive); worker.once('error', fail); worker.once('exit', exit);
    try { worker.postMessage(message); } catch (error) { finish(error); }
  });
}
function checkArenaRows(actual, expected, stage) {
  const diagnostic = `${stage}: ${JSON.stringify({ expected, actual })}`, byID = new Map(expected.map(row => [row.id, row]));
  assert.equal(byID.size, expected.length, diagnostic); assert.equal(actual.length, expected.length, diagnostic);
  const seen = new Set();
  for (const row of actual) {
    assert.ok(!seen.has(row.id) && byID.has(row.id), diagnostic); seen.add(row.id);
    assert.deepEqual(row, byID.get(row.id), diagnostic);
  }
}
const arenaRows = snapshots => snapshots.map(item => ({ id: item.id, capacity: item.memory.buffer.byteLength, used: item.used,
  prefixSHA256: sha(new Uint8Array(item.memory.buffer, 65536, item.used - 65536)) }));
// Shared by the owner, actual worker readers, and an optional main-corpus group.
// Preparation creates ordinary generators; the returned checker can run after owner growth.
function prepareEmptyPublicChecks(item, kind) {
  assert.ok(kind === 'map' || kind === 'set', 'known empty collection kind');
  const a = arena(item), before = snapshot(a), root = item.toWorkerData().root;
  assert.equal(root, 0, 'empty public snapshot root'); assert.equal(item.size, 0, 'empty public snapshot size');
  const projectionNames = kind === 'map' ? ['entries', 'keys', 'values'] : ['values'];
  const factories = [['leaves', () => a.leaves(root)], ...projectionNames.map(name => [name, () => item[name]()])];
  const prepared = factories.map(([method, create]) => ({ method, first: create(), close: create(), thrown: create() }));
  let checked = false;
  return () => {
    assert.equal(checked, false, 'consume an empty iterator batch once'); checked = true;
    const projections = Object.fromEntries(projectionNames.map(name => [name, [...item[name]()]]));
    for (const name of projectionNames) assert.deepEqual(projections[name], [], `empty ${kind} ${name}`);
    let forEachCalls = 0; item.forEach(() => { forEachCalls++; }); assert.equal(forEachCalls, 0, 'empty forEach has no callback');
    const exhausted = iterator => {
      const step = iterator.next(); assert.deepEqual(step, { done: true, value: undefined }); return step;
    };
    const iterators = prepared.map(({ method, first, close, thrown }) => {
      const firstNext = exhausted(first), afterFirstNext = exhausted(first);
      const returnBeforeNext = close.return(17); assert.deepEqual(returnBeforeNext, { done: true, value: 17 });
      const afterReturn = exhausted(close), sentinel = new Error('empty-iterator-stop');
      let caught;
      try { thrown.throw(sentinel); } catch (error) { caught = error; }
      assert.equal(caught, sentinel, `empty ${kind} ${method} throw-before-next identity`);
      const afterThrow = exhausted(thrown);
      return { method, firstNext, afterFirstNext, returnBeforeNext, afterReturn,
        throwBeforeNextSameError: caught === sentinel, afterThrow };
    });
    assert.equal(item.toWorkerData().root, root); assert.equal(item.size, 0);
    assert.equal(a.used, before.used, 'empty checks allocate no arena bytes'); unchanged(a, before);
    return { kind, root, size: item.size, projections, forEachCalls, iterators };
  };
}
function emptyPublicChecks(item, kind) { return prepareEmptyPublicChecks(item, kind)(); }
const WORKER_EMPTY_CASES = [['empty', 'map'], ['empty-set', 'set'], ['emptied-map', 'map'], ['emptied-set', 'set']];
const WORKER_SET_NAMES = ['set', 'empty-set', 'emptied-set'];

async function workers(S, moduleURL, f) {
  S.resetMap();
  const objects = new S.SharedMap('object').setMany([['a', { nested: [1, 2] }], ['b', { nested: [3, 4] }]]);
  const set = new S.SharedSet().addMany([1, '1', 'two', 3]);
  const emptySet = new S.SharedSet(), populatedMap = new S.SharedMap('number').set('remove-me', 7);
  const emptiedMap = populatedMap.delete('remove-me'), populatedSet = emptySet.add(0).add('0');
  const emptiedSet = populatedSet.delete(0).delete('0');
  assert.deepEqual([...populatedMap.entries()], [['remove-me', 7]], 'retained public map before deleting last key');
  assert.equal(populatedSet.size, 2); assert.ok(populatedSet.has(0)); assert.ok(populatedSet.has('0'));
  const items = { empty: f.empty, single: f.single, canonical: f.old, late: f.late, fork: f.fork, collision: f.collision,
    journal: f.journal, nested: f.nested, objects, set, 'empty-set': emptySet, 'emptied-map': emptiedMap, 'emptied-set': emptiedSet };
  const expected = Object.fromEntries(Object.entries(items).map(([name, item]) => [name, WORKER_SET_NAMES.includes(name) ? [...item.values()] : [...item.entries()]]));
  const expectedEmptyChecks = WORKER_EMPTY_CASES.map(([name, kind]) => ({ name, ...emptyPublicChecks(items[name], kind) }));
  assert.deepEqual([...expected.objects].sort(byKey), [['a', { nested: [1, 2] }], ['b', { nested: [3, 4] }]]);
  assert.deepEqual(new Set(expected.set), new Set([1, '1', 'two', 3]));
  const results = [];
  for (const copy of [false, true]) {
    const payload = S.getWorkerData(items, { copy });
    assert.ok(payload.arenas.every(item => copy ? item.copy && !item.memory : item.memory && !item.copy));
    const originals = S.getWorkerData(items, { copy: false }).arenas.map(item => ({ id: item.id, memory: item.memory, used: item.used, bytes: Buffer.from(new Uint8Array(item.memory.buffer).slice(65536, item.used)) }));
    const initialRows = payload.arenas.map(item => ({ id: item.id,
      capacity: copy ? Math.max(2, Math.ceil(item.copy.byteLength / 65536)) * 65536 : item.memory.buffer.byteLength,
      used: item.used, prefixSHA256: sha(copy ? item.copy.subarray(65536, item.used) : new Uint8Array(item.memory.buffer, 65536, item.used - 65536)) }));
    const transportDiagnostics = { structureIDs: Object.entries(payload.structures).map(([name, item]) => [name, item.arena]), stages: [] };
    function checkStage(stage, observed) {
      const expectedRows = stage === 'attach' || copy ? initialRows : arenaRows(originals);
      checkArenaRows(observed, expectedRows, `${copy ? 'copy' : 'shared'} ${stage}`);
      transportDiagnostics.stages.push({ stage, expected: expectedRows, observed });
    }
    const emptyIterationChecks = [];
    function checkEmptyStage(stage, createdAt, observed) {
      assert.deepEqual(observed, expectedEmptyChecks, `${copy ? 'copy' : 'shared'} ${stage}: empty checks`);
      emptyIterationChecks.push({ stage, createdAt, results: observed });
    }
    const worker = new Worker(new URL(import.meta.url), { workerData: { moduleURL } });
    try {
      const attached = await request(worker, { type: 'attach', data: payload });
      assert.equal(attached.type, 'created'); assert.equal(attached.workerThread, true); checkStage('attach', attached.arenas);
      assert.deepEqual(attached.structureIDs, transportDiagnostics.structureIDs, 'attached structure arena IDs');
      transportDiagnostics.observedStructureIDs = attached.structureIDs;
      checkEmptyStage('attach', 'attach', attached.emptyChecks);
      for (const item of originals) item.memory.grow(1);
      const paused = await request(worker, { type: 'first' }); assert.equal(paused.type, 'paused');
      checkStage('pause', paused.arenas); checkEmptyStage('pause', 'attach', paused.emptyChecks);
      for (const item of originals) item.memory.grow(1);
      const newer = f.late.set('writer-new', 999); assert.equal(newer.get('writer-new'), 999); assert.equal(f.late.has('writer-new'), false);
      const reply = await request(worker, { type: 'resume' });
      assert.equal(reply.type, 'done'); assert.deepEqual(reply.result, expected);
      checkStage('resume', reply.arenas); checkEmptyStage('resume', 'pause', reply.emptyChecks);
      assert.equal(reply.allocatedSharedBytes, 0); assert.equal(reply.frozenObjects, true); assert.equal(reply.readOnlyRejections, Object.keys(items).length);
      for (const item of originals) assert.deepEqual(Buffer.from(new Uint8Array(item.memory.buffer, 65536, item.bytes.length)), item.bytes, `writer prefix ${item.id}`);
      results.push({ copy, workerThread: true, snapshots: Object.keys(items).length, shape: reply.shape,
        result: reply.result, frozenObjects: true, readOnlyRejections: reply.readOnlyRejections, allocatedSharedBytes: 0,
        readerObservedWriterGrowth: !copy, interleavedIteratorsPerMap: 2, transportDiagnostics, emptyIterationChecks });
    } finally { await worker.terminate(); }
  }
  return results;
}
if (!isMainThread) {
  const S = await import(workerData.moduleURL); let items, pending, snapshots, pendingEmptyChecks;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'attach') {
        assert.ok(threadId > 0); items = await S.initWorker(message.data);
        const shape = inspect(items.late); assert.equal(shape.leavesBeforeFirstOverlay, 1); assert.ok(new Set(shape.overlayNodes).size >= 2);
        assert.equal(inspect(items.canonical).overlayNodes.length, 0); assert.equal(inspect(items.collision).collisionCount, 1);
        assert.equal(inspect(items.nested).journalDepth, 2);
        pending = Object.fromEntries(Object.entries(items).filter(([name]) => !WORKER_SET_NAMES.includes(name)).map(([name, item]) => [name, { iterators: [item.entries(), item.entries()], output: [[], []] }]));
        const structureIDs = Object.entries(items).map(([name, item]) => [name, arena(item).id]);
        assert.deepEqual(structureIDs, Object.entries(message.data.structures).map(([name, item]) => [name, item.arena]), 'worker structure descriptor identity');
        snapshots = S.getWorkerData(items, { copy: false }).arenas.map(item => ({ id: item.id, memory: item.memory, used: item.used, bytes: Buffer.from(new Uint8Array(item.memory.buffer).slice(65536, item.used)) }));
        const emptyChecks = WORKER_EMPTY_CASES.map(([name, kind]) => ({ name, ...emptyPublicChecks(items[name], kind) }));
        pendingEmptyChecks = WORKER_EMPTY_CASES.map(([name, kind]) => [name, prepareEmptyPublicChecks(items[name], kind)]);
        parentPort.postMessage({ type: 'created', workerThread: true, arenas: arenaRows(snapshots), structureIDs, emptyChecks });
      } else if (message.type === 'first') {
        for (const entry of Object.values(pending)) entry.iterators.forEach((iterator, i) => { const step = iterator.next(); if (!step.done) entry.output[i].push(step.value); });
        const emptyChecks = pendingEmptyChecks.map(([name, check]) => ({ name, ...check() }));
        pendingEmptyChecks = WORKER_EMPTY_CASES.map(([name, kind]) => [name, prepareEmptyPublicChecks(items[name], kind)]);
        parentPort.postMessage({ type: 'paused', arenas: arenaRows(snapshots), emptyChecks });
      } else if (message.type === 'resume') {
        const emptyChecks = pendingEmptyChecks.map(([name, check]) => ({ name, ...check() }));
        const result = {}; let readOnlyRejections = 0;
        // Visit payload order so the original ten report keys stay first and unchanged.
        for (const [name, item] of Object.entries(items)) {
          if (WORKER_SET_NAMES.includes(name)) {
            result[name] = [...item.values()]; assert.throws(() => item.add('forbidden'), /read-only/); readOnlyRejections++;
            continue;
          }
          const entry = pending[name];
          let active = true;
          while (active) { active = false; entry.iterators.forEach((iterator, i) => { const step = iterator.next(); if (!step.done) { active = true; entry.output[i].push(step.value); } }); }
          assert.deepEqual(entry.output[0], entry.output[1]);
          const expected = entry.output[0], callbacks = [];
          assert.deepEqual([...item.keys()], expected.map(([k]) => k)); assert.deepEqual([...item.values()], expected.map(([, v]) => v));
          item.forEach((value, key) => callbacks.push([key, value])); assert.deepEqual(callbacks, expected);
          assert.throws(() => item.set('forbidden', 1), /read-only/); readOnlyRejections++; result[name] = expected;
        }
        for (const value of items.objects.values()) { assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.nested)); }
        assert.equal(items.objects.get('a'), items.objects.get('a'));
        const after = S.getWorkerData(items, { copy: false }).arenas;
        checkArenaRows(after.map(item => ({ id: item.id, used: item.used })), snapshots.map(item => ({ id: item.id, used: item.used })), 'reader arena allocation');
        for (const item of snapshots) assert.deepEqual(Buffer.from(new Uint8Array(item.memory.buffer, 65536, item.bytes.length)), item.bytes, `reader prefix ${item.id}`);
        parentPort.postMessage({ type: 'done', result, shape: inspect(items.late), allocatedSharedBytes: 0, frozenObjects: true,
          readOnlyRejections, arenas: arenaRows(snapshots), emptyChecks });
      } else throw new Error('Unknown traversal worker message');
    } catch (error) { parentPort.postMessage({ type: 'error', error: String(error.stack ?? error) }); }
  });
} else {
  const [entry, engine, output] = process.argv.slice(2);
  assert.ok(entry && output); assert.ok(['bun-source', 'node-portable'].includes(engine));
  const moduleURL = pathToFileURL(entry).href, S = await import(moduleURL), result = await corpus(S);
  const report = { schema: 1, kind: 'empty-root-traversal-correctness', engine, groups: result.groups,
    workers: engine === 'node-portable' ? await workers(S, moduleURL, result.fixtures) : [] };
  const raw = JSON.stringify(report, null, 2) + '\n'; writeFileSync(output, raw, { flag: 'wx' });
  console.log(JSON.stringify({ schema: 1, kind: report.kind, engine, passed: true, groups: GROUPS, workerCases: report.workers.length, outputSHA256: sha(raw) }));
}
