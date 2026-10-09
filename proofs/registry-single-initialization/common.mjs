import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';

export const emit = event => writeSync(1, `${JSON.stringify(event)}\n`);
export async function settleGc() {
  assert.equal(typeof globalThis.gc, 'function', '--expose-gc is required');
  // WeakRef targets remain alive in the job that created/dereferenced them.
  // Leave that job before each collection and do not dereference in this loop.
  for (let round = 0; round < 3; round++) {
    await setImmediate();
    for (let pass = 0; pass < 3; pass++) globalThis.gc();
  }
}

export async function modules(root) {
  const files = readdirSync(join(root, 'dist')).filter(file => file.endsWith('.js') && /class Arena\s*\{/.test(readFileSync(join(root, 'dist', file), 'utf8')));
  assert.equal(files.length, 1, 'Exactly one emitted Arena module is required');
  const arena = await import(pathToFileURL(join(root, 'dist', files[0])).href);
  const S = await import(pathToFileURL(join(root, 'dist/shared.js')).href);
  assert.equal(typeof arena.Arena, 'function');
  assert.equal(typeof arena.arenaOf, 'function');
  return { ...arena, S };
}

export function fixture(S, count, copy) {
  assert([1, 512].includes(count));
  S.configureMemory({ maximumBytes: 131072 });
  const leaves = [];
  for (let i = 0; i < Math.max(1, count - 1); i++) {
    S.resetMap(); leaves.push(new S.SharedMap('number').set('value', i));
  }
  if (count > 1) {
    S.configureMemory({ maximumBytes: Math.max(131072, Math.ceil((65536 + count * 1024) / 65536) * 65536) });
    S.resetMap();
  }
  const root = new S.SharedMap('SharedMap<number>').setMany(leaves.map((leaf, i) => [`leaf${i}`, leaf]));
  const source = { root }, data = S.getWorkerData(source, { copy });
  assert.equal(data.arenas.length, count);
  return { source, data, leaves, keys: leaves.map((_, i) => `leaf${i}`) };
}

export function checkReads(S, attached, setup, copy) {
  let sum = 0;
  for (let i = 0; i < setup.keys.length; i++) {
    const value = attached.root.get(setup.keys[i]).get('value');
    assert.equal(value, i); sum += value;
  }
  assert.throws(() => attached.root.get(setup.keys[0]).set('value', -1), /read-only/);
  assert.throws(() => attached.root.set('forbidden', setup.leaves[0]), /read-only/);
  assert.equal(S.getWorkerData(attached, { copy }).arenas.length, setup.data.arenas.length);
  return { checkedLeaves: setup.keys.length, sum, rootAndNestedReadOnly: true, reexportArenas: setup.data.arenas.length };
}

export function dependencyMap(arena) {
  // Never access the candidate's materializing dependencies getter here.
  return Object.hasOwn(arena, 'dependencyLookup') ? arena.dependencyLookup : arena.dependencies;
}

export function ownLayout(arena) {
  const names = Object.getOwnPropertyNames(arena);
  assert.equal(Object.getOwnPropertySymbols(arena).length, 0);
  const slots = names.map((name, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(arena, name);
    assert(Object.hasOwn(descriptor, 'value'), `Unexpected accessor own property: ${name}`);
    return { index, name, writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable };
  });
  return { count: names.length, slots, physicalObjectSize: null, physicalInObjectSlots: null, physicalLayoutInspected: false };
}

export function topology(owner, data, role) {
  const arenas = [...new Set([owner, ...dependencyMap(owner).values()])];
  const byId = new Map(arenas.map(arena => [arena.id, arena]));
  assert.equal(arenas.length, data.arenas.length);
  const ordered = data.arenas.map(source => byId.get(source.id));
  assert(ordered.every(Boolean));
  const lookups = [...new Set(ordered.map(dependencyMap))];
  const shared = role !== 'main' && ordered.length > 1;
  assert.equal(lookups.length, shared ? 1 : ordered.length);
  const expectedEntries = shared ? ordered.length : ordered.length - 1;
  for (const arena of ordered) {
    assert.equal(arena.readOnly, true);
    const map = dependencyMap(arena);
    assert.equal(map.size, expectedEntries);
    for (const other of ordered) assert.equal(map.get(other.id), shared || other !== arena ? other : undefined);
    if (role !== 'main') {
      assert.equal(arena.transportDependencies, map);
      assert.equal(arena.hasSharedDependencies, shared);
      if (shared) assert.deepEqual(arena.sharedDependencyMembers, ordered);
      else assert.equal(arena.sharedDependencyMembers, undefined);
    }
  }
  const layout = ownLayout(owner);
  for (const arena of ordered) assert.deepEqual(ownLayout(arena), layout);
  return { arenas: ordered, lookups, summary: {
    arenaCount: ordered.length, distinctDependencyMaps: lookups.length,
    dependencyEntries: lookups.reduce((sum, map) => sum + map.size, 0),
    selfEntries: ordered.filter(arena => dependencyMap(arena).get(arena.id) === arena).length,
    sharedRegistry: shared, layout,
  } };
}

export async function runSubject(work) {
  const request = JSON.parse(process.argv[2]);
  emit({ event: 'start', request, pid: process.pid, versions: process.versions, arch: process.arch, platform: process.platform, execArgv: process.execArgv });
  try {
    const result = await work(request);
    emit({ event: 'result', request, result });
  } catch (error) {
    emit({ event: 'failure', request, error: { name: error.name, message: error.message, stack: error.stack } });
    process.exitCode = 1;
  }
}
