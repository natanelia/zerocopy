/** Compare the PR against its actual base, not an external library or old release.
 * Run from the repository root after building WASM in both working trees.
 * The script never uses a faster algorithm in the candidate-only workload.
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const baseRoot = resolve(root, '.primitive-baseline');
const [baseline, candidate] = await Promise.all(
  [baseRoot, root].map(async dir => import(pathToFileURL(resolve(dir, 'shared.ts')).href))
);
const n = 32769, shortN = 8193;
const numbers = Array.from({ length: n }, (_, i) => i + 0.5);
const flags = Array.from({ length: n }, (_, i) => i % 3 === 0);
const strings = Array.from({ length: shortN }, (_, i) => `key-${i}`);
const numericSum = numbers.reduce((s, v) => s + v, 0);
const shortSum = (shortN - 1) * shortN / 2;

function prepare(module) {
  const list = new module.SharedList('number').pushMany(numbers);
  const bools = new module.SharedList('boolean').pushMany(flags);
  const text = new module.SharedList('string').pushMany(strings);
  let linked = new module.SharedLinkedList('number');
  let doubly = new module.SharedDoublyLinkedList('number');
  for (let i = 0; i < shortN; i++) { linked = linked.append(i); doubly = doubly.append(i); }
  return { list, bools, text, linked, doubly };
}

const source = [prepare(baseline), prepare(candidate)];
const cases = [
  { name: 'SharedList<number>.forEach', count: n, repeat: 4,
    run: x => { let s = 0; x.list.forEach(v => { s += v; }); return s; }, expected: numericSum },
  { name: 'SharedList<number>.toArray', count: n, repeat: 4,
    run: x => { const a = x.list.toArray(); return a.length + a[0] + a[a.length - 1]; },
    expected: n + numbers[0] + numbers[n - 1] },
  { name: 'SharedList<number>.values', count: n, repeat: 4,
    run: x => { let s = 0; for (const v of x.list.values()) s += v; return s; }, expected: numericSum },
  { name: 'SharedList<boolean>.forEach', count: n, repeat: 4,
    run: x => { let s = 0; x.bools.forEach(v => { s += Number(v); }); return s; },
    expected: flags.filter(Boolean).length },
  { name: 'SharedList<string>.values', count: shortN, repeat: 4,
    run: x => { let s = 0; for (const v of x.text.values()) s += v.length; return s; },
    expected: strings.reduce((s, v) => s + v.length, 0) },
  { name: 'SharedLinkedList<number>.forEach', count: shortN, repeat: 4,
    run: x => { let s = 0; x.linked.forEach(v => { s += v; }); return s; }, expected: shortSum },
  { name: 'SharedDoublyLinkedList<number>.forEach', count: shortN, repeat: 4,
    run: x => { let s = 0; x.doubly.forEach(v => { s += v; }); return s; }, expected: shortSum },
  { name: 'SharedDoublyLinkedList<number>.forEachReverse', count: shortN, repeat: 4,
    run: x => { let s = 0; x.doubly.forEachReverse(v => { s += v; }); return s; }, expected: shortSum }
];

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = [];
let sink = 0;
for (const item of cases) {
  const samples = [[], []];
  function run(which) {
    let result = 0;
    const start = performance.now();
    for (let iteration = 0; iteration < item.repeat; iteration++) result = item.run(source[which]);
    const time = performance.now() - start;
    assert.equal(result, item.expected, `${item.name} output changed in ${which ? 'candidate' : 'baseline'}`);
    sink += result;
    return time;
  }
  for (let i = 0; i < 8; i++) { run(i % 2); run((i + 1) % 2); }
  for (let round = 0; round < 15; round++) {
    const first = round % 2, second = 1 - first;
    samples[first].push(run(first)); samples[second].push(run(second));
  }
  const beforeMs = median(samples[0]), afterMs = median(samples[1]);
  rows.push({ name: item.name, count: item.count, repeat: item.repeat,
    baselineMedianMs: beforeMs, candidateMedianMs: afterMs, speedup: beforeMs / afterMs,
    baselineSamplesMs: samples[0], candidateSamplesMs: samples[1] });
  console.log(`${item.name}: base ${beforeMs.toFixed(3)}ms, candidate ${afterMs.toFixed(3)}ms, ${(beforeMs / afterMs).toFixed(2)}x`);
}
const output = resolve(root, 'proofs/results/primitive-scan-comparison.json');
mkdirSync(resolve(root, 'proofs/results'), { recursive: true });
writeFileSync(output, JSON.stringify({
  baseline: process.env.BASE_SHA ?? 'PR base', candidate: process.env.GITHUB_SHA ?? 'PR head',
  bunVersion: typeof Bun === 'undefined' ? 'unknown' : Bun.version, sink, rows
}, null, 2) + '\n');
