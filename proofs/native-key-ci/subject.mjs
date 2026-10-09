// Only explicit calibrate/measure modes read the performance clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
assert(['untimed', 'calibrate', 'measure'].includes(config.mode));
assert.equal(process.arch, protocol.architecture);
const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
assert.equal(runtime, config.runtime);
assert.equal(runtime === 'node' ? process.version : Bun.version, protocol.runtimeVersions[runtime]);
assert.equal(typeof String.prototype.toWellFormed, 'function', 'This first screen requires the native-capable path');
const api = await import(pathToFileURL(config.entrypoint).href);
api.configureMemory({maximumBytes: protocol.memory.maximumArenaBytes});
const collect = runtime === 'bun' ? () => Bun.gc(true) : () => { assert.equal(typeof globalThis.gc, 'function'); globalThis.gc(); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {ignoreBOM: true});
// Independent UTF-8 oracle remains outside the timed region.
const normalize = key => decoder.decode(encoder.encode(key));
const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const timed = config.mode !== 'untimed';
let highRss = 0, chunks = 0;
function memory() {
  const m = process.memoryUsage(); highRss = Math.max(highRss, m.rss);
  assert(m.rss <= protocol.memory.maximumSubjectRssBytes, 'Subject RSS limit');
  return m;
}
function value(type, i, unicode = false) {
  if (type === 'number') return i * 0.25 - 512;
  if (type === 'boolean') return (i & 1) === 0;
  if (type === 'object') return Object.freeze({index: i, text: `object-${i}`, ok: (i & 1) === 0});
  return unicode ? `value-é-界-🙂-${i.toString().padStart(5, '0')}` : `value-ascii-${i.toString().padStart(5, '0')}`;
}
function fixture(spec) {
  const entries = Object.freeze(Array.from({length: spec.size}, (_, i) => {
    const unicodeKey = spec.shape === 'unicode-keys' || (spec.shape === 'mixed' && i % 4 === 0);
    const unicodeValue = spec.shape === 'unicode-values' || (spec.shape === 'mixed' && i % 4 === 1);
    let key = `${unicodeKey ? 'key-é-界-🙂-' : 'key-ascii-'}${i.toString().padStart(5, '0')}`;
    if (spec.shape === 'long-malformed-alias') {
      const pair = i >> 1;
      key = `${pair % 2 ? '\ufeff' : ''}key-${'x'.repeat(512)}-${pair}-${i % 2 ? '\ufffd' : '\ud800'}`;
    } else if (spec.shape === 'malformed-alias') key = `${i % 2 ? '\ufeff' : ''}key-${i}-\ud800`;
    return Object.freeze([key, value(spec.type, i, unicodeValue)]);
  }));
  const seed = spec.operation === 'setMany'
    ? Object.freeze(Array.from({length: 8}, (_, i) => Object.freeze([`anchor-${i}`, value(spec.type, -i - 1)])))
    : entries;
  const expected = new Map(seed.map(([key, val]) => [normalize(key), val]));
  if (spec.operation === 'setMany') for (const [key, val] of entries) expected.set(normalize(key), val);
  const canonicalKeys = Object.freeze(entries.map(([key]) => normalize(key)));
  const alternateKeys = Object.freeze(entries.map(([key]) => key.replace('\ud800', '\udfff')));
  const updates = Object.freeze(spec.type === 'number' ? [123, 456] : ['update-a', 'update-b']);
  return {entries, seed, expected, canonicalKeys, alternateKeys, updates, inputDigest: digest(entries)};
}
function chunk(spec, fixture, operations, phase) {
  assert(spec.ladder.includes(operations) || operations === 1);
  api.resetMap(); collect(); memory();
  let root = new api.SharedMap(spec.type);
  for (const [key, val] of fixture.seed) root = root.set(key, val);
  let output = root, checksum = 0;
  if (spec.operation !== 'setMany') {
    for (const [i, [, val]] of fixture.entries.entries()) assert.equal(root.get(fixture.canonicalKeys[i]), val);
    assert(root.arena.valueMap instanceof Map, 'Public reads must prime primitive cache');
    assert.equal(root.arena.valueRoot, root.root);
    assert.equal(root.arena.valueMap.size, spec.size);
    for (const key of fixture.canonicalKeys) assert(root.arena.valueMap.has(key));
  }
  const beforeBuffer = api.SharedMap.getSharedBuffer().byteLength;
  const retainedUsed = root.arena.used;
  const retainedPayload = bytesDigest(root.arena.buf.subarray(65536, retainedUsed));
  let durationMs;
  if (spec.operation === 'setMany') {
    // Every public call retains the same eight-entry root; results are not chained.
    const started = timed ? performance.now() : null;
    for (let i = 0; i < operations; i++) output = root.setMany(fixture.entries);
    durationMs = timed ? performance.now() - started : null;
  } else if (spec.operation === 'set') {
    // Chain changed-value writes so cachePrimitive keeps the current primitive cache.
    // Retain the old root, prebuild inputs, and never read either root in this region.
    const started = timed ? performance.now() : null;
    for (let i = 0; i < operations; i++) {
      const index = i & 15, cycle = (i >>> 4) & 1;
      output = output.set(cycle ? fixture.alternateKeys[index] : fixture.entries[index][0], fixture.updates[cycle]);
    }
    durationMs = timed ? performance.now() - started : null;
  } else {
    // Canonical keys hit the unchanged warm primitive-cache read path.
    const started = timed ? performance.now() : null;
    for (let i = 0; i < operations; i++) checksum += root.get(fixture.canonicalKeys[i & 15]).length;
    durationMs = timed ? performance.now() - started : null;
  }
  const arenaBytes = api.SharedMap.getSharedBuffer().byteLength;
  assert(arenaBytes <= protocol.memory.maximumArenaBytes);
  assert.equal(root.size, fixture.seed.length);
  assert.equal(bytesDigest(root.arena.buf.subarray(65536, retainedUsed)), retainedPayload);
  let cacheState = null;
  const expected = new Map(fixture.expected);
  if (spec.operation === 'set') {
    for (let i = 0; i < Math.min(spec.size, operations); i++) {
      const last = i + Math.floor((operations - 1 - i) / spec.size) * spec.size;
      expected.set(fixture.canonicalKeys[i], fixture.updates[(last >>> 4) & 1]);
    }
    assert(output.arena.valueMap instanceof Map, 'Cache must stay primed through every chained update');
    assert.equal(output.arena.valueRoot, output.root);
    assert.equal(output.arena.valueMap.size, spec.size);
    assert.deepEqual(output.arena.valueMap, expected);
    cacheState = {root: output.arena.valueRoot, entries: output.arena.valueMap.size, chars: output.arena.valueMapChars, bytes: output.arena.valueMapBytes};
    for (const [key] of fixture.entries) assert.equal(output.get(key), expected.get(normalize(key)));
    for (const key of fixture.alternateKeys) assert.equal(output.get(key), expected.get(normalize(key)));
  } else if (spec.operation === 'get') {
    const lengths = fixture.entries.map(([, val]) => val.length);
    const expectedChecksum = Math.floor(operations / spec.size) * lengths.reduce((a, b) => a + b, 0) + lengths.slice(0, operations % spec.size).reduce((a, b) => a + b, 0);
    assert.equal(checksum, expectedChecksum);
    assert.equal(output, root);
    cacheState = {root: root.arena.valueRoot, entries: root.arena.valueMap.size, chars: root.arena.valueMapChars, bytes: root.arena.valueMapBytes};
    assert.deepEqual(root.arena.valueMap, expected);
  }
  assert.equal(output.size, expected.size);
  for (const [key, val] of expected) assert.deepEqual(output.get(key), val);
  assert.deepEqual(new Map(output.entries()), expected);
  for (const [key, val] of fixture.seed) assert.deepEqual(root.get(key), val);
  if (spec.operation === 'setMany') {
    for (const [key] of fixture.entries) {
      assert.equal(root.get(key), undefined);
      assert.deepEqual(output.get(key), expected.get(normalize(key)));
    }
    if (!fixture.entries.length) assert.equal(output, root);
  }
  assert.equal(digest(fixture.entries), fixture.inputDigest);
  assert.equal([...root.entries()].length, fixture.seed.length);
  const afterValidation = memory();
  output = null; root = null;
  api.resetMap(); collect();
  const afterCleanup = memory(); chunks++;
  return {phase, operation: spec.operation, operations, durationMs, nsPerOperation: timed ? durationMs * 1e6 / operations : null, checksum, retainedPayload, cacheState, beforeBuffer, arenaBytes, afterValidation, afterCleanup};
}
emit({kind: 'start', mode: config.mode, runtime, version: runtime === 'node' ? process.version : Bun.version, pid: process.pid, arch: process.arch});
const offset = config.block ?? 0;
const cases = [...protocol.cases.slice(offset), ...protocol.cases.slice(0, offset)];
for (const spec of cases) {
  const input = fixture(spec), rows = [];
  if (config.mode === 'untimed') {
    rows.push(chunk(spec, input, 1, 'untimed-minimum'));
    rows.push(chunk(spec, input, spec.ladder.at(-1), 'untimed-maximum'));
  } else if (config.mode === 'calibrate') {
    for (let i = 0; i < protocol.calibration.warmupChunks; i++) rows.push(chunk(spec, input, spec.ladder.at(-1), 'calibration-warmup'));
    const warmupBodyMs = rows.reduce((sum, x) => sum + x.durationMs, 0);
    emit({kind: 'calibration-diagnostics', case: spec.id, warmupBodyMs, insufficientWarmup: warmupBodyMs < protocol.calibration.minimumWarmupBodyMs});
    for (const operations of spec.ladder) for (let sample = 0; sample < protocol.calibration.samplesPerLevel; sample++) rows.push({...chunk(spec, input, operations, 'calibration'), sample});
  } else {
    const work = config.work[spec.id]; assert(work && spec.ladder.includes(work.operations));
    for (let i = 0; i < protocol.measurement.warmupChunks; i++) rows.push({...chunk(spec, input, work.operations, 'warmup'), sample: i});
    for (let i = 0; i < protocol.measurement.samples; i++) rows.push({...chunk(spec, input, work.operations, 'measurement'), sample: i});
    const warm = rows.filter(x => x.phase === 'warmup').map(x => x.durationMs);
    const measure = rows.filter(x => x.phase === 'measurement');
    const window = protocol.measurement.warmupComparisonWindow;
    const relativeWarmupDrift = median(warm.slice(-window)) / median(warm.slice(-2*window, -window)) - 1;
    const warmupBodyMs = warm.reduce((sum, x) => sum + x, 0);
    const stats = summary(measure.map(x => x.nsPerOperation));
    emit({kind: 'diagnostics', case: spec.id, calibrationFloor: !work.targetMet, calibrationWarmupFlag: work.calibrationWarmupFlag, minimumDurationFloor: measure.some(x => x.durationMs < protocol.measurement.minimumChunkMs), warmupBodyMs, insufficientWarmup: warmupBodyMs < protocol.measurement.minimumWarmupBodyMs, relativeWarmupDrift, warmupFlag: Math.abs(relativeWarmupDrift) > protocol.measurement.warmupDriftFraction, variabilityFlag: stats.relativeMad > protocol.statistics.sampleRelativeMadDiagnosticFraction, stats});
  }
  emit({kind: 'case', case: spec.id, operation: spec.operation, inputDigest: input.inputDigest, retainedRootEntries: input.seed.length, inputEntries: input.entries.length, rows});
}
api.resetMap(); collect(); memory();
emit({kind: 'complete', chunks, highRss, resourceUsage: process.resourceUsage()});
