import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedMap, SharedList, SharedStack, getWorkerData, initWorker, compact } from './shared';

const align4 = (n: number) => Math.ceil(n / 4) * 4;
const align8 = (n: number) => Math.ceil(n / 8) * 8;
describe('compact primitive bulk leaves', () => {
  for (const type of ['number', 'boolean'] as const) {
    for (let length = 3; length <= 10; length++) {
      it(`${type} packs ${length}-byte keys into four-byte-aligned leaf records`, () => {
        const a = new Arena(), count = 257, entries = Array.from({ length: count }, (_, i) => [
          'x'.repeat(length - 3) + i.toString(36).padStart(3, '0'), type === 'number' ? i + 0.25 : i % 2 === 0,
        ] as const);
        const map: any = new SharedMap(type, 0, 0, a).setMany(entries as any);
        const pointers = [...a.leaves(map.root)].sort((x, y) => x - y);
        const leafBytes = align4(16 + length + (type === 'number' ? 8 : 1));
        expect(pointers.length).toBe(count);
        pointers.forEach((pointer, i) => expect(pointer).toBe(HEAP_START + align8(count * 4) + i * leafBytes));
        for (const [key, value] of entries) expect(Object.is(map.get(key), value)).toBe(true);
        expect(a.wasm.mapSize(map.root)).toBe(count);
      });
    }

    it(`${type} retains forks, Unicode aliases, and alignment across later allocations`, async () => {
      const a = new Arena();
      const keys = ['0', '11', '222', '3333', '44444', '中文', '🙂', '\ufeffx', '\ud800', ''];
      const entries = keys.map((key, i) => [key, type === 'number' ? [NaN, -0, Infinity, -Infinity, 0.25][i % 5] : i % 2 === 0] as const);
      const base: any = new SharedMap(type, 0, 0, a).setMany(entries as any), before = a.buf.slice(HEAP_START, a.used);
      const value = type === 'number' ? 44.5 : false;
      const next = base.setMany([['222', value], ['\ufffd', value], ['new', value]]).delete('11');
      const list = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 1057 }, (_, i) => i + 0.25));
      const stack = new SharedStack('number', 0, 0, undefined, a).push(-0);
      a.alloc(262144);
      const { map: reader }: any = await initWorker(getWorkerData({ map: next }, { copy: false }));
      for (const [key, expected] of entries) expect(Object.is(base.get(key), expected)).toBe(true);
      expect(reader.get('222')).toBe(value); expect(reader.get('\ud800')).toBe(value);
      expect(reader.has('11')).toBe(false); expect(reader.get('new')).toBe(value);
      expect(next.size).toBe(keys.length); expect(reader.size).toBe(next.size);
      expect(list.get(1056)).toBe(1056.25); expect(Object.is(stack.peek(), -0)).toBe(true);
      expect(Buffer.compare(Buffer.from(a.buf.subarray(HEAP_START, HEAP_START + before.length)), Buffer.from(before))).toBe(0);
      expect([...compact(next).entries()].sort()).toEqual([...next.entries()].sort());
      expect(getWorkerData({ map: next }, { copy: false }).version).toBe(4);
      expect(() => reader.setMany([['x', value]])).toThrow(/read-only/);
    });
  }
});
