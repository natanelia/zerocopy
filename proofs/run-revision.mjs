import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const original = resolve(process.argv[2] ?? '../baseline'), previous = resolve(process.argv[3] ?? '../previous');
const output = resolve(process.argv[4] ?? 'proofs/results/revision.json');
if (new Set([root, original, previous]).size !== 3) throw Error('Use three separate source directories');
const bun = process.env.BUN_BIN ?? 'bun';
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
const names = ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue'];
const scenarios = ['list.pushMany', 'list.toArray', 'list.push', 'map.setMany', 'map.get', 'linked.randomGet', 'linked.append', 'doubly.randomGet', 'doubly.append', 'ordered.set', 'sorted.set', 'priority.enqueue', 'queue.build', 'stack.build'];
const run = (command, args, cwd, env = {}) => {
  const p = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (p.status !== 0) throw Error(`${command} failed: ${p.stdout}\n${p.stderr}`); return p.stdout;
};
function fingerprint(dir) {
  const files = readdirSync(dir).filter(p => p === 'persistent-core.as.ts' || ['arena.ts', 'read-cache.ts', 'compaction.ts', 'codec.ts', 'types.ts', 'utf8.ts', 'wasm-utils.ts', 'set-key.ts', 'shared.ts'].includes(p) || /^(shared-|linked-list|singly-linked-list|doubly-linked-list|ordered-map|priority-queue|sorted-tree).*\.ts$/.test(p) && !p.endsWith('.test.ts')).sort();
  const hash = createHash('sha256'); for (const f of files) hash.update(f + '\0').update(readFileSync(join(dir, f))).update('\0');
  return { files, sha256: hash.digest('hex') };
}
const sources = { original: fingerprint(original), previous: fingerprint(previous), current: fingerprint(root) };
const bench = readFileSync(join(root, 'proofs/compare.ts'));
const benchmarkSHA256 = createHash('sha256').update(bench).digest('hex');
const temp = mkdtempSync(join(tmpdir(), 'zerocopy-revision-'));
const rounds = [];
try {
  for (const dir of [original, previous]) { mkdirSync(join(dir, 'proofs'), { recursive: true }); writeFileSync(join(dir, 'proofs/compare.ts'), bench); }
  run(bun, ['run', 'build:wasm'], original);
  for (const name of names) copyFileSync(join(original, `${name}.wasm`), join(temp, `${name}-original.wasm`));
  for (const name of names) {
    run(process.execPath, [join(root, 'node_modules/assemblyscript/bin/asc.js'), `${name}.as.ts`, '-o', `${name}.wasm`, ...flags], original);
    copyFileSync(join(original, `${name}.wasm`), join(temp, `${name}-matched.wasm`));
  }
  for (const dir of [previous, root]) run(process.execPath, ['scripts/build-wasm.mjs'], dir);
  mkdirSync(resolve(output, '..'), { recursive: true });
  const order = ['original', 'current', 'matched', 'previous'];
  for (let round = 0; round < 3; round++) for (let k = 0; k < order.length; k++) {
    const label = order[(k + round) % order.length], cwd = label === 'current' ? root : label === 'previous' ? previous : original;
    if (cwd === original) for (const name of names) copyFileSync(join(temp, `${name}-${label}.wasm`), join(original, `${name}.wasm`));
    console.error(`round ${round + 1}: ${label}`);
    const rows = scenarios.map(name => JSON.parse(run(bun, ['proofs/compare.ts'], cwd, { ONLY: name, LABEL: label, N: '4096', SAMPLES: '15' })));
    rounds.push({ round: round + 1, label, metadata: { ...rows[0], rows: undefined, sink: undefined }, rows: rows.flatMap(r => r.rows) });
    writeFileSync(output + '.partial', JSON.stringify({ sources, benchmarkSHA256, rounds }));
  }
  const median = x => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
  const summary = scenarios.map(name => {
    const ms = label => median(rounds.filter(r => r.label === label).flatMap(r => r.rows.find(x => x.name === name).samplesMs));
    const originalMs = ms('original'), matchedMs = ms('matched'), previousMs = ms('previous'), currentMs = ms('current');
    return { name, originalMs, matchedMs, previousMs, currentMs, versusMatched: matchedMs / currentMs, versusPrevious: previousMs / currentMs };
  });
  if (fingerprint(root).sha256 !== sources.current.sha256) throw Error('Source changed during measurement');
  const result = { measuredAt: new Date().toISOString(), referenceCommits: { original: '7aea44447177d37a303ab5c1b26d7c5e00e1c1f7', previous: '59bd5ad9f84358f828968910c66b9a2e80c0673d' }, sources, benchmarkSHA256, compiler: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'))).version, flags, candidateWasmSHA256: createHash('sha256').update(readFileSync(join(root, 'persistent-core.wasm'))).digest('hex'), summary, rounds };
  writeFileSync(output, JSON.stringify(result) + '\n'); rmSync(output + '.partial'); console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
