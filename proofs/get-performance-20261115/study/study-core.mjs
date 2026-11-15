import { CASES, FIXTURE_VERSION, makeFixture, expectedPlain } from './fixtures.mjs';

export const STUDY_VERSION = 1;
export const WARM_PASSES = 16;
export function exact(actual, expected, message = 'Output mismatch') {
  const work = [[actual, expected]];
  while (work.length) {
    const [a, b] = work.pop();
    if (Object.is(a, b)) continue;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)
        || Array.isArray(a) && a.length !== b.length) throw new Error(message);
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length || ak.some((key, i) => key !== bk[i])) throw new Error(message);
    for (const key of ak) work.push([a[key], b[key]]);
  }
}
function frozenTree(values) {
  const pending = [...values], seen = new Set(); let count = 0;
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); count++;
    if (!Object.isFrozen(value)) throw new Error('Standard .get() returned a mutable JSON object');
    for (const child of Object.values(value)) pending.push(child);
  }
  return count;
}
function arenaSizes(payload) {
  return payload.arenas.map(arena => ({ usedBytes: arena.used, capacityBytes: arena.memory?.buffer.byteLength ?? arena.copy?.byteLength, shared: arena.memory?.buffer instanceof SharedArrayBuffer }));
}
function bytesEqual(payload, snapshots) {
  for (let n = 0; n < payload.arenas.length; n++) {
    const bytes = new Uint8Array(payload.arenas[n].memory.buffer, 0, snapshots[n].length);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== snapshots[n][i]) throw new Error(`Reader wrote published byte ${i}`);
  }
}
function timed(operation) { const start = performance.now(); const value = operation(); return { ms: performance.now() - start, value }; }
async function timedAsync(operation) { const start = performance.now(); const value = await operation(); return { ms: performance.now() - start, value }; }
function plainRead(collection, requests) { const values = new Array(requests.length); for (let i = 0; i < requests.length; i++) values[i] = collection.get(requests[i]); return values; }

/** Construction is a separate guardrail, including nested child construction. */
export function buildOwner(api, definition, fixture) {
  if (definition.kind === 'map' || definition.shape === 'nested-number-map') api.resetMap();
  if (definition.kind === 'list') api.resetSharedList();
  const nested = definition.shape === 'nested-number-map';
  const value = item => nested ? new api.SharedMap('number').set('value', item) : item;
  if (definition.kind === 'map') return new api.SharedMap(definition.type).setMany(nested ? fixture.entries.map(([key, item]) => [key, value(item)]) : fixture.entries);
  return new api.SharedList(definition.type).pushMany(nested ? fixture.values.map(value) : fixture.values);
}
export function verifyPlainCapture(api, definition, capture, expected) {
  if (definition.shape !== 'nested-number-map') { exact(capture, expected); return; }
  const contents = capture.map(value => {
    if (value === undefined) return undefined;
    if (!(value instanceof api.SharedMap) || value.type !== 'number' || value.size !== 1 || !Object.isFrozen(value)) throw new Error('Nested descriptor did not reconstruct a frozen numeric SharedMap');
    return value.get('value');
  });
  exact(contents, expected);
}

