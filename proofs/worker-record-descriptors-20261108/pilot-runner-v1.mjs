import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cases, createWorkload } from './workloads.mjs';

const median = xs => { const s = [...xs].sort((a, b) => a - b), p = (s.length - 1) / 2; return (s[Math.floor(p)] + s[Math.ceil(p)]) / 2; };
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = path => hashBytes(readFileSync(path));
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const p = arg.indexOf('='); return p < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, p), arg.slice(p + 1)];
}));
const enumerate = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? enumerate(join(dir, entry.name)) : [join(dir, entry.name)]);
const bundleHashes = repo => Object.fromEntries(enumerate(resolve(repo, 'dist')).filter(p => p.endsWith('.js')).sort()
  .map(path => [relative(repo, path), hash(path)]));
const sourceHashes = repo => Object.fromEntries([...readdirSync(repo).filter(n => n === 'package.json'
  || n.endsWith('.wasm') || (n.endsWith('.ts') && !n.endsWith('.test.ts'))),
  'scripts/build-browser.ts', 'scripts/build-wasm.mjs'].sort().map(n => [n, hash(resolve(repo, n))]));
const warmMs = Number(args.warm ?? 200);
const samples = Number(args.samples ?? 9);
const baselineCommit = '0ac8a005268335a6116f025e75f670b5cee6843e';
const gitHead = repo => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const affinity = () => readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim();

