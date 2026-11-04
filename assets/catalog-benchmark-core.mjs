import { LABELS } from './catalog-core.mjs';

export const UPDATE_MODES = ['incremental', 'full'];
export const BENCHMARK_CASES = [
  { id: 'shared', kind: 'shared', updateMode: 'shared', label: 'SharedMap · shared snapshot' },
  ...['native', 'immutable', 'immer'].flatMap(kind => UPDATE_MODES.map(updateMode => ({
    id: `${kind}-${updateMode}`, kind, updateMode,
    label: `${LABELS[kind]} · ${updateMode === 'full' ? 'full' : 'incremental'} copy`,
  }))),
];

export function validateUpdateMode(updateMode = 'incremental') {
  if (!UPDATE_MODES.includes(updateMode)) throw new RangeError('Choose incremental or full replica updates');
  return updateMode;
}

/** Count logical product deliveries, not bytes, local copies, or result messages. */
export function publicationFor(storage, current, { initial = false, changes, updateMode = 'incremental' } = {}) {
  validateUpdateMode(updateMode);
  const complete = initial || storage.kind === 'shared' || updateMode === 'full';
  return {
    type: initial ? 'load' : complete ? 'replace' : 'edit',
    body: complete ? { payload: storage.payload(current) } : { changes },
    recordsPerReader: storage.kind === 'shared' ? 0 : complete ? current.size : changes.length,
  };
}
