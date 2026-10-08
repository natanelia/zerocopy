/** One library version per process keeps workload call sites monomorphic.
 * UTF8_CASES=map-json-set node --expose-gc proofs/utf8-write-case.mjs dist/shared.js output.json
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { utf8WriteCases, createUtf8WriteWorkload } from './utf8-write-workloads.mjs';

const [entryArg, outputArg] = process.argv.slice(2);
assert(entryArg && outputArg, 'Usage: utf8-write-case.mjs library-entry output.json');
const count = Number(process.env.UTF8_COUNT ?? 5000), samples = Number(process.env.UTF8_SAMPLES ?? 15);
const warmups = Number(process.env.UTF8_WARMUPS ?? 20), round = Number(process.env.UTF8_ROUND ?? 0);
const variant = process.env.UTF8_VARIANT ?? 'candidate';
for (const [key, value, low, high] of [['count', count, 64, 50000], ['samples', samples, 1, 100], ['warmups', warmups, 0, 100], ['round', round, 0, 100]]) {
  assert(Number.isSafeInteger(value) && value >= low && value <= high, `Invalid ${key}`);
}
const gc = typeof Bun === 'undefined' ? globalThis.gc : () => Bun.gc(true);
assert.equal(typeof gc, 'function', 'Use Node --expose-gc');
const entry = resolve(entryArg), api = await import(pathToFileURL(entry).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = dirname(entry), digest = createHash('sha256');
for (const name of readdirSync(directory).filter(name => name.endsWith('.js')).sort()) {
  digest.update(name).update('\0').update(readFileSync(resolve(directory, name))).update('\0');
}
const selected = process.env.UTF8_CASES?.split(',');
if (selected) assert(selected.every(name => utf8WriteCases.some(spec => spec.name === name)), 'Unknown workload');
const cases = utf8WriteCases.filter(spec => !selected || selected.includes(spec.name));
assert.equal(cases.length, 1, 'Select exactly one workload with UTF8_CASES; use run-utf8-write.mjs for a suite');
const report = { schema: 'zerocopy-utf8-write-case/v1', date: new Date().toISOString(), variant, round,
  runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`,
  platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  count, samples, warmups, entry, buildSha256: digest.digest('hex'),
  method: 'One library version and workload per process. Prebuilt fixtures; fresh arena before every run. Setup, full GC, validation, and SHA256 outside timing. Final values and retained roots checked after every warm-up and sample. No timing threshold.',
  cases: [] };
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction, low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
};
mkdirSync(dirname(resolve(outputArg)), { recursive: true });
for (const spec of cases) {
  const work = createUtf8WriteWorkload(api, spec, count), records = [];
  for (let sample = -warmups; sample < samples; sample++) {
    work.setup(); gc();
    const start = performance.now(), result = work.run(), ms = performance.now() - start;
    const checked = work.verify(result);
    if (sample >= 0) records.push({ ms, usedBytes: checked.usedBytes, backingBytes: checked.backingBytes,
      payloadSha256: hash(checked.payload), descriptor: checked.descriptor });
  }
  const result = { ...spec, operations: work.count, medianMs: quantile(records.map(record => record.ms), 0.5),
    p95Ms: quantile(records.map(record => record.ms), 0.95), records };
  report.cases.push(result);
  writeFileSync(outputArg, JSON.stringify(report, null, 2) + '\n');
  console.log(`${variant} ${spec.name}: ${result.medianMs.toFixed(3)} ms`);
}
