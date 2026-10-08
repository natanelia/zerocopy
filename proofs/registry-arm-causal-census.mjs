// Imported only in untimed census processes; never by pilots/timing/trace runs.
import assert from 'node:assert/strict';
export function observeMaterializedMaps(Arena) {
  const descriptor = Object.getOwnPropertyDescriptor(Arena.prototype, 'dependencies'), refs = [];
  if (descriptor?.get) Object.defineProperty(Arena.prototype, 'dependencies', {
    ...descriptor, get() { const map = descriptor.get.call(this); refs.push(new WeakRef(map)); return map; },
  });
  return {
    restore() { if (descriptor?.get) Object.defineProperty(Arena.prototype, 'dependencies', descriptor); },
    afterGC(treatment) {
      const alive = refs.filter(ref => ref.deref() !== undefined).length;
      assert.equal(refs.length, treatment === 'native' ? 0 : 512);
      assert.equal(alive, treatment === 'materialized' ? 512 : 0);
      return { weakRefs: refs.length, alive, cleared: refs.length - alive };
    },
  };
}
export function census({ Arena, arenaOf, retained, source, keys, kept }) {
  const counts = {}, labels = new WeakMap(), restore = [];
  const owner = arenaOf(retained.root), lookup = Object.hasOwn(owner, 'dependencyLookup') ? 'dependencyLookup' : 'dependencies';
  for (const arena of kept.arenas) {
    labels.set(arena[lookup], 'dependency');
    for (const key of ['objects', 'keys', 'strings', 'valueMap']) if (arena[key]) labels.set(arena[key], key);
    if (arena.reads) labels.set(arena.reads.slots, 'readSlots');
  }
  let active = false;
  const bump = key => { if (active) counts[key] = (counts[key] ?? 0) + 1; };
  for (const name of ['value', 'find', 'findUncached', 'leafValue', 'decodeAt', 'decode', 'refresh', 'readPrimitive', 'cacheRead']) {
    const method = Arena.prototype[name];
    Arena.prototype[name] = function (...args) { bump('Arena.' + name); return method.apply(this, args); };
    restore.push(() => Arena.prototype[name] = method);
  }
  for (const name of ['dependencies', 'transportDependencies', 'sharedDependencyMembers', 'hasSharedDependencies']) {
    const descriptor = Object.getOwnPropertyDescriptor(Arena.prototype, name);
    if (!descriptor?.get) continue;
    Object.defineProperty(Arena.prototype, name, { ...descriptor, get() { bump('getter.' + name); return descriptor.get.call(this); } });
    restore.push(() => Object.defineProperty(Arena.prototype, name, descriptor));
  }
  for (const name of ['get', 'has', 'set', 'delete']) {
    const method = Map.prototype[name];
    Map.prototype[name] = function (...args) { bump('Map.' + (labels.get(this) ?? 'unlabelled') + '.' + name); return method.apply(this, args); };
    restore.push(() => Map.prototype[name] = method);
  }
  const parse = JSON.parse;
  JSON.parse = function (...args) { bump('JSON.parse'); return parse.apply(this, args); };
  restore.push(() => JSON.parse = parse);
  const iterations = keys.length * 2; let total = 0;
  try {
    active = true;
    for (let i = 0; i < iterations; i++) total += retained.root.get(keys[i % keys.length]).get('value');
  } finally { active = false; for (const fn of restore.reverse()) fn(); }
  assert.equal(total, keys.length * (keys.length - 1));
  assert.deepEqual(counts, {
    'Arena.value': iterations * 2, 'Map.readSlots.get': iterations * 3,
    'Arena.find': iterations, 'Arena.leafValue': iterations, 'Arena.refresh': iterations,
    'Arena.decodeAt': iterations, 'Map.objects.get': iterations, 'Map.valueMap.get': iterations,
  });
  assert.equal(owner.objects.size, 511); assert.equal(owner.reads.slots.size, 511);
  assert.equal(kept.arenas.filter(arena => arena.valueMap?.has('value')).length, 511);
  const fields = Object.keys(owner);
  assert.equal(fields.length, 37);
  assert.equal(fields.indexOf(lookup), 4); assert.equal(fields.indexOf('reads'), 11);
  assert.equal(fields.indexOf('valueMap'), 19); assert.equal(fields.indexOf('objects'), 22);
  // V8 diagnostic output goes to stdout, separate from the fd3 JSONL evidence.
  const debug = new Function('value', '%DebugPrint(value);');
  console.log('ROOT_ARENA'); debug(owner);
  console.log('CHILD_ARENA'); debug(arenaOf(retained.root.get(keys[0])));
  console.log('WRITER_ARENA'); debug(arenaOf(source.root));
  return { iterations, counts, fields, cache: { objects: owner.objects.size, readSlots: owner.reads.slots.size, childValueMaps: 511 }, wrappersRestored: true };
}
