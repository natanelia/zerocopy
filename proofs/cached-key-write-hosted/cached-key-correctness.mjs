import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData, threadId } from 'node:worker_threads';

const GROUPS = ['hits-misses-and-undefined-pointer', 'entry-and-byte-budgets', 'unicode-alias-and-dedup', 'public-map-reentry-growth-errors', 'oversized-scalar-boundary', 'nested-batch-replacements'];
const sha = value => createHash('sha256').update(value).digest('hex');
const arena = map => map.arena;
const byKey = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const snapshot = a => ({ used: a.used, bytes: Buffer.from(a.buf.slice(65536, a.used)) });
const unchanged = (a, before) => assert.deepEqual(Buffer.from(a.buf.subarray(65536, before.used)), before.bytes);
const stored = key => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(key));
const valueView = value => value && typeof value.entries === 'function'
  ? { nestedType: value.valueType, entries: [...value.entries()].map(([key, item]) => [key, valueView(item)]).sort(byKey) } : value;
const logical = map => [...map.entries()].map(([key, value]) => [key, valueView(value)]).sort(byKey);
function check(map, expected) {
  const actual = logical(map), wanted = [...expected].map(([key, value]) => [stored(key), valueView(value)]).sort(byKey);
  assert.deepEqual(actual, wanted); assert.equal(map.size, wanted.length);
  for (const [key, value] of wanted) assert.deepEqual(valueView(map.get(key)), value);
  const callbacks = []; map.forEach((value, key) => callbacks.push([key, valueView(value)]));
  assert.deepEqual(callbacks.sort(byKey), wanted); assert.ok(Object.isFrozen(map));
  return { root: map.root, size: map.size, entriesSHA256: sha(JSON.stringify(actual)) };
}
function summary(a) {
  const tokens = [...a.keys].map(([key, token]) => [sha(Buffer.from(key, 'utf16le')), token.length, token.hash, token.ptr ?? null]);
  assert.equal(a.keyBytes, [...a.keys.values()].reduce((sum, token) => sum + token.length, 0));
  assert.ok(a.keys.size <= 2048 && a.keyBytes <= 262144);
  return { used: a.used, capacity: a.memory.buffer.byteLength, payloadSHA256: sha(a.buf.subarray(65536, a.used)),
    keyCount: a.keys.size, keyBytes: a.keyBytes, tokensSHA256: sha(JSON.stringify(tokens)) };
}
function fresh(S, id, type = 'object', kind = 'map') {
  // Use the existing Arena constructor with explicit IDs, not private-field
  // mutation. This keeps nested serialized bytes comparable across processes.
  const A = arena(new S.SharedMap('object')).constructor;
  const a = new A({ id, memory: new WebAssembly.Memory({ initial: 2, maximum: 128, shared: true }) });
  const map = kind === 'sorted' ? new S.SharedSortedMap(type, undefined, 0, 0, a)
    : kind === 'ordered' ? new S.SharedOrderedMap(type, 0, 0, 0, 0, a) : new S.SharedMap(type, 0, 0, a);
  return [a, map];
}

function basic(S) {
  const [a, empty] = fresh(S, 'cached-key/basic');
  const initial = [['hot', { n: 1 }], ['', { n: 2 }], ['other', { n: 3 }]];
  assert.equal(a.keys.size, 0); const old = empty.setMany(initial), before = snapshot(a);
  const hot = a.keys.get('hot'), blank = a.keys.get(''); assert.ok(hot && blank && hot.ptr !== undefined);
  const next = old.setMany([['hot', { n: 4 }], ['new', { n: 5 }], ['', { n: 6 }]]);
  assert.equal(a.keys.get('hot'), hot); assert.equal(a.keys.get(''), blank); assert.ok(a.keys.has('new'));
  assert.equal(a.keys.size, 4); unchanged(a, before);
  const fork = old.setMany([['hot', { n: 7 }]]);
  const rows = [check(old, initial), check(next, [['hot', { n: 4 }], ['new', { n: 5 }], ['', { n: 6 }], ['other', { n: 3 }]]),
    check(fork, [['hot', { n: 7 }], ['', { n: 2 }], ['other', { n: 3 }]])];
  const [b, sortedEmpty] = fresh(S, 'cached-key/undefined-pointer', 'object', 'sorted');
  const sorted = sortedEmpty.set('seed', { seed: true });
  assert.equal(sorted.has('future'), false); const token = b.keys.get('future');
  assert.ok(token); assert.equal(token.ptr, undefined); const kept = snapshot(b);
  const ordinary = new S.SharedMap('object', 0, 0, b).setMany([['future', { accepted: true }]]);
  assert.equal(b.keys.get('future'), token); assert.ok(token.ptr !== undefined); unchanged(b, kept);
  check(ordinary, [['future', { accepted: true }]]); check(sorted, [['seed', { seed: true }]]);
  return { group: { name: GROUPS[0], rows, hitIdentityPreserved: true, undefinedPointerInitialized: true,
    cache: summary(a), pointerCache: summary(b) }, fixtures: { old, next, fork } };
}

