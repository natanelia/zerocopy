import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { study, makeFixture } from './workloads.mjs';

const [rootArg, outputArg] = process.argv.slice(2);
assert.ok(rootArg && outputArg, 'Usage: node allocation.mjs BUILT_REPOSITORY OUTPUT_JSON');
const root = resolve(rootArg), output = resolve(outputArg);
assert.ok(!existsSync(output), 'Do not replace recorded allocation evidence');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const S = await import(pathToFileURL(join(root, 'dist/shared.js')));
const batched = typeof S.SharedList.prototype.setMany === 'function';
const specs = study.cases.filter(spec => spec.mode === 'batch' && spec.type === 'number').concat([
  { name: 'tail-only-17', mode: 'batch', type: 'number', count: 17, edits: 17, shape: 'clustered' },
  { name: 'scratch-limit-4096', mode: 'batch', type: 'number', count: 8193, edits: 4096, shape: 'clustered' },
  { name: 'scratch-limit-4097', mode: 'batch', type: 'number', count: 8193, edits: 4097, shape: 'clustered' },
]);
const rows = [];
for (const spec of specs) {
  const { input, entries } = makeFixture(spec), expected = [...input];
  for (const [index, value] of entries) expected[index] = value;
  S.resetSharedList();
  const source = new S.SharedList('number').pushMany(input);
  const before = S.getWorkerData({ source }, { copy: false }).arenas[0];
  const published = hash(new Uint8Array(before.memory.buffer, 65536, before.used - 65536));
  let result = source;
  if (batched) result = source.setMany(entries);
  else for (const [index, value] of entries) result = result.set(index, value);
  const after = S.getWorkerData({ source, result }, { copy: false }).arenas[0];
  assert.deepEqual(result.toArray(), expected); assert.deepEqual(source.toArray(), input);
  assert.equal(hash(new Uint8Array(before.memory.buffer, 65536, before.used - 65536)), published);
  const distinct = new Set(entries.map(([index]) => index)), tailStart = (spec.count - 1) & ~31;
  const tree = [...distinct].filter(index => index < tailStart);
  let expectedBatchBytes = new Set(tree.map(index => index >>> 5)).size * 256;
  for (let level = 1; level <= source.depth; level++) expectedBatchBytes += new Set(tree.map(index => index >>> ((level + 1) * 5))).size * 128;
  if ([...distinct].some(index => index >= tailStart)) expectedBatchBytes += (spec.count - tailStart) * 8;
  const stagingBytes = distinct.size > 4096 ? Math.ceil(distinct.size * 12 / 8) * 8 : 0;
  expectedBatchBytes += stagingBytes;
  const expectedScalarBytes = entries.reduce((sum, [index]) => sum + (index < tailStart ? source.depth * 128 + 256 : (spec.count - tailStart) * 8), 0);
  const actualBytes = after.used - before.used;
  assert.equal(actualBytes, batched ? expectedBatchBytes : expectedScalarBytes);
  rows.push({ name: spec.name, count: spec.count, submittedEdits: entries.length, distinctEdits: distinct.size,
    strategy: batched ? 'setMany' : 'scalar set loop', actualBytes, expectedScalarBytes, expectedBatchBytes,
    batchStagingBytesIncluded: batched ? stagingBytes : 0, expectedBatchStagingBytes: stagingBytes, originalBytesUnchanged: true,
    fixtureDigest: hash(JSON.stringify({ input, entries, expected })) });
}
const report = { schema: 'zerocopy-list-batch-allocation/v1', measuredAt: new Date().toISOString(), root,
  runtime: process.version, bun: process.versions.bun ?? null,
  harnessSha256: hash(readFileSync(new URL(import.meta.url))), workloadSha256: hash(readFileSync(new URL('./workloads.mjs', import.meta.url))),
  scope: 'Exact append-only WASM writer allocation for one complete batch; includes unreachable intermediate scalar paths and any batch staging above 4096 distinct edits. Excludes JS objects, native-array storage, total backing capacity, RSS, and GC; this is not a cross-library total-memory comparison.',
  sourceHashes: Object.fromEntries(['persistent-core.as.ts', 'shared-list.ts', 'persistent-core.wasm'].map(name => [name, hash(readFileSync(join(root, name)))])), rows };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(rows, null, 2));
