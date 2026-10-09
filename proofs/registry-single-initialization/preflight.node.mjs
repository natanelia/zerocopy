/** Explicit Node test discovery; no benchmark kernels run here. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, expectedCleanupArena, verifyPrimaryBytes } from './preflight-guard.mjs';
import { treeManifest, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment } from './package-tools.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('preflight has exact three runtime pins and no claimed cleanup digest', () => {
  assert.equal(config.mode, 'correctness-build-only-no-pilots-no-timing');
  assert.equal(config.pins.main, '3773c6e519c7c0958da13727ed1082f449f3ee25');
  assert.equal(config.pins.old, 'ab969f043e44d53f6ba7315c2b818c1a51ce49c9');
  assert.equal(config.pins.cleanup, '6b4b436435955be5cedeeafa763df44c4e8004ec');
  assert.equal(config.pins.source.cleanup, undefined);
  assert.equal(config.pins.build.cleanup, undefined);
  assert.equal(config.toolchain.node, '22.23.3');
  assert.equal(config.toolchain.bun, '1.4.2');
});
test('entire original subject is the historical Git blob, not a reconstructed loop', () => {
  assert.equal(verifyPrimaryBytes(root).blob, config.pins.originalSubjectBlob);
});
test('exact source delta rejects missing or duplicate anchors', () => {
  const old = '  private dependencyLookup = new Map<string, Arena>();\n' +
    '    if (this.readOnly && options.registry) this.dependencyLookup = options.registry.arenas;\n';
  const next = expectedCleanupArena(old);
  assert(next.includes('private dependencyLookup: Map<string, Arena>;'));
  assert(next.includes('options.registry.arenas : new Map<string, Arena>();'));
  assert.throws(() => expectedCleanupArena(old + old));
  assert.throws(() => expectedCleanupArena('unrelated'));
});
test('owned control is separate and cannot attach a reader', () => {
  const owned = readFileSync(new URL('./owned-subject.mjs', import.meta.url), 'utf8');
  assert(owned.includes('const retained = source;'));
  assert(owned.includes("assert.equal(count, 512);"));
  assert(!owned.includes('S.initWorker('));
  assert(owned.includes('assert.equal(first.get(\'value\'), before);'));
  const original = readFileSync(new URL('./original-subject.mjs', import.meta.url), 'utf8');
  assert.notEqual(owned, original);
});
test('preflight runner only requests correctness and checks zero emitted batches', () => {
  const runner = readFileSync(new URL('./preflight.mjs', import.meta.url), 'utf8');
  assert(runner.includes("phase: 'correctness'"));
  assert(!/phase:\s*['"](?:pilot|measure)['"]/.test(runner));
  assert(runner.includes("e.event !== 'batch'"));
  assert(runner.includes('result.calibration.length + result.warmup.length + result.measured.length, 0'));
  assert(runner.includes("record.buildsAfter, record.buildsBefore"));
});
test('prospective stages have declared352 and240 budgets and no redundant control bridge', () => {
  const cases = config.timingPlan.cases;
  for (const stage of [1, 2]) assert.equal(cases.filter(c => c.stage === stage).reduce((n, c) => n + c.quartets * c.arms.length * 4, 0), config.timingPlan.stages[stage]);
  const primary = cases.filter(c => c.primary);
  assert.equal(primary.length, 1); assert.equal(primary[0].quartets, 8); assert.equal(primary[0].arms.length, 6);
  for (const c of cases.filter(c => !c.primary)) {
    assert.equal(c.quartets, 4); assert.equal(c.arms.length, 5); assert(!c.arms.includes('bridge'));
  }
});
test('neutral staging replaces whole distributions and rejects mutated/symlinked inputs', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'registry-preflight-unit-')));
  try {
    const fixture = (name, chunk) => {
      const path = join(directory, name); mkdirSync(join(path, 'dist'), { recursive: true });
      writeFileSync(join(path, 'package.json'), '{"name":"zerocopy","type":"module"}\n');
      writeFileSync(join(path, 'dist', 'shared.js'), 'export {x} from "./' + chunk + '.js";');
      writeFileSync(join(path, 'dist', chunk + '.js'), 'export const x=1;');
      return sourceContext(path);
    };
    const a = fixture('a', 'first'), b = fixture('b', 'second'), canonical = join(directory, 'subject');
    const one = stageCanonical(a, canonical, '// fixture\n');
    checkAfterSubject(a, canonical, one);
    const two = stageCanonical(b, canonical, '// fixture\n');
    assert(!existsSync(join(canonical, 'dist/first.js')));
    checkAfterSubject(b, canonical, two);
    writeFileSync(join(canonical, 'dist/second.js'), 'mutation');
    assert.throws(() => checkAfterSubject(b, canonical, two));
    symlinkSync(join(a.dist, 'shared.js'), join(a.dist, 'link.js'));
    assert.throws(() => treeManifest(a.dist));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('subject environment removes role, credentials, CI and JIT overrides', () => {
  assert.deepEqual(cleanEnvironment({ PATH: '/bin', HOME: '/fake', GITHUB_SHA: 'role', NODE_OPTIONS: '--jitless', SECRET_TOKEN: 'secret' }),
    { PATH: '/bin', HOME: '/fake', NODE_DISABLE_COMPILE_CACHE: '1' });
});
test('workflow is isolated push-only, attempt1, with unconditional partial evidence archiving', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/registry-single-initialization-preflight.yml', import.meta.url), 'utf8');
  assert(workflow.includes('branches: [proof/registry-single-initialization-preflight-20261009]'));
  assert(!workflow.includes('workflow_dispatch:')); assert(!workflow.includes('pull_request:'));
  assert(workflow.includes("github.run_attempt == 1"));
  assert(workflow.includes('always()'));
  assert(workflow.includes('sha256sum'));
  assert(!workflow.includes('run-registry-attachment-controls.mjs'));
});

test('failed builds and digest guards retain available inputs before a passing receipt', () => {
  const runner = readFileSync(new URL('./preflight.mjs', import.meta.url), 'utf8');
  assert(runner.includes('function archiveAvailableInputs(role)'));
  const finalizer = runner.slice(runner.lastIndexOf('} finally {'));
  assert(finalizer.includes('archiveAvailableInputs(role)'));
  assert(finalizer.includes("'failed-neutral'"));
  assert(runner.includes("'available-input-manifest.json'"));
  assert(finalizer.includes("record.status = 'failed'; record.integrityComplete = false; process.exitCode = 1;"));
  assert(finalizer.indexOf('archiveAvailableInputs(role)') < finalizer.indexOf("REGISTRY_PREFLIGHT_RECEIPT="));
  assert(runner.includes("assert.deepEqual(parents, [config.runtimeParent]"));
});
