/** Optional Redux integration. No Redux, Immer, React or Node runtime dependency. */
import { SharedMap } from './shared';
import { arenaOf, type Arena } from './arena';
import type { ValueOf } from './types';
import { createZerocopyCodec, isPlainRecord, isSharedCollection, sharedCollectionKind, type ZerocopyCodec } from './redux-codec';
import { createPortableSerialization } from './redux-jsan';
export { createZerocopyCodec, isSharedCollection } from './redux-codec';
export type { SharedCollection, ZerocopyCodec, ZerocopyCodecOptions, ZerocopyReduxEnvelope, EncodedReduxValue } from './redux-codec';
export { encodeZerocopyState, decodeZerocopyState, serializeZerocopyState, deserializeZerocopyState } from './redux-checkpoint';
export type { ZerocopyCodecOptions as ZerocopyCheckpointOptions, ZerocopyStatePacket } from './redux-checkpoint';
export const isZerocopyCollection = isSharedCollection;

/** Admit supported immutable snapshots while keeping RTK checks elsewhere. */
export function isZerocopySerializable(value: unknown): boolean {
  if (isSharedCollection(value)) {
    try { value.toWorkerData(); return true; } catch { return false; }
  }
  return value == null || ['string', 'boolean', 'number'].includes(typeof value) || Array.isArray(value) || isPlainRecord(value);
}
/** Never enumerate WASM internals or decode every entity on every dispatch. */
export function getZerocopyEntries(value: unknown): [string, unknown][] {
  if (isSharedCollection(value) || value === null || typeof value !== 'object') return [];
  return Object.entries(value);
}
export const zerocopySerializableCheck = Object.freeze({ isSerializable: isZerocopySerializable, getEntries: getZerocopyEntries });
/** Equivalent to RTK's default: frozen snapshots require no recursive scan. */
export const zerocopyImmutableCheck = Object.freeze({
  isImmutable(value: unknown): boolean { return value === null || typeof value !== 'object' || Object.isFrozen(value); },
});
export const zerocopyMiddlewareOptions = Object.freeze({ serializableCheck: zerocopySerializableCheck, immutableCheck: zerocopyImmutableCheck });

/** One-entry cache per component/key stream. Arena identity prevents address reuse errors. */
export function createSharedMapEntrySelector<State, Args extends unknown[], T extends string>(
  selectMap: (state: State, ...args: { [K in keyof Args]: NoInfer<Args[K]> }) => SharedMap<T>,
  selectKey: (state: State, ...args: Args) => string,
): (state: State, ...args: Args) => ValueOf<T> | undefined {
  let lastArena: Arena | undefined, lastLeaf = -1, lastType: string | undefined;
  let lastValue: ValueOf<T> | undefined;
  return (state, ...args) => {
    const map = selectMap(state, ...args), key = selectKey(state, ...args);
    if (sharedCollectionKind(map) !== 'SharedMap') throw new TypeError('Expected a frozen SharedMap');
    const arena = arenaOf(map), leaf = arena.find(map.root, key);
    if (arena !== lastArena || leaf !== lastLeaf || map.valueType !== lastType) {
      lastValue = leaf ? arena.leafValue(map.valueType, leaf) : undefined;
      lastArena = arena; lastLeaf = leaf; lastType = map.valueType;
    }
    return lastValue;
  };
}
/** Backward-compatible state-only selector. */
export function createSharedMapValueSelector<State, T extends string>(
  selectMap: (state: State) => SharedMap<T>, selectKey: (state: State) => string,
): (state: State) => ValueOf<T> | undefined {
  return createSharedMapEntrySelector<State, [], T>(selectMap, selectKey);
}
/** Immer maps public fields in its Draft type, even for non-draftable classes. */
export type SharedMapView<T extends string> = Pick<SharedMap<T>, keyof SharedMap<T>>;
/** Optional no-op guard. The core write path does not pay for an equality read. */
export function setSharedMapValue<T extends string>(map: SharedMapView<T>, key: string, value: ValueOf<T>, equals: (previous: ValueOf<T>, next: ValueOf<T>) => boolean = Object.is): SharedMap<T> {
  if (sharedCollectionKind(map) !== 'SharedMap') throw new TypeError('Expected a frozen SharedMap');
  return map.has(key) && equals(map.get(key)!, value) ? map as SharedMap<T> : map.set(key, value);
}

/** Display only. Do not use summaries as saved state or as reducer input. */
export function sanitizeZerocopyState<State>(state: State): State {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown, depth: number): unknown => {
    if (isSharedCollection(value)) {
      return Object.freeze({ $zerocopy: sharedCollectionKind(value), size: value.size, valueType: 'valueType' in value ? value.valueType : 'string | number' });
    }
    if ((!Array.isArray(value) && !isPlainRecord(value)) || value === null) return value;
    if (seen.has(value)) return seen.get(value);
    if (depth > 128) return '[Depth limit]';
    const result = Array.isArray(value) ? new Array(value.length) : Object.create(null);
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      Object.defineProperty(result, key, { value: 'value' in property ? visit(property.value, depth + 1) : '[Accessor]', enumerable: true, configurable: true, writable: true });
    }
    return Object.freeze(result);
  };
  return visit(state, 0) as State;
}
export const summarizeZerocopyState = sanitizeZerocopyState;

export interface ZerocopyDevToolsOptions {
  /** Summary avoids scanning shared data. Portable mode serializes logical values. */
  mode?: 'summary' | 'portable';
  maxAge?: number;
  codec?: ZerocopyCodec;
}
export function createZerocopyDevToolsOptions(options: ZerocopyDevToolsOptions = {}) {
  const maxAge = options.maxAge ?? 50;
  if (!Number.isSafeInteger(maxAge) || maxAge < 2) throw new RangeError('DevTools maxAge must be at least 2');
  if (options.mode !== undefined && options.mode !== 'summary' && options.mode !== 'portable') throw new TypeError('Invalid DevTools mode');
  if (options.mode !== 'portable') return {
    maxAge, stateSanitizer: sanitizeZerocopyState, actionSanitizer: sanitizeZerocopyState,
    // Setting features makes unlisted controls unavailable. Enable safe controls explicitly.
    features: { pause: true, lock: true, jump: true, skip: true, reorder: true, dispatch: true, import: false, export: false, persist: false, test: false },
  };
  return { maxAge, serialize: createPortableSerialization(options.codec ?? createZerocopyCodec()) };
}
export const createZerocopyDevTools = createZerocopyDevToolsOptions;
