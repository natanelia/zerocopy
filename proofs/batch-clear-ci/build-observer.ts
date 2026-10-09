// Separate diagnostic bundle only. Official dist and WASM are never replaced.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
const [base, candidate, directory] = process.argv.slice(2).map(p => path.resolve(p));
for (const [arm, source] of [['baseline', base], ['candidate', candidate]]) {
  const entry = path.join(directory, arm + '-observer-entry.ts');
  writeFileSync(entry, `export * from ${JSON.stringify(path.join(source, 'shared.ts'))};\n`, {flag: 'wx'});
  const encoded = readFileSync(path.join(directory, arm + '-instrumented.wasm')).toString('base64');
  const result = await Bun.build({entrypoints: [entry], outdir: directory, naming: arm + '-observer.mjs', target: 'browser', format: 'esm',
    plugins: [{name: 'batch-count-only-diagnostic', setup(build) {
      build.onLoad({filter: /[\\/]wasm-utils\.ts$/}, () => ({contents: `export function loadWasm() { const text = atob(${JSON.stringify(encoded)}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js'}));
    }}]});
  if (!result.success) throw new Error(JSON.stringify(result.logs));
  console.log(JSON.stringify({arm, diagnosticOnly: true, outputs: result.outputs.map(output => ({path: output.path, bytes: output.size}))}));
}
