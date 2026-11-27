import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { browserExamples, extract } from './doc-examples.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(root, '.docs-examples-'));

// Expected results belong here; the code under test comes from the reader's example.
const cases = [
  ['docs/tanstack.md', 'upstream-confirmed', `
let feed;
const { roads, mirror, session } = openRoads({ sync(p) { feed = p; p.markReady(); } });
try {
  await roads.preload();
  feed.begin(); feed.write({ type: 'insert', value: { id: 'a', revision: 1 } });
  assert.equal(mirror.getSnapshot().size, 0);
  await feed.commit();
  assert.equal(session.current.get('a').revision, 1);
  const first = mirror.getSnapshot();
  feed.begin({ snapshot: true }); await feed.commit();
  assert.equal(session.current.size, 0); assert.equal(first.size, 1);
} finally { session.dispose(); await roads.cleanup(); }`],
  ['docs/tanstack.md', 'tanstack-confirmed-source', `
const { connectSharedSession } = await import('zerocopy/worker');
const { port1, port2 } = new MessageChannel();
const receiving = connectSharedSession({ endpoint: port2 });
const { lanes, session } = await shareLanes(port1);
const reader = await receiving;
try {
  const first = reader.current;
  const snapshots = reader.snapshots({ emitCurrent: false });
  await lanes.update('north', lane => { lane.revision = 1; }).when('settled');
  const { value: current } = await snapshots.next();
  assert.deepEqual([...current.changesSince(first)], [{ type: 'update', key: 'north',
    before: { id: 'north', revision: 0 }, after: { id: 'north', revision: 1 } }]);
  await snapshots.return();
} finally { reader.dispose(); session.dispose(); port1.close(); port2.close(); await lanes.cleanup(); }`],
  ['docs/api.md', 'map-changes', "assert.deepEqual(changes.sort((a, b) => a.key.localeCompare(b.key)), [{ type: 'update', key: 'lane-7', before: 40, after: 50 }, { type: 'insert', key: 'lane-9', before: undefined, after: 30 }]);"],
  ['docs/spatial.md', 'spatial-viewport-edits', "assert.deepEqual(delta, { added: [7], removed: [9] });"],
  ['docs/spatial.md', 'spatial-query-cursor', "assert.deepEqual([before, after, visible, cursor.revision], [[7], [], [7], 1]);"],
  ['docs/geometry.md', 'stream-lane-tile', `
const { encodeTile } = await import('../proofs/spatial-editor/tile-io.mjs');
const { getLineStringById } = await import('zerocopy/spatial');
const url = 'data:application/vnd.apache.arrow.stream;base64,' + Buffer.from(encodeTile(128, 8, 'sparse')).toString('base64');
const signal = new AbortController().signal;
const { index, lookup } = await openLaneTile(url, 128, signal);
assert.equal(index.ids.length, 128);
assert.equal(getLineStringById(lookup, 0xffffffff).length, 16);
assert.equal(getLineStringById(lookup, 9), undefined);
await assert.rejects(openLaneTile(url, 129, signal), /Incomplete tile/);
await assert.rejects(openLaneTile(url, 128, AbortSignal.abort()), { name: 'AbortError' });`],
  ['README.md', 'map-snapshots', "assert.equal(before.size, 1); assert.equal(after.size, 2); assert.equal(after.get(1), 'Upstream timeout'); assert.notEqual(before, after);"],
  ['website/content/log-explorer.md', 'log-columns', "assert.equal(before.message.get(1), 'Upstream timeout'); assert.equal(before.message.size, 2); assert.equal(next.message.size, 3); assert.equal(next.level.size, next.message.size);"],
  ['website/content/catalog.md', 'catalog-snapshots', "assert.equal(initial.get('product/000000').attributes.priceCents, 0); assert.equal(current.get('product/000000').attributes.priceCents, 2500); assert.equal(initial.get('product/000000').status, 'available'); assert.equal(current.get('product/000000').status, 'unavailable'); assert(Object.isFrozen(current.get('product/000000').attributes)); assert(message.arenas.every(arena => !arena.copy && arena.memory.buffer instanceof SharedArrayBuffer));"],
  ['docs/api.md', 'typed-json', "assert.equal(before.get(product.id).stock, 12); assert.equal(restored.products.get(product.id).stock, 0); assert.equal(restored.categories.get('electronics').get(0).category, 'electronics'); assert(Object.isFrozen(restored.products.get(product.id).variants[0].sizes));"],
  ['docs/api.md', 'json-view', "assert.equal(product.get('stock'), 12); assert(product.equals('name', 'Wireless headphones')); assert.equal(product.has('missing'), false); assert(details instanceof JsonView); assert.equal(details.get('color'), 'black'); assert.equal(rows.getView(0).at(1), 20); assert.equal(editable.stock, 0); assert.equal(Object.isFrozen(editable), false); assert(Object.isFrozen(product.toObject({ freeze: true }).details));"],
  ['docs/api.md', 'ordered-map', "assert.deepEqual([...labels.keys()], ['c', 'a', 'b']);"],
  ['docs/api.md', 'sorted-map', "assert.deepEqual([...reverse.keys()], ['c', 'b', 'a']);"],
  ['docs/api.md', 'sets', "assert.equal(tags.has('admin'), true); assert.deepEqual([...insertionOrder.values()], ['z', 'a', 'm']); assert.deepEqual([...sorted.values()], ['a', 'm', 'z']);"],
  ['docs/api.md', 'sequences', "assert.equal(list.get(0), 1); assert.equal(stack.peek(), 2); assert.equal(queue.peek(), 'first'); assert.equal(remaining.peek(), 'second');"],
  ['docs/api.md', 'linked-lists', "assert.deepEqual(numbers.toArray(), [0, 1, 2]); assert.deepEqual(letters.toArrayReverse(), ['c', 'b', 'a']);"],
  ['docs/api.md', 'priority-queues', "assert.equal(pending.peek(), 'high'); assert.equal(pending.peekPriority(), 1); assert.equal(largest.peek(), 30);"],
  ['docs/api.md', 'nested-collections', "assert.equal(users.get('user-1').has('admin'), true); assert.equal(records.get(0).get('x'), 10); assert.equal(nested.size, 0); assert.equal(stack.size, 0); assert.equal(queue.size, 0);"],
  ['docs/architecture.md', 'compaction', "assert.equal(original.get('headphones'), 12); assert.equal(owned.get('headphones'), 12); assert.equal(group.updated.get('headphones'), 0); assert.notEqual(original, owned);"],
  ['docs/tanstack.md', 'shared-collection', "assert.equal(before.get('1').name, 'Alice'); assert.equal(after.get('1').name, 'Alicia');"],
  ['docs/redux.md', 'redux-store', "const previous = store.getState(); store.dispatch(catalogSlice.actions.stockChanged({ id: 'headphones', quantity: 12 })); assert.equal(previous.catalog.stock.get('headphones'), undefined); assert.equal(store.getState().catalog.stock.get('headphones'), 12); const unchanged = store.getState(); store.dispatch(catalogSlice.actions.stockChanged({ id: 'headphones', quantity: 12 })); assert.equal(store.getState(), unchanged);"],
];

