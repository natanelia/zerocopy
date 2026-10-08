import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
export const BASELINE_COMMIT = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const HISTORICAL_RUNTIME_TEST_COMMIT = 'c9209b1a40887a77ac2ce3259a37a4581fe377bb';
export const HISTORICAL_CANDIDATE_COMMIT = 'b857382910af2b587d7cc525357289c8084608fc';
// Publication may reconstruct the tree with a new commit identity. Frozen
// blob hashes, rather than unpublished local ancestry, are the authority.
export const FROZEN_FILES = {
  'persistent-core.as.ts': '7a578ee28ec5d82253b7a686c7a5c1b3e8eb3729feaf3d1fd89260dc9dbbcd4c',
  'shared-list-noop-set.test.ts': '80d600b6906ff11df4770e1a5013db0fad3cb82ffff7bcd97683a7f0562f4965',
  'worker.test.ts': 'ccf4dcf8bc9e4fc3dfc6881dd1737f6491ab149aa91d7a1c0774dc2fd9cd1ddf',
  'proofs/noop-sequence-invariants.mjs': '316668b083b1c9ba505c8f711dc73208c18ac258c926efd6317c11ce9d213696',
  'proofs/noop-sequence-worker.mjs': '0270b85f3d7052b871b71c40c6b81b01733827317e334ed9693b72162e1ff735',
};
export const BUILD_FLAGS = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
export const PROOF_FILES = ['noop-sequence-source.mjs', 'noop-sequence-workloads.mjs', 'noop-sequence-case.mjs', 'noop-sequence-stats.mjs', 'noop-sequence-performance.mjs', 'noop-sequence-build.mjs', 'noop-sequence-tests.node.mjs'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The scope cut restores every byte outside vecSetAt, including tailSet. */
export function verifyVectorOnlySource(baseline, candidate) {
  const split = source => {
    const start = source.indexOf('function vecSetAt('), end = source.indexOf('export function vecSet(', start);
    assert(start >= 0 && end > start, 'Missing vector implementation boundary');
    return { prefix: source.slice(0, start), vector: source.slice(start, end), suffix: source.slice(end) };
  };
  const old = split(baseline), next = split(candidate);
  assert.equal(next.prefix, old.prefix, 'Production changed before vecSetAt');
  assert.equal(next.suffix, old.suffix, 'Production changed after vecSetAt, including tailSet');
  assert.equal(sha256(next.vector), '74f2bc361d5df3b8702c3eadce56a4b1df683f223562b02e0d16fc844a641584', 'vecSetAt differs from the original reviewed candidate');
  return { reuseScope: 'vector-only', tailSet: 'byte-identical to baseline', vecSetAt: 'byte-identical to historical candidate', vectorSha256: sha256(next.vector) };
}
export const median = values => { const sorted = [...values].sort((a, b) => a - b), n = sorted.length; return n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  if (result.status) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
export function bundleManifest(entry) {
  const root = dirname(resolve(entry)), paths = [];
  const walk = dir => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name); if (item.isSymbolicLink()) throw new Error(`Bundle symlink: ${path}`);
    if (item.isDirectory()) walk(path); else if (/\.(js|wasm)$/.test(path)) paths.push(path);
  } }; walk(root);
  return Object.fromEntries(paths.sort().map(path => [relative(root, path), sha256(readFileSync(path))]));
}
/** Content-addressed chunk names may change; code and the complete import graph may not. */
export function comparePortableBundles(paths) {
  const modules = {}, wasm = {}, fingerprints = {};
  const normalize = (text, role) => text.split(wasm[role]).join('__EXPECTED_CORE_WASM__');
  for (const role of ['baseline', 'candidate']) {
    const root = dirname(paths[role]);
    modules[role] = Object.fromEntries(Object.keys(bundleManifest(paths[role])).filter(n => n.endsWith('.js')).map(n => [n, readFileSync(join(root, n), 'utf8')]));
    wasm[role] = readFileSync(join(dirname(root), 'persistent-core.wasm')).toString('base64');
    assert.equal(Object.values(modules[role]).reduce((n, text) => n + text.split(wasm[role]).length - 1, 0), 1, `${role} core WASM embedding`);
    const chunkNames = Object.keys(modules[role]).filter(n => /^chunk-[\w-]+\.js$/.test(n));
    fingerprints[role] = Object.fromEntries(Object.entries(modules[role]).map(([name, source]) => {
      let text = normalize(source, role);
      for (const chunk of chunkNames) text = text.split(`"./${chunk}"`).join('"./__CHUNK__"');
      return [name, sha256(text)];
    }));
  }
  assert.deepEqual(Object.keys(modules.baseline).filter(n => !n.startsWith('chunk-')).sort(), Object.keys(modules.candidate).filter(n => !n.startsWith('chunk-')).sort(), 'Entrypoints differ');
  assert.equal(Object.keys(modules.baseline).length, Object.keys(modules.candidate).length, 'Module count differs');
  const mapping = {};
  for (const [name, hash] of Object.entries(fingerprints.candidate)) {
    const matches = Object.keys(fingerprints.baseline).filter(n => fingerprints.baseline[n] === hash);
    assert.equal(matches.length, 1, `Unexpected portable code difference: ${name}`);
    mapping[name] = matches[0];
    if (!name.startsWith('chunk-')) assert.equal(matches[0], name);
  }
  assert.equal(new Set(Object.values(mapping)).size, Object.keys(mapping).length, 'Chunk mapping is not bijective');
  for (const [candidateName, baselineName] of Object.entries(mapping)) {
    let text = normalize(modules.candidate[candidateName], 'candidate');
    // Placeholders prevent accidental rewrite cascades if a filename happens to overlap.
    for (const [index, [from]] of Object.entries(mapping).entries()) text = text.split(`"./${from}"`).join(`"./__MODULE_${index}__"`);
    for (const [index, [, to]] of Object.entries(mapping).entries()) text = text.split(`"./__MODULE_${index}__"`).join(`"./${to}"`);
    assert.equal(text, normalize(modules.baseline[baselineName], 'baseline'), `Portable import graph changed: ${candidateName}`);
  }
  return { modules: Object.keys(mapping).length, candidateToBaseline: mapping, allowedChange: 'exact embedded core WASM replacement and its content-addressed import names' };
}
export function verifyProofSources(root, ref) {
  const files = [...PROOF_FILES.map(n => `proofs/${n}`), 'proofs/noop-sequence-invariants.mjs', 'proofs/noop-sequence-worker.mjs', 'proofs/noop-sequence-design.md', '.github/workflows/noop-sequence-writes.yml'];
  return Object.fromEntries(files.map(file => {
    const hash = sha256(readFileSync(join(root, file)));
    assert.equal(hash, sha256(git(root, ['show', `${ref}:${file}`])), `Uncommitted proof: ${file}`);
    return [file, hash];
  }));
}
export function compilerContext(root) {
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'))).version;
  assert.equal(installed, '0.28.20', 'Unreviewed AssemblyScript compiler');
  const script = readFileSync(join(root, 'scripts/build-wasm.mjs'), 'utf8');
  const declaredFlags = script.match(/const flags = (\[[^\n]+\]);/);
  assert(declaredFlags, 'Compiler flags missing');
  assert.deepEqual(JSON.parse(declaredFlags[1].replaceAll("'", '"')), BUILD_FLAGS);
  const bun = spawnSync(process.env.BUN_BINARY ?? 'bun', ['--version'], { encoding: 'utf8' });
  assert.equal(bun.status, 0, bun.error?.message ?? bun.stderr); assert.equal(bun.stdout.trim(), '1.4.2', 'Unreviewed portable bundler');
  return { assemblyscript: installed, bun: bun.stdout.trim(), node: process.version, commonWasmFlags: BUILD_FLAGS,
    numericSimdExtraFlags: ['--enable', 'simd'], geometryExtraFlags: ['--textFile', 'geometry-kernels.wat'],
    portableOptions: { target: 'browser', format: 'esm', splitting: true },
    buildScripts: Object.fromEntries(['scripts/build-wasm.mjs', 'scripts/build-browser.ts'].map(file => [file, sha256(readFileSync(join(root, file)))])) };
}
export function prepareComparison(baseline, candidate) {
  const paths = { baseline: resolve(baseline), candidate: resolve(candidate) }, repo = dirname(dirname(paths.candidate));
  const candidateCommit = (process.env.CANDIDATE_COMMIT ?? git(repo, ['rev-parse', 'HEAD']).toString().trim());
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error('Candidate commit must be an immutable full SHA');
  assert.equal(git(repo, ['merge-base', BASELINE_COMMIT, candidateCommit]).toString().trim(), BASELINE_COMMIT, 'Wrong comparison base');
  const changedPaths = git(repo, ['diff', '--name-only', BASELINE_COMMIT, candidateCommit]).toString().trim().split('\n');
  const allowedPaths = new Set([...Object.keys(FROZEN_FILES), ...PROOF_FILES.map(n => `proofs/${n}`), 'proofs/noop-sequence-design.md', '.github/workflows/noop-sequence-writes.yml']);
  assert(changedPaths.every(path => allowedPaths.has(path)), `Unrelated commit changes: ${changedPaths.filter(path => !allowedPaths.has(path)).join(', ')}`);
  for (const [file, hash] of Object.entries(FROZEN_FILES)) {
    assert.equal(sha256(git(repo, ['show', `${candidateCommit}:${file}`])), hash, `Frozen committed runtime/test changed: ${file}`);
    assert.equal(sha256(readFileSync(join(repo, file))), hash, `Frozen working runtime/test changed: ${file}`);
  }
  const refs = { baseline: BASELINE_COMMIT, candidate: candidateCommit };
  const production = file => (/\.ts$/.test(file) && !file.endsWith('.test.ts') && !/^(proofs|type-tests|website|demo|demo-app)\//.test(file)) || file === 'package.json' || /^tsconfig.*\.json$/.test(file) || /^scripts\/build[^/]*\.(mjs|ts)$/.test(file);
  const names = new Set();
  for (const ref of Object.values(refs)) for (const file of git(repo, ['ls-tree', '-r', '--name-only', ref]).toString().trim().split('\n')) if (production(file)) names.add(file);
  const sourceManifests = {};
  for (const [variant, ref] of Object.entries(refs)) {
    const root = dirname(dirname(paths[variant])), files = {};
    for (const file of [...names].sort()) {
      const expected = git(repo, ['show', `${ref}:${file}`]);
      files[file] = sha256(readFileSync(join(root, file)));
      assert.equal(files[file], sha256(expected), `Source is not pinned ${variant}/${file}`);
    }
    // Reused generated kernels must be byte-identical, even for portable builds.
    const wasm = Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha256(readFileSync(join(root, file)))]));
    assert(Object.keys(wasm).length >= 4, 'Missing generated kernels');
    sourceManifests[variant] = { root, files, wasm };
  }
  const sourceDiff = [...names].filter(file => sourceManifests.baseline.files[file] !== sourceManifests.candidate.files[file]).sort();
  assert.deepEqual(sourceDiff, ['persistent-core.as.ts'], 'Unrelated runtime/build source difference');
  const scope = verifyVectorOnlySource(readFileSync(join(sourceManifests.baseline.root, 'persistent-core.as.ts'), 'utf8'), readFileSync(join(sourceManifests.candidate.root, 'persistent-core.as.ts'), 'utf8'));
  assert.equal(sourceManifests.candidate.files['persistent-core.as.ts'], '7a578ee28ec5d82253b7a686c7a5c1b3e8eb3729feaf3d1fd89260dc9dbbcd4c', 'Unreviewed persistent-core runtime change');
  const aliases = ['persistent-core', 'shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue'].map(name => name + '.wasm');
  const coreHashes = { baseline: 'b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4', candidate: '5fc20f651963718601578d105bd560e0b31f62421df4edb8080ba7bc5ad1334f' };
  assert.deepEqual(Object.keys(sourceManifests.baseline.wasm), Object.keys(sourceManifests.candidate.wasm));
  for (const role of ['baseline', 'candidate']) for (const name of aliases) assert.equal(sourceManifests[role].wasm[name], coreHashes[role], `Incorrect ${role} core alias ${name}`);
  for (const name of Object.keys(sourceManifests.baseline.wasm)) if (!aliases.includes(name)) assert.equal(sourceManifests.baseline.wasm[name], sourceManifests.candidate.wasm[name], `Unrelated WASM changed: ${name}`);
  const abi = {};
  for (const role of ['baseline', 'candidate']) {
    const module = new WebAssembly.Module(readFileSync(join(sourceManifests[role].root, 'persistent-core.wasm')));
    abi[role] = { imports: WebAssembly.Module.imports(module), exports: WebAssembly.Module.exports(module) };
  }
  assert.deepEqual(abi.baseline, abi.candidate, 'Core WASM import/export ABI changed');
  const portableComparison = comparePortableBundles(paths);
  return { paths, sourcePaths: paths, sourceManifests, sourceDiff, candidateCommit, changedPaths, historicalRuntimeTestCommit: HISTORICAL_RUNTIME_TEST_COMMIT, historicalCandidateCommit: HISTORICAL_CANDIDATE_COMMIT, scope, frozenFiles: FROZEN_FILES, abi, portableComparison,
    manifests: Object.fromEntries(Object.entries(paths).map(([key, entry]) => [key, bundleManifest(entry)])) };
}
