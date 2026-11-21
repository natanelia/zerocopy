import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = fileURLToPath(import.meta.url);
const widths = [8, 256, 4096];
const cases = [...widths.map(n => 'flat-' + n), 'nested', 'quoted-bracket', 'late-field', 'unique-field'];
function makeRow(name, row) {
  const width = Number(name.slice(5));
  if (name.startsWith('flat-')) return Object.fromEntries(Array.from({ length: width }, (_, i) => ['attr' + i, row + i]));
  if (name === 'late-field') return { description: 'x'.repeat(8192), state: row };
  if (name === 'unique-field') return { ['column' + row]: row };
  const flat = { id: row, title: 'row ' + row, price: 23 + row % 97, stock: row % 17 };
  return name === 'nested' ? { ...flat, dimensions: [row, 3], stock: { quantity: row % 17 } } : { ...flat, title: '[row]' };
}
function checkFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value));
  for (const child of Object.values(value)) checkFrozen(child);
}
function query(map, keys, name) {
  if (name === 'late-field') return keys.map(key => map.getView(key).get('state'));
  if (name === 'unique-field') return keys.map((key, row) => map.getView(key).get('column' + row));
  return keys.map(key => map.get(key));
}

if (process.argv[2] === '--sample') {
  const [dir, rotation] = process.argv.slice(3);
  const api = await import(pathToFileURL(resolve(dir, 'dist/shared.js')));
  const result = {};
  for (let c = 0; c < cases.length; c++) {
    const name = cases[(c + Number(rotation)) % cases.length];
    const count = name === 'flat-4096' ? 32 : name === 'flat-256' || name === 'late-field' ? 256 : 1024;
    const keys = Array.from({ length: count }, (_, i) => 'item/' + i);
    const rows = keys.map((_, i) => makeRow(name, i));
    api.resetMap();
    const owner = new api.SharedMap('object').setMany(keys.map((key, i) => [key, rows[i]]));
    const payload = api.getWorkerData({ map: owner }, { copy: false });
    const isView = name === 'late-field' || name === 'unique-field';
    const reference = isView ? keys.map((_, i) => i) : rows;
    const samples = [];
    for (let j = -3; j < 7; j++) {
      const { map } = await api.initWorker(payload);
      let start = performance.now();
      const first = query(map, keys, name);
      const firstMs = performance.now() - start;
      start = performance.now();
      const repeat = isView ? query(map, keys, name) : undefined;
      const repeatMs = repeat ? performance.now() - start : undefined;
      assert.deepEqual(first, reference);
      if (repeat) assert.deepEqual(repeat, reference);
      else for (const value of first) checkFrozen(value);
      samples.push({ warmup: j < 0, firstMs, repeatMs });
    }
    result[name] = { count, samples };
  }
  process.stdout.write(JSON.stringify(result));
} else {
  const [baseline, candidate, output, pairsArg = '9'] = process.argv.slice(2);
  const pairs = Number(pairsArg);
  assert(baseline && candidate && output && Number.isInteger(pairs) && pairs > 0);
  const hash = data => createHash('sha256').update(data).digest('hex');
  const report = { node: process.version, cpu: cpus()[0].model, os: release(), pairs, cases,
    driverSha256: hash(readFileSync(file)), builds: {}, samples: [] };
  for (const [label, dir] of Object.entries({ baseline, candidate })) {
    const cwd = resolve(dir), build = resolve(cwd, 'dist');
    report.builds[label] = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
      bundles: Object.fromEntries(readdirSync(build).filter(f => f.endsWith('.js')).sort().map(f => [f, hash(readFileSync(resolve(build, f)))])),
      wasm: hash(readFileSync(resolve(cwd, 'persistent-core.wasm'))),
    };
  }
  assert.equal(report.builds.baseline.wasm, report.builds.candidate.wasm);
  writeFileSync(output, '', { flag: 'wx' });
  for (let pair = 0; pair < pairs; pair++) {
    for (const label of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const dir = label === 'candidate' ? candidate : baseline;
      const data = execFileSync(process.execPath, [file, '--sample', dir, String(pair)], { encoding: 'utf8' });
      report.samples.push({ pair, label, cases: JSON.parse(data) });
    }
    writeFileSync(output, JSON.stringify(report));
    console.log('Finished pair', pair + 1, 'of', pairs);
  }
}
