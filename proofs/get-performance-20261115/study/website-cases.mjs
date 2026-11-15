/** The PRIMARY browser evidence uses the frozen website's actual workers. */
export const WEBSITE_CASE_IDS = ['website-full-object-get', 'website-legacy-catalog'];

export async function runWebsiteStudy({ variant, warmups = 1 }, { onRecord, hash }) {
  const prefix = `/run/${variant}/assets/`;
  const [{ sampleReadCase }, { readCase }, { Peer }, catalog] = await Promise.all([
    import(prefix + 'read-benchmark-runner.mjs'), import(prefix + 'catalog-read-workloads.mjs'),
    import(prefix + 'catalog-peer.mjs'), import(prefix + 'catalog-core.mjs'),
  ]);
  const count = 10000;
  const fixtureSHA256 = await hash(JSON.stringify({ entries: catalog.entriesFor(count), ids: catalog.queryIds(count), edits: catalog.editsFor(count, 1) }));
  const records = [];
  for (let caseOrder = 0; caseOrder < WEBSITE_CASE_IDS.length; caseOrder++) {
    const caseId = WEBSITE_CASE_IDS[caseOrder];
    for (let sample = 0; sample <= warmups; sample++) {
      const record = { caseId, caseOrder, processSample: sample, warmup: sample < warmups, fixtureSHA256, api: 'SharedMap.get',
        collection: 'map', valueType: 'object', freezeBehavior: 'deeply frozen native JSON',
        status: 'running', codeState: 'fresh owner and two fresh reader workers; empty reader caches and new module instances; browser module/Wasm compilation cache state is unspecified',
        measurements: {}, memory: { available: false, reason: 'Worker heaps are not exposed by a portable browser API; see separate local/Node memory guardrails' } };
      let peer;
      try {
        if (caseId === 'website-full-object-get') {
          const result = await sampleReadCase(readCase('full-shared-get'), count);
          record.websiteRecord = result;
          record.timer = 'Frozen Track A sampleReadCase: local parallel max separately from both-reader request/reply including full captured result transport';
          for (const key of ['startupMs', 'generationMs', 'constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs', 'firstRoundTripMs', 'repeatRoundTripMs',
            'constructionToFirstAnswerMs', 'updateMs', 'editPublicationMs', 'updatedQueryMs', 'retainedQueryMs']) {
            if (Number.isFinite(result[key])) record.measurements[key] = result[key];
          }
          record.correctness = result.verification;
        } else {
          const startupStart = performance.now();
          peer = new Peer(new URL(prefix + 'feature-owner.mjs', location.origin));
          await peer.request('prepare', { kind: 'shared', readers: 2, updateMode: 'incremental' });
          record.measurements.startupMs = performance.now() - startupStart;
          const setup = await peer.request('load', { count });
          const first = await peer.request('query'), repeat = await peer.request('query');
          const edit = await peer.request('edit'), updated = await peer.request('query'), retained = await peer.request('query', { frozen: true });
          await peer.request('stop');
          record.timer = 'Unchanged legacy feature-owner: fingerprint generation and parallel reader request/reply inside query; independent reference verification outside timer';
          Object.assign(record.measurements, { generationMs: setup.generationMs, constructionMs: setup.constructionMs, publicationMs: setup.publicationMs,
            firstQueryMs: first.ms, repeatQueryMs: repeat.ms, constructionToFirstAnswerMs: setup.constructionMs + setup.publicationMs + first.ms,
            updateMs: edit.updateMs, editPublicationMs: edit.publicationMs, updatePublicationMs: edit.updatePublicationMs, updatedQueryMs: updated.ms, retainedQueryMs: retained.ms });
          record.websiteRecord = { setup, first, repeat, edit, updated, retained };
          record.correctness = { first: first.verifiedReplies, repeat: repeat.verifiedReplies, updated: updated.verifiedReplies, retained: retained.verifiedReplies };
        }
        record.status = 'passed';
      } catch (error) {
        record.status = 'failed'; record.failure = { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
        if (error.sample) record.websiteRecord = error.sample;
      } finally { peer?.close(); }
      records.push(record); await onRecord?.(record);
      if (record.status !== 'passed') return records;
    }
  }
  return records;
}
