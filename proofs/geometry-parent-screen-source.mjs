// Untimed source, compiler, root-Wasm and complete portable-package receipts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
export const BASELINE = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const CANDIDATE = 'c6db76c1363b6f7512a9919fe7f450ef801fd626';
export const CANDIDATE_TREE = 'ad3c3cb8669b3cfe77943caa78bee89f38572c29';
export const BRANCH = 'refs/heads/perf/geometry-parent-cache-20261008';
export const TOOLCHAIN = Object.freeze({node: '22.23.3', bun: '1.4.2', assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721', long: '5.3.2', typescript: '5.9.3'});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ORIGINAL_HASHES = Object.freeze({
  'proofs/geometry-bbox.mjs': 'b1a43ae6e0689d0e651f03dcb78a45182b674f84bef58434bdf35fca34dea11b',
  'proofs/geometry-fixtures.mjs': 'd11400eadff235f2aa2a9918cfa3ac971ff4586ccb6ba1789a02839c5cbbcf36',
  'proofs/geometry-parent-cache.mjs': 'cd5c5b1c85d8f359b3bd65fa03570c64baa0020e49dc6b6de041d55f74d9f906',
});
export const COMPILER_HASHES = Object.freeze({
  assemblyscript: '4530bcb58bdb9def1c62f2b715adad09a50891da09f5e5f740eee0eca036b388',
  binaryen: 'e425c8f319c85f872f998ab4744aaab74397e3596688dc6bc3623140277340c5',
  long: '365aa8b91a37d583e683d596842e94ca5f7d0f680c2187bee57918c67b3d330b',
  typescript: '157973716ed7eea8fef4816c93432cb12febb4c31b02360394d7767304bdb4e5',
});
export const GEOMETRY_WASM = Object.freeze({baseline: '01652e1fd8dd0a8b6a1f808dc07ad2dd05d8918c966d99ed429657a51de4a9d0', candidate: '5245cf99384b918c9afe233047871d95bc47a2a0bfacecd8c3fb42b2f25ed2a4'});
export const PROOF_FILES = Object.freeze([
  'proofs/geometry-parent-screen-source.mjs', 'proofs/geometry-parent-screen-protocol.mjs',
  'proofs/geometry-parent-screen-timing.mjs', 'proofs/geometry-parent-screen-subject.mjs',
  'proofs/geometry-parent-screen.mjs', 'proofs/geometry-parent-screen-prerequisites.mjs',
  'proofs/geometry-parent-screen.node.mjs', 'docs/geometry-parent-cache-screen.md',
  '.github/workflows/geometry-parent-cache-screen.yml',
]);
export const SUBJECT_FILES = Object.freeze([
  'geometry-parent-screen-subject.mjs', 'geometry-parent-screen-protocol.mjs',
  'geometry-parent-screen-timing.mjs', 'geometry-fixtures.mjs', 'geometry-bbox.mjs',
]);
export function git(root, args) { return execFileSync('git', args, {cwd: root, maxBuffer: 128*1024*1024}); }
export function files(root, predicate = () => true) {
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name); assert(!entry.isSymbolicLink(), `Symlink: ${path}`);
      if (entry.isDirectory()) walk(path); else { assert(entry.isFile()); if (predicate(relative(root,path))) found.push(relative(root,path)); }
    }
  }
  assert(lstatSync(root).isDirectory()); walk(root);
  return Object.fromEntries(found.sort().map(file => [file, sha256(readFileSync(join(root,file)))]));
}
export function compilerManifest(root) {
  return Object.fromEntries(Object.entries(COMPILER_HASHES).map(([name, hash]) => {
    const dir = join(root,'node_modules',name), version = JSON.parse(readFileSync(join(dir,'package.json'))).version;
    assert.equal(version,TOOLCHAIN[name]); const manifest = files(dir), actual = sha256(JSON.stringify(manifest));
    assert.equal(actual,hash, `Unpinned compiler: ${name}`); return [name,{version,sha256:actual,files:manifest}];
  }));
}
const isCode = file => (/\.(?:[cm]?[jt]sx?|json|sh)$/.test(file) && !file.startsWith('proofs/results/') && !file.includes('-results/'))
  || ['.npmignore','.gitignore','.gitattributes','bun.lock','bun.lockb','package-lock.json'].includes(file);
