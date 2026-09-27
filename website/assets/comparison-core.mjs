import { FIELDS, MAX_EVENTS, normalizeQuery, validateColumns } from './explorer-core.mjs';

export const PATHS = ['shared', 'immutable', 'native'];
export const READER_COUNT = 2;
export const COMPARISON_MODES = ['incremental', 'full'];
export function validateMode(mode) {
  if (!COMPARISON_MODES.includes(mode)) throw new RangeError('Choose incremental or full replica updates');
  return mode;
}
/** Counts logical event deliveries, not serialized bytes or retained heap. */
export function transferCounts({ total, appended = 0, initial = false, mode = 'incremental', frozen = false }) {
  validateMode(mode);
  for (const value of [total, appended]) if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EVENTS) throw new RangeError('Invalid event count');
  if (appended > total) throw new RangeError('Appended count exceeds the dataset');
  return {
    shared: { clonedEvents: 0, publishedSnapshots: frozen ? 0 : READER_COUNT },
    immutable: { clonedEvents: (initial || mode === 'full' ? total : appended) * READER_COUNT, publishedSnapshots: READER_COUNT },
    native: { clonedEvents: (initial || mode === 'full' ? total : appended) * READER_COUNT, publishedSnapshots: READER_COUNT },
  };
}
/** Append-only native columns can retain a snapshot by length. No fake limitation. */
export function prefixColumns(columns, length) {
  validateColumns(columns);
  if (!Number.isSafeInteger(length) || length < 0 || length > columns.time.length) throw new RangeError('Invalid snapshot length');
  return Object.fromEntries(FIELDS.map(field => [field, columns[field].slice(0, length)]));
}
export function validateComparisonQuery(value) { return normalizeQuery(value); }
