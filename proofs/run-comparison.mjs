import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Supply a separate checkout of the pinned base. Never rewrite the candidate.
const root = resolve(import.meta.dirname, '..');
const baseline = resolve(process.argv[2] ?? '../baseline');
if (baseline === root) throw Error('The baseline must be a separate directory');
const output = resolve(process.argv[3] ?? join(root, 'proofs/results/local.json'));
const bun = process.env.BUN_BIN ?? 'bun';
const baseSHA = '7aea44447177d37a303ab5c1b26d7c5e00e1c1f7';
const entries = ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue'];
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
const temp = mkdtempSync(join(tmpdir(), 'zerocopy-proof-'));
const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const baselineFiles = ["codec.ts", "doubly-linked-list.as.ts", "linked-list.as.ts", "ordered-map.as.ts", "priority-queue.as.ts", "shared-doubly-linked-list.ts", "shared-linked-list.ts", "shared-list.as.ts", "shared-list.ts", "shared-map.as.ts", "shared-map.ts", "shared-ordered-map.ts", "shared-ordered-set.ts", "shared-priority-queue.ts", "shared-queue.ts", "shared-set.ts", "shared-sorted-map.ts", "shared-sorted-set.ts", "shared-stack.ts", "shared.ts", "singly-linked-list.as.ts", "sorted-tree.as.ts", "types.ts", "wasm-utils.ts"];
const baseHash = createHash('sha256');
for (const file of baselineFiles) baseHash.update(file + '\0').update(readFileSync(join(baseline, file))).update('\0');
const baselineEngineSHA256 = baseHash.digest('hex');
if (baselineEngineSHA256 !== '8dfcd6c936b4875ebfcd6e13dd214d5b84d2d6301f1c5f6c68704a2f357352fa') throw Error('Baseline source does not match the pinned commit');

const engineFiles = readdirSync(root).filter(p => (p === 'persistent-core.as.ts' || p === 'shared-hash-reader.as.ts' || p === 'shared-runtime.as.ts') || p === 'compaction.ts' || p === 'arena.ts' || p === 'utf8.ts' || p === 'codec.ts' || p === 'types.ts' || p === 'wasm-utils.ts' || p === 'set-key.ts' || p === 'shared.ts' || /^shared-.*\.ts$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.as.ts')).sort();
const hash = createHash('sha256');
for (const file of engineFiles) hash.update(file + '\0').update(readFileSync(join(root, file))).update('\0');
const candidateEngineSHA256 = hash.digest('hex');
const benchmarkSHA256 = createHash('sha256').update(readFileSync(join(root, 'proofs/compare.ts'))).digest('hex');
try {
  run(process.execPath, ['scripts/build-wasm.mjs'], root);
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(join(temp, 'original')); mkdirSync(join(temp, 'optimized'));
  mkdirSync(join(baseline, 'proofs'), { recursive: true });
  copyFileSync(join(root, 'proofs/compare.ts'), join(baseline, 'proofs/compare.ts'));
  console.error('Build the original baseline'); run(bun, ['run', 'build:wasm'], baseline);
  for (const name of entries) copyFileSync(join(baseline, `${name}.wasm`), join(temp, 'original', `${name}.wasm`));
  console.error('Build the same baseline with the candidate compiler flags');
  for (const name of entries) {
    run(process.execPath, [join(root, 'node_modules/assemblyscript/bin/asc.js'), `${name}.as.ts`, '-o', `${name}.wasm`, ...flags], baseline);
    copyFileSync(join(baseline, `${name}.wasm`), join(temp, 'optimized', `${name}.wasm`));
  }
  const scenarios = ['list.pushMany', 'list.toArray', 'list.push', 'map.setMany', 'map.get', 'linked.randomGet', 'linked.append', 'doubly.randomGet', 'doubly.append', 'ordered.set', 'sorted.set', 'priority.enqueue', 'queue.build', 'stack.build'];
  const checkpoint = output + '.partial';
  let rounds = [];
  if (process.env.RESUME === '1' && existsSync(checkpoint)) {
    const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
    if (saved.candidateEngineSHA256 !== candidateEngineSHA256 || saved.benchmarkSHA256 !== benchmarkSHA256 || saved.baselineEngineSHA256 !== baselineEngineSHA256) throw Error('Checkpoint sources have changed; run without RESUME');
    rounds = saved.rounds;
  }
  for (let round = 0; round < 3; round++) {
    const order = [['original', 'candidate', 'optimized'], ['optimized', 'original', 'candidate'], ['candidate', 'optimized', 'original']][round];
    for (const label of order) {
      if (rounds.some(r => r.round === round + 1 && r.label === label)) continue;
      const cwd = label === 'candidate' ? root : baseline;
      if (label !== 'candidate') for (const name of entries) copyFileSync(join(temp, label, `${name}.wasm`), join(baseline, `${name}.wasm`));
      console.error(`Round ${round + 1}: ${label}`);
      const cases = scenarios.map(name => JSON.parse(run(bun, ['proofs/compare.ts'], cwd, { LABEL: label, SAMPLES: '15', N: '4096', ONLY: name })));
      rounds.push({ round: round + 1, ...cases[0], isolatedProcesses: true, rows: cases.flatMap(c => c.rows), sink: cases.reduce((s, c) => s + c.sink, 0) });
      writeFileSync(checkpoint, JSON.stringify({ candidateEngineSHA256, benchmarkSHA256, baselineEngineSHA256, rounds }));
    }
  }
  const summary = rounds[0].rows.map(row => {
    const times = label => rounds.filter(r => r.label === label).flatMap(r => r.rows.find(x => x.name === row.name).samplesMs);
    const original = median(times('original')), optimized = median(times('optimized')), candidate = median(times('candidate'));
    return { name: row.name, units: row.units, originalMs: original, optimizedMs: optimized, candidateMs: candidate, originalSpeedup: original / candidate, optimizedSpeedup: optimized / candidate };
  });
  const result = { baselineCommit: baseSHA, baselineEngineSHA256, measuredAt: new Date().toISOString(), engineFiles, candidateEngineSHA256, candidateWasmSHA256: createHash('sha256').update(readFileSync(join(root, 'persistent-core.wasm'))).digest('hex'), compiler: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'))).version, matchedCompilerFlags: flags, benchmarkSHA256, summary, rounds };
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(result) + '\n');
  rmSync(output + '.partial', { force: true });
  console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