function budgets(S) {
  const [a, empty] = fresh(S, 'cached-key/count-budget');
  const rows = Array.from({ length: 2047 }, (_, i) => [`k${String(i).padStart(7, '0')}`, { i }]);
  const old = empty.setMany(rows), before = snapshot(a), hot = a.keys.get(rows[0][0]);
  assert.equal(a.keys.size, 2047); let side;
  const next = old.setMany([[rows[0][0], { toJSON() {
    assert.equal(a.keys.get(rows[0][0]), hot); side = old.setMany([['last-slot', { side: true }]]);
    assert.equal(a.keys.size, 2048); return { outer: true };
  } }]]);
  assert.equal(a.keys.get(rows[0][0]), hot); const fullCount = a.keyBytes;
  const saturated = next.setMany([[rows[0][0], { saturated: true }], ['uncached', { i: -1 }]]);
  assert.equal(a.keys.size, 2048); assert.equal(a.keyBytes, fullCount); assert.equal(a.keys.has('uncached'), false);
  const repeatedMiss = saturated.setMany([['uncached', { i: -2 }]]);
  assert.equal(a.keys.has('uncached'), false); assert.deepEqual(repeatedMiss.get('uncached'), { i: -2 });
  assert.deepEqual(old.get(rows[0][0]), { i: 0 }); assert.deepEqual(side.get('last-slot'), { side: true });
  assert.deepEqual(next.get(rows[0][0]), { outer: true }); unchanged(a, before);

  const [b, byteEmpty] = fresh(S, 'cached-key/byte-budget');
  const keys = ['A'.repeat(65536), 'B'.repeat(65536), 'C'.repeat(65535), 'D'.repeat(65536)];
  const byteOld = byteEmpty.setMany(keys.slice(0, 3).map((key, i) => [key, { i }]));
  assert.equal(b.keyBytes, 196607); const byteBefore = snapshot(b), byteToken = b.keys.get(keys[0]), trace = [];
  let byteSide;
  const byteNext = byteOld.setMany([[keys[0], { toJSON() {
    trace.push(b.keyBytes); byteSide = byteOld.setMany([[keys[3], { side: true }]]); trace.push(b.keyBytes);
    byteSide = byteSide.setMany([['E', { finalByte: true }]]); trace.push(b.keyBytes); return { outer: true };
  } }]]);
  assert.deepEqual(trace, [196607, 262143, 262144]); assert.equal(b.keys.get(keys[0]), byteToken);
  const byteFull = byteNext.setMany([['', { empty: true }], ['F', { rejectedByte: true }], [keys[0], { cached: true }]]);
  assert.ok(b.keys.has('')); assert.equal(b.keys.has('F'), false); assert.equal(b.keys.size, 6); assert.equal(b.keyBytes, 262144);
  const never = 'Z'.repeat(262145), neverMap = byteFull.setMany([[never, { largeKey: true }]]);
  assert.equal(b.keys.has(never), false); assert.deepEqual(neverMap.get(never), { largeKey: true });
  assert.deepEqual(byteOld.get(keys[0]), { i: 0 }); assert.deepEqual(byteSide.get(keys[3]), { side: true });
  assert.deepEqual(byteNext.get(keys[0]), { outer: true }); unchanged(b, byteBefore);
  return { name: GROUPS[1], countBefore: 2047, countAfter: a.keys.size, reentrantByteCounts: trace,
    rejectedCountMiss: true, rejectedByteMiss: true, neverCacheableMiss: true, emptyAtByteCapAdmitted: true,
    countCache: summary(a), byteCache: summary(b) };
}

