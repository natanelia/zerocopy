import { describe, test, expect } from 'vitest';
import { Worker } from 'worker_threads';
import { SharedMap, sharedBuffer, resetMap } from './shared-map';
import { SharedList, sharedBuffer as sharedListBuffer, sharedMemory, resetSharedList, getAllocState, getBufferCopy } from './shared-list';

const isBun = typeof Bun !== 'undefined';

const workerCode = `
const { parentPort, workerData } = require('worker_threads');
const { readFileSync } = require('fs');

const { sharedBuf, root, keys, workerId } = workerData;
const wasmBytes = readFileSync('./shared-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);
const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });

// Copy shared buffer content to our memory
new Uint8Array(memory.buffer).set(new Uint8Array(sharedBuf));

const wasm = new WebAssembly.Instance(wasmModule, { env: { memory, abort: () => {} } }).exports;
const keyBufPtr = wasm.keyBuf();
const batchBufPtr = wasm.batchBuf();
const memBuf = new Uint8Array(memory.buffer);
const memDv = new DataView(memory.buffer);

function encodeKey(key) {
  for (let i = 0; i < key.length; i++) memBuf[keyBufPtr + i] = key.charCodeAt(i);
  return key.length;
}

function get(root, key) {
  const keyLen = encodeKey(key);
  if (!wasm.getInfo(root, keyLen)) return undefined;
  const kLen = memDv.getUint32(batchBufPtr, true);
  const vLen = memDv.getUint32(batchBufPtr + 4, true);
  const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
  return new TextDecoder().decode(memBuf.subarray(keyPtr + kLen, keyPtr + kLen + vLen));
}

const results = keys.map(key => ({ key, value: get(root, key) }));
parentPort.postMessage({ workerId, results });
`;

