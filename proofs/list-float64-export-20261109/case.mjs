import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mode = process.argv[2], size = Number(process.argv[3]);
if (!['before','after'].includes(mode) || ![32,1024,65536,262144].includes(size))
  throw new Error('Pass before|after and an approved list size');
const entry = resolve(process.cwd(), 'dist/shared.js');
const { SharedList } = await import(pathToFileURL(entry).href);
const values = Array.from({ length: size }, (_, i) => ((i * 37) % 1021) / 4);
values[0] = -0;
values[size - 1] = NaN;
const list = new SharedList('number').pushMany(values);
if (list.size !== size) throw new Error('Incorrect fixture size');
const make = mode === 'before'
  ? () => new Float64Array(list.toArray())
  : () => list.toFloat64Array();
const indexes = [0, size >>> 1, size - 2, size - 1];
function verify(out) {
  if (!(out instanceof Float64Array) || out.length !== size) throw new Error('Wrong typed-array result');
  for (let i = 0; i < size; i++) if (!Object.is(out[i], values[i]))
    throw new Error(mode + ' mismatch at ' + i + ': ' + out[i] + ' != ' + values[i]);
}
verify(make());
function run(repeats) {
  let out, check = 0;
  for (let i = 0; i < repeats; i++) {
    out = make();
    check += out[indexes[0]] + out[indexes[1]] + out[indexes[2]];
  }
  return [out,check];
}
const checkExpected = (values[indexes[0]] + values[indexes[1]] + values[indexes[2]]);
function timed(repeats) {
  const start = performance.now(), [out, check] = run(repeats);
  const elapsed = performance.now() - start;
  if (!Object.is(check, checkExpected * repeats)) throw new Error('Workload not consumed');
  verify(out); // exhaustive check is outside the timer
  return elapsed;
}
const warmEnd = performance.now() + 250;
while (performance.now() < warmEnd) timed(2);
let repeats = 1;
while (repeats < 16384 && timed(repeats) < 18) repeats *= 2;
const samplesUs = [];
for (let i = 0; i < 9; i++) samplesUs.push(timed(repeats) * 1000 / repeats);
const median = arr => [...arr].sort((a,b)=>a-b)[Math.floor(arr.length / 2)];
console.log(JSON.stringify({
  mode, size, runtime: process.versions.bun ? 'bun' : 'node',
  runtimeVersion: process.versions.bun || process.version,
  sourceSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  repeats, checksum: checkExpected, estimateUs: median(samplesUs), samplesUs,
}));
