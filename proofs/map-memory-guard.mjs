/** Compare memory and speed together. The two runtime checkouts must already be built. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const before = resolve(process.argv[2] ?? '../before-memory');
const output = resolve(process.argv[3] ?? join(root, 'proofs/results/map-memory'));
assert.notEqual(root, before, 'Use a separate baseline checkout');
mkdirSync(output, { recursive: true });
const bun = process.env.BUN_BIN ?? 'bun';
const drivers = ['readme-libraries.ts', 'hot-path-workloads.ts', 'library-memory.mjs'];
for (const file of drivers) assert.equal(readFileSync(join(root, 'proofs', file), 'utf8'), readFileSync(join(before, 'proofs', file), 'utf8'), `${file}: benchmark semantics must be identical`);
function fingerprint(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(readFileSync(join(dir, file))).update('\0');
  return { files, sha256: hash.digest('hex'), wasmSHA256: createHash('sha256').update(readFileSync(join(dir, 'persistent-core.wasm'))).digest('hex') };
}
const sources = { before: fingerprint(before), current: fingerprint(root) };
const caseFilter = ['SharedMap:set', 'SharedMap:get', 'SharedMap:has', 'SharedMap:delete', 'SharedMap:setMany(100)', 'SharedOrderedMap:set', 'SharedOrderedMap:get', 'SharedOrderedMap:has', 'SharedOrderedMap:delete', 'SharedOrderedMap:forEach'].join(',');
function run(command, args, cwd, env = {}) {
  const p = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
  if (p.status !== 0) throw Error(`${command} ${args.join(' ')} failed\n${p.stdout}\n${p.stderr}`);
  return p.stdout;
}
const records = [], memory = [];
for (let round = 1; round <= 3; round++) {
  // Reverse the source order in the middle round, in addition to the library rotation.
  for (const label of round === 2 ? ['current', 'before'] : ['before', 'current']) {
    const cwd = label === 'current' ? root : before;
    const common = { ROUND: String(round), SAMPLES: '15', N: '10000', INCLUDE_ARENA_SETUP: '0', CASE_FILTER: caseFilter };
    for (const [suite, driver] of [['timing', 'readme-libraries.ts'], ['extra', 'hot-path-workloads.ts']]) {
      const path = join(output, `${label}-${suite}-${round}.json`);
      console.error(`${label}: ${suite}, round ${round}`);
      run(bun, [`proofs/${driver}`, path], cwd, common);
      records.push({ label, suite, round, file: path.split('/').pop(), data: JSON.parse(readFileSync(path, 'utf8')) });
    }
    for (const [name, n, state] of [['Map', 10000, 'warm'], ['Map', 100000, 'warm'], ['Map', 10000, 'history'], ['Map', 10000, 'compact'], ['OrderedMap', 10000, 'warm']]) {
      for (const kind of ['shared', 'immutable', 'native']) {
        const data = JSON.parse(run(process.execPath, ['--expose-gc', 'proofs/library-memory.mjs', '--case', name, kind, state, String(n)], cwd));
        memory.push({ label, round, ...data });
      }
    }
  }
  writeFileSync(join(output, 'memory-raw.json'), JSON.stringify({ method: 'Unchanged library-memory.mjs; post-GC heap delta plus full retained backing buffers. Three isolated processes per case.', samples: memory }) + '\n');
}
const median = x => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
const speed = [];
for (const suite of ['timing', 'extra']) {
  const first = records.find(r => r.suite === suite).data.rows;
  for (const row of first.filter(r => r.kind === 'shared')) {
    const key = suite === 'timing' ? `${row.group}:${row.operation}` : row.name;
    const values = (label, kind) => records.filter(r => r.suite === suite && r.label === label).flatMap(r => r.data.rows.filter(x => x.kind === kind && (suite === 'timing' ? `${x.group}:${x.operation}` : x.name) === key).flatMap(x => x.samplesMs));
    const beforeMs = median(values('before', 'shared')), sharedMs = median(values('current', 'shared'));
    const immutableMs = median(values('current', 'immutable')), nativeMs = median(values('current', 'native'));
    const byRound = [1, 2, 3].map(round => {
      const get = label => median(records.find(r => r.suite === suite && r.label === label && r.round === round).data.rows.find(x => x.kind === 'shared' && (suite === 'timing' ? `${x.group}:${x.operation}` : x.name) === key).samplesMs);
      return get('before') / get('current');
    });
    speed.push({ suite, key, beforeMs, sharedMs, immutableMs, nativeMs, versusBefore: beforeMs / sharedMs, versusImmutable: immutableMs / sharedMs, beforeSpeedupByRound: byRound });
  }
}
const memorySummary = memory.filter(r => r.round === 1 && r.label === 'current' && r.kind === 'shared').map(row => {
  const values = (label, kind, field) => memory.filter(r => r.label === label && r.kind === kind && r.name === row.name && r.n === row.n && r.state === row.state).map(r => field === 'allocatedBytes' ? r.binary.allocatedBytes : r[field]);
  return { name: row.name, n: row.n, state: row.state, before: median(values('before', 'shared', 'retainedBytes')), shared: median(values('current', 'shared', 'retainedBytes')), immutable: median(values('current', 'immutable', 'retainedBytes')), native: median(values('current', 'native', 'retainedBytes')), beforeAllocated: median(values('before', 'shared', 'allocatedBytes')), sharedAllocated: median(values('current', 'shared', 'allocatedBytes')) };
});
assert.equal(fingerprint(root).sha256, sources.current.sha256, 'Current source changed during measurement');
assert.equal(fingerprint(before).sha256, sources.before.sha256, 'Baseline source changed during measurement');
const summary = { measuredAt: new Date().toISOString(), cpu: cpus()[0].model, node: process.version, sources, samplesPerTimingCell: 45, memoryTrials: 3, speed, memory: memorySummary };
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
