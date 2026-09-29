import { describe, it, expect } from 'vitest';
import { SharedMap, SharedList, SharedOrderedMap, SharedSortedMap, SharedStack, getWorkerData, initWorker, compact } from './shared';
import { Arena, arenaOf, HEAP_START } from './arena';

describe('bounded hot paths preserve immutable snapshots', () => {
  for (const C of [SharedMap, SharedOrderedMap, SharedSortedMap] as const) {
    for (const type of ['string', 'number', 'boolean'] as const) {
      it(`${C.name} ${type}: cached hits, misses, empty roots and forks`, () => {
        const original: any = new C(type);
        const first = type === 'string' ? 'one' : type === 'number' ? 1 : true;
        const second = type === 'string' ? 'two' : type === 'number' ? 2 : false;
        const a = original.set('key', first), b = a.set('key', second), deleted = b.delete('key');
        const fork = a.set('other', second);
        for (let i = 0; i < 50; i++) {
          expect(b.get('key')).toBe(second); expect(b.has('key')).toBe(true);
          expect(original.get('key')).toBeUndefined(); expect(original.has('key')).toBe(false);
          expect(a.get('key')).toBe(first); expect(fork.get('key')).toBe(first);
          expect(deleted.get('key')).toBeUndefined(); expect(deleted.has('key')).toBe(false);
        }
        const owner = arenaOf(a), before = owner.used;
        a.get('key'); expect(a.set('key', first)).toBe(a);
        expect(owner.used).toBe(before);
        expect(Object.isFrozen(a)).toBe(true);
      });
    }
  }
  it('keeps NaN, negative zero, zero and missing values distinct', () => {
    const a = new SharedMap('number').set('key', NaN);
    const b = a.set('key', -0), c = b.set('key', 0);
    for (let i = 0; i < 50; i++) {
      expect(Object.is(b.get('key'), -0)).toBe(true);
      expect(Number.isNaN(a.get('key'))).toBe(true);
      expect(Object.is(c.get('key'), 0)).toBe(true);
      expect(c.get('missing')).toBeUndefined();
    }
    b.get('key'); expect(b.set('key', 0)).not.toBe(b);
  });
  it('uses the right codec and ordered prefix in one shared arena', () => {
    const source = new Arena();
    const map = new SharedMap('string', 0, 0, source).set('key', 'plain');
    const ordered = new SharedOrderedMap('string', 0, 0, 0, 0, source).set('key', 'ordered');
    const number = new SharedMap('number', 0, 0, source).set('key', 123);
    for (let i = 0; i < 20; i++) {
      expect(map.get('key')).toBe('plain'); expect(ordered.get('key')).toBe('ordered'); expect(number.get('key')).toBe(123);
    }
  });
  it('falls back correctly beyond the entry and string-value budgets', () => {
    let map = new SharedMap('string');
    for (let i = 0; i < 17000; i++) map = map.set(`key${i}`, `value${i}`);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 17000; i++) {
      expect(map.has(`key${i}`)).toBe(true); expect(map.get(`key${i}`)).toBe(`value${i}`);
    }
    const large = 'x'.repeat(600000);
    const a = map.set('large', large), b = a.set('large', 'small');
    expect(a.get('large')).toBe(large); expect(b.get('large')).toBe('small'); expect(a.get('large')).toBe(large);
    expect(Object.keys((arenaOf(map) as any).reads).length).toBeGreaterThan(0);
    expect((arenaOf(map) as any).reads.slots.size).toBeLessThanOrEqual(16384);
    expect((arenaOf(a) as any).reads.valueBytes).toBeLessThanOrEqual(1048576);
  });
  it('handles Unicode, empty strings and the scratch boundary', () => {
    const strings = ['', 'x', 'x'.repeat(31), 'x'.repeat(32), 'x'.repeat(33), 'x'.repeat(49151), 'x'.repeat(49152), '\uFEFFstart', '中文🙂', '\ud800'];
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    let map = new SharedMap('string');
    const old = [];
    for (let i = 0; i < strings.length; i++) { old.push(map); map = map.set(`k${i}`, strings[i]); }
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < strings.length; i++) {
      expect(map.get(`k${i}`)).toBe(decoder.decode(encoder.encode(strings[i]))); expect(old[i].has(`k${i}`)).toBe(false);
    }
    const unicode = map.set('🙂', '值').set('\ud800', 'replacement');
    expect(unicode.get('🙂')).toBe('值'); expect(unicode.get('\uFFFD')).toBe('replacement');
  });
  it('does not confuse full-hash collisions', () => {
    // FNV-1a collision, also covered by the original invariant suite.
    const keyA = 'costarring', keyB = 'liquid';
    const a = new SharedMap('string').set(keyA, 'A').set(keyB, 'B');
    const b = a.set(keyA, 'changed').delete(keyB);
    for (let i = 0; i < 20; i++) {
      expect(a.get(keyA)).toBe('A'); expect(a.get(keyB)).toBe('B');
      expect(b.get(keyA)).toBe('changed'); expect(b.has(keyB)).toBe(false);
    }
  });
  it('read caches do not write any shared bytes in worker attachments', async () => {
    const source = new SharedMap('string', 0, 0, new Arena()).setMany(Array.from({ length: 200 }, (_, i) => [`key${i}`, `value${i}`] as const));
    const owner = arenaOf(source), before = owner.buf.slice(HEAP_START, owner.used);
    const { map } = await initWorker<{ map: SharedMap<'string'> }>(getWorkerData({ map: source }, { copy: false }));
    for (let i = 0; i < 200; i++) { expect(map.get(`key${i}`)).toBe(`value${i}`); expect(map.has(`key${i}`)).toBe(true); }
    expect(Buffer.compare(Buffer.from(owner.buf.subarray(HEAP_START, HEAP_START + before.length)), Buffer.from(before))).toBe(0);
    expect(() => map.set('key0', 'value0')).toThrow(/read-only/);
    const next = compact(source); expect(next.get('key199')).toBe('value199'); expect(source.get('key199')).toBe('value199');
  });
  it('vector leaf hints remain correct across edits, forks and growth', () => {
    const a = new SharedList('number').pushMany(Array.from({ length: 1057 }, (_, i) => i));
    const b = a.set(31, -31).set(32, -32), c = a.push(1057);
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 1057; i++) {
      expect(a.get(i)).toBe(i); expect(b.get(i)).toBe(i === 31 || i === 32 ? -i : i); expect(c.get(i)).toBe(i);
    }
    const visited: number[] = [];
    a.forEach((value, i) => { if (i === 0) a.pushMany(Array(20000).fill(1)); b.get(1000 - (i % 999)); visited.push(value); });
    expect(visited).toEqual(a.toArray());
  });
  it('a stack stores encoded values, not mutable caller objects', () => {
    const input = { nested: { value: 1 } };
    const a = new SharedStack('object').push(input), b = a.push({ nested: { value: 2 } });
    input.nested.value = 99;
    expect(a.peek()).toEqual({ nested: { value: 1 } }); expect(Object.isFrozen((a.peek() as any).nested)).toBe(true);
    expect(b.pop().peek()).toEqual(a.peek());
  });
});
