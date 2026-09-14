import { readFileSync, rmSync } from 'node:fs';
// The browser uses the same source and WASM as Bun. Embed WASM so this entry
// does not need Node APIs, asynchronous module initialization, or a fetch URL.
const encoded = readFileSync(new URL('../persistent-core.wasm', import.meta.url)).toString('base64');
rmSync('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['shared.ts', 'tanstack-db-collection.ts', 'redux.ts'], outdir: 'dist', naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
  plugins: [{ name: 'embedded-wasm', setup(build) {
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { const text = atob(${JSON.stringify(encoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.length} portable modules: ${result.outputs.reduce((n, file) => n + file.size, 0)} bytes`);
