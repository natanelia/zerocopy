import { connectSharedSession } from '../dist/worker.js';
let memoryHandles = 0;
self.addEventListener('message', event => {
  if (event.data.protocol === 'zerocopy/session' && event.data.kind === 'snapshot') {
    memoryHandles = event.data.data.arenas.filter(arena => arena.memory).length;
  }
});
const reader = await connectSharedSession({ channel: 'browser-proof' });
const first = reader.current;
const report = (value, version) => {
  let readOnly = false;
  try { value.map.set('invalid', 1); } catch (error) { readOnly = /read-only/.test(String(error)); }
  self.postMessage({ result: true, version, seed: value.map.get('seed'), oldSeed: first.map.get('seed'), last: value.map.get('n9999'), memoryHandles, readOnly, isolated: self.crossOriginIsolated });
};
report(reader.current, reader.version);
reader.subscribe(report);
