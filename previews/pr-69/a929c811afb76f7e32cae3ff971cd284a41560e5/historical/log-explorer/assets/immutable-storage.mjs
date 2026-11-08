// The build copies the pinned upstream ESM distribution and license locally.
// No CDN requests, reimplementation, or conversion back to arrays during queries.
import { List } from '../vendor/immutable.mjs';
import { FIELDS, MAX_EVENTS, sharedView, validateColumns } from './explorer-core.mjs';

export function immutableView(snapshot) {
  if (!snapshot || !FIELDS.every(field => List.isList(snapshot[field]))) throw new TypeError('Expected five Immutable.js Lists');
  return sharedView(snapshot);
}
export function fromColumns(columns) {
  validateColumns(columns);
  return Object.fromEntries(FIELDS.map(field => [field, List(columns[field])]));
}
export function appendImmutable(snapshot, delta) {
  const view = immutableView(snapshot);
  validateColumns(delta);
  if (view.length + delta.time.length > MAX_EVENTS) throw new RangeError('Event capacity reached');
  return Object.fromEntries(FIELDS.map(field => [field, snapshot[field].withMutations(column => {
    for (const value of delta[field]) column.push(value);
  })]));
}
/** Encode only the requested suffix. Primitive columns need no deep toJS walk. */
export function transportColumns(snapshot, start = 0) {
  const { length } = immutableView(snapshot);
  if (!Number.isSafeInteger(start) || start < 0 || start > length) throw new RangeError('Invalid delta start');
  return Object.fromEntries(FIELDS.map(field => [field, snapshot[field].slice(start).toArray()]));
}
