import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { chromium, firefox, webkit } from 'playwright';

const proof = fileURLToPath(new URL('./primitive-compaction-performance.mjs', import.meta.url));
const prepared = spawnSync(process.execPath, [proof, '--prepare'], { encoding: 'utf8', env: process.env });
if (prepared.status !== 0) throw new Error(prepared.stderr || prepared.error?.message || 'Source preparation failed');
const comparison = JSON.parse(prepared.stdout);
const configuration = { ...comparison.configuration, gcBeforeCalibrationAndSamples: false,
  warmup: { ...comparison.configuration.warmup, gcEveryCalls: 0, durationIncludesGC: false } };
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
for (const name of engines) assert.ok(['chromium', 'firefox', 'webkit'].includes(name), `Invalid browser: ${name}`);
const roots = Object.fromEntries(Object.entries(comparison.paths).map(([name, path]) => [name, join(path, 'dist')]));
roots['worker-candidate'] = join(comparison.candidatePath, 'dist');
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Primitive compaction diagnostic</title>'); return; }
  const [, variant, ...parts] = new URL(request.url, 'http://localhost').pathname.split('/'), root = roots[variant];
  const path = root && resolve(root, ...parts);
  if (!path || !path.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(path)); }
  catch { response.writeHead(404); response.end(); }
});

// Each invocation runs in a fresh page/context and imports exactly one build.
async function measure({ entry, workload, config }) {
  if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
  const S = await import(entry), { kind, type, size } = workload;
  const serialize = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && Object.is(item, -0) ? { negativeZero: true } : item);
  const valuesOf = value => {
    if (kind !== 'queue') return value.toArray();
    const values = []; while (value.size) { values.push(value.peek()); value = value.dequeue(); } return values;
  };
  const offset = kind === 'queue' ? 37 : 0;
  const input = Array.from({ length: size + offset }, (_, i) => type === 'number' ? i % 13 ? i / 8 : -0
    : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `value/${i}/界🙂` : { i, child: { active: i % 3 === 0 } });
  let fixture = kind === 'list' ? new S.SharedList(type).pushMany(input) : kind === 'queue' ? new S.SharedQueue(type)
    : kind === 'linked' ? new S.SharedLinkedList(type) : new S.SharedDoublyLinkedList(type);
  if (kind !== 'list') for (const value of input) fixture = kind === 'queue' ? fixture.enqueue(value) : fixture.append(value);
  for (let i = 0; i < offset; i++) fixture = fixture.dequeue();
  const expected = serialize(input.slice(offset));
  const check = result => {
    if (result.size !== size || serialize(valuesOf(result)) !== expected || serialize(valuesOf(fixture)) !== expected) throw new Error('Compaction changed values or its source');
  };
  const sample = repeat => {
    let last, count = 0; const started = performance.now();
    for (let i = 0; i < repeat; i++) { last = S.compact(fixture); count += last.size; }
    const elapsed = performance.now() - started;
    if (count !== repeat * size) throw new Error('Invalid compacted size');
    return { elapsed, last };
  };
  check(S.compact(fixture));
  let warmups = 0; const warmStarted = performance.now();
  do { sample(1); warmups++; } while (warmups < config.warmup.minCalls || performance.now() - warmStarted < config.warmup.minDurationMs);
  let repeat = config.calibration.initialRepeat, calibration; const calibrationAttempts = [];
  while (true) {
    calibration = sample(repeat); check(calibration.last); calibrationAttempts.push({ repeat, elapsedMs: calibration.elapsed });
    if (calibration.elapsed >= config.targetBatchMs || repeat >= config.maxRepeat) break;
    repeat *= config.calibration.growthFactor;
  }
  const samplesMs = [], batchesMs = [];
  for (let i = 0; i < config.samples; i++) {
    const result = sample(repeat); samplesMs.push(result.elapsed / repeat); batchesMs.push(result.elapsed);
    if (!i || i === config.samples - 1) check(result.last);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b), middle = sorted.length >> 1;
  return { ...workload, configuration: config, repeat, warmups, samplesMs, batchesMs,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    calibrationAttempts, calibrationTargetReached: calibration.elapsed >= config.targetBatchMs, hitMaxRepeat: repeat >= config.maxRepeat,
    belowTargetBatches: batchesMs.filter(ms => ms < config.targetBatchMs).length, gcAvailable: false, crossOriginIsolated };
}

