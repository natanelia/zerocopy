import assert from 'node:assert/strict';

export const MEMORY_SCHEMA = 'zerocopy-feature-map-memory/v1';
export const KINDS = ['shared', 'native', 'immutable', 'immer'];
export const READER_COUNTS = [0, 2, 4];
export const STAGES = ['loaded', 'queried', 'edited-retained', 'released', 'streamed'];
export const READ_COUNT = 1000;
export const EDIT_COUNT = 100;
export const STREAM_EDITS = 10;
export const RPC_TIMEOUT_MS = 60000;
export const PROCESS_TIMEOUT_MS = 180000;
export const METHOD = 'Sum of signed post-GC JavaScript heap and tracked ArrayBuffer changes across the controller, owner, and every reader, plus unique shared WASM backing capacity counted once by arena identity. Empty imported workers and connected MessageChannels are the baseline. Includes caches, spare capacity, and unreclaimed arena history. External memory is diagnostic and is not added twice. Process RSS and high-water RSS are reported separately. Not live payload size, browser memory, or peak temporary allocation.';

export function validateCase(value) {
  assert.ok(KINDS.includes(value.kind), 'Unknown map kind');
  assert.ok(READER_COUNTS.includes(value.readers), 'Readers must be 0, 2, or 4');
  assert.ok([1000, 10000, 100000].includes(value.entries), 'Entries must be one of the validated presets: 1,000, 10,000, or 100,000');
  return value;
}

export function totals(threads) {
  assert.ok(Array.isArray(threads) && threads.length, 'Missing thread samples');
  assert.equal(new Set(threads.map(thread => thread.role)).size, threads.length, 'Duplicate thread identity');
  const arenas = new Map();
  let heapUsed = 0, arrayBuffers = 0, external = 0;
  for (const thread of threads) {
    assert.ok(typeof thread.role === 'string' && thread.role, 'Missing thread identity');
    for (const field of ['heapUsed', 'arrayBuffers', 'external']) assert.ok(Number.isFinite(thread.usage[field]) && thread.usage[field] >= 0, `Missing ${field}`);
    heapUsed += thread.usage.heapUsed;
    arrayBuffers += thread.usage.arrayBuffers;
    external += thread.usage.external;
    for (const arena of thread.arenas) {
      assert.ok(typeof arena.id === 'string' && arena.id, 'Missing arena identity');
      assert.ok(Number.isSafeInteger(arena.capacityBytes) && arena.capacityBytes >= 131072 && arena.capacityBytes % 65536 === 0, 'Invalid WASM capacity');
      assert.ok(Number.isSafeInteger(arena.usedBytes) && arena.usedBytes >= 65536 && arena.usedBytes <= arena.capacityBytes, 'Invalid used prefix');
      const previous = arenas.get(arena.id);
      if (previous) {
        assert.equal(previous.capacityBytes, arena.capacityBytes, 'Conflicting capacities for the same arena');
        // Read-only attachments keep the used prefix from their own descriptor.
        // Retained roots can legitimately lag the latest root in the same arena.
        previous.usedBytes = Math.max(previous.usedBytes, arena.usedBytes);
      } else arenas.set(arena.id, { id: arena.id, capacityBytes: arena.capacityBytes, usedBytes: arena.usedBytes });
    }
  }
  const unique = [...arenas.values()].sort((left, right) => left.id.localeCompare(right.id));
  return { heapUsed, arrayBuffers, external,
    wasmCapacityBytes: unique.reduce((sum, arena) => sum + arena.capacityBytes, 0),
    arenaUsedBytes: unique.reduce((sum, arena) => sum + arena.usedBytes, 0),
    arenaCount: unique.length, arenas: unique };
}

export function compareMemory(before, after) {
  assert.deepEqual(before.map(thread => thread.role).sort(), after.map(thread => thread.role).sort(), 'Thread set changed after baseline');
  const baseline = totals(before), current = totals(after);
  assert.equal(baseline.wasmCapacityBytes, 0, 'Baseline must precede collection allocation');
  const heapDelta = current.heapUsed - baseline.heapUsed;
  const arrayBufferDelta = current.arrayBuffers - baseline.arrayBuffers;
  const retainedBytes = heapDelta + arrayBufferDelta + current.wasmCapacityBytes;
  return { ...current, heapDelta, arrayBufferDelta, retainedBytes, resolved: retainedBytes > 0 };
}

