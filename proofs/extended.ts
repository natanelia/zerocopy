import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.ENGINE_ROOT ?? import.meta.dirname + '/..');
const S = await import(pathToFileURL(resolve(root, 'shared.ts')).href);
(await import(pathToFileURL(resolve(root, 'shared-map.ts')).href)).configureAutoGC({ enabled: false });
const samples = Number(process.env.SAMPLES ?? 15), only = process.env.ONLY;
const keys = Array.from({ length: 1024 }, (_, i) => `key/${i.toString().padStart(6, '0')}`);
const rows: any[] = [];
function measure(name: string, prepare: () => any, run: (input: any) => any, check: (value: any) => void) {
  if (only && only !== name) return;
  const times: number[] = [];
  for (let i = -20; i < samples; i++) {
    const input = prepare(), start = performance.now(), value = run(input), end = performance.now();
    check(value); if (i >= 0) times.push(end - start);
  }
  rows.push({ name, samplesMs: times, medianMs: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] });
}
for (const kind of ['ordered', 'sorted']) {
  const C = kind === 'ordered' ? S.SharedOrderedMap : S.SharedSortedMap;
  const reset = kind === 'ordered' ? S.resetOrderedMap : S.resetSortedMap;
  measure(`${kind}.write+scan`, () => { reset(); return new C('number'); }, map => {
    for (let i = 0; i < keys.length; i++) map = map.set(keys[i], i);
    return [...map.entries()];
  }, entries => assert.deepEqual(entries, keys.map((k, i) => [k, i])));
}
const prefixed = keys.slice(0, 512).map(k => 'shared-prefix/'.repeat(20) + k);
measure('sorted.longPrefix+scan', () => { S.resetSortedMap(); return new S.SharedSortedMap('number'); }, map => {
  for (let i = 0; i < prefixed.length; i++) map = map.set(prefixed[i], i);
  return [...map.entries()];
}, entries => assert.deepEqual(entries, prefixed.map((k, i) => [k, i])));
measure('map.coldGetAfterBulk', () => {
  S.resetMap(); return new S.SharedMap('number').setMany(keys.map((k, i) => [k, i]));
}, map => keys.map(k => map.get(k)), values => assert.deepEqual(values, keys.map((_, i) => i)));
measure('map.objectWrite+read', () => { S.resetMap(); return new S.SharedMap('object'); }, map => {
  for (let i = 0; i < 512; i++) map = map.set(keys[i], { i, position: { x: i, y: -i }, label: 'lane'.repeat(8) });
  return keys.slice(0, 512).map(k => map.get(k));
}, values => assert.deepEqual(values, keys.slice(0, 512).map((_, i) => ({ i, position: { x: i, y: i === 0 ? 0 : -i }, label: 'lane'.repeat(8) }))));
measure('queue.fullCycle', () => { S.resetQueue(); return new S.SharedQueue('number'); }, queue => {
  for (let i = 0; i < 4096; i++) queue = queue.enqueue(i);
  const values = []; while (queue.size) { values.push(queue.peek()); queue = queue.dequeue(); } return values;
}, values => assert.deepEqual(values, Array.from({ length: 4096 }, (_, i) => i)));
console.log(JSON.stringify({ label: process.env.LABEL, runtime: process.versions, samples, warmups: 20, fullResultValidation: true, rows }));
