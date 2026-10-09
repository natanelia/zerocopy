import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discover, discoveryPolicy, assertDisjointRoots, inspectArms } from './heap-compaction-records-discovery.mjs';
import { evidenceWriter, saveFocusedReceipt } from './heap-compaction-records-evidence.mjs';
import { verifyActivation, harnessIdentity, RUNTIME, INTENT } from './heap-compaction-records-activation.mjs';
import { CLEANUP, assertLaunchBudget } from './heap-compaction-records-command.mjs';
const root = resolve(import.meta.dirname, '..');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, text) => git(cwd, '-c', 'user.name=Codex Test', '-c', 'user.email=codex-test@openai.com', 'commit', '-m', text);
function temp() { return mkdtempSync(join(tmpdir(), 'heap-record-repair-')); }
function put(path, text) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text); }

test('glob-only negative nested baseline and exact real-arm discovery', async () => {
  const directory = temp();
  try {
    put(join(directory, 'heap.test.ts'), 'never executed'); put(join(directory, '.proof-baseline/heap.test.ts'), 'never executed');
    assert.deepEqual(await discover(directory, discoveryPolicy(root)), ['.proof-baseline/heap.test.ts', 'heap.test.ts']);
    assert.throws(() => assertDisjointRoots(directory, join(directory, '.proof-baseline')), /ancestor overlap/);
    assert(process.env.HEAP_BASE, 'Set the external prepared baseline for discovery-only validation');
    const arms = await inspectArms(process.env.HEAP_BASE, root, { initializeCaches: true });
    assert.equal(arms[0].discovered.length, 41); assert.deepEqual(arms[0].discovered, arms[1].discovered);
    assert.equal(arms[0].policy.timeout, 5000); assert.equal(arms[0].policy.cacheDir, 'node_modules/.vite');
    for (const a of arms[0].caches) for (const b of arms[1].caches) assert.notEqual(a.physical, b.physical);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('private cache aliases are rejected without changing Vitest settings', async () => {
  const directory = temp(), a = join(directory, 'a'), b = join(directory, 'b');
  try {
    for (const r of [a, b]) {
      mkdirSync(join(r, 'node_modules'), { recursive: true }); put(join(r, 'vitest.config.ts'), readFileSync(join(root, 'vitest.config.ts')));
      put(join(r, 'one.test.ts'), 'never executed'); git(r, 'init'); git(r, 'add', 'vitest.config.ts', 'one.test.ts');
    }
    mkdirSync(join(a, 'node_modules/.vite')); symlinkSync(join(a, 'node_modules/.vite'), join(b, 'node_modules/.vite'), 'dir');
    await assert.rejects(inspectArms(a, b));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('evidence is incremental and failed/partial records stay distinguishable', () => {
  const directory = temp(), path = join(directory, 'subject.ndjson');
  try {
    const identity = { engine: 'node22', case: 'synthetic', build: 'baseline', mode: 'measure', protocol: 'AB', block: 2, pair: 1, label: 'right', frozenCounts: { chunks: 1, samples: 5 } };
    const emit = evidenceWriter(path, identity); emit('chunk', { synthetic: true, known: 1 }); emit('batch', { synthetic: true, known: 2 });
    assert.equal(JSON.parse(readFileSync(`${path}.state.json`)).status, 'incomplete');
    emit('failed', { error: 'synthetic interruption' });
    const state = JSON.parse(readFileSync(`${path}.state.json`)); assert.equal(state.status, 'failed'); assert.deepEqual(state.identity, identity);
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(s => JSON.parse(s).sequence), [1, 2, 3]);
    assert.throws(() => evidenceWriter(path, identity));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Node and Bun focused results cannot overwrite or be relabeled', () => {
  const directory = temp(), source = join(directory, 'shared.json');
  try {
    writeFileSync(source, JSON.stringify({ runtime: 'v22.23.3', passed: true, synthetic: true })); saveFocusedReceipt(source, directory, 'node22');
    writeFileSync(source, JSON.stringify({ runtime: 'Bun 1.4.2', passed: true, synthetic: true })); saveFocusedReceipt(source, directory, 'bun142');
    assert.equal(JSON.parse(readFileSync(join(directory, 'focused-node22.json'))).runtime, 'v22.23.3');
    assert.equal(JSON.parse(readFileSync(join(directory, 'focused-bun142.json'))).runtime, 'Bun 1.4.2');
    assert.throws(() => saveFocusedReceipt(source, directory, 'node22'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cleanup fits existing envelopes; expired post-staging budgets cannot launch', () => {
  assert.equal(CLEANUP.termMs + CLEANUP.verifyMs, CLEANUP.reserveMs); assert.equal(CLEANUP.reserveMs, 200);
  assert.throws(() => assertLaunchBudget(Date.now() - 1), /engine-budget-exhausted/);
  const source = readFileSync(join(root, 'proofs/heap-compaction-records-performance.mjs'), 'utf8');
  const runStart = source.indexOf('async function run(build, config)'), clean = source.indexOf('assertOwnedClean()', runStart), removal = source.indexOf('rmSync(neutral', runStart);
  assert(runStart > 0 && clean > runStart && clean < removal, 'Cleanup failure must block staging replacement');
  const staged = source.indexOf('cpSync(join(build'), secondBudgetCheck = source.indexOf('assertLaunchBudget(engineDeadline)', staged), spawn = source.indexOf('await runOwnedCommand', staged);
  assert(staged >= 0 && secondBudgetCheck > staged && spawn > secondBudgetCheck);
  const start = source.indexOf('const start = performance.now()'), end = source.indexOf('const ms = performance.now() - start', start);
  assert(start > 0 && end > start); assert.doesNotMatch(source.slice(start, end), /emit\(|writeFile|appendFile|atomicJSON/);
  assert(source.indexOf("emit('chunk'", end) > end);
});

test('creation-push guard binds accepted tree, intent-only change and physical modes', () => {
  const directory = temp(), r = join(directory, 'fixture');
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, r], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe' });
    git(r, 'checkout', '--detach', RUNTIME);
    for (let i = 0; i < 12; i++) put(join(r, `proofs/heap-compaction-records-fixture-${i}.txt`), 'synthetic');
    put(join(r, INTENT), JSON.stringify({ enabled: false, publishedRuntime: RUNTIME }));
    git(r, 'add', 'proofs'); commit(r, 'synthetic accepted preparation');
    const acceptedCommit = git(r, 'rev-parse', 'HEAD'), acceptedTree = git(r, 'rev-parse', 'HEAD^{tree}'), acceptedHarnessSha256 = harnessIdentity(r, acceptedCommit).sha256;
    assert.equal(verifyActivation(r, {}, 'invalid').enabled, false);
    put(join(r, INTENT), JSON.stringify({ enabled: true, publishedRuntime: RUNTIME, acceptedCommit, acceptedTree, acceptedHarnessSha256 }));
    git(r, 'add', INTENT); commit(r, 'synthetic intent-only activation');
    const event = { created: true, deleted: false, forced: false, before: '0'.repeat(40), after: git(r, 'rev-parse', 'HEAD'), ref: 'refs/heads/proof/heap-compaction-records-run-synthetic' };
    assert.equal(verifyActivation(r, event, 'push').enabled, true);
    for (const invalid of [{ created: false }, { forced: true }, { before: 'a'.repeat(40) }, { ref: 'refs/heads/main' }, { after: 'b'.repeat(40) }]) assert.throws(() => verifyActivation(r, { ...event, ...invalid }, 'push'));
    git(r, 'config', 'core.filemode', 'false');
    const target = join(r, 'proofs/heap-compaction-records-fixture-0.txt'); chmodSync(target, 0o755);
    assert.throws(() => verifyActivation(r, event, 'push'), /Physical mode/); chmodSync(target, 0o644);
    put(join(r, 'compaction.ts'), readFileSync(join(r, 'compaction.ts'), 'utf8') + '\n// forbidden extra edit\n'); git(r, 'add', 'compaction.ts'); commit(r, 'synthetic forbidden change');
    assert.throws(() => verifyActivation(r, { ...event, after: git(r, 'rev-parse', 'HEAD') }, 'push'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('activation rejects dirty intent and actual committed intent/compaction modes', () => {
  const directory = temp(), r = join(directory, 'fixture');
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, r], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe' });
    git(r, 'checkout', '--detach', RUNTIME); git(r, 'config', 'core.filemode', 'false');
    for (let i = 0; i < 12; i++) put(join(r, `proofs/heap-compaction-records-fixture-${i}.txt`), 'synthetic');
    put(join(r, INTENT), JSON.stringify({ enabled: false, publishedRuntime: RUNTIME }));
    git(r, 'add', 'proofs'); commit(r, 'synthetic accepted preparation');
    const acceptedCommit = git(r, 'rev-parse', 'HEAD'), acceptedTree = git(r, 'rev-parse', 'HEAD^{tree}'), acceptedHarnessSha256 = harnessIdentity(r, acceptedCommit).sha256;
    const enabledIntent = { enabled: true, publishedRuntime: RUNTIME, acceptedCommit, acceptedTree, acceptedHarnessSha256 };
    put(join(r, INTENT), JSON.stringify(enabledIntent)); git(r, 'add', INTENT); commit(r, 'synthetic activation');
    const valid = git(r, 'rev-parse', 'HEAD');
    const event = () => ({ created: true, deleted: false, forced: false, before: '0'.repeat(40), after: git(r, 'rev-parse', 'HEAD'), ref: 'refs/heads/proof/heap-compaction-records-run-synthetic' });
    const amend = message => git(r, '-c', 'user.name=Codex Test', '-c', 'user.email=codex-test@openai.com', 'commit', '--amend', '-m', message);
    assert.equal(verifyActivation(r, event(), 'push').enabled, true);
    git(r, 'update-index', '--chmod=+x', INTENT); amend('synthetic executable intent'); chmodSync(join(r, INTENT), 0o644);
    assert.match(git(r, 'ls-tree', 'HEAD', INTENT), /^100755 blob /);
    assert.throws(() => verifyActivation(r, event(), 'push'), /Committed mode: proofs\/heap-compaction-records-intent.json/);
    git(r, 'reset', '--hard', valid); chmodSync(join(r, INTENT), 0o644);
    put(join(r, INTENT), JSON.stringify({ ...enabledIntent, enabled: false })); git(r, 'add', INTENT); amend('synthetic committed disabled child intent');
    assert.equal(verifyActivation(r, {}, 'invalid').enabled, false);
    put(join(r, INTENT), JSON.stringify(enabledIntent));
    assert.throws(() => verifyActivation(r, event(), 'push'), /Dirty committed intent bytes/);
    put(join(r, INTENT), JSON.stringify({ ...enabledIntent, enabled: false, note: 'uncommitted disabled edit' }));
    assert.throws(() => verifyActivation(r, {}, 'invalid'), /Dirty committed intent bytes/);
    git(r, 'reset', '--hard', valid); chmodSync(join(r, INTENT), 0o644);
    git(r, 'update-index', '--chmod=+x', 'compaction.ts'); amend('synthetic executable compaction'); chmodSync(join(r, 'compaction.ts'), 0o644);
    assert.match(git(r, 'ls-tree', 'HEAD', 'compaction.ts'), /^100755 blob /);
    assert.throws(() => verifyActivation(r, event(), 'push'), /Committed mode: compaction.ts/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
