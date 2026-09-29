// Public WASM entry: immutable writers and scratch-free cold readers.
export * from './persistent-core.as';
export { mapHashCandidate, mapHashCandidateFrom, mapHashPrefix } from './shared-hash-reader.as';
export { textContains16, textContainsBlock16 } from './shared-text-reader.as';
