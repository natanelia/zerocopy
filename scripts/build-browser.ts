import { readFileSync, rmSync } from 'node:fs';
// The browser uses the same source and WASM as Bun. Embed WASM so this entry
// does not need Node APIs, asynchronous module initialization, or a fetch URL.
const bytes = [...readFileSync(new URL('../persistent-core.wasm', import.meta.url))];
rmSync('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['shared.ts', 'tanstack-db-collection.ts'], outdir: 'dist', naming: '[name].js', target: 'browser', format: 'esm', splitting: true,
  plugins: [{ name: 'embedded-wasm', setup(build) {
    build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { return new Uint8Array(${JSON.stringify(bytes)}); }`, loader: 'js' }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.length} portable modules: ${result.outputs.reduce((n, file) => n + file.size, 0)} bytes`);
