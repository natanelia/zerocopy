/** Packaging/history regression checks only: no builds, imports of runtime bundles, or timing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveEvidence } from './archive-vector-reservation-evidence.mjs';
import { CASES } from './noop-sequence-workloads.mjs';
import { prerequisitePlan } from './vector-reservation-prerequisites.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(join(root, name));
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
function scratch() { return mkdtempSync(join(root, '.vector-evidence-test-')); }
test('archive helper is the reviewed stream packager with only filename substitutions', () => {
  const normalized = read('proofs/archive-vector-reservation-evidence.mjs').toString()
    .replaceAll('vector-reservation.tar.gz', 'stream-screen.tar.gz')
    .replaceAll('archive-vector-reservation-evidence.mjs', 'archive-latest-stream-screen-evidence.mjs');
  assert.equal(hash(normalized), 'b241947c5f0f94aa363f71384507b801520322f48be93f17a7887d32cf10a1d3');
});
test('archive roundtrips colon, hidden, binary and incomplete evidence without changing bytes', () => {
  const temporary = scratch();
  try {
    const source = join(temporary, 'evidence'), output = join(temporary, 'upload'), extracted = join(temporary, 'extracted');
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
    const listed = execFileSync('tar', ['-tzf', packaged.archive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listed, ['./', ...before.map(([name]) => `./${name}`)].sort());
    assert.equal(readFileSync(packaged.checksum, 'utf8'), `${hash(readFileSync(packaged.archive))}  vector-reservation.tar.gz\n`);
    execFileSync('sha256sum', ['--check', 'vector-reservation.tar.gz.sha256'], { cwd: output });
    execFileSync('tar', ['-xzf', packaged.archive, '-C', extracted]);
    assert.deepEqual(tree(extracted), before); assert.deepEqual(tree(source), before);
    for (const [path, bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(extracted, path)), bytes);
    const archived = readFileSync(packaged.archive);
    assert.throws(() => archiveEvidence(source, output), /EEXIST/);
    assert.deepEqual(readFileSync(packaged.archive), archived, 'Packaging must refuse replacement of retained evidence');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('archive CLI preserves an empty early-failure directory and rejects nested output', () => {
  const temporary = scratch();
  try {
    const source = join(temporary, 'not-yet-created'), output = join(temporary, 'upload');
    execFileSync(process.execPath, [join(root, 'proofs/archive-vector-reservation-evidence.mjs'), source, output]);
    assert.equal(execFileSync('tar', ['-tzf', join(output, 'vector-reservation.tar.gz')], { encoding: 'utf8' }), './\n');
    execFileSync('sha256sum', ['--check', 'vector-reservation.tar.gz.sha256'], { cwd: output });
    assert.throws(() => archiveEvidence(source, join(source, 'upload')), /outside evidence/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('all 32 original console labels remain observed but unauditable, alongside exact log and metadata', () => {
  const bytes = read('proofs/vector-reservation-first-attempt.json');
  assert.equal(hash(bytes), '831adacfe3587acbb4bdafde8185000bc5aa211726c84ca145531a43b50ae055');
  const audit = JSON.parse(bytes), log = read(`proofs/${audit.jobLog.file}`);
  assert.equal(log.length, audit.jobLog.bytes); assert.equal(hash(log), audit.jobLog.sha256);
  assert.equal(audit.runId, 37850788732); assert.equal(audit.jobId, 113562885124);
  assert.deepEqual(audit.artifactListing.artifacts, []); assert.equal(audit.observedBeforePackagingRepair, true);
  assert.equal(audit.labels.length, 32); assert.equal(audit.labels.filter(row => row.consoleLabel === 'inconclusive').length, 10);
  for (const runtime of ['node', 'bun']) {
    const rows = audit.labels.filter(row => row.runtime === runtime);
    assert.deepEqual(rows.map(row => row.case), CASES.map(row => row.name));
    assert(rows.every(row => !row.rawAuditPossible && row.ratio === null && row.ci95 === null && row.aaRatio === null && row.aaCi95 === null && row.floorFlags === null));
    for (const row of rows) assert(log.toString().includes(row.originalLine));
  }
  const steps = audit.jobMetadata.jobs[0].steps;
  for (const number of [9, 10, 11]) assert.equal(steps.find(step => step.number === number).conclusion, 'success');
  assert.equal(steps.find(step => step.number === 13).conclusion, 'failure');
  for (const [path, expected] of Object.entries(audit.unchangedInputs)) assert.equal(hash(read(path)), expected, `Frozen runtime/prerequisite/timing file changed: ${path}`);
});
test('all planned prerequisite log names stay intact inside two portable outer filenames', () => {
  const compared = { sourceManifests: { baseline: { root: '/baseline' }, candidate: { root: '/candidate' } }, paths: { baseline: '/baseline/dist/shared.js', candidate: '/candidate/dist/shared.js' } };
  const names = prerequisitePlan(compared, { packages: { candidate: { root: '/packed' } } }, '/evidence').map((row, index) => `logs/${String(index).padStart(2, '0')}-${row.name}.log`);
  const invalid = /["<>|*?:\r\n]/;
  assert.deepEqual(names.filter(name => invalid.test(name)), ['logs/03-typecheck:redux.log', 'logs/04-typecheck:values.log', 'logs/05-typecheck:geometry.log']);
  for (const name of ['vector-reservation.tar.gz', 'vector-reservation.tar.gz.sha256']) assert(!invalid.test(name));
});
test('workflow permits one complete replacement push and uploads only the portable archive pair', () => {
  const yaml = read('.github/workflows/vector-path-reservation.yml').toString();
  assert(!yaml.includes('workflow_dispatch:')); assert(!yaml.includes('\n  pull_request:'));
  for (const clause of ["github.event_name == 'push'", "github.ref == 'refs/heads/perf/vector-path-reservation-gate-20261008'", 'github.run_attempt == 1', "github.event.before == '0432589af7f62fe6d8411eeb97c6296fd32fe572'", '!github.event.forced', '!github.event.deleted', 'cancel-in-progress: false']) assert(yaml.includes(clause), clause);
  assert(yaml.includes('branches: [perf/vector-path-reservation-gate-20261008]'));
  assert(yaml.includes('cp proofs/vector-reservation-first-attempt.json')); assert(yaml.includes('cp proofs/vector-reservation-first-attempt.log'));
  assert(yaml.includes('git archive 0432589af7f62fe6d8411eeb97c6296fd32fe572'));
  assert(yaml.includes('node --test proofs/vector-reservation-evidence-tests.node.mjs'));
  const prerequisites = yaml.indexOf('run: node proofs/vector-reservation-prerequisites.mjs');
  const node = yaml.indexOf('run: node proofs/vector-reservation-performance.mjs');
  const bun = yaml.indexOf('run: bun proofs/vector-reservation-performance.mjs');
  const archive = yaml.indexOf('      - name: Archive complete or partial evidence');
  const upload = yaml.indexOf('      - name: Retain complete or partial portable evidence archive');
  assert(prerequisites >= 0 && node > prerequisites && bun > node && archive > bun && upload > archive);
  assert(yaml.slice(archive, upload).includes('if: always()')); assert(yaml.slice(upload).includes('if: always()'));
  assert(yaml.slice(archive, upload).includes('node proofs/archive-vector-reservation-evidence.mjs'));
  assert(yaml.slice(upload).includes('/vector-reservation-upload/vector-reservation.tar.gz\n'));
  assert(yaml.slice(upload).includes('/vector-reservation-upload/vector-reservation.tar.gz.sha256\n'));
  assert(!yaml.slice(upload).includes('path: ${{ runner.temp }}/vector-reservation-results/'));
  assert(yaml.slice(upload).includes('compression-level: 0'));
});
