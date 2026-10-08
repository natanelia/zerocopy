/** Explicit node --test only: never .test.mjs / .spec.mjs Vitest discovery. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocol, scheduleCase, variantFor, interval, summarizeCase, applyRunIntegrity } from './registry-attachment-protocol.mjs';
import { treeManifest, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment } from './registry-attachment-guard.mjs';
import { sha256 } from './worker-arena-source-guard.mjs';

test('prospective scope is exactly two x64 cases and one ARM secondary', () => {
  assert.deepEqual(protocol.cases.map(({ arch, operation, arenas }) => [arch, operation, arenas]), [['x64', 'attach', 1], ['x64', 'reexport', 512], ['arm64', 'warmNestedRead', 512]]);
  assert.equal(protocol.quartetsPerMode, 8); assert.equal(protocol.samples, 7); assert.equal(protocol.warmups, 3); assert.equal(protocol.minimumBatchMs, 20);
  assert.equal(protocol.toolchain.node, '22.23.3'); assert.equal(protocol.degreesOfFreedom, 7);
});
test('seeded schedule has eight separate quartets and exact four/four orientation for every mode', () => {
  for (let i = 0; i < protocol.cases.length; i++) {
    const schedule = scheduleCase(protocol.seed + i);
    assert.deepEqual(schedule, scheduleCase(protocol.seed + i)); assert.equal(schedule.length, 24);
    for (const mode of protocol.modes) {
      const blocks = schedule.filter(b => b.mode === mode);
      assert.equal(blocks.length, 8); assert.equal(blocks.filter(b => b.order === 'ABBA').length, 4); assert.equal(blocks.filter(b => b.order === 'BAAB').length, 4);
      assert.equal(new Set(blocks.map(b => b.quartet)).size, 8);
      assert(blocks.every(b => b.roles.join('') === b.order));
    }
    for (let quartet = 1; quartet <= 8; quartet++) assert.equal(new Set(schedule.filter(b => b.quartet === quartet).map(b => b.mode)).size, 3);
  }
  assert.notDeepEqual(scheduleCase(protocol.seed), scheduleCase(protocol.seed + 1));
});
test('A/A arms use the identical source for both independently launched roles', () => {
  assert.deepEqual(['A', 'B'].map(r => variantFor('ab', r)), ['baseline', 'candidate']);
  assert.deepEqual(['A', 'B'].map(r => variantFor('aa-baseline', r)), ['baseline', 'baseline']);
  assert.deepEqual(['A', 'B'].map(r => variantFor('aa-candidate', r)), ['candidate', 'candidate']);
  assert.throws(() => variantFor('bb', 'A')); assert.throws(() => variantFor('ab', 'C'));
});
test('df7 two-sided log t interval uses quartets and detects slowdown, uncertainty and either role drift direction', () => {
  assert.equal(interval(Array(8).fill(0)).classification, 'within-2%-margin');
  const slow = interval(Array(8).fill(Math.log(1.04)));
  assert.equal(slow.classification, 'material-slowdown-signal'); assert.equal(slow.materialRoleDrift, true);
  assert.equal(interval(Array(8).fill(Math.log(0.96))).materialRoleDrift, true);
  assert.equal(interval(Array(8).fill(Math.log(1.015))).materialRoleDrift, false);
  const uncertain = interval([0.9, 1.1, 1.2, 0.95, 1.08, 0.97, 1.07, 1.0].map(Math.log));
  assert.equal(uncertain.classification, 'inconclusive'); assert.equal(uncertain.materialRoleDrift, false);
  assert.throws(() => interval([0, 0, 0, 0]));
  const logs = [-.02, -.01, 0, .01, .02, .03, .04, .05], known = interval(logs);
  assert(Math.abs(known.ratio - Math.exp(.015)) < 1e-14);
  assert(Math.abs(known.standardError - Math.sqrt(.0042 / 7 / 8)) < 1e-14);
  assert(Math.abs(known.ci95[1] - Math.exp(.015 + 2.3646242510102993 * known.standardError)) < 1e-14);
});
function syntheticBlocks({ ab = 1.01, aaBaseline = 1, aaCandidate = 1, short = false } = {}) {
  return scheduleCase(protocol.seed).map(planned => ({ ...planned, subjects: planned.roles.map(role => {
    const ratio = { ab, 'aa-baseline': aaBaseline, 'aa-candidate': aaCandidate }[planned.mode];
    const ms = role === 'A' ? .1 : .1 * ratio;
    const batch = index => ({ iterations: 400, elapsedMs: short && index === 0 ? 19 : 400 * ms, msPerOperation: ms });
    return { role, result: { warmup: Array.from({ length: 3 }, (_, i) => batch(i)), measured: Array.from({ length: 7 }, (_, i) => batch(i + 3)) } };
  }) }));
}
test('either separate A/A arm invalidates A/B without normalization or discarding samples', () => {
  const valid = summarizeCase(syntheticBlocks()); assert.equal(valid.inferenceValid, true);
  for (const options of [{ aaBaseline: 1.04 }, { aaCandidate: .96 }]) {
    const result = summarizeCase(syntheticBlocks(options));
    assert.equal(result.inferenceValid, false); assert(result.invalidationReasons.some(r => r.endsWith('material-role-drift')));
    assert(Math.abs(result.arms.ab.inference.ratio - 1.01) < 1e-14); assert.equal(result.arms.ab.pairs.length, 16);
  }
  const short = summarizeCase(syntheticBlocks({ short: true }));
  assert.equal(short.inferenceValid, false); assert(short.invalidationReasons.includes('short-warmup-or-measured-batch')); assert.equal(short.arms.ab.pairs.length, 16);
  assert.equal(summarizeCase(syntheticBlocks().slice(0, -1)).inferenceValid, false);
});
test('final integrity failure invalidates complete statistical results without erasing intervals', () => {
  const summary = summarizeCase(syntheticBlocks());
  for (const state of [{ status: 'measuring' }, { status: 'failed' }, { status: 'failed', integrityComplete: true }, { status: 'completed', integrityComplete: false }]) {
    const result = applyRunIntegrity(summary, state); assert.equal(result.inferenceValid, false); assert.equal(result.measurementFlagsClear, true);
    assert.deepEqual(result.arms.ab.inference, summary.arms.ab.inference);
  }
  assert.equal(applyRunIntegrity(summary, { status: 'completed', integrityComplete: true }).inferenceValid, true);
});
test('original setup and all three timed loop bodies are preserved byte-for-byte', () => {
  const old = readFileSync(new URL('./worker-arena-benchmark.mjs', import.meta.url), 'utf8');
  const subject = readFileSync(new URL('./registry-attachment-subject.mjs', import.meta.url), 'utf8');
  assert.equal(sha256(old), protocol.pins.originalHarnessSha256);
  assert(subject.includes(old.slice(old.indexOf('S.configureMemory('), old.indexOf('const attachIterations'))));
  for (const prefix of ['for (let i = 0; i < iterations; i++) { const current = await S.initWorker(data);', 'for (let i = 0; i < iterations; i++) sink += S.getWorkerData(retained,', 'for (let i = 0; i < iterations; i++) sink += retained.root.get(keys[']) {
    const originalLine = old.split('\n').find(line => line.includes(prefix)); assert(originalLine); assert(subject.includes(originalLine));
  }
  assert(subject.includes('const start = performance.now(); await action(iterations);'));
  assert(!subject.includes('ARENA_VARIANT')); assert(!subject.includes('CANDIDATE_SHA')); assert(subject.includes("await import('./dist/shared.js')"));
});
test('physical neutral package retains original bytes, replaces stale chunks, and rejects mutation/symlinks', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-guard-test-')));
  try {
    const packageBytes = '{"name":"zerocopy","type":"module","exports":{".":"./dist/shared.js"},"custom":"unchanged"}\n';
    function fixture(name, chunk) {
      const path = join(root, name); mkdirSync(join(path, 'dist'), { recursive: true });
      writeFileSync(join(path, 'package.json'), packageBytes); writeFileSync(join(path, 'dist', 'shared.js'), `export {value} from './${chunk}.js';`); writeFileSync(join(path, 'dist', `${chunk}.js`), 'export const value=1;');
      return sourceContext(path);
    }
    const a = fixture('a', 'chunk-a'), b = fixture('b', 'chunk-b'), canonical = join(root, 'subject'), runner = '// synthetic; no workload\n';
    const before = stageCanonical(a, canonical, runner); checkAfterSubject(a, canonical, before);
    const next = stageCanonical(b, canonical, runner); checkAfterSubject(b, canonical, next);
    assert.equal(realpathSync(canonical), canonical); assert.equal(readFileSync(join(canonical, 'package.json'), 'utf8'), packageBytes);
    assert.equal(existsSync(join(canonical, 'dist', 'chunk-a.js')), false); assert.equal(existsSync(join(canonical, 'dist', 'chunk-b.js')), true);
    writeFileSync(join(canonical, 'dist', 'chunk-b.js'), 'tampered'); assert.throws(() => checkAfterSubject(b, canonical, next), /changed during subject/);
    writeFileSync(join(a.dist, 'shared.js'), 'tampered'); assert.throws(() => stageCanonical(a, canonical, runner), /Source bundle changed/);
    symlinkSync(join(b.dist, 'shared.js'), join(b.dist, 'link.js')); assert.throws(() => treeManifest(b.dist), /Symlink forbidden/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('subject environment strips role, CI, credentials, and engine override variables', () => {
  const env = cleanEnvironment({ PATH: '/bin', HOME: '/tmp/test', GITHUB_SHA: 'role', ARENA_VARIANT: 'candidate', NODE_OPTIONS: '--jitless', BUN_OPTIONS: 'x', SECRET_TOKEN: 'secret' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp/test', NODE_DISABLE_COMPILE_CACHE: '1' });
});
test('completed setup and batches are synchronously emitted outside the timed interval for failure retention', () => {
  const subject = readFileSync(new URL('./registry-attachment-subject.mjs', import.meta.url), 'utf8');
  assert(subject.includes("const emit = event => writeSync(1, JSON.stringify(event) + '\\n');"));
  assert(subject.includes("emit({ event: 'start', metadata, request });"));
  assert(subject.includes("emit({ event: 'setup', setupElapsedMs"));
  assert(subject.indexOf("emit({ event: 'batch', row });") > subject.indexOf('const elapsedMs = performance.now() - start;'));
  assert(subject.includes("emit({ event: 'result', result });"));
});
test('workflow is a separate scoped push and protocol checks require explicit Node discovery', () => {
  const workflow = readFileSync(new URL('../.github/workflows/registry-attachment-controls.yml', import.meta.url), 'utf8');
  assert(workflow.includes('branches: [proof/registry-attachment-controls-20261008]'));
  assert(!workflow.includes('pull_request:')); assert(!workflow.includes('workflow_dispatch:'));
  assert(workflow.includes('node --test proofs/worker-arena-source-guard.node.mjs proofs/registry-attachment-tests.node.mjs'));
  assert(!workflow.includes('run-worker-arenas.mjs')); assert(!workflow.includes('ARENA_COUNTS'));
});
