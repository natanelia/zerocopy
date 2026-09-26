import { readFileSync } from 'node:fs';
for (const name of ['baseline', 'bytes-scalar', 'bytes-simd']) {
  const encoded = readFileSync(`.simd-lab/${name}/core.wasm`).toString('base64');
  const result = await Bun.build({ entrypoints: ['shared.ts'], target: 'node', format: 'esm', outdir: `.simd-lab/public-${name}`, naming: 'shared.mjs',
    plugins: [{ name: 'experiment-core', setup(build) {
      build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ loader: 'js', contents: `export function loadWasm() { return new Uint8Array(Buffer.from(${JSON.stringify(encoded)}, 'base64')); }` }));
    } }],
  });
  if (!result.success) throw new Error(result.logs.join('\n'));
}
