/** Real Node/browser worker handshake, including a suspended scan across growth. */
let send, listen;
if (typeof process !== 'undefined' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  send = value => parentPort.postMessage(value); listen = fn => parentPort.on('message', fn);
} else { send = value => postMessage(value); listen = fn => { self.onmessage = event => fn(event.data); }; }
let state, mapIterator, setIterator, mapFirst, setFirst;
listen(async message => {
  try {
    if (message.kind === 'attach') {
      const S = await import(message.module); state = await S.initWorker(message.data);
      mapIterator = state.map.entries(); setIterator = state.set.values();
      mapFirst = mapIterator.next().value; setFirst = setIterator.next().value;
      send({ kind: 'paused' });
    } else if (message.kind === 'resume') {
      const visits = []; state.map.forEach((value, key) => visits.push([key, value]));
      let rejected = false; try { state.map.set('forbidden', 1); } catch (error) { rejected = /read-only/.test(error.message); }
      send({ kind: 'done', entries: [mapFirst, ...mapIterator], keys: [...state.map.keys()], values: [...state.map.values()], visits,
        initial: [...state.initial.entries()], set: [setFirst, ...setIterator], rejected, frozen: Object.isFrozen(state.map) });
    } else throw new Error('Unexpected handshake');
  } catch (error) { send({ kind: 'error', message: String(error.stack ?? error) }); }
});
