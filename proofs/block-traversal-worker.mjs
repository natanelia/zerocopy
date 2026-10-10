/** Real worker pauses inside the public forEach callback while its block iterator is live. */
let send, listen, close;
if (typeof process !== 'undefined' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  send = message => parentPort.postMessage(message);
  listen = handler => parentPort.once('message', handler); close = () => parentPort.close();
} else {
  send = message => postMessage(message); listen = handler => { self.onmessage = event => handler(event.data); }; close = () => self.close();
}
listen(async ({ module, data, gate, reverse }) => {
  try {
    const api = await import(module), { item, fork, nested } = await api.initWorker(data);
    const control = new Int32Array(gate), values = [], indices = [];
    item[reverse ? 'forEachReverse' : 'forEach']((value, index) => {
      // Skip the tail in reverse order. Both pause sites are inside Arena.blocks.
      if (index === (reverse ? item.size - item.tailSize - 1 : 1)) {
        send({ type: 'paused', index });
        if (Atomics.wait(control, 0, 0, 30000) === 'timed-out') throw new Error('Writer did not resume paused scan');
      }
      values.push(value); indices.push(index);
    });
    const nestedValues = nested.toArray().map(value => value.toArray());
    const compacted = api.compactMany({ item, fork, nested });
    let writeRejected = false;
    try { item.append(999); } catch (error) { writeRejected = /read-only/.test(error.message); }
    send({ type: 'done', values, indices, array: item.toArray(), fork: fork.toArray(), nested: nestedValues,
      compacted: compacted.item.toArray(), compactedFork: compacted.fork.toArray(),
      compactedNested: compacted.nested.toArray().map(value => value.toArray()), writeRejected });
  } catch (error) { send({ type: 'error', error: String(error.stack ?? error) }); }
  finally { close(); }
});
