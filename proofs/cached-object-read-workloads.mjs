import assert from 'node:assert/strict';
import { hash, jsonHash, workload } from './cached-object-read-protocol.mjs';

// This is the only private setup access. It runs before fixture publication.
// No Arena export, prototype changes, cache clearing, instrumentation or direct
// Arena read is used by a measured loop.
function arenaConstructor(api) {
  const probe = new api.SharedMap('number');
  const arena = Reflect.get(probe, 'arena');
  assert.ok(arena && typeof arena.constructor === 'function');
  assert.ok(typeof arena.copy === 'function');
  return arena.constructor;
}
function empty(api, kind, type, arena) {
  if (kind === 'map') return new api.SharedMap(type, 0, undefined, arena);
  if (kind === 'ordered') return new api.SharedOrderedMap(type, 0, 0, 0, undefined, arena);
  if (kind === 'sorted') return new api.SharedSortedMap(type, undefined, 0, undefined, arena);
  throw new Error('unknown kind');
}
const keyFor = i => 'k' + String(i).padStart(6, '0');
const objectFor = i => ({ index: i + 1, enabled: (i & 1) === 0, meta: { label: 'v' + String(i).padStart(6, '0') } });
function inputFor(codec, i, api, innerArena) {
  if (codec === 'object') return objectFor(i);
  if (codec === 'number') return i + 1;
  if (codec === 'string') return 'value:' + String(i).padStart(6, '0');
  return empty(api, 'map', 'number', innerArena).set('v', i + 1);
}
function outputFor(value, codec, missing) {
  if (missing) { assert.equal(value, undefined); return null; }
  if (codec === 'object') {
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.meta));
    return value;
  }
  if (codec === 'nested') {
    assert.ok(Object.isFrozen(value));
    return { descriptor: value.toWorkerData(), value: value.get('v') };
  }
  return value;
}
function transportDigest(api, structures) {
  const packet = api.getWorkerData(structures, { copy: true });
  assert.equal(packet.__shared, true); assert.equal(packet.version, 4);
  return {
    version: packet.version,
    arenas: packet.arenas.map(a => {
      assert.ok(a.copy instanceof Uint8Array);
      assert.equal(a.used, a.copy.length);
      return { id: a.id, used: a.used, bytesSha256: hash(a.copy) };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    structures: packet.structures,
    descriptorSha256: jsonHash(packet.structures),
  };
}
export function buildFixture(api, id) {
  const spec = workload(id);
  const Arena = arenaConstructor(api);
  const outer = new Arena({ id: 'cached-object-read-v1/' + id + '/outer' });
  const inner = spec.codec === 'nested' ? new Arena({ id: 'cached-object-read-v1/' + id + '/inner' }) : undefined;
  const fixtureKey = i => spec.addressSaturated && i < 512 ? ('prefill:' + String(i).padStart(6, '0')).padEnd(256, 'x') : keyFor(i);
  const type = spec.codec === 'nested' ? api.map('number') : spec.codec;
  let map = empty(api, spec.kind, type, outer);
  const inputs = Array.from({ length: spec.size }, (_, i) => inputFor(spec.codec, i, api, inner));
  for (let i = 0; i < spec.size; i++) map = map.set(fixtureKey(i), inputs[i]);
  assert.equal(map.size, spec.size);
  let fork;
  if (spec.alternate) {
    fork = map;
    for (let i = 0; i < spec.size; i++) fork = fork.set(keyFor(i), objectFor(i + 10000));
    assert.notEqual(map.root, fork.root);
    assert.equal(fork.size, spec.size);
  }
  const structures = fork ? { map, fork } : { map };
  const before = transportDigest(api, structures);
  assert.deepEqual(before.arenas.map(a => a.id), [
    ...(inner ? ['cached-object-read-v1/' + id + '/inner'] : []),
    'cached-object-read-v1/' + id + '/outer',
  ]);
  // Prewarm in ascending order. In the pressure case this fills exactly the
  // first 2048 decoded-object entries before any read of the final 512.
  const warmed = [];
  for (let i = 0; i < spec.size; i++) {
    const value = map.get(fixtureKey(i));
    const output = outputFor(value, spec.codec, false);
    if (spec.codec === 'nested') assert.equal(output.value, i + 1);
    else assert.deepEqual(output, inputs[i]);
    warmed.push(output);
  }
  if (fork) for (let i = 0; i < spec.size; i++) assert.deepEqual(fork.get(keyFor(i)), objectFor(i + 10000));
  if (spec.addressSaturated) {
    assert.equal(Array.from({ length: 512 }, (_, i) => fixtureKey(i)).reduce((sum, key) => sum + key.length, 0), 131072);
    assert.equal(new Set(Array.from({ length: 512 }, (_, i) => fixtureKey(i))).size, 512);
    // Source guard pins MAX_CHARS=131072 and admission semantics. Ascending
    // public prewarm consumes that address budget before any short-key get.
    for (let i = 512; i < 1024; i++) {
      const value = map.get(fixtureKey(i));
      assert.equal(map.get(fixtureKey(i)), value, 'decoded measured objects remain cached');
    }
  }
  if (spec.saturated) {
    const cached = map.get(keyFor(0));
    assert.equal(map.get(keyFor(0)), cached, 'first 2048 decoded objects are retained');
    const tail = map.get(keyFor(2048));
    assert.notEqual(map.get(keyFor(2048)), tail, 'tail decoding allocates beyond the 2048-entry object cache');
  } else if (spec.codec === 'object' || spec.codec === 'nested') {
    for (let i = 0; i < spec.size; i++) {
      const value = map.get(fixtureKey(i));
      assert.equal(map.get(fixtureKey(i)), value, 'target decoded values are warm');
    }
  }
  // Fixed odd permutation visits all 512 keys. The one-entry controls issue
  // 512 repeated gets per sweep, rather than timing a one-iteration loop.
  const indices = Array.from({ length: 512 }, (_, i) => spec.size === 1 ? 0
    : ((i * 73) & 511) + (spec.saturated ? 2048 : spec.addressSaturated ? 512 : 0));
  const keys = indices.map(i => spec.missing ? 'absent:' + keyFor(i) : fixtureKey(i));
  if (spec.missing) for (const key of keys) assert.equal(map.get(key), undefined);
  let expectedPerSweep;
  if (spec.missing) expectedPerSweep = 512;
  else if (spec.codec === 'string') expectedPerSweep = indices.reduce((sum, i) => sum + inputs[i].length, 0);
  else if (spec.codec === 'nested') expectedPerSweep = indices.reduce((sum, i) => sum + inputs[i].size + inputs[i].root, 0);
  else expectedPerSweep = indices.reduce((sum, i) => sum + i + 1 + (fork ? i + 10001 : 0), 0);
  // Separate closures keep measured inner-loop work explicit and identical
  // between source roles. The only collection operation here is public get.
  let run;
  if (spec.missing) run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) sink += map.get(keys[i]) === undefined ? 1 : 0;
    return sink;
  };
  else if (fork) run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) {
      sink += map.get(keys[i]).index; sink += fork.get(keys[i]).index;
    }
    return sink;
  };
  else if (spec.codec === 'object') run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) sink += map.get(keys[i]).index;
    return sink;
  };
  else if (spec.codec === 'nested') run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) {
      const value = map.get(keys[i]); sink += value.size + value.root;
    }
    return sink;
  };
  else if (spec.codec === 'number') run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) sink += map.get(keys[i]);
    return sink;
  };
  else run = sweeps => {
    let sink = 0;
    for (let r = 0; r < sweeps; r++) for (let i = 0; i < 512; i++) sink += map.get(keys[i]).length;
    return sink;
  };
  const fixture = {
    spec, transport: before, keySequenceSha256: jsonHash(keys), outputSha256: jsonHash(warmed),
    forkOutputSha256: fork ? jsonHash(Array.from({ length: 512 }, (_, i) => objectFor(i + 10000))) : null,
    opsPerSweep: fork ? 1024 : 512, expectedPerSweep,
  };
  const verify = () => {
    assert.deepEqual(transportDigest(api, structures), before, 'published bytes and descriptors changed');
    return jsonHash(fixture);
  };
  assert.equal(run(1), expectedPerSweep, 'complete fixed-loop public-get check');
  verify();
  return Object.freeze({ run, verify, fixture, fixtureDigest: jsonHash(fixture),
    expectedPerSweep, opsPerSweep: fixture.opsPerSweep });
}
