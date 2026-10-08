import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CASES, PATTERNS, changedOperations, repeatCap, PAYLOAD_CAP, MAX_REPEATS, checkFixtures } from './noop-sequence-workloads.mjs';
import { summarizeQuartets, applyControl } from './noop-sequence-stats.mjs';
import { freezeWork } from './vector-reservation-performance.mjs';
import { BASELINE_COMMIT, comparePortableBundles, verifyReservationSource } from './vector-reservation-source.mjs';
function subjects(ratios, flags = []) {
  return ratios.flatMap((ratio, block) => [0, 1].flatMap(pair => ((block + pair) % 2 ? ['B', 'A'] : ['A', 'B']).map(label => ({ block, pair, label,
    result: { repeat: 1000, medianMs: label === 'A' ? 10 : ratio * 10, flags } }))));
}
test('fixed ordered 16-cell screen retains ten changed controls, two tail controls and four tree targets', () => {
  assert.equal(CASES.length, 16); assert.equal(new Set(CASES.map(c => c.name)).size, 16);
  assert.equal(CASES.filter(c => c.group === 'control').length, 10);
  assert.deepEqual(CASES.map(c => [c.type, c.size, c.index, c.pattern]), [
    ['number', 1, 0, 'changed'], ['number', 32, 31, 'changed'], ['number', 33, 0, 'changed'],
    ['number', 65, 32, 'changed'], ['number', 1057, 1024, 'changed'], ['number', 32801, 32768, 'changed'],
    ['boolean', 32, 31, 'changed'], ['boolean', 1057, 1024, 'changed'],
    ['string', 32, 31, 'changed'], ['string', 1057, 1024, 'changed'],
    ['number', 1, 0, 'same'], ['number', 32801, 32768, 'same'], ['boolean', 65, 32, 'same'],
    ['string', 32, 31, 'same'], ['number', 1057, 1024, 'half-same'], ['string', 65, 32, 'nine-tenths-same'],
  ]);
  assert.deepEqual(CASES.filter(c => c.group === 'unchanged-control').map(c => [c.type, c.size, c.region, c.pattern]), [['number', 1, 'tail', 'same'], ['string', 32, 'tail', 'same']]);
  assert.equal(CASES.filter(c => c.group === 'target').length, 4);
  assert(CASES.filter(c => c.group === 'target').every(c => c.region === 'tree'));
  assert.deepEqual(CASES.filter(c => c.group === 'control' && c.type === 'number').map(c => [c.region, c.region === 'tail' ? c.size : c.depth]), [['tail', 1], ['tail', 32], ['tree', 0], ['tree', 1], ['tree', 2], ['tree', 3]]);
});
test('actual mixed sequences have the declared changes and restore original values', () => {
  for (const workload of CASES) {
    const pattern = PATTERNS[workload.pattern]; let current = 0, changes = 0;
    for (let i = 0; i < 40; i++) { const next = pattern[i % pattern.length]; changes += next !== current; current = next; }
    assert.equal(current, 0); assert.equal(changes, changedOperations(workload, 40));
  }
});
test('baseline cap includes fixture payload and rounds all periods down safely', () => {
  for (const workload of CASES) {
    const used = 65536 + 300000, cap = repeatCap(workload, used);
    assert.equal(cap % 20, 0); assert(cap <= MAX_REPEATS);
    assert(used - 65536 + cap * workload.bytesPerWrite <= PAYLOAD_CAP);
    assert(cap === MAX_REPEATS || used - 65536 + (cap + 20) * workload.bytesPerWrite > PAYLOAD_CAP);
  }
});
test('matches repeats and warm work without hiding capped fast targets', () => {
  const pilot = (repeat, ms) => ({ result: { repeat, cap: 100000, fixtureUsed: 100000, calibration: [{ ms }] } });
  const plan = freezeWork([pilot(20000, 16), pilot(100000, 2)]);
  assert.equal(plan.repeat, 100000); assert.equal(plan.warmBatches, 75); assert.equal(plan.pilotCappedBelowFloor, true);
  assert.equal(freezeWork([pilot(20000, 16), pilot(40000, 16)]).pilotCappedBelowFloor, false);
  assert.throws(() => freezeWork([pilot(20, 10), { result: { ...pilot(20, 10).result, cap: 200000 } }]));
});
test('classifies the 2% latency margin and reports absolute per-write units', () => {
  for (const [ratio, conclusion] of [[1.01, 'within-margin'], [1.03, 'material-loss'], [0.5, 'within-margin']]) {
    const result = summarizeQuartets(subjects(Array(4).fill(ratio)));
    assert.equal(result.conclusion, conclusion); assert.equal(result.baselineNsPerWrite, 10000);
    assert(Math.abs(result.candidateNsPerWrite - ratio * 10000) < 1e-9);
  }
});
test('uses four quartet mean logs and Student t df=3, never pooled batches', () => {
  const ratios = [0.5, 0.5, 2, 2], result = summarizeQuartets(subjects(ratios));
  assert.equal(result.latencyRatio, 1); assert.equal(result.independentQuartets, 4); assert.equal(result.degreesOfFreedom, 3);
  const width = 3.182446305284263 * Math.log(2) / Math.sqrt(3);
  assert(Math.abs(Math.log(result.interval[1]) - width) < 1e-12);
  assert.equal(result.descriptivePairs.length, 8); assert.equal(result.conclusion, 'inconclusive');
});
test('rejects missing, duplicate, or unbalanced quartet membership', () => {
  const rows = subjects([1, 1, 1, 1]); assert.throws(() => summarizeQuartets(rows.slice(1)));
  const swapped = structuredClone(rows); [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(() => summarizeQuartets(swapped));
  const duplicate = structuredClone(rows); duplicate[1].pair = 1; assert.throws(() => summarizeQuartets(duplicate));
});
test('all timing flags invalidate acceptance and material A/A drift remains direct', () => {
  const clean = summarizeQuartets(subjects([1, 1, 1, 1]));
  for (const flag of ['batch-below-10ms', 'warm-work-below-100ms', 'pilot-cap-below-10ms']) {
    const flagged = summarizeQuartets(subjects([0.5, 0.5, 0.5, 0.5], [flag]));
    assert.equal(flagged.conclusion, 'timing-inconclusive'); assert.equal(applyControl(flagged, clean).conclusion, 'timing-inconclusive');
  }
  for (const ratio of [0.97, 1.03]) {
    const drift = summarizeQuartets(subjects(Array(4).fill(ratio)));
    const result = applyControl(drift, clean); assert.equal(result.conclusion, 'control-drift-inconclusive'); assert.equal(result.latencyRatio, 1);
  }
  assert.equal(applyControl(summarizeQuartets(subjects([1.01, 1.01, 1.01, 1.01])), clean).conclusion, 'within-margin');
  assert.equal(applyControl(summarizeQuartets(subjects([0.9, 1.1, 0.9, 1.3])), clean).materialRoleDrift, false);
});
test('portable guard allows only expected WASM replacement and a bijective import graph', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'noop-source-test-')), paths = {};
  try {
    for (const [role, token] of [['baseline', 'aaa'], ['candidate', 'bbb']]) {
      const dir = join(scratch, role); mkdirSync(join(dir, 'dist'), { recursive: true });
      const wasm = Buffer.from(role); writeFileSync(join(dir, 'persistent-core.wasm'), wasm);
      writeFileSync(join(dir, 'dist', `chunk-${token}.js`), `export const wasm = "${wasm.toString('base64')}";\n`);
      writeFileSync(join(dir, 'dist/shared.js'), `export { wasm } from "./chunk-${token}.js";\n`);
      paths[role] = join(dir, 'dist/shared.js');
    }
    assert.equal(comparePortableBundles(paths).modules, 2);
    writeFileSync(paths.candidate, readFileSync(paths.candidate, 'utf8') + '// unrelated code\n');
    assert.throws(() => comparePortableBundles(paths), /Unexpected portable code difference/);
    writeFileSync(paths.candidate, 'export { wasm } from "./chunk-aaa.js";\n');
    assert.throws(() => comparePortableBundles(paths));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
test('exact source guard freezes the reviewed reservation vector and baseline tail and all other production code', () => {
  const baseline = execFileSync('git', ['show', `${BASELINE_COMMIT}:persistent-core.as.ts`], { encoding: 'utf8' });
  const candidate = readFileSync('persistent-core.as.ts', 'utf8');
  assert.equal(verifyReservationSource(baseline, candidate).reuseScope, 'vector-only');
  assert.throws(() => verifyReservationSource(baseline, candidate.replace('export function tailSet(', '// changed tail\nexport function tailSet(')), /Production changed after/);
  assert.throws(() => verifyReservationSource(baseline, candidate.replace('export function vecLeaf(', '// changed helper\nexport function vecLeaf(')), /Production changed before/);
  assert.throws(() => verifyReservationSource(baseline, candidate.replace('256 + depth * 128', '256 + depth * 64')), /vecSetAt\/vecSet differ/);
});
test('all 16 candidate public-package fixtures satisfy values, handles and exact allocations', async () => {
  const S = await import(pathToFileURL(resolve('dist/shared.js')).href);
  assert.equal(checkFixtures(S, true).length, 16);
});

test('the historical workload, subject, statistics and old gate remain exact published blobs', async () => {
  const { verifyHistoricalProtocol } = await import('./vector-reservation-source.mjs');
  assert.equal(Object.keys(verifyHistoricalProtocol(resolve('.'))).length, 7);
});
test('actual compiled portable WASM is verified before workload checks', () => {
  const wrapper = resolve('proofs/vector-reservation-case.mjs'), module = resolve('dist/shared.js');
  const expectedWasm = '44d1fbd14dd4c4dcc53979d0c2aef0a7ce2e9c3671bcbf1e04c7cecf6a3720f6';
  const result = JSON.parse(execFileSync(process.execPath, [wrapper, JSON.stringify({ module, expectedWasm, mode: 'checks', reuse: true })], { encoding: 'utf8' }));
  assert.deepEqual(result.actualCompiledWasm, [expectedWasm]); assert.equal(result.rows.length, 16);
  assert.throws(() => execFileSync(process.execPath, [wrapper, JSON.stringify({ module, expectedWasm: 'b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4', mode: 'checks', reuse: true })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /Actual portable import compiled stale or unexpected core WASM/);
});
test('the prerequisite plan includes clean full runtimes, every type configuration and real workers', async () => {
  const { prerequisitePlan } = await import('./vector-reservation-prerequisites.mjs');
  const compared = { sourceManifests: { baseline: { root: '/tmp/base' }, candidate: { root: '/tmp/next' } }, paths: { baseline: '/tmp/base/dist/shared.js', candidate: '/tmp/next/dist/shared.js' } };
  const rows = prerequisitePlan(compared, { packages: { candidate: { root: '/tmp/packed' } } }, '/tmp/results');
  assert.deepEqual(rows.slice(0, 2).map(row => row.name), ['baseline-full-bun', 'candidate-full-bun']);
  assert(rows.every(row => !row.name.endsWith('full-node')));
  assert(rows.every(row => !row.args.some(arg => /testTimeout|maxWorkers|no-file-parallelism/.test(arg))));
  assert.deepEqual(rows.filter(row => row.name.startsWith('typecheck')).map(row => row.name), ['typecheck', 'typecheck:redux', 'typecheck:values', 'typecheck:geometry', 'typecheck-numeric', 'typecheck-text-search', 'typecheck-worker']);
  assert.equal(rows.filter(row => /-workers-(node|bun)$/.test(row.name)).length, 4);
  assert(rows.some(row => row.name === 'full-chromium'));
  assert(rows.some(row => row.name === 'installed-package'));
});
test('incomplete, omitted, failed, or altered prerequisites cannot authorize timings', async () => {
  const { verifyPrerequisites, prerequisitePlan } = await import('./vector-reservation-prerequisites.mjs');
  const { sha256 } = await import('./vector-reservation-source.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'reservation-receipt-test-'));
  try {
    const buildPath = join(directory, 'build.json'), receiptPath = join(directory, 'prerequisites.json'), log = join(directory, 'check.log');
    const compared = { candidateCommit: 'test-pin', sourceManifests: { baseline: { root: '/tmp/base' }, candidate: { root: '/tmp/next' } }, paths: { baseline: '/tmp/base/dist/shared.js', candidate: '/tmp/next/dist/shared.js' } };
    const build = { packages: { candidate: { root: '/tmp/packed' } } };
    writeFileSync(buildPath, JSON.stringify(build)); writeFileSync(log, 'passed');
    const base = { schema: 'vector-reservation-prerequisites/v1', complete: true, candidateCommit: compared.candidateCommit,
      buildReceiptSha256: sha256(readFileSync(buildPath)), proofs: {}, commands: prerequisitePlan(compared, build, directory).map(row => ({ ...row, status: 0, log, logSha256: sha256(readFileSync(log)) })) };
    const reject = (receipt, pattern) => { writeFileSync(receiptPath, JSON.stringify(receipt)); assert.throws(() => verifyPrerequisites(receiptPath, buildPath, compared, {}), pattern); };
    reject({ ...base, complete: false }, /All prerequisites must pass/);
    reject({ ...base, commands: base.commands.slice(1) }, /Expected values to be strictly deep-equal/);
    const failed = structuredClone(base); failed.commands[0].status = 1; reject(failed, /Failed correctness check blocks timing/);
    writeFileSync(log, 'changed'); reject(base, /Correctness log changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