export function sourceComparison(baseRoot, candidateRoot) {
  const roots = {baseline:resolve(baseRoot),candidate:resolve(candidateRoot)}, refs = {baseline:BASELINE,candidate:CANDIDATE};
  assert(!roots.baseline.startsWith(roots.candidate+'/'), 'Baseline must live outside the project');
  assert.equal(git(candidateRoot,['rev-parse',CANDIDATE+'^{tree}']).toString().trim(),CANDIDATE_TREE);
  assert.equal(git(candidateRoot,['rev-parse',CANDIDATE+'^']).toString().trim(),BASELINE);
  const manifests = {};
  for (const build of ['baseline','candidate']) {
    const root = roots[build], ref = refs[build];
    const names = git(candidateRoot,['ls-tree','-r','--name-only',ref]).toString().trim().split('\n').filter(isCode);
    const manifest = {};
    for (const name of names) {
      assert(lstatSync(join(root,name)).isFile()); const bytes = readFileSync(join(root,name));
      manifest[name] = sha256(bytes); assert.equal(manifest[name],sha256(git(candidateRoot,['show',ref+':'+name])),`Original source changed: ${build}/${name}`);
    }
    manifests[build] = manifest;
  }
  const production = Object.keys(manifests.baseline).filter(name => !name.startsWith('proofs/'));
  assert.deepEqual(production.filter(name => manifests.baseline[name] !== manifests.candidate[name]), ['geometry-kernels.as.ts']);
  for (const [file, hash] of Object.entries(ORIGINAL_HASHES)) assert.equal(manifests.candidate[file], hash);
  const changed = git(candidateRoot,['diff','--name-only',CANDIDATE]).toString().trim().split('\n').filter(Boolean);
  assert(changed.every(file => PROOF_FILES.includes(file)), 'Proof head changed runtime or original evidence');
  for (const entry of readdirSync(candidateRoot,{withFileTypes:true})) if (entry.isFile() && isCode(entry.name))
    assert(entry.name in manifests.candidate || ['bun.lock','bun.lockb'].includes(entry.name), `Untracked production input: ${entry.name}`);
  return {roots,refs,manifests,proofHead:git(candidateRoot,['rev-parse','HEAD']).toString().trim()};
}
export function buildManifest(root, build) {
  const wasm = Object.fromEntries(readdirSync(root).filter(file=>file.endsWith('.wasm')).sort().map(file=>[file,sha256(readFileSync(join(root,file)))]));
  assert.equal(Object.keys(wasm).length,12); assert.equal(wasm['geometry-kernels.wasm'],GEOMETRY_WASM[build]);
  const bundle = files(join(root,'dist'));
  const embedded = {};
  for (const file of Object.keys(bundle).filter(file=>file.endsWith('.js'))) {
    const hashes = [...readFileSync(join(root,'dist',file),'utf8').matchAll(/["'](AGFzbQ[A-Za-z0-9+/=]+)["']/g)].map(m=>sha256(Buffer.from(m[1],'base64')));
    if (hashes.length) embedded[file] = hashes;
  }
  assert.deepEqual([...new Set(Object.values(embedded).flat())].sort(),[...new Set(Object.values(wasm))].sort(), 'Embedded modules differ from root Wasm');
  return {wasm,bundle,embedded,packageSha256:sha256(readFileSync(join(root,'package.json'))),compiler:compilerManifest(root)};
}
export function compare(baseRoot,candidateRoot) {
  const source = sourceComparison(baseRoot,candidateRoot), builds = {};
  for (const build of ['baseline','candidate']) builds[build] = buildManifest(source.roots[build],build);
  assert.deepEqual(Object.keys(builds.baseline.wasm),Object.keys(builds.candidate.wasm));
  const changed = Object.keys(builds.baseline.wasm).filter(file=>builds.baseline.wasm[file] !== builds.candidate.wasm[file]);
  assert.deepEqual(changed,['geometry-kernels.wasm']);
  assert.deepEqual(builds.baseline.compiler,builds.candidate.compiler);
  return {...source,builds,unrelatedWasmMatches:11};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode,baseline,candidate] = process.argv.slice(2);
  assert(['source','compare','compiler'].includes(mode));
  console.log(JSON.stringify(mode === 'source' ? sourceComparison(baseline,candidate) : mode === 'compare' ? compare(baseline,candidate) : compilerManifest(baseline),null,2));
}
