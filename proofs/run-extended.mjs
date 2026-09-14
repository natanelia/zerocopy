import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), matched = resolve(process.argv[2]), previous = resolve(process.argv[3]);
const output = resolve(process.argv[4] ?? 'proofs/results/extended.json'), bun = process.env.BUN_BIN ?? 'bun';
if (new Set([root, matched, previous]).size !== 3) throw Error('Use separate directories');
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
function run(command, args, cwd, env = {}) {
  const p = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (p.status !== 0) throw Error(p.stdout + '\n' + p.stderr); return p.stdout;
}
const sources = {};
for (const [name, dir] of Object.entries({ matched, previous, current: root })) {
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !['benchmark.ts'].includes(f)).sort(), hash = createHash('sha256');
  for (const f of files) hash.update(f + '\0').update(readFileSync(join(dir, f))).update('\0');
  sources[name] = { files, sha256: hash.digest('hex') };
}
for (const name of ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue']) {
  run(process.execPath, [join(root, 'node_modules/assemblyscript/bin/asc.js'), name + '.as.ts', '-o', name + '.wasm', ...flags], matched);
}
for (const dir of [root, previous]) run(process.execPath, ['scripts/build-wasm.mjs'], dir);
const cases = ['ordered.write+scan', 'sorted.write+scan', 'sorted.longPrefix+scan', 'map.coldGetAfterBulk', 'map.objectWrite+read', 'queue.fullCycle'];
const labels = ['current', 'matched', 'previous'], rounds = [];
for (let round = 0; round < 3; round++) for (let k = 0; k < 3; k++) {
  const label = labels[(k + round) % 3], dir = label === 'current' ? root : label === 'matched' ? matched : previous;
  console.error(`extended ${round + 1}: ${label}`);
  const data = cases.map(name => JSON.parse(run(bun, ['proofs/extended.ts'], root, { ENGINE_ROOT: dir, ONLY: name, LABEL: label, SAMPLES: '15' })));
  rounds.push({ round: round + 1, label, runtime: data[0].runtime, rows: data.flatMap(d => d.rows) });
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = cases.map(name => {
  const ms = label => median(rounds.filter(r => r.label === label).flatMap(r => r.rows.find(x => x.name === name).samplesMs));
  const matchedMs = ms('matched'), previousMs = ms('previous'), currentMs = ms('current');
  return { name, matchedMs, previousMs, currentMs, versusMatched: matchedMs / currentMs, versusPrevious: previousMs / currentMs };
});
mkdirSync(resolve(output, '..'), { recursive: true });
writeFileSync(output, JSON.stringify({ sources, flags, measuredAt: new Date().toISOString(), benchmarkSHA256: createHash('sha256').update(readFileSync(join(root, 'proofs/extended.ts'))).digest('hex'), summary, rounds }) + '\n');
console.log(JSON.stringify(summary, null, 2));
