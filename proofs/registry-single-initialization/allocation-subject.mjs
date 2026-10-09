import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOOK } from './instrument.mjs';
import { modules, fixture, runSubject, settleGc } from './common.mjs';

await runSubject(async ({ root, role, mode, count, copy }) => {
  const nativeMap = Map, records = [];
  let armed = false;
  globalThis[HOOK] = (site, value) => {
    assert(value instanceof nativeMap);
    if (armed) records.push({ site, reference: new WeakRef(value) });
    return value;
  };
  const { Arena, S } = await modules(root);
  const setup = mode === 'attach' ? fixture(S, count, copy) : null;
  S.configureMemory({ maximumBytes: 131072 });
  globalThis.__registryProbeKeep = { setup };
  armed = true;
  try {
    if (mode === 'attach') globalThis.__registryProbeKeep.attached = await S.initWorker(setup.data);
    else {
      assert.equal(mode, 'owned');
      globalThis.__registryProbeKeep.owned = Array.from({ length: count }, () => new Arena());
    }
  } finally { armed = false; }
  assert.equal(Map, nativeMap, 'The global Map constructor must remain native');
  // No nested reads/cache priming occurs before this census.
  await settleGc();
  const sites = {};
  for (const { site, reference } of records) {
    const entry = sites[site] ??= { evaluated: 0, settledAlive: 0, discarded: 0 };
    entry.evaluated++;
    if (reference.deref() !== undefined) entry.settledAlive++; else entry.discarded++;
  }
  const evaluated = records.length, settledAlive = Object.values(sites).reduce((sum, site) => sum + site.settledAlive, 0);
  const patch = JSON.parse(readFileSync(join(dirname(root), 'instrumentation.json'), 'utf8'));
  const siteDefinitions = new Map(patch.sites.map(site => [site.id, site]));
  const byPurpose = {};
  for (const [id, counts] of Object.entries(sites)) {
    const definition = siteDefinitions.get(id);
    assert(definition, `Missing archived expression definition: ${id}`);
    const ancestry = definition.ancestry;
    let purpose;
    if (ancestry.includes('Arena') && ['dependencies', 'dependencyLookup', 'constructor'].includes(ancestry[0])) purpose = 'arenaDependencyMap';
    else if (ancestry.includes('Arena') && ['objects', 'keys', 'strings'].includes(ancestry[0])) purpose = ancestry[0];
    else if (ancestry[0] === 'arenas' && ancestry.some(name => /^initWorker\d*$/.test(name))) purpose = 'attachmentArenaIndex';
    else assert.fail(`Unexpected Map-expression call site in measured construction: ${id} (${ancestry.join('/')})`);
    const aggregate = byPurpose[purpose] ??= { evaluated: 0, settledAlive: 0, discarded: 0 };
    for (const key of Object.keys(aggregate)) aggregate[key] += counts[key];
  }
  const shared = mode === 'attach' && count > 1;
  const expectedEvaluated = mode === 'owned' ? count * 4 : role === 'cleanup' && shared ? count * 3 + 1 : count * 4 + 1;
  const expectedAlive = mode === 'owned' ? count * 4 : role !== 'main' && shared ? count * 3 + 1 : count * 4;
  assert.equal(evaluated, expectedEvaluated, 'Map-expression evaluation count');
  assert.equal(settledAlive, expectedAlive, 'Settled live instrumented Maps');
  for (const purpose of ['objects', 'keys', 'strings']) assert.deepEqual(byPurpose[purpose], { evaluated: count, settledAlive: count, discarded: 0 });
  const dependencyEvaluated = role === 'cleanup' && shared ? 0 : count;
  const dependencyDiscarded = role === 'old' && shared ? count : 0;
  assert.deepEqual(byPurpose.arenaDependencyMap ?? { evaluated: 0, settledAlive: 0, discarded: 0 },
    { evaluated: dependencyEvaluated, settledAlive: dependencyEvaluated - dependencyDiscarded, discarded: dependencyDiscarded });
  const indexAlive = role !== 'main' && shared ? 1 : 0;
  assert.deepEqual(byPurpose.attachmentArenaIndex ?? { evaluated: 0, settledAlive: 0, discarded: 0 }, mode === 'attach' ?
    { evaluated: 1, settledAlive: indexAlive, discarded: 1 - indexAlive } : { evaluated: 0, settledAlive: 0, discarded: 0 });
  return { metric: 'evaluated-native-new-Map-expressions', evaluated, settledAlive, discarded: evaluated - settledAlive, sites, byPurpose,
    scope: 'Attachment or owned construction only; WeakRefs observed after explicit GC and job boundaries; no cache priming',
    globalMapUnchanged: Map === nativeMap };
});
