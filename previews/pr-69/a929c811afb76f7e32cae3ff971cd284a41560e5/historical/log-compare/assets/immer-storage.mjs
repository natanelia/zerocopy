// Use the pinned upstream Immer package with its default auto-freezing.
// Snapshots contain five native arrays; produce copies changed arrays on append.
import { produce, freeze } from '../vendor/immer.mjs';
import { FIELDS, nativeView, validateColumns, appendNative } from './explorer-core.mjs';

export function immerView(snapshot) {
  const view = nativeView(snapshot);
  if (!Object.isFrozen(snapshot) || !FIELDS.every(field => Object.isFrozen(snapshot[field]))) throw new TypeError('Expected frozen Immer columns');
  return view;
}
/** Keep the generated native input mutable and independent of the Immer root. */
export function fromColumns(columns) {
  validateColumns(columns);
  return produce({}, draft => {
    for (const field of FIELDS) draft[field] = columns[field].slice();
  });
}
/** Structured clone removes freezing; restore it without another full copy. */
export function attachColumns(columns) {
  validateColumns(columns);
  return freeze(columns, true);
}
export function appendImmer(snapshot, delta) {
  immerView(snapshot);
  return produce(snapshot, draft => { appendNative(draft, delta); });
}
