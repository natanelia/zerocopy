// Untimed packaging, lineage, workflow and historical-protocol regression checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { archiveEvidence } from './trie-view-archive.mjs';
import { CASES } from './trie-view-workloads.mjs';
import { CONFIG, MODES, studyFor } from './trie-view-protocol.mjs';
import { COMMON_CHECKS, REQUIRED_CHECKS } from './trie-view-prerequisites.mjs';
import { validatePushInvocation } from './trie-view-gate.mjs';
import { CANDIDATE_RUNTIME_COMMIT, CANDIDATE_TREE, GATE_FILES, verifyGateIdentity } from './trie-view-source.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(join(root, name));
const plan = JSON.parse(read('proofs/radix-view-plan.json'));
function tree(directory) {
  const rows = [];
  function walk(prefix = '') {
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) { rows.push([name + '/', 'directory']); walk(name + '/'); }
      else { assert(entry.isFile()); rows.push([name, hash(readFileSync(join(directory, name)))]); }
    }
  }
  walk(); return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
function scratch(t) { const p = mkdtempSync(join(tmpdir(), 'radix-evidence-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
test('reviewed archive helper changes only portable filenames', () => {
  const normalized = read('proofs/trie-view-archive.mjs').toString()
    .replaceAll('radix-view.tar.gz', 'stream-screen.tar.gz')
    .replaceAll('trie-view-archive.mjs', 'archive-latest-stream-screen-evidence.mjs');
  assert.equal(hash(normalized), 'b241947c5f0f94aa363f71384507b801520322f48be93f17a7887d32cf10a1d3');
});
test('archive roundtrips colon, hidden, binary, empty and partial evidence without replacement', t => {
  const temporary = scratch(t), source = join(temporary, 'evidence'), output = join(temporary, 'upload'), extracted = join(temporary, 'extracted');
  const files = {
    'logs/03-typecheck:redux.log': Buffer.from('declaration log\r\n\0unchanged\n'),
    '.hidden-receipt': Buffer.from('retain hidden metadata\n'),
    'node.json.partial': Buffer.from('{"subjects":[{"block":0},'),
    'raw/subject:0.ndjson': Buffer.from('{"event":"sample"}\n{"event":"partial"'),
    'raw/trace.bin': Buffer.from([0, 1, 13, 10, 127, 128, 254, 255]),
  };
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), bytes); }
  mkdirSync(join(source, 'empty')); mkdirSync(extracted);
  const before = tree(source), packaged = archiveEvidence(source, output);
  assert.deepEqual(execFileSync('tar', ['-tzf', packaged.archive], { encoding: 'utf8' }).trim().split('\n').sort(), ['./', ...before.map(([name]) => `./${name}`)].sort());
  assert.equal(readFileSync(packaged.checksum, 'utf8'), `${hash(readFileSync(packaged.archive))}  radix-view.tar.gz\n`);
  execFileSync('sha256sum', ['--check', 'radix-view.tar.gz.sha256'], { cwd: output });
  execFileSync('tar', ['-xzf', packaged.archive, '-C', extracted]);
  assert.deepEqual(tree(extracted), before); assert.deepEqual(tree(source), before);
  const archived = readFileSync(packaged.archive); assert.throws(() => archiveEvidence(source, output), /EEXIST/);
  assert.deepEqual(readFileSync(packaged.archive), archived);
});
test('archive CLI preserves empty early failures and rejects nested output', t => {
  const temporary = scratch(t), source = join(temporary, 'not-yet-created'), output = join(temporary, 'upload');
  execFileSync(process.execPath, [join(root, 'proofs/trie-view-archive.mjs'), source, output]);
  assert.equal(execFileSync('tar', ['-tzf', join(output, 'radix-view.tar.gz')], { encoding: 'utf8' }), './\n');
  execFileSync('sha256sum', ['--check', 'radix-view.tar.gz.sha256'], { cwd: output });
  assert.throws(() => archiveEvidence(source, join(source, 'upload')), /outside evidence/);
});
test('all20 operations, descriptions and seeded statistical schedules retain the frozen history', () => {
  const expected = plan.cases.map(({ priorCategory, priorTarget, scope, ...row }) => row);
  assert.deepEqual(CASES, expected); assert.deepEqual(CONFIG, plan.config); assert.deepEqual(MODES, plan.modes);
  assert.equal(CASES.filter(c => c.target).length, 3); assert.equal(CASES.filter(c => !c.target).length, 17);
  const historical = plan.cases.map(({ priorCategory, priorTarget, scope, ...row }) => ({ ...row, category: priorCategory, target: priorTarget }));
  const oldStudy = studyFor(historical), nextStudy = studyFor(CASES);
  assert.deepEqual(nextStudy.rows.map(({ workload, ...row }) => ({ ...row, name: workload.name })), oldStudy.rows.map(({ workload, ...row }) => ({ ...row, name: workload.name })));
  assert.equal(nextStudy.measuredSubjects, 640); assert.equal(nextStudy.measuredBatches, 13440); assert.equal(nextStudy.pilots, 40);
  assert.equal(hash(read('proofs/trie-view-protocol.mjs')), plan.sourceHashes['trie-view-protocol.mjs']);
  const prior = JSON.parse(read('proofs/trie-view-history.json')).priorGateSourceHashes;
  assert.equal(hash(read('proofs/trie-view-subject.mjs')), prior['trie-view-subject.mjs']);
  const restored = read('proofs/trie-view-workloads.mjs').toString()
    .replace("add('map', 'hamt', 'number', 4096, 'canonical', 'entries', 'control',", "add('map', 'hamt', 'number', 4096, 'canonical', 'entries', 'target',")
    .replace("add('map', 'hamt', 'number', 4096, 'patched', 'entries', 'control',", "add('map', 'hamt', 'number', 4096, 'patched', 'entries', 'target',")
    .replace("4096, 'canonical', 'keys', trie === 'hamt' ? 'control' : 'target',", "4096, 'canonical', 'keys', 'target',");
  assert.equal(hash(restored), plan.sourceHashes['trie-view-workloads.mjs']);
});
test('push guard admits only first nonforced direct-child update from published c79', () => {
  const head = 'a'.repeat(40), env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/perf/radix-view-only-20261008', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head };
  const event = { before: CANDIDATE_RUNTIME_COMMIT, after: head, ref: env.GITHUB_REF, created: false, forced: false, deleted: false };
  assert.equal(validatePushInvocation(env, event, head, CANDIDATE_RUNTIME_COMMIT).before, CANDIDATE_RUNTIME_COMMIT);
  for (const name of ['created', 'forced', 'deleted']) for (const value of [true, undefined]) assert.throws(() => validatePushInvocation(env, { ...event, [name]: value }, head, CANDIDATE_RUNTIME_COMMIT));
  for (const patch of [{ before: 'b'.repeat(40) }, { after: 'b'.repeat(40) }, { ref: 'refs/heads/main' }]) assert.throws(() => validatePushInvocation(env, { ...event, ...patch }, head, CANDIDATE_RUNTIME_COMMIT));
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' }]) assert.throws(() => validatePushInvocation({ ...env, ...patch }, event, head, CANDIDATE_RUNTIME_COMMIT));
  assert.throws(() => validatePushInvocation(env, event, head, 'b'.repeat(40)));
});
test('exact gate commit adds only declared proof files and keeps runtime tree pinned', () => {
  const identity = verifyGateIdentity(root);
  assert.equal(identity.parent, CANDIDATE_RUNTIME_COMMIT); assert.equal(identity.candidateTree, CANDIDATE_TREE);
  assert.deepEqual(identity.addedFiles, [...GATE_FILES]);
});
test('receipt runner can log installation before any dependency tree exists', t => {
  const temporary = scratch(t), proof = join(temporary, 'proofs'); mkdirSync(proof);
  for (const file of ['trie-view-prerequisites.mjs', 'trie-view-source.mjs', 'trie-view-worker-types.expected.json']) writeFileSync(join(proof, file), read(`proofs/${file}`));
  const evidence = join(temporary, 'evidence'); mkdirSync(evidence); writeFileSync(join(evidence, 'prerequisites.json'), '{"status":"partial","checks":[]}');
  const result = spawnSync(process.execPath, [join(proof, 'trie-view-prerequisites.mjs'), 'check', evidence, 'gate', 'install', temporary, process.execPath, '-e', 'console.log("synthetic install pass")'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /synthetic install pass/);
});
test('workflow orders full standard Bun and supported built Node prerequisites before pilots', () => {
  assert.equal(REQUIRED_CHECKS.length, 40); assert.ok(!COMMON_CHECKS.some(c => c.includes('unit-node')));
  const yaml = read('.github/workflows/radix-view-only.yml').toString();
  assert(!yaml.includes('workflow_dispatch:')); assert(!yaml.includes('\n  pull_request:')); assert(!yaml.includes('node node_modules/vitest'));
  for (const clause of ["github.event_name == 'push'", "github.ref == 'refs/heads/perf/radix-view-only-20261008'", 'github.run_attempt == 1', `github.event.before == '${CANDIDATE_RUNTIME_COMMIT}'`, '!github.event.created', '!github.event.forced', '!github.event.deleted', 'cancel-in-progress: false']) assert(yaml.includes(clause), clause);
  const declarations = yaml.indexOf('check "$build" build-types'), strict = yaml.indexOf('check "$build" worker-types');
  const unit = yaml.indexOf('check "$build" unit "$directory" bun run test'), seal = yaml.indexOf('proofs/trie-view-prerequisites.mjs seal'), pilots = yaml.indexOf('proofs/trie-view-gate.mjs run');
  assert(declarations >= 0 && strict > declarations && unit > strict && seal > unit && pilots > seal);
  for (const name of ['package', 'worker-tasks-node', 'node-worker', 'redux-node', 'typed-json-worker', 'actual-workers-node', 'actual-workers-bun']) {
    const index = yaml.indexOf(`check "$build" ${name}`); assert(index > unit && index < seal, name);
  }
  const retain = yaml.indexOf('      - name: Retain complete or partial builds'), archive = yaml.indexOf('      - name: Archive complete or partial evidence'), upload = yaml.indexOf('      - name: Retain portable complete or partial evidence archive');
  assert(retain > pilots && archive > retain && upload > archive);
  for (const chunk of [yaml.slice(retain, archive), yaml.slice(archive, upload), yaml.slice(upload)]) assert(chunk.includes('if: always()'));
  assert(yaml.slice(upload).includes('/radix-view.tar.gz\n')); assert(yaml.slice(upload).includes('/radix-view.tar.gz.sha256\n'));
  assert(yaml.slice(upload).includes('compression-level: 0')); assert(!yaml.slice(upload).includes('path: ${{ env.EVIDENCE }}/'));
});
test('combined loss and both historical Node-loader failures remain explicit', () => {
  const history = JSON.parse(read('proofs/trie-view-history.json')), audit = read('proofs/trie-view-combined-audit.md');
  assert.equal(hash(audit), history.priorEvidenceHashes['AUDIT.md']); assert.equal(history.runId, 37850139130);
  assert.equal(history.bunEmptyHamtEntries.classification, 'detected material loss');
  assert.equal(history.bunEmptyHamtEntries.latencyChangePercent, 3.779); assert.deepEqual(history.bunEmptyHamtEntries.pointwise95IntervalPercent, [3.330, 4.231]);
  assert.equal(history.node.pilotsStarted, false); assert.equal(history.node.timingsAvailable, false);
  assert.equal(history.olderHistory.find(r => r.runId === 37848932492).supplementalNodeFailed, 9);
  assert.equal(history.localRadixPreparation.fullCleanCIRemainsMandatory, true);
});
