/**
 * Untimed raw geometry ABI coverage. Build geometry-kernels.wasm first.
 *
 * Candidate/reference checks (no AssemblyScript checkout required):
 *   node proofs/rust-migration-20261115/geometry-abi.mjs [--candidate CHECKOUT]
 * Original 80-call comparison, also checking the fixed expected results:
 *   node proofs/rust-migration-20261115/geometry-abi.mjs --baseline AS_CHECKOUT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index], value = process.argv[index + 1];
  assert.ok(option === '--candidate' || option === '--baseline', `Unknown option ${option}`);
  assert.ok(value && !value.startsWith('--'), `Missing ${option} checkout path`);
  assert.ok(!options.has(option), `Repeated ${option}`);
  options.set(option, resolve(value));
}
const candidateRoot = options.get('--candidate') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = { rust: candidateRoot };
if (options.has('--baseline')) {
  roots.assemblyscript = options.get('--baseline');
  assert.notEqual(roots.assemblyscript, candidateRoot, 'Use separate baseline and candidate checkouts');
}

const memoryBytes = 2 * 65536;
const modules = Object.entries(roots).map(([name, root]) => {
  const bytes = readFileSync(resolve(root, 'geometry-kernels.wasm'));
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
  for (const name of ['bboxXY', 'bboxMinX', 'bboxMinY', 'bboxMaxX', 'bboxMaxY']) {
    assert.equal(typeof exports[name], 'function', `Missing geometry export ${name}`);
  }
  return { name, root, memory, exports, metadata: {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } };
});

// Fixed expectations deliberately avoid implementing another bounds scan.
// Strict equality checks distinguish +0 from -0.
const payloads = [
  { name: 'first-signed-zero', values: [-0, 0, 0, -0], expected: [-0, 0, -0, 0] },
  { name: 'nan-per-axis', values: [NaN, -1, 3, NaN], expected: [3, -1, 3, -1] },
  { name: 'infinities', values: [Infinity, -Infinity, -Infinity, Infinity], expected: [-Infinity, -Infinity, Infinity, Infinity] },
  { name: 'all-nan', values: [NaN, NaN], expected: [Infinity, Infinity, -Infinity, -Infinity] },
  { name: 'finite-extremes', values: [Number.MIN_VALUE, Number.MAX_VALUE], expected: [Number.MIN_VALUE, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_VALUE] },
];
const fixedAddresses = [0, 1, 8, 9, 2112, 65536, 65537];
const checks = { cases: 0, bboxCalls: 0, resultComponents: 0, unchangedMemories: 0, crossModuleComparisons: 0 };

for (const payload of payloads) {
  const addresses = [...fixedAddresses, memoryBytes - payload.values.length * 8];
  for (const address of addresses) {
    checks.cases++;
    let candidateBounds;
    for (const { name, memory, exports } of modules) {
      const buffer = memory.buffer;
      const bytes = new Uint8Array(buffer);
      bytes.fill(0xa5);
      const view = new DataView(buffer);
      payload.values.forEach((value, index) => view.setFloat64(address + index * 8, value, true));
      const before = bytes.slice();

      exports.bboxXY(0, 0, address, payload.values.length);
      checks.bboxCalls++;
      const bounds = [exports.bboxMinX(), exports.bboxMinY(), exports.bboxMaxX(), exports.bboxMaxY()];
      assert.deepStrictEqual(bounds, payload.expected, `${name}: ${payload.name} at ${address}`);
      checks.resultComponents += 4;
      assert.equal(memory.buffer, buffer, `${name}: memory buffer must not change`);
      assert.equal(memory.buffer.byteLength, memoryBytes, `${name}: memory must not grow`);
      assert.deepStrictEqual(bytes, before, `${name}: geometry must not write linear memory`);
      checks.unchangedMemories++;

      if (name === 'rust') candidateBounds = bounds;
      else {
        assert.deepStrictEqual(bounds, candidateBounds, `${payload.name} at ${address}: baseline parity`);
        checks.crossModuleComparisons++;
      }
    }
  }
}

assert.equal(checks.cases, 40);
assert.equal(checks.bboxCalls, 40 * modules.length);
const numberJSON = value => Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0'
  : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value;
console.log(JSON.stringify({
  schema: 1,
  status: 'passed',
  mode: modules.length === 2 ? 'candidate-and-baseline' : 'candidate-only',
  modules: Object.fromEntries(modules.map(({ name, root, metadata }) => [name, { root, ...metadata }])),
  checks,
  memoryBytes,
  addresses: [...fixedAddresses, 'memoryBytes - payloadBytes'],
  payloads: payloads.map(({ name, values, expected }) => ({
    name, values: values.map(numberJSON), expected: expected.map(numberJSON),
  })),
}, null, 2));
