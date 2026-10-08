/** Shared correctness protocol for Node and real browser module workers. */
export const ARENA_PROTOCOL = 'zerocopy/worker-arena-proof/v1';
export const ARENA_COUNTS = [1, 2, 49];
const HEADER_WORD = 60000; // Test-only scratch below the published data heap.
function check(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) { check(Object.is(actual, expected), `${message}: ${actual} !== ${expected}`); }
function blocked(action) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  check(error && /read-only/.test(String(error)), 'Attached mutation was not rejected');
}
function rootTransport(data) {
  const source = data.arenas.find(arena => arena.id === data.structures.root.arena);
  check(source, 'Missing root transport'); return source;
}
export function transportMarker(data) {
  const source = rootTransport(data);
  return source.copy ? new DataView(source.copy.buffer, source.copy.byteOffset).getInt32(HEADER_WORD, true)
    : Atomics.load(new Int32Array(source.memory.buffer, HEADER_WORD, 1), 0);
}
function writeTransportMarker(data, marker) {
  const source = rootTransport(data);
  if (source.copy) new DataView(source.copy.buffer, source.copy.byteOffset).setInt32(HEADER_WORD, marker, true);
  else Atomics.store(new Int32Array(source.memory.buffer, HEADER_WORD, 1), 0, marker);
}
export function checkArenaTransport(data, copy, arenas) {
  equal(data?.version, 4, 'Wire version'); equal(data.__shared, true, 'Wire marker');
  equal(data.arenas.length, arenas, 'Arena count');
  equal(data.structures.root.arena, data.structures.alias.arena, 'Alias arena');
  equal(data.structures.root.data.root, data.structures.alias.data.root, 'Alias root');
  for (const source of data.arenas) {
    if (copy) check(source.copy instanceof Uint8Array && source.copy.buffer instanceof ArrayBuffer && !source.memory, 'Expected copied transport only');
    else check(source.memory instanceof WebAssembly.Memory && source.memory.buffer instanceof SharedArrayBuffer && !source.copy, 'Expected shared transport only');
  }
}
export function createArenaProducer(api, arenas) {
  check(Number.isInteger(arenas) && arenas >= 1, 'Invalid arena count');
  api.configureMemory({ maximumBytes: 131072 }); // Bounded reservations; fixtures fit in two pages.
  const leafCount = Math.max(1, arenas - 1), leaves = [];
  for (let i = 0; i < leafCount; i++) { api.resetMap(); leaves.push(new api.SharedMap('number')); }
  if (arenas > 1) api.resetMap();
  let root = new api.SharedMap('SharedMap<number>');
  return offset => {
    for (let i = 0; i < leaves.length; i++) leaves[i] = leaves[i].set('value', offset + i);
    root = root.setMany(leaves.map((leaf, i) => [`leaf${i}`, leaf]));
    return { root, alias: root };
  };
}
export function checkArenaReader(reader, offset, arenas, readCount = Math.max(1, arenas - 1)) {
  equal(reader.root.size, Math.max(1, arenas - 1), 'Root size');
  for (let i = 0; i < readCount; i++) {
    const leaf = reader.root.get(`leaf${i}`);
    equal(leaf.get('value'), offset + i, 'Nested value');
    equal(reader.root.get(`leaf${i}`), leaf, 'Repeated nested identity');
    equal(reader.alias.get(`leaf${i}`), leaf, 'Nested identity through root alias');
    blocked(() => leaf.set('value', -1));
  }
  blocked(() => reader.root.set('illegal', null));
}
export function createArenaWorkerProtocol(api) {
  let retained, configuration, initialIds, nextGeneration = 0;
  return async message => {
    const { protocol, data, offset, copy, arenas, generation, marker } = message;
    equal(protocol, ARENA_PROTOCOL, 'Protocol'); equal(generation, nextGeneration, 'Generation');
    equal(offset, generation * 100, 'Offset');
    check(typeof copy === 'boolean' && [0, 1].includes(generation), 'Invalid scenario');
    checkArenaTransport(data, copy, arenas);
    const ids = JSON.stringify(data.arenas.map(arena => arena.id).sort());
    const config = `${arenas}/${copy}`;
    if (configuration) { equal(config, configuration, 'Worker scenario'); equal(ids, initialIds, 'Retained arena IDs'); }
    else { configuration = config; initialIds = ids; }
    const beforeMarker = transportMarker(data);
    const current = await api.initWorker(data);
    if (retained) checkArenaReader(retained, 0, arenas);
    // The final old leaf stays unread until after the second attachment.
    checkArenaReader(current, offset, arenas, retained ? Math.max(1, arenas - 1) : Math.max(1, arenas - 1) - 1);
    retained ??= current;
    // Shared writes must reach the producer. Copied transport writes must affect
    // neither the producer copy nor the reader memory already initialized above.
    writeTransportMarker(data, marker);
    const forwarded = api.getWorkerData(current, { copy });
    checkArenaTransport(forwarded, copy, arenas);
    equal(transportMarker(forwarded), copy ? beforeMarker : marker, 'Forwarded backing mode');
    nextGeneration++;
    return { protocol, generation, arenas, copy, offset, data: forwarded, retainedChecked: generation === 1, deferredOldRead: generation === 1, beforeMarker };
  };
}
export async function runArenaScenario(api, exchange, arenas, copy) {
  const produce = createArenaProducer(api, arenas);
  let firstIds, retained;
  for (const generation of [0, 1]) {
    const offset = generation * 100, data = api.getWorkerData(produce(offset), { copy });
    checkArenaTransport(data, copy, arenas);
    const ids = JSON.stringify(data.arenas.map(arena => arena.id).sort());
    if (firstIds) equal(ids, firstIds, 'Producer arena IDs'); else firstIds = ids;
    const beforeMarker = transportMarker(data), marker = 1000 + generation;
    const reply = await exchange({ protocol: ARENA_PROTOCOL, generation, data, offset, copy, arenas, marker });
    if (reply.error) throw new Error(reply.error);
    equal(reply.protocol, ARENA_PROTOCOL, 'Reply protocol'); equal(reply.generation, generation, 'Reply generation');
    equal(reply.arenas, arenas, 'Reply arena count'); equal(reply.copy, copy, 'Reply transport mode');
    equal(transportMarker(data), copy ? beforeMarker : marker, 'Producer backing mode');
    checkArenaTransport(reply.data, copy, arenas);
    const restored = await api.initWorker(reply.data); checkArenaReader(restored, offset, arenas);
    if (retained) checkArenaReader(retained, 0, arenas);
    retained ??= restored;
    if (generation === 1) check(reply.retainedChecked && reply.deferredOldRead, 'Worker did not verify the old cold nested value');
  }
  return { arenas, copy, generations: 2, reexport: true, retained: true, aliases: true, nestedReadOnly: true, repeatedArenaIds: true, deferredOldRead: true, backingModeVerified: true };
}
