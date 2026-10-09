// Build-only semantic overlay. Never replaces production source or timed bundles.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { sha256, json, writeJson, manifest } from './radix-portability-source.mjs';
import { replaceOnce } from './radix-portability-adapter.mjs';
const here = dirname(fileURLToPath(import.meta.url));
export const SEMANTIC_PINS = Object.freeze({
  test: 'be832872d1da2283e32902b30e26ea1435cae3c3635dc8ee5aaf47bfa3554857',
  fixtures: '98e04ab88cc0f6e75e29668f750090b559319268326122c4cce3d2d71dc92992',
  proposal: 'c08c262009fcb9448a3bcfa0093a833af2222d23c1065ea5f6db3491a4a72129',
});
export function adaptFixture(source) {
  assert.equal(sha256(source), SEMANTIC_PINS.fixtures);
  const baseline = /export const baselineSource = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1]; assert(baseline);
  const ast = ts.createSourceFile('arena.ts', baseline, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arena = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'Arena');
  const methods = ['leaves', 'radixLeaves'].map(name => arena.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name));
  assert.deepEqual(methods.map(node => sha256(baseline.slice(node.getStart(ast), node.end))), [
    '8f8912ccc6d344d28207fd3fb01d5cd7ec6c85cd0658704e739cecd5d39f3365', 'f5450c8eb333782ca090685d51bdaa5e08c5529b50694ab0a3eaa40253386c04']);
  const precompiled = ts.transpileModule(`class BaselineTraversal { ${methods.map(node => baseline.slice(node.getStart(ast), node.end)).join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const start = source.indexOf('export function methodSource('), end = source.indexOf('export function withMethods<');
  assert(start > 0 && end > start);
  let adapted = source.slice(0, start) + precompiled + '\nexport const baselineMethods = BaselineTraversal.prototype;\n' + source.slice(end);
  for (const line of ["import ts from 'typescript';\n", "import { createHash } from 'node:crypto';\n"]) adapted = replaceOnce(adapted, line, '');
  return { source: adapted, sourceSha256: sha256(adapted), originalSha256: sha256(source), precompiledBaselineSha256: sha256(precompiled),
    rationale: 'Only untimed baseline method parsing/compilation and its build-time hash assertions are precomputed; semantic test bodies and remaining fixture helpers are unchanged.' };
}
export const registrationShim = `const tests = []; const scopes = [];
export function describe(name, fn) { scopes.push(name); try { fn(); } finally { scopes.pop(); } }
export function it(name, fn) { tests.push({ name: [...scopes, name].join(' / '), fn }); }
export async function runSemantics() {
  if (tests.length !== 17) throw new Error('Expected exactly 17 frozen semantic tests');
  const results = [];
  for (const test of tests) {
    try { await test.fn(); results.push({ name: test.name, status: 'passed' }); }
    catch (error) { results.push({ name: test.name, status: 'failed', error: String(error.stack ?? error) }); return { status: 'failed', results }; }
  }
  return { status: 'completed', results };
}`;
export async function buildSemantics(sourceRoot, outputRoot) {
  assert.equal(globalThis.Bun?.version, '1.4.2'); assert.equal(Bun.revision, '744846f844374847c902b5e7fd59b4342a51ef99');
  sourceRoot = resolve(sourceRoot); outputRoot = resolve(outputRoot); mkdirSync(outputRoot, { recursive: true });
  const testPath = join(sourceRoot, 'trie-view-capture.test.ts'), fixturePath = join(sourceRoot, 'proofs/trie-view-fixtures.ts');
  const proposal = readFileSync(join(here, 'radix-frame-screen-proposal.test.txt'), 'utf8'), test = readFileSync(testPath, 'utf8');
  assert.equal(sha256(test), SEMANTIC_PINS.test); assert.equal(sha256(proposal), SEMANTIC_PINS.proposal);
  const fixture = adaptFixture(readFileSync(fixturePath, 'utf8'));
  const shimPath = join(outputRoot, 'registration.mjs'); writeFileSync(shimPath, registrationShim, { flag: 'wx' });
  const assertPath = join(outputRoot, 'assert.mjs'); writeFileSync(assertPath, `export { assert as default } from ${JSON.stringify(join(here, 'radix-portability-browser-shims.mjs'))};\n`, { flag: 'wx' });
  const entryPath = join(outputRoot, 'entry.mjs'); writeFileSync(entryPath, `import ${JSON.stringify(testPath)};\nimport 'frame-proposal';\nexport { runSemantics } from './registration.mjs';\n`, { flag: 'wx' });
  const wasm = Object.fromEntries(['persistent-core', 'numeric-kernels', 'numeric-kernels-simd', 'geometry-kernels'].map(name => [name, readFileSync(join(sourceRoot, `${name}.wasm`))]));
  const result = await Bun.build({ entrypoints: [entryPath], outdir: join(outputRoot, 'bundle'), naming: 'semantics.js', target: 'browser', format: 'esm', splitting: false,
    plugins: [{ name: 'frozen-semantic-environment', setup(build) {
      build.onResolve({ filter: /^vitest$/ }, () => ({ path: shimPath }));
      build.onResolve({ filter: /^node:assert\/strict$/ }, () => ({ path: assertPath }));
      build.onResolve({ filter: /^frame-proposal$/ }, () => ({ path: 'frame-proposal', namespace: 'frame-proposal' }));
      build.onLoad({ filter: /.*/, namespace: 'frame-proposal' }, () => ({ contents: proposal, loader: 'ts', resolveDir: sourceRoot }));
      build.onLoad({ filter: /[\\/]trie-view-fixtures\.ts$/ }, ({ path }) => { assert.equal(path, fixturePath); return { contents: fixture.source, loader: 'ts' }; });
      for (const [filename, exportName, body] of [
        ['wasm-utils', 'loadWasm', JSON.stringify(wasm['persistent-core'].toString('base64'))],
        ['numeric-wasm', 'loadNumericWasm', `simd ? ${JSON.stringify(wasm['numeric-kernels-simd'].toString('base64'))} : ${JSON.stringify(wasm['numeric-kernels'].toString('base64'))}`],
        ['geometry-wasm', 'loadGeometryWasm', JSON.stringify(wasm['geometry-kernels'].toString('base64'))],
      ]) build.onLoad({ filter: new RegExp(`[\\\\/]${filename}\\.ts$`) }, () => ({ contents: `export function ${exportName}(simd) { const text = atob(${body}); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }`, loader: 'js' }));
    } }],
  });
  assert(result.success, result.logs.map(String).join('\n')); assert.equal(result.outputs.length, 1);
  const { source, ...fixtureReceipt } = fixture;
  const receipt = { status: 'built', testCount: 17, sourceRoot, inputs: { test: sha256(test), proposal: sha256(proposal), arena: sha256(readFileSync(join(sourceRoot, 'arena.ts'))), fixture: fixtureReceipt,
    wasm: Object.fromEntries(Object.entries(wasm).map(([name, bytes]) => [name, sha256(bytes)])) }, bundle: manifest(join(outputRoot, 'bundle')), productionOutputUnchanged: true };
  writeJson(join(outputRoot, 'receipt.json'), receipt); return receipt;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await buildSemantics(...process.argv.slice(2))));
