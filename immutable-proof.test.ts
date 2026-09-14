import { beforeEach, describe, expect, test } from 'vitest';
import * as S from './shared';
import { arenaOf, hashBytes, HEAP_START, popcount } from './arena';
import { configureAutoGC } from './shared-map';

function random(seed = 0x19abcd): () => number {
  let x = seed;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
}
function resetAll() {
  S.resetMap(); S.resetSharedList(); S.resetStack(); S.resetQueue();
  S.resetLinkedList(); S.resetDoublyLinkedList(); S.resetOrderedMap();
  S.resetSortedMap(); S.resetPriorityQueue();
}
beforeEach(resetAll);
function stackValues(s: any): any[] { const a = []; while (s.size) { a.push(s.peek()); s = s.pop(); } return a; }
function queueValues(s: any): any[] { const a = []; while (s.size) { a.push(s.peek()); s = s.dequeue(); } return a; }
function heapValues(s: any): any[] { const a = []; while (s.size) { a.push([s.peekPriority(), s.peek()]); s = s.dequeue(); } return a; }
function checkAVL(snapshot: any, root = snapshot.head ?? snapshot.root): void {
  const dv = arenaOf(snapshot).dv;
  const visit = (p: number): [number, number] => {
    if (!p) return [0, 0];
    const [ls, lh] = visit(dv.getUint32(p, true));
    const [rs, rh] = visit(dv.getUint32(p + 4, true));
    expect(Math.abs(lh - rh)).toBeLessThanOrEqual(1);
    const weight = snapshot.tailSize !== undefined ? dv.getUint32(p + 20, true) : 1;
    expect(weight).toBeGreaterThan(0); expect(weight).toBeLessThanOrEqual(32);
    expect(dv.getUint32(p + 8, true)).toBe(ls + rs + weight);
    expect(dv.getUint32(p + 12, true)).toBe(Math.max(lh, rh) + 1);
    return [ls + rs + weight, Math.max(lh, rh) + 1];
  };
  expect(visit(root)[0] + (snapshot.tailSize ?? 0)).toBe(snapshot.size);
}
function checkRadix(snapshot: any): void {
  const a = arenaOf(snapshot), dv = a.dv;
  const visit = (p: number, previous = -1, lookup = snapshot.root): number => {
    if (!p) return 0;
    const tag = dv.getUint32(p, true);
    if (!tag) { expect(a.radixFind(lookup, a.leafKey(p))).toBe(p); return 1; }
    if (tag === 0xffffffff) {
      const base = dv.getUint32(p + 4, true), n = dv.getUint32(p + 12, true);
      expect(n).toBeGreaterThan(0); expect(n).toBeLessThanOrEqual(4);
      let count = visit(base, -1, base); const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const leaf = dv.getUint32(p + 16 + i * 4, true), key = a.leafKey(leaf);
        expect(seen.has(key)).toBe(false); seen.add(key);
        expect(a.radixFind(p, key)).toBe(leaf);
        if (!a.radixFind(base, key)) count++;
      }
      expect(dv.getUint32(p + 8, true)).toBe(count); return count;
    }
    const critical = tag - 3;
    expect(critical).toBeGreaterThan(previous);
    const bitmap = dv.getUint32(p + 4, true);
    expect(bitmap & ~0x1ffff).toBe(0); expect(popcount(bitmap)).toBeGreaterThanOrEqual(2);
    let count = 0;
    for (let i = 0; i < popcount(bitmap); i++) count += visit(dv.getUint32(p + 16 + i * 4, true), critical, lookup);
    expect(dv.getUint32(p + 8, true)).toBe(count); return count;
  };
  expect(visit(snapshot.root)).toBe(snapshot.size);
  const keys = [...snapshot.keys()].map(k => new TextEncoder().encode(k));
  for (let i = 1; i < keys.length; i++) expect(Buffer.compare(keys[i - 1], keys[i])).toBeLessThan(0);
}
function checkHAMT(snapshot: any): void {
  const a = arenaOf(snapshot), dv = a.dv;
  const visit = (p: number, prefix: readonly number[], lookup = snapshot.root): number => {
    if (!p) return 0;
    const tag = dv.getUint32(p, true);
    if (tag === 0xffffffff) {
      expect(prefix).toEqual([]);
      const base = dv.getUint32(p + 4, true), n = dv.getUint32(p + 12, true);
      expect(n).toBeGreaterThan(0); expect(n).toBeLessThanOrEqual(4);
      let count = visit(base, [], base); const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const leaf = dv.getUint32(p + 16 + i * 4, true), key = a.leafKey(leaf);
        expect(seen.has(key)).toBe(false); seen.add(key); expect(a.find(p, key)).toBe(leaf);
        if (!a.find(base, key)) count++;
      }
      expect(dv.getUint32(p + 8, true)).toBe(count); return count;
    }
    if (tag === 0) {
      const hash = dv.getUint32(p + 4, true);
      for (let d = 0; d < prefix.length; d++) expect((hash >>> (d * 4)) & 15).toBe(prefix[d]);
      expect(a.find(lookup, a.leafKey(p))).toBe(p);
      return 1;
    }
    if (tag === 2) {
      const n = dv.getUint32(p + 8, true);
      for (let i = 0; i < n; i++) {
        const leaf = dv.getUint32(p + 16 + i * 4, true);
        expect(dv.getUint32(leaf + 4, true)).toBe(dv.getUint32(p + 4, true));
        visit(leaf, prefix, lookup);
      }
      return n;
    }
    if (tag & 0x80000000) {
      const patches: number[] = []; let base = p;
      while (dv.getUint32(base, true) & 0x80000000) {
        const t = dv.getUint32(base, true);
        expect((t >>> 21) & 15).toBeGreaterThan(0);
        expect((t >>> 21) & 15).toBeLessThanOrEqual(8);
        patches.push(base);
        const distance = (dv.getUint32(base, true) & 16383) * 4;
        expect(distance).toBeGreaterThan(0);
        const previous = base - distance;
        expect(previous).toBeGreaterThanOrEqual(HEAP_START);
        expect(previous).toBeLessThan(base); base = previous;
      }
      expect(patches.length).toBe((tag >>> 21) & 15);
      expect(dv.getUint32(base, true) & 3).toBe(1);
      const children = new Array<number>(16).fill(0);
      const original = dv.getUint32(base + 4, true); let offset = 0;
      for (let d = 0; d < 16; d++) if (original & (1 << d)) children[d] = dv.getUint32(base + 8 + offset++ * 4, true);
      let expectedSize = dv.getUint32(base, true) >>> 2, changed = 0;
      for (let i = patches.length - 1; i >= 0; i--) {
        const patch = patches[i], t = dv.getUint32(patch, true);
        const anchorWord = dv.getUint32(patch + 8, true);
        expect(patch - (anchorWord & 65535) * 4).toBe(base);
        const distance = ((t >>> 14) & 127) * 4;
        const child = distance ? patch - distance : 0;
        if (child) expect(child).toBeGreaterThanOrEqual(HEAP_START);
        const digits = dv.getUint32(patch + 4, true);
        children[digits & 15] = child;
        expectedSize += (t << 1) >> 26;
        changed = ((changed << 4) | (digits & 15)) >>> 0;
        expect(digits).toBe(changed);
        let bitmap = 0; for (let d = 0; d < 16; d++) if (children[d]) bitmap |= 1 << d;
        expect(bitmap).toBe(anchorWord >>> 16);
        expect(a.wasm.mapSize(patch)).toBe(expectedSize);
        for (let d = 0; d < 16; d++) expect(a.wasm.mapChild(patch, d)).toBe(children[d]);
      }
      let count = 0;
      for (let d = 0; d < 16; d++) if (children[d]) count += visit(children[d], [...prefix, d], lookup);
      expect(count).toBe(expectedSize); return count;
    }
    expect(tag & 3).toBe(1);
    const bm = dv.getUint32(p + 4, true);
    expect(bm & ~65535).toBe(0);
    let n = 0, i = 0;
    for (let digit = 0; digit < 16; digit++) if (bm & (1 << digit)) n += visit(dv.getUint32(p + 8 + i++ * 4, true), [...prefix, digit], lookup);
    expect(i).toBe(popcount(bm));
    expect(tag >>> 2).toBe(n);
    return n;
  };
  expect(visit(snapshot.root, [])).toBe(snapshot.size);
}