export function validateStage(record, config) {
  assert.ok(STAGES.includes(record.name), 'Unknown stage');
  assert.deepEqual(record.threads.map(thread => thread.role).sort(), ['controller', 'owner', ...Array.from({ length: config.readers }, (_, index) => `reader-${index}`)].sort());
  assert.equal(record.memory.arenaCount, config.kind === 'shared' ? 1 : 0, 'Unexpected arena count');
  assert.ok(record.memory.resolved, `${record.name}: retained total is unresolved; preserve this run and investigate`);
  const expectedRevision = ['loaded', 'queried'].includes(record.name) ? 0 : record.name === 'streamed' ? STREAM_EDITS + 1 : 1;
  for (const thread of record.threads.filter(thread => thread.role !== 'controller')) {
    assert.equal(thread.count, config.entries, 'Map cardinality changed during replacement edits');
    assert.equal(thread.revision, expectedRevision, 'Wrong current revision');
    assert.equal(thread.retainedRevision, record.name === 'edited-retained' ? 0 : null, 'Wrong retained revision');
    assert.equal(thread.arenas.length, config.kind === 'shared' ? 1 : 0);
    if (config.kind === 'shared') assert.equal(thread.arenas[0].readOnly, thread.role !== 'owner');
  }
  for (const field of ['rssBytes', 'processHighWaterRSSBytes']) assert.ok(Number.isFinite(record[field]) && record[field] > 0);
  const owner = record.threads.find(thread => thread.role === 'owner');
  assert.deepEqual(owner.transport, { initialPublications: config.readers, editPublications: expectedRevision * config.readers,
    clonedEntryPairs: config.kind === 'shared' ? 0 : config.readers * (config.entries + expectedRevision * EDIT_COUNT) }, 'Unexpected full-map cloning or publication count');
}

export function validateAnswers(value, config, revision, expected) {
  assert.equal(value.revision, revision, 'Wrong answer revision');
  assert.equal(value.answers.length, config.readers || 1, 'Missing worker reply');
  for (const [index, reply] of value.answers.entries()) {
    const task = config.readers ? index % 2 ? 'validate' : 'lookup' : 'both';
    assert.equal(reply.role, config.readers ? `reader-${index}` : 'owner', 'Wrong answer worker');
    assert.equal(reply.revision, revision, 'Wrong worker revision');
    assert.equal(reply.task, task, 'Wrong worker task');
    const keys = task === 'both' ? ['lookup', 'validation'] : [task === 'validate' ? 'validation' : 'lookup'];
    assert.deepEqual(Object.keys(reply.answer).sort(), [...keys].sort(), 'Incomplete or extra answer sections');
    for (const key of keys) assert.deepEqual(reply.answer[key], expected[key], `${reply.role} ${key} differs from the independent reference`);
  }
}

export function median(values) {
  assert.ok(values.length && values.every(Number.isFinite), 'Median requires finite samples');
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const SUMMARY_FIELDS = ['retainedBytes', 'heapDelta', 'arrayBufferDelta', 'wasmCapacityBytes', 'arenaUsedBytes', 'rssBytes', 'processHighWaterRSSBytes'];
export function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) for (const record of sample.records.filter(record => record.type === 'stage')) {
    const identity = { kind: sample.kind, readers: sample.readers, entries: sample.entries, stage: record.name }, key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { ...identity, samples: [] });
    groups.get(key).samples.push({ trial: sample.trial, ...record.memory, rssBytes: record.rssBytes, processHighWaterRSSBytes: record.processHighWaterRSSBytes });
  }
  return [...groups.values()].map(group => ({ ...group,
    medians: Object.fromEntries(SUMMARY_FIELDS.map(field => [field, median(group.samples.map(sample => sample[field]))])),
    ranges: Object.fromEntries(SUMMARY_FIELDS.map(field => [field, { min: Math.min(...group.samples.map(sample => sample[field])), max: Math.max(...group.samples.map(sample => sample[field])) }])) }));
}
