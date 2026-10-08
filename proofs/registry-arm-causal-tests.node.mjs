import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { protocol, schedule, stateFor, summarize, pilotOrder } from './registry-arm-causal-protocol.mjs';
import { internalExports, assertPublicationDelta, NEW_PATHS } from './registry-arm-causal-guard.mjs';
import { sha256 } from './worker-arena-source-guard.mjs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('frozen scope, common work and eight-arm schedule have exactly256 subjects', () => {
  assert.deepEqual(protocol.scope, { arch: 'arm64', operation: 'warmNestedRead', arenas: 512 });
  assert.deepEqual([protocol.quartetsPerArm, protocol.warmups, protocol.samples, protocol.minimumBatchMs, protocol.pilotTargetBatchMs], [8, 3, 7, 20, 40]);
  const plan = schedule(); assert.deepEqual(plan, schedule()); assert.equal(plan.length, 64);
  assert.deepEqual(Object.keys(protocol.states), ['B', 'C', 'D', 'R']); assert.equal(plan.flatMap(b => b.roles).length, 256);
  for (const arm of Object.keys(protocol.arms)) {
    const own = plan.filter(b => b.arm === arm); assert.equal(own.length, 8);
    assert.equal(own.filter(b => b.order === 'ABBA').length, 4); assert.equal(own.filter(b => b.order === 'BAAB').length, 4);
    assert.deepEqual(['A', 'B'].map(role => stateFor(arm, role)), protocol.arms[arm]);
  }
  for (let quartet = 1; quartet <= 8; quartet++) assert.equal(new Set(plan.filter(b => b.quartet === quartet).map(b => b.arm)).size, 8);
  assert.equal(new Set(pilotOrder()).size, 4); assert.notDeepEqual(schedule(), schedule(protocol.seed + 1));
  assert.throws(() => stateFor('unknown', 'A')); assert.throws(() => stateFor('C_over_B', 'C'));
});
function synthetic({ drift = null, short = null } = {}) {
  return schedule().map(planned => ({ ...planned, subjects: planned.roles.map(role => {
    const state = stateFor(planned.arm, role), ms = ({ B: 1, C: 1.04, D: 1.01, R: 1.03 })[state] * (planned.arm === drift && role === 'B' ? 1.06 : 1);
    const batch = index => ({ elapsedMs: planned.arm === short && index === 0 ? 19 : 100 * ms, msPerOperation: ms });
    return { role, state, result: { warmup: Array.from({ length: 3 }, (_, i) => batch(i)), measured: Array.from({ length: 7 }, (_, i) => batch(i + 3)) } };
  }) }));
}
test('quartet inference keeps contrast direction, dedicatedAA and all relevant invalidations', () => {
  const state = { status: 'completed', integrityComplete: true }, good = summarize(synthetic(), state);
  for (const [name, ratio] of Object.entries({ C_over_B: 1.04, D_over_C: 1.01 / 1.04, R_over_C: 1.03 / 1.04, D_over_R: 1.01 / 1.03, aa_B: 1, aa_C: 1, aa_D: 1, aa_R: 1 })) {
    assert(Math.abs(good.arms[name].inference.ratio - ratio) < 1e-14); assert.equal(good.arms[name].inferenceValid, true); assert.equal(good.arms[name].pairs.length, 16);
  }
  for (const aa of ['aa_B', 'aa_C', 'aa_D', 'aa_R']) {
    const bad = summarize(synthetic({ drift: aa }), state);
    for (const arm of Object.keys(protocol.arms)) {
      const affected = arm === aa || protocol.arms[arm].includes(aa.slice(3));
      assert.equal(bad.arms[arm].inferenceValid, !affected);
    }
  }
  assert.equal(summarize(synthetic({ short: 'aa_R' }), state).arms.D_over_R.inferenceValid, false);
  assert.equal(summarize(synthetic().slice(0, -1), state).arms[schedule().at(-1).arm].inferenceValid, false);
  for (const failed of [{ status: 'failed', integrityComplete: true }, { status: 'measuring' }, { status: 'completed', integrityComplete: false }]) {
    const result = summarize(synthetic(), failed);
    for (const arm of Object.keys(protocol.arms)) { assert.equal(result.arms[arm].inferenceValid, false); assert.deepEqual(result.arms[arm].inference, good.arms[arm].inference); }
  }
});
test('graph helper is byte-exact and historical hot loop/setup remain in the subject', () => {
  assert.equal(sha256(read('./registry-arm-causal-graph.mjs')), '6e5c856598f0db6c4b66895c6153234e29ff7468efacd10f496893d3f26fdb78');
  const old = read('./registry-attachment-subject.mjs'), subject = read('./registry-arm-causal-subject.mjs');
  const fixture = old.slice(old.indexOf('S.configureMemory('), old.indexOf('let retained = keepAlive.reader'));
  assert(subject.includes(fixture));
  const line = old.split('\n').find(line => line.includes("sink += retained.root.get(keys[i % keys.length]).get('value')"));
  assert(subject.includes(line)); assert(subject.includes('const start = performance.now(); await action(iterations);'));
  assert(subject.includes("phase === 'census' ? await import('./census.mjs') : null"));
  assert(subject.indexOf('applyGraphTreatment(') < subject.indexOf('const memoryAfter'));
  assert(subject.indexOf("mark('before-action')") < subject.indexOf('const start = performance.now();'));
  assert(subject.indexOf("mark('after-action')") > subject.indexOf('const elapsedMs = performance.now() - start;'));
  assert(subject.includes('writeSync(3, JSON.stringify(event)'));
});
test('neutral internal adapter identifies exactly one exported Arena chunk and rejects ambiguity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-internals-'));
  try {
    mkdirSync(join(dir, 'dist')); const dist = join(dir, 'dist');
    writeFileSync(join(dist, 'chunk-one.js'), 'class Arena {}\nexport { arenaOf, Arena };\n');
    assert.equal(internalExports({ dist }), "export { Arena, arenaOf } from './dist/chunk-one.js';\n");
    writeFileSync(join(dist, 'chunk-two.js'), 'class Arena {}'); assert.throws(() => internalExports({ dist }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('direct file descriptors preserve partial output above buffer limits and segregate JSONL', () => {
  const runner = read('./run-registry-arm-causal.mjs');
  assert(runner.includes("stdio: ['ignore', ...fds]")); assert(runner.includes("openSync(join(output, path), 'wx')"));
  assert(runner.includes("request.phase === 'census' ? { 'census.mjs': censusBytes } : {}"));
  assert(runner.includes("record.diagnostics.push")); assert(runner.includes('record.blocks.flatMap(block => block.subjects).length'));
  const dir = mkdtempSync(join(tmpdir(), 'registry-partial-'));
  try {
    const script = join(dir, 'writer.mjs');
    writeFileSync(script, "import { writeSync } from 'node:fs'; writeSync(1, 'x'.repeat(1024 * 1024)); writeSync(2, 'diagnostic failure\\n'); writeSync(3, JSON.stringify({event:'batch',complete:true})+'\\n'); process.exit(9);\n");
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { openSync, closeSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; const paths=${JSON.stringify(['out', 'err', 'events'].map(n => join(dir, n)))}; const fds=paths.map(p=>openSync(p,'wx')); const r=spawnSync(process.execPath,[${JSON.stringify(script)}],{stdio:['ignore',...fds],maxBuffer:1}); for(const fd of fds)closeSync(fd); process.exit(r.status);`]);
    assert.equal(child.status, 9); assert.equal(readFileSync(join(dir, 'out')).length, 1024 * 1024);
    assert.equal(readFileSync(join(dir, 'err'), 'utf8'), 'diagnostic failure\n'); assert.equal(JSON.parse(readFileSync(join(dir, 'events'), 'utf8')).event, 'batch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('workflow gates one exact-base nonforced attempt and packs hidden/colon evidence inside tar', () => {
  const workflow = read('../.github/workflows/registry-arm-causal.yml');
  for (const text of ['branches: [proof/registry-arm-causal-20261008]', "github.event.before == '96b90882df5d5294489065bd303fbbede6a83184'", 'github.event.forced == false', 'github.run_attempt == 1', 'runs-on: ubuntu-24.04-arm', 'tar -czf', '${{ always() }}']) assert(workflow.includes(text));
  assert(!workflow.includes('workflow_dispatch:')); assert(!workflow.includes('pull_request:')); assert(!workflow.includes('matrix:'));
  assert(workflow.includes('registry-arm-causal-evidence.tar.gz')); assert(workflow.includes('registry-arm-causal-evidence.sha256'));
  assert(workflow.indexOf('bun run build:wasm') < workflow.indexOf('vitest/vitest.mjs run'));
  const runner = read('./run-registry-arm-causal.mjs');
  assert(runner.includes("assert.equal(event.before, protocol.publication.before)")); assert(runner.includes("assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1')"));
});
test('publication rejects changed runtime, existing proofs, omissions and renamed files', () => {
  const valid = NEW_PATHS.map(path => 'A\t' + path).join('\n'); assertPublicationDelta(valid);
  for (const delta of [valid + '\nM\tarena.ts', valid + '\nA\tunexpected.md', valid.replace('A\t', 'M\t'), valid.split('\n').slice(1).join('\n'), valid.replace('A\t', 'R100\told\t')]) assert.throws(() => assertPublicationDelta(delta));
});
test('tar evidence packing round-trips hidden workflow and native colon filenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-archive-'));
  try {
    const source = join(dir, 'source'), restored = join(dir, 'restored'), archive = join(dir, 'evidence.tar.gz');
    mkdirSync(join(source, '.github', 'workflows'), { recursive: true }); mkdirSync(restored);
    writeFileSync(join(source, '.github/workflows/proof.yml'), 'workflow bytes\n');
    writeFileSync(join(source, 'native:trace.log'), 'complete or partial trace bytes\n');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status, 0);
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', restored]).status, 0);
    for (const name of ['.github/workflows/proof.yml', 'native:trace.log']) assert.deepEqual(readFileSync(join(restored, name)), readFileSync(join(source, name)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
