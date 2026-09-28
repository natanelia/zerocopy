import { SharedList, getWorkerData } from '../library/shared.js';
import { FIELDS, MAX_EVENTS, generateColumns, yieldToEvents, sharedView, validateColumns } from './explorer-core.mjs';
export function emptyShared() {
  return Object.fromEntries(FIELDS.map(field => [field, new SharedList(field === 'message' ? 'string' : 'number')]));
}
export function appendShared(snapshot, delta) {
  const { length } = sharedView(snapshot);
  validateColumns(delta);
  if (length + delta.time.length > MAX_EVENTS) throw new RangeError('Event capacity reached');
  return Object.fromEntries(FIELDS.map(field => [field, snapshot[field].pushMany(delta[field])]));
}
export async function buildShared(count, progress = () => {}) {
  let snapshot = emptyShared();
  for (let start = 0; start < count; start += 2000) {
    snapshot = appendShared(snapshot, generateColumns(start, Math.min(2000, count - start)));
    progress(snapshot.time.size);
    await yieldToEvents();
  }
  return snapshot;
}
export function sharedPayload(snapshot) {
  const payload = getWorkerData(snapshot, { copy: false });
  if (payload.arenas.some(arena => arena.copy || !(arena.memory?.buffer instanceof SharedArrayBuffer))) throw new Error('Shared transport is required. No copy fallback.');
  return payload;
}
