import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CASES, ORDERS, capFor, nextCount, quality, validateExport } from './latency.mjs';

test('fixed cases, all six orders and copied-byte caps', () => {
  assert.deepEqual(CASES, ['S', 'A', 'E', 'D2', 'D24', 'RC', 'RO', 'T', 'R']);
  assert.deepEqual(ORDERS, ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB']);
  assert.equal(new Set(ORDERS).size, 6);
  assert.equal(capFor('S', 65536), 2 ** 20);
  assert.equal(capFor('R', 65536), 2 ** 24);
  assert.equal(capFor('T', 65536), 4096);
  assert.equal(capFor('T', 262144), 2048);
});
test('calibration arithmetic clips and rounds without tuning', () => {
  assert.equal(nextCount(256, 15e6, 2 ** 20), 512);
  assert.equal(nextCount(256, 90e6, 2 ** 20), 85);
  assert.equal(nextCount(256, 1, 4096), 4096);
  assert.equal(nextCount(1, 100e6, 4096), 1);
  assert.throws(() => nextCount(256, 0, 4096));
});
test('quality keeps every batch and uses the fixed limits', () => {
  const batches = Array.from({ length: 9 }, () => ({ count: 1000, elapsedNs: 30e6 }));
  assert.equal(quality(batches).nsPerOp, 30000);
  assert.equal(quality(batches).resolved, true);
  const short = batches.map((b, i) => ({ ...b, elapsedNs: i === 0 ? 9e6 : 30e6 }));
  assert(quality(short).reasons.includes('batch below 10 ms'));
  const drift = batches.map((b, i) => ({ ...b, elapsedNs: i >= 6 ? 40e6 : 30e6 }));
  assert(quality(drift).reasons.includes('batch drift outside 0.85–1.15'));
  const variable = batches.map((b, i) => ({ ...b, elapsedNs: i % 2 ? 15e6 : 60e6 }));
  assert(quality(variable).reasons.includes('batch CV above 25%'));
  assert.equal(short.length, 9);
});
test('export validator rejects order, shape, descriptors and copy corruption', () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const data = Object.freeze({ root: 123, valueType: 'number', size: 32 });
  const map = { toWorkerData: () => data }, expected = [{ id: 'arena', used: 65536, memory }];
  const build = (copy = false) => Object.freeze({ __shared: true, version: 4,
    structures: Object.freeze({ root: Object.freeze({ type: 'SharedMap', arena: 'arena', data }) }),
    arenas: Object.freeze([Object.freeze(copy ? { id: 'arena', used: 65536, copy: new Uint8Array(memory.buffer).slice(0, 65536) } : expected[0])]) });
  validateExport(build(), { root: map }, expected, false);
  validateExport(build(true), { root: map }, expected, true);
  assert.throws(() => validateExport(build(), { root: map }, [{ ...expected[0], id: 'wrong' }], false));
  assert.throws(() => validateExport(build(), { alias: map }, expected, false));
  const copied = build(true); copied.arenas[0].copy[0] = 1;
  assert.throws(() => validateExport(copied, { root: map }, expected, true));
});
test('workflow context and ordinary execution settings are static', () => {
  const source = readFileSync(new URL('../../.github/workflows/single-arena-export.yml', import.meta.url), 'utf8');
  assert(!/^ {4}env:/m.test(source), 'No job-level environment context');
  for (const line of source.split('\n').filter(line => line.includes('${{ runner.temp }}'))) {
    assert(/^ {10,}/.test(line), 'runner.temp must occur in step env or step action input');
  }
  assert(source.includes("node-version: '22.16.0'"));
  assert(source.includes("bun-version: '1.4.2'"));
  assert(source.includes('permissions:\n  contents: read\n'));
  assert(source.includes('actions/checkout@v4') && source.includes('actions/setup-node@v4') && source.includes('oven-sh/setup-bun@v2') && source.includes('actions/upload-artifact@v4'));
  assert(!source.includes('pull_request_target'));
  assert(source.includes('npm ci --prefix proofs/single-arena-export/dependencies --no-audit --no-fund'));
  assert(!source.includes('bun install'));
});