const cases = [
  ['SharedMap', () => new S.SharedMap('number').set('a', 1), (s: any) => s.setMany([['a', 2], ['b', 3]]).delete('a'), (s: any) => [...s.entries()]],
  ['SharedList', () => new S.SharedList('number').pushMany([1, 2, 3]), (s: any) => s.pushMany([4, 5]).set(1, 9).pop(), (s: any) => s.toArray()],
  ['SharedSet', () => new S.SharedSet().addMany([1, '1']), (s: any) => s.addMany([2, 3]).delete(1), (s: any) => [...s.values()]],
  ['SharedStack', () => new S.SharedStack('number').push(1).push(2), (s: any) => s.pop().push(3), stackValues],
  ['SharedQueue', () => new S.SharedQueue('number').enqueue(1).enqueue(2), (s: any) => s.dequeue().enqueue(3), queueValues],
  ['SharedLinkedList', () => new S.SharedLinkedList('number').append(1).append(2), (s: any) => s.prepend(3).insertAfter(0, 4).removeAfter(1), (s: any) => s.toArray()],
  ['SharedDoublyLinkedList', () => new S.SharedDoublyLinkedList('number').append(1).append(2), (s: any) => s.append(3).insertBefore(1, 4).remove(0).removeLast(), (s: any) => s.toArrayReverse()],
  ['SharedOrderedMap', () => new S.SharedOrderedMap('number').set('a', 1).set('b', 2), (s: any) => s.set('a', 3).delete('b').set('c', 4), (s: any) => [...s.entries()]],
  ['SharedOrderedSet', () => new S.SharedOrderedSet().add(1).add('1'), (s: any) => s.add(2).delete(1), (s: any) => [...s.values()]],
  ['SharedSortedMap', () => new S.SharedSortedMap('number').set('b', 1).set('a', 2), (s: any) => s.set('c', 3).delete('a'), (s: any) => [...s.entries()]],
  ['SharedSortedSet', () => new S.SharedSortedSet().add(1).add('1'), (s: any) => s.add(2).delete(1), (s: any) => [...s.values()]],
  ['SharedPriorityQueue', () => new S.SharedPriorityQueue('number').enqueue(1, 2).enqueue(2, 1), (s: any) => s.enqueue(3, 0).dequeue(), heapValues],
] as const;

