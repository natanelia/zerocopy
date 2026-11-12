import { KINDS, deepFreeze } from './feature-core.mjs';

/** Load only the chosen representation. Native replicas do not load the WASM engine. */
export async function createStorage(kind) {
  if (!KINDS.includes(kind)) throw new RangeError('Unknown feature map kind');
  const api = kind === 'shared' ? await import('../library/shared.js') : undefined;
  const immutable = kind === 'immutable' ? await import('../vendor/immutable.mjs') : undefined;
  const immer = kind === 'immer' ? await import('../vendor/immer.mjs') : undefined;
  immer?.enableMapSet();
  const freezeEntries = entries => { for (const [, value] of entries) deepFreeze(value); return entries; };
  function update(map, entries, retained) {
    freezeEntries(entries);
    if (kind === 'shared') return map.setMany(entries);
    if (kind === 'immutable') return map.withMutations(next => { for (const [key, value] of entries) next.set(key, value); });
    if (kind === 'immer') return immer.produce(map, next => { for (const [key, value] of entries) next.set(key, value); });
    // This application retains only the initial and current revisions. Once
    // current has separated from initial, native can update its own Map safely.
    const next = map === retained ? new Map(map) : map;
    for (const [key, value] of entries) next.set(key, value); return next;
  }
  function build(entries) {
    freezeEntries(entries);
    if (kind === 'shared') return new api.SharedMap('object').setMany(entries);
    if (kind === 'immutable') return immutable.Map(entries);
    if (kind === 'immer') return immer.produce(new Map(), next => { for (const [key, value] of entries) next.set(key, value); });
    return new Map(entries);
  }
  function payload(map) {
    if (kind !== 'shared') return kind === 'immutable' ? map.entrySeq().toArray() : map;
    const value = api.getWorkerData({ features: map }, { copy: false });
    if (value.arenas.some(arena => arena.copy || !(arena.memory?.buffer instanceof SharedArrayBuffer))) throw new Error('Shared memory is required; no copy fallback');
    return value;
  }
  async function attach(value) {
    if (kind === 'shared') return (await api.initWorker(value)).features;
    if (kind === 'immutable') return build(value);
    if (!(value instanceof Map)) throw new TypeError('Expected a cloned native Map');
    for (const record of value.values()) deepFreeze(record);
    return kind === 'immer' ? immer.freeze(value, true) : value;
  }
  function arenas(map, retained) {
    if (kind !== 'shared') return [];
    const seen = new Map(), pending = [map, retained].filter(Boolean).map(value => value.arena);
    while (pending.length) {
      const arena = pending.pop();
      if (!(arena.memory.buffer instanceof SharedArrayBuffer)) throw new Error('Expected shared arena');
      const previous = seen.get(arena.id);
      if (previous) {
        if (previous.capacityBytes !== arena.memory.buffer.byteLength) throw new Error('Shared arena capacities disagree');
        previous.usedBytes = Math.max(previous.usedBytes, arena.used);
        continue;
      }
      seen.set(arena.id, { id: arena.id, usedBytes: arena.used, capacityBytes: arena.memory.buffer.byteLength, readOnly: arena.readOnly });
      pending.push(...arena.dependencies.values());
    }
    return [...seen.values()];
  }
  return { kind, build, update, payload, attach, arenas };
}
