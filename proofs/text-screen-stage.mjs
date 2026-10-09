/** Run after the documented clean builds. Creates guarded proof fixtures only. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { stage, hash, verifyManifest } from './text-screen-inventory.mjs';
import { caseManifest } from './text-screen-cases.mjs';

const [outputArg, baseArg, scalarArg, simdArg, bunArg] = process.argv.slice(2);
assert(outputArg && baseArg && scalarArg && simdArg && bunArg, 'output baseline-root scalar-dist simd-dist bun-executable required');
const root = resolve(import.meta.dirname, '..'), output = resolve(outputArg), base = resolve(baseArg);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const baseline = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad';
const prototypeTree = '1af8af965c3f29cb07a6db818ee326d3491f6965';
assert.equal(process.version, 'v22.23.3');
git('merge-base', '--is-ancestor', baseline, 'HEAD');
const frozen = JSON.parse(readFileSync(join(root, 'proofs/text-screen-source-pins.json')));
assert.equal(frozen.baseline, baseline);
for (const file of frozen.prototypeFiles) assert.equal(hash(readFileSync(join(root, file.file))), file.sha256, file.file);
const changedPrototype = new Set(frozen.prototypeFiles.map(file => file.file));
for (const file of git('ls-tree', '-r', '--name-only', baseline).split('\n').filter(file => !file.includes('/') && /\.(?:ts|json)$/.test(file))) {
  if (!changedPrototype.has(file)) assert.deepEqual(readFileSync(join(root, file)), execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root }), file);
}
const dependencies = realpathSync(join(root, 'node_modules'));
const versions = { node: process.version, bun: execFileSync(resolve(bunArg), ['--version'], { encoding: 'utf8' }).trim() };
assert.equal(versions.bun, '1.4.2');
for (const [name, expected] of Object.entries({ assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721', typescript: '5.9.3' })) {
  versions[name] = JSON.parse(readFileSync(join(dependencies, name, 'package.json'))).version;
  assert.equal(versions[name], expected);
}
const lock = readFileSync(join(root, 'proofs/text-screen-bun.lock'));
assert.equal(hash(lock), '3e2462a27f26395f52e20e1f958b227277d4e40c54c33ff64e06075c8fad99f3');
const compilerInputs = ['assemblyscript/package.json', 'assemblyscript/bin/asc.js', 'assemblyscript/dist/asc.js',
  'assemblyscript/dist/assemblyscript.js', 'binaryen/package.json', 'binaryen/index.js', 'typescript/package.json'].map(file => ({
  file, sha256: hash(readFileSync(join(dependencies, file))),
}));
const runtimeSources = [...new Set([...git('ls-tree', '-r', '--name-only', baseline).split('\n'), ...changedPrototype])].filter(name => !name.includes('/') && /\.(?:ts|json)$/.test(name));
const sourcePins = runtimeSources.map(name => {
  const data = readFileSync(join(root, name));
  return { file: name, sha256: hash(data) };
});
const buildPins = ['scripts/build-wasm.mjs', 'scripts/build-text-aux-experiment.mjs', 'scripts/build-browser.ts'].map(name => {
  const data = readFileSync(join(root, name));
  return { file: name, sha256: hash(data) };
});
const wasm = readdirSync(base).filter(name => name.endsWith('.wasm')).sort().map(name => {
  const data = readFileSync(join(base, name));
  assert.deepEqual(data, readFileSync(join(root, name)), name);
  return { file: name, bytes: data.length, sha256: hash(data) };
});
assert.equal(wasm.length, 12);
const auxiliary = ['scalar', 'simd'].map(arm => {
  const data = readFileSync(join(root, `text-aux-${arm}.wasm`));
  return { arm, bytes: data.length, sha256: hash(data) };
});
mkdirSync(output, { recursive: true });
mkdirSync(join(output, 'runtime')); // Reusing a populated runtime directory fails.
const arms = {};
for (const [arm, path] of Object.entries({ A0: join(base, 'dist'), A1: join(base, 'dist'), B0: resolve(scalarArg), B1: resolve(scalarArg), C0: resolve(simdArg), C1: resolve(simdArg) })) {
  arms[arm] = stage(path, join(output, 'runtime', arm));
}
const proofFiles = readdirSync(join(root, 'proofs')).filter(x => x.startsWith('text-screen-')).sort().map(file => ({
  file: `proofs/${file}`, sha256: hash(readFileSync(join(root, 'proofs', file))),
}));
const manifest = { schema: 'zerocopy-text-screen/v1', baseline, prototypeTree, sourceTree: git('write-tree'), sourcePins, buildPins, proofFiles,
  design: { runtime: 'Node22.23.3 Linux x64 GitHub-hosted', cases: 12, warmBlocks: 6, coldBlocks: 8,
    aliases: ['A0', 'A1', 'B0', 'B1', 'C0', 'C1'], warmupOperations: 8, timedBatches: 6,
    calibrationTargetNs: 20000000, batchFloorNs: 10000000, maximumRepeats: 1024, timingBudgetMs: 240000,
    warmMaterialityMargin: 0.02 },
  versions, dependencies, compilerInputs, lockSha256: hash(lock), nodeExecutable: realpathSync(process.execPath),
  nodeSha256: hash(readFileSync(process.execPath)), bunExecutable: realpathSync(resolve(bunArg)),
  bunSha256: hash(readFileSync(resolve(bunArg))), host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  wasm, auxiliary, arms, cases: caseManifest(),
  scope: 'Portable shared.js dependency closures, not npm release validation. No external control WASM or build directory in runtime fixtures.' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
verifyManifest(output);
console.log(JSON.stringify({ output, arms: Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, { files: arm.files.length, reachableJsBytes: arm.reachableJsBytes, perFileGzipBytes: arm.perFileGzipBytes }])), cases: manifest.cases.length }));