describe('SharedMap Multi-Worker Tests', () => {
  test('concurrent reads from multiple workers', async () => {
    resetMap();
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const values = ['v1', 'v2', 'v3', 'v4', 'v5'];
    
    let hamt = new SharedMap('string');
    for (let i = 0; i < keys.length; i++) {
      hamt = hamt.set(keys[i], values[i]);
    }
    
    const root = (hamt as any).root;
    const NUM_WORKERS = 2;
    
    const workers = Array.from({ length: NUM_WORKERS }, (_, i) => 
      new Worker(workerCode, {
        eval: true,
        workerData: { sharedBuf: sharedBuffer, root, keys, workerId: i }
      })
    );
    
    const results = await Promise.all(workers.map(w => new Promise<any>((resolve, reject) => {
      w.on('message', resolve);
      w.on('error', reject);
    })));
    
    for (const { results: workerResults } of results) {
      expect(workerResults.length).toBe(keys.length);
      for (let i = 0; i < keys.length; i++) {
        expect(workerResults[i].value).toBe(values[i]);
      }
    }
  });

  test('workers see updated map after set operations', async () => {
    resetMap();
    let hamt = new SharedMap('string').set('key1', 'initial');
    hamt = hamt.set('key1', 'updated').set('key2', 'new');
    
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sharedBuf: sharedBuffer, root: (hamt as any).root, keys: ['key1', 'key2'], workerId: 0 }
    });
    
    const { results } = await new Promise<any>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results[0].value).toBe('updated');
    expect(results[1].value).toBe('new');
  });

  test('workers see map after delete operations', async () => {
    resetMap();
    let hamt = new SharedMap('string').set('a', '1').set('b', '2').set('c', '3');
    hamt = hamt.delete('b');
    
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sharedBuf: sharedBuffer, root: (hamt as any).root, keys: ['a', 'b', 'c'], workerId: 0 }
    });
    
    const { results } = await new Promise<any>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results[0].value).toBe('1');
    expect(results[1].value).toBeUndefined();
    expect(results[2].value).toBe('3');
  });

  test('workers handle missing keys', async () => {
    resetMap();
    const hamt = new SharedMap('string').set('a', 'exists');
    const root = (hamt as any).root;
    
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sharedBuf: sharedBuffer, root, keys: ['a', 'missing'], workerId: 0 }
    });
    
    const { results } = await new Promise<any>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results[0].value).toBe('exists');
    expect(results[1].value).toBeUndefined();
  });

  test('stress test - 2 workers, 100 keys', async () => {
    resetMap();
    const N = 100;
    const keys = Array.from({ length: N }, (_, i) => `key${i}`);
    const values = Array.from({ length: N }, (_, i) => `value${i}`);
    
    let hamt = new SharedMap('string');
    for (let i = 0; i < N; i++) hamt = hamt.set(keys[i], values[i]);
    
    const root = (hamt as any).root;
    const NUM_WORKERS = 2;
    
    const workers = Array.from({ length: NUM_WORKERS }, (_, i) => 
      new Worker(workerCode, {
        eval: true,
        workerData: { sharedBuf: sharedBuffer, root, keys, workerId: i }
      })
    );
    
    const results = await Promise.all(workers.map(w => new Promise<any>((resolve, reject) => {
      w.on('message', resolve);
      w.on('error', reject);
    })));
    
    for (const { results: workerResults } of results) {
      for (let i = 0; i < N; i++) {
        expect(workerResults[i].value).toBe(values[i]);
      }
    }
  });

  test('empty SharedMap', async () => {
    resetMap();
    const hamt = new SharedMap('string');
    const root = (hamt as any).root;
    
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sharedBuf: sharedBuffer, root, keys: ['a', 'b'], workerId: 0 }
    });
    
    const { results } = await new Promise<any>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results.every((r: any) => r.value === undefined)).toBe(true);
  });

  test('3 workers same key simultaneously', async () => {
    resetMap();
    const hamt = new SharedMap('string').set('shared', 'value');
    const root = (hamt as any).root;
    
    const workers = Array.from({ length: 3 }, (_, i) => 
      new Worker(workerCode, {
        eval: true,
        workerData: { sharedBuf: sharedBuffer, root, keys: ['shared'], workerId: i }
      })
    );
    
    const results = await Promise.all(workers.map(w => new Promise<any>((resolve, reject) => {
      w.on('message', resolve);
      w.on('error', reject);
    })));
    
    for (const { results: workerResults } of results) {
      expect(workerResults[0].value).toBe('value');
    }
  });

  test('unicode keys and values', async () => {
    resetMap();
    let hamt = new SharedMap('string')
      .set('日本語', '値')
      .set('émoji', '🎉🚀')
      .set('Ключ', 'Значение');
    
    const root = (hamt as any).root;
    
    const unicodeWorkerCode = `
const { parentPort, workerData } = require('worker_threads');
const { readFileSync } = require('fs');

const { sharedBuf, root, keys } = workerData;
const wasmBytes = readFileSync('./shared-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);
const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
new Uint8Array(memory.buffer).set(new Uint8Array(sharedBuf));

const wasm = new WebAssembly.Instance(wasmModule, { env: { memory, abort: () => {} } }).exports;
const keyBufPtr = wasm.keyBuf();
const batchBufPtr = wasm.batchBuf();
const memBuf = new Uint8Array(memory.buffer);
const memDv = new DataView(memory.buffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function get(root, key) {
  const keyEnc = encoder.encode(key);
  memBuf.set(keyEnc, keyBufPtr);
  if (!wasm.getInfo(root, keyEnc.length)) return undefined;
  const kLen = memDv.getUint32(batchBufPtr, true);
  const vLen = memDv.getUint32(batchBufPtr + 4, true);
  const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
  return decoder.decode(memBuf.subarray(keyPtr + kLen, keyPtr + kLen + vLen));
}

parentPort.postMessage(keys.map(k => get(root, k)));
`;
    
    const worker = new Worker(unicodeWorkerCode, {
      eval: true,
      workerData: { sharedBuf: sharedBuffer, root, keys: ['日本語', 'émoji', 'Ключ'] }
    });
    
    const results = await new Promise<string[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results[0]).toBe('値');
    expect(results[1]).toBe('🎉🚀');
    expect(results[2]).toBe('Значение');
  });
});


