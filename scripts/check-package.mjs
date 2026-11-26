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
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|website|proofs|scripts|rust|\.github)\//, path);
    assert.doesNotMatch(path, /(?:\.test\.ts|\.as\.ts|\.wat|\.tgz)$|^tsconfig.*\.json$|^rust-toolchain\.toml$/, path);
  }
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, archive.filename)]);

  const imports = Object.keys(pkg.exports).map(path => path === '.' ? pkg.name : pkg.name + path.slice(1));
  const smoke = `import assert from 'node:assert/strict';
import { SharedList } from 'zerocopy';
import { buildSpatialIndex, applySpatialEdits, prepareSpatialQuery, querySpatialIndex, rebuildSpatialIndex } from 'zerocopy/spatial';
const base = buildSpatialIndex([{ id: 7, bounds: [0, 0, 2, 3] }]);
const edits = applySpatialEdits(undefined, 1, [{ id: 7, bounds: null }]);
assert.deepEqual(querySpatialIndex(base, [0, 0, 2, 3]), [7]);
assert.deepEqual(querySpatialIndex(base, [0, 0, 2, 3], edits), []);
assert.deepEqual(querySpatialIndex(rebuildSpatialIndex(base, edits, 1), [0, 0, 2, 3]), []);
assert.deepEqual(querySpatialIndex(structuredClone(prepareSpatialQuery(base, edits, 1)), [0, 0, 2, 3]), []);
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

  writeFileSync(join(temporary, 'spatial-reader.mjs'), `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildSpatialIndex, applySpatialEdits, prepareSpatialQuery, querySpatialIndex } from 'zerocopy/spatial';
const box = [0, 0, 1, 1];
if (isMainThread) {
  const base = buildSpatialIndex([{ id: 7, bounds: box }]);
  const edits = applySpatialEdits(undefined, 1, [{ id: 7, bounds: null }, { id: 19, bounds: box }]);
  const reader = new Worker(new URL(import.meta.url), { workerData: prepareSpatialQuery(base, edits, 1) });
  try { assert.deepEqual(await once(reader, 'message'), [[19]]); }
  finally { await reader.terminate(); }
} else parentPort.postMessage(querySpatialIndex(workerData, box));
`);
  run(process.execPath, ['spatial-reader.mjs']);

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
  // Exercise both transaction APIs with the published archive and real npm peer resolution.
  writeFileSync(join(temporary, 'tanstack-peer.mjs'), `
import assert from 'node:assert/strict';
import { BTreeIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { sharedCollectionConfig, viewportCollectionConfig } from 'zerocopy/tanstack';
const options = sharedCollectionConfig({ id: 'lanes', initialData: [{ id: 'n', handle: 2, style: { width: 2 } }] });
const lanes = createCollection(options);
lanes.createIndex(row => row.handle, { indexType: BTreeIndex });
const viewport = createCollection(viewportCollectionConfig({ id: 'visible' }));
const joined = createLiveQueryCollection(q => q.from({ hit: viewport })
  .innerJoin({ lane: lanes }, ({ hit, lane }) => eq(hit.id, lane.handle))
  .select(({ lane }) => ({ id: lane.id, style: lane.style })));
const settled = process.argv[2] === '0.5.0'
  ? tx => tx.isPersisted.promise
  : tx => tx.when('settled');
try {
  await joined.preload();
  await viewport.utils.setVisibleIds([1, 2]);
  await viewport.utils.setVisibleIds(Promise.resolve([2, 3]));
  assert.deepEqual([...viewport.keys()].sort(), [2, 3]);
  assert.equal([...joined.values()][0].id, 'n');
  const initial = options.getSnapshot();
  await settled(lanes.update('n', draft => { draft.style.width = 4; }));
  await settled(lanes.update('n', draft => { draft.style.width = 6; }));
  assert.equal(initial.get('n').style.width, 2);
  assert.equal(options.getSnapshot().get('n').style.width, 6);
  assert.equal([...joined.values()][0].style.width, 6);
  await settled(lanes.delete('n'));
  assert.equal(options.getSnapshot().size, 0);
  assert.equal(joined.size, 0);
} finally { await joined.cleanup(); await viewport.cleanup(); await lanes.cleanup(); }
`);
  const peers = ['0.5.0', pkg.devDependencies['@tanstack/db']];
  for (const version of peers) {
    run('npm', ['install', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '@tanstack/db@' + version]);
    run(process.execPath, ['tanstack-peer.mjs', version]);
  }
  console.log(`Package ${archive.name}@${archive.version}: ${paths.size} files, ${archive.size} bytes. Node/Bun exports, immutable snapshots, Node worker sharing, TypeScript consumer, and TanStack DB ${peers.join(' and ')} passed.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
