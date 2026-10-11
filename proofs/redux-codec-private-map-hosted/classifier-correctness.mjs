import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [armPath, engine, output] = process.argv.slice(2);
assert.ok(armPath && output && ['bun-source', 'node-portable'].includes(engine));
const arm = resolve(armPath);
// This fixture is inside the arm, so package self-reference uses its actual
// export map and shares constructors with its public Redux entry.
const { S, R } = await import(pathToFileURL(`${arm}/classifier-public-consumer.mjs`).href);
const require = createRequire(`${arm}/package.json`);
const { configureStore, createSlice } = require('@reduxjs/toolkit');
const jsan = require('jsan');
const Snapshot = Object.getPrototypeOf(S.SharedMap);
assert.equal(typeof Snapshot.owner, 'function');
const kinds = ['SharedMap', 'SharedList', 'SharedSet', 'SharedStack', 'SharedQueue',
  'SharedLinkedList', 'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedOrderedSet',
  'SharedSortedMap', 'SharedSortedSet', 'SharedPriorityQueue'];
const groups = [];
const codec = R.createZerocopyCodec();
function examples(empty) {
  const values = empty ? [] : [3, 1, 2];
  return kinds.map(kind => {
    let value = kind.endsWith('Set') ? new S[kind]() : new S[kind]('number');
    for (const n of values) {
      if (kind.endsWith('Map')) value = value.set(String(n), n);
      else if (kind.endsWith('Set')) value = value.add(n);
      else if (kind === 'SharedList' || kind === 'SharedStack') value = value.push(n);
      else if (kind === 'SharedQueue') value = value.enqueue(n);
      else if (kind === 'SharedPriorityQueue') value = value.enqueue(n, n);
      else value = value.append(n);
    }
    return value;
  });
}
const empty = examples(true), full = examples(false);
const record = Object.fromEntries(kinds.map((name, index) => [name, full[index]]));
const accepted = [];
for (const [label, values] of [['empty', empty], ['nonempty', full]]) {
  for (let index = 0; index < kinds.length; index++) {
    const value = values[index], before = value.toWorkerData();
    assert.equal(R.isSharedCollection(value), true);
    assert.equal(R.isZerocopyCollection(value), true);
    assert.equal(R.isZerocopySerializable(value), true);
    assert.deepEqual(R.getZerocopyEntries(value), []);
    assert.deepEqual(value.toWorkerData(), before);
    assert.equal(value.size, label === 'empty' ? 0 : 3);
    accepted.push({ label, kind: kinds[index], size: value.size });
  }
}
const attachments = [];
for (const copy of [false, true]) {
  const attached = await S.initWorker(S.getWorkerData(record, { copy }));
  for (const kind of kinds) {
    const value = attached[kind];
    assert.equal(R.isSharedCollection(value), true);
    assert.equal(Snapshot.owner(value).readOnly, true);
    assert.deepEqual(codec.encode(value), codec.encode(record[kind]));
    attachments.push({ copy, kind, size: value.size, readOnly: true });
  }
}
class Subclass extends S.SharedMap {}
class ForeignSharedMap {}
const fake = Object.freeze(Object.create(S.SharedMap.prototype));
const plain = Object.freeze({ a: 1 });
const rejectedInputs = [
  ['null', null], ['undefined', undefined], ['false', false], ['zero', 0], ['nan', NaN],
  ['empty-string', ''], ['string', 'x'], ['bigint', 1n], ['symbol', Symbol('x')],
  ['function', () => 1], ['mutable-record', { a: 1 }], ['frozen-record', plain],
  ['frozen-array', Object.freeze([1])], ['null-prototype', Object.freeze(Object.create(null))],
  ['frozen-date', Object.freeze(new Date(0))], ['foreign-class', Object.freeze(new ForeignSharedMap())],
  ['fake-prototype', fake], ['subclass', new Subclass('number')],
  ['constructor-field', Object.freeze({ constructor: S.SharedMap })],
];
for (const [label, value] of rejectedInputs) assert.equal(R.isSharedCollection(value), false, label);
groups.push({ name: 'classes-and-boundaries', accepted, attachments,
  rejected: rejectedInputs.map(([label]) => label), attachmentMode: 'same-process-real-initWorker-no-worker-thread' });

