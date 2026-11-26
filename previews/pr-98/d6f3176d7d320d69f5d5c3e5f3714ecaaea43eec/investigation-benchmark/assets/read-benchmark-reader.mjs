import { createStorage } from './feature-storage.mjs';
import { listen } from './catalog-peer.mjs';
import { readCase, runReadQuery, validateReadIds, verifyReadContract } from './catalog-read-workloads.mjs';

let storage, definition, current, retained;
const captured = new Map();
const slots = ['first', 'repeat', 'updated', 'retained'];
listen(async data => {
  if (data.type === 'prepare') {
    definition = readCase(data.caseId);
    storage = await createStorage(definition.kind);
    return true;
  }
  if (data.type === 'load') { current = await storage.attach(data.payload); retained = current; return current.size; }
  if (data.type === 'replace') { current = await storage.attach(data.payload, current); return current.size; }
  if (data.type === 'edit') { current = storage.update(current, data.changes, retained); return current.size; }
  if (data.type === 'read') {
    if (!slots.includes(data.slot) || captured.has(data.slot)) throw new Error('Read phase must be measured once');
    const ids = validateReadIds(data.ids), map = data.slot === 'retained' ? retained : current;
    if (!map) throw new Error('Snapshot is missing');
    const start = performance.now();
    const answer = runReadQuery(map, ids, definition);
    const localMs = performance.now() - start;
    captured.set(data.slot, answer);
    return { localMs, answer };
  }
  if (data.type === 'verify-contract') {
    if (!captured.has('first') || !captured.has('repeat')) throw new Error('Measure cold and repeat before verification');
    const checks = {};
    for (const [slot, answer] of captured) checks[slot] = verifyReadContract(answer, definition);
    return checks;
  }
  if (data.type === 'stop') { captured.clear(); current = retained = undefined; return true; }
  throw new Error('Unknown read-benchmark reader operation');
});
