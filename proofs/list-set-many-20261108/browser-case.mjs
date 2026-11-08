import { equal, values } from './browser-values.mjs';

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker timed out waiting for ${type}`)), 30000);
    const receive = event => {
      if (event.data?.type === 'error') finish(new Error(event.data.error));
      else if (event.data?.type === type) finish(null, event.data);
    };
    const fail = error => finish(new Error(error.message ?? 'Worker failed'));
    function finish(error, result) {
      clearTimeout(timer);
      worker.removeEventListener('message', receive); worker.removeEventListener('error', fail);
      if (error) reject(error); else resolve(result);
    }
    worker.addEventListener('message', receive); worker.addEventListener('error', fail);
  });
}

export async function runBrowserProof() {
  if (!crossOriginIsolated) throw new Error('Browser page is not isolated');
  const S = await import('/build/shared.js'), results = [];
  for (const copy of [false, true]) {
    S.resetSharedList();
    const count = 32801, input = Array.from({ length: count }, (_, i) => i + 0.5);
    input[0] = NaN; input[1] = -0; input[2] = Infinity; input[3] = -Infinity;
    const before = new S.SharedList('number').pushMany(input);
    const boolInput = Array.from({ length: 65 }, (_, i) => i % 3 === 0);
    const boolBefore = new S.SharedList('boolean').pushMany(boolInput);
    const textInput = Array.from({ length: 65 }, (_, i) => `lane/é/界/🙂/${i}`);
    const textBefore = new S.SharedList('string').pushMany(textInput);
    const jsonInput = Array.from({ length: 65 }, (_, i) => ({ id: i, path: [i, i + 1] }));
    const jsonBefore = new S.SharedList('object').pushMany(jsonInput);
    const children = Array.from({ length: 65 }, (_, i) => new S.SharedList('number').pushMany([i, -i]));
    const nestedBefore = new S.SharedList(S.list('number')).pushMany(children);
    const originalPacket = S.getWorkerData({ before }, { copy: false }), arena = originalPacket.arenas[0];
    const published = new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice();
    const initialCapacity = arena.memory.buffer.byteLength, control = new SharedArrayBuffer(4);
    const worker = new Worker('/proof/browser-worker.mjs', { type: 'module' });
    try {
      const ready = waitFor(worker, 'attached');
      worker.postMessage({ type: 'attach', packet: S.getWorkerData({ before }, { copy }),
        module: new URL('/build/shared.js', location.href).href, expected: input });
      await ready;
      const reading = waitFor(worker, 'reading'), done = waitFor(worker, 'read-complete');
      worker.postMessage({ type: 'read-during-edits', control });
      await reading;
      const entries = Array.from({ length: 512 }, (_, i) => [
        (Math.imul(i, 2654435761) >>> 0) % (count - 32), -i - 1,
      ]);
      entries.push([0, 11], [0, 12], [31, -0], [32, NaN], [-1, 123], [count, 456]);
      const expectedAfter = [...input];
      for (const [index, value] of entries) if (index >= 0 && index < count) expectedAfter[index] = value;
      const after = before.setMany(entries), fork = before.setMany([[0, -100], [32768, -200], [32800, -300]]);
      const boolAfter = boolBefore.setMany([[0, false], [32, true], [64, true]]);
      const textAfter = textBefore.setMany([[0, '\u0000é'], [32, '改🙂'], [64, '\ufefftail']]);
      const jsonAfter = jsonBefore.setMany([[0, { id: -1, path: [] }], [32, { id: -2, path: [0, 1] }]]);
      const nestedAfter = nestedBefore.setMany([[0, children[64]], [32, children[0]], [64, children[1]]]);
      // The new path-copying API may allocate fewer pages; this subsequent
      // owning edit guarantees retained readers are checked across growth.
      before.pushMany(Array(200000).fill(9));
      Atomics.store(new Int32Array(control), 0, 1);
      const reads = (await done).reads;
      if (arena.memory.buffer.byteLength <= initialCapacity) throw new Error('Writer did not grow');
      const currentBytes = new Uint8Array(arena.memory.buffer, 65536, published.length);
      if (published.some((value, index) => value !== currentBytes[index])) throw new Error('Published bytes changed');
      const compacted = S.compact(after);
      const structures = { before, after, fork, compacted, boolBefore, boolAfter, textBefore, textAfter,
        jsonBefore, jsonAfter, nestedBefore, nestedAfter };
      const expectedFork = [...input]; expectedFork[0] = -100; expectedFork[32768] = -200; expectedFork[32800] = -300;
      const expectedBool = [...boolInput]; expectedBool[0] = false; expectedBool[32] = true; expectedBool[64] = true;
      const expectedText = [...textInput]; expectedText[0] = '\u0000é'; expectedText[32] = '改🙂'; expectedText[64] = '\ufefftail';
      const expectedJson = [...jsonInput]; expectedJson[0] = { id: -1, path: [] }; expectedJson[32] = { id: -2, path: [0, 1] };
      const nestedInput = Array.from({ length: 65 }, (_, i) => [i, -i]), expectedNested = [...nestedInput];
      expectedNested[0] = nestedInput[64]; expectedNested[32] = nestedInput[0]; expectedNested[64] = nestedInput[1];
      const expected = { before: input, after: expectedAfter, fork: expectedFork, compacted: expectedAfter,
        boolBefore: boolInput, boolAfter: expectedBool, textBefore: textInput, textAfter: expectedText,
        jsonBefore: jsonInput, jsonAfter: expectedJson, nestedBefore: nestedInput, nestedAfter: expectedNested };
      for (const [name, snapshot] of Object.entries(structures)) equal(values(snapshot), expected[name], `owner ${name}`);
      const verified = waitFor(worker, 'verified');
      worker.postMessage({ type: 'verify', packet: S.getWorkerData(structures, { copy }), expected });
      const reply = await verified;
      results.push({ copy, reads, snapshots: reply.snapshots, sourceCount: count,
        initialCapacity, finalCapacity: arena.memory.buffer.byteLength, sourceBytesUnchanged: true });
    } finally { Atomics.store(new Int32Array(control), 0, 1); worker.terminate(); }
  }
  return { passed: true, crossOriginIsolated, results };
}
