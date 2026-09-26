export { createSharedState as createState } from './worker';
export type { SharedState, SharedSession, SharedReader, SharedSource } from './worker';
export type StateOf<T> = T extends { readonly current: infer S } ? S : never;
