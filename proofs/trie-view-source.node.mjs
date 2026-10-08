import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, ARENA_SHA256, WASM_SHA256,
  BUNDLE_SHA256, FROZEN_PROOF_SHA256, applyCaptureEdits, assertCaptureDelta,
  assertPinnedManifest, bundleManifest, isProductionSource, isValidationSource, validationManifest, sha256,
} from './trie-view-source.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = ref => execFileSync('git', ['show', `${ref}:arena.ts`], { cwd: root });
test('the immutable pair admits exactly the complete 13+/10- capture delta', () => {
  const baseline = source(BASELINE_COMMIT), candidate = source(CANDIDATE_RUNTIME_COMMIT);
  assertCaptureDelta(baseline, candidate);
  assert.equal(sha256(applyCaptureEdits(baseline.toString())), ARENA_SHA256.candidate);
  assert.equal(execFileSync('git', ['diff', '--numstat', BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, '--', 'arena.ts'], { cwd: root, encoding: 'utf8' }).trim(), '13\t10\tarena.ts');
});

test('reject unrelated Arena edits, eager capture, removed scratch and altered laziness', () => {
  const baseline = source(BASELINE_COMMIT), candidate = source(CANDIDATE_RUNTIME_COMMIT).toString();
  for (const altered of [
    candidate + '\n',
    candidate.replace('let dv!: DataView;', 'const dv = this.dv;'),
    candidate.replace('const stack = root ? [root] : [];', 'const stack = [root];'),
    candidate.replace('const lanes = new Uint32Array(16)', 'const lanes = new Uint32Array(8)'),
    candidate.replace('*radixLeaves(root: number)', 'radixLeaves(root: number)'),
    candidate.replace('dv.getUint32(root + 12, true)', 'this.dv.getUint32(root + 12, true)'),
  ]) {
    assert.notEqual(altered, candidate, 'Mutation must hit a real source site');
    assert.throws(() => assertCaptureDelta(baseline, altered), /Unpinned full candidate/);
  }
  assert.throws(() => assertCaptureDelta(Buffer.concat([baseline, Buffer.from('\n')]), candidate), /Unpinned full baseline/);
  assert.throws(() => applyCaptureEdits(baseline.toString().replaceAll('this.dv.getUint32(root, true)', 'dv.getUint32(root, true)')), /Exact capture site/);
});

test('all 12 WASM and both complete 12-file JS sets are pinned without subset acceptance', () => {
  for (const [label, expected] of Object.entries({ wasm: WASM_SHA256, ...BUNDLE_SHA256 })) {
    assert.equal(Object.keys(expected).length, 12, label);
    assertPinnedManifest({ ...expected }, expected, label);
    for (const file of Object.keys(expected)) {
      const missing = { ...expected }; delete missing[file];
      assert.throws(() => assertPinnedManifest(missing, expected, label), /missing or extra paths/);
      assert.throws(() => assertPinnedManifest({ ...expected, [file]: '0'.repeat(64) }, expected, label), /changed bytes/);
    }
    assert.throws(() => assertPinnedManifest({ ...expected, 'unexpected.js': '0'.repeat(64) }, expected, label), /missing or extra paths/);
  }
});

test('bundle receipts include every chunk and nested JS and reject filesystem indirection', t => {
  const directory = mkdtempSync(join(tmpdir(), 'trie-view-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'shared.js'), 'export const x = 1;');
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'chunk.js'), 'export const y = 2;');
  writeFileSync(join(directory, 'ignored.d.ts'), 'export declare const x: number;');
  assert.deepEqual(Object.keys(bundleManifest(join(directory, 'shared.js'))), ['nested/chunk.js', 'shared.js']);
  symlinkSync(join(directory, 'shared.js'), join(directory, 'unexpected.js'));
  assert.throws(() => bundleManifest(join(directory, 'shared.js')), /Unexpected symlink/);
});

test('build inputs and unchanged package bytes are within the source guard boundary', () => {
  for (const file of ['arena.ts', 'new-source.ts', 'new-source.tsx', 'new-source.mjs', 'shared-runtime.as.ts', 'package.json', '.npmignore', 'scripts/build-browser.ts', 'scripts/check-package.mjs', 'tsconfig.worker.json', 'type-tests/worker.consumer.ts']) assert.equal(isProductionSource(file), true, file);
  for (const file of ['README.md', 'proofs/trie-view-gate.mjs', '.github/workflows/trie-view-capture.yml', 'trie-view-capture.test.ts']) assert.equal(isProductionSource(file), false, file);
  const pkg = ref => execFileSync('git', ['show', `${ref}:package.json`], { cwd: root });
  assert.deepEqual(pkg(BASELINE_COMMIT), pkg(CANDIDATE_RUNTIME_COMMIT));
  assert.equal(Object.keys(FROZEN_PROOF_SHA256).length, 5);
  for (const [file, expected] of Object.entries(FROZEN_PROOF_SHA256)) {
    assert.equal(sha256(execFileSync('git', ['show', `${CANDIDATE_RUNTIME_COMMIT}:${file}`], { cwd: root })), expected, file);
  }
});

test('original prerequisite helpers and type fixtures cannot be weakened, omitted or replaced by symlinks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'trie-view-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'proofs'));
  const files = ['proofs/node-worker.mjs', 'proofs/redux-node.mjs', 'proofs/typed-json-worker.mjs', 'proofs/redux-types.ts'];
  const originals = Object.fromEntries(files.map(file => [file, execFileSync('git', ['show', `${BASELINE_COMMIT}:${file}`], { cwd: root })]));
  for (const [file, bytes] of Object.entries(originals)) writeFileSync(join(directory, file), bytes);
  const verify = () => validationManifest(directory, root, BASELINE_COMMIT, files);
  assert.deepEqual(verify(), Object.fromEntries([...files].sort().map(file => [file, sha256(originals[file])])));
  for (const file of files) {
    writeFileSync(join(directory, file), 'export {};\n');
    assert.throws(verify, /Changed original validation source/, file);
    rmSync(join(directory, file));
    assert.throws(verify, /ENOENT/, file);
    symlinkSync(join(root, file), join(directory, file));
    assert.throws(verify, /Not a regular file/, file);
    rmSync(join(directory, file));
    writeFileSync(join(directory, file), originals[file]);
  }
  for (const file of [...files, 'original.test.ts', 'proofs/nested/helper.cjs', 'proofs/run-proof.sh']) assert.equal(isValidationSource(file), true, file);
  for (const file of ['README.md', 'proofs/results/prior.json', 'proofs/README.md']) assert.equal(isValidationSource(file), false, file);
  assert.deepEqual(verify(), Object.fromEntries([...files].sort().map(file => [file, sha256(originals[file])])));
});
