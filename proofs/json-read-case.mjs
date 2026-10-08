/** One library, workload, runtime, and round per process.
 * JSON_READ_CASES=cold-map-feature node --expose-gc proofs/json-read-case.mjs dist/shared.js output.json
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jsonReadCases, createJsonReadWorkload, quantile } from './json-read-workloads.mjs';

const [entryArg, outputArg] = process.argv.slice(2);
assert(entryArg && outputArg, 'Usage: json-read-case.mjs library-entry output.json');
const requestedCount = Number(process.env.JSON_READ_COUNT ?? 512), samples = Number(process.env.JSON_READ_SAMPLES ?? 12);
const warmups = Number(process.env.JSON_READ_WARMUPS ?? 5), passes = Number(process.env.JSON_READ_PASSES ?? 32);
const round = Number(process.env.JSON_READ_ROUND ?? 0), variant = process.env.JSON_READ_VARIANT ?? 'candidate';
for (const [key, value, low, high] of [['count', requestedCount, 16, 16384], ['samples', samples, 1, 100],
  ['warmups', warmups, 0, 100], ['passes', passes, 1, 1024], ['round', round, 0, 100]]) {
  assert(Number.isSafeInteger(value) && value >= low && value <= high, `Invalid ${key}`);
}
const selected = process.env.JSON_READ_CASES?.split(',');
assert(selected?.length === 1, 'Select exactly one workload with JSON_READ_CASES; use run-json-read.mjs for the suite');
const spec = jsonReadCases.find(value => value.name === selected[0]);
assert(spec, 'Unknown workload');
const gc = typeof Bun === 'undefined' ? globalThis.gc : () => Bun.gc(true);
assert.equal(typeof gc, 'function', 'Use Node --expose-gc');
const entry = resolve(entryArg), api = await import(pathToFileURL(entry).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function hashFiles(directory, names) {
  const digest = createHash('sha256');
  for (const name of names.sort()) digest.update(name).update('\0').update(readFileSync(resolve(directory, name))).update('\0');
  return digest.digest('hex');
}
const directory = dirname(entry), sourceDirectory = dirname(directory);
const sources = readdirSync(sourceDirectory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const work = createJsonReadWorkload(api, spec, requestedCount, passes);
function evidence(checked) {
  return { allocatedBytes: checked.allocatedBytes, usedBytes: checked.usedBytes, backingBytes: checked.backingBytes,
    payloadSha256: hash(checked.payload), descriptorSha256: hash(JSON.stringify(checked.descriptors)) };
}
const reference = evidence(work.storage()), milliseconds = [];
const report = { schema: 'zerocopy-json-read-case/v1', date: new Date().toISOString(), variant, round,
  runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`,
  platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model,
  entry, buildSha256: hashFiles(directory, readdirSync(directory).filter(name => name.endsWith('.js'))),
  sourceSha256: sources.length ? hashFiles(sourceDirectory, sources) : undefined,
  harnessSha256: hashFiles(harnessDirectory, ['json-read-workloads.mjs', 'json-read-case.mjs']),
  requestedCount, count: work.count, samples, warmups, passes, workload: { ...spec, requestedCount, count: work.count,
    passes: work.passes, operations: work.operations, totalValues: work.totalValues,
    snapshotCount: work.snapshotCount, fixture: work.fixture },
  method: 'One process per library, workload, runtime, and round. Fixtures are built once. Every run attaches a new read-only reader outside timing. Warm cases prime only their measured values; saturated cases prime 2,048 earlier records. Full GC follows setup. Timed work is public get/peek calls plus a scalar checksum. Exact values, deep freeze, caller ownership, descriptors, allocation lengths, and SHA-256 are checked outside timing after every run. No timing threshold.',
  integrity: reference, verifiedRuns: 0, milliseconds };
mkdirSync(dirname(resolve(outputArg)), { recursive: true });
const save = () => writeFileSync(outputArg, JSON.stringify(report, null, 2) + '\n');
save();
for (let sample = -warmups; sample < samples; sample++) {
  await work.setup();
  assert.deepEqual(evidence(work.storage()), reference, 'Storage changed before a read');
  gc();
  const start = performance.now(), checksum = work.run(), ms = performance.now() - start;
  assert.deepEqual(evidence(work.verify(checksum)), reference, 'A read changed allocated bytes or descriptors');
  report.verifiedRuns++;
  if (sample >= 0) milliseconds.push(ms);
  save();
}
report.medianMs = quantile(milliseconds, 0.5); report.p95Ms = quantile(milliseconds, 0.95); report.complete = true;
save();
console.log(`${variant} ${spec.name}: ${report.medianMs.toFixed(3)} ms`);
