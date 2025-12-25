import { describe, test, expect, beforeEach } from 'vitest';
import { SharedLinkedList, resetLinkedList } from './shared-linked-list';

describe('SharedLinkedList', () => {
  beforeEach(() => resetLinkedList());

  describe('basic operations', () => {
    test('empty list', () => {
      const l = new SharedLinkedList('number');
      expect(l.isEmpty).toBe(true);
      expect(l.size).toBe(0);
      expect(l.getFirst()).toBeUndefined();
      expect(l.getLast()).toBeUndefined();
    });

    test('prepend', () => {
      const l = new SharedLinkedList('number').prepend(1).prepend(2).prepend(3);
      expect(l.size).toBe(3);
      expect(l.getFirst()).toBe(3);
      expect(l.getLast()).toBe(1);
    });

    test('append', () => {
      const l = new SharedLinkedList('number').append(1).append(2).append(3);
      expect(l.size).toBe(3);
      expect(l.getFirst()).toBe(1);
      expect(l.getLast()).toBe(3);
    });

    test('mixed prepend/append', () => {
      const l = new SharedLinkedList('number').append(2).prepend(1).append(3);
      expect(l.toArray()).toEqual([1, 2, 3]);
    });

    test('removeFirst', () => {
      const l = new SharedLinkedList('number').append(1).append(2).append(3).removeFirst();
      expect(l.toArray()).toEqual([2, 3]);
    });

    test('removeFirst to empty', () => {
      const l = new SharedLinkedList('number').append(1).removeFirst();
      expect(l.isEmpty).toBe(true);
      expect(l.removeFirst()).toBe(l);
    });

    test('get by index', () => {
      const l = new SharedLinkedList('number').append(10).append(20).append(30);
      expect(l.get(0)).toBe(10);
      expect(l.get(1)).toBe(20);
      expect(l.get(2)).toBe(30);
      expect(l.get(3)).toBeUndefined();
      expect(l.get(-1)).toBeUndefined();
    });
  });

  describe('insertAfter', () => {
    test('insert in middle', () => {
      const l = new SharedLinkedList('number').append(1).append(3).insertAfter(0, 2);
      expect(l.toArray()).toEqual([1, 2, 3]);
    });

    test('insert at end', () => {
      const l = new SharedLinkedList('number').append(1).append(2).insertAfter(1, 3);
      expect(l.toArray()).toEqual([1, 2, 3]);
      expect(l.getLast()).toBe(3);
    });

    test('insert out of bounds', () => {
      const l = new SharedLinkedList('number').append(1);
      expect(l.insertAfter(5, 2)).toBe(l);
      expect(l.insertAfter(-1, 2)).toBe(l);
    });
  });

  describe('removeAfter', () => {
    test('remove in middle', () => {
      const l = new SharedLinkedList('number').append(1).append(2).append(3).removeAfter(0);
      expect(l.toArray()).toEqual([1, 3]);
    });

    test('remove last element', () => {
      const l = new SharedLinkedList('number').append(1).append(2).append(3).removeAfter(1);
      expect(l.toArray()).toEqual([1, 2]);
    });

    test('remove out of bounds', () => {
      const l = new SharedLinkedList('number').append(1).append(2);
      expect(l.removeAfter(1)).toBe(l); // can't remove after last
      expect(l.removeAfter(-1)).toBe(l);
    });
  });

  describe('immutability', () => {
    test('prepend does not modify original', () => {
      const l1 = new SharedLinkedList('number').append(1);
      const l2 = l1.prepend(0);
      expect(l1.toArray()).toEqual([1]);
      expect(l2.toArray()).toEqual([0, 1]);
    });

    test('append does not modify original', () => {
      const l1 = new SharedLinkedList('number').append(1);
      const l2 = l1.append(2);
      expect(l1.size).toBe(1);
      expect(l2.size).toBe(2);
    });

    test('prepend branching works', () => {
      const base = new SharedLinkedList('number').prepend(1);
      const branch1 = base.prepend(2);
      const branch2 = base.prepend(3);
      expect(branch1.getFirst()).toBe(2);
      expect(branch2.getFirst()).toBe(3);
    });
  });

  describe('type: number', () => {
    test('integers', () => {
      const l = new SharedLinkedList('number').append(42).append(-100).append(0);
      expect(l.toArray()).toEqual([42, -100, 0]);
    });

    test('floats', () => {
      const l = new SharedLinkedList('number').append(3.14159).append(-2.5);
      expect(l.get(0)).toBeCloseTo(3.14159);
      expect(l.get(1)).toBe(-2.5);
    });

    test('special values', () => {
      const l = new SharedLinkedList('number').append(Infinity).append(-Infinity);
      expect(l.get(0)).toBe(Infinity);
      expect(l.get(1)).toBe(-Infinity);
    });
  });

  describe('type: string', () => {
    test('basic strings', () => {
      const l = new SharedLinkedList('string').append('hello').append('world');
      expect(l.toArray()).toEqual(['hello', 'world']);
    });

    test('empty string', () => {
      const l = new SharedLinkedList('string').append('').append('a');
      expect(l.get(0)).toBe('');
    });

    test('unicode', () => {
      const l = new SharedLinkedList('string').append('日本語').append('🎉🚀');
      expect(l.toArray()).toEqual(['日本語', '🎉🚀']);
    });

    test('long strings', () => {
      const long = 'x'.repeat(1000);
      const l = new SharedLinkedList('string').append(long);
      expect(l.getFirst()).toBe(long);
    });
  });

  describe('type: boolean', () => {
    test('true and false', () => {
      const l = new SharedLinkedList('boolean').append(true).append(false).append(true);
      expect(l.toArray()).toEqual([true, false, true]);
    });
  });

  describe('type: object', () => {
    test('simple objects', () => {
      const l = new SharedLinkedList('object').append({ a: 1 }).append({ b: 2 });
      expect(l.toArray()).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test('nested objects', () => {
      const obj = { x: { y: { z: [1, 2, 3] } } };
      const l = new SharedLinkedList('object').append(obj);
      expect(l.getFirst()).toEqual(obj);
    });

    test('arrays', () => {
      const l = new SharedLinkedList('object').append([1, 2, 3]).append(['a', 'b']);
      expect(l.toArray()).toEqual([[1, 2, 3], ['a', 'b']]);
    });
  });

  describe('iteration', () => {
    test('forEach', () => {
      const l = new SharedLinkedList('number').append(1).append(2).append(3);
      const items: [number, number][] = [];
      l.forEach((v, i) => items.push([v, i]));
      expect(items).toEqual([[1, 0], [2, 1], [3, 2]]);
    });

    test('toArray', () => {
      const l = new SharedLinkedList('string').append('a').append('b').append('c');
      expect(l.toArray()).toEqual(['a', 'b', 'c']);
    });

    test('empty forEach', () => {
      const l = new SharedLinkedList('number');
      const items: number[] = [];
      l.forEach(v => items.push(v));
      expect(items).toEqual([]);
    });
  });

  describe('stress tests', () => {
    test('1000 appends', () => {
      let l = new SharedLinkedList('number');
      for (let i = 0; i < 1000; i++) l = l.append(i);
      expect(l.size).toBe(1000);
      expect(l.getFirst()).toBe(0);
      expect(l.getLast()).toBe(999);
    });

    test('1000 prepends', () => {
      let l = new SharedLinkedList('number');
      for (let i = 0; i < 1000; i++) l = l.prepend(i);
      expect(l.size).toBe(1000);
      expect(l.getFirst()).toBe(999);
      expect(l.getLast()).toBe(0);
    });

    test('random access', () => {
      let l = new SharedLinkedList('number');
      for (let i = 0; i < 100; i++) l = l.append(i);
      for (let i = 0; i < 100; i++) expect(l.get(i)).toBe(i);
    });

    test('many string appends', () => {
      let l = new SharedLinkedList('string');
      for (let i = 0; i < 500; i++) l = l.append(`item${i}`);
      expect(l.size).toBe(500);
      expect(l.getFirst()).toBe('item0');
      expect(l.getLast()).toBe('item499');
    });
  });
});
