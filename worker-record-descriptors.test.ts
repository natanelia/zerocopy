import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';
import { SharedMap, resetMap } from './shared';
import { createSharedState } from './worker';

beforeEach(() => resetMap());
const map = () => new SharedMap('number').set('value', 1);

describe('shared-state record descriptors', () => {
  it('preserves null prototypes, special names, aliases and retained publications', () => {
    const first = map(), changed = first.set('value', 2);
    const input = Object.assign(Object.create(null), { first, alias: first, constructor: first, hasOwnProperty: first });
    input.__proto__ = first;
    const state = createSharedState(input, { copy: false });
    try {
      const old = state.current;
      assert.equal(Object.getPrototypeOf(old), null);
      assert.equal(Object.isFrozen(old), true);
      assert.deepEqual(Object.keys(old), Object.keys(input));
      assert.equal(old.__proto__, first); assert.equal(old.alias, old.first);
      assert.equal(state.publish({ ...input }), 0);
      assert.equal(state.current, old);
      assert.equal(state.publish({ ...input, first: changed }), 1);
      assert.equal(state.current.first, changed); assert.equal(state.current.alias, first);
      assert.equal(old.first.get('value'), 1); assert.equal(state.current.first.get('value'), 2);
      assert.equal(Object.isFrozen(input), false);
      assert.equal(input.first, first);
    } finally { state.dispose(); }
  });

  it('keeps symbol rejection before string-descriptor inspection', () => {
    const value = map(), marker = Symbol('field'), calls: string[] = [];
    const input = new Proxy({ first: value, [marker]: value }, {
      ownKeys(target) { calls.push('keys'); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { calls.push(typeof key === 'symbol' ? 'symbol' : key); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    assert.throws(() => createSharedState(input), error => error instanceof TypeError
      && error.message === 'Shared state cannot have enumerable symbol keys');
    assert.deepEqual(calls, ['keys', 'symbol']);
  });

  it('fetches later descriptors before reporting an enumerable string accessor', () => {
    const value = map(), marker = Symbol('hidden'), calls: string[] = [];
    let getterCalls = 0;
    const target = { get first() { getterCalls++; return value; }, last: value };
    Object.defineProperty(target, marker, { value, configurable: true });
    const input = new Proxy(target, {
      ownKeys(object) { calls.push('keys'); return Reflect.ownKeys(object); },
      getOwnPropertyDescriptor(object, key) { calls.push(typeof key === 'symbol' ? 'symbol' : key); return Reflect.getOwnPropertyDescriptor(object, key); },
    });
    assert.throws(() => createSharedState(input), error => error instanceof TypeError
      && error.message === 'Shared state cannot have getters or setters');
    assert.deepEqual(calls, ['keys', 'symbol', 'keys', 'first', 'last', 'symbol']);
    assert.equal(getterCalls, 0);
  });

  it('lets a later descriptor trap error take precedence over an earlier accessor', () => {
    const value = map(), marker = Symbol('hidden'), calls: string[] = [];
    const failure = new Error('later descriptor failed');
    const target = { get first() { throw new Error('Getter must not run'); }, last: value };
    Object.defineProperty(target, marker, { value, configurable: true });
    const input = new Proxy(target, {
      ownKeys(object) { calls.push('keys'); return Reflect.ownKeys(object); },
      getOwnPropertyDescriptor(object, key) {
        calls.push(typeof key === 'symbol' ? 'symbol' : key);
        if (key === 'last') throw failure;
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const state = createSharedState({ retained: value });
    try {
      const original = state.current;
      assert.throws(() => state.publish(input as never), error => error === failure);
      assert.deepEqual(calls, ['keys', 'symbol', 'keys', 'first', 'last']);
      assert.equal(state.current, original); assert.equal(state.version, 0);
    } finally { state.dispose(); }
  });

  it('still fetches a symbol descriptor that changes after the initial symbol check', () => {
    const value = map(), marker = Symbol('hidden'), calls: string[] = [];
    let symbolReads = 0;
    const target = { present: value };
    Object.defineProperty(target, marker, { value, configurable: true });
    Object.defineProperty(target, 'hidden', { configurable: true, get() { throw new Error('Hidden getter must not run'); } });
    const input = new Proxy(target, {
      ownKeys() { calls.push('keys'); return ['present', 'vanished', marker, 'hidden']; },
      getOwnPropertyDescriptor(object, key) {
        calls.push(typeof key === 'symbol' ? 'symbol' : key);
        if (key === marker) return { configurable: true, enumerable: ++symbolReads === 2, value };
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const state = createSharedState(input);
    try {
      assert.deepEqual(calls, ['keys', 'symbol', 'keys', 'present', 'vanished', 'symbol', 'hidden']);
      assert.deepEqual(Reflect.ownKeys(state.current), ['present']);
      assert.equal(state.current.present, value);
    } finally { state.dispose(); }
  });

  it('keeps canonical numeric-key ordering for a proxy with reordered own keys', () => {
    const value = map(), target = { '2': value, '1': value, name: value };
    const input = new Proxy(target, { ownKeys: () => ['name', '2', '1'] });
    const state = createSharedState(input);
    try { assert.deepEqual(Object.keys(state.current), ['1', '2', 'name']); }
    finally { state.dispose(); }
  });

  it('keeps the single-snapshot path and empty records', () => {
    const value = map(), single = createSharedState(value), empty = createSharedState(Object.create(null));
    try {
      assert.equal(single.current, value); assert.equal(single.publish(value), 0);
      assert.deepEqual(Object.keys(empty.current), []); assert.equal(Object.isFrozen(empty.current), true);
      assert.equal(empty.publish({}), 0);
    } finally { single.dispose(); empty.dispose(); }
  });
});
