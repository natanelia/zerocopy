import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The matrix and repetitions are fixed before the confirmation run. Timings
// measure complete public scans, including callbacks. Fixture setup, oracle
// validation and assertions are outside the timed region.
const cases = {
  'number-4096': { size: 4096, type: 'number', repeats: 48 },
  'number-64': { size: 64, type: 'number', repeats: 2048 },
  'boolean-4096': { size: 4096, type: 'boolean', repeats: 48 },
  'string-1024': { size: 1024, type: 'string', repeats: 128 },
  'json-256': { size: 256, type: 'object', repeats: 512 },
  'empty': { size: 0, type: 'number', repeats: 32768 },
  'custom-1024': { size: 1024, type: 'number', repeats: 64, comparator: true },
  'entries-4096': { size: 4096, type: 'number', repeats: 32, entries: true },
};

async function subject(modulePath, name) {
  const { SharedSortedMap, resetSortedMap } = await import(pathToFileURL(modulePath));
  const spec = cases[name]; assert.ok(spec, `Unknown case ${name}`);
  const descending = (a, b) => a === b ? 0 : a < b ? 1 : -1;
  resetSortedMap();
  let map = new SharedSortedMap(spec.type, spec.comparator ? descending : undefined);
  const native = new Map();
  for (let i = 0; i < spec.size; i++) {
    const id = (i * 17) % spec.size, key = `row/${String(id).padStart(6, '0')}`;
    const value = spec.type === 'number' ? id * 0.5 : spec.type === 'boolean' ? !!(id % 2)
      : spec.type === 'string' ? `name/${id}/🙂` : { id, label: `record-${id}`, child: { value: id * 3 } };
    map = map.set(key, value); native.set(key, value);
  }
  const expected = [...native].sort(([a], [b]) => spec.comparator ? descending(a, b) : Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const collect = () => { const output = []; map.forEach((value, key) => output.push([key, value])); return output; };
  assert.deepEqual(collect(), expected);
  assert.deepEqual([...map.entries()], expected);
  const magnitude = value => spec.type === 'number' ? value : spec.type === 'boolean' ? +value : spec.type === 'string' ? value.length : value.id;
  const expectedSum = expected.reduce((sum, [key, value]) => sum + magnitude(value) + key.length, 0);
  let sum = 0, count = 0;
  const visit = spec.type === 'number' ? (value, key) => { count++; sum += value + key.length; }
    : spec.type === 'boolean' ? (value, key) => { count++; sum += +value + key.length; }
    : spec.type === 'string' ? (value, key) => { count++; sum += value.length + key.length; }
    : (value, key) => { count++; sum += value.id + key.length; };
  const run = spec.entries ? () => { for (const [key, value] of map.entries()) visit(value, key); } : () => map.forEach(visit);
  function batch() {
    sum = 0; count = 0;
    const start = performance.now();
    for (let i = 0; i < spec.repeats; i++) run();
    const elapsed = performance.now() - start;
    assert.equal(sum, expectedSum * spec.repeats); assert.equal(count, spec.size * spec.repeats);
    return elapsed / spec.repeats;
  }
  let warmupMilliseconds = 0, warmupBatches = 0;
  while (warmupMilliseconds < 250 || warmupBatches < 8) { warmupMilliseconds += batch() * spec.repeats; warmupBatches++; }
  const samplesMs = Array.from({ length: 9 }, () => batch());
  assert.deepEqual(collect(), expected);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { name, runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`, spec, warmupMilliseconds, warmupBatches, samplesMs, medianMs: sorted[4], checksum: sum, count, validated: true };
}

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function identity(path) {
  const rootSources = readdirSync(path).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  const sourceNames = [...rootSources, 'package.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs'].sort();
  const wasmNames = readdirSync(path).filter(name => name.endsWith('.wasm')).sort();
  const bundleNames = readdirSync(join(path, 'dist')).filter(name => name.endsWith('.js')).sort();
  const git = spawnSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); assert.equal(git.status, 0);
  return { commit: git.stdout.trim(), sources: Object.fromEntries(sourceNames.map(name => [name, digest(join(path, name))])),
    wasm: Object.fromEntries(wasmNames.map(name => [name, digest(join(path, name))])),
    bundles: Object.fromEntries(bundleNames.map(name => [name, digest(join(path, 'dist', name))])) };
}

if (process.argv[2] === '--child') {
  console.log(JSON.stringify(await subject(process.argv[3], process.argv[4])));
} else {
  const [beforeArgument, afterArgument, bunArgument, outputArgument, mode = 'confirm'] = process.argv.slice(2);
  assert.ok(beforeArgument && afterArgument && bunArgument && outputArgument, 'Usage: node benchmark.mjs BEFORE_DIR AFTER_DIR BUN OUTPUT_JSON [pilot|confirm|aa]');
  assert.ok(['pilot', 'confirm', 'aa'].includes(mode));
  const before = resolve(beforeArgument), after = resolve(afterArgument), output = resolve(outputArgument);
  assert.ok(!existsSync(output), 'Never overwrite a recorded study; choose a new output path');
  const variants = { before, after: mode === 'aa' ? before : after };
  const source = { before: identity(before), after: identity(variants.after) };
  const changed = Object.keys(source.before.sources).filter(name => source.before.sources[name] !== source.after.sources[name]);
  assert.deepEqual(changed, mode === 'aa' ? [] : ['shared-sorted-map.ts']);
  assert.deepEqual(source.before.wasm, source.after.wasm);
  const pairs = mode === 'pilot' ? 2 : mode === 'aa' ? 4 : 6;
  const selectedCases = mode === 'aa' ? ['number-4096', 'custom-1024', 'entries-4096'] : Object.keys(cases);
  const runtimes = { node: process.execPath, bun: resolve(bunArgument) };
  const neutral = mkdtempSync(join(tmpdir(), 'sorted-foreach-'));
  const result = { study: `sorted-foreach-${mode}-v1`, status: 'running', started: new Date().toISOString(),
    cpu: cpus()[0].model, platform: `${platform()} ${release()}`, affinityCpu: 2, source,
    harnessSha256: digest(fileURLToPath(import.meta.url)), pairs, cases: selectedCases, subjects: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  save();
  try {
    for (let pair = 0; pair < pairs; pair++) for (const [runtime, executable] of Object.entries(runtimes)) for (const name of selectedCases) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        rmSync(join(neutral, 'dist'), { recursive: true, force: true });
        cpSync(join(variants[variant], 'dist'), join(neutral, 'dist'), { recursive: true });
        const start = new Date().toISOString();
        const child = spawnSync('taskset', ['-c', '2', executable, fileURLToPath(import.meta.url), '--child', join(neutral, 'dist', 'shared.js'), name], { encoding: 'utf8' });
        assert.equal(child.status, 0, `Subject failed: ${child.stdout}\n${child.stderr}`);
        const data = { pair, runtimeLabel: runtime, variant, start, ...JSON.parse(child.stdout) };
        result.subjects.push(data); save();
        console.log(`${runtime} ${name} pair=${pair} ${variant} ${(data.medianMs * 1000).toFixed(3)} us`);
      }
    }
    assert.deepEqual(source.before, identity(before)); assert.deepEqual(source.after, identity(variants.after));
    result.status = 'complete';
  } catch (error) { result.status = 'failed'; result.error = String(error?.stack ?? error); throw error; }
  finally { result.finished = new Date().toISOString(); save(); rmSync(neutral, { recursive: true, force: true }); }
}
