import { describe, expect, it } from 'vitest';
import { Arena } from './arena';
import { SharedMap, compact, getWorkerData, initWorker } from './shared';

describe('SharedMap.changedKeysSince', () => {
  it('reports insertions, removals and rewrites on either side of a fork', () => {
    const empty = new SharedMap('number', 0, undefined, new Arena());
    const base = empty.setMany(Array.from({ length: 1024 }, (_, i) => ['k' + i, i] as const));
    const left = base.set('k100', -1).delete('k4').set('left', 5);
    const right = base.set('k200', -2).delete('k8').set('right', 6);
    expect(left.changedKeysSince(base)).toEqual(new Set(['k100', 'k4', 'left']));
    expect(right.changedKeysSince(left)).toEqual(new Set(['k100', 'k4', 'left', 'k200', 'k8', 'right']));
    expect(left.changedKeysSince(right)).toEqual(right.changedKeysSince(left));
    expect(base.changedKeysSince(base)).toEqual(new Set());
    expect(empty.changedKeysSince(base)).toEqual(new Set(base.keys()));
    expect(base.changedKeysSince(empty)).toEqual(new Set(base.keys()));
    expect(base.get('k100')).toBe(100);
  });

  it('handles collision buckets, normalized Unicode keys and equal-value rewrites conservatively', () => {
    const before = new SharedMap('object', 0, undefined, new Arena()).setMany([
      ['costarring', { v: 1 }], ['liquid', { v: 2 }], ['\uD800', { v: 3 }], ['stable', { v: 4 }]
    ]);
    const after = before.delete('liquid').set('costarring', { v: 1 }).set('\uFFFD', { v: 5 }).set('新增/車道', { v: 6 });
    const keys = after.changedKeysSince(before);
    expect(keys.has('liquid')).toBe(true);
    expect(keys.has('\uFFFD')).toBe(true);
    expect(keys.has('新增/車道')).toBe(true);
    expect(keys.has('stable')).toBe(false);
    expect([...keys].every(k => ['liquid', 'costarring', '\uFFFD', '新增/車道'].includes(k))).toBe(true);
    expect(before.get('liquid')).toEqual({ v: 2 });
  });

  it('matches an independent oracle through dense edits and many sparse revisions', () => {
    let map = new SharedMap('number', 0, undefined, new Arena()).setMany(
      Array.from({ length: 2048 }, (_, i) => ['k' + i, i] as const));
    for (let rev = 0; rev < 20; rev++) {
      const before = map, old = new Map(before.entries());
      const writes = Array.from({ length: rev === 10 ? 1024 : 25 }, (_, i) =>
        ['k' + ((i * 7919 + rev * 31) % 2048), -1 - rev] as const);
      map = before.deleteMany(['k' + rev, 'missing']).setMany(writes);
      const next = new Map(map.entries());
      const expected = new Set([...old.keys(), ...next.keys()].filter(k =>
        old.has(k) !== next.has(k) || !Object.is(old.get(k), next.get(k))));
      const actual = map.changedKeysSince(before);
      for (const k of expected) expect(actual.has(k)).toBe(true);
      for (const k of actual) expect(old.has(k) || next.has(k)).toBe(true);
      expect(before.changedKeysSince(map)).toEqual(actual);
    }
  });

  it('uses one co-published attachment but never assumes identity across attachments or compaction', async () => {
    const before = new SharedMap('number', 0, undefined, new Arena()).setMany([['a', 1], ['b', 2], ['c', 3]]);
    const after = before.set('a', 4).delete('b').set('d', 5);
    for (const copy of [false, true]) {
      const both = await initWorker(getWorkerData({ before, after }, { copy }));
      expect(both.after.changedKeysSince(both.before)).toEqual(new Set(['a', 'b', 'd']));
      const separate = await initWorker(getWorkerData({ after }, { copy }));
      expect(separate.after.changedKeysSince(both.before)).toEqual(new Set(['a', 'b', 'c', 'd']));
      expect(both.before.get('a')).toBe(1);
    }
    expect(compact(after).changedKeysSince(after)).toEqual(new Set(['a', 'c', 'd']));
    const unrelated = new SharedMap('number', 0, undefined, new Arena()).set('x', 1);
    expect(unrelated.changedKeysSince(before)).toEqual(new Set(['a', 'b', 'c', 'x']));
    expect(() => after.changedKeysSince(new SharedMap('string') as any)).toThrow(TypeError);
  });
});
