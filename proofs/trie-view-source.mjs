// Frozen source/build receipts for the trie DataView capture screen. Never timed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BASELINE_COMMIT = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const CANDIDATE_RUNTIME_COMMIT = '47402ad2ec2ac7226831a577e6e224c555710af8';
export const TOOLCHAIN = Object.freeze({ node: '22.23.3', bun: '1.4.2', assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721', long: '5.3.2', typescript: '5.9.3' });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ARENA_SHA256 = Object.freeze({ baseline: '71b858f8c25d52ab1b6fd8f6ab426512653fe5aee5586f801b74f6c144e11a31', candidate: '98ce40b588bd5eea1fc73e65f6d37ff1745f46c0f15f16d14934b532d320f7ea' });
export const WASM_SHA256 = Object.freeze({
  "doubly-linked-list.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "geometry-kernels.wasm": "01652e1fd8dd0a8b6a1f808dc07ad2dd05d8918c966d99ed429657a51de4a9d0",
  "linked-list.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "numeric-kernels-simd.wasm": "42ed864a9470363d567d6a253c09ff03e283310b97b458b7dda296e618138df7",
  "numeric-kernels.wasm": "5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95",
  "ordered-map.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "persistent-core.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "priority-queue.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "shared-list.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "shared-map.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "singly-linked-list.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4",
  "sorted-tree.wasm": "b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4"
});
export const BUNDLE_SHA256 = Object.freeze({
  baseline: Object.freeze({
  "chunk-bngxdyck.js": "05b0ae07261a73e6b0e41b328c9583fb268d27472da53fd828fa393339e193e6",
  "chunk-byfqjcsj.js": "0e09e9a7a14e4a5c3c4b8ee3f4e4b1d11bcc317b238b9df4ba513cddd83a5fe2",
  "chunk-fvjmff4x.js": "4842f051f6e854e879ac2303041a48e690da744e1fca1762f5e6911ac30dcd47",
  "chunk-qrfmwc9f.js": "1cf6d1b08c4e9795e3c180668ae0428cb02d7f989ea67166b6f8102f43f72308",
  "chunk-vme84hfz.js": "63bcc0990af192140dfda3b86d28b1d7b4ed02dac9afa1c06ac27d52bf020ef5",
  "geometry.js": "fc63210907f892c92872bec322b45602e3780ba4295e0e5af776a4efe08cc885",
  "numeric.js": "be4d299dce68743537dae7029db6df85bb6570b6257b7be36fd3ae2a246cddcc",
  "redux.js": "a78bac0690095ba0bc58b9ec9d4a413ba1e6021fc2eee8df84e83145e97583d7",
  "shared.js": "bf206ed59f2b426a9e5cfca9200e1e5a593bd82445290805b04450faeb6c7292",
  "state.js": "5f69efac6e3d926fa5cd9762acde9467c7810c95c4eebb65a83359e0cade6f85",
  "tanstack-db-collection.js": "c4fe5a39dbe129d1236d825a85cbdd9bfe7b284bd5a3dfdff4518bdfb5a3aed6",
  "worker.js": "b60f60db31821a7699cc03eb34611adf70db1bafd0dad0fdff2b11d8263ad61f"
}),
  candidate: Object.freeze({
  "chunk-5hje9tr8.js": "8ff3b8c182de6ace0c11d36d33004f4848beadecd1db3c4e1280a50de08dc333",
  "chunk-aknrhf6q.js": "8fe19b500d24b04370d6ca1a1ba4d7397b9615fe807c6e88a09f94d1fe16323d",
  "chunk-e4vr2mt4.js": "edcd3c6532da42c9c4c0c7d3cf6eabdd988b5e11ed30b458bdb9fc646110060e",
  "chunk-g0ncgype.js": "40a45b5b08f9883b21826098e352d0e10c86f5f692be5c860df287a3beb54643",
  "chunk-tjz8qzk0.js": "127c51cd88222d38eff406f7ee84242586f1a63a735c913de156eb394aa6b4b8",
  "geometry.js": "f6cb188a1463f85a2fadcb74df05126675bfb2b7ad15d73dea572ba6d39bcf39",
  "numeric.js": "65d2fa5d586ac05bd1b6bda623b69b22f297732fe9cfc8012fe744a5c59258b2",
  "redux.js": "ff5e6e6769534d172cd21e098a32cbb759a2b7bc4e32ed118ed1499b44899aa4",
  "shared.js": "250d891bbd4df6eee8c26d951157459876e977fadd20d2244dcb2bee296ab89e",
  "state.js": "e618cc7c7f1c795f5b736dea9fd65068777dfcee386ac2a835d7f08b2ca52e6e",
  "tanstack-db-collection.js": "4abdc56eb6e3144e00eec7e2a0520da8a5416c64578fcbaf80d6538445d9f304",
  "worker.js": "d1fe5f13902cc28ce88646808e23980047140d8622096109ba0c7c134dabdde7"
}),
});
export const FROZEN_PROOF_SHA256 = Object.freeze({
  "trie-view-capture.test.ts": "de42b7e6de2d98521977effadcae12ebc33ba385418e1cb477f4c6300f9baa4a",
  "proofs/trie-view-fixtures.ts": "0fde6b49893bc3ed0a606238fc3e72e53ad7f0e5786efebcc8d662c120ab98f8",
  "proofs/trie-view-mechanism.ts": "d380d40fce71e5ac8d5d215ecd06e5a84f8a199a459ba47bb1e17e29f028bdd5",
  "proofs/trie-view-worker.mjs": "f2e0f8efe959d78cabc4afb3d905da8865812d2c4d560c1f3a80f44cf5c9947e",
  "proofs/trie-view-workers.mjs": "612a4b9f5a64253cf517468ce552825be8d01b14487ecdce7d1f5a58533aacf5"
});
export const COMPILER_SHA256 = Object.freeze({
  assemblyscript: '4530bcb58bdb9def1c62f2b715adad09a50891da09f5e5f740eee0eca036b388',
  binaryen: 'e425c8f319c85f872f998ab4744aaab74397e3596688dc6bc3623140277340c5',
  long: '365aa8b91a37d583e683d596842e94ca5f7d0f680c2187bee57918c67b3d330b',
  typescript: '157973716ed7eea8fef4816c93432cb12febb4c31b02360394d7767304bdb4e5',
});

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout;
}
function regularFile(path) {
  assert.ok(lstatSync(path).isFile(), `Not a regular file: ${path}`);
  return readFileSync(path);
}
function directoryManifest(root, select = () => true) {
  assert.ok(lstatSync(root).isDirectory(), `Not a real directory: ${root}`);
  const files = [];
  const visit = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      assert.ok(!item.isSymbolicLink(), `Unexpected symlink: ${path}`);
      if (item.isDirectory()) visit(path);
      else {
        assert.ok(item.isFile(), `Unexpected non-file: ${path}`);
        if (select(relative(root, path))) files.push(path);
      }
    }
  };
  visit(root);
  return Object.fromEntries(files.map(path => relative(root, path)).sort().map(file => [file, sha256(regularFile(join(root, file)))]));
}
export function assertPinnedManifest(actual, expected, label = 'manifest') {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: missing or extra paths`);
  for (const [path, hash] of Object.entries(expected)) assert.equal(actual[path], hash, `${label}: changed bytes in ${path}`);
  return actual;
}
// Complete transitive local JS/WASM compiler packages, including AS standard
// library inputs. File maps and whole-package hashes are retained in receipts.
export function compilerManifest(root) {
  return Object.fromEntries(Object.entries(COMPILER_SHA256).map(([name, expected]) => {
    const packageRoot = join(resolve(root), 'node_modules', name);
    const version = JSON.parse(regularFile(join(packageRoot, 'package.json'))).version;
    assert.equal(version, TOOLCHAIN[name], `${name}: unpinned compiler version`);
    const files = directoryManifest(packageRoot);
    const digest = sha256(JSON.stringify(files));
    assert.equal(digest, expected, `${name}: unpinned compiler package bytes`);
    return [name, { version, sha256: digest, files }];
  }));
}
export function bundleManifest(entry) {
  // The shared entry's directory contains the full split bundle. Neither a
  // shared.js-only check nor a subset of its chunks is an adequate receipt.
  return directoryManifest(dirname(resolve(entry)), file => /\.(?:js|wasm)$/.test(file));
}
export function wasmManifest(root) {
  return Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha256(regularFile(join(root, file)))]));
}

export function applyCaptureEdits(baseline) {
  let expected = baseline;
  for (const [before, after, count] of [
    ['if (root && this.dv.getUint32(root, true) === 0xffffffff) {', '// Published pointers stay within this view after shared-memory growth.\n    let dv!: DataView;\n    if (root && (dv = this.dv).getUint32(root, true) === 0xffffffff) {', 2],
    ['const pending: number[] = [], n = this.dv.getUint32(root + 12, true);', 'const pending: number[] = [], n = dv.getUint32(root + 12, true);', 1],
    ['pending.push(this.dv.getUint32(root + 16 + i * 4, true))', 'pending.push(dv.getUint32(root + 16 + i * 4, true))', 1],
    ['this.radixLeaves(this.dv.getUint32(root + 4, true))', 'this.radixLeaves(dv.getUint32(root + 4, true))', 1],
    ['const p = stack.pop()!, dv = this.dv;', 'const p = stack.pop()!;', 1],
    ['const n = this.dv.getUint32(root + 12, true), base = this.dv.getUint32(root + 4, true);', 'const n = dv.getUint32(root + 12, true), base = dv.getUint32(root + 4, true);', 1],
    ['yield this.dv.getUint32(root + 16 + i * 4, true)', 'yield dv.getUint32(root + 16 + i * 4, true)', 1],
    ['for (const leaf of this.leaves(base)) {\n        const dv = this.dv;', 'for (const leaf of this.leaves(base)) {', 1],
    ['const p = stack.pop()!, dv = this.dv, tag = dv.getUint32(p, true);', 'const p = stack.pop()!, tag = dv.getUint32(p, true);', 1],
  ]) {
    assert.equal(expected.split(before).length - 1, count, `Exact capture site: ${before}`);
    expected = expected.replaceAll(before, after);
  }
  return expected;
}
export function assertCaptureDelta(baseline, candidate) {
  assert.equal(sha256(baseline), ARENA_SHA256.baseline, 'Unpinned full baseline Arena source');
  assert.equal(sha256(candidate), ARENA_SHA256.candidate, 'Unpinned full candidate Arena source');
  assert.equal(candidate.toString(), applyCaptureEdits(baseline.toString()), 'Only immutable view capture substitutions are admitted');
}
// Include every top-level TS/JS source, every script, all compiler/test config,
// package metadata and type fixtures. Exclude test files here only because the
// new regression suite is separately pinned; original tests/helpers are checked below.
export function isProductionSource(file) {
  return (/^[^/]+\.(?:[cm]?[jt]sx?|json)$/.test(file) && !file.endsWith('.test.ts'))
    || /^(?:scripts|type-tests)\//.test(file)
    || ['.npmignore', '.gitattributes', '.gitignore', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock'].includes(file);
}
function trackedFiles(repo, ref) {
  return git(repo, ['ls-tree', '-r', '--name-only', ref]).toString().trim().split('\n').filter(Boolean);
}
export function isValidationSource(file) {
  return /^[^/]+\.test\.ts$/.test(file) || /^proofs\/.*\.(?:[cm]?[jt]sx?|sh)$/.test(file);
}
export function validationManifest(root, repo, ref, allFiles = trackedFiles(repo, ref)) {
  // Original proof code includes direct prerequisite entrypoints, their helper
  // imports and compile-only fixtures such as proofs/redux-types.ts. Guard all
  // tracked proof code so a prerequisite cannot silently become a no-op.
  return Object.fromEntries(allFiles.filter(isValidationSource).sort().map(file => {
    const actual = sha256(regularFile(join(root, file)));
    assert.equal(actual, sha256(git(repo, ['show', `${ref}:${file}`])), `Changed original validation source: ${file}`);
    return [file, actual];
  }));
}
function actualProtectedFiles(root) {
  const files = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isFile() && isProductionSource(item.name)) files.push(item.name);
    else if (['scripts', 'type-tests'].includes(item.name)) {
      for (const file of Object.keys(directoryManifest(join(root, item.name)))) files.push(`${item.name}/${file}`);
    } else if (item.isSymbolicLink() && isProductionSource(item.name)) throw new Error(`Source symlink: ${item.name}`);
  }
  // bun install generates a lockfile on this historical commit. It is archived,
  // not allowed to alter production inputs; compiler package/output pins apply.
  return files.filter(file => !['bun.lock', 'bun.lockb'].includes(file)).sort();
}
export function verifySourceRoots(baselineRoot, candidateRoot) {
  const roots = { baseline: resolve(baselineRoot), candidate: resolve(candidateRoot) };
  const repo = roots.candidate;
  const refs = { baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT };
  const gateCommit = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  assert.match(gateCommit, /^[0-9a-f]{40}$/, 'Gate HEAD is not immutable');
  const sourceManifests = {};
  for (const [variant, ref] of Object.entries(refs)) {
    const allFiles = trackedFiles(repo, ref);
    const names = allFiles.filter(isProductionSource).sort();
    assert.deepEqual(actualProtectedFiles(roots[variant]), names, `${variant}: added, missing or untracked production/build input`);
    const files = {};
    for (const file of names) {
      const expected = sha256(git(repo, ['show', `${ref}:${file}`]));
      files[file] = sha256(regularFile(join(roots[variant], file)));
      assert.equal(files[file], expected, `${variant}: source differs from immutable ref: ${file}`);
    }
    const validationFiles = validationManifest(roots[variant], repo, ref, allFiles);
    sourceManifests[variant] = { root: roots[variant], ref, files, validationFiles };
  }
  const names = new Set([...Object.keys(sourceManifests.baseline.files), ...Object.keys(sourceManifests.candidate.files)]);
  const sourceDiff = [...names].filter(file => sourceManifests.baseline.files[file] !== sourceManifests.candidate.files[file]).sort();
  assert.deepEqual(sourceDiff, ['arena.ts'], 'Unrelated production/build input difference');
  assert.deepEqual(git(repo, ['diff', '--numstat', BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, '--', ...sourceDiff]).toString().trim(), '13\t10\tarena.ts', 'Capture must stay exactly 13 additions / 10 deletions');
  assertCaptureDelta(regularFile(join(roots.baseline, 'arena.ts')), regularFile(join(roots.candidate, 'arena.ts')));
  assert.equal(sourceManifests.baseline.files['package.json'], sourceManifests.candidate.files['package.json'], 'Original package bytes must remain unchanged');
  const frozenProofs = {};
  for (const [file, expected] of Object.entries(FROZEN_PROOF_SHA256)) {
    frozenProofs[file] = sha256(regularFile(join(roots.candidate, file)));
    assert.equal(frozenProofs[file], expected, `Changed original capture validation: ${file}`);
  }
  return { roots, sourceManifests, sourceDiff, frozenProofs, baselineCommit: BASELINE_COMMIT, candidateCommit: CANDIDATE_RUNTIME_COMMIT, gateCommit };
}
export function prepareComparison(baselineRoot, candidateRoot) {
  const sources = verifySourceRoots(baselineRoot, candidateRoot);
  const paths = Object.fromEntries(Object.entries(sources.roots).map(([name, root]) => [name, join(root, 'dist', 'shared.js')]));
  const manifests = {};
  for (const [variant, root] of Object.entries(sources.roots)) {
    sources.sourceManifests[variant].wasm = assertPinnedManifest(wasmManifest(root), WASM_SHA256, `${variant}: all 12 rebuilt WASM files`);
    manifests[variant] = assertPinnedManifest(bundleManifest(paths[variant]), BUNDLE_SHA256[variant], `${variant}: all 12 rebuilt JS bundles`);
    sources.sourceManifests[variant].compilers = compilerManifest(root);
  }
  assert.deepEqual(sources.sourceManifests.baseline.wasm, sources.sourceManifests.candidate.wasm, 'Both independently rebuilt WASM sets must match');
  return { ...sources, paths, sourcePaths: { ...paths }, manifests, cleanup() {} };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, baseline, candidate] = process.argv.slice(2);
  assert.ok(['sources', 'compare', 'compiler'].includes(mode), 'Usage: trie-view-source.mjs sources|compare BASE_ROOT CAND_ROOT; compiler ROOT');
  const receipt = mode === 'compiler' ? compilerManifest(baseline) : mode === 'sources' ? verifySourceRoots(baseline, candidate) : prepareComparison(baseline, candidate);
  console.log(JSON.stringify(receipt, null, 2));
}
