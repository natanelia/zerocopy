/** Alternate matched builds in a fresh process for each workload and round.
 * node proofs/run-json-read.mjs ../baseline/dist/shared.js dist/shared.js output-directory
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { jsonReadCases, quantile } from './json-read-workloads.mjs';

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outputArg, 'Usage: run-json-read.mjs before-entry after-entry output-directory');
const rounds = Number(process.env.JSON_READ_ROUNDS ?? 3), runtimes = process.env.JSON_READ_RUNTIMES?.split(',') ?? ['node', 'bun'];
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'Invalid rounds');
assert(runtimes.length && runtimes.every(name => name === 'node' || name === 'bun'), 'Unknown runtime');
const selected = process.env.JSON_READ_CASES?.split(',');
if (selected) assert(selected.every(name => jsonReadCases.some(spec => spec.name === name)), 'Unknown workload');
const cases = jsonReadCases.filter(spec => !selected || selected.includes(spec.name));
const directory = resolve(outputArg), scratch = mkdtempSync(resolve(tmpdir(), 'json-read-proof-'));
mkdirSync(directory, { recursive: true });
const runs = [], builds = {}, sources = {};
let harnessSha256;
try {
  for (const runtime of runtimes) for (let round = 0; round < rounds; round++) {
    const reports = [];
    for (const [index, spec] of cases.entries()) {
      const pair = {}, order = (round + index) % 2 ? ['after', 'before'] : ['before', 'after'];
      for (const variant of order) {
        const name = `${runtime}-${round + 1}-${spec.name}-${variant}`;
        const output = resolve(scratch, `${name}.json`);
        try {
          execFileSync(runtime === 'node' ? process.execPath : 'bun', [
            ...(runtime === 'node' ? ['--expose-gc'] : []), fileURLToPath(new URL('./json-read-case.mjs', import.meta.url)),
            resolve(variant === 'before' ? beforeArg : afterArg), output,
          ], { encoding: 'utf8', timeout: 180000, env: { ...process.env,
            JSON_READ_CASES: spec.name, JSON_READ_ROUND: String(round), JSON_READ_VARIANT: variant } });
          const report = JSON.parse(readFileSync(output, 'utf8'));
          assert.equal(report.complete, true); assert.equal(report.milliseconds.length, report.samples);
          if (builds[variant]) assert.equal(report.buildSha256, builds[variant], 'Build changed during measurement');
          if (sources[variant]) assert.equal(report.sourceSha256, sources[variant], 'Source changed during measurement');
          if (harnessSha256) assert.equal(report.harnessSha256, harnessSha256, 'Harness changed during measurement');
          builds[variant] = report.buildSha256; sources[variant] = report.sourceSha256; harnessSha256 = report.harnessSha256;
          pair[variant] = report; reports.push(report); runs.push(report);
          writeFileSync(resolve(directory, `${runtime}-${round + 1}.partial.json`), JSON.stringify(reports, null, 2) + '\n');
        } catch (error) {
          // Keep verified samples even when a later sample or child fails.
          if (existsSync(output)) copyFileSync(output, resolve(directory, `${name}.partial.json`));
          writeFileSync(resolve(directory, `${name}.error.json`), JSON.stringify({
            schema: 'zerocopy-json-read-failure/v1', date: new Date().toISOString(), runtime, round, variant,
            workload: spec.name, message: error instanceof Error ? error.message : String(error),
            status: error.status, signal: error.signal,
            stdout: error.stdout?.toString().slice(-16384), stderr: error.stderr?.toString().slice(-16384),
          }, null, 2) + '\n');
          throw error;
        }
      }
      assert.deepEqual(pair.before.integrity, pair.after.integrity, `${spec.name}: baseline storage differs`);
      assert.deepEqual(pair.before.workload, pair.after.workload, `${spec.name}: workload differs`);
      assert.equal(pair.before.count, pair.after.count); assert.equal(pair.before.passes, pair.after.passes);
      assert.equal(pair.before.requestedCount, pair.after.requestedCount);
      assert.equal(pair.before.samples, pair.after.samples); assert.equal(pair.before.warmups, pair.after.warmups);
      console.log(`${runtime} round ${round + 1}: ${spec.name}: ${(pair.before.medianMs / pair.after.medianMs).toFixed(2)}x (${pair.before.medianMs.toFixed(3)} -> ${pair.after.medianMs.toFixed(3)} ms)`);
    }
    writeFileSync(resolve(directory, `${runtime}-${round + 1}.json`), JSON.stringify(reports, null, 2) + '\n');
    rmSync(resolve(directory, `${runtime}-${round + 1}.partial.json`), { force: true });
  }
  const rows = [];
  for (const runtime of runtimes) for (const spec of cases) {
    const found = runs.filter(run => run.runtime.toLowerCase().startsWith(runtime) && run.workload.name === spec.name);
    assert.equal(found.length, rounds * 2);
    const summary = Object.fromEntries(['before', 'after'].map(variant => {
      const times = found.filter(run => run.variant === variant).flatMap(run => run.milliseconds);
      return [variant, { medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95), samples: times.length }];
    }));
    rows.push({ runtime: found[0].runtime, ...found[0].workload, ...summary,
      speedup: summary.before.medianMs / summary.after.medianMs,
      roundSpeedups: Array.from({ length: rounds }, (_, round) =>
        found.find(run => run.round === round && run.variant === 'before').medianMs /
        found.find(run => run.round === round && run.variant === 'after').medianMs),
      integrity: found[0].integrity });
  }
  const first = runs[0];
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ schema: 'zerocopy-json-read-summary/v1',
    date: new Date().toISOString(), rounds, requestedCount: first.requestedCount, passes: first.passes, warmups: first.warmups,
    buildSha256: builds, sourceSha256: sources, harnessSha256, cpu: first.cpu, platform: first.platform,
    arch: first.arch, osRelease: first.osRelease, method: first.method,
    processIsolation: 'One fresh process per runtime, workload, variant, and round. Variant order alternates by workload and round. Each sample must retain the same allocated-byte hash, descriptor hash, used length, and backing length; matched builds must agree on all invariants.', rows }, null, 2) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
