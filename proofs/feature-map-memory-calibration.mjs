/** Verify this exact Node process accounts for ordinary buffers but excludes shared WASM. */
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
const BYTES = 8 * 1024 * 1024;
async function usage() {
  assert.equal(typeof global.gc, 'function');
  for (let index = 0; index < 4; index++) { await new Promise(setImmediate); global.gc(); }
  return process.memoryUsage();
}
if (!isMainThread) {
  let memory;
  parentPort.on('message', async message => {
    try {
      if (message.memory) memory = message.memory;
      parentPort.postMessage({ id: message.id, usage: await usage(), capacityBytes: memory?.buffer.byteLength ?? 0 });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.stack ?? String(error) }); }
  });
} else {
  const worker = new Worker(new URL(import.meta.url));
  let next = 0;
  const pending = new Map();
  function rejectAll(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  worker.on('error', rejectAll);
  worker.on('exit', code => rejectAll(new Error(`Calibration worker exited (${code})`)));
  worker.on('message', message => {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message);
  });
  function sample(memory) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Calibration worker timed out')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, memory });
    });
  }
  try {
    const readerBefore = await sample();
    const before = await usage();
    globalThis.ordinaryBuffer = new ArrayBuffer(BYTES);
    const ordinary = await usage();
    globalThis.sharedWasm = new WebAssembly.Memory({ initial: 128, maximum: 512, shared: true });
    const wasm = await usage();
    const readerAttached = await sample(globalThis.sharedWasm);
    globalThis.sharedWasm.grow(128);
    const grown = await usage(), readerGrown = await sample();
    const result = { before, ordinary, wasm, grown, readerBefore, readerAttached, readerGrown,
      ordinaryCapacityBytes: globalThis.ordinaryBuffer.byteLength,
      wasmCapacityBytes: globalThis.sharedWasm.buffer.byteLength };
    // Emit raw evidence even when an accounting check below fails.
    process.stdout.write(JSON.stringify(result) + '\n');
    assert.ok(Math.abs((ordinary.arrayBuffers - before.arrayBuffers) - BYTES) < 65536, 'Ordinary buffers are not accounted as expected');
    for (const current of [wasm, grown]) assert.ok(Math.abs(current.arrayBuffers - ordinary.arrayBuffers) < 65536, 'Node tracks shared WASM in arrayBuffers; revise the formula before using these measurements');
    for (const current of [readerAttached, readerGrown]) assert.ok(Math.abs(current.usage.arrayBuffers - readerBefore.usage.arrayBuffers) < 65536, 'Node tracks attached shared WASM in arrayBuffers; revise the formula');
    assert.equal(readerAttached.capacityBytes, BYTES);
    assert.equal(readerGrown.capacityBytes, 2 * BYTES);
  } finally { await worker.terminate(); }
}
