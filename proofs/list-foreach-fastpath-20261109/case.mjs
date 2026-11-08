import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const name = process.argv[2];
const configs = {
  'number-256': ['number', 256],
  'number-32768': ['number', 32768],
  'boolean-256': ['boolean', 256],
  'boolean-32768': ['boolean', 32768],
  'string-4096': ['string', 4096],
  'object-2048': ['object', 2048],
};
if (!(name in configs)) throw new Error('Unknown workload: ' + name);
const [type, size] = configs[name];
const entry = resolve(process.cwd(), 'dist/shared.js');
const { SharedList } = await import(pathToFileURL(entry).href);
const values = Array.from({ length: size }, (_, i) =>
  type === 'number' ? (i % 97) / 4 : type === 'boolean' ? (i & 1) === 0
  : type === 'string' ? 'value-' + (i % 29) : { n: i % 31 });
const list = new SharedList(type).pushMany(values);
if (list.size !== size) throw new Error('incorrect list size');
const materialized = list.toArray();
for (let i = 0; i < size; i++) {
  if (type === 'object' ? materialized[i].n !== values[i].n : !Object.is(materialized[i], values[i]))
    throw new Error('incorrect list content at ' + i);
}

let sum = 0;
const callback = type === 'number' ? (v, i) => { sum += v * 4 + (i & 7); }
  : type === 'boolean' ? (v, i) => { sum += (v ? 19 : 0) + (i & 7); }
  : type === 'string' ? (v, i) => { sum += v.length + (i & 7); }
  : (v, i) => { sum += v.n + (i & 7); };

list.forEach(callback);
const expected = sum;
if (!Number.isSafeInteger(expected)) throw new Error('invalid checksum');
function execute(repeats) {
  let all = 0;
  for (let i = 0; i < repeats; i++) {
    sum = 0;
    list.forEach(callback);
    all += sum;
  }
  return all;
}
function timed(repeats) {
  const start = performance.now();
  const checksum = execute(repeats);
  const duration = performance.now() - start;
  if (checksum !== expected * repeats) throw new Error('incomplete iteration: ' + name);
  return duration;
}
// Warm the same callback and collection, but never include construction,
// serialization, verification or process startup in the timed comparison.
const warmEnd = performance.now() + 250;
while (performance.now() < warmEnd) {
  const checksum = execute(2);
  if (checksum !== expected * 2) throw new Error('invalid warmup');
}
let repeats = 1;
while (repeats < 16384 && timed(repeats) < 18) repeats *= 2;
const samplesUs = [];
for (let i = 0; i < 9; i++) samplesUs.push((timed(repeats) * 1000) / repeats);
function median(a) {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}
console.log(JSON.stringify({
  case: name, runtime: process.versions.bun ? 'bun' : 'node',
  runtimeVersion: process.versions.bun || process.version,
  sourceSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  size, repeats, checksum: expected, samplesUs, estimateUs: median(samplesUs),
}));
