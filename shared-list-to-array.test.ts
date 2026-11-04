import { describe, expect, it, vi } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { structureRegistry } from './codec';
import { SharedList, SharedMap, map } from './shared';

describe('SharedList array materialization', () => {
  it('keeps the original leaves when nested reconstruction grows the arena and creates a fork', () => {
    const childArena = new Arena();
    const children = Array.from({ length: 97 }, (_, i) => new SharedMap('number', 0, undefined, childArena).set('id', i));
    const list = new SharedList(map('number'), 0, 0, 0, new Arena()).pushMany(children);
    const owner = arenaOf(list), bytesBefore = owner.memory.buffer.byteLength, endBefore = owner.used;
    const publishedBefore = owner.buf.slice(HEAP_START, endBefore);
    const reconstruct = structureRegistry.SharedMap.fromWorkerData;
    let calls = 0, fork: typeof list | undefined;
    const restore = vi.spyOn(structureRegistry.SharedMap, 'fromWorkerData').mockImplementation((data, arena) => {
      if (++calls === 33) {
        owner.memory.grow(1);
        fork = list.set(64, children[0]).push(children[1]);
      }
      return reconstruct(data, arena);
    });
    try {
      expect(list.toArray().map(child => child.get('id'))).toEqual(children.map((_, i) => i));
      expect(calls).toBe(97);
      expect(owner.memory.buffer.byteLength).toBeGreaterThan(bytesBefore);
      expect(fork!.get(64)!.get('id')).toBe(0);
      expect(fork!.get(97)!.get('id')).toBe(1);
      expect(list.get(64)!.get('id')).toBe(64);
      expect(owner.buf.slice(HEAP_START, endBefore)).toEqual(publishedBefore);
    } finally { restore.mockRestore(); }
  });

  it('returns fresh mutable arrays without sharing elements with primitive snapshot storage', () => {
    for (const type of ['number', 'boolean'] as const) {
      const empty = new SharedList(type, 0, 0, 0, new Arena());
      const first = empty.toArray(), second = empty.toArray();
      expect(first).toEqual([]); expect(first).not.toBe(second);
      expect(Object.isFrozen(first)).toBe(false);
      const input = Array.from({ length: 65 }, (_, i) => type === 'number' ? i + 0.25 : i % 3 === 0);
      const original = empty.pushMany(input), fork = original.pop();
      const result = original.toArray();
      result[32] = type === 'number' ? -100 : !input[32];
      result.length = 1;
      expect(original.toArray()).toEqual(input);
      expect(fork.toArray()).toEqual(input.slice(0, -1));
    }
  });
});
