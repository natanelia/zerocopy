import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const root = process.cwd();
const base = execFileSync('git', ['show', 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad:compaction.ts'], { encoding: 'utf8' });
const core = readFileSync('persistent-core.wasm').toString('base64');
const scalar = readFileSync('numeric-kernels.wasm').toString('base64');
const simd = readFileSync('numeric-kernels-simd.wasm').toString('base64');
const geometry = readFileSync('geometry-kernels.wasm').toString('base64');
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const summary: any = { runtime: Bun.version, base: 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad', arms: {} };
for (const arm of ['baseline', 'candidate']) {
  const outdir = `${root}/.proof-tools/heap-compaction-records/build/${arm}`;
  const result = await Bun.build({
    entrypoints: ['shared.ts', 'tanstack-db-collection.ts', 'redux.ts', 'worker.ts', 'state.ts', 'numeric.ts', 'geometry.ts'],
    outdir, naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
    plugins: [{ name: 'exact-source-arm-and-embedded-wasm', setup(build) {
      if (arm === 'baseline') build.onLoad({ filter: /[\\/]compaction\.ts$/ }, () => ({ contents: base, loader: 'ts', resolveDir: root }));
      build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { const text = atob(${JSON.stringify(core)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
      build.onLoad({ filter: /[\\/]numeric-wasm\.ts$/ }, () => ({ contents: `export function loadNumericWasm(simd) { const text = atob(simd ? ${JSON.stringify(simd)} : ${JSON.stringify(scalar)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
      build.onLoad({ filter: /[\\/]geometry-wasm\.ts$/ }, () => ({ contents: `export function loadGeometryWasm() { const text = atob(${JSON.stringify(geometry)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    } }],
  });
  assert(result.success, String(result.logs));
  const files = [];
  for (const file of result.outputs) { const bytes = new Uint8Array(await file.arrayBuffer()); files.push({ file: file.path.slice(outdir.length + 1), bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: hash(bytes) }); }
  files.sort((a, b) => a.file.localeCompare(b.file));
  summary.arms[arm] = { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0), totalGzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0) };
}
summary.rawDelta = summary.arms.candidate.totalBytes - summary.arms.baseline.totalBytes;
summary.gzipDelta = summary.arms.candidate.totalGzipBytes - summary.arms.baseline.totalGzipBytes;
summary.wasm = Object.fromEntries(['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'].map(file => [file, { bytes: readFileSync(file).length, sha256: hash(readFileSync(file)) }]));
const proof = await Bun.build({
  entrypoints: ['proofs/heap-compaction-records-check.ts'], outdir: '.proof-tools/heap-compaction-records', naming: 'node-check.mjs', target: 'node', format: 'esm',
  plugins: [{ name: 'embedded-core-for-node-proof', setup(build) {
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { return new Uint8Array(Buffer.from(${JSON.stringify(core)}, 'base64')); }`, loader: 'js' }));
  } }],
});
assert(proof.success, String(proof.logs));
summary.nodeProofBundleSha256 = hash(readFileSync('.proof-tools/heap-compaction-records/node-check.mjs'));
writeFileSync('.proof-tools/heap-compaction-records/emitted-sizes.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ baselineBytes: summary.arms.baseline.totalBytes, candidateBytes: summary.arms.candidate.totalBytes, rawDelta: summary.rawDelta, gzipDelta: summary.gzipDelta }));
