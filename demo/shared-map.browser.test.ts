import { describe, it, expect } from 'vitest';
import { SharedMap, getWorkerData, initWorker } from './shared-browser';

describe('SharedMap Browser', () => {
  it('initializes WASM', async () => {
    await SharedMap.init();
    expect(SharedMap.getSharedBuffer()).toBeInstanceOf(SharedArrayBuffer);
  });

  it('set and get', async () => {
    await SharedMap.init();
    let map = new SharedMap('string');
    map = map.set('key', 'value');
    expect(map.get('key')).toBe('value');
    expect(map.size).toBe(1);
  });

  it('stores objects', async () => {
    await SharedMap.init();
    let map = new SharedMap('object');
    map = map.set('todo', { id: 1, title: 'Test' });
    expect(map.get('todo')).toEqual({ id: 1, title: 'Test' });
  });

  it('forEach iterates all entries', async () => {
    await SharedMap.init();
    let map = new SharedMap('object');
    for (let i = 0; i < 100; i++) {
      map = map.set(`key-${i}`, { id: i });
    }
    
    let count = 0;
    map.forEach(() => count++);
    expect(count).toBe(100);
  });

  it('creates 1000 todos quickly', async () => {
    await SharedMap.init();
    const start = performance.now();
    let todos = new SharedMap('object');
    for (let i = 0; i < 1000; i++) {
      todos = todos.set(`todo-${i}`, { id: i, title: `Task ${i}` });
    }
    const time = performance.now() - start;
    
    expect(todos.size).toBe(1000);
    expect(time).toBeLessThan(5000);
    console.log(`Created 1000 todos in ${time.toFixed(2)}ms`);
  });

  it('creates 10000 todos', async () => {
    await SharedMap.init();
    const start = performance.now();
    let todos = new SharedMap('object');
    for (let i = 0; i < 10000; i++) {
      todos = todos.set(`todo-${i}`, { id: i, title: `Task ${i}` });
    }
    const time = performance.now() - start;
    
    expect(todos.size).toBe(10000);
    console.log(`Created 10000 todos in ${time.toFixed(2)}ms`);
  }, 30000);

  it('getWorkerData serializes correctly', async () => {
    await SharedMap.init();
    let map = new SharedMap('string').set('a', '1').set('b', '2');
    const data = getWorkerData({ map });
    
    expect(data.__shared).toBe(true);
    expect(data.mapBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(data.structures.map.type).toBe('SharedMap');
  });
});
