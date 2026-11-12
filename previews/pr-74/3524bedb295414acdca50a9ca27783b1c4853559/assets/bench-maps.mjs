import { Map as ImmutableMap } from '../vendor/immutable.mjs';
import { enableMapSet, produce, freeze } from '../vendor/immer.mjs';
enableMapSet();

/** Batch construction is setup only; the measured workload publishes a full snapshot. */
export function buildReplica(path, keys) {
  if (path === 'immutable') return ImmutableMap().withMutations(map => {
    keys.forEach((key, index) => map.set(key, index));
  });
  if (path === 'immer') return produce(new Map(), map => {
    keys.forEach((key, index) => map.set(key, index));
  });
  throw new RangeError('Unknown replica path');
}
export function encodeReplica(path, map) {
  if (path === 'immutable') return map.entrySeq().toArray();
  if (path === 'immer') return map;
  throw new RangeError('Unknown replica path');
}
/** Structured clone cannot preserve Immutable.js roots or Immer's frozen Map methods. */
export function attachReplica(path, payload) {
  if (path === 'immutable') return ImmutableMap(payload);
  if (path === 'immer' && payload instanceof Map) return freeze(payload, true);
  throw new RangeError('Invalid replica payload');
}
