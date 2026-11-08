/** Worker publication strategies; local collection updates stay the same. */
export const INVESTIGATION_CASES = [
  { id: 'shared', kind: 'shared', updateMode: 'shared', label: 'zerocopy · shared snapshots', readers: 2 },
  // Full-copy baselines are the first alternatives after shared snapshots.
  { id: 'replicated-full', kind: 'native', updateMode: 'full', label: 'Native arrays · full copy', readers: 2 },
  { id: 'immutable-full', kind: 'immutable', updateMode: 'full', label: 'Immutable.js Lists · full copy', readers: 2 },
  { id: 'replicated', kind: 'native', updateMode: 'incremental', label: 'Native arrays · incremental copy', readers: 2 },
  { id: 'immutable', kind: 'immutable', updateMode: 'incremental', label: 'Immutable.js Lists · incremental copy', readers: 2 },
  { id: 'centralized', kind: 'centralized', updateMode: 'owner', label: 'Native arrays · one owner', readers: 1 },
];
