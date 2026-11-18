// Each scenario runs in a fresh process so the optional module is genuinely
// loaded after an existing arena's prototype hooks have been installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = resolve(process.argv[2] ?? '.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const driver = fileURLToPath(import.meta.url), mode = process.argv[3];
if (!mode) {
  const checks = ['allocator-mutation', 'allocator-detachment', 'view-mutation'].map(scenario =>
    JSON.parse(execFileSync(process.execPath, [driver, directory, scenario], { encoding: 'utf8', timeout: 25000 })));
  console.log(JSON.stringify({ runtime: process.versions, date: new Date().toISOString(),
    source: sha(readFileSync(join(directory, 'numeric.ts'))),
    bundle: sha(readFileSync(join(directory, 'dist/numeric.js'))), driver: sha(readFileSync(driver)),
    checks, timingMeasurements: false }, null, 2));
} else {
  assert.ok(['allocator-mutation', 'allocator-detachment', 'view-mutation'].includes(mode));
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const held = new S.SharedList('number').pushMany([10, -0, 30]), a = held.arena;
  const end = a.used, published = a.buf.slice(65536, end);
  const input = new Float64Array(65), raw = new DataView(input.buffer);
  const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const patterns = [0x3ff4000000000000n, 0x8000000000000000n, 0x7ff0000000000001n, 0xfff8000000000002n];
  const expected = Array.from({ length: input.length }, (_, i) => patterns[i % patterns.length]);
  expected.forEach((value, i) => raw.setBigUint64(i * 8, value, little));
  const prototype = Object.getPrototypeOf(a), key = mode === 'view-mutation' ? 'dv' : 'alloc';
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  let calls = 0, writes = 0;
  if (key === 'alloc') {
    Object.defineProperty(prototype, key, { ...descriptor, value(bytes) {
      calls++;
      if (mode === 'allocator-detachment') structuredClone(input.buffer, { transfer: [input.buffer] });
      else input.fill(99);
      return descriptor.value.call(this, bytes);
    } });
  } else {
    Object.defineProperty(prototype, key, { ...descriptor, get() {
      calls++; input.fill(99);
      const target = new DataView(descriptor.get.call(this).buffer);
      Object.defineProperty(target, 'setUint32', { value(offset, value, endian) {
        writes++; DataView.prototype.setUint32.call(this, offset, value, endian);
      } });
      return target;
    } });
  }
  let result;
  try {
    const { fromFloat64 } = await import(pathToFileURL(join(directory, 'dist/numeric.js')));
    result = fromFloat64(input);
  } finally { Object.defineProperty(prototype, key, descriptor); }
  assert.ok(calls > 0, 'The custom storage hook must run');
  if (key === 'dv') assert.ok(writes > 0, 'Writes must use the current custom view');
  const view = a.dv, tailStart = (result.size - 1) & ~31;
  const actual = Array.from({ length: result.size }, (_, index) => {
    const leaf = index >= tailStart ? result.tail : a.wasm.vecLeaf(result.root, result.depth, index) >>> 0;
    return view.getBigUint64(leaf + (index & 31) * 8, true);
  });
  assert.deepEqual(actual, expected, 'Input bits must be captured before custom storage hooks');
  assert.deepEqual(held.toArray(), [10, -0, 30]);
  assert.deepEqual(a.buf.slice(65536, end), published);
  assert.ok(Object.isFrozen(result));
  console.log(JSON.stringify({ scenario: mode, status: 'passed', calls, writes, size: result.size,
    inputDetached: input.buffer.byteLength === 0,
    rawBitsSha256: sha(JSON.stringify(actual.map(String))), retainedSnapshotUnchanged: true }));
}
