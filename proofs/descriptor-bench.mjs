import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

// Compare actual revisions, not a hand-copied approximation of the old parser.
// Run after installing dependencies: node proofs/descriptor-bench.mjs <base-sha>
// Timings are diagnostic; correctness tests must never depend on CPU speed.
const baseline = process.argv[2] ?? '92fbbff480365efc417dbb1ffb5d3b2188a18575';
if (!/^[0-9a-f]{7,40}$/.test(baseline)) throw new Error('Expected a baseline commit SHA');
const beforeSource = execFileSync('git', ['show', `${baseline}:types.ts`], { encoding: 'utf8' });
const afterSource = await readFile(new URL('../types.ts', import.meta.url), 'utf8');
async function load(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const before = await load(beforeSource), after = await load(afterSource);
const nested = 'SharedMap<SharedList<object>>';
const deep = `${'SharedList<'.repeat(32)}object${'>'.repeat(32)}`;
const cases = [
  ['primitive classification', api => api.parseNestedType('object'), null, 500000],
  ['nested classification', api => api.parseNestedType(nested)?.innerType, 'SharedList<object>', 200000],
  ['compose shallow', api => api.list('object'), 'SharedList<object>', 100000],
  ['compose depth 32', api => api.map(deep), `SharedMap<${deep}>`, 10000],
];
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(`Node ${process.version}; baseline ${baseline}; median of 7 interleaved rounds`);
console.log('This measures descriptor handling only, not end-to-end collection/JSON throughput.');
for (const [name, operation, expected, count] of cases) {
  for (const api of [before, after]) {
    assert.deepEqual(operation(api), expected);
    for (let i = 0; i < 10000; i++) operation(api);
  }
  const samples = [[], []];
  for (let round = 0; round < 7; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const api = [before, after][index], start = performance.now();
      let result;
      for (let i = 0; i < count; i++) result = operation(api);
      const elapsed = performance.now() - start;
      assert.deepEqual(result, expected);
      samples[index].push(elapsed * 1e6 / count);
    }
  }
  const oldNs = median(samples[0]), newNs = median(samples[1]);
  console.log(`${name}: ${oldNs.toFixed(1)} -> ${newNs.toFixed(1)} ns/op (${(oldNs / newNs).toFixed(2)}x)`);
}
