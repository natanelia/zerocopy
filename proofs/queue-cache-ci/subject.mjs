// Queue-specific public API subject. Only calibrate/measure read the operation clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const objectWeight = value => value.index + value.text.length + value.tags.length + value.meta.score + value.meta.parity;
export function fixture(spec) {
  const entries = Object.freeze(Array.from({length: spec.size}, (_, i) => spec.type === 'object'
    ? Object.freeze({index: i, text: `row-${i.toString().padStart(4, '0')}-é-界-🙂`, tags: Object.freeze(['queue', 'prefix']), meta: Object.freeze({parity: i & 1, score: i * 3})})
    : i + 1));
  const second = spec.shape === 'alternate-roots' ? Object.freeze(entries.map(x => x + 10000)) : null;
  const encodedBytes = spec.type === 'object' ? entries.map(value => new TextEncoder().encode(JSON.stringify(value)).length) : [];
  if (encodedBytes.length) {
    assert(encodedBytes.every(n => n < 256));
    assert(encodedBytes.slice(0, 2048).reduce((a, b) => a + b, 0) < 2097152);
  }
  return {entries, second, encodedBytes, perDrainChecksum: entries.reduce((sum, value) => sum + (spec.type === 'object' ? objectWeight(value) : value), 0), inputDigest: digest([entries, second])};
}
export function expectedChecksum(spec, input, operations) {
  if (spec.operation === 'drain') return operations * input.perDrainChecksum;
  if (spec.shape === 'empty') return operations;
  if (spec.shape === 'tail') return operations * 32;
  if (spec.shape === 'alternate-roots') return Math.ceil(operations / 2) + Math.floor(operations / 2) * 10001;
  if (spec.shape === 'alternate-blocks') return Math.ceil(operations / 2) + Math.floor(operations / 2) * 33;
  return operations;
}
export function operationCounts(spec, operations) {
  const items = operations * spec.itemsPerOperation;
  return {unit: spec.unit, itemsPerOperation: spec.itemsPerOperation, publicPeekCalls: items, publicDequeueCalls: spec.operation === 'drain' ? items : 0};
}
export function runBody(spec, roots, operations) {
  let output = roots[0], checksum = 0;
  if (spec.operation === 'drain') {
    if (spec.type === 'object') {
      for (let pass = 0; pass < operations; pass++) {
        output = roots[0];
        for (let i = 0; i < spec.size; i++) { checksum += objectWeight(output.peek()); output = output.dequeue(); }
      }
    } else {
      for (let pass = 0; pass < operations; pass++) {
        output = roots[0];
        for (let i = 0; i < spec.size; i++) { checksum += output.peek(); output = output.dequeue(); }
      }
    }
  } else if (spec.shape === 'empty') {
    for (let i = 0; i < operations; i++) checksum += roots[0].peek() === undefined ? 1 : 0;
  } else if (spec.shape === 'alternate-roots' || spec.shape === 'alternate-blocks') {
    for (let i = 0; i < operations; i++) checksum += roots[i & 1].peek();
  } else {
    for (let i = 0; i < operations; i++) checksum += roots[0].peek();
  }
  return {output, checksum};
}
function vectorState(arena) {
  return {root: arena.vectorRoot, depth: arena.vectorLevel, block: arena.vectorBlock, address: arena.vectorAddress, viewBytes: arena.vectorView?.byteLength ?? null};
}
function checkVector(arm, spec, roots, state, after, operations) {
  if (arm === 'baseline' || spec.shape === 'empty' || spec.shape === 'tail' || (!after && spec.shape === 'unprimed')) {
    assert.deepEqual(state, {root: -1, depth: -1, block: -1, address: 0, viewBytes: null}); return;
  }
  let root = roots[0], block = 0;
  if (spec.shape === 'alternate-roots' || spec.shape === 'alternate-blocks') {
    root = roots[after ? (operations - 1) & 1 : 1]; block = root.tail >>> 5;
  } else if (spec.operation === 'drain') block = (spec.size - 2) >>> 5;
  assert.equal(state.root, root.head); assert.equal(state.depth, root.depth); assert.equal(state.block, block);
  assert(state.address >= 65536); assert(state.viewBytes >= state.address + 256);
}
function objectState(arena, spec, input) {
  if (spec.type !== 'object') { assert.equal(arena.objects.size, 0); return {entries: 0, bytes: 0}; }
  assert.equal(arena.objects.size, 2048);
  assert.equal(arena.objectBytes, input.encodedBytes.slice(0, 2048).reduce((a, b) => a + b, 0));
  const indices = [...arena.objects.values()].map(value => value.index);
  assert.deepEqual(indices, Array.from({length: 2048}, (_, i) => i));
  return {entries: arena.objects.size, bytes: arena.objectBytes, cachedFirstIndex: indices[0], cachedLastIndex: indices.at(-1), uncachedFirstIndex: 2048, uncachedLastIndex: 4096, uncachedPerDrain: 2049};
}
function setup(api, spec, input) {
  const build = values => { let queue = new api.SharedQueue(spec.type); for (const value of values) queue = queue.enqueue(value); return queue; };
  const root = build(input.entries), retained = [{root, expected: input.entries}];
  let roots = [root];
  if (spec.shape === 'alternate-roots') {
    const second = build(input.second); roots.push(second); retained.push({root: second, expected: input.second});
    assert.equal(root.arena, second.arena); assert.notEqual(root.head, second.head);
    assert.equal(root.depth, 0); assert.equal(second.depth, 0); assert.equal(root.tail, 0); assert.equal(second.tail, 0);
    assert.equal(second.peek(), 10001);
  } else if (spec.shape === 'alternate-blocks' || spec.shape === 'tail') {
    const offset = spec.shape === 'tail' ? 31 : 32;
    let advanced = root; for (let i = 0; i < offset; i++) advanced = advanced.dequeue();
    retained.push({root: advanced, expected: input.entries.slice(offset)});
    assert.equal(advanced.head, root.head); assert.equal(advanced.depth, root.depth); assert.equal(advanced.tail, offset);
    if (spec.shape === 'tail') { roots = [advanced]; assert.equal(advanced.size, 1); assert.equal(root.head, 0); }
    else { roots.push(advanced); assert.equal(advanced.peek(), 33); }
  } else if (spec.shape === 'warm-prefix') assert.equal(root.peek(), 1);
  else if (spec.shape === 'mixed-decode') {
    let cursor = root;
    for (let i = 0; i < input.entries.length; i++) { assert.deepEqual(cursor.peek(), input.entries[i]); cursor = cursor.dequeue(); }
    assert.equal(cursor.size, 0);
  }
  if (spec.operation === 'drain' || spec.shape === 'warm-prefix' || spec.shape.startsWith('alternate')) {
    for (const queue of roots) assert(queue.tail < ((queue.tail + queue.size - 1) & ~31));
  }
  return {root, roots, retained};
}
export async function runSubject(config) {
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
  assert(['untimed', 'calibrate', 'measure'].includes(config.mode));
  assert(['baseline', 'candidate'].includes(config.arm));
  assert.equal(process.arch, protocol.architecture); assert.equal(process.platform, 'linux');
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  assert.equal(runtime, config.runtime);
  assert.equal(runtime === 'node' ? process.version : Bun.version, protocol.runtimeVersions[runtime]);
  const api = await import(pathToFileURL(config.entrypoint).href);
  api.configureMemory({maximumBytes: protocol.memory.maximumArenaBytes});
  const collect = runtime === 'bun' ? () => Bun.gc(true) : () => { assert.equal(typeof globalThis.gc, 'function'); globalThis.gc(); };
  const timed = config.mode !== 'untimed';
  let highRss = 0, chunks = 0;
  function memory() { const m = process.memoryUsage(); highRss = Math.max(highRss, m.rss); assert(m.rss <= protocol.memory.maximumSubjectRssBytes, 'Subject RSS limit'); return m; }
  function chunk(spec, input, operations, phase) {
    assert(spec.ladder.includes(operations));
    api.resetQueue(); collect(); memory();
    let prepared = setup(api, spec, input);
    collect(); // Explicit symmetric post-setup GC, never inside the measured body.
    let arena = prepared.root.arena;
    const used = arena.used, beforeBuffer = arena.memory.buffer.byteLength;
    assert(beforeBuffer <= protocol.memory.maximumArenaBytes);
    const descriptors = prepared.retained.map(({root}) => root.toWorkerData());
    const retainedPayload = bytesDigest(arena.buf.subarray(65536, used));
    const beforeVector = vectorState(arena), beforeObjects = objectState(arena, spec, input);
    checkVector(config.arm, spec, prepared.roots, beforeVector, false, operations);
    const started = timed ? performance.now() : null;
    let result = runBody(spec, prepared.roots, operations);
    const durationMs = timed ? performance.now() - started : null;
    const afterVector = vectorState(arena), afterObjects = objectState(arena, spec, input);
    checkVector(config.arm, spec, prepared.roots, afterVector, true, operations);
    assert.equal(result.checksum, expectedChecksum(spec, input, operations));
    assert(Number.isSafeInteger(result.checksum));
    if (spec.operation === 'drain') { assert.equal(result.output.size, 0); assert.equal(result.output.peek(), undefined); assert.equal(result.output.dequeue(), result.output); }
    else assert.equal(result.output, prepared.roots[0]);
    assert.equal(arena.used, used); assert.equal(bytesDigest(arena.buf.subarray(65536, used)), retainedPayload);
    assert.deepEqual(prepared.retained.map(({root}) => root.toWorkerData()), descriptors);
    assert.equal(digest([input.entries, input.second]), input.inputDigest);
    for (const {root, expected} of prepared.retained) {
      let cursor = root;
      assert.equal(cursor.size, expected.length);
      for (const value of expected) {
        const actual = cursor.peek(); assert.deepEqual(actual, value);
        if (spec.type === 'object') { assert(Object.isFrozen(actual)); assert(Object.isFrozen(actual.tags)); assert(Object.isFrozen(actual.meta)); }
        cursor = cursor.dequeue();
      }
      assert.equal(cursor.size, 0); assert.equal(cursor.peek(), undefined);
    }
    assert.equal(arena.used, used); assert.equal(bytesDigest(arena.buf.subarray(65536, used)), retainedPayload);
    const arenaBytes = arena.memory.buffer.byteLength;
    assert.equal(arenaBytes, beforeBuffer);
    const afterValidation = memory(), checksum = result.checksum;
    result = null; prepared = null; arena = null; api.resetQueue(); collect();
    const afterCleanup = memory(); chunks++;
    return {phase, operation: spec.operation, operations, ...operationCounts(spec, operations), durationMs, nsPerOperation: timed ? durationMs * 1e6 / operations : null, nsPerItemPair: timed && spec.operation === 'drain' ? durationMs * 1e6 / operations / spec.size : null, checksum, retainedPayload, descriptors, beforeVector, afterVector, beforeObjects, afterObjects, used, beforeBuffer, arenaBytes, afterValidation, afterCleanup};
  }
  emit({kind: 'start', mode: config.mode, runtime, arm: config.arm, version: runtime === 'node' ? process.version : Bun.version, pid: process.pid, arch: process.arch});
  const offset = config.block ?? 0;
  const cases = [...protocol.cases.slice(offset), ...protocol.cases.slice(0, offset)];
  for (const spec of cases) {
    const input = fixture(spec), rows = [];
    if (config.mode === 'untimed') {
      rows.push(chunk(spec, input, spec.ladder[0], 'untimed-minimum'));
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
    emit({kind: 'case', case: spec.id, operation: spec.operation, unit: spec.unit, itemsPerOperation: spec.itemsPerOperation, inputDigest: input.inputDigest, inputEntries: input.entries.length, rows});
  }
  api.resetQueue(); collect(); memory();
  emit({kind: 'complete', chunks, highRss, resourceUsage: process.resourceUsage(), operationClocks: timed});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSubject(JSON.parse(readFileSync(process.argv[2], 'utf8')));
