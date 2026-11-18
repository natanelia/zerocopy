import { initWorker } from '../dist/shared.js';

let retained: any;
self.onmessage = async ({ data }) => {
  try {
    const before = data.payload.arenas.map((arena: any) => new Uint8Array(arena.memory.buffer).slice());
    const attached = await initWorker(data.payload);
    if (data.phase === 'prime') retained = attached.map.getView('record').get('items');
    const start = data.phase === 'prime' ? 0 : 128, end = data.phase === 'prime' ? 128 : 1024;
    let sum = 0;
    for (let index = start; index < end; index++) sum += retained.at(index);
    if (data.phase !== 'prime' && (retained.at(1024) !== undefined || retained.at(3) !== 3
      || attached.map.getView('record').get('items').at(0) !== -1)) throw new Error('Retained cursor changed');
    for (let arenaIndex = 0; arenaIndex < before.length; arenaIndex++) {
      const current = new Uint8Array(data.payload.arenas[arenaIndex].memory.buffer);
      if (current.length !== before[arenaIndex].length) throw new Error('Reader grew memory');
      for (let index = 0; index < current.length; index++) {
        if (current[index] !== before[arenaIndex][index]) throw new Error('Reader wrote shared bytes');
      }
    }
    self.postMessage({ sum, sharedBytesUnchanged: true });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