async function verifyWorkers(entry) {
  if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
  const S = await import(entry);
  const serialize = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && Object.is(item, -0) ? { negativeZero: true } : item);
  const read = value => { if (typeof value.toArray === 'function') return value.toArray(); const items = []; while (value.size) { items.push(value.peek()); value = value.dequeue(); } return items; };
  const project = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'nested' ? value.get('inner').toArray() : read(value)]));
  let checked = 0;
  for (const copy of [false, true]) {
    const snapshots = {};
    for (const [type, suffix] of [['number', 'Number'], ['boolean', 'Boolean']]) {
      const values = Array.from({ length: 65 }, (_, i) => type === 'number' ? i % 7 ? i : -0 : i % 3 === 0);
      snapshots[`list${suffix}`] = new S.SharedList(type).pushMany(values);
      let queue = new S.SharedQueue(type), linked = new S.SharedLinkedList(type), doubly = new S.SharedDoublyLinkedList(type);
      for (const value of values) { queue = queue.enqueue(value); linked = linked.append(value); doubly = doubly.append(value); }
      snapshots[`queue${suffix}`] = queue.dequeue(); snapshots[`linked${suffix}`] = linked.removeFirst(); snapshots[`doubly${suffix}`] = doubly.removeFirst();
    }
    let tinyLinked = new S.SharedLinkedList('boolean'), tinyDoubly = new S.SharedDoublyLinkedList('boolean');
    for (let i = 0; i < 32; i++) { tinyLinked = tinyLinked.append(i % 2 === 0); tinyDoubly = tinyDoubly.append(i % 2 === 0); }
    Object.assign(snapshots, { tinyLinked, tinyDoubly, nested: new S.SharedMap('SharedList<number>').set('inner', snapshots.listNumber) });
    const expected = serialize(project(snapshots));
    const code = `import * as S from ${JSON.stringify(entry)}; const serialize=${serialize.toString()}, read=${read.toString()}, project=${project.toString()}; let attached, expected; onmessage=async ({data})=>{try{if(data.kind==='attach'){attached=await S.initWorker(data.payload);expected=serialize(project(attached));postMessage('ready');}else{const result=S.compactMany(attached);if(serialize(project(attached))!==expected||serialize(project(result))!==expected)throw new Error('Worker values changed');if(result.listNumber.push(999).get(result.listNumber.size)!==999)throw new Error('Compacted result is not writable');postMessage(S.getWorkerData(result,{copy:true}));}}catch(error){postMessage({error:String(error)});}};`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), worker = new Worker(url, { type: 'module' });
    const exchange = data => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Compaction worker timed out')), 30000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); data?.error ? reject(new Error(data.error)) : resolve(data); };
      worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)); }; worker.postMessage(data);
    });
    try {
      if (await exchange({ kind: 'attach', payload: S.getWorkerData(snapshots, { copy }) }) !== 'ready') throw new Error('Worker did not attach');
      snapshots.listNumber.pushMany(Array.from({ length: 32769 }, (_, i) => i));
      const restored = await S.initWorker(await exchange({ kind: 'compact' }));
      if (serialize(project(restored)) !== expected || serialize(project(snapshots)) !== expected) throw new Error('Roundtrip values changed');
      checked += Object.keys(snapshots).length;
    } finally { worker.terminate(); URL.revokeObjectURL(url); }
  }
  return { sharedAndCopiedWorkers: true, verifiedCollections: checked };
}

const output = resolve(process.env.OUTPUT ?? `primitive-compaction-browser-${comparison.mode}.json`);
mkdirSync(dirname(output), { recursive: true });
const report = { schema: 1, measuredAt: new Date().toISOString(), status: 'running', ...comparison, configuration, engines,
  host: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  browserHarnessSHA256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  method: `Fresh page/context per build, workload and round; one imported build; ${configuration.rounds} alternating-order rounds, ${configuration.samples} samples; full compact including fresh arena creation timed; fixture setup and full value checks outside timing; warmup requires ${configuration.warmup.minCalls} calls and ${configuration.warmup.minDurationMs}ms; one-pilot doubling calibration targets ${configuration.targetBatchMs}ms, capped at ${configuration.maxRepeat}; browser GC is automatic; raw batches, calibration attempts and floor flags retained.`,
  results: [] };
const save = () => { const temp = `${output}.tmp-${process.pid}`; writeFileSync(temp, JSON.stringify(report, null, 2)); renameSync(temp, output); };
save();
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const engine of engines) {
    const browser = await { chromium, firefox, webkit }[engine].launch({ headless: true });
    const result = { engine, version: browser.version(), rows: [], summary: [] }; report.results.push(result); save();
    try {
      for (const workload of comparison.workloads) for (let round = 0; round < configuration.rounds; round++) {
        const row = { workload, round, order: round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'], variants: {} }; result.rows.push(row);
        for (const variant of row.order) {
          report.activeSubject = { engine, name: workload.name, round, variant }; save();
          const page = await browser.newPage(); let timer;
          try {
            await page.goto(origin);
            row.variants[variant] = await Promise.race([
              page.evaluate(measure, { entry: `${origin}/${variant}/shared.js`, workload, config: configuration }),
              new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Browser subject timed out')), configuration.subjectTimeoutMs); }),
            ]);
            assert.deepEqual(row.variants[variant].configuration, configuration);
          } finally { clearTimeout(timer); await page.close(); }
          delete report.activeSubject; save();
        }
        row.ratio = row.variants.baseline.medianMs / row.variants.candidate.medianMs;
        result.summary = comparison.workloads.map(item => {
          const complete = result.rows.filter(row => row.workload.name === item.name && Number.isFinite(row.ratio));
          return { name: item.name, completedRounds: complete.length, expectedRounds: configuration.rounds, ratio: complete.length ? median(complete.map(row => row.ratio)) : null };
        }); save(); console.log(`${engine} ${workload.name} round ${round + 1}: ${row.ratio.toFixed(3)}x`);
      }
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        result.workerProof = { variant: 'candidate', gitHead: comparison.sourceState.candidate.gitHead,
          dirtyProduction: comparison.sourceState.candidate.dirtyProduction,
          ...await page.evaluate(verifyWorkers, `${origin}/worker-candidate/shared.js`) };
      }
      finally { await page.close(); }
      assert.strictEqual(result.workerProof.verifiedCollections, 22); save();
    } finally { await browser.close(); }
  }
  report.status = 'complete'; report.finishedAt = new Date().toISOString(); save();
} catch (error) { report.status = 'failed'; report.error = String(error); report.finishedAt = new Date().toISOString(); save(); throw error; }
finally { await new Promise(resolve => server.close(resolve)); }
