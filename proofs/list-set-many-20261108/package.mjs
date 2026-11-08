import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-list-batch-package-'));
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
try {
  const [archive] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'zerocopy');
  const modules = join(temporary, 'node_modules'); mkdirSync(modules);
  // Use the actual archive in a clean consumer without a registry install.
  run('tar', ['-xzf', join(temporary, archive.filename), '-C', modules]);
  renameSync(join(modules, 'package'), join(modules, pkg.name));
  writeFileSync(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(temporary, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { SharedList, compact, getWorkerData, initWorker } from 'zerocopy';
const input = Array.from({ length: 32801 }, (_, i) => i + 0.25);
input[0] = NaN; input[1] = -0; input[2] = Infinity;
const original = new SharedList('number').pushMany(input);
const entries = [[0, 7], [32, 8], [32767, 9], [32800, 10], [32, -0], [-1, 11], [32801, 12]];
const expected = input.slice();
for (const [index, value] of entries) if (index >= 0 && index < expected.length) expected[index] = value;
const changed = original.setMany(entries);
assert.deepEqual(original.toArray(), input);
assert.deepEqual(changed.toArray(), expected);
assert.deepEqual(compact(changed).toArray(), expected);
assert.equal(original.setMany([]), original);
for (const copy of [false, true]) {
  const attached = await initWorker(getWorkerData({ original, changed }, { copy }));
  assert.deepEqual(attached.original.toArray(), input);
  assert.deepEqual(attached.changed.toArray(), expected);
  assert.throws(() => attached.changed.setMany([[0, 1]]), /read-only/);
}
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', passed: true, values: input.length }));
`);
  const node = JSON.parse(run(process.execPath, ['smoke.mjs']));
  const bun = JSON.parse(run('bun', ['smoke.mjs']));
  assert.equal(node.runtime, 'node'); assert.equal(bun.runtime, 'bun');
  const consumer = join(temporary, 'consumer.ts');
  writeFileSync(consumer, `import { SharedList } from 'zerocopy';
const list = new SharedList('number').pushMany([1, 2, 3]);
const changed: SharedList<'number'> = list.setMany([[0, 7], [2, 9]] as const);
const value: number | undefined = changed.get(0);
// @ts-expect-error A numeric List rejects string values.
list.setMany([[0, 'wrong']]);
// @ts-expect-error Point indexes must be numeric.
list.setMany([['0', 3]]);
`);
  const program = ts.createProgram([consumer], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: false,
    types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => temporary, getNewLine: () => '\n',
  }));
  console.log(JSON.stringify({ passed: true, archive: { name: archive.name, version: archive.version, integrity: archive.integrity },
    checks: [node, bun], types: 'new method and invalid-input errors verified against packed declarations' }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
