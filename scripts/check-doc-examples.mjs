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
  ['README.md', 'map-snapshots', "assert.equal(before.get('lane-1'), 30); assert.equal(after.get('lane-1'), 50); assert.notEqual(before, after);"],
  ['docs/api.md', 'ordered-map', "assert.deepEqual([...labels.keys()], ['c', 'a', 'b']);"],
  ['docs/api.md', 'sorted-map', "assert.deepEqual([...reverse.keys()], ['c', 'b', 'a']);"],
  ['docs/api.md', 'sets', "assert.equal(tags.has('admin'), true); assert.deepEqual([...insertionOrder.values()], ['z', 'a', 'm']); assert.deepEqual([...sorted.values()], ['a', 'm', 'z']);"],
  ['docs/api.md', 'sequences', "assert.equal(list.get(0), 1); assert.equal(stack.peek(), 2); assert.equal(queue.peek(), 'first'); assert.equal(remaining.peek(), 'second');"],
  ['docs/api.md', 'linked-lists', "assert.deepEqual(numbers.toArray(), [0, 1, 2]); assert.deepEqual(letters.toArrayReverse(), ['c', 'b', 'a']);"],
  ['docs/api.md', 'priority-queues', "assert.equal(pending.peek(), 'high'); assert.equal(pending.peekPriority(), 1); assert.equal(largest.peek(), 30);"],
  ['docs/api.md', 'nested-collections', "assert.equal(users.get('user-1').has('admin'), true); assert.equal(records.get(0).get('x'), 10); assert.equal(nested.size, 0); assert.equal(stack.size, 0); assert.equal(queue.size, 0);"],
  ['docs/architecture.md', 'compaction', "assert.equal(original.get('lane-1'), 30); assert.equal(owned.get('lane-1'), 30); assert.equal(group.updated.get('lane-1'), 50); assert.notEqual(original, owned);"],
  ['docs/tanstack.md', 'shared-collection', "assert.equal(before.get('1').name, 'Alice'); assert.equal(after.get('1').name, 'Alicia');"],
  ['docs/redux.md', 'redux-store', "const previous = store.getState(); store.dispatch(mapSlice.actions.speedChanged({ id: 'lane-1', speed: 30 })); assert.equal(previous.map.speedLimits.get('lane-1'), undefined); assert.equal(store.getState().map.speedLimits.get('lane-1'), 30); const unchanged = store.getState(); store.dispatch(mapSlice.actions.speedChanged({ id: 'lane-1', speed: 30 })); assert.equal(store.getState(), unchanged);"],
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
  assert.equal(output.trim(), '30', 'Node worker example returned the wrong value');
  console.log('Passed: documented Node owner/worker pair.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
