#!/usr/bin/env node
// Paired, serial Node/Bun measurements of the same frozen portable bundles.
// Example: node benchmark.mjs --workloads map-workloads.mjs --baseline /base \
//   --candidate /candidate --bun /path/bun --pairs 7 --output formal.json
// Identical checkout paths produce a separate A/A noise control. Outputs never overwrite.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), directory = dirname(script);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const allowedCpus = () => {
  try { return readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null; }
  catch { return null; }
};
const median = values => { const s = [...values].sort((a, b) => a - b), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function files(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? files(root, name) : entry.isFile() ? [name] : [];
  }).sort();
}
function inventory(root) {
  const captured = new Map();
  const capture = file => { const bytes = readFileSync(join(root, file)); captured.set(file, bytes); return bytes; };
  const sourceFiles = [...readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') || name.endsWith('.wasm')),
    ...files(join(root, 'rust', 'src')).map(name => `rust/src/${name}`),
    'package.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust-toolchain.toml', 'rust/wasm-abi.json',
    'scripts/build-wasm.mjs', 'scripts/rust-wasm.mjs', 'scripts/build-browser.ts'].sort();
  const source = sourceFiles.map(file => ({ file, sha256: hash(capture(file)) }));
  const bundles = files(join(root, 'dist')).filter(file => extname(file) === '.js').map(file => {
    const bytes = capture(`dist/${file}`); return { file: `dist/${file}`, bytes: bytes.length, sha256: hash(bytes) };
  });
  if (!bundles.some(file => file.file === 'dist/shared.js')) throw new Error(`Missing built dist/shared.js: ${root}`);
  return { files: captured, metadata: { path: root, commit: git(root, 'rev-parse', 'HEAD'), trackedDiffSha256: hash(git(root, 'diff', 'HEAD', '--')),
    status: git(root, 'status', '--short'), source, sourceManifestSha256: hash(JSON.stringify(source)), bundles,
    bundleManifestSha256: hash(JSON.stringify(bundles)), dependencyVersions: JSON.parse(captured.get('package.json').toString()).devDependencies } };
}