function unicode(S) {
  const [a, empty] = fresh(S, 'cached-key/unicode');
  const old = empty.set('\ud800', { old: true }), alias = a.keys.get('\ud800'), before = snapshot(a);
  assert.ok(alias); assert.equal(a.keys.has('\ufffd'), false); let discardedCalls = 0;
  const next = old.setMany([['\udc00', { toJSON() { discardedCalls++; throw new Error('deduplicated input evaluated'); } }],
    ['\ufffd', { latest: true }], ['', {}], ['\0', { nul: true }], ['\ufeff', { bom: true }], ['界🙂', { text: 'é' }]]);
  assert.equal(discardedCalls, 0); const normalized = a.keys.get('\ufffd'); assert.ok(normalized && normalized !== alias);
  assert.equal(a.keys.get('\ud800'), alias); assert.equal(a.keys.has('\udc00'), false);
  const repeat = next.setMany([['\ud800', { replaced: true }], ['界🙂', { text: 'next' }]]);
  assert.equal(a.keys.get('\ufffd'), normalized); unchanged(a, before);
  return { name: GROUPS[2], discardedCalls, exactAliasTokensDistinct: true,
    old: check(old, [['\ufffd', { old: true }]]), next: check(next, [['\ufffd', { latest: true }], ['', {}], ['\0', { nul: true }], ['\ufeff', { bom: true }], ['界🙂', { text: 'é' }]]),
    repeat: check(repeat, [['\ufffd', { replaced: true }], ['', {}], ['\0', { nul: true }], ['\ufeff', { bom: true }], ['界🙂', { text: 'next' }]]), cache: summary(a) };
}

function reentry(S) {
  const [a, empty] = fresh(S, 'cached-key/reentry');
  const old = empty.setMany([['hot', { n: 1 }], ['kept', { n: 2 }]]), before = snapshot(a), initialCapacity = a.memory.buffer.byteLength;
  const hot = a.keys.get('hot'), events = []; let side, asciiWinner, unicodeToken, unicodePointer;
  const next = old.setMany([
    ['hot', { toJSON() { events.push('hot'); side = old.delete('hot').set('hot', { side: true });
      side = side.set('growth', { text: 'g'.repeat(200000) }); assert.equal(a.keys.get('hot'), hot); return { outer: true }; } }],
    ['cold', { toJSON() { events.push('cold'); assert.equal(a.keys.has('cold'), false);
      side = side.setMany([['cold', { side: 'ascii' }]]); asciiWinner = a.keys.get('cold'); return { outer: 'ascii' }; } }],
    ['新', { toJSON() { events.push('unicode'); unicodeToken = a.keys.get('新'); assert.ok(unicodeToken); assert.equal(unicodeToken.ptr, undefined);
      side = side.setMany([['新', { side: 'unicode' }]]); unicodePointer = unicodeToken.ptr; assert.ok(unicodePointer !== undefined); return { outer: 'unicode' }; } }],
    ['getter', new Proxy({ get value() { events.push('getter'); return 7; } }, { get(target, key, receiver) {
      if (key === 'toJSON') events.push('proxy'); return Reflect.get(target, key, receiver);
    } })],
  ]);
  assert.deepEqual(events, ['hot', 'cold', 'unicode', 'proxy', 'getter']); assert.ok(a.memory.buffer.byteLength > initialCapacity);
  assert.equal(a.keys.get('cold'), asciiWinner); assert.equal(a.keys.get('新'), unicodeToken); assert.equal(unicodeToken.ptr, unicodePointer);
  assert.equal(a.keys.get('hot'), hot); assert.deepEqual(side.get('cold'), { side: 'ascii' }); assert.deepEqual(side.get('新'), { side: 'unicode' });
  assert.equal(side.get('growth').text.length, 200000); unchanged(a, before);
  const sentinel = new Error('cached key serialization stop'); let retained, caught;
  try { old.setMany([['hot', { toJSON() { retained = side.setMany([['retained', { ok: true }]]); throw sentinel; } }]]); } catch (error) { caught = error; }
  assert.equal(caught, sentinel); assert.deepEqual(retained.get('retained'), { ok: true }); assert.equal(a.keys.get('hot'), hot);
  const recovery = old.setMany([['hot', { recovery: true }]]); unchanged(a, before);
  return { name: GROUPS[3], events, initialCapacity, finalCapacity: a.memory.buffer.byteLength, thrownIdentityPreserved: true,
    asciiFirstInsertionWon: true, unicodePointerSetByReentry: true, sideResultRetained: true,
    old: check(old, [['hot', { n: 1 }], ['kept', { n: 2 }]]),
    next: check(next, [['hot', { outer: true }], ['kept', { n: 2 }], ['cold', { outer: 'ascii' }], ['新', { outer: 'unicode' }], ['getter', { value: 7 }]]),
    recovery: check(recovery, [['hot', { recovery: true }], ['kept', { n: 2 }]]), cache: summary(a) };
}

