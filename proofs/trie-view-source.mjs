// Frozen source/build receipts for the trie DataView capture screen. Never timed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const BASELINE_COMMIT = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const CANDIDATE_RUNTIME_COMMIT = 'c79c803bf7c59a2fc559e43ce7cc74aa4dacde15';
export const CANDIDATE_TREE = 'b09e5938f1312a91c833b64122657254c8bc1de8';
export const GATE_FILES = Object.freeze([
  ".github/workflows/radix-view-only.yml",
  "proofs/trie-view-gate.md",
  "proofs/trie-view-gate.mjs",
  "proofs/trie-view-gate.node.mjs",
  "proofs/trie-view-protocol.mjs",
  "proofs/trie-view-protocol.node.mjs",
  "proofs/trie-view-source.mjs",
  "proofs/trie-view-source.node.mjs",
  "proofs/trie-view-workloads.mjs",
  "proofs/trie-view-subject.mjs",
  "proofs/trie-view-workloads.node.mjs",
  "proofs/trie-view-prerequisites.mjs",
  "proofs/trie-view-prerequisites.node.mjs",
  "proofs/trie-view-worker-types.baseline.txt",
  "proofs/trie-view-worker-types.expected.json",
  "proofs/trie-view-archive.mjs",
  "proofs/trie-view-evidence.node.mjs",
  "proofs/trie-view-history.json",
  "proofs/trie-view-combined-audit.md"
]);
export const TOOLCHAIN = Object.freeze({ node: '22.23.3', bun: '1.4.2', assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721', long: '5.3.2', typescript: '5.9.3' });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ARENA_SHA256 = Object.freeze({ baseline: '71b858f8c25d52ab1b6fd8f6ab426512653fe5aee5586f801b74f6c144e11a31', candidate: '07920049817c4d6ae97655668c2401d5049532c76d21389544a91aea8a2bb36a' });
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
  "chunk-2wbnrkbc.js": "64ccccf4d6b1985c518f26443db2efbdfb942b937584b180ee07286f3e59f21c",
  "chunk-8fdx8py4.js": "feb008870ffeb6eb46ddabef3dd3c1c9dfa98e2112c46f4e32814107bb96d549",
  "chunk-adgp6z5q.js": "db824a1033d394d156dcc7179756d2adf39149c444fe3b28c119fa9b44b04738",
  "chunk-dhffg0ce.js": "59895f283f4b1441e506467a5070a771070714502b93cd74678d3b530a808ad2",
  "chunk-w0v3yk9v.js": "ab68891919d4450e038981f1c118f0c2c5e2ada2b2585d3596b72c17ada6b6cd",
  "geometry.js": "74eae6ec562f1a5cf2b2f2ed5df9c7a39e93c30dcc8a8eb78d903233a18c963d",
  "numeric.js": "a73dfd55be7c3c8113081632db5a69eaae87b319c14d436393952ef9cc8a60e2",
  "redux.js": "778c87a567e00c2d58b193c9ee4b10836808c4f3004e30a1c6c982ee0352d910",
  "shared.js": "b6ecfbc4668ffa098f2caf3a019ae0609c6792fe3fd99ed51d8eb33e545610cb",
  "state.js": "e5474221a0721507fde14e8c13f0dd57f0bf08c709dc6cbfa5a1056dfc7af10d",
  "tanstack-db-collection.js": "3c4ec57902c324a5d0a2cb3d839505ba46871392e106e164c2fe1dc35b3fa707",
  "worker.js": "1c4e026442c717f6a11d9fed6996d78bb3f1beb5e3c2115fc79d4d5f32a541dc"
}),
});
export const FROZEN_PROOF_SHA256 = Object.freeze({
  "trie-view-capture.test.ts": "be832872d1da2283e32902b30e26ea1435cae3c3635dc8ee5aaf47bfa3554857",
  "proofs/trie-view-fixtures.ts": "0fde6b49893bc3ed0a606238fc3e72e53ad7f0e5786efebcc8d662c120ab98f8",
  "proofs/trie-view-mechanism.ts": "8536fb89411595b8db4beca4c68420535daaded6aa30b0b58c0cca9f9769b1c0",
  "proofs/trie-view-worker.mjs": "f2e0f8efe959d78cabc4afb3d905da8865812d2c4d560c1f3a80f44cf5c9947e",
  "proofs/trie-view-workers.mjs": "612a4b9f5a64253cf517468ce552825be8d01b14487ecdce7d1f5a58533aacf5",
  "proofs/radix-view-only.md": "9965e4b1670c1da4217a4186cde142f9b84992082e83099bc752ba782dbe1921",
  "proofs/radix-view-plan.json": "fca7efb53e1b6f268efb7ad3528568d6577b58dcfdc2fa3750c85b451b4e9a1e",
  "proofs/radix-view-source.mjs": "5333a48e6d803103633adcb47bd7e28ada778226d474aa10df8cfb6b0bdd80cf",
  "proofs/radix-view-source.patch": "a085ed19543b02b8f9651e1286dddbe088beb75dfa6b00e11142921fd8140eef"
});
export const METHOD_SHA256 = Object.freeze({
  "baseline": {
    "leaves": "8f8912ccc6d344d28207fd3fb01d5cd7ec6c85cd0658704e739cecd5d39f3365",
    "radixLeaves": "f5450c8eb333782ca090685d51bdaa5e08c5529b50694ab0a3eaa40253386c04"
  },
  "candidate": {
    "leaves": "8f8912ccc6d344d28207fd3fb01d5cd7ec6c85cd0658704e739cecd5d39f3365",
    "radixLeaves": "12008f45a41a3632f7765287e67af4dda7a461268390e57413be0555124043c5"
  }
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

export function methodText(source, name) {
  // The prerequisite receipt runner imports this module before dependency install.
  // AST parsing is only needed after install, inside source/method verification.
  const ts = createRequire(import.meta.url)('typescript');
  const ast = ts.createSourceFile('arena.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arena = ast.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Arena');
  const method = arena.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === name);
  assert.ok(method?.asteriskToken, `Expected generator method: ${name}`);
  return source.slice(method.getStart(ast), method.end);
}
export function applyCaptureEdits(baseline) {
  const original = methodText(baseline, 'radixLeaves');
  let expected = original;
  for (const [before, after] of [
    ['if (root && this.dv.getUint32(root, true) === 0xffffffff) {', '// Published pointers stay within this view after shared-memory growth.\n    let dv!: DataView;\n    if (root && (dv = this.dv).getUint32(root, true) === 0xffffffff) {'],
    ['const pending: number[] = [], n = this.dv.getUint32(root + 12, true);', 'const pending: number[] = [], n = dv.getUint32(root + 12, true);'],
    ['pending.push(this.dv.getUint32(root + 16 + i * 4, true))', 'pending.push(dv.getUint32(root + 16 + i * 4, true))'],
    ['this.radixLeaves(this.dv.getUint32(root + 4, true))', 'this.radixLeaves(dv.getUint32(root + 4, true))'],
    ['const p = stack.pop()!, dv = this.dv;', 'const p = stack.pop()!;'],
  ]) {
    assert.equal(expected.split(before).length - 1, 1, `Exact capture site: ${before}`);
    expected = expected.replace(before, after);
  }
  return baseline.replace(original, expected);
}
export function assertCaptureDelta(baseline, candidate) {
  assert.equal(sha256(baseline), ARENA_SHA256.baseline, 'Unpinned full baseline Arena source');
  assert.equal(sha256(candidate), ARENA_SHA256.candidate, 'Unpinned full candidate Arena source');
  assert.equal(candidate.toString(), applyCaptureEdits(baseline.toString()), 'Only exact radix immutable view capture substitutions are admitted');
  assert.equal(methodText(candidate.toString(), 'leaves'), methodText(baseline.toString(), 'leaves'), 'Unchanged HAMT generator body');
  for (const variant of ['baseline', 'candidate']) for (const name of ['leaves', 'radixLeaves']) {
    const text = methodText((variant === 'baseline' ? baseline : candidate).toString(), name);
    assert.equal(sha256(text), METHOD_SHA256[variant][name], `Pinned ${variant}/${name} body`);
  }
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
export function verifyGateIdentity(root) {
  const head = git(root, ['rev-parse', 'HEAD']).toString().trim();
  assert.equal(git(root, ['show', '-s', '--format=%P', head]).toString().trim(), CANDIDATE_RUNTIME_COMMIT,
    'Gate must be one direct proof commit on the published runtime');
  assert.equal(git(root, ['rev-parse', `${CANDIDATE_RUNTIME_COMMIT}^{tree}`]).toString().trim(), CANDIDATE_TREE);
  assert.equal(git(root, ['show', '-s', '--format=%P', CANDIDATE_RUNTIME_COMMIT]).toString().trim(), BASELINE_COMMIT);
  const changes = git(root, ['diff', '--name-status', CANDIDATE_RUNTIME_COMMIT, head]).toString().trim().split('\n');
  assert.deepEqual(changes.sort(), GATE_FILES.map(file => `A\t${file}`).sort(),
    'Gate can only add its declared proof files; frozen runtime/test/proof bytes cannot change');
  for (const file of GATE_FILES) assert.equal(sha256(regularFile(join(root, file))), sha256(git(root, ['show', `${head}:${file}`])), `Uncommitted gate edit: ${file}`);
  return { head, parent: CANDIDATE_RUNTIME_COMMIT, candidateTree: CANDIDATE_TREE, addedFiles: [...GATE_FILES] };
}
export function verifySourceRoots(baselineRoot, candidateRoot) {
  const roots = { baseline: resolve(baselineRoot), candidate: resolve(candidateRoot) };
  const repo = roots.candidate;
  const gateIdentity = verifyGateIdentity(repo);
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
  assert.deepEqual(git(repo, ['diff', '--numstat', BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, '--', ...sourceDiff]).toString().trim(), '7\t5\tarena.ts', 'Radix capture must stay exactly 7 additions / 5 deletions');
  assertCaptureDelta(regularFile(join(roots.baseline, 'arena.ts')), regularFile(join(roots.candidate, 'arena.ts')));
  assert.equal(sourceManifests.baseline.files['package.json'], sourceManifests.candidate.files['package.json'], 'Original package bytes must remain unchanged');
  const frozenProofs = {};
  for (const [file, expected] of Object.entries(FROZEN_PROOF_SHA256)) {
    frozenProofs[file] = sha256(regularFile(join(roots.candidate, file)));
    assert.equal(frozenProofs[file], expected, `Changed original capture validation: ${file}`);
  }
  return { roots, sourceManifests, sourceDiff, frozenProofs, gateIdentity, methodSha256: METHOD_SHA256, baselineCommit: BASELINE_COMMIT, candidateCommit: CANDIDATE_RUNTIME_COMMIT, gateCommit };
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
