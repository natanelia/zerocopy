import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SETTINGS, hash, jsonHash, positiveCount } from './cached-object-read-protocol.mjs';
import { buildFixture } from './cached-object-read-workloads.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function digestPackage(root) {
  const paths = [];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'staged package cannot contain symlinks');
      if (entry.isDirectory()) visit(next); else paths.push(next);
    }
  };
  visit(root);
  return jsonHash(paths.sort().map(path => [relative(root, path), hash(readFileSync(path))]));
}
let result;
try {
  assert.equal(process.argv.length, 3, 'one neutral input path');
  const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), (config.phase === 'measure'
    ? ['phase', 'sweeps', 'warmSweeps', 'workload'] : ['phase', 'workload']).sort());
  const runtime = { name: process.versions.bun ? 'bun' : 'node',
    version: process.versions.bun ?? process.versions.node, arch: process.arch,
    versions: process.versions, executable: process.execPath, pid: process.pid, parentPid: process.ppid, execArgv: process.execArgv };
  assert.equal(runtime.version, SETTINGS[runtime.name]);
  assert.equal(runtime.arch, SETTINGS.arch);
  assert.equal(process.execArgv.length, 0, 'no asymmetric engine flags');
  const packagePath = join(here, 'package');
  const packageDigest = digestPackage(packagePath);
  // Deliberate direct dist import: Bun's package export would choose shared.ts.
  const api = await import(new URL('./package/dist/shared.js', import.meta.url).href);
  const fixture = buildFixture(api, config.workload);
  result = {
    schema: SETTINGS.schema, phase: config.phase, workload: config.workload, runtime,
    packageDigest, fixture: fixture.fixture, fixtureDigest: fixture.fixtureDigest,
    expectedPerSweep: fixture.expectedPerSweep, opsPerSweep: fixture.opsPerSweep,
  };
  emit({ event: 'fixture', result });
  const timed = sweeps => {
    positiveCount(sweeps);
    const start = performance.now();
    const sink = fixture.run(sweeps);
    const ms = performance.now() - start;
    assert.equal(sink, fixture.expectedPerSweep * sweeps, 'all work consumed');
    assert.ok(Number.isSafeInteger(sink), 'integer checksum overflow');
    assert.ok(ms > 0 && Number.isFinite(ms));
    return { sweeps, ms, sink };
  };
  if (config.phase === 'check') {
    result.checkSink = fixture.run(1);
    assert.equal(result.checkSink, fixture.expectedPerSweep);
  } else if (config.phase === 'pilot') {
    result.pilot = [];
    for (let sweeps = 1; ; sweeps *= 2) {
      const attempt = timed(sweeps);
      result.pilot.push(attempt);
      emit({ event: 'pilot', attempt });
      if (attempt.ms >= SETTINGS.pilotTargetMs) break;
      assert.ok(sweeps < SETTINGS.maxSweeps, 'pilot cannot reach target within bounded work');
    }
  } else {
    assert.equal(config.phase, 'measure');
    positiveCount(config.sweeps); positiveCount(config.warmSweeps);
    result.sweeps = config.sweeps;
    result.warm = timed(config.warmSweeps);
    emit({ event: 'warm', sample: result.warm });
    result.samples = [];
    for (let index = 0; index < SETTINGS.samples; index++) {
      const sample = timed(config.sweeps);
      result.samples.push(sample);
      emit({ event: 'sample', index, sample });
    }
  }
  result.postFixtureDigest = fixture.verify();
  assert.equal(digestPackage(packagePath), packageDigest, 'staged package changed during subject');
  emit({ event: 'result', result });
} catch (error) {
  emit({ event: 'failure', message: error?.message ?? String(error), stack: error?.stack, partial: result });
  process.exitCode = 1;
}