function oversized(S) {
  const results = []; let representative;
  for (const kind of ['map', 'ordered', 'sorted']) {
    const [a, empty] = fresh(S, `cached-key/oversized-${kind}`, 'object', kind);
    const old = empty.set('k', { old: true }), before = snapshot(a), token = a.keys.get('k'); assert.ok(token);
    let calls = 0, current = old; const sizes = [];
    for (const total of [49152, 49153]) {
      const record = { text: 'x'.repeat(total - 12) };
      assert.equal(new TextEncoder().encode(JSON.stringify(record)).length + 1, total);
      current = current.set('k', { toJSON() { calls++; return record; } });
      assert.equal(current.get('k').text.length, total - 12); assert.equal(current.size, 1);
      assert.deepEqual([...current.keys()], ['k']); assert.equal(a.keys.get('k'), token);
      sizes.push({ encodedKeyPlusValue: total, root: current.root, used: a.used });
    }
    assert.equal(calls, 2); unchanged(a, before); check(old, [['k', { old: true }]]);
    results.push({ kind, sizes, calls, tokenIdentityPreserved: true, cache: summary(a) });
    if (kind === 'map') representative = current;
  }
  return { group: { name: GROUPS[4], results }, fixture: representative };
}

function nested(S) {
  const [childArena, childEmpty] = fresh(S, 'cached-key/nested-child');
  const child = childEmpty.setMany([['one', { n: 1 }]]), changedChild = child.setMany([['one', { n: 2 }], ['two', { n: 3 }]]);
  const [a, empty] = fresh(S, 'cached-key/nested-parent', 'SharedMap<object>');
  const old = empty.setMany([['child', child]]), before = snapshot(a), token = a.keys.get('child');
  const next = old.setMany([['child', changedChild], ['alias', child]]);
  assert.equal(a.keys.get('child'), token); assert.equal(a.transportDependencies.get(childArena.id), childArena); unchanged(a, before);
  const rows = [check(old, [['child', child]]), check(next, [['child', changedChild], ['alias', child]])];
  assert.ok(Object.isFrozen(next.get('child'))); assert.ok(Object.isFrozen(next.get('child').get('one')));
  return { group: { name: GROUPS[5], rows, tokenIdentityPreserved: true, parent: summary(a), child: summary(childArena) }, fixtures: { nestedOld: old, nestedNext: next } };
}

function corpus(S) {
  const first = basic(S), limits = budgets(S), aliases = unicode(S), callbacks = reentry(S), large = oversized(S), children = nested(S);
  return { groups: [first.group, limits, aliases, callbacks, large.group, children.group],
    fixtures: { ...first.fixtures, ...children.fixtures, oversized: large.fixture } };
}

