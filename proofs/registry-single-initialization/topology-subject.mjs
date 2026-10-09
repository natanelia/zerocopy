import assert from 'node:assert/strict';
import { modules, fixture, runSubject, settleGc, topology, ownLayout, dependencyMap, checkReads } from './common.mjs';

await runSubject(async ({ root, role, mode, count, copy }) => {
  const { Arena, arenaOf, S } = await modules(root);
  S.configureMemory({ maximumBytes: 131072 });
  if (mode === 'owned') {
    const owned = Array.from({ length: count }, () => new Arena());
    const layout = ownLayout(owned[0]);
    const maps = new Set(owned.map(dependencyMap));
    assert.equal(maps.size, count);
    for (const arena of owned) {
      assert.deepEqual(ownLayout(arena), layout);
      assert.equal(arena.readOnly, false);
      assert.equal(dependencyMap(arena).size, 0);
      assert.doesNotThrow(() => arena.assertWritable());
      if (role !== 'main') assert.equal(arena.hasSharedDependencies, false);
    }
    const refs = owned.map(arena => new WeakRef(arena));
    globalThis.__registryProbeKeep = { owned };
    await settleGc();
    assert.equal(refs.filter(ref => ref.deref() !== undefined).length, count);
    return { mode, arenaCount: count, distinctDependencyMaps: maps.size, dependencyEntries: 0, layout, writableOwned: true };
  }
  assert.equal(mode, 'attach');
  let setup = fixture(S, count, copy);
  globalThis.__registryProbeKeep = { setup };
  // Return only WeakRefs and serializable observations from this scope. No
  // owner/arena/lookup list is accidentally retained by the caller.
  async function attachAndRetain() {
    const attached = await S.initWorker(setup.data);
    const observed = topology(arenaOf(attached.root), setup.data, role);
    const before = observed.summary;
    const reads = checkReads(S, attached, setup, copy);
    assert.deepEqual(topology(arenaOf(attached.root), setup.data, role).summary, before,
      'Natural nested reads/reexport must not materialize shared dependency Maps or change own slots');
    const independent = await S.initWorker(setup.data);
    const other = topology(arenaOf(independent.root), setup.data, role);
    assert(observed.arenas.every(arena => !other.arenas.includes(arena)));
    assert(observed.lookups.every(map => !other.lookups.includes(map)));
    let compatibility = null;
    if (role !== 'main') {
      // Exercise the compatibility getter for one owner only. This is an
      // untimed semantic check, never a dense all-to-all treatment.
      const otherOwner = arenaOf(independent.root), original = dependencyMap(otherOwner);
      const materialized = otherOwner.dependencies;
      assert.equal(materialized === original, count === 1);
      assert.equal(materialized.size, count - 1);
      assert.equal(materialized.has(otherOwner.id), false);
      assert.equal(otherOwner.transportDependencies, materialized);
      for (const member of other.arenas) {
        assert.equal(member.hasSharedDependencies, false);
        if (member !== otherOwner) {
          assert.equal(materialized.get(member.id), member);
          assert.equal(dependencyMap(member), original);
        }
      }
      assert.deepEqual(ownLayout(otherOwner), before.layout);
      assert.equal(S.getWorkerData(independent, { copy }).arenas.length, count);
      compatibility = { ownersMaterialized: count > 1 ? 1 : 0, entries: materialized.size, selfExcluded: true, sharedFlagsInvalidated: true, layoutPreserved: true };
    }
    const retained = attached.root.get(setup.keys[0]);
    globalThis.__registryProbeKeep.retained = retained;
    return { before, reads, compatibility, arenaRefs: observed.arenas.map(arena => new WeakRef(arena)),
      lookupRefs: observed.lookups.map(map => new WeakRef(map)),
      independentRefs: other.arenas.map(arena => new WeakRef(arena)),
      retainedArenaRef: new WeakRef(arenaOf(retained)) };
  }
  const observed = await attachAndRetain();
  await settleGc();
  const alive = refs => refs.filter(ref => ref.deref() !== undefined).length;
  const retainedArenas = alive(observed.arenaRefs), retainedLookups = alive(observed.lookupRefs);
  assert.equal(retainedArenas, count, 'Retained nested view must keep the natural dependency graph alive');
  assert.equal(retainedLookups, observed.before.distinctDependencyMaps);
  assert.equal(alive(observed.independentRefs), 0, 'Dropped independent attachment must be collectible');
  assert.equal(globalThis.__registryProbeKeep.retained.get('value'), 0);
  assert.throws(() => globalThis.__registryProbeKeep.retained.set('value', -1), /read-only/);
  // Create a different current writer and drop producer views/payloads. The
  // retained view must still read and reexport using only its own lifetime.
  S.resetMap();
  delete globalThis.__registryProbeKeep.setup;
  setup = null;
  await settleGc();
  assert.equal(globalThis.__registryProbeKeep.retained.get('value'), 0);
  assert.equal(S.getWorkerData({ retained: globalThis.__registryProbeKeep.retained }, { copy }).arenas.length, count);
  delete globalThis.__registryProbeKeep.retained;
  await settleGc();
  const releasedArenas = alive(observed.arenaRefs), releasedLookups = alive(observed.lookupRefs);
  assert.equal(releasedArenas, 0, 'Released attachment arena graph must be collectible');
  assert.equal(releasedLookups, 0, 'Released dependency Maps must be collectible');
  return { mode, topology: observed.before, reads: observed.reads, compatibility: observed.compatibility, independentAttachmentsIsolated: true,
    lifetime: { retainedViewReadable: true, retainedViewReadOnly: true, retainedArenas, retainedLookups, releasedArenas, releasedLookups, droppedIndependentArenas: 0 } };
});