if (args.child) {
  const startedAt = new Date().toISOString();
  const repo = resolve(args.repo), api = await import(pathToFileURL(resolve(repo, 'dist/shared.js')).href);
  const worker = await import(pathToFileURL(resolve(repo, 'dist/worker.js')).href);
  const order = Number(args.order ?? 0) % cases.length;
  const results = [];
  for (const spec of [...cases.slice(order), ...cases.slice(0, order)]) {
    const work = createWorkload(api, worker, spec);
    let iterations = 1, calibrationMs;
    do {
      work.setup(iterations);
      const start = performance.now(), checksum = work.run(iterations);
      calibrationMs = performance.now() - start;
      work.verify(checksum, iterations);
      if (calibrationMs < 20) iterations *= 2;
    } while (calibrationMs < 20);
    let warmed = 0, warmBatches = 0;
    while (warmed < warmMs) {
      work.setup(iterations);
      const start = performance.now(), checksum = work.run(iterations), elapsed = performance.now() - start;
      warmed += elapsed; warmBatches++;
      work.verify(checksum, iterations);
    }
    const milliseconds = [], batchMilliseconds = [], checksums = [];
    for (let sample = 0; sample < samples; sample++) {
      work.setup(iterations);
      const start = performance.now(), checksum = work.run(iterations), elapsed = performance.now() - start;
      work.verify(checksum, iterations);
      batchMilliseconds.push(elapsed); milliseconds.push(elapsed / iterations); checksums.push(checksum);
    }
    work.close();
    results.push({ ...spec, iterations, calibrationMs, warmMs: warmed, warmBatches,
      unit: 'milliseconds per complete public operation', batchMilliseconds, checksums, milliseconds, medianMs: median(milliseconds) });
  }
  process.stdout.write(JSON.stringify({ startedAt, endedAt: new Date().toISOString(),
    runtime: process.version, bun: process.versions.bun ?? null, versions: process.versions, execPath: process.execPath,
    cpu: cpus()[0].model, affinity: affinity(), platform: platform(), arch: arch(), hashes: bundleHashes(repo), results }));
} else {
  const baseline = resolve(args.baseline), candidate = resolve(args.candidate), output = resolve(args.output);
  assert.equal(existsSync(output), false, `Refusing to replace ${output}`);
  const pairs = Number(args.pairs ?? 2);
  const runtimes = [resolve(args.node ?? process.execPath), resolve(args.bun)];
  const source = fileURLToPath(import.meta.url), workloads = fileURLToPath(new URL('./workloads.mjs', import.meta.url));
  const neutral = mkdtempSync(resolve(tmpdir(), 'zerocopy-record-descriptors-'));
  const metadata = { baseline, candidate, pairs, start: new Date().toISOString(), neutral, warmMs, samples,
    baselineCommit: gitHead(baseline), candidateCommit: gitHead(candidate), affinity: affinity(),
    baselineSources: sourceHashes(baseline), candidateSources: sourceHashes(candidate),
    baselineBuild: bundleHashes(baseline), candidateBuild: bundleHashes(candidate),
    harnessHashes: { runner: hash(source), workloads: hash(workloads) },
    baselineSource: readFileSync(resolve(baseline, 'worker-protocol.ts'), 'utf8'),
    candidateSource: readFileSync(resolve(candidate, 'worker-protocol.ts'), 'utf8') };
  assert.equal(metadata.baselineCommit, baselineCommit);
  assert.match(metadata.affinity, /^\d+$/, 'Pin the runner to one CPU with taskset');
  for (const [name, digest] of Object.entries(metadata.baselineSources)) {
    if (name.endsWith('.wasm')) continue;
    const committed = execFileSync('git', ['show', `${baselineCommit}:${name}`], { cwd: baseline, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(digest, hashBytes(committed), `Baseline source differs from its commit: ${name}`);
  }
  assert.deepEqual(Object.keys(metadata.baselineSources), Object.keys(metadata.candidateSources));
  assert.deepEqual(Object.keys(metadata.baselineSources).filter(name => metadata.baselineSources[name] !== metadata.candidateSources[name]),
    baseline === candidate ? [] : ['worker-protocol.ts']);
  const records = [];
  for (const runtime of runtimes) for (let pair = 0; pair < pairs; pair++) {
    for (const role of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const repo = role === 'baseline' ? baseline : candidate;
      rmSync(resolve(neutral, 'dist'), { recursive: true, force: true });
      cpSync(resolve(repo, 'dist'), resolve(neutral, 'dist'), { recursive: true });
      cpSync(resolve(repo, 'package.json'), resolve(neutral, 'package.json'));
      const child = spawnSync(runtime, [source, '--child', `--repo=${neutral}`, `--order=${pair}`, `--warm=${warmMs}`, `--samples=${samples}`],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (child.status !== 0) writeFileSync(`${output}.failure.json`, JSON.stringify({ metadata, records, failed: {
        runtime, pair, role, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr,
      } }, null, 2), { flag: 'wx' });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const result = JSON.parse(child.stdout);
      assert.deepEqual(result.hashes, role === 'baseline' ? metadata.baselineBuild : metadata.candidateBuild);
      assert.equal(result.affinity, metadata.affinity);
      records.push({ runtime, pair, role, result });
      process.stderr.write(`${runtime.includes('bun') ? 'Bun' : 'Node'} pair ${pair + 1}/${pairs} ${role} done\n`);
    }
  }
  assert.deepEqual(sourceHashes(baseline), metadata.baselineSources); assert.deepEqual(sourceHashes(candidate), metadata.candidateSources);
  assert.deepEqual(bundleHashes(baseline), metadata.baselineBuild); assert.deepEqual(bundleHashes(candidate), metadata.candidateBuild);
  assert.deepEqual({ runner: hash(source), workloads: hash(workloads) }, metadata.harnessHashes);
  assert.equal(gitHead(baseline), metadata.baselineCommit); assert.equal(gitHead(candidate), metadata.candidateCommit);
  const summary = [];
  for (const runtime of runtimes) for (const { name } of cases) {
    const matched = [];
    for (let pair = 0; pair < pairs; pair++) {
      const get = role => records.find(r => r.runtime === runtime && r.pair === pair && r.role === role).result.results.find(r => r.name === name).medianMs;
      matched.push({ baselineMs: get('baseline'), candidateMs: get('candidate'), ratio: get('candidate') / get('baseline') });
    }
    const ratios = matched.map(p => Math.log(p.ratio)), mean = ratios.reduce((a, b) => a + b, 0) / pairs;
    const se = Math.sqrt(ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (pairs - 1) / pairs);
    summary.push({ runtime, name, baselineMs: median(matched.map(p => p.baselineMs)), candidateMs: median(matched.map(p => p.candidateMs)),
      pairedGeomeanRatio: Math.exp(mean), interval95: pairs === 6 ? [Math.exp(mean - 2.570581835636305 * se), Math.exp(mean + 2.570581835636305 * se)] : null, pairs: matched });
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ metadata, end: new Date().toISOString(), records, summary }, null, 2), { flag: 'wx' });
  rmSync(neutral, { recursive: true });
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