function request(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Cached-key worker timed out')), 10000);
    const receive = result => result.type === 'error' ? finish(new Error(result.error)) : finish(null, result);
    const fail = error => finish(error), exit = code => finish(new Error(`Worker exited before replying (${code})`));
    function finish(error, value) { clearTimeout(timer); worker.off('message', receive); worker.off('error', fail); worker.off('exit', exit); error ? reject(error) : resolve(value); }
    worker.once('message', receive); worker.once('error', fail); worker.once('exit', exit);
    try { worker.postMessage(message); } catch (error) { finish(error); }
  });
}
function checkArenaRows(actual, expected, stage) {
  const diagnostic = `${stage}: ${JSON.stringify({ expected, actual })}`, byID = new Map(expected.map(row => [row.id, row]));
  assert.equal(byID.size, expected.length, diagnostic); assert.equal(actual.length, expected.length, diagnostic);
  const seen = new Set();
  for (const row of actual) {
    assert.ok(!seen.has(row.id) && byID.has(row.id), diagnostic); seen.add(row.id);
    assert.deepEqual(row, byID.get(row.id), diagnostic);
  }
}
const arenaRows = snapshots => snapshots.map(item => ({ id: item.id, capacity: item.memory.buffer.byteLength, used: item.used,
  prefixSHA256: sha(new Uint8Array(item.memory.buffer, 65536, item.used - 65536)) }));
