/** Reproducible scalar-write comparison. No transient API or deferred flush. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'proofs/results/map-set-local.json'));
const baseline = process.env.MAP_SET_BASELINE ? resolve(process.env.MAP_SET_BASELINE) : undefined;
const cases = ['insert-string', 'insert-shuffled-string', 'insert-number', 'update-string', 'update-number', 'mixed-number', 'insert-unicode', 'insert-long', 'fork-update-string', 'cold-insert-string'];
const runtimeNames = (process.env.MAP_SET_RUNTIMES ?? 'bun,node').split(',');
assert(runtimeNames.length && runtimeNames.every(name => ['bun', 'node'].includes(name)));
const executable = { bun: process.env.BUN_BIN ?? 'bun', node: process.execPath };
const variants = baseline ? ['shared', 'immutable', 'native', 'before'] : ['shared', 'immutable', 'native'];
const program = join(root, 'proofs/map-set-case.mjs');
function fingerprint(directory) {
  const files = readdirSync(directory).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'benchmark.ts').sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(readFileSync(join(directory, file))).update('\0');
  return { files, sha256: hash.digest('hex'), wasmSHA256: createHash('sha256').update(readFileSync(join(directory, 'persistent-core.wasm'))).digest('hex') };
}
assert(existsSync(join(root, 'dist/shared.js')), 'Build portable modules before measuring');
if (baseline) {
  assert(baseline !== root && existsSync(join(baseline, 'dist/shared.js')), 'Baseline must be a separate built source directory');
  mkdirSync(join(baseline, 'proofs'), { recursive: true }); copyFileSync(program, join(baseline, 'proofs/map-set-case.mjs'));
}
const sources = { shared: fingerprint(root), ...(baseline ? { before: fingerprint(baseline) } : {}) };
const benchmarkSHA256 = createHash('sha256').update(readFileSync(program)).digest('hex');
const rows = [];
if (process.env.RESUME === '1' && existsSync(output + '.partial')) {
  const saved = JSON.parse(readFileSync(output + '.partial', 'utf8'));
  assert.deepEqual(saved.sources, sources, 'Checkpoint source changed');
  assert.equal(saved.benchmarkSHA256, benchmarkSHA256, 'Checkpoint benchmark changed');
  rows.push(...saved.rows);
}
mkdirSync(dirname(output), { recursive: true });
for (const runtime of runtimeNames) for (let round = 0; round < 3; round++) for (const name of cases) {
  for (let slot = 0; slot < variants.length; slot++) {
    const variant = variants[(slot + round) % variants.length], cwd = variant === 'before' ? baseline : root;
    if (rows.some(row => row.round === round + 1 && row.variant === variant && row.name === name && row.runtimeName === runtime)) continue;
    const command = spawnSync(executable[runtime], ['proofs/map-set-case.mjs'], { cwd,
      env: { ...process.env, KIND: variant === 'before' ? 'shared' : variant, CASE: name, N: '10000', SAMPLES: '15' },
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(command.status, 0, `${runtime}/${name}/${variant}: ${command.error ?? ''}\n${command.stderr}\n${command.stdout}`);
    const row = JSON.parse(command.stdout); assert(row.outputChecked);
    rows.push({ round: round + 1, variant, runtimeName: runtime, ...row });
    writeFileSync(output + '.partial', JSON.stringify({ sources, benchmarkSHA256, rows }));
    console.error(`${runtime}/${round + 1}/${name}/${variant} complete`);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const runtime of runtimeNames) for (const name of cases) {
  const selected = variant => rows.filter(row => row.runtimeName === runtime && row.name === name && row.variant === variant);
  const mediansMs = Object.fromEntries(variants.map(variant => [variant, median(selected(variant).flatMap(row => row.samplesMs))]));
  const roundRatios = [1, 2, 3].map(round => {
    const ms = variant => median(selected(variant).find(row => row.round === round).samplesMs);
    return { round, vsImmutable: ms('immutable') / ms('shared'), ...(baseline ? { vsBefore: ms('before') / ms('shared') } : {}) };
  });
  const sharedRows = selected('shared');
  summary.push({ runtime, name, operations: sharedRows[0].operations, mediansMs,
    vsImmutable: mediansMs.immutable / mediansMs.shared, vsNative: mediansMs.native / mediansMs.shared,
    ...(baseline ? { vsBefore: mediansMs.before / mediansMs.shared } : {}), roundRatios,
    allocatedBytes: median(sharedRows.flatMap(row => row.allocatedBytes)),
    reservedBytes: median(sharedRows.flatMap(row => row.reservedBytes)),
    ...(baseline ? { beforeAllocatedBytes: median(selected('before').flatMap(row => row.allocatedBytes)) } : {}) });
}
assert.equal(fingerprint(root).sha256, sources.shared.sha256, 'Source changed during measurement');
const result = { schema: 1, measuredAt: new Date().toISOString(), method: 'Median of 45 samples across three process rounds per case, library, and runtime. Variant order rotates. Checked complete outputs and retained bases. Native updates copy once inside timing. Arena setup is separate except cold-insert-string. No speed threshold or statistical significance is implied.',
  sources, benchmarkSHA256,
  immutable: JSON.parse(readFileSync(join(root, 'node_modules/immutable/package.json'), 'utf8')).version,
  compiler: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'), 'utf8')).version,
  summary, rows };
writeFileSync(output, JSON.stringify(result) + '\n');
rmSync(output + '.partial', { force: true });
console.log(JSON.stringify(summary, null, 2));
