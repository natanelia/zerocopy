import { readFileSync, rmSync } from 'node:fs';
// Embed WASM so browser entries do not require Node APIs or an extra fetch.
const encoded = readFileSync(new URL('../persistent-core.wasm', import.meta.url)).toString('base64');
const geometry = readFileSync(new URL('../geometry-kernels.wasm', import.meta.url)).toString('base64');
function embedded(name: string, data: string): string {
  return `export function ${name}() { const text = atob(${JSON.stringify(data)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`;
}
rmSync('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['shared.ts', 'tanstack-db-collection.ts', 'redux.ts', 'worker.ts', 'geometry.ts'], outdir: 'dist', naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
  plugins: [{ name: 'embedded-wasm', setup(build) {
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: embedded('loadWasm', encoded), loader: 'js' }));
    build.onLoad({ filter: /[\\/]geometry-wasm\.ts$/ }, () => ({ contents: embedded('loadGeometryWasm', geometry), loader: 'js' }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.length} portable modules: ${result.outputs.reduce((n, file) => n + file.size, 0)} bytes`);
