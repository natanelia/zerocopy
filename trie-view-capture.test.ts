import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedMap, SharedSortedMap, SharedSet, SharedSortedSet, SharedList, getWorkerData, initWorker } from './shared';
import { baselineLeaves, baselineMethods, fixtures, mapOf, methods, reference, utf8Compare, withMethods } from './proofs/trie-view-fixtures';

describe('radix view capture with unchanged HAMT controls', () => {
  it('keeps both generator methods and native iterator prototypes unchanged', () => {
    for (const name of methods) {
      const method = Arena.prototype[name], descriptor = Object.getOwnPropertyDescriptor(Arena.prototype, name)!;
      assert.equal(Object.getPrototypeOf(method).constructor.name, 'GeneratorFunction');
      assert.equal(Object.hasOwn(method, 'prototype'), true);
      assert.deepEqual([descriptor.enumerable, descriptor.configurable, descriptor.writable], [false, true, true]);
      const iterator = new Arena()[name](0);
      assert.equal(Object.getPrototypeOf(iterator), method.prototype); assert.equal(iterator[Symbol.iterator](), iterator);
    }
  });

  it('preserves creation, return-before-next, throw-before-next, and zero-root laziness', () => {
    for (const name of methods) for (const size of [0, 1, 32]) {
      const map = mapOf(size, name === 'radixLeaves'), a = arenaOf(map);
      Object.defineProperty(a, 'dv', { get() { throw new Error('view accessed'); }, configurable: true });
      const iterator = a[name](map.root);
      assert.equal(iterator.return(undefined).done, true);
      const thrown = a[name](map.root), error = new Error('stop');
      assert.throws(() => thrown.throw(error), e => e === error); assert.equal(thrown.next().done, true);
      if (!size) assert.deepEqual(a[name](0).next(), { value: undefined, done: true });
      else assert.throws(() => a[name](map.root).next(), /view accessed/);
      delete (a as any).dv;
    }
  });

  it('matches exact baseline pointer order and independent recursion across all trie shapes', () => {
    for (const { name, a, root, method } of fixtures()) {
      const expected = reference(a, root, method), before = a.buf.slice(HEAP_START, a.used), used = a.used;
      assert.deepEqual(baselineLeaves(a, root, method), expected, `${name}: baseline oracle`);
      assert.deepEqual([...a[method](root)], expected, `${name}: candidate oracle`);
      assert.equal(a.used, used, `${name}: zero shared allocation`);
      assert.deepEqual(a.buf.subarray(HEAP_START, used), before, `${name}: immutable source bytes`);
    }
  });

  it('captures after caller growth before first next and survives two interleaved paused traversals', () => {
    for (const method of methods) {
      const base = mapOf(512, method === 'radixLeaves'), fork = base.set('key17', -17).delete('key3'), a = arenaOf(base);
      const expected = [base, fork].map(map => baselineLeaves(a, map.root, method));
      const iterators = [base, fork].map(map => a[method](map.root));
      const beforeFirst = a.memory.buffer; a.memory.grow(2);
      assert.notEqual(a.memory.buffer, beforeFirst);
      const actual = iterators.map(iterator => [iterator.next().value!]);
      const captured = a.dv, beforePause = a.buf.slice(HEAP_START, a.used);
      new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(a.memory.buffer.byteLength * 2));
      assert.notEqual(a.memory.buffer, captured.buffer);
      assert.ok(captured.byteLength > Math.max(base.root, fork.root));
      const used = a.used;
      let pending = true;
      while (pending) { pending = false; iterators.forEach((iterator, i) => { const next = iterator.next(); if (!next.done) { pending = true; actual[i].push(next.value); } }); }
      assert.deepEqual(actual, expected); assert.equal(a.used, used);
      assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + beforePause.length), beforePause);
      assert.equal(base.get('key17'), 17); assert.equal(fork.get('key17'), -17);
    }
  });

  it('resumes journal yields across growth and captures each recursive iterator independently', () => {
    for (const { a, root, method, name } of fixtures().filter(f => f.name.includes('nested-journal-32'))) {
      const expected = baselineLeaves(a, root, method), iterator = a[method](root), first = iterator.next();
      a.memory.grow(1);
      assert.deepEqual([first.value, ...iterator], expected, name);
    }
  });

  it('retains close, throw, callback reentry and fresh iteration after termination', () => {
    for (const sorted of [false, true]) {
      const map = mapOf(128, sorted).set('key0', -1), expected = [...map.entries()], a = arenaOf(map), used = a.used;
      const first = map.entries(); first.next(); assert.equal(first.return(undefined).done, true); assert.equal(first.next().done, true);
      const second = map.entries(); second.next(); const error = new Error('stop');
      assert.throws(() => second.throw(error), e => e === error); assert.equal(second.next().done, true);
      const visited: unknown[] = [];
      map.forEach((value, key) => { assert.deepEqual([...map.entries()], expected); visited.push([key, value]); });
      assert.deepEqual(visited, expected); assert.equal(a.used, used);
    }
  });

  for (const type of ['number', 'boolean', 'string', 'object', 'SharedMap<number>', 'SharedList<number>']) {
    it(`preserves public projection order, Unicode and ${type} values`, () => {
      const keys = ['', 'a', 'é', '🙂', '\0', '\ufeff', '\ud800', 'costarring', 'liquid'];
      const values: any[] = type === 'number' ? [0, -0, NaN, Infinity, -Infinity, 3.5, -7, 2, 1]
        : type === 'boolean' ? keys.map((_, i) => !!(i % 2))
        : type === 'string' ? keys.map(k => `${k}🙂`)
        : type === 'object' ? keys.map((k, i) => ({ k, i, nested: [null, false, { value: '🙂' }] }))
        : type === 'SharedMap<number>' ? keys.map((_, i) => new SharedMap('number').set('child', i))
        : keys.map((_, i) => new SharedList('number').push(i));
      const normalize = (value: any): any => type.startsWith('SharedMap') ? [...value.entries()] : type.startsWith('SharedList') ? value.toArray() : value;
      for (const kind of ['ordinary', 'sorted', 'custom']) {
        let map: any = kind === 'ordinary' ? new SharedMap(type, 0, 0, new Arena()) : new SharedSortedMap(type, kind === 'custom' ? (a, b) => b.localeCompare(a) : undefined, 0, 0, new Arena());
        keys.forEach((key, i) => { map = map.set(key, values[i]); });
        const a = arenaOf(map), expected = withMethods(a, baselineMethods, () => [...map.entries()].map(([key, value]) => [key, normalize(value)]));
        const used = a.used, before = a.buf.slice(HEAP_START, used);
        assert.deepEqual([...map.entries()].map(([key, value]) => [key, normalize(value)]), expected);
        assert.deepEqual([...map.keys()], expected.map(([key]) => key));
        assert.deepEqual([...map.values()].map(normalize), expected.map(([, value]) => value));
        const visited: any[] = []; map.forEach((value, key) => visited.push([key, normalize(value)])); assert.deepEqual(visited, expected);
        assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(HEAP_START, used), before);
      }
    });
  }

  it('preserves natural UTF-8 byte order independently of baseline traversal', () => {
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const keys = ['', 'a', 'é', '🙂', '\0', '\ufeff', '\ud800', 'costarring', 'liquid', '界'];
    let map = new SharedSortedMap('number', undefined, 0, 0, new Arena());
    keys.forEach((key, i) => { map = map.set(key, i); });
    const expected = keys.map(key => decoder.decode(encoder.encode(key))).sort(utf8Compare);
    assert.deepEqual([...map.keys()], expected);
    const canonical = map.set('flush', -1).delete('flush');
    assert.deepEqual([...canonical.keys()], expected);
  });

  for (const copy of [false, true]) it(`keeps ${copy ? 'copy' : 'shared'} attachments and ordinary/sorted sets unchanged`, async () => {
    let set = new SharedSet(), sorted = new SharedSortedSet();
    for (const value of [1, '1', 0, -1, NaN, Infinity, '', '🙂', 'é']) { set = set.add(value); sorted = sorted.add(value); }
    set = set.delete('1').add('1'); sorted = sorted.delete('1').add('1');
    const map = mapOf(128).set('key4', -4), ordered = mapOf(128, true).set('key4', -4);
    const items = { set, sorted, map, ordered }, attached = await initWorker<typeof items>(getWorkerData(items, { copy }));
    for (const name of ['set', 'sorted'] as const) {
      const a = arenaOf(items[name]), expected = withMethods(a, baselineMethods, () => [...items[name].values()]);
      assert.deepEqual([...attached[name].values()], expected);
      const used = arenaOf(attached[name]).used; [...attached[name].values()]; assert.equal(arenaOf(attached[name]).used, used);
    }
    for (const name of ['map', 'ordered'] as const) {
      assert.deepEqual([...attached[name].entries()], [...items[name].entries()]);
      assert.throws(() => attached[name].set('forbidden', 1), /read-only/);
    }
  });
});
