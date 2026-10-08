import { describe, expect, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';

const values = [0, -0, NaN, Infinity, -Infinity, 1.25, -7.5];
function check(actual: unknown[], expected: unknown[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, i) => expect(Object.is(value, expected[i])).toBe(true));
}
describe('fixed-size immutable vector branch copies', () => {
  it('preserves every unchanged child lane and every old byte', () => {
    const a = new Arena(), input = a.alloc(1024 * 8);
    for (let i = 0; i < 1024; i++) a.dv.setFloat64(input + i * 8, i + 0.25, true);
    const root = a.wasm.vecLink(0, 0, 1, 0, input, 1024), replacement = a.alloc(256);
    for (let i = 0; i < 32; i++) a.dv.setFloat64(replacement + i * 8, -i - 0.25, true);
    const before = a.buf.slice(HEAP_START, a.used);
    for (let lane = 0; lane < 32; lane++) {
      const next = a.wasm.vecLink(root, 1, 1, lane * 32, replacement, 32);
      for (let i = 0; i < 32; i++) expect(a.dv.getUint32(next + i * 4, true)).toBe(i === lane ? replacement : a.dv.getUint32(root + i * 4, true));
      expect(a.wasm.vecGet(next, 1, lane * 32 + 31)).toBe(-31.25);
      expect(a.wasm.vecGet(root, 1, lane * 32 + 31)).toBe(lane * 32 + 31.25);
      expect(Buffer.compare(Buffer.from(a.buf.subarray(HEAP_START, HEAP_START + before.length)), Buffer.from(before))).toBe(0);
    }
  });

  it('keeps forks and vector depth boundaries intact through large bulk appends', async () => {
    for (const n of [31, 32, 33, 1023, 1024, 1025, 32769]) {
      const a = new Arena(), original = Array.from({ length: n }, (_, i) => values[i % values.length]);
      const base = new SharedList('number', 0, 0, 0, a).pushMany(original);
      const before = a.buf.slice(HEAP_START, a.used);
      new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(131072));
      const appended = Array.from({ length: 1025 }, (_, i) => values[(i + 3) % values.length]);
      const next = base.pushMany(appended), fork = base.pushMany(Array(33).fill(-2.5));
      check(base.toArray(), original); check(next.toArray(), [...original, ...appended]); check(fork.toArray(), [...original, ...Array(33).fill(-2.5)]);
      expect(Buffer.compare(Buffer.from(a.buf.subarray(HEAP_START, HEAP_START + before.length)), Buffer.from(before))).toBe(0);
      const { list }: any = await initWorker(getWorkerData({ list: next }, { copy: false }));
      check(list.toArray(), [...original, ...appended]);
    }
  });

  it('preserves encoded-value addresses through copied branches', () => {
    const strings = Array.from({ length: 1057 }, (_, i) => `value-🙂-${i}`);
    const base = new SharedList('string').pushMany(strings), appended = Array.from({ length: 1025 }, (_, i) => `new-中文-${i}`);
    const fork = base.pushMany(appended);
    expect(base.toArray()).toEqual(strings); expect(fork.toArray()).toEqual([...strings, ...appended]);
  });
});
