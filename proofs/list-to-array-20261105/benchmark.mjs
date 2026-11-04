/** Compare two freshly built public bundles. Run correctness tracing separately. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONFIG = Object.freeze({ pairs: 6, samples: 11, pilotWarmupMs: 100, warmupMs: 180,
  targetBatchMs: 6, maxRepeat: 1048576, maxRetainedBytes: 64 * 1024 * 1024, childTimeoutMs: 90000 });
export const CASES = Object.freeze([
  ...[0, 16, 1057, 65537].map(size => ({ type: 'number', size, operation: 'toArray' })),
  ...[16, 1057, 65537].map(size => ({ type: 'boolean', size, operation: 'toArray' })),
  ...['string', 'object'].flatMap(type => [1057, 4097].map(size => ({ type, size, operation: 'toArray' }))),
  { type: 'nested', size: 65, operation: 'toArray' },
  { type: 'number', size: 65537, operation: 'forEach' },
].map(c => Object.freeze({ ...c, id: `${c.type}/${c.operation}/${c.size}` })));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function median(values) {
  const a = [...values].sort((a, b) => a - b), m = a.length >>> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function summarize(pairs) {
  const logs = pairs.map(p => Math.log(p.right.medianMs / p.left.medianMs));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((s, x) => s + (x - mean) ** 2, 0) / (logs.length - 1);
  const critical = [0, 12.7062047364, 4.3026527297, 3.1824463053, 2.7764451052, 2.5705818356][logs.length - 1];
  const half = critical * Math.sqrt(variance / logs.length);
  return { pairs: pairs.length, leftMedianMs: median(pairs.map(p => p.left.medianMs)),
    rightMedianMs: median(pairs.map(p => p.right.medianMs)), latencyRatio: Math.exp(mean),
    lower95: Math.exp(mean - half), upper95: Math.exp(mean + half), pairedLogRatios: logs };
}
function manifest(root) {
  const files = {};
  for (const name of readdirSync(join(root, 'dist')).filter(n => n.endsWith('.js')).sort()) {
    files[`dist/${name}`] = hash(readFileSync(join(root, 'dist', name)));
  }
  for (const name of ['shared-list.ts', 'package.json', 'persistent-core.wasm', 'scripts/build-browser.ts']) {
    files[name] = hash(readFileSync(join(root, name)));
  }
  return { commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files };
}
function fixture(api, c) {
  const expected = Array.from({ length: c.size }, (_, i) => c.type === 'number' ? i % 8191 + 0.25
    : c.type === 'boolean' ? i % 3 === 0 : c.type === 'string' ? `界-row-${i}`
    : c.type === 'object' ? { id: i, label: `row-${i}`, values: [i, -(i + 1)] } : i);
  const input = c.type === 'nested' ? expected.map(id => new api.SharedMap('number').set('id', id)) : expected;
  const list = api.compact(new api.SharedList(c.type === 'nested' ? 'SharedMap<number>' : c.type)).pushMany(input);
  function validate(actual) {
    if (actual.length !== expected.length) throw new Error('Materialization length mismatch');
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i], e = expected[i];
      if (!Object.hasOwn(actual, i)) throw new Error(`Missing element ${i}`);
      const valid = c.type === 'object'
        ? a.id === e.id && a.label === e.label && a.values.length === 2
          && a.values[0] === e.values[0] && Object.is(a.values[1], e.values[1]) && Object.isFrozen(a.values)
        : c.type === 'nested' ? a.get('id') === e : Object.is(a, e);
      if (!valid) throw new Error(`Mismatch at ${i}`);
    }
  }
  validate(list.toArray());
  return { list, validate, expected, checksum: expected.reduce((sum, v, i) => sum + (typeof v === 'number' ? v : 0) * ((i & 31) + 1), 0) };
}
export async function subject(request) {
  const { workload: c, phase } = request;
  const api = await import(request.entry);
  const { list, validate, expected, checksum } = fixture(api, c);
  let checkedCalls = 0, checkedValues = 0;
  const batch = repeat => {
    const results = new Array(repeat);
    const start = performance.now();
    if (c.operation === 'toArray') {
      for (let i = 0; i < repeat; i++) results[i] = list.toArray();
    } else {
      for (let i = 0; i < repeat; i++) {
        let sum = 0;
        list.forEach((value, index) => { sum += value * ((index & 31) + 1); });
        results[i] = sum;
      }
    }
    const elapsed = performance.now() - start;
    // Retain and validate every result after timing, not just a length/sentinel.
    for (const result of results) {
      if (c.operation === 'toArray') validate(result);
      else assert.equal(result, checksum);
    }
    checkedCalls += repeat; checkedValues += repeat * c.size;
    return elapsed;
  };
  const cap = c.operation === 'toArray'
    ? Math.min(CONFIG.maxRepeat, Math.max(1, Math.floor(CONFIG.maxRetainedBytes / (32 + c.size * 8)))) : CONFIG.maxRepeat;
  let repeat = Math.max(1, Math.min(cap, Math.ceil(32768 / Math.max(c.size, 1))));
  if (phase === 'pilot') {
    let warmupMs = 0;
    while (warmupMs < CONFIG.pilotWarmupMs) warmupMs += batch(repeat);
    const calibration = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      const samples = Array.from({ length: 3 }, () => batch(repeat));
      calibration.push({ repeat, samples });
      const fastest = Math.min(...samples);
      if (fastest >= CONFIG.targetBatchMs * 1.25 || repeat === cap) {
        return { phase, repeat, fastestMs: fastest / repeat, capped: repeat === cap && fastest < CONFIG.targetBatchMs,
          warmupMs, calibration, checkedCalls, checkedValues, expectedHash: hash(JSON.stringify(expected)) };
      }
      repeat = Math.min(cap, Math.ceil(repeat * Math.min(8, Math.max(1.25, CONFIG.targetBatchMs * 1.5 / Math.max(fastest, 0.001)))));
    }
    throw new Error('Pilot could not calibrate');
  }
  assert.equal(phase, 'measure');
  repeat = request.repeat;
  assert.ok(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= cap);
  const warmup = [], samples = [];
  for (let remaining = request.warmupCalls; remaining > 0;) {
    const n = Math.min(remaining, repeat); warmup.push({ repeat: n, ms: batch(n) }); remaining -= n;
  }
  for (let i = 0; i < CONFIG.samples; i++) samples.push(batch(repeat));
  validate(list.toArray());
  return { phase, runtime: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.version,
    repeat, warmupCalls: request.warmupCalls, warmup, samples, medianMs: median(samples) / repeat,
    belowTargetBatches: samples.filter(ms => ms < CONFIG.targetBatchMs).length,
    checkedCalls, checkedValues, expectedHash: hash(JSON.stringify(expected)) };
}
async function main() {
  if (process.argv[2] === '--subject') { console.log(JSON.stringify(await subject(JSON.parse(process.argv[3])))); return; }
  const [baseArg, headArg, outputArg] = process.argv.slice(2);
  if (!baseArg || !headArg || !outputArg) throw new Error('Usage: node|bun benchmark.mjs BASE_REPOSITORY HEAD_REPOSITORY OUTPUT.json');
  const roots = { baseline: resolve(baseArg), candidate: resolve(headArg) }, output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Do not overwrite a previous recording');
  const manifests = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, manifest(root)]));
  assert.equal(manifests.baseline.files['package.json'], manifests.candidate.files['package.json']);
  assert.equal(manifests.baseline.files['persistent-core.wasm'], manifests.candidate.files['persistent-core.wasm']);
  const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-list-array-')), neutral = join(temporary, 'subject');
  mkdirSync(neutral); const entry = pathToFileURL(join(neutral, 'dist', 'shared.js')).href;
  const record = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', config: CONFIG,
    runtime: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.version,
    platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, manifests,
    harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))), rows: [] };
  const checkpoint = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output + '.partial', JSON.stringify(record, null, 2) + '\n'); };
  let sequence = 0;
  const run = (build, request) => {
    rmSync(join(neutral, 'dist'), { recursive: true, force: true });
    cpSync(join(roots[build], 'dist'), join(neutral, 'dist'), { recursive: true });
    cpSync(join(roots[build], 'package.json'), join(neutral, 'package.json'));
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--subject', JSON.stringify({ ...request, entry })], {
      encoding: 'utf8', timeout: CONFIG.childTimeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' },
    });
    if (child.status !== 0) throw new Error(child.error ?? child.stderr ?? child.stdout);
    return { sequence: sequence++, build, startedAt, ...JSON.parse(child.stdout) };
  };
  try {
    for (const workload of CASES) {
      const row = { workload, pilots: {}, ab: [], aa: [] }; record.rows.push(row);
      for (const build of ['baseline', 'candidate']) row.pilots[build] = run(build, { workload, phase: 'pilot' });
      assert.equal(row.pilots.baseline.expectedHash, row.pilots.candidate.expectedHash);
      row.plan = { repeat: Math.max(...Object.values(row.pilots).map(p => p.repeat)),
        warmupCalls: Math.ceil(CONFIG.warmupMs / Math.min(...Object.values(row.pilots).map(p => p.fastestMs))) };
      const modes = workload.id === 'number/toArray/65537' ? ['ab', 'aa'] : ['ab'];
      for (let pair = 0; pair < CONFIG.pairs; pair++) for (const mode of modes) {
        const roles = pair % 2 ? ['right', 'left'] : ['left', 'right'];
        const result = { pair, roles };
        for (const role of roles) result[role] = run(mode === 'aa' || role === 'left' ? 'baseline' : 'candidate',
          { workload, phase: 'measure', ...row.plan });
        assert.equal(result.left.expectedHash, result.right.expectedHash);
        row[mode].push(result); checkpoint();
      }
      row.summary = { ab: summarize(row.ab), ...(row.aa.length ? { aa: summarize(row.aa) } : {}) };
      checkpoint(); console.log(`${workload.id}: ${row.summary.ab.latencyRatio.toFixed(3)} candidate/baseline [${row.summary.ab.lower95.toFixed(3)}, ${row.summary.ab.upper95.toFixed(3)}]`);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(roots).map(([n, root]) => [n, manifest(root)])), manifests);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint(); renameSync(output + '.partial', output);
  } catch (error) {
    record.status = 'failed'; record.error = String(error.stack ?? error); checkpoint(); throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
