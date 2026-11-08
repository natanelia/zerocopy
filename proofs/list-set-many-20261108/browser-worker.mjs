import { equal, values } from './browser-values.mjs';

let S, retained, expected, iterator, first;
self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'attach') {
      if (!crossOriginIsolated) throw new Error('Browser worker is not isolated');
      S = await import(message.module);
      retained = (await S.initWorker(message.packet)).before;
      expected = message.expected;
      equal(values(retained), expected, 'retained initial list');
      iterator = retained.values(); first = iterator.next().value;
      postMessage({ type: 'attached' });
    } else if (message.type === 'read-during-edits') {
      const control = new Int32Array(message.control), deadline = performance.now() + 20000;
      postMessage({ type: 'reading' });
      let reads = 0;
      while (reads < 10000 || !Atomics.load(control, 0)) {
        const index = reads % expected.length;
        equal(retained.get(index), expected[index], `retained concurrent read ${index}`);
        reads++;
        if (reads % 256 === 0 && performance.now() > deadline) throw new Error('Owner did not finish editing');
      }
      postMessage({ type: 'read-complete', reads });
    } else if (message.type === 'verify') {
      equal([first, ...iterator], expected, 'retained iterator after growth');
      equal(values(retained), expected, 'retained list after growth');
      const attached = await S.initWorker(message.packet);
      for (const [name, snapshot] of Object.entries(attached)) {
        equal(values(snapshot), message.expected[name], name);
        if (!Object.isFrozen(snapshot)) throw new Error(`${name}: unfrozen snapshot`);
        let rejected = false;
        try { snapshot.setMany([[0, snapshot.get(0)]]); }
        catch (error) { rejected = /read-only/.test(String(error.message)); }
        if (!rejected) throw new Error(`${name}: worker accepted a batch write`);
      }
      postMessage({ type: 'verified', snapshots: Object.keys(attached).length });
    } else throw new Error('Unknown worker message');
  } catch (error) { postMessage({ type: 'error', error: String(error.stack ?? error) }); }
};