describe('immutable published bytes and handles, all 12 structures', () => {
  for (const [name, create, update, read] of cases) test(name, () => {
    const old = create(), value = read(old), a = arenaOf(old);
    const end = a.used, prefix = a.buf.slice(HEAP_START, end);
    const first = update(old), fork = update(old);
    expect(first).not.toBe(old); expect(fork).not.toBe(old);
    expect(Object.isFrozen(old)).toBe(true); expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(old.toWorkerData())).toBe(true);
    expect(read(old)).toEqual(value);
    expect(read(first)).toEqual(read(fork));
    expect(a.buf.slice(HEAP_START, end)).toEqual(prefix);
    expect(Reflect.set(old, 'size', 999)).toBe(false);
  });
});

describe('forked model histories', () => {
  for (const [name, C] of [['HAMT', S.SharedMap], ['ordered', S.SharedOrderedMap], ['sorted', S.SharedSortedMap]] as const) test(`${name}: 500 branching versions`, () => {
    const rng = random(), versions: any[] = [new C('number')], models: Map<string, number>[] = [new Map()];
    for (let i = 0; i < 500; i++) {
      const parent = rng() % versions.length, key = `key${rng() % 60}`, value = rng();
      const m = new Map(models[parent]); let s = versions[parent];
      if (rng() % 3) { s = s.set(key, value); m.set(key, value); }
      else { s = s.delete(key); m.delete(key); }
      if (name === 'HAMT' && i % 5 === 0) {
        const entries: [string, number][] = [['patch', i], [key, i], ['patch', i + 1]];
        s = s.setMany(entries); for (const [k, v] of entries) m.set(k, v);
      }
      versions.push(s); models.push(m);
    }
    versions.forEach((s, i) => {
      const entries = [...models[i]];
      if (name !== 'ordered') { entries.sort(([a], [b]) => a.localeCompare(b)); expect([...s.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual(entries); }
      else expect([...s.entries()]).toEqual(entries);
      expect(s.size).toBe(models[i].size);
      if (name === 'HAMT') checkHAMT(s);
      if (name === 'sorted') checkRadix(s);
    });
  });
  for (const [name, C] of [['singly', S.SharedLinkedList], ['doubly', S.SharedDoublyLinkedList]] as const) test(`${name}: 500 branching versions and AVL ranks`, () => {
    const rng = random(42), versions: any[] = [new C('number')], models: number[][] = [[]];
    for (let i = 0; i < 500; i++) {
      const parent = rng() % versions.length, m = [...models[parent]];
      let s = versions[parent]; const index = rng() % Math.max(1, m.length);
      switch (rng() % 4) {
        case 0: s = s.prepend(i); m.unshift(i); break;
        case 1: s = s.append(i); m.push(i); break;
        case 2: if (m.length) { s = s.insertAfter(index, i); m.splice(index + 1, 0, i); } break;
        default: s = s.removeFirst(); m.shift();
      }
      versions.push(s); models.push(m);
    }
    versions.forEach((s, i) => { expect(s.toArray()).toEqual(models[i]); checkAVL(s); if (name === 'doubly') expect(s.toArrayReverse()).toEqual([...models[i]].reverse()); });
  });
  test('vector: partial blocks, level growth, overwrite, pop and forks', () => {
    const sizes = [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769];
    for (const size of sizes) {
      const input = Array.from({ length: size }, (_, i) => i);
      const s = new S.SharedList('number').pushMany(input);
      const tail = Array.from({ length: 67 }, (_, i) => -i);
      expect(s.pushMany(tail).toArray()).toEqual([...input, ...tail]);
      expect(s.toArray()).toEqual(input);
      if (size) { const fork = s.set(size - 1, -99); expect(fork.get(size - 1)).toBe(-99); expect(s.pop().toArray()).toEqual(input.slice(0, -1)); expect(s.get(size - 1)).toBe(size - 1); }
    }
  });
  test('queue and stack: 400 branching versions', () => {
    const rng = random(), versions = [{ queue: new S.SharedQueue('number'), stack: new S.SharedStack('number'), model: [] as number[] }];
    for (let i = 0; i < 400; i++) {
      const p = versions[rng() % versions.length], add = rng() % 3;
      versions.push(add ? { queue: p.queue.enqueue(i), stack: p.stack.push(i), model: [...p.model, i] } : { queue: p.queue.dequeue(), stack: p.stack.pop(), model: p.model.slice(1) });
      // Stack has the opposite removal end. Validate it against an independent stack history below.
    }
    for (const v of versions) expect(queueValues(v.queue)).toEqual(v.model);
    const stacks: any[] = [new S.SharedStack('number')], models: number[][] = [[]];
    for (let i = 0; i < 400; i++) {
      const p = rng() % stacks.length, add = rng() % 3;
      stacks.push(add ? stacks[p].push(i) : stacks[p].pop()); models.push(add ? [i, ...models[p]] : models[p].slice(1));
    }
    stacks.forEach((s, i) => expect(stackValues(s)).toEqual(models[i]));
  });
  for (const C of [S.SharedSet, S.SharedOrderedSet, S.SharedSortedSet]) test(`${C.name}: 400 branching versions`, () => {
    const rng = random(), versions: any[] = [new C()], models: Set<string | number>[] = [new Set()];
    for (let i = 0; i < 400; i++) {
      const p = rng() % versions.length, v = rng() % 2 ? i % 23 : `${i % 23}`, add = rng() % 3;
      const m = new Set(models[p]); add ? m.add(v) : m.delete(v);
      versions.push(add ? versions[p].add(v) : versions[p].delete(v)); models.push(m);
    }
    versions.forEach((s, i) => { expect(new Set(s.values())).toEqual(models[i]); expect(s.size).toBe(models[i].size); if (C === S.SharedOrderedSet) expect([...s.values()]).toEqual([...models[i]]); });
  });
  for (const maxHeap of [false, true]) test(`heap: branching histories, order, size and leftist ranks (max=${maxHeap})`, () => {
    const rng = random(), versions: any[] = [new S.SharedPriorityQueue('number', { maxHeap })], models: number[][] = [[]];
    for (let i = 1; i <= 300; i++) {
      const p = rng() % versions.length, add = rng() % 3;
      const model = [...models[p]].sort((a, b) => maxHeap ? b - a : a - b);
      versions.push(add ? versions[p].enqueue(i, i) : versions[p].dequeue());
      if (add) model.push(i); else model.shift(); models.push(model);
    }
    versions.forEach((s, i) => {
      const dv = arenaOf(s).dv;
      const visit = (p: number): [number, number] => {
        if (!p) return [0, 0];
        const left = dv.getUint32(p + 16, true), right = dv.getUint32(p + 20, true);
        const [ls, lr] = visit(left), [rs, rr] = visit(right);
        expect(lr).toBeGreaterThanOrEqual(rr); expect(dv.getUint32(p + 24, true)).toBe(rr + 1); expect(dv.getUint32(p + 28, true)).toBe(ls + rs + 1);
        for (const c of [left, right]) if (c) expect(maxHeap ? dv.getFloat64(p, true) >= dv.getFloat64(c, true) : dv.getFloat64(p, true) <= dv.getFloat64(c, true)).toBe(true);
        return [ls + rs + 1, rr + 1];
      };
      expect(visit(s.root)[0]).toBe(s.size);
      expect(heapValues(s).map(([, v]) => v)).toEqual([...models[i]].sort((a, b) => maxHeap ? b - a : a - b));
    });
  });
});

test('FNV-1a exact collision: scalar, bulk, merge, overwrite and delete', () => {
  const a = 'costarring', b = 'liquid';
  expect(hashBytes(new TextEncoder().encode(a))).toBe(hashBytes(new TextEncoder().encode(b)));
  for (const seed of [new S.SharedMap('number'), new S.SharedMap('number').set('other', 0)]) {
    const old = seed.set(a, 1).set(b, 2);
    const bulk = seed.setMany([[a, 1], [b, 2], [a, 3]]);
    expect(old.get(a)).toBe(1); expect(old.get(b)).toBe(2);
    expect(bulk.get(a)).toBe(3); expect(bulk.get(b)).toBe(2);
    expect(bulk.delete(a).get(b)).toBe(2); expect(bulk.delete(b).get(a)).toBe(3);
    expect(old.setMany([[b, 4], ['third', 5]]).get(a)).toBe(1);
    checkHAMT(bulk); checkHAMT(old);
  }
  const one = new S.SharedMap('number').set('abc', 1);
  for (const absent of ['', 'a', 'ab', 'abcd']) expect(one.delete(absent)).toBe(one);
});

test('batching has no 8-bit owner epoch or 1024-live-root limit', () => {
  configureAutoGC({ enabled: true, opsThreshold: 1, memoryThreshold: 1 });
  let s = new S.SharedMap('number').set('old', 7);
  const saved = [s];
  for (let i = 0; i < 1400; i++) { s = i % 2 ? s.set('x', i) : s.setMany([['x', i]]); saved.push(s); }
  saved.forEach((v, i) => { expect(v.get('old')).toBe(7); if (i) expect(v.get('x')).toBe(i - 1); });
  s.dispose(); expect(saved[0].get('old')).toBe(7); expect(s.get('x')).toBe(1399);
});

test('large keys, values, batches and UTF-16 replacement have no packed-pointer truncation', () => {
  const large = '🙂'.repeat(18000), key = 'key'.repeat(24000);
  const m = new S.SharedMap('string').set(key, large).setMany(Array.from({ length: 4500 }, (_, i) => [`k${i}`, `v${i}`]));
  expect(m.get(key)).toBe(large); expect(m.get('k4499')).toBe('v4499'); expect(m.size).toBe(4501);
  const l = new S.SharedList('string').pushMany(Array.from({ length: 20 }, (_, i) => large + i));
  expect(arenaOf(l).used).toBeGreaterThan(1048576); expect(l.get(19)).toBe(large + 19); expect(l.get(0)).toBe(large + 0);
  const unicode = new S.SharedMap('number').setMany([['\ud800', 1], ['�', 2]]);
  expect(unicode.size).toBe(1); expect(unicode.get('\ud800')).toBe(2);
  for (const C of [S.SharedList, S.SharedStack, S.SharedQueue, S.SharedLinkedList, S.SharedDoublyLinkedList, S.SharedPriorityQueue] as any[]) {
    const s = new C('string'); const v = s.push ? s.push(large) : s.append ? s.append(large) : s.enqueue(large, 1);
    expect(v.peek ? v.peek() : v.get ? v.get(0) : v.getFirst()).toBe(large);
  }
});

test('caller inputs and returned JSON objects cannot change stored values', () => {
  const creates = [
    (v: any) => new S.SharedMap('object').set('x', v), (v: any) => new S.SharedList('object').push(v),
    (v: any) => new S.SharedStack('object').push(v), (v: any) => new S.SharedQueue('object').enqueue(v),
    (v: any) => new S.SharedLinkedList('object').append(v), (v: any) => new S.SharedDoublyLinkedList('object').append(v),
    (v: any) => new S.SharedOrderedMap('object').set('x', v), (v: any) => new S.SharedSortedMap('object').set('x', v),
    (v: any) => new S.SharedPriorityQueue('object').enqueue(v, 1),
  ];
  for (const create of creates) {
    const input = { nested: [{ value: 1 }] }; const s: any = create(input); input.nested[0].value = 99;
    const value = s.peek ? s.peek() : s instanceof S.SharedList || s instanceof S.SharedLinkedList || s instanceof S.SharedDoublyLinkedList ? s.get(0) : s.get('x');
    expect(value.nested[0].value).toBe(1); expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Reflect.set(value.nested[0], 'value', 88)).toBe(false);
  }
  let calls = 0; const m = new S.SharedMap('object').set('x', { toJSON() { calls++; return { value: calls }; } });
  expect(calls).toBe(1); expect(m.get('x')).toEqual({ value: 1 });
});

test('reentrant and interleaved iterators survive nested reads and memory growth', () => {
  const m = new S.SharedMap('number').setMany(Array.from({ length: 1200 }, (_, i) => [`k${i}`, i]));
  const original = [...m.entries()], first = m.entries(), second = m.entries();
  expect(first.next().value).toEqual(second.next().value);
  const seen: any[] = [];
  m.forEach((v, k) => { seen.push([k, v]); expect(m.get(k)).toBe(v); if (seen.length === 1) { expect([...m.entries()]).toEqual(original); m.setMany(Array.from({ length: 15000 }, (_, i) => [`new${i}`, i])); } });
  expect(seen).toEqual(original); expect([...first]).toEqual(original.slice(1)); expect([...second]).toEqual(original.slice(1));
});

for (const copy of [true, false]) test(`worker snapshot attachment, nested dependencies, reset and read-only writes (copy=${copy})`, async () => {
  const items: Record<string, any> = Object.fromEntries(cases.map(([name, create]) => [name, create()]));
  const nested = new S.SharedMap('SharedList<number>').set('items', new S.SharedList('number').pushMany([1, 2, 3]));
  items.nested = nested;
  const data = S.getWorkerData(items, { copy }), attached: any = await S.initWorker(data);
  for (const [name, , , read] of cases) {
    // Extracting heap elements allocates, and is deliberately rejected on a worker.
    if (name === 'SharedPriorityQueue') { expect(attached[name].peek()).toBe(items[name].peek()); expect(() => attached[name].enqueue(8, 0)).toThrow(/read-only/); }
    else expect(read(attached[name])).toEqual(read(items[name]));
  }
  expect(attached.nested.get('items').toArray()).toEqual([1, 2, 3]);
  expect(() => attached.SharedMap.set('z', 9)).toThrow(/read-only/);
  expect(() => attached.SharedList.push(9)).toThrow(/read-only/);
  expect(() => attached.nested.get('items').push(9)).toThrow(/read-only/);
  const before = items.SharedMap.get('a'); resetAll();
  const other = await S.initWorker(S.getWorkerData({ m: new S.SharedMap('number').set('a', 100) }, { copy }));
  expect(other.m.get('a')).toBe(100); expect(attached.SharedMap.get('a')).toBe(before); expect(items.SharedMap.get('a')).toBe(before);
  expect(nested.get('items').toArray()).toEqual([1, 2, 3]);
});

test('nested values remain valid after their originating arena is reset', async () => {
  const first = new S.SharedList('number').pushMany([1, 2]);
  S.resetSharedList(); const second = new S.SharedList('number').pushMany([8, 9]);
  const m = new S.SharedMap('SharedList<number>').set('first', first).set('second', second);
  const w = await S.initWorker<{ m: typeof m }>(S.getWorkerData({ m }));
  expect(w.m.get('first').toArray()).toEqual([1, 2]); expect(w.m.get('second').toArray()).toEqual([8, 9]);
});

test('bulk vector construction has a deterministic linear allocation bound', () => {
  const s = new S.SharedList('number'), a = arenaOf(s), before = a.used;
  const values = Array.from({ length: 4096 }, (_, i) => i), v = s.pushMany(values);
  // 32768 input bytes + 32768 leaf bytes + branch nodes, including growth scaffolding.
  expect(a.used - before).toBeLessThan(68000); expect(v.toArray()).toEqual(values); expect(s.size).toBe(0);
});


test('empty map keys do not alias cached values; UTF-8 BOM is content', () => {
  const m = new S.SharedMap('string').set('', 'value').set('\ufeffkey', '\ufeffvalue');
  expect(m.get('')).toBe('value');
  expect(new Map(m.entries())).toEqual(new Map([['', 'value'], ['\ufeffkey', '\ufeffvalue']]));
  expect(m.get('\ufeffkey')).toBe('\ufeffvalue');
  expect(new S.SharedList('string').push('\ufeffvalue').get(0)).toBe('\ufeffvalue');
});
