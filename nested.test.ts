import { describe, test, expect, beforeEach } from 'vitest';
import { SharedMap, resetMap } from './shared-map';
import { SharedSet } from './shared-set';
import { SharedList, resetSharedList } from './shared-list';
import { SharedStack, resetStack } from './shared-stack';
import { SharedQueue, resetQueue } from './shared-queue';
import { SharedLinkedList, resetLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList, resetDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedOrderedMap, resetOrderedMap } from './shared-ordered-map';
import { SharedSortedMap, resetSortedMap } from './shared-sorted-map';
import { SharedPriorityQueue, resetPriorityQueue } from './shared-priority-queue';

beforeEach(() => {
  resetMap();
  resetSharedList();
  resetStack();
  resetQueue();
  resetLinkedList();
  resetDoublyLinkedList();
  resetOrderedMap();
  resetSortedMap();
  resetPriorityQueue();
});

describe('Nested Data Structures', () => {
  describe('SharedMap containing nested structures', () => {
    test('SharedMap<SharedSet<string>>', () => {
      const map = new SharedMap<'SharedSet<string>'>('SharedSet<string>');
      const set1 = new SharedSet<string>().add('a').add('b');
      const set2 = new SharedSet<string>().add('x').add('y').add('z');
      
      const map2 = map.set('users', set1).set('items', set2);
      
      expect(map2.size).toBe(2);
      
      const retrieved1 = map2.get('users')!;
      expect(retrieved1.has('a')).toBe(true);
      expect(retrieved1.has('b')).toBe(true);
      expect(retrieved1.has('c')).toBe(false);
      expect(retrieved1.size).toBe(2);
      
      const retrieved2 = map2.get('items')!;
      expect(retrieved2.has('x')).toBe(true);
      expect(retrieved2.has('y')).toBe(true);
      expect(retrieved2.has('z')).toBe(true);
      expect(retrieved2.size).toBe(3);
    });

    test('SharedMap<SharedList<number>>', () => {
      const map = new SharedMap<'SharedList<number>'>('SharedList<number>');
      const list1 = new SharedList('number').push(1).push(2).push(3);
      const list2 = new SharedList('number').push(10).push(20);
      
      const map2 = map.set('nums', list1).set('tens', list2);
      
      const retrieved1 = map2.get('nums')!;
      expect(retrieved1.get(0)).toBe(1);
      expect(retrieved1.get(1)).toBe(2);
      expect(retrieved1.get(2)).toBe(3);
      expect(retrieved1.size).toBe(3);
      
      const retrieved2 = map2.get('tens')!;
      expect(retrieved2.get(0)).toBe(10);
      expect(retrieved2.get(1)).toBe(20);
      expect(retrieved2.size).toBe(2);
    });

    test('SharedMap<SharedMap<string>>', () => {
      const outer = new SharedMap<'SharedMap<string>'>('SharedMap<string>');
      const inner1 = new SharedMap('string').set('name', 'Alice').set('city', 'NYC');
      const inner2 = new SharedMap('string').set('name', 'Bob').set('city', 'LA');
      
      const outer2 = outer.set('user1', inner1).set('user2', inner2);
      
      const retrieved1 = outer2.get('user1')!;
      expect(retrieved1.get('name')).toBe('Alice');
      expect(retrieved1.get('city')).toBe('NYC');
      
      const retrieved2 = outer2.get('user2')!;
      expect(retrieved2.get('name')).toBe('Bob');
      expect(retrieved2.get('city')).toBe('LA');
    });
  });

  describe('SharedList containing nested structures', () => {
    test('SharedList<SharedMap<number>>', () => {
      const list = new SharedList<'SharedMap<number>'>('SharedMap<number>');
      const map1 = new SharedMap('number').set('x', 10).set('y', 20);
      const map2 = new SharedMap('number').set('a', 100).set('b', 200);
      
      const list2 = list.push(map1).push(map2);
      
      expect(list2.size).toBe(2);
      
      const retrieved1 = list2.get(0)!;
      expect(retrieved1.get('x')).toBe(10);
      expect(retrieved1.get('y')).toBe(20);
      
      const retrieved2 = list2.get(1)!;
      expect(retrieved2.get('a')).toBe(100);
      expect(retrieved2.get('b')).toBe(200);
    });

    test('SharedList<SharedSet<string>>', () => {
      const list = new SharedList<'SharedSet<string>'>('SharedSet<string>');
      const set1 = new SharedSet<string>().add('hello');
      const set2 = new SharedSet<string>().add('world');
      
      const list2 = list.push(set1).push(set2);
      
      expect(list2.get(0)!.has('hello')).toBe(true);
      expect(list2.get(1)!.has('world')).toBe(true);
    });
  });

  describe('SharedStack containing nested structures', () => {
    test('SharedStack<SharedMap<string>>', () => {
      const stack = new SharedStack<'SharedMap<string>'>('SharedMap<string>');
      const map1 = new SharedMap('string').set('key', 'value1');
      const map2 = new SharedMap('string').set('key', 'value2');
      
      const stack2 = stack.push(map1).push(map2);
      
      expect(stack2.size).toBe(2);
      expect(stack2.peek()!.get('key')).toBe('value2');
      
      const stack3 = stack2.pop();
      expect(stack3.peek()!.get('key')).toBe('value1');
    });
  });

  describe('SharedQueue containing nested structures', () => {
    test('SharedQueue<SharedList<number>>', () => {
      const queue = new SharedQueue<'SharedList<number>'>('SharedList<number>');
      const list1 = new SharedList('number').push(1).push(2);
      const list2 = new SharedList('number').push(3).push(4);
      
      const queue2 = queue.enqueue(list1).enqueue(list2);
      
      expect(queue2.size).toBe(2);
      expect(queue2.peek()!.get(0)).toBe(1);
      expect(queue2.peek()!.get(1)).toBe(2);
      
      const queue3 = queue2.dequeue();
      expect(queue3.peek()!.get(0)).toBe(3);
    });
  });

  describe('SharedLinkedList containing nested structures', () => {
    test('SharedLinkedList<SharedSet<string>>', () => {
      const ll = new SharedLinkedList<'SharedSet<string>'>('SharedSet<string>');
      const set1 = new SharedSet<string>().add('first');
      const set2 = new SharedSet<string>().add('second');
      
      const ll2 = ll.append(set1).append(set2);
      
      expect(ll2.size).toBe(2);
      expect(ll2.getFirst()!.has('first')).toBe(true);
      expect(ll2.getLast()!.has('second')).toBe(true);
    });
  });

  describe('SharedDoublyLinkedList containing nested structures', () => {
    test('SharedDoublyLinkedList<SharedMap<number>>', () => {
      const dll = new SharedDoublyLinkedList<'SharedMap<number>'>('SharedMap<number>');
      const map1 = new SharedMap('number').set('val', 100);
      const map2 = new SharedMap('number').set('val', 200);
      
      const dll2 = dll.append(map1).append(map2);
      
      expect(dll2.size).toBe(2);
      expect(dll2.getFirst()!.get('val')).toBe(100);
      expect(dll2.getLast()!.get('val')).toBe(200);
    });
  });

  describe('SharedOrderedMap containing nested structures', () => {
    test('SharedOrderedMap<SharedList<string>>', () => {
      const om = new SharedOrderedMap<'SharedList<string>'>('SharedList<string>');
      const list1 = new SharedList('string').push('a').push('b');
      const list2 = new SharedList('string').push('x').push('y');
      
      const om2 = om.set('first', list1).set('second', list2);
      
      expect(om2.size).toBe(2);
      expect(om2.get('first')!.get(0)).toBe('a');
      expect(om2.get('second')!.get(0)).toBe('x');
      
      // Verify insertion order
      const keys = [...om2.keys()];
      expect(keys).toEqual(['first', 'second']);
    });
  });

  describe('SharedSortedMap containing nested structures', () => {
    test('SharedSortedMap<SharedSet<number>>', () => {
      const sm = new SharedSortedMap<'SharedSet<number>'>('SharedSet<number>');
      const set1 = new SharedSet<number>().add(1).add(2);
      const set2 = new SharedSet<number>().add(10).add(20);
      
      const sm2 = sm.set('b', set1).set('a', set2);
      
      expect(sm2.size).toBe(2);
      expect(sm2.get('a')!.has(10)).toBe(true);
      expect(sm2.get('b')!.has(1)).toBe(true);
      
      // Verify sorted order
      const keys = [...sm2.keys()];
      expect(keys).toEqual(['a', 'b']);
    });
  });

  describe('SharedPriorityQueue containing nested structures', () => {
    test('SharedPriorityQueue<SharedMap<string>>', () => {
      const pq = new SharedPriorityQueue<'SharedMap<string>'>('SharedMap<string>');
      const map1 = new SharedMap('string').set('name', 'low');
      const map2 = new SharedMap('string').set('name', 'high');
      
      const pq2 = pq.enqueue(map1, 10).enqueue(map2, 1);
      
      expect(pq2.size).toBe(2);
      expect(pq2.peek()!.get('name')).toBe('high'); // min-heap, priority 1 first
      
      const pq3 = pq2.dequeue();
      expect(pq3.peek()!.get('name')).toBe('low');
    });
  });

  describe('Immutability with nested structures', () => {
    test('modifying nested structure does not affect stored version', () => {
      const map = new SharedMap<'SharedSet<string>'>('SharedSet<string>');
      const set1 = new SharedSet<string>().add('original');
      
      const map2 = map.set('key', set1);
      
      // Modify the original set (creates new version)
      const set2 = set1.add('modified');
      
      // The stored set should still only have 'original'
      const retrieved = map2.get('key')!;
      expect(retrieved.has('original')).toBe(true);
      expect(retrieved.has('modified')).toBe(false);
      expect(retrieved.size).toBe(1);
    });
  });

  describe('Iteration with nested structures', () => {
    test('forEach with nested maps', () => {
      const map = new SharedMap<'SharedMap<number>'>('SharedMap<number>');
      const inner1 = new SharedMap('number').set('val', 1);
      const inner2 = new SharedMap('number').set('val', 2);
      
      const map2 = map.set('a', inner1).set('b', inner2);
      
      const results: [string, number][] = [];
      map2.forEach((innerMap, key) => {
        results.push([key, innerMap.get('val')!]);
      });
      
      expect(results).toContainEqual(['a', 1]);
      expect(results).toContainEqual(['b', 2]);
    });

    test('entries with nested lists', () => {
      const map = new SharedMap<'SharedList<string>'>('SharedList<string>');
      const list1 = new SharedList('string').push('hello');
      const list2 = new SharedList('string').push('world');
      
      const map2 = map.set('greeting', list1).set('target', list2);
      
      const entries = [...map2.entries()];
      expect(entries.length).toBe(2);
      
      const greetingEntry = entries.find(([k]) => k === 'greeting')!;
      expect(greetingEntry[1].get(0)).toBe('hello');
      
      const targetEntry = entries.find(([k]) => k === 'target')!;
      expect(targetEntry[1].get(0)).toBe('world');
    });
  });
});
