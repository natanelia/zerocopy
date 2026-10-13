import { integer, validateCount, entriesFor, editsFor, queryIds, calculate, MAX_REVISION } from './catalog-core.mjs';
import { reference, verifyAnswer } from './catalog-reference.mjs';
import { createStorage } from './feature-storage.mjs';
import { Peer, listen } from './catalog-peer.mjs';
let storage, current, retained, count = 0, revision = 0;
const readers = [];
async function publish(initial, changes) {
  const body = storage.kind === 'shared' || initial ? { payload: storage.payload(current) } : { changes };
  await Promise.all(readers.map(reader => reader.request(initial ? 'load' : 'edit', body)));
}
async function query(selected, frozen) {
  const ids = queryIds(count, selected), map = frozen ? retained : current;
  if (!map) throw new Error('Snapshot is missing');
  const start = performance.now();
  const replies = readers.length ? await Promise.all(readers.map((reader, index) => reader.request('query', {
    ids, frozen, task: readers.length === 1 ? 'both' : index % 2 ? 'validate' : 'lookup',
  }))) : [calculate(map, ids)];
  const ms = performance.now() - start;
  const expected = reference(count, frozen ? 0 : revision, ids);
  replies.forEach((reply, index) => verifyAnswer(reply, expected, readers.length < 2 ? 'both' : index % 2 ? 'validate' : 'lookup'));
  return { answer: Object.assign({}, ...replies), ms, verifiedReplies: replies.length, revision: frozen ? 0 : revision };
}
listen(async data => {
  if (data.type === 'prepare') {
    integer(data.readers, 0, 4, 'Reader count');
    storage = await createStorage(data.kind);
    try {
      for (let i = 0; i < data.readers; i++) readers.push(new Peer(new URL('./feature-reader.mjs', import.meta.url)));
      await Promise.all(readers.map(reader => reader.request('prepare', { kind: data.kind })));
      return true;
    } catch (error) { for (const reader of readers) reader.close(); readers.length = 0; throw error; }
  }
  if (data.type === 'load') {
    if (current) throw new Error('Start a new owner to load another dataset');
    count = validateCount(data.count);
    let start = performance.now(), entries = entriesFor(count);
    const generationMs = performance.now() - start;
    start = performance.now(); current = storage.build(entries); retained = current; entries = undefined;
    const constructionMs = performance.now() - start;
    start = performance.now(); await publish(true); const publicationMs = performance.now() - start;
    return { generationMs, constructionMs, publicationMs, count, revision };
  }
  if (data.type === 'query') return query(data.selected, !!data.frozen);
  if (data.type === 'edit') {
    if (revision >= MAX_REVISION) throw new Error('Session edit limit reached; stop and reload');
    let start = performance.now(), changes = editsFor(count, revision + 1);
    const generationMs = performance.now() - start;
    start = performance.now(); const operationStart = start; current = storage.update(current, changes, retained);
    const updateMs = performance.now() - start;
    start = performance.now(); await publish(false, changes); changes = undefined;
    const publicationMs = performance.now() - start, updatePublicationMs = performance.now() - operationStart;
    revision++;
    return { generationMs, updateMs, publicationMs, updatePublicationMs, revision };
  }
  if (data.type === 'release') { retained = undefined; await Promise.all(readers.map(reader => reader.request('release'))); return true; }
  if (data.type === 'stop') { for (const reader of readers) reader.close(); readers.length = 0; current = retained = undefined; return true; }
  throw new Error('Unknown product catalog owner operation');
});
