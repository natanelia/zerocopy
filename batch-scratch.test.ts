import { describe, expect, test } from 'vitest';
import { arenaOf, hashBytes } from './arena';
import { SharedMap, SharedSet, compact, getWorkerData, initWorker, resetMap } from './shared';

// Genuine FNV-1a collisions exercise all eight recursive partition frames and
// the full-hash bucket path with more than the four-entry insertion fallback.
const collisions = ['costarring', 'liquid', 'full-collision-0-U<EY?',
  'full-collision-1-kJ5Nk', 'full-collision-2-N2dq9', 'full-collision-3-m1Fo*',
  'full-collision-4-Kxdu,', 'full-collision-5->WsG0'];
function poison(map: SharedMap<any>): void {
  arenaOf(map).buf.fill(0xa5, 8192, 10240);
}
function payload(map: SharedMap<any>): Uint8Array {
  const a = arenaOf(map); return a.buf.slice(65536, a.used);
}

describe('batch scratch reuse', () => {
  test('preserves snapshots and forks across small and partitioned batches', () => {
    resetMap();
    for (const count of [0, 1, 4, 5, 16, 257]) {
      const old = new SharedMap('number').set('old', 7), before = payload(old);
      const entries = Array.from({ length: count }, (_, i) => [`k${i}`, i] as const);
      poison(old); const next = old.setMany(entries);
      poison(old); const fork = old.setMany([['fork-a', 1], ['fork-b', 2], ['fork-c', 3], ['fork-d', 4], ['fork-e', 5]]);
      expect(new Map(next.entries())).toEqual(new Map([['old', 7], ...entries]));
      expect(fork.size).toBe(6); expect(fork.get('old')).toBe(7);
      expect([...old.entries()]).toEqual([['old', 7]]);
      expect(payload(old).slice(0, before.length)).toEqual(before);
    }
  });

  test('reinitializes every depth for full collisions and existing buckets', () => {
    resetMap();
    expect(new Set(collisions.map(k => hashBytes(new TextEncoder().encode(k)))).size).toBe(1);
    const empty = new SharedMap('number'); poison(empty);
    const old = empty.setMany(collisions.map((k, i) => [k, i] as const));
    const original = [...old.entries()], before = payload(old); poison(old);
    const next = old.setMany(collisions.slice(0, 6).map((k, i) => [k, i + 100] as const));
    expect(new Map(next.entries())).toEqual(new Map(collisions.map((k, i) => [k, i < 6 ? i + 100 : i])));
    expect([...old.entries()]).toEqual(original); expect(payload(old).slice(0, before.length)).toEqual(before);
    poison(old); expect(new Map(compact(old).entries())).toEqual(new Map(original));
  });

  test('preserves last-value semantics for normalized duplicates and Unicode strings', () => {
    resetMap();
    const old = new SharedMap('string').set('retained', '雪'), before = payload(old); poison(old);
    const entries = [['bad\ud800', 'first'], ['bad�', 'last'], ['🙂', 'one'], ['🙂', 'two'],
      ['', 'empty'], ['é', 'accent'], ['雪', 'snow'], ['\ufeff', 'BOM']] as const;
    const next = old.setMany(entries);
    expect(new Map(next.entries())).toEqual(new Map([['retained', '雪'], ['bad�', 'last'], ['🙂', 'two'],
      ['', 'empty'], ['é', 'accent'], ['雪', 'snow'], ['\ufeff', 'BOM']]));
    expect([...old.entries()]).toEqual([['retained', '雪']]); expect(payload(old).slice(0, before.length)).toEqual(before);
  });

  test('compacts attached map and set snapshots without making readers writable', async () => {
    resetMap();
    const map = new SharedMap('number').setMany(collisions.map((k, i) => [k, i] as const));
    const set = new SharedSet().addMany(Array.from({ length: 257 }, (_, i) => i % 2 ? i : `雪-${i}`));
    for (const copy of [false, true]) {
      const reader = await initWorker(getWorkerData({ map, set }, { copy }));
      expect([...compact(reader.map).entries()]).toEqual([...map.entries()]);
      expect([...compact(reader.set).values()]).toEqual([...set.values()]);
      expect(() => reader.map.setMany([['new', 1]])).toThrow(/read-only/);
      expect(() => reader.set.addMany(['new'])).toThrow(/read-only/);
    }
  });
});
