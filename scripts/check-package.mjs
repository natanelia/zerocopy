import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-package-'));
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
try {
  // Inspect the actual archive, not imports resolved against the source checkout.
  const [archive] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  const paths = new Set(archive.files.map(file => file.path));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const conditions of Object.values(pkg.exports)) {
    for (const path of Object.values(conditions)) assert.ok(paths.has(path.replace(/^\.\//, '')), `Missing export: ${path}`);
  }
  for (const path of paths) {
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|website|proofs|scripts|\.github)\//, path);
    assert.doesNotMatch(path, /(?:\.test\.ts|\.as\.ts|\.wat|\.tgz)$|^tsconfig.*\.json$/, path);
  }
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, archive.filename)]);

  const imports = Object.keys(pkg.exports).map(path => path === '.' ? pkg.name : pkg.name + path.slice(1));
  const smoke = `import assert from 'node:assert/strict';
import { SharedList } from 'zerocopy';
${imports.map((name, index) => `import * as entry${index} from ${JSON.stringify(name)}; assert.ok(Object.keys(entry${index}).length > 0);`).join('\n')}
const before = new SharedList('number').pushMany([1, 2]);
const after = before.push(3);
assert.deepEqual(before.toArray(), [1, 2]);
assert.deepEqual(after.toArray(), [1, 2, 3]);
`;
  writeFileSync(join(temporary, 'smoke.mjs'), smoke);
  run(process.execPath, ['smoke.mjs']);
  run('bun', ['smoke.mjs']);

  // Reuse the real shared-memory worker proof through the installed package.
  const workerProof = readFileSync(join(root, 'proofs/node-worker.mjs'), 'utf8').replace("'../dist/shared.js'", "'zerocopy'");
  writeFileSync(join(temporary, 'worker.mjs'), workerProof);
  run(process.execPath, ['worker.mjs']);

  const consumer = join(temporary, 'consumer.ts');
  writeFileSync(consumer, imports.map((name, index) => `import * as entry${index} from ${JSON.stringify(name)}; void entry${index};`).join('\n') + "\nimport { SharedList } from 'zerocopy';\nconst list: SharedList<'number'> = new SharedList('number');\nconst value: number | undefined = list.get(0);\n");
  const program = ts.createProgram([consumer], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: false, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => temporary, getNewLine: () => '\n',
  }));
  console.log(`Package ${archive.name}@${archive.version}: ${paths.size} files, ${archive.size} bytes. Node/Bun exports, immutable snapshots, Node worker sharing, and TypeScript consumer passed.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
