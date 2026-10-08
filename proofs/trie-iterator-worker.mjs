// Real Node/browser worker: pause all readers, then resume after writer growth.
let send, listen;
if (typeof process !== 'undefined' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  send = message => parentPort.postMessage(message);
  listen = handler => parentPort.on('message', handler);
} else {
  send = message => postMessage(message);
  listen = handler => { self.onmessage = event => handler(event.data); };
}
let items, pending;
listen(async message => {
  try {
    if (message.type === 'attach') {
      const api = await import(message.module);
      items = await api.initWorker(message.data);
      pending = Object.fromEntries(Object.entries(items).filter(([name]) => name !== 'nested' && name !== 'set').map(([name, item]) => {
        const iterator = item.entries(), first = iterator.next();
        return [name, { iterator, first }];
      }));
      send({ type: 'paused' });
    } else if (message.type === 'resume') {
      const result = {};
      for (const [name, { iterator, first }] of Object.entries(pending)) {
        const item = items[name], entries = first.done ? [] : [first.value, ...iterator], visited = [];
        item.forEach((value, key) => { for (const _ of item.entries()) break; visited.push([key, value]); });
        const abandoned = item.entries(); abandoned.next(); abandoned.return();
        let rejected = false;
        try { item.set('forbidden', 1); } catch (error) { rejected = /read-only/.test(error.message); }
        result[name] = { entries, keys: [...item.keys()], values: [...item.values()], visited, rejected };
      }
      result.nested = [...items.nested.get('child').entries()];
      result.set = [...items.set.values()];
      send({ type: 'done', result });
    } else throw new Error('Unknown worker message');
  } catch (error) { send({ type: 'error', error: String(error.stack ?? error) }); }
});
