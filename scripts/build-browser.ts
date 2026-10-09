import { readFileSync, rmSync } from 'node:fs';
// The browser uses the same source and WASM as Bun. Embed WASM so this entry
// does not need Node APIs, asynchronous module initialization, or a fetch URL.
const encoded = readFileSync(new URL('../persistent-core.wasm', import.meta.url)).toString('base64');
const numericScalar = readFileSync(new URL('../numeric-kernels.wasm', import.meta.url)).toString('base64');
const numericSimd = readFileSync(new URL('../numeric-kernels-simd.wasm', import.meta.url)).toString('base64');
const geometryEncoded = readFileSync(new URL('../geometry-kernels.wasm', import.meta.url)).toString('base64');
// Build-time control only: no runtime threshold, option, or redundant fallback binary.
const textArm = process.env.TEXT_AUX_ARM ?? 'simd';
if (textArm !== 'scalar' && textArm !== 'simd') throw new Error('TEXT_AUX_ARM must be scalar or simd');
const textEncoded = readFileSync(new URL(`../text-aux-${textArm}.wasm`, import.meta.url)).toString('base64');
rmSync('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['shared.ts', 'tanstack-db-collection.ts', 'redux.ts', 'worker.ts', 'state.ts', 'numeric.ts', 'geometry.ts'], outdir: 'dist', naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
  plugins: [{ name: 'embedded-wasm', setup(build) {
    build.onLoad({ filter: /[\\/]text-wasm\.ts$/ }, () => ({ contents: `export function loadTextWasm() { const text = atob(${JSON.stringify(textEncoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { const text = atob(${JSON.stringify(encoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    build.onLoad({ filter: /[\\/]numeric-wasm\.ts$/ }, () => ({ contents: `export function loadNumericWasm(simd) { const text = atob(simd ? ${JSON.stringify(numericSimd)} : ${JSON.stringify(numericScalar)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    build.onLoad({ filter: /[\\/]geometry-wasm\.ts$/ }, () => ({ contents: `export function loadGeometryWasm() { const text = atob(${JSON.stringify(geometryEncoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.length} portable modules: ${result.outputs.reduce((n, file) => n + file.size, 0)} bytes`);
