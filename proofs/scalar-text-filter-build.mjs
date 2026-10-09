/** Reproduce the pinned baseline and guarded candidate proof; never runs timing. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad';
const build = 'build/scalar-text-filter/';
mkdirSync(build + 'baseline-source', { recursive: true });
const sources = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).trim().split('\n').filter(name => name.endsWith('.as.ts'));
for (const path of sources) {
  assert.ok(!path.includes('/'));
  writeFileSync(build + 'baseline-source/' + path, execFileSync('git', ['show', base + ':' + path]));
}
copyFileSync(build + 'baseline-source/shared-text-reader.as.ts', build + 'baseline-reader.as.ts');
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
const asc = resolve('node_modules/assemblyscript/bin/asc.js');
execFileSync(process.execPath, [asc, build + 'baseline-source/shared-runtime.as.ts', '-o', build + 'reproduced-baseline-core.wasm', ...flags], { stdio: 'inherit' });
const hadBaseline = existsSync(build + 'baseline-core.wasm');
if (!hadBaseline) copyFileSync(build + 'reproduced-baseline-core.wasm', build + 'baseline-core.wasm');
const firstBaseline = readFileSync(build + 'baseline-core.wasm');
assert.deepEqual(readFileSync(build + 'reproduced-baseline-core.wasm'), firstBaseline, 'The isolated baseline source must reproduce the original root build exactly');
let source = readFileSync('shared-text-reader.as.ts', 'utf8');
const before = '  const lo = <u64>q0';
assert.equal(source.split(before).length, 2);
source = source.replace(before, '  guardStart = start; guardEnd = end;\n' + before);
assert.equal((source.match(/load<u64>\(/g) ?? []).length, 5);
assert.equal((source.match(/load<u8>\(/g) ?? []).length, 3);
source = source.replaceAll('load<u64>(', 'bounded64(').replaceAll('load<u8>(', 'bounded8(');
source += `
let guardStart: u32 = 0, guardEnd: u32 = 0;
function bounded64(pointer: u32): u64 {
  assert(pointer >= guardStart && pointer + 8 <= guardEnd);
  return load<u64>(pointer);
}
function bounded8(pointer: u32): u8 {
  assert(pointer >= guardStart && pointer < guardEnd);
  return load<u8>(pointer);
}
`;
writeFileSync(build + 'guarded-reader.as.ts', source);
execFileSync(process.execPath, [asc, build + 'guarded-reader.as.ts', '-o', build + 'guarded-reader.wasm', ...flags], { stdio: 'inherit' });
console.log(JSON.stringify({ base, sources, reproducedBaselineBytes: firstBaseline.length, comparedExistingBaseline: hadBaseline, guardedLoads: { word: 5, byte: 3 }, noTimings: true }));
