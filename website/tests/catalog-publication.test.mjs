import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_CASES, BENCHMARK_CASES, EDIT_PUBLICATION_PHASES, casesForPhase, publicationFor, validateUpdateMode } from '../assets/catalog-benchmark-core.mjs';
import { entriesFor, editsFor, queryIds } from '../assets/catalog-core.mjs';
import { reference, verifyAnswer } from '../assets/catalog-reference.mjs';
import { RPC } from '../assets/feature-core.mjs';
import { createStorage } from '../_site/compare/assets/feature-storage.mjs';

test('replica publication defaults to incremental and rejects unknown modes', () => {
  assert.equal(validateUpdateMode(), 'incremental');
  for (const mode of ['incremental', 'full']) assert.equal(validateUpdateMode(mode), mode);
  for (const mode of ['snapshot', 'shared', '', null, false]) assert.throws(() => validateUpdateMode(mode), /incremental or full/);
});

test('full-copy comparisons are ordered directly under SharedMap on edited-publication phases only', () => {
  const baseline = ['shared', 'native-incremental', 'immutable-incremental', 'immer-incremental'];
  const edited = ['shared', 'native-full', 'immutable-full', 'immer-full', 'native-incremental', 'immutable-incremental', 'immer-incremental'];
  assert.deepEqual(BASELINE_CASES.map(item => item.id), baseline);
  assert.deepEqual(BENCHMARK_CASES.map(item => item.id), edited);
  assert.deepEqual(EDIT_PUBLICATION_PHASES, ['editPublicationMs', 'updatePublicationMs']);
  for (const phase of ['generationMs', 'constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs', 'updateMs', 'updatedQueryMs']) {
    assert.deepEqual(casesForPhase(phase).map(item => item.id), baseline, phase);
  }
  for (const phase of EDIT_PUBLICATION_PHASES) {
    assert.deepEqual(casesForPhase(phase).map(item => item.id), edited, phase);
  }
});

test('actual readers receive full or incremental copies on every edit and retain revision zero', async () => {
  const previousSelf = globalThis.self;
  try {
    for (const { id, kind, updateMode } of BENCHMARK_CASES) {
      const storage = await createStorage(kind), initial = storage.build(entriesFor(1000)), ids = queryIds(1000);
      let current = initial, response, sequence = 0;
      // Capture replies in-process so object identity reveals whether unchanged
      // records were copied. Publications still cross a structured-clone boundary.
      globalThis.self = { postMessage: value => { response = value; } };
      await import(`../_site/compare/assets/feature-reader.mjs?case=${id}`);
      const receive = globalThis.self.onmessage;
      async function request(type, body = {}) {
        response = undefined;
        await receive({ data: structuredClone({ protocol: RPC, id: ++sequence, type, ...body }) });
        assert.equal(response?.id, sequence, `${id}: reader must reply`);
        assert.equal(response.error, undefined, `${id}: ${response.error}`);
        return response.value;
      }
      await request('prepare', { kind });
      const mode = updateMode === 'shared' ? 'incremental' : updateMode;
      const load = publicationFor(storage, current, { initial: true, updateMode: mode });
      assert.equal(load.type, 'load');
      assert.equal(load.recordsPerReader, kind === 'shared' ? 0 : 1000);
      assert.equal(await request(load.type, load.body), 1000);

      const editedIds = new Set(editsFor(1000, 1).map(([key]) => key));
      const untouchedId = entriesFor(1000).find(([key]) => !editedIds.has(key))[0];
      const untouched = async () => (await request('query', { ids: [untouchedId] })).lookup.rows[0].value;
      let previousUntouched = await untouched();
      for (let revision = 1; revision <= 3; revision++) {
        const changes = editsFor(1000, revision);
        current = storage.update(current, changes, initial);
        const publication = publicationFor(storage, current, { changes, updateMode: mode });
        const full = kind === 'shared' || mode === 'full';
        assert.equal(publication.type, full ? 'replace' : 'edit');
        assert.equal(publication.recordsPerReader, kind === 'shared' ? 0 : full ? 1000 : 100);
        assert.equal(await request(publication.type, publication.body), 1000);
        verifyAnswer(await request('query', { ids }), reference(1000, revision, ids));
        verifyAnswer(await request('query', { ids, frozen: true }), reference(1000, 0, ids));

        const nextUntouched = await untouched();
        if (mode === 'full') assert.notEqual(nextUntouched, previousUntouched, `${id}: full copy must replace unchanged record objects on every publication`);
        else if (kind !== 'shared') assert.equal(nextUntouched, previousUntouched, `${id}: incremental copies must reuse unchanged reader records`);
        assert.throws(() => { nextUntouched.metadata.tags.push('changed'); }, TypeError);
        previousUntouched = nextUntouched;
      }
      await request('release');
      await assert.rejects(request('query', { ids, frozen: true }), /Snapshot is missing/);
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});
