import { describe, test, expect, beforeEach } from 'vitest';
import { SharedPriorityQueue, resetPriorityQueue } from './shared-priority-queue';

describe('SharedPriorityQueue', () => {
  beforeEach(() => resetPriorityQueue());

  describe('basic operations', () => {
    test('empty queue', () => {
      const pq = new SharedPriorityQueue('number');
      expect(pq.isEmpty).toBe(true);
      expect(pq.size).toBe(0);
      expect(pq.peek()).toBeUndefined();
      expect(pq.peekPriority()).toBeUndefined();
      expect(pq.dequeue()).toBe(pq);
    });

    test('enqueue and peek (min-heap)', () => {
      const pq = new SharedPriorityQueue('string')
        .enqueue('low', 3)
        .enqueue('high', 1)
        .enqueue('med', 2);
      expect(pq.peek()).toBe('high');
      expect(pq.peekPriority()).toBe(1);
      expect(pq.size).toBe(3);
    });

    test('dequeue returns new queue with next priority', () => {
      const pq1 = new SharedPriorityQueue('string')
        .enqueue('a', 3)
        .enqueue('b', 1)
        .enqueue('c', 2);
      const pq2 = pq1.dequeue();
      expect(pq2.peek()).toBe('c');
      expect(pq2.peekPriority()).toBe(2);
      expect(pq2.size).toBe(2);
    });

    test('dequeue to empty', () => {
      const pq = new SharedPriorityQueue('number')
        .enqueue(42, 1)
        .dequeue();
      expect(pq.isEmpty).toBe(true);
      expect(pq.peek()).toBeUndefined();
    });
  });

  describe('max-heap', () => {
    test('max-heap returns highest priority first', () => {
      const pq = new SharedPriorityQueue('number', { maxHeap: true })
        .enqueue(10, 1)
        .enqueue(20, 2)
        .enqueue(30, 3);
      expect(pq.peek()).toBe(30);
      expect(pq.peekPriority()).toBe(3);
    });

    test('max-heap dequeue order', () => {
      let pq = new SharedPriorityQueue('string', { maxHeap: true })
        .enqueue('low', 1)
        .enqueue('high', 3)
        .enqueue('med', 2);
      expect(pq.peek()).toBe('high');
      pq = pq.dequeue();
      expect(pq.peek()).toBe('med');
      pq = pq.dequeue();
      expect(pq.peek()).toBe('low');
    });
  });

  describe('value types', () => {
    test('number values', () => {
      const pq = new SharedPriorityQueue('number')
        .enqueue(100, 2)
        .enqueue(200, 1);
      expect(pq.peek()).toBe(200);
    });

    test('boolean values', () => {
      const pq = new SharedPriorityQueue('boolean')
        .enqueue(false, 2)
        .enqueue(true, 1);
      expect(pq.peek()).toBe(true);
    });

    test('object values', () => {
      const pq = new SharedPriorityQueue('object')
        .enqueue({ task: 'urgent' }, 1)
        .enqueue({ task: 'normal' }, 5);
      expect(pq.peek()).toEqual({ task: 'urgent' });
    });

    test('string values', () => {
      const pq = new SharedPriorityQueue('string')
        .enqueue('first', 1)
        .enqueue('second', 2);
      expect(pq.peek()).toBe('first');
    });
  });

  describe('immutability', () => {
    test('enqueue does not modify original', () => {
      const pq1 = new SharedPriorityQueue('number').enqueue(1, 10);
      const pq2 = pq1.enqueue(2, 5);
      expect(pq1.peek()).toBe(1);
      expect(pq1.size).toBe(1);
      expect(pq2.peek()).toBe(2);
      expect(pq2.size).toBe(2);
    });
  });

  describe('edge cases', () => {
    test('same priority values', () => {
      const pq = new SharedPriorityQueue('string')
        .enqueue('a', 1)
        .enqueue('b', 1)
        .enqueue('c', 1);
      expect(pq.size).toBe(3);
      expect(pq.peekPriority()).toBe(1);
    });

    test('negative priorities', () => {
      const pq = new SharedPriorityQueue('string')
        .enqueue('neg', -5)
        .enqueue('pos', 5);
      expect(pq.peek()).toBe('neg');
      expect(pq.peekPriority()).toBe(-5);
    });

    test('many items', () => {
      let pq = new SharedPriorityQueue('number');
      for (let i = 100; i > 0; i--) {
        pq = pq.enqueue(i, i);
      }
      expect(pq.size).toBe(100);
      expect(pq.peek()).toBe(1);
      expect(pq.peekPriority()).toBe(1);
    });
  });
});
