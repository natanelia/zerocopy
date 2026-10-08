/** The same handshake runs in a real Node worker and a browser module worker. */
let send, listen;
if (typeof process !== 'undefined' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  send = message => parentPort.postMessage(message);
  listen = handler => parentPort.on('message', handler);
} else {
  send = message => postMessage(message);
  listen = handler => { self.onmessage = event => handler(event.data); };
}
let item, iterator, first;
listen(async message => {
  try {
    if (message.type === 'attach') {
      const api = await import(message.module);
      ({ item } = await api.initWorker(message.data));
      iterator = item.values(); first = iterator.next().value;
      send({ type: 'paused' });
    } else if (message.type === 'resume') {
      const values = [first, ...iterator], array = item.toArray(), visited = [];
      item.forEach((value, index) => { if (index !== visited.length) throw new Error('Worker index mismatch'); visited.push(value); });
      let writeRejected = false;
      try { item.push(1); } catch (error) { writeRejected = /read-only/.test(error.message); }
      send({ type: 'done', values, array, visited, writeRejected });
    } else throw new Error('Unknown worker message');
  } catch (error) { send({ type: 'error', error: String(error.stack ?? error) }); }
});