// Only public inspection/owner hooks are intercepted. Private Map/Array
// intrinsics and constructors are never changed.
const observerRows = [];
function observe(label, value, expectedResult, expectedCalls, failAt) {
  const descriptors = [Object.getOwnPropertyDescriptor(Object, 'isFrozen'),
    Object.getOwnPropertyDescriptor(Object, 'getPrototypeOf'), Object.getOwnPropertyDescriptor(Snapshot, 'owner')];
  const calls = [], sentinel = new Error(`sentinel:${label}`);
  const targets = [[Object, 'isFrozen'], [Object, 'getPrototypeOf'], [Snapshot, 'owner']];
  let result, caught;
  try {
    targets.forEach(([target, name], index) => Object.defineProperty(target, name, {
      ...descriptors[index], value: function(input) {
        if (input === value) {
          calls.push({ name, receiver: this === target, argumentCount: arguments.length });
          if (failAt === name) throw sentinel;
        }
        return Reflect.apply(descriptors[index].value, this, arguments);
      },
    }));
    try { result = R.isSharedCollection(value); } catch (error) { caught = error; }
  } finally {
    targets.forEach(([target, name], index) => Object.defineProperty(target, name, descriptors[index]));
  }
  assert.deepEqual(calls.map(row => row.name), expectedCalls, label);
  assert.ok(calls.every(row => row.receiver && row.argumentCount === 1), label);
  if (failAt && failAt !== 'owner') assert.equal(caught, sentinel, label);
  else { assert.equal(caught, undefined, label); assert.equal(result, expectedResult, label); }
  observerRows.push({ label, calls, outcome: caught ? 'same-sentinel' : result });
}
for (let i = 0; i < kinds.length; i++) observe(kinds[i], full[i], true, ['isFrozen', 'getPrototypeOf', 'owner']);
observe('primitive-bypass', 7, false, []);
observe('unfrozen-bypass', { a: 1 }, false, ['isFrozen']);
observe('frozen-ordinary', plain, false, ['isFrozen', 'getPrototypeOf']);
observe('forged-owner-failure', fake, false, ['isFrozen', 'getPrototypeOf', 'owner']);
observe('freeze-error', full[0], undefined, ['isFrozen'], 'isFrozen');
observe('prototype-error', full[0], undefined, ['isFrozen', 'getPrototypeOf'], 'getPrototypeOf');
observe('owner-error-caught', full[0], false, ['isFrozen', 'getPrototypeOf', 'owner'], 'owner');