try {
  const files = [], runnable = [];
  for (const [file, name, checks] of cases) {
    const source = extract(file, name, 'ts');
    const path = join(temporary, `${name}.ts`);
    writeFileSync(path, source); files.push(path);
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const executable = join(temporary, `${name}.mjs`);
    writeFileSync(executable, `import assert from 'node:assert/strict';\n${js}\n${checks}\n`);
    runnable.push([name, executable]);
  }
  for (const example of browserExamples) {
    for (const name of [example.owner, example.reader]) {
      const path = join(temporary, `${name}.ts`);
      writeFileSync(path, extract(example.file, name, 'ts')); files.push(path);
    }
  }
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  console.log(`Type-checked ${files.length} Markdown examples against built package declarations.`);
  for (const [name, executable] of runnable) {
    execFileSync(process.execPath, [executable], { cwd: root, encoding: 'utf8', timeout: 30000 });
    console.log(`Passed: ${name}`);
  }
  writeFileSync(join(temporary, 'main.mjs'), extract('docs/worker-sharing.md', 'node-owner', 'js'));
  writeFileSync(join(temporary, 'worker.mjs'), extract('docs/worker-sharing.md', 'node-reader', 'js'));
  const output = execFileSync(process.execPath, [join(temporary, 'main.mjs')], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(output.trim(), '12', 'Node worker example returned the wrong value');
  console.log('Passed: documented Node owner/worker pair.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