describe('SharedList Multi-Worker Tests', () => {
  // Worker code for buffer copy approach (Bun)
  const listWorkerCodeCopy = `
const { parentPort, workerData } = require('worker_threads');
const { attachToBufferCopy, SharedList } = require('./shared-list.ts');

attachToBufferCopy(workerData.bufferCopy, workerData.allocState);
const list = SharedList.fromWorkerData(workerData.listData);
const results = workerData.indices.map(i => list.get(i));
parentPort.postMessage(results);
`;

  // Worker code for zero-copy approach (Node.js)
  const listWorkerCodeZeroCopy = `
const { parentPort, workerData } = require('worker_threads');
const { attachToMemory, SharedList } = require('./shared-list.ts');

attachToMemory(workerData.memory, workerData.allocState);
const list = SharedList.fromWorkerData(workerData.listData);
const results = workerData.indices.map(i => list.get(i));
parentPort.postMessage(results);
`;

  function createListWorker(list: SharedList<any>, indices: number[]) {
    const allocState = getAllocState();
    const listData = list.toWorkerData();
    
    if (isBun) {
      return new Worker(listWorkerCodeCopy, {
        eval: true,
        workerData: { bufferCopy: getBufferCopy(), allocState, listData, indices }
      });
    } else {
      return new Worker(listWorkerCodeZeroCopy, {
        eval: true,
        workerData: { memory: sharedMemory, allocState, listData, indices }
      });
    }
  }

  test('SharedList<number> shared across workers', async () => {
    resetMap();
    resetSharedList();
    
    let v = new SharedList('number');
    for (let i = 0; i < 100; i++) v = v.push(i * 10);
    
    const worker = createListWorker(v, [0, 50, 99]);
    
    const results = await new Promise<number[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([0, 500, 990]);
  });

  test('SharedList<string> shared across workers', async () => {
    resetMap();
    resetSharedList();
    
    let v = new SharedList('string');
    v = v.push('hello').push('world').push('test');
    
    const worker = createListWorker(v, [0, 1, 2]);
    
    const results = await new Promise<string[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual(['hello', 'world', 'test']);
  });

  test('SharedList<object> shared across workers', async () => {
    resetMap();
    resetSharedList();
    
    let v = new SharedList('object');
    v = v.push({ x: 1 }).push({ y: 2, z: [1, 2, 3] });
    
    const worker = createListWorker(v, [0, 1]);
    
    const results = await new Promise<object[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([{ x: 1 }, { y: 2, z: [1, 2, 3] }]);
  });

  test('SharedList after set operation', async () => {
    resetMap();
    resetSharedList();
    
    let v = new SharedList('number').push(1).push(2).push(3);
    v = v.set(1, 99);
    
    const worker = createListWorker(v, [0, 1, 2]);
    
    const results = await new Promise<number[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([1, 99, 3]);
  });

  test('SharedList after pop operation', async () => {
    resetMap();
    resetSharedList();
    
    let v = new SharedList('number').push(1).push(2).push(3);
    v = v.pop();
    
    const worker = createListWorker(v, [0, 1]);
    
    const results = await new Promise<number[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([1, 2]);
  });
});

describe('SharedSet Multi-Worker Tests', () => {
  const setWorkerCode = `
const { parentPort, workerData } = require('worker_threads');
const { readFileSync } = require('fs');

const { sharedBuf, root, keys } = workerData;
const wasmBytes = readFileSync('./shared-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);
const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
new Uint8Array(memory.buffer).set(new Uint8Array(sharedBuf));

const wasm = new WebAssembly.Instance(wasmModule, { env: { memory, abort: () => {} } }).exports;
const keyBufPtr = wasm.keyBuf();
const batchBufPtr = wasm.batchBuf();
const memBuf = new Uint8Array(memory.buffer);
const encoder = new TextEncoder();

function has(root, key) {
  // v2 sets store a type tag so 1 and '1' remain distinct.
  const keyEnc = encoder.encode((typeof key === 'number' ? 'n:' : 's:') + key);
  memBuf.set(keyEnc, keyBufPtr);
  return wasm.getInfo(root, keyEnc.length) !== 0;
}

parentPort.postMessage(keys.map(k => has(root, k)));
`;

  test('SharedSet shared across workers', async () => {
    resetMap();
    const { SharedSet } = await import('./shared-set');
    
    let s = new SharedSet<string>();
    s = s.addMany(['apple', 'banana', 'cherry']);
    
    const worker = new Worker(setWorkerCode, {
      eval: true,
      workerData: { 
        sharedBuf: sharedBuffer, 
        root: (s as any)._map['root'],
        keys: ['apple', 'banana', 'missing', 'cherry']
      }
    });
    
    const results = await new Promise<boolean[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([true, true, false, true]);
  });

  test('SharedSet after delete operation', async () => {
    resetMap();
    const { SharedSet } = await import('./shared-set');
    
    let s = new SharedSet<string>().addMany(['a', 'b', 'c']);
    s = s.delete('b');
    
    const worker = new Worker(setWorkerCode, {
      eval: true,
      workerData: { 
        sharedBuf: sharedBuffer, 
        root: (s as any)._map['root'],
        keys: ['a', 'b', 'c']
      }
    });
    
    const results = await new Promise<boolean[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([true, false, true]);
  });
});

describe('Seamless Worker API', () => {
  test('all structures via getWorkerData/initWorker', async () => {
    resetMap();
    resetSharedList();
    
    const { getWorkerData, SharedMap, SharedList, SharedSet, SharedStack, SharedQueue } = await import('./shared.ts');
    
    const map = new SharedMap('string').set('key', 'hello');
    const list = new SharedList('number').push(42);
    const set = new SharedSet<string>().add('item');
    const stack = new SharedStack('number').push(99);
    const queue = new SharedQueue('string').enqueue('first');
    
    const data = getWorkerData({ map, list, set, stack, queue });
    
    // Verify serialization works
    expect(data.__shared).toBe(true);
    expect(data.version).toBe(4);
    expect(data.arenas.length).toBeGreaterThan(0);
    expect(data.arenas.every(a => a.copy || a.memory)).toBe(true);
    expect(data.structures.map.type).toBe('SharedMap');
    expect(data.structures.list.type).toBe('SharedList');
    expect(data.structures.set.type).toBe('SharedSet');
    expect(data.structures.stack.type).toBe('SharedStack');
    expect(data.structures.queue.type).toBe('SharedQueue');
    
    // Verify we can reconstruct on same thread (simulates worker)
    const { initWorker } = await import('./shared.ts');
    const reconstructed = await initWorker<{
      map: typeof map;
      list: typeof list;
      set: typeof set;
      stack: typeof stack;
      queue: typeof queue;
    }>(data);
    
    expect(reconstructed.map.get('key')).toBe('hello');
    expect(reconstructed.list.get(0)).toBe(42);
    expect(reconstructed.set.has('item')).toBe(true);
    expect(reconstructed.stack.peek()).toBe(99);
    expect(reconstructed.queue.peek()).toBe('first');
  });
});

describe('Zero-Copy Data Type Tests', () => {
  // SharedMap worker for all value types
  const mapWorkerZeroCopy = `
const { parentPort, workerData } = require('worker_threads');
const { readFileSync } = require('fs');

const { memory, root, keys, valueType } = workerData;
const wasmBytes = readFileSync('./shared-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasm = new WebAssembly.Instance(wasmModule, { env: { memory, abort: () => {} } }).exports;

const keyBufPtr = wasm.keyBuf();
const batchBufPtr = wasm.batchBuf();
const memBuf = new Uint8Array(memory.buffer);
const memDv = new DataView(memory.buffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function get(root, key) {
  const keyEnc = encoder.encode(String(key));
  memBuf.set(keyEnc, keyBufPtr);
  if (!wasm.getInfo(root, keyEnc.length)) return undefined;
  const kLen = memDv.getUint32(batchBufPtr, true);
  const vLen = memDv.getUint32(batchBufPtr + 4, true);
  const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
  const valPtr = keyPtr + kLen;
  if (valueType === 'number') return memDv.getFloat64(valPtr, true);
  if (valueType === 'boolean') return memBuf[valPtr] === 1;
  if (valueType === 'object') return JSON.parse(decoder.decode(memBuf.subarray(valPtr, valPtr + vLen)));
  return decoder.decode(memBuf.subarray(valPtr, valPtr + vLen));
}

parentPort.postMessage(keys.map(k => get(root, k)));
`;

  // SharedList worker for zero-copy
  const listWorkerZeroCopy = `
const { parentPort, workerData } = require('worker_threads');
const { attachToMemory, SharedList } = require('./shared-list.ts');

attachToMemory(workerData.memory, workerData.allocState);
const list = SharedList.fromWorkerData(workerData.listData);
const results = workerData.indices.map(i => list.get(i));
parentPort.postMessage(results);
`;

  function createZeroCopyMapWorker(root: number, keys: any[], valueType: string) {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
    new Uint8Array(memory.buffer).set(new Uint8Array(sharedBuffer));
    
    return new Worker(mapWorkerZeroCopy, {
      eval: true,
      workerData: { memory, root, keys, valueType }
    });
  }

  test('SharedMap<string> zero-copy', async () => {
    resetMap();
    let m = new SharedMap('string').set('a', 'hello').set('b', 'world');
    
    const worker = createZeroCopyMapWorker((m as any).root, ['a', 'b', 'missing'], 'string');
    const results = await new Promise<any[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual(['hello', 'world', undefined]);
  });

  test('SharedMap<number> zero-copy', async () => {
    resetMap();
    let m = new SharedMap('number').set('x', 42).set('y', 3.14).set('z', -100);
    
    const worker = createZeroCopyMapWorker((m as any).root, ['x', 'y', 'z'], 'number');
    const results = await new Promise<any[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([42, 3.14, -100]);
  });

  test('SharedMap<boolean> zero-copy', async () => {
    resetMap();
    let m = new SharedMap('boolean').set('t', true).set('f', false);
    
    const worker = createZeroCopyMapWorker((m as any).root, ['t', 'f'], 'boolean');
    const results = await new Promise<any[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([true, false]);
  });

  test('SharedMap<object> zero-copy', async () => {
    resetMap();
    let m = new SharedMap('object')
      .set('simple', { a: 1 })
      .set('nested', { x: { y: [1, 2, 3] } })
      .set('array', [1, 'two', true]);
    
    const worker = createZeroCopyMapWorker((m as any).root, ['simple', 'nested', 'array'], 'object');
    const results = await new Promise<any[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([{ a: 1 }, { x: { y: [1, 2, 3] } }, [1, 'two', true]]);
  });

  test('SharedList<number> zero-copy (Node.js)', async () => {
    if (isBun) return; // Skip on Bun - uses buffer copy
    resetSharedList();
    
    let list = new SharedList('number').push(1).push(2.5).push(-999);
    
    const worker = new Worker(listWorkerZeroCopy, {
      eval: true,
      workerData: { memory: sharedMemory, allocState: getAllocState(), listData: list.toWorkerData(), indices: [0, 1, 2] }
    });
    
    const results = await new Promise<number[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([1, 2.5, -999]);
  });

  test('SharedList<string> zero-copy (Node.js)', async () => {
    if (isBun) return;
    resetSharedList();
    
    let list = new SharedList('string').push('hello').push('世界').push('🚀');
    
    const worker = new Worker(listWorkerZeroCopy, {
      eval: true,
      workerData: { memory: sharedMemory, allocState: getAllocState(), listData: list.toWorkerData(), indices: [0, 1, 2] }
    });
    
    const results = await new Promise<string[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual(['hello', '世界', '🚀']);
  });

  test('SharedList<boolean> zero-copy (Node.js)', async () => {
    if (isBun) return;
    resetSharedList();
    
    let list = new SharedList('boolean').push(true).push(false).push(true);
    
    const worker = new Worker(listWorkerZeroCopy, {
      eval: true,
      workerData: { memory: sharedMemory, allocState: getAllocState(), listData: list.toWorkerData(), indices: [0, 1, 2] }
    });
    
    const results = await new Promise<boolean[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([true, false, true]);
  });

  test('SharedList<object> zero-copy (Node.js)', async () => {
    if (isBun) return;
    resetSharedList();
    
    let list = new SharedList('object').push({ a: 1 }).push([1, 2]).push({ nested: { deep: true } });
    
    const worker = new Worker(listWorkerZeroCopy, {
      eval: true,
      workerData: { memory: sharedMemory, allocState: getAllocState(), listData: list.toWorkerData(), indices: [0, 1, 2] }
    });
    
    const results = await new Promise<object[]>((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
    });
    
    expect(results).toEqual([{ a: 1 }, [1, 2], { nested: { deep: true } }]);
  });
});