function readerView(map) {
  const entries = logical(map), callbacks = [];
  map.forEach((value, key) => callbacks.push([key, valueView(value)])); assert.deepEqual(callbacks.sort(byKey), entries);
  for (const [key, value] of entries) assert.deepEqual(valueView(map.get(key)), value);
  assert.equal(map.size, entries.length);
  return { root: map.root, size: map.size, entriesSHA256: sha(JSON.stringify(entries)) };
}
async function workers(S, moduleURL, items) {
  const expected = Object.fromEntries(Object.entries(items).map(([name, item]) => [name, readerView(item)])), results = [];
  for (const copy of [false, true]) {
    const payload = S.getWorkerData(items, { copy });
    assert.ok(payload.arenas.every(item => copy ? item.copy && !item.memory : item.memory && !item.copy));
    const originals = S.getWorkerData(items, { copy: false }).arenas.map(item => ({ id: item.id, memory: item.memory, used: item.used,
      bytes: Buffer.from(new Uint8Array(item.memory.buffer).slice(65536, item.used)) }));
    const initialRows = payload.arenas.map(item => ({ id: item.id,
      capacity: copy ? Math.max(2, Math.ceil(item.copy.byteLength / 65536)) * 65536 : item.memory.buffer.byteLength,
      used: item.used, prefixSHA256: sha(copy ? item.copy.subarray(65536, item.used) : new Uint8Array(item.memory.buffer, 65536, item.used - 65536)) }));
    const transportDiagnostics = { structureIDs: Object.entries(payload.structures).map(([name, item]) => [name, item.arena]), stages: [] };
    function checkStage(stage, observed) {
      const expectedRows = stage === 'attach' || copy ? initialRows : arenaRows(originals);
      checkArenaRows(observed, expectedRows, `${copy ? 'copy' : 'shared'} ${stage}`);
      transportDiagnostics.stages.push({ stage, expected: expectedRows, observed });
    }
    const worker = new Worker(new URL(import.meta.url), { workerData: { moduleURL } });
    try {
      const attached = await request(worker, { type: 'attach', data: payload });
      assert.equal(attached.type, 'created'); assert.equal(attached.workerThread, true); checkStage('attach', attached.arenas);
      assert.deepEqual(attached.structureIDs, transportDiagnostics.structureIDs); transportDiagnostics.observedStructureIDs = attached.structureIDs;
      const a = arena(items.next), capacityBefore = a.memory.buffer.byteLength;
      const newer = items.next.setMany([['writer-growth', { text: 'w'.repeat(capacityBefore + 65536) }]]);
      assert.ok(a.memory.buffer.byteLength > capacityBefore); assert.equal(items.next.has('writer-growth'), false);
      assert.equal(newer.get('writer-growth').text.length, capacityBefore + 65536);
      const reply = await request(worker, { type: 'resume' });
      assert.equal(reply.type, 'done'); assert.deepEqual(reply.result, expected); checkStage('resume', reply.arenas);
      assert.equal(reply.allocatedSharedBytes, 0); assert.equal(reply.frozenObjects, true); assert.equal(reply.serializationCalls, 0);
      assert.equal(reply.readOnlyRejections, Object.keys(items).length);
      for (const item of originals) assert.deepEqual(Buffer.from(new Uint8Array(item.memory.buffer, 65536, item.bytes.length)), item.bytes);
      results.push({ copy, workerThread: true, snapshots: Object.keys(items).length, result: reply.result,
        allocatedSharedBytes: 0, frozenObjects: true, serializationCalls: 0, readOnlyRejections: reply.readOnlyRejections,
        readerObservedWriterGrowth: !copy, transportDiagnostics });
    } finally { await worker.terminate(); }
  }
  return results;
}
if (!isMainThread) {
  const S = await import(workerData.moduleURL); let items, pending, snapshots;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'attach') {
        assert.ok(threadId > 0); items = await S.initWorker(message.data);
        pending = Object.fromEntries(Object.entries(items).map(([name, item]) => [name, item.entries()]));
        const structureIDs = Object.entries(items).map(([name, item]) => [name, arena(item).id]);
        assert.deepEqual(structureIDs, Object.entries(message.data.structures).map(([name, item]) => [name, item.arena]));
        snapshots = S.getWorkerData(items, { copy: false }).arenas.map(item => ({ id: item.id, memory: item.memory, used: item.used,
          bytes: Buffer.from(new Uint8Array(item.memory.buffer).slice(65536, item.used)) }));
        parentPort.postMessage({ type: 'created', workerThread: true, arenas: arenaRows(snapshots), structureIDs });
      } else if (message.type === 'resume') {
        const result = {}; let readOnlyRejections = 0, serializationCalls = 0;
        for (const [name, item] of Object.entries(items)) {
          const held = [...pending[name]].map(([key, value]) => [key, valueView(value)]).sort(byKey);
          assert.deepEqual(held, logical(item)); result[name] = readerView(item);
          assert.throws(() => item.set('forbidden', { toJSON() { serializationCalls++; return {}; } }), /read-only/);
          readOnlyRejections++;
        }
        for (const value of items.next.values()) assert.ok(Object.isFrozen(value));
        assert.ok(Object.isFrozen(items.nestedNext.get('child'))); assert.ok(Object.isFrozen(items.nestedNext.get('child').get('one')));
        const after = S.getWorkerData(items, { copy: false }).arenas;
        checkArenaRows(after.map(item => ({ id: item.id, used: item.used })), snapshots.map(item => ({ id: item.id, used: item.used })), 'reader arena allocation');
        for (const item of snapshots) assert.deepEqual(Buffer.from(new Uint8Array(item.memory.buffer, 65536, item.bytes.length)), item.bytes);
        parentPort.postMessage({ type: 'done', result, allocatedSharedBytes: 0, frozenObjects: true, serializationCalls,
          readOnlyRejections, arenas: arenaRows(snapshots) });
      } else throw new Error('Unknown cached-key worker message');
    } catch (error) { parentPort.postMessage({ type: 'error', error: String(error.stack ?? error) }); }
  });
} else {
  const [entry, engine, output] = process.argv.slice(2);
  assert.ok(entry && output); assert.ok(['bun-source', 'node-portable'].includes(engine));
  const moduleURL = pathToFileURL(entry).href, S = await import(moduleURL), result = corpus(S);
  const report = { schema: 1, kind: 'cached-key-write-correctness', engine, groups: result.groups,
    workers: engine === 'node-portable' ? await workers(S, moduleURL, result.fixtures) : [] };
  const raw = JSON.stringify(report, null, 2) + '\n'; writeFileSync(output, raw, { flag: 'wx' });
  console.log(JSON.stringify({ schema: 1, kind: report.kind, engine, passed: true, groups: GROUPS, workerCases: report.workers.length, outputSHA256: sha(raw) }));
}
