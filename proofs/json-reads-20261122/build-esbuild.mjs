import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

// Reproduce the alternative browser bundles used for the Node timings. Keep
// the package's normal Bun build and its dependencies independent of this proof.
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
if (esbuild.version !== '0.27.7') throw new Error('This proof uses esbuild 0.27.7');
const root = resolve(process.argv[2] || '.');
const outdir = join(root, 'dist');
const encoded = name => JSON.stringify(readFileSync(join(root, name + '.wasm')).toString('base64'));
const embed = `
  function bytes(text) {
    const s = atob(text), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
`;
const loaders = {
  'wasm-utils.ts': embed + `export function loadWasm() { return bytes(${encoded('persistent-core')}) }`,
  'geometry-wasm.ts': embed + `export function loadGeometryWasm() { return bytes(${encoded('geometry-kernels')}) }`,
  'numeric-wasm.ts': embed + `export function loadNumericWasm(simd) {
    return bytes(simd ? ${encoded('numeric-kernels-simd')} : ${encoded('numeric-kernels')})
  }`,
};
const entries = ['shared', 'worker', 'redux', 'state', 'tanstack-db-collection', 'numeric', 'geometry'];
const result = await esbuild.build({
  absWorkingDir: root, entryPoints: entries.map(name => name + '.ts'), format: 'esm',
  bundle: true, splitting: true, outdir, platform: 'browser', target: 'es2022', metafile: true,
  plugins: [{
    name: 'embedded-wasm',
    setup(build) {
      build.onLoad({ filter: /[\\/](?:wasm-utils|geometry-wasm|numeric-wasm)\.ts$/ }, args => ({
        contents: loaders[basename(args.path)], loader: 'js',
      }));
    },
  }],
});
// A previous build may leave chunk files with different content hashes.
const emitted = new Set(Object.keys(result.metafile.outputs).map(path => basename(path)));
for (const name of readdirSync(outdir)) {
  if (/^chunk-.*\.js$/.test(name) && !emitted.has(name)) rmSync(join(outdir, name));
}
execFileSync(process.execPath, ['website/build.mjs'], { cwd: root, stdio: 'inherit' });
