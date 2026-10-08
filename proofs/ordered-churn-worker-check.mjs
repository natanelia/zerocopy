import { churnFixture, equal } from './ordered-churn-checks.mjs';
export async function checkChurnWorker(S, worker, module, copy, node = false) {
  const request = message => new Promise((resolve, reject) => {
    const receive = result => done(null, node ? result : result.data);
    const fail = error => done(error);
    const timer = setTimeout(() => done(new Error('Ordered worker timed out')), 30000);
    function done(error, result) {
      clearTimeout(timer);
      if (node) { worker.off('message', receive); worker.off('error', fail); }
      else { worker.removeEventListener('message', receive); worker.removeEventListener('error', fail); }
      if (error) reject(error); else if (result.kind === 'error') reject(new Error(result.message)); else resolve(result);
    }
    if (node) { worker.on('message', receive); worker.on('error', fail); }
    else { worker.addEventListener('message', receive); worker.addEventListener('error', fail); }
    worker.postMessage(message);
  });
  try {
    const { map, expected, initial, initialExpected } = churnFixture(S, 33, 2048);
    let set = new S.SharedOrderedSet(), native = new Set();
    for (let i = 0; i < 16; i++) { set = set.add(i); native.add(i); }
    for (let i = 0; i < 1024; i++) { const value = i % 16; set = set.delete(value).add(value); native.delete(value); native.add(value); }
    const data = S.getWorkerData({ map, initial, set }, { copy });
    equal((await request({ kind: 'attach', data, module })).kind, 'paused');
    const memory = S.getWorkerData({ map }, { copy: false }).arenas[0].memory, before = memory.buffer.byteLength;
    memory.grow(2); if (memory.buffer.byteLength <= before) throw new Error('Writer did not grow');
    const result = await request({ kind: 'resume' }); equal(result.kind, 'done'); equal(result.rejected, true); equal(result.frozen, true);
    equal(result.entries, expected); equal(result.visits, expected); equal(result.keys, expected.map(e => e[0])); equal(result.values, expected.map(e => e[1]));
    equal(result.initial, initialExpected); equal(result.set, [...native]);
    return { transport: copy ? 'copy' : 'shared', status: 'passed' };
  } finally { await worker.terminate(); }
}
