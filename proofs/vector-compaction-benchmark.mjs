import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases, createCase } from './vector-compaction-cases.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const hash = value => createHash('sha256').update(value).digest('hex');
const protocolPath = resolve(root, 'proofs/vector-compaction-protocol.json');
const protocol = JSON.parse(readFileSync(protocolPath));
const runtime = { node: process.version, bun: process.versions.bun ?? null, v8: process.versions.v8 ?? null, arch: process.arch, cpu: cpus()[0]?.model };
const gc = () => { if (typeof Bun !== 'undefined') Bun.gc(true); else globalThis.gc?.(); };
const manifest = directory => Object.fromEntries(readdirSync(resolve(directory, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(readFileSync(resolve(directory, 'dist', name)))]));

if (process.argv[2] === '--runtime-info') {
  console.log(JSON.stringify(runtime));
} else if (process.argv[2] === '--subject') {
  const [directory, name, mode, count] = process.argv.slice(3);
  const spec = cases.find(value => value.name === name);
  assert.ok(spec, 'Unknown workload');
  const modules = manifest(directory), packageHash = hash(readFileSync(resolve(directory, 'package.json')));
  const api = await import(pathToFileURL(resolve(directory, 'dist/shared.js')).href);
  const item = createCase(api, spec), iterations = Number(count);
  assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
  const preflightStart = performance.now(); item.run(1); const preflightMs = performance.now() - preflightStart;
  const before = item.check();
  const maxCalls = Math.max(1, Math.min(256, Math.floor(64 * 1024 * 1024 / before.backingBytes)));
  const warmupIterations = Math.max(1, Math.min(maxCalls, Math.ceil(protocol.batchTargetMs / Math.max(preflightMs, 0.000001))));
  const warmupSamples = []; let warmupMs = 0;
  while (warmupSamples.length < protocol.warmupBatches || warmupMs < protocol.warmupMinimumMs) {
    gc();
    const start = performance.now(); item.run(warmupIterations); const ms = performance.now() - start;
    warmupSamples.push(ms); warmupMs += ms;
  }
  await new Promise(done => setTimeout(done, protocol.settleMs));
  const samples = [];
  for (let round = 0; round < (mode === 'pilot' ? 3 : protocol.measuredBatches); round++) {
    gc();
    const start = performance.now(); item.run(iterations); const ms = performance.now() - start;
    samples.push(ms);
  }
  const after = item.check();
  assert.equal(after.size, before.size); assert.equal(after.usedBytes, before.usedBytes); assert.equal(after.backingBytes, before.backingBytes);
  assert.deepEqual(manifest(directory), modules, 'The subject bundle changed after import');
  assert.equal(hash(readFileSync(resolve(directory, 'package.json'))), packageHash, 'The subject package changed after import');
  console.log(JSON.stringify({ runtime, case: spec.name, mode, iterations, preflightMs,
    warmup: { iterations: warmupIterations, samples: warmupSamples, executionMs: warmupMs, settleMs: protocol.settleMs },
    samples, msPerCall: median(samples) / iterations, before, after, modules, packageHash }));
} else {
  assert.equal(process.versions.bun, undefined, 'Run the controller with Node; select Bun with SUBJECT_RUNTIME=bun');
  const roots = { baseline: resolve(process.env.BASE_DIR ?? '../zerocopy'), candidate: resolve(process.env.CANDIDATE_DIR ?? root) };
  // A Node controller also runs Bun subjects. This keeps filesystem cleanup
  // and process accounting separate from the runtime under measurement.
  const label = process.env.SUBJECT_RUNTIME ?? (process.versions.bun ? 'bun' : 'node');
  assert.ok(label === 'node' || label === 'bun', 'Unknown subject runtime');
  const binary = process.env.SUBJECT_BIN ?? (label === (process.versions.bun ? 'bun' : 'node') ? process.execPath : label);
  const out = resolve(process.env.OUT_DIR ?? `proofs/results/vector-compaction/final-${label}`);
  const neutral = resolve(out, 'subject');
  mkdirSync(out, { recursive: true });
  const selected = process.env.CASE ? cases.filter(spec => spec.name === process.env.CASE) : cases;
  assert.ok(selected.length, 'Unknown CASE');
  const pairs = Number(process.env.PAIRS ?? protocol.pairs);
  assert.ok(Number.isSafeInteger(pairs) && pairs > 0);
  function launch(args, name) {
    const output = resolve(out, `${name}.json`), error = resolve(out, `${name}.stderr.txt`);
    const stdout = openSync(output, 'w'), stderr = openSync(error, 'w');
    let result;
    try { result = spawnSync(binary, [...(label === 'node' ? ['--expose-gc'] : []), script, ...args], { stdio: ['ignore', stdout, stderr], timeout: 120000 }); }
    finally { closeSync(stdout); closeSync(stderr); }
    writeFileSync(resolve(out, `${name}.launch.json`), JSON.stringify({ binary, args, error: result.error?.message ?? null, status: result.status, signal: result.signal }, null, 2) + '\n');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} failed; see ${error}`);
    return JSON.parse(readFileSync(output, 'utf8'));
  }
  const subjectRuntime = launch(['--runtime-info'], 'runtime');
  assert.equal(Boolean(subjectRuntime.bun), label === 'bun', 'The selected runtime is wrong');
  const source = Object.fromEntries(Object.entries(roots).map(([arm, directory]) => [arm, { directory, compaction: hash(readFileSync(resolve(directory, 'compaction.ts'))), modules: manifest(directory) }]));
  // Keep all hashed chunks in place. The selected entry modules reference only
  // their own build. Avoid deleting and recreating files between subjects.
  const union = { ...source.baseline.modules, ...source.candidate.modules };
  for (const file of Object.keys(source.baseline.modules)) if (file.startsWith('chunk-') && Object.hasOwn(source.candidate.modules, file))
    assert.equal(source.baseline.modules[file], source.candidate.modules[file], 'A hashed chunk filename collides');
  const neutralManifests = Object.fromEntries(Object.keys(roots).map(arm => [arm, { ...union, ...source[arm].modules }]));
  rmSync(neutral, { recursive: true, force: true });
  mkdirSync(resolve(neutral, 'dist'), { recursive: true });
  writeFileSync(resolve(neutral, 'package.json'), '{"type":"module"}\n');
  for (const arm of Object.keys(roots)) for (const file of Object.keys(source[arm].modules)) copyFileSync(resolve(roots[arm], 'dist', file), resolve(neutral, 'dist', file));
  const record = { date: new Date().toISOString(), runtime: subjectRuntime, controller: runtime, protocol, protocolHash: hash(readFileSync(protocolPath)), source, neutralManifests, harness: Object.fromEntries(['vector-compaction-benchmark.mjs', 'vector-compaction-cases.mjs'].map(name => [name, hash(readFileSync(resolve(root, 'proofs', name)))])), pairs, complete: false, rows: [] };
  const save = () => writeFileSync(resolve(out, 'results.json'), JSON.stringify(record, null, 2) + '\n');
  save();
  function child(arm, spec, mode, iterations, name) {
    for (const file of Object.keys(source[arm].modules)) copyFileSync(resolve(roots[arm], 'dist', file), resolve(neutral, 'dist', file));
    assert.deepEqual(manifest(neutral), neutralManifests[arm], 'Subject bundle differs from the source manifest');
    const value = launch(['--subject', neutral, spec.name, mode, String(iterations)], name);
    assert.deepEqual(value.runtime, subjectRuntime, 'The child runtime changed');
    assert.deepEqual(value.modules, neutralManifests[arm], 'The measured bundle changed');
    return value;
  }
  for (const spec of selected) {
    const pilots = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, child(arm, spec, 'pilot', 1, `${spec.name}-${arm}-pilot`)]));
    assert.equal(pilots.baseline.after.usedBytes, pilots.candidate.after.usedBytes);
    assert.equal(pilots.baseline.after.backingBytes, pilots.candidate.after.backingBytes);
    const maxCalls = Math.max(1, Math.min(256, Math.floor(64 * 1024 * 1024 / pilots.baseline.after.backingBytes)));
    const requestedIterations = Math.ceil(protocol.batchTargetMs / Math.min(pilots.baseline.msPerCall, pilots.candidate.msPerCall));
    const iterations = Math.max(1, Math.min(maxCalls, requestedIterations));
    const row = { ...spec, iterations, batchCapped: iterations < requestedIterations, pilots, pairs: [] };
    record.rows.push(row); save();
    for (let pair = 0; pair < pairs; pair++) {
      const values = {};
      for (const arm of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) values[arm] = child(arm, spec, 'sample', iterations, `${spec.name}-${pair}-${arm}`);
      assert.equal(values.baseline.after.usedBytes, values.candidate.after.usedBytes);
      assert.equal(values.baseline.after.backingBytes, values.candidate.after.backingBytes);
      row.pairs.push({ order: pair % 2 ? 'BA' : 'AB', baseline: values.baseline.msPerCall, candidate: values.candidate.msPerCall,
        timeRatio: values.candidate.msPerCall / values.baseline.msPerCall, observations: values });
      save();
    }
    console.log(`${spec.name}: ${(1 / median(row.pairs.map(pair => pair.timeRatio))).toFixed(3)}x median paired speedup`);
  }
  for (const [arm, directory] of Object.entries(roots)) {
    assert.deepEqual(manifest(directory), source[arm].modules);
    assert.equal(hash(readFileSync(resolve(directory, 'compaction.ts'))), source[arm].compaction);
  }
  for (const [name, digest] of Object.entries(record.harness)) assert.equal(hash(readFileSync(resolve(root, 'proofs', name))), digest, 'The harness changed');
  assert.equal(hash(readFileSync(protocolPath)), record.protocolHash, 'The protocol changed');
  rmSync(neutral, { recursive: true, force: true });
  record.complete = true; save();
  // The final evidence is written once, after cleanup. results.json is only
  // a recovery checkpoint and must not replace this completed record.
  writeFileSync(resolve(out, 'completed.json'), JSON.stringify(record, null, 2) + '\n');
}
