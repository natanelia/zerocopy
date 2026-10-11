/** Isolate each runtime/workload/variant/round in a fresh process. Preserve every sample.
 * node proofs/run-utf8-write.mjs ../baseline/dist/shared.js dist/shared.js output-dir
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { utf8WriteCases, compareUtf8WriteStorage } from './utf8-write-workloads.mjs';

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outputArg, 'Usage: run-utf8-write.mjs before-entry after-entry output-directory');
const rounds = Number(process.env.UTF8_ROUNDS ?? 3), runtimes = process.env.UTF8_RUNTIMES?.split(',') ?? ['node', 'bun'];
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
assert(runtimes.length && runtimes.every(name => name === 'node' || name === 'bun'));
const selected = process.env.UTF8_CASES?.split(',');
if (selected) assert(selected.every(name => utf8WriteCases.some(spec => spec.name === name)), 'Unknown workload');
const cases = utf8WriteCases.filter(spec => !selected || selected.includes(spec.name));
const directory = resolve(outputArg), scratch = mkdtempSync(resolve(tmpdir(), 'utf8-write-proof-'));
mkdirSync(directory, { recursive: true });
const runs = [];
const buildSha256 = {};
try {
  for (const runtime of runtimes) for (let round = 0; round < rounds; round++) {
    const reports = [];
    for (const [index, spec] of cases.entries()) {
      const pair = {}, order = (round + index) % 2 ? ['after', 'before'] : ['before', 'after'];
      for (const variant of order) {
        const output = resolve(scratch, 'sample.json');
        const args = [...(runtime === 'node' ? ['--expose-gc'] : []),
          fileURLToPath(new URL('./utf8-write-case.mjs', import.meta.url)),
          resolve(variant === 'before' ? beforeArg : afterArg), output];
        execFileSync(runtime === 'node' ? process.execPath : 'bun', args, { encoding: 'utf8', timeout: 120000,
          env: { ...process.env, UTF8_CASES: spec.name, UTF8_ROUND: String(round), UTF8_VARIANT: variant } });
        const report = JSON.parse(readFileSync(output, 'utf8'));
        assert.equal(report.cases.length, 1);
        if (buildSha256[variant]) assert.equal(report.buildSha256, buildSha256[variant], 'A build changed during the proof');
        buildSha256[variant] = report.buildSha256;
        pair[variant] = report.cases[0]; reports.push(report); runs.push(report);
        // A later failed workload must not discard completed measurements.
        writeFileSync(resolve(directory, `${runtime}-${round + 1}.partial.json`), JSON.stringify(reports, null, 2) + '\n');
      }
      assert.equal(pair.before.records.length, pair.after.records.length);
      for (let sample = 0; sample < pair.before.records.length; sample++) {
        const { ms: beforeMs, ...before } = pair.before.records[sample];
        const { ms: afterMs, ...after } = pair.after.records[sample];
        compareUtf8WriteStorage(spec, pair.before.operations, before, after);
      }
      console.log(`${runtime} round ${round + 1}: ${spec.name}: ${(pair.before.medianMs / pair.after.medianMs).toFixed(2)}x (${pair.before.medianMs.toFixed(3)} -> ${pair.after.medianMs.toFixed(3)} ms)`);
    }
    // Publish each complete round once, separately from changing progress files.
    writeFileSync(resolve(directory, `${runtime}-${round + 1}.json`), JSON.stringify(reports, null, 2) + '\n');
    rmSync(resolve(directory, `${runtime}-${round + 1}.partial.json`), { force: true });
  }
  const quantile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction, low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  const rows = [];
  for (const runtime of runtimes) for (const spec of cases) {
    const found = runs.filter(run => run.runtime.toLowerCase().startsWith(runtime) && run.cases[0].name === spec.name);
    assert.equal(found.length, rounds * 2);
    const summary = Object.fromEntries(['before', 'after'].map(variant => {
      const values = found.filter(run => run.variant === variant).flatMap(run => run.cases[0].records.map(record => record.ms));
      return [variant, { medianMs: quantile(values, 0.5), p95Ms: quantile(values, 0.95), samples: values.length }];
    }));
    const roundSpeedups = Array.from({ length: rounds }, (_, round) =>
      found.find(run => run.round === round && run.variant === 'before').cases[0].medianMs
      / found.find(run => run.round === round && run.variant === 'after').cases[0].medianMs);
    const integrity = Object.fromEntries(['before', 'after'].map(variant => {
      const { ms, ...record } = found.find(run => run.variant === variant).cases[0].records[0];
      return [variant, record];
    }));
    const record = found[0].cases[0].records[0];
    rows.push({ runtime: found[0].runtime, name: spec.name, operations: found[0].cases[0].operations, ...summary,
      speedup: summary.before.medianMs / summary.after.medianMs,
      roundSpeedups, usedBytes: record.usedBytes, backingBytes: record.backingBytes,
      payloadSha256: record.payloadSha256, integrityByVariant: integrity });
  }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ schema: 'zerocopy-utf8-write-summary/v1',
    date: new Date().toISOString(), rounds, buildSha256, cpu: runs[0].cpu,
    platform: runs[0].platform, arch: runs[0].arch, method: runs[0].method,
    processIsolation: 'One fresh process per runtime, workload, variant, and round; full GC after setup before each timed sample. Alternate variant order across workloads and rounds. Every warm-up and sample must retain its own fresh-arena payload, descriptors, used bytes, and backing sizes. Compare verified actual map contents and structure across variants for bounded generic bulk-map fixtures, including update seeds; compare full physical storage for all other paths. Layout differences can affect performance.',
    rows }, null, 2) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
