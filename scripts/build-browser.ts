import { readFileSync, rmSync } from 'node:fs';
const encoded = readFileSync(new URL('../persistent-core.wasm', import.meta.url)).toString('base64');
const geometry = [false, true].map(simd => readFileSync(`geometry-kernels${simd ? '-simd' : ''}.wasm`).toString('base64'));
const simplify = [false, true].map(simd => readFileSync(`simplify-kernels${simd ? '-simd' : ''}.wasm`).toString('base64'));
function embedded(name: string, bytes: string[]): string {
  return `const encoded = ${JSON.stringify(bytes)}; export function ${name}(simd) { const text = atob(encoded[simd ? 1 : 0]); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`;
}
rmSync('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['shared.ts', 'tanstack-db-collection.ts', 'redux.ts', 'worker.ts', 'geometry.ts'], outdir: 'dist', naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
  plugins: [{ name: 'embedded-wasm', setup(build) {
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { const text = atob(${JSON.stringify(encoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    build.onLoad({ filter: /[\\/]geometry-wasm\.ts$/ }, () => ({ contents: embedded('loadGeometryWasm', geometry), loader: 'js' }));
    build.onLoad({ filter: /[\\/]simplify-wasm\.ts$/ }, () => ({ contents: embedded('loadSimplifyWasm', simplify), loader: 'js' }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.length} portable modules: ${result.outputs.reduce((n, file) => n + file.size, 0)} bytes`);
