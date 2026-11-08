import { LABELS } from './catalog-core.mjs';

export const UPDATE_MODES = ['incremental', 'full'];
export const EDIT_PUBLICATION_PHASES = ['editPublicationMs', 'updatePublicationMs'];
const REPLICA_KINDS = ['native', 'immutable', 'immer'];
const replicaCase = (kind, updateMode) => ({
  id: `${kind}-${updateMode}`, kind, updateMode,
  label: `${LABELS[kind]} · ${updateMode === 'full' ? 'full' : 'incremental'} copy`,
});
// The four primary paths suffice when no updated dataset is published.
export const BASELINE_CASES = [
  { id: 'shared', kind: 'shared', updateMode: 'shared', label: 'SharedMap · shared snapshot' },
  ...REPLICA_KINDS.map(kind => replicaCase(kind, 'incremental')),
];
export const FULL_COPY_CASES = REPLICA_KINDS.map(kind => replicaCase(kind, 'full'));
// On edited-publication charts: SharedMap first, then all full copies, then incremental copies.
export const BENCHMARK_CASES = [BASELINE_CASES[0], ...FULL_COPY_CASES, ...BASELINE_CASES.slice(1)];
export const casesForPhase = phase => EDIT_PUBLICATION_PHASES.includes(phase) ? BENCHMARK_CASES : BASELINE_CASES;

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
