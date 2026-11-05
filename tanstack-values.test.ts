import { describe, expect, it } from 'vitest';
import { Arena } from './arena';
import { SharedMap } from './shared-map';
import { SharedCollection } from './tanstack-db-collection';
import { getWorkerData, initWorker } from './shared';

type Row = { id: string; rank: number; metadata: { label: string; flags: boolean[] } };
const row = (id: string, rank: number): Row => ({ id, rank, metadata: { label: `row ${rank} 界`, flags: [true, rank % 2 === 0] } });
const normalized = (key: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(key));
function expected(map: SharedMap<'object'>, rows: readonly Row[]): Row[] {
  const values = new Map(rows.map(value => [normalized(value.id), value]));
  return [...map.keys()].map(key => values.get(key)!);
}

describe('SharedCollection value materialization', () => {
  it('returns fresh arrays in map order, including normalized and unusual keys', () => {
    const arena = new Arena(), empty = new SharedCollection<Row>('rows', new SharedMap('object', 0, 0, arena));
    expect(empty.toArray()).toEqual([]);
    expect(empty.toArray()).not.toBe(empty.toArray());
    const rows = ['', '__proto__', 'constructor', '\ud800', '\ufffd', '日本語🌏', '\uFEFF', 'x\0y'].map(row);
    const map = new SharedMap('object', 0, 0, arena).setMany(rows.map(value => [value.id, value]));
    const collection = new SharedCollection<Row>('rows', map), want = expected(map, rows);
    const output = collection.toArray();
    expect(output).toEqual(want);
    expect(collection.toArray()).not.toBe(output);
    output.reverse(); output.pop();
    expect(collection.toArray()).toEqual(want);
    for (const value of collection.toArray()) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.metadata)).toBe(true);
      expect(Object.isFrozen(value.metadata.flags)).toBe(true);
    }
  });

  it('preserves cold shared/copy readers and subsequent entries and keyed reads', async () => {
    const arena = new Arena();
    const rows = Array.from({ length: 257 }, (_, i) => row(`道路-${i}-🌏-${'界'.repeat(40)}`, i));
    const map = new SharedMap('object', 0, 0, arena).setMany(rows.map(value => [value.id, value]));
    const want = expected(map, rows), expectedEntries = [...map.keys()].map((key, index) => [key, want[index]]);
    const used = arena.used, bytes = arena.copy();
    for (const copy of [false, true]) {
      const reader = (await initWorker(getWorkerData({ map }, { copy }))).map;
      const collection = new SharedCollection<Row>('rows', reader);
      // The reader has not decoded keys or objects before this operation.
      expect(collection.toArray()).toEqual(want);
      expect([...collection.entries()]).toEqual(expectedEntries);
      for (const value of rows) expect(collection.get(value.id)).toEqual(value);
      expect(() => collection.insert(row('forbidden', -1))).toThrow(/read-only/);
      expect(() => collection.delete(rows[0]!.id)).toThrow(/read-only/);
    }
    expect(arena.used).toBe(used);
    expect(arena.copy()).toEqual(bytes);
  });

  it('keeps old snapshots and decoded values unchanged after forks and memory growth', async () => {
    const arena = new Arena(), rows = Array.from({ length: 96 }, (_, i) => row(`row-${i}`, i));
    const map = new SharedMap('object', 0, 0, arena).setMany(rows.map(value => [value.id, value]));
    const collection = new SharedCollection<Row>('rows', map), want = expected(map, rows);
    const shared = new SharedCollection<Row>('rows', (await initWorker(getWorkerData({ map }, { copy: false }))).map);
    const copied = new SharedCollection<Row>('rows', (await initWorker(getWorkerData({ map }, { copy: true }))).map);
    const retained = collection.toArray();
    const changed = collection.update(rows[0]!.id, { rank: -1 }).delete(rows[1]!.id).insert(row('new', 1000));
    const oldBytes = arena.memory.buffer.byteLength;
    new SharedMap('object', 0, 0, arena).setMany(Array.from({ length: 4096 }, (_, i) => [`growth-${i}`, { id: `growth-${i}`, payload: 'x'.repeat(256) }]));
    expect(arena.memory.buffer.byteLength).toBeGreaterThan(oldBytes);
    for (const snapshot of [collection, shared, copied]) {
      expect(snapshot.toArray()).toEqual(want);
      expect([...snapshot.entries()].map(([, value]) => value)).toEqual(want);
    }
    expect(retained).toEqual(want);
    expect(changed.get(rows[0]!.id)?.rank).toBe(-1);
    expect(changed.get(rows[1]!.id)).toBeUndefined();
    expect(changed.get('new')).toEqual(row('new', 1000));
    expect(changed.toArray().map(value => value.id).sort()).toEqual([...rows.slice(0, 1), ...rows.slice(2), row('new', 1000)].map(value => value.id).sort());
  });
});
