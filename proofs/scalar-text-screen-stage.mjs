/** Exact source, emitted-function and reachable-output gates; no clocks. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { stage, hash, verifyManifest, inventory } from './scalar-text-screen-inventory.mjs';
import { caseManifest } from './scalar-text-screen-cases.mjs';
import { RUNTIME_COMMIT as runtimeCommit, RUNTIME_TREE as runtimeTree } from './scalar-text-screen-activation.mjs';
const [outputArg, baseArg, bunArg] = process.argv.slice(2);
assert(outputArg && baseArg && bunArg, 'output baseline-root bun-executable required');
const root = resolve(import.meta.dirname, '..'), output = resolve(outputArg), base = resolve(baseArg);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const baseline = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad';
assert.equal(git('rev-parse', `${runtimeCommit}^{tree}`), runtimeTree);
assert.equal(git('rev-parse', `${runtimeCommit}^`), baseline);
assert.equal(git('diff', '--name-only'), '', 'No unstaged tracked edits');
assert.equal(process.version, 'v22.23.3');
const prototypeFiles = ['proofs/scalar-text-filter-build.mjs', 'proofs/scalar-text-filter-census.mjs',
  'proofs/scalar-text-filter-correctness.mjs', 'proofs/scalar-text-filter-experiment.md',
  'proofs/scalar-text-filter-format.mjs', 'shared-text-reader.as.ts'];
assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', runtimeCommit).split('\n'), prototypeFiles);
const sourceNames = git('ls-tree', '-r', '--name-only', baseline).split('\n').filter(file =>
  (!file.includes('/') && /\.(?:ts|json)$/.test(file)) || file.startsWith('scripts/'));
const sourcePins = sourceNames.map(file => {
  const candidate = readFileSync(join(root, file)), original = readFileSync(join(base, file));
  assert.deepEqual(candidate, execFileSync('git', ['show', `${runtimeCommit}:${file}`], { cwd: root }), file);
  assert.deepEqual(original, execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root }), `base:${file}`);
  if (file !== 'shared-text-reader.as.ts') assert.deepEqual(candidate, original, file);
  return { file, sha256: hash(candidate), baselineSha256: hash(original) };
});
for (const file of prototypeFiles) assert.deepEqual(readFileSync(join(root, file)), execFileSync('git', ['show', `${runtimeCommit}:${file}`], { cwd: root }), file);
const dependencies = realpathSync(join(root, 'node_modules'));
const versions = { node: process.version, bun: execFileSync(resolve(bunArg), ['--version'], { encoding: 'utf8' }).trim() };
assert.equal(versions.bun, '1.4.2');
for (const [name, expected] of Object.entries({ assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721', typescript: '5.9.3', vitest: '4.1.11' })) {
  versions[name] = JSON.parse(readFileSync(join(dependencies, name, 'package.json'))).version;
  assert.equal(versions[name], expected);
}
const lock = readFileSync(join(root, 'proofs/scalar-text-screen-bun.lock'));
assert.equal(hash(lock), '3e2462a27f26395f52e20e1f958b227277d4e40c54c33ff64e06075c8fad99f3');
const compilerInputs = ['assemblyscript/package.json', 'assemblyscript/bin/asc.js', 'assemblyscript/dist/asc.js',
  'assemblyscript/dist/assemblyscript.js', 'binaryen/package.json', 'binaryen/index.js', 'typescript/package.json', 'vitest/package.json', 'vitest/dist/chunks/cli-api.CnMVyzaz.js'].map(file => ({ file, sha256: hash(readFileSync(join(dependencies, file))) }));
function leb(b, c) { let n = 0, shift = 0, byte; do { byte = b[c.i++]; n += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return n; }
function sections(b) { const c = { i: 8 }, out = []; while (c.i < b.length) { const id = b[c.i++], n = leb(b, c); out.push({ id, data: b.subarray(c.i, c.i + n) }); c.i += n; } return out; }
function bodies(b) { const c = { i: 0 }, count = leb(b, c), out = []; for (let i = 0; i < count; i++) { const n = leb(b, c); out.push(b.subarray(c.i, c.i + n)); c.i += n; } assert.equal(c.i, b.length); return out; }
const coreA = readFileSync(join(base, 'persistent-core.wasm')), coreB = readFileSync(join(root, 'persistent-core.wasm'));
assert.equal(hash(coreA), 'b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4');
assert.equal(hash(coreB), '383a99278cb1eae78a164489493c71eeb2a0cea3b3edb3db47349fe5e54b0647');
const sectionsA = sections(coreA), sectionsB = sections(coreB);
assert.deepEqual(sectionsA.map(x => x.id), sectionsB.map(x => x.id));
for (let i = 0; i < sectionsA.length; i++) if (sectionsA[i].id !== 10) assert.deepEqual(sectionsA[i].data, sectionsB[i].data, `non-code section ${i}`);
const moduleA = new WebAssembly.Module(coreA), moduleB = new WebAssembly.Module(coreB);
assert.deepEqual(WebAssembly.Module.imports(moduleA), WebAssembly.Module.imports(moduleB));
assert.deepEqual(WebAssembly.Module.exports(moduleA), WebAssembly.Module.exports(moduleB));
assert(!WebAssembly.Module.imports(moduleA).some(x => x.kind === 'function'));
const ex = sectionsA.find(x => x.id === 7).data, cur = { i: 0 }, count = leb(ex, cur), names = new Map();
for (let i = 0; i < count; i++) { const n = leb(ex, cur), name = ex.subarray(cur.i, cur.i + n).toString(); cur.i += n; const kind = ex[cur.i++], index = leb(ex, cur); if (kind === 0) names.set(index, name); }
const bodyA = bodies(sectionsA.find(x => x.id === 10).data), bodyB = bodies(sectionsB.find(x => x.id === 10).data);
assert.equal(bodyA.length, bodyB.length);
const changedFunctions = bodyA.flatMap((b, i) => b.equals(bodyB[i]) ? [] : [{ index: i, name: names.get(i), baselineBytes: b.length, candidateBytes: bodyB[i].length }]);
assert.deepEqual(changedFunctions.map(x => x.name), ['textContains16']);
const wasmNames = readdirSync(base).filter(x => x.endsWith('.wasm')).sort();
assert.equal(wasmNames.length, 12); assert.deepEqual(readdirSync(root).filter(x => x.endsWith('.wasm')).sort(), wasmNames);
const wasm = wasmNames.map(file => { const a = readFileSync(join(base, file)), b = readFileSync(join(root, file));
  if (a.equals(coreA)) assert.deepEqual(b, coreB, file); else assert.deepEqual(a, b, file);
  return { file, baselineBytes: a.length, candidateBytes: b.length, baselineSha256: hash(a), candidateSha256: hash(b) }; });
assert.equal(wasm.filter(x => x.baselineSha256 !== x.candidateSha256).length, 9);
mkdirSync(join(output, 'binaries'));
for (const [role, from] of [['baseline', base], ['candidate', root]]) {
  mkdirSync(join(output, 'binaries', role));
  for (const file of wasmNames) copyFileSync(join(from, file), join(output, 'binaries', role, file));
}
const distOutputs = { baseline: inventory(join(base, 'dist')), candidate: inventory(join(root, 'dist')) };
mkdirSync(join(output, 'runtime'));
const arms = {};
for (const arm of ['A0', 'A1', 'B0', 'B1']) arms[arm] = stage(join(arm.startsWith('A') ? base : root, 'dist'), join(output, 'runtime', arm));
for (const arm of Object.keys(arms)) {
  const expected = arm.startsWith('A') ? coreA : coreB;
  const embedded = arms[arm].files.filter(x => x.file.endsWith('.js')).flatMap(x => [...readFileSync(join(output, 'runtime', arm, x.file), 'utf8').matchAll(/["'](AGFzbQ[A-Za-z0-9+/=]+)["']/g)].map(m => Buffer.from(m[1], 'base64')));
  assert.equal(embedded.length, 1, 'Only the one mandatory core may be embedded'); assert.deepEqual(embedded[0], expected);
}
const proofFiles = readdirSync(join(root, 'proofs')).filter(x => x.startsWith('scalar-text-')).sort().map(file => ({ file: `proofs/${file}`, sha256: hash(readFileSync(join(root, 'proofs', file))) }));
const manifest = { schema: 'zerocopy-scalar-text-screen/v1', baseline, runtimeCommit, runtimeTree, sourceTree: git('write-tree'), sourcePins,
  buildPins: [], proofFiles, design: { runtime: 'Node22.23.3 Linux x64 GitHub-hosted', cases: 12, warmBlocks: 8, coldBlocks: 8,
    aliases: ['A0', 'A1', 'B0', 'B1'], warmupOperations: 8, timedBatches: 6, calibrationTargetNs: 20000000,
    batchFloorNs: 10000000, maximumRepeats: 1024, timingBudgetMs: 240000, totalProcesses: 40, warmMaterialityMargin: 0.02,
    warmAaRule: 'point outside [1/1.02,1.02] AND descriptive95Percent excludes 1',
    coldAaRule: 'point outside [0.9,1.1] OR descriptive95Percent excludes 1' },
  versions, dependencies, compilerInputs, lockSha256: hash(lock), nodeExecutable: realpathSync(process.execPath), nodeSha256: hash(readFileSync(process.execPath)),
  bunExecutable: realpathSync(resolve(bunArg)), bunSha256: hash(readFileSync(resolve(bunArg))), host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  changedFunctions, unchangedFunctions: bodyA.length - changedFunctions.length, wasm, distOutputs, arms, cases: caseManifest(),
  scope: 'Structural repeated/interned values, portable shared.js closure; no natural-text, large-string-working-set, release or adoption claim.' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
verifyManifest(output);
console.log(JSON.stringify({ runtimeCommit, runtimeTree, changedFunctions, arms: Object.fromEntries(Object.entries(arms).map(([key, value]) => [key, { reachableJsBytes: value.reachableJsBytes, perFileGzipBytes: value.perFileGzipBytes }])), timingsRun: false }));
