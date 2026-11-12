import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// node|bun run.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON [PAIRS=6]
const [beforeArg, afterArg, outputArg, pairsArg = '6'] = process.argv.slice(2);
assert.ok(beforeArg && afterArg && outputArg, 'Usage: run.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON [PAIRS=6]');
const roots = { before: resolve(beforeArg), after: resolve(afterArg) };
const output = resolve(outputArg), pairs = Number(pairsArg);
assert.ok(!existsSync(output), `Refusing to overwrite existing evidence: ${output}`);
assert.ok(Number.isSafeInteger(pairs) && pairs >= 1 && pairs <= 100, 'Pairs must be an integer from 1 to 100');
const sizes = (process.env.SIZES ?? '1000,10000,100000').split(',').map(Number);
assert.ok(sizes.length && new Set(sizes).size === sizes.length && sizes.every(n => [1000, 10000, 100000].includes(n)));
const workloads = ['catalog-map', 'object-list', 'number-map'];
const here = dirname(fileURLToPath(import.meta.url)), repository = resolve(here, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const paths = readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => `dist/${name}`);
  const sourcePaths = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.mjs', 'package.json', 'bun.lock'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => path && !path.startsWith('proofs/') && !path.startsWith('website/') && !path.endsWith('.test.ts')).sort();
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    sources: Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(resolve(root, path)))])),
    distribution: Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))])) };
}
const sources = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, inventory(root)]));
const fixturePaths = ['run.mjs', 'worker.mjs'].map(path => resolve(here, path)).concat(
  ['catalog-core.mjs', 'catalog-reference.mjs'].map(path => resolve(repository, 'website/assets', path)));
const fixtures = Object.fromEntries(fixturePaths.map(path => [relative(repository, path), hash(readFileSync(path))]));
const data = { schema: 'zerocopy-reader-startup/v1', startedAt: new Date().toISOString(),
  runtime: { executable: process.execPath, node: process.version, bun: process.versions.bun ?? null,
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  method: 'Fresh owner process and two fresh reader workers per sample; imports and input generation excluded. No query warmup. Original catalog calculate includes fingerprints. Paired alternating process order, all samples retained. Summary ratios compare after/before within each pair; total is construction+publication+first query per sample. Correctness checks run after each timer.',
  config: { pairs, sizes, workloads, readers: 2, requestedIds: 1000 }, roots, sources, fixtures, raw: [] };
mkdirSync(dirname(output), { recursive: true });
const save = () => { writeFileSync(output + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(output + '.tmp', output); };
save();
try {
for (const workload of workloads) for (const size of sizes) for (let pair = 0; pair < pairs; pair++) {
  for (const label of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
    process.stderr.write(`${workload} ${size}: pair ${pair + 1}/${pairs} ${label}\n`);
    const result = JSON.parse(execFileSync(process.execPath, [resolve(here, 'worker.mjs'), roots[label], workload, String(size)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
    assert.equal(result.verified, true);
    assert.ok(Object.values(result.times).every(time => Number.isFinite(time) && time >= 0));
    data.raw.push({ workload, size, pair, label, ...result }); save();
  }
}
// Reject distributions or fixtures changed while the cohort was running.
for (const label of Object.keys(roots)) assert.deepEqual(inventory(roots[label]), sources[label], `${label} source changed during measurement`);
for (const [path, sha] of Object.entries(fixtures)) assert.equal(hash(readFileSync(resolve(repository, path))), sha);
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
data.summary = [];
for (const workload of workloads) for (const size of sizes) {
  const records = data.raw.filter(row => row.workload === workload && row.size === size);
  const before = records.filter(row => row.label === 'before'), after = records.filter(row => row.label === 'after');
  const phases = Object.keys(before[0].times);
  data.summary.push({ workload, size, phases: Object.fromEntries(phases.map(phase => {
    const ratios = before.map((row, index) => after[index].times[phase] / row.times[phase]);
    return [phase, { beforeMs: median(before.map(row => row.times[phase])), afterMs: median(after.map(row => row.times[phase])),
      medianPairedRatio: median(ratios), fasterPairs: ratios.filter(ratio => ratio < 1).length, pairs,
      beforeRangeMs: [Math.min(...before.map(row => row.times[phase])), Math.max(...before.map(row => row.times[phase]))],
      afterRangeMs: [Math.min(...after.map(row => row.times[phase])), Math.max(...after.map(row => row.times[phase]))] }];
  })) });
}
data.completedAt = new Date().toISOString(); save();
console.log(JSON.stringify(data.summary, null, 2));
} catch (error) { data.failedAt = new Date().toISOString(); data.failure = error.stack ?? String(error); save(); throw error; }
