import assert from 'node:assert/strict';

// Experimental graph controls, never a production repair. Call after attachment
// and before all post-attachment GC, cache warming, and timed work.
export function applyGraphTreatment(owner, treatment) {
  assert(['native', 'materialized', 'materialized-released'].includes(treatment));
  const candidate = Object.hasOwn(owner, 'dependencyLookup');
  assert(candidate || treatment === 'native');
  const lookupName = candidate ? 'dependencyLookup' : 'dependencies';
  const originalLookup = owner[lookupName];
  const arenas = [...new Set([owner, ...originalLookup.values()])];
  if (treatment !== 'native') {
    assert.equal(arenas.length, 512);
    assert(arenas.every(arena => arena.dependencyLookup === originalLookup));
    for (const arena of arenas) {
      const dependencies = arena.dependencies;
      assert.equal(dependencies.size, arenas.length - 1);
      assert.equal(dependencies.has(arena.id), false);
    }
    if (treatment === 'materialized-released') {
      for (const arena of arenas) arena.dependencyLookup = originalLookup;
    }
  }
  // Retain the original registry and arena list in every cell. Thus both dense
  // candidate controls keep identical original registry metadata alive, and
  // released maps have no surviving experimental reference after this returns.
  const kept = { originalLookup, arenas };
  const maps = new Set(arenas.map(arena => arena[lookupName]));
  const summary = {
    treatment, candidate, arenas: arenas.length, distinctLookupMaps: maps.size,
    lookupEntries: [...maps].reduce((sum, map) => sum + map.size, 0),
    selfEntries: arenas.filter(arena => arena[lookupName].get(arena.id) === arena).length,
    sharedFastExport: candidate && owner.sharedDependencyMembers !== undefined,
  };
  return { kept, summary };
}