/** No instruments or view APIs. All benchmarks call the ordinary .get() path. */
export async function runCase(api, harness, definition, options = {}) {
  const record = { caseId: definition.id, ...definition, studyVersion: STUDY_VERSION, fixtureVersion: FIXTURE_VERSION,
    api: definition.kind === 'map' ? 'SharedMap.get' : 'SharedList.get', status: 'running', timer: 'local synchronous query; result array included; no worker transport',
    warmPasses: WARM_PASSES, coldDefinition: 'fresh read-only attachment with empty decoded caches; no prior map/list API reads or decoding; code may be warm and the untimed byte-canary copy has already touched the payload, so CPU caches are not cold', measurements: {}, memory: {}, correctness: {} };
  const fixture = makeFixture(definition, harness.catalog);
  record.fixtureSHA256 = await options.hash(JSON.stringify({ definition, entries: fixture.entries, requests: fixture.requests, edits: fixture.edits }));
  record.serializedValueBytes = fixture.serializedBytes;
  record.requested = fixture.requests.length; record.uniqueRequested = new Set(fixture.requests).size;
  record.uniqueLookupKeys = fixture.uniqueLookupKeys;
  options.gc?.(); record.memory.before = options.memory?.() ?? { available: false };
  let phase = 'construction';
  try {
    const build = timed(() => buildOwner(api, definition, fixture));
    const owner = build.value;
    record.measurements.constructionMs = build.ms;
    phase = 'publication-attachment';
    const publish = await timedAsync(async () => {
      const payload = api.getWorkerData({ data: owner }, { copy: false });
      return { payload, reader: (await api.initWorker(payload)).data };
    });
    const { payload, reader } = publish.value;
    record.measurements.publicationAttachmentMs = publish.ms;
    record.arenaBefore = arenaSizes(payload);
    if (record.arenaBefore.some(arena => !arena.shared)) throw new Error('Expected direct shared memory attachment');
    // Correctness copy is outside all timings, and makes no collection reads.
    const publishedBytes = payload.arenas.map(arena => new Uint8Array(arena.memory.buffer, 0, arena.used).slice());
    const fullDefinition = harness.reads.readCase('full-shared-get');
    const run = collection => definition.workload === 'full-object-get' ? harness.reads.runReadQuery(collection, fixture.requests, fullDefinition)
      : definition.workload === 'legacy-lookup' ? harness.catalog.calculate(collection, fixture.requests, 'lookup')
      : definition.workload === 'legacy-validate' ? harness.catalog.calculate(collection, fixture.requests, 'validate')
      : plainRead(collection, fixture.requests);
    const expected = revision => definition.workload === 'full-object-get' ? harness.readReference.readReference(definition.size, revision, fixture.requests, fullDefinition)
      : definition.workload.startsWith('legacy-') ? (() => { const all = harness.catalogReference.reference(definition.size, revision, fixture.requests); return definition.workload === 'legacy-lookup' ? { lookup: all.lookup } : { validation: all.validation }; })()
      : expectedPlain(fixture, definition, revision === 1);
    const sourceValues = answer => definition.workload === 'full-object-get' ? answer.rows.map(row => row.value)
      : definition.workload === 'legacy-lookup' ? answer.lookup.rows.map(row => row.value)
      : definition.workload === 'legacy-validate' ? [] : answer;
    const verify = (answer, expectedValue) => definition.workload === 'ordinary-get' ? verifyPlainCapture(api, definition, answer, expectedValue) : exact(answer, expectedValue);
    phase = 'cold'; let cold = timed(() => run(reader));
    record.measurements.coldMs = cold.ms;
    record.measurements.constructionToFirstLocalAnswerMs = build.ms + publish.ms + cold.ms;
    phase = 'repeat'; let repeat = timed(() => run(reader));
    record.measurements.repeatMs = repeat.ms;
    // The first complete verification is AFTER the immediate repeat.
    phase = 'verify-cold-repeat'; const initialExpected = expected(0);
    verify(cold.value, initialExpected); verify(repeat.value, initialExpected);
    const expectedValues = expectedPlain(fixture, definition);
    record.found = expectedValues.filter(value => value !== undefined).length; record.missing = expectedValues.length - record.found;
    record.correctness.initial = true;
    let coldValues = sourceValues(cold.value), repeatValues = sourceValues(repeat.value);
    record.identity = { compared: coldValues.length, identicalColdRepeat: coldValues.filter((value, i) => Object.is(value, repeatValues[i])).length,
      note: 'Observed identity behavior. Above admission limits, uncached objects may be newly decoded.' };
    coldValues = repeatValues = undefined;
    if (definition.type === 'object') record.correctness.frozenObjects = frozenTree(sourceValues(cold.value)) + frozenTree(sourceValues(repeat.value));
    record.memory.afterColdAndRepeat = options.memory?.() ?? { available: false };
    phase = 'warm-batch'; let warm = timed(() => { const captures = []; for (let i = 0; i < WARM_PASSES; i++) captures.push(run(reader)); return captures; });
    record.measurements.warmBatchMs = warm.ms; record.measurements.warmPassMs = warm.ms / WARM_PASSES;
    phase = 'verify-warm'; for (const capture of warm.value) verify(capture, initialExpected);
    record.correctness.warmPasses = WARM_PASSES;
    bytesEqual(payload, publishedBytes); record.correctness.publishedBytesUnchanged = true;
    cold = repeat = warm = undefined;
    options.gc?.(); record.memory.retainedAfterReads = options.memory?.() ?? { available: false };
    phase = 'edit'; const update = timed(() => owner.setMany(definition.shape === 'nested-number-map'
      ? fixture.edits.map(([key, value]) => [key, new api.SharedMap('number').set('value', value)]) : fixture.edits));
    record.measurements.editMs = update.ms; record.edits = fixture.edits.length;
    phase = 'edited-publication'; const updated = await timedAsync(async () => {
      const data = api.getWorkerData({ initial: owner, current: update.value }, { copy: false });
      return { payload: data, snapshots: await api.initWorker(data) };
    });
    record.measurements.editedPublicationAttachmentMs = updated.ms;
    record.arenaAfter = arenaSizes(updated.value.payload);
    phase = 'edited-first-read'; const edited = timed(() => run(updated.value.snapshots.current));
    record.measurements.editedFirstMs = edited.ms;
    phase = 'retained-read'; const retained = timed(() => run(updated.value.snapshots.initial));
    record.measurements.retainedMs = retained.ms;
    phase = 'verify-revisions'; verify(edited.value, expected(1)); verify(retained.value, initialExpected);
    record.correctness.editedAndRetained = true;
    // Mix roots in one attached arena using precisely the same ordinary API.
    // Both roots have now been exercised; record this explicitly as a warm test.
    const mixed = timed(() => fixture.requests.map((key, i) => (i % 2 ? updated.value.snapshots.current : updated.value.snapshots.initial).get(key)));
    record.measurements.mixedRevisionMs = mixed.ms;
    const originalPlain = expectedPlain(fixture, definition, false), editedPlain = expectedPlain(fixture, definition, true);
    verifyPlainCapture(api, definition, mixed.value, originalPlain.map((value, i) => i % 2 ? editedPlain[i] : value));
    record.correctness.mixedRevisions = true;
    record.memory.afterEdits = options.memory?.() ?? { available: false };
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.failure = { phase, name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack };
  }
  return record;
}

export async function runStudy(api, harness, options) {
  const selected = options.cases?.length ? CASES.filter(item => options.cases.includes(item.id)) : CASES;
  if (!selected.length || options.cases?.some(id => !CASES.some(item => item.id === id))) throw new Error('Unknown study case');
  const rotation = (options.rotation ?? 0) % selected.length;
  const ordered = [...selected.slice(rotation), ...selected.slice(0, rotation)];
  const records = [];
  for (let order = 0; order < ordered.length; order++) {
    for (let sample = 0; sample <= options.warmups; sample++) {
      const record = await runCase(api, harness, ordered[order], options);
      Object.assign(record, { caseOrder: order, warmup: sample < options.warmups, processSample: sample });
      records.push(record); await options.onRecord?.(record);
      if (record.status !== 'passed') return records;
    }
  }
  return records;
}