const proxyRows = [];
function proxyCase(label, target, failAt) {
  const trace = [], sentinel = new Error(`proxy:${label}`);
  const trap = (name, args) => { trace.push(name); if (failAt === name) throw sentinel; return Reflect[name](...args); };
  const proxy = new Proxy(target, {
    isExtensible: target => trap('isExtensible', [target]),
    ownKeys: target => trap('ownKeys', [target]),
    getOwnPropertyDescriptor: (target, key) => {
      trace.push(`descriptor:${String(key)}`);
      if (failAt === 'descriptor') throw sentinel;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf: target => trap('getPrototypeOf', [target]),
    get: (target, key, receiver) => { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
  });
  let result, caught;
  try { result = R.isSharedCollection(proxy); } catch (error) { caught = error; }
  if (failAt) assert.equal(caught, sentinel, label);
  else { assert.equal(caught, undefined, label); assert.equal(result, false, label); }
  assert.ok(!trace.some(item => item.startsWith('get:')), label);
  if (!failAt && target === plain) assert.deepEqual(trace, ['isExtensible', 'ownKeys', 'descriptor:a', 'getPrototypeOf']);
  if (!failAt && target === full[0]) assert.deepEqual(trace, ['isExtensible', 'ownKeys', 'descriptor:root', 'descriptor:valueType', 'descriptor:size', 'getPrototypeOf']);
  proxyRows.push({ label, trace, outcome: caught ? 'same-sentinel' : result });
}
proxyCase('ordinary', plain);
proxyCase('snapshot-brand-rejected', full[0]);
for (const trap of ['isExtensible', 'ownKeys', 'descriptor', 'getPrototypeOf']) proxyCase(`throw-${trap}`, plain, trap);
const revokedObject = Proxy.revocable({}, {}); revokedObject.revoke();
assert.throws(() => R.isSharedCollection(revokedObject.proxy), TypeError);
const revokedFunction = Proxy.revocable(() => 1, {}); revokedFunction.revoke();
assert.equal(R.isSharedCollection(revokedFunction.proxy), false);
groups.push({ name: 'observers-and-errors', observerRows, proxyRows, revokedObject: 'TypeError', revokedCallable: false });

// Getters on prototype methods make accidental public reads visible without
// replacing Object or private bookkeeping intrinsics.
const saved = [], readSentinel = new Error('Unexpected public collection read');
try {
  for (const kind of kinds) for (const name of ['entries', 'get', 'values', 'keys', 'forEach', 'toWorkerData']) {
    const prototype = S[kind].prototype;
    saved.push([prototype, name, Object.getOwnPropertyDescriptor(prototype, name)]);
    Object.defineProperty(prototype, name, { configurable: true, get() { throw readSentinel; } });
  }
  for (const value of full) assert.equal(R.isSharedCollection(value), true);
} finally {
  for (const [prototype, name, descriptor] of saved.reverse()) {
    if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete prototype[name];
  }
}
const map = new S.SharedMap('object').set('x', { nested: { n: 1 } });
const oldDescriptor = map.toWorkerData(), mapArena = Snapshot.owner(map), usedBefore = mapArena.used;
const readDescriptors = ['entries', 'get', 'values', 'keys', 'forEach'].map(name => [name, Object.getOwnPropertyDescriptor(S.SharedMap.prototype, name)]);
const middlewareErrors = [], originalError = console.error;
try {
  for (const [name] of readDescriptors) Object.defineProperty(S.SharedMap.prototype, name, { configurable: true, get() { throw readSentinel; } });
  console.error = (...args) => middlewareErrors.push(args.map(String).join(' '));
  assert.equal(R.isZerocopySerializable(map), true);
  assert.deepEqual(R.getZerocopyEntries(map), []);
  const state = Object.freeze({ map, plain: Object.freeze({ selected: 'x' }) });
  const store = configureStore({ reducer: (value = state) => value, middleware: get => get(R.zerocopyMiddlewareOptions), devTools: false });
  store.dispatch({ type: 'observe' });
  assert.equal(store.getState(), state);
  assert.deepEqual(R.sanitizeZerocopyState(state).map, { $zerocopy: 'SharedMap', size: 1, valueType: 'object' });
} finally {
  console.error = originalError;
  for (const [name, descriptor] of readDescriptors) Object.defineProperty(S.SharedMap.prototype, name, descriptor);
}
assert.deepEqual(middlewareErrors, []);
assert.deepEqual(map.toWorkerData(), oldDescriptor);
assert.equal(mapArena.used, usedBefore);
assert.deepEqual(map.get('x'), { nested: { n: 1 } });
const select = R.createSharedMapEntrySelector(state => state.map, state => state.key);
const first = select({ map, key: 'x' });
assert.equal(select({ map, key: 'x' }), first);
const next = map.set('other', { n: 2 });
assert.equal(select({ map: next, key: 'x' }), first);
assert.equal(select({ map, key: 'missing' }), undefined);
assert.deepEqual(map.get('x'), { nested: { n: 1 } });
groups.push({ name: 'public-no-scan-and-selectors', kindsChecked: kinds, middlewareErrors,
  oldSnapshotPreserved: true, descriptorsPreserved: true, unchangedArenaAllocation: true,
  earlySharedMapSelectorSameIdentity: true, unrelatedRootSameIdentity: true, missing: true });

const nested = new S.SharedMap('SharedList<object>').set('child', new S.SharedList('object').push({ deep: { n: 7 } }));
const special = Object.assign(Object.create(null), { field: undefined });
const state = Object.freeze({ collections: Object.freeze(record), nested, plain: Object.freeze({ title: '界🙂', values: Object.freeze([1, true, null]) }), special,
  marker: { $jsan: 'literal', $zerocopyReduxText: 'literal' }, numbers: [NaN, -0, Infinity, undefined] });
const encoded = codec.encode(state), portable = codec.decode(encoded);
assert.deepEqual(codec.encode(portable), encoded);
assert.deepEqual(codec.encode(codec.parse(codec.stringify(state))), encoded);
const config = R.createZerocopyDevToolsOptions({ mode: 'portable' }).serialize;
const jsanText = jsan.stringify(state, config.replacer, null, config.options);
const jsanRestored = jsan.parse(jsanText, config.reviver);
assert.deepEqual(codec.encode(jsanRestored), encoded);
const checkpoint = R.encodeZerocopyState(state), restored = R.decodeZerocopyState(checkpoint);
assert.deepEqual(codec.encode(restored), encoded);
assert.equal(Snapshot.owner(restored.collections.SharedMap).readOnly, false);
assert.equal(restored.collections.SharedMap.set('future', 9).get('future'), 9);
assert.equal(record.SharedMap.has('future'), false);
assert.deepEqual(restored.nested.get('child').get(0), { deep: { n: 7 } });
assert.equal(Object.isFrozen(restored.nested.get('child').get(0).deep), true);
// Public package identity and a real Toolkit reducer exercise the same export
// contract as the existing small Node package proof, without a second process.
const slice = createSlice({ name: 'classifier', initialState: { map: new S.SharedMap('number') }, reducers: {
  set(state) { state.map = state.map.set('answer', 42); },
} });
const store = configureStore({ reducer: slice.reducer, middleware: get => get(R.zerocopyMiddlewareOptions), devTools: false });
const before = store.getState(); store.dispatch(slice.actions.set());
assert.equal(R.isSharedCollection(store.getState().map), true);
assert.equal(store.getState().map.constructor, S.SharedMap);
assert.equal(before.map.size, 0); assert.equal(store.getState().map.get('answer'), 42);
groups.push({ name: 'codec-jsan-checkpoint-and-package', encoded,
  restoredKinds: kinds.map(kind => [kind, restored.collections[kind].size, R.isSharedCollection(restored.collections[kind])]),
  checkpointWritable: true, nestedFrozen: true, packageClassIdentity: true, toolkitOldSize: before.map.size, toolkitNewValue: 42 });

let sourceWrapper = null;
if (engine === 'bun-source') {
  const { sharedCollectionKind } = await import(pathToFileURL(`${arm}/redux-codec.ts`).href);
  assert.equal(sharedCollectionKind.name, 'sharedCollectionKind'); assert.equal(sharedCollectionKind.length, 1);
  assert.deepEqual(full.map(value => sharedCollectionKind(value)), kinds);
  sourceWrapper = { name: sharedCollectionKind.name, length: sharedCollectionKind.length };
}
const report = { schema: 1, kind: 'redux-classifier-correctness', engine, groups, sourceWrapper };
const bytes = JSON.stringify(report, null, 2) + '\n';
writeFileSync(output, bytes, { flag: 'wx' });
console.log(JSON.stringify({ schema: 1, kind: report.kind, engine, passed: true,
  groups: groups.map(group => group.name), outputSHA256: createHash('sha256').update(bytes).digest('hex') }));