if (process.argv.includes('--worker')) {
  const { run } = await import(pathToFileURL(join(directory, 'workloads.mjs')).href);
  const config = JSON.parse(readFileSync(arg('config'), 'utf8'));
  const lib = await import(pathToFileURL(arg('entry')).href);
  const result = await run(lib, config, Number(arg('rotation', 0)));
  process.stdout.write(JSON.stringify({ versions: process.versions, allowedCpus: allowedCpus(), ...result }));
} else {
  if (!arg('baseline') || !arg('candidate')) throw new Error('Pass --baseline and --candidate checkout paths');
  const baseline = resolve(arg('baseline')), candidate = resolve(arg('candidate'));
  const workloadPath = resolve(arg('workloads', join(directory, 'workloads.mjs')));
  const harnessBytes = { driver: readFileSync(script), workloads: readFileSync(workloadPath) };
  const { cases } = await import(pathToFileURL(workloadPath).href);
  const declaredCases = cases.map(item => item.name);
  if (!cases.length || new Set(declaredCases).size !== cases.length) throw new Error('Invalid workload catalog');
  const pairs = Number(arg('pairs', 7)), runtimes = arg('runtimes', 'node,bun').split(',');
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 30) throw new Error('--pairs must be 1..30');
  if (!runtimes.length || new Set(runtimes).size !== runtimes.length || runtimes.some(name => !['node', 'bun'].includes(name))) throw new Error('Choose unique runtimes: node,bun');
  const config = { warmups: Number(arg('warmups', 8)), batchScale: Number(arg('batch-scale', 1)), only: arg('only', '').split(',').filter(Boolean) };
  if (!Number.isFinite(config.batchScale) || config.batchScale <= 0 || config.batchScale > 64) throw new Error('Invalid --batch-scale');
  if (!Number.isSafeInteger(config.warmups) || config.warmups < 0 || config.warmups > 64) throw new Error('Invalid --warmups');
  if (new Set(config.only).size !== config.only.length || config.only.some(name => !declaredCases.includes(name))) throw new Error('Choose unique declared cases');
  config.caseNames = declaredCases.filter(name => !config.only.length || config.only.includes(name));
  const captured = { baseline: inventory(baseline), candidate: inventory(candidate) };
  const output = resolve(arg('output', join(directory, 'results.json')));
  if (existsSync(output)) throw new Error(`Refusing to overwrite evidence: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const outputFd = openSync(output, 'wx'), temporary = mkdtempSync(join(tmpdir(), 'zerocopy-followup-'));
  const report = { schema: 'zerocopy-followup-performance/v1', complete: false, startedAt: new Date().toISOString(), pairs, runtimes, config,
    catalog: cases, harness: { driverSha256: hash(harnessBytes.driver), workloadsSha256: hash(harnessBytes.workloads) },
    environment: { platform: platform(), release: release(), architecture: process.arch, allowedCpus: allowedCpus(),
      cpus: cpus().map(cpu => ({ model: cpu.model, speed: cpu.speed })), totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), loadAtStart: loadavg() },
    variants: Object.fromEntries(Object.entries(captured).map(([name, value]) => [name, value.metadata])),
    notes: [
      'Every runtime/pair/variant runs in a fresh process. Variant order alternates; workload order rotates. All runs are serial.',
      'Both runtimes import identical portable dist/shared.js builds; Bun source exports are not used.',
      'The exact captured source, bundles, and harness bytes are staged before measurement. No output path is overwritten.',
      'Each workload declares its timed region. Inputs, warmup, GC, and verification are outside timing.',
      'Actual timed results are retained without numeric coercion and verified after timing; no checksum replaces exact validation.',
      'Every distinct read-only Arena is checked for used/capacity changes; immutable byte checks deduplicate only common memory.',
      'Attached readers run in the writer process. Measurements are not cross-worker transport or process startup latency.',
      'The engine is warm; integrity snapshots can warm CPU caches. JavaScript heap bytes, peak RSS, and GC pause attribution are not measured.',
      'A/A comparisons are separate noise observations and never normalize A/B ratios. Batches below 20 ms are flagged.',
    ], samples: [] };
  const save = () => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(outputFd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error('Could not save evidence');
      offset += written;
    }
    ftruncateSync(outputFd, bytes.length);
  };
  const operationCounts = new Map();
  const validate = result => {
    if (result.allowedCpus !== report.environment.allowedCpus) throw new Error('Worker CPU affinity differs from controller');
    if (!Array.isArray(result.rows) || result.rows.length !== config.caseNames.length || new Set(result.rows.map(row => row.name)).size !== result.rows.length
      || result.rows.some(row => !config.caseNames.includes(row.name))) throw new Error('Worker case coverage mismatch');
    for (const row of result.rows) {
      if (!Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0 || !Number.isSafeInteger(row.operations) || row.operations <= 0
        || row.millisecondsPer10000 !== row.elapsedMs / row.operations * 10000) throw new Error(`Invalid timing: ${row.name}`);
      if (operationCounts.has(row.name) && operationCounts.get(row.name) !== row.operations) throw new Error(`Operation count changed: ${row.name}`);
      operationCounts.set(row.name, row.operations);
    }
  };
  save();
  try {
    writeFileSync(join(temporary, 'benchmark.mjs'), harnessBytes.driver);
    writeFileSync(join(temporary, 'workloads.mjs'), harnessBytes.workloads);
    writeFileSync(join(temporary, 'config.json'), JSON.stringify(config));
    for (const variant of ['baseline', 'candidate']) {
      const root = join(temporary, variant);
      const manifest = new Map([...report.variants[variant].source, ...report.variants[variant].bundles].map(entry => [entry.file, entry.sha256]));
      for (const [file, bytes] of captured[variant].files) {
        if (hash(bytes) !== manifest.get(file)) throw new Error('Captured file differs from fingerprint');
        mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), bytes);
      }
    }
    for (const runtime of runtimes) for (let pair = 0; pair < pairs; pair++) for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const executable = runtime === 'node' ? arg('node', process.execPath) : arg('bun', 'bun');
      const result = JSON.parse(execFileSync(executable, ['--expose-gc', join(temporary, 'benchmark.mjs'), '--worker',
        '--entry', join(temporary, variant, 'dist/shared.js'), '--config', join(temporary, 'config.json'), '--rotation', String(pair)],
      { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 }));
      validate(result); report.samples.push({ runtime, pair, variant, ...result }); save();
      process.stderr.write(`${runtime} pair ${pair + 1}/${pairs} ${variant}: ${result.rows.length} workloads verified\n`);
    }
    report.summary = runtimes.flatMap(runtime => config.caseNames.map(name => {
      const get = (variant, pair) => report.samples.find(sample => sample.runtime === runtime && sample.variant === variant && sample.pair === pair).rows.find(row => row.name === name);
      const rows = variant => Array.from({ length: pairs }, (_, pair) => get(variant, pair));
      const ratios = Array.from({ length: pairs }, (_, pair) => get('candidate', pair).elapsedMs / get('baseline', pair).elapsedMs);
      const batches = [...rows('baseline'), ...rows('candidate')].map(row => row.elapsedMs);
      return { runtime, name, baselineMedianMsPer10000: median(rows('baseline').map(row => row.millisecondsPer10000)),
        candidateMedianMsPer10000: median(rows('candidate').map(row => row.millisecondsPer10000)), pairedRatios: ratios, medianPairedRatio: median(ratios),
        candidateFasterPairs: ratios.filter(ratio => ratio < 1).length, minimumBatchMs: Math.min(...batches), shortBatchWarning: batches.some(ms => ms < 20) };
    }));
    report.complete = true; report.finishedAt = new Date().toISOString(); report.environment.loadAtEnd = loadavg(); save();
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } catch (error) { report.error = error.stack; save(); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); closeSync(outputFd); }
}
