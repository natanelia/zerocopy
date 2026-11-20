import { validateCount, entriesFor, editsFor, queryIds, EDIT_COUNT } from './catalog-core.mjs';
import { createStorage } from './feature-storage.mjs';
import { publicationFor } from './catalog-benchmark-core.mjs';
import { Peer, listen } from './catalog-peer.mjs';
import { readCase } from './catalog-read-workloads.mjs';
import { readReference, verifyReadAnswer } from './catalog-read-reference.mjs';

let storage, definition, current, retained, used = false;
const readers = [];
const closeReaders = () => { for (const reader of readers) reader.close(); readers.length = 0; current = retained = undefined; };

async function publish(initial, changes) {
  const publication = publicationFor(storage, current, { initial, changes, updateMode: 'incremental' });
  await Promise.all(readers.map(reader => reader.request(publication.type, publication.body)));
  return { recordsPerReader: publication.recordsPerReader, totalRecords: publication.recordsPerReader * readers.length };
}

async function query(ids, slot) {
  const start = performance.now();
  const replies = await Promise.all(readers.map(reader => reader.request('read', { ids, slot })));
  const roundTripMs = performance.now() - start;
  const readerMs = replies.map(reply => reply.localMs);
  return { roundTripMs, readerMs, localMs: Math.max(...readerMs), answers: replies.map(reply => reply.answer) };
}

listen(async data => {
  if (data.type === 'prepare') {
    if (storage || readers.length) throw new Error('Start a fresh owner for each read case');
    definition = readCase(data.caseId);
    storage = await createStorage(definition.kind);
    try {
      for (let i = 0; i < 2; i++) readers.push(new Peer(new URL('./read-benchmark-reader.mjs', import.meta.url)));
      await Promise.all(readers.map(reader => reader.request('prepare', { caseId: definition.id })));
      return true;
    } catch (error) { closeReaders(); throw error; }
  }
  if (data.type === 'sample') {
    if (!storage || used) throw new Error('A prepared owner measures exactly one sample');
    used = true;
    const count = validateCount(data.count), ids = queryIds(count);
    const record = { status: 'running', caseId: definition.id, kind: definition.kind, api: definition.api, workload: definition.workload,
      freeze: definition.freeze, collectionType: definition.collectionType, valueType: definition.valueType, workloadVersion: definition.version,
      config: { entries: count, requestedIds: ids.length, uniqueRequestedIds: new Set(ids).size, readers: 2, edits: EDIT_COUNT, retainedRevisions: [0, 1] } };
    let phase = 'generation';
    try {
      let start = performance.now(), entries = entriesFor(count);
      record.generationMs = performance.now() - start;
      phase = 'construction'; start = performance.now();
      current = storage.build(entries); retained = current; entries = undefined;
      record.constructionMs = performance.now() - start;
      phase = 'publication'; start = performance.now();
      const initialPublication = await publish(true);
      record.publicationMs = performance.now() - start;
      record.publication = { initial: initialPublication };
      phase = 'first'; const first = await query(ids, 'first');
      record.firstQueryMs = first.localMs; record.firstRoundTripMs = first.roundTripMs;
      record.readerTimings = { first: first.readerMs };
      record.constructionToFirstAnswerMs = record.constructionMs + record.publicationMs + record.firstRoundTripMs;
      // No validation pass, oracle, or extra map read between cold and repeat.
      phase = 'repeat'; const repeat = await query(ids, 'repeat');
      record.repeatQueryMs = repeat.localMs; record.repeatRoundTripMs = repeat.roundTripMs;
      record.readerTimings.repeat = repeat.readerMs;
      phase = 'verification-initial';
      const initialExpected = readReference(count, 0, ids, definition);
      record.config.foundIds = initialExpected.found; record.config.missingIds = initialExpected.missing;
      record.verification = {
        first: first.answers.map(answer => verifyReadAnswer(answer, initialExpected)),
        repeat: repeat.answers.map(answer => verifyReadAnswer(answer, initialExpected)),
      };
      // Verification uses captured answers only, never decodes the readers.
      phase = 'edit-generation'; start = performance.now();
      let changes = editsFor(count, 1);
      record.editGenerationMs = performance.now() - start;
      phase = 'update'; start = performance.now();
      current = storage.update(current, changes, retained);
      record.updateMs = performance.now() - start;
      phase = 'edit-publication'; start = performance.now();
      const editPublication = await publish(false, changes); changes = undefined;
      record.editPublicationMs = performance.now() - start;
      record.publication.edit = editPublication;
      phase = 'updated'; const updated = await query(ids, 'updated');
      record.updatedQueryMs = updated.localMs; record.updatedRoundTripMs = updated.roundTripMs;
      record.readerTimings.updated = updated.readerMs;
      phase = 'retained'; const original = await query(ids, 'retained');
      record.retainedQueryMs = original.localMs; record.retainedRoundTripMs = original.roundTripMs;
      record.readerTimings.retained = original.readerMs;
      phase = 'verification-revisions';
      const editedExpected = readReference(count, 1, ids, definition);
      record.verification.updated = updated.answers.map(answer => verifyReadAnswer(answer, editedExpected));
      record.verification.retained = original.answers.map(answer => verifyReadAnswer(answer, initialExpected));
      record.verification.contracts = await Promise.all(readers.map(reader => reader.request('verify-contract')));
      record.status = 'passed';
      return record;
    } catch (error) {
      record.status = 'failed'; record.failure = { phase, name: error?.name ?? 'Error', message: error?.message ?? String(error) };
      return record;
    } finally { closeReaders(); }
  }
  if (data.type === 'stop') { closeReaders(); return true; }
  throw new Error('Unknown read-benchmark owner operation');
});
