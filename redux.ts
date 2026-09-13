/** Optional Redux integration. No Redux, Immer, React or Node runtime dependency. */
import { arenaOf } from './arena';
import type { Arena } from './arena';
import { SharedMap } from './shared-map';
import type { ValueOf } from './types';
import { collectionKind, isPlainRecord, isZerocopyCollection, isSerializable, getEntries } from './redux-internal';
import { encodeZerocopyState, decodeZerocopyState } from './redux-codec';
import type { ZerocopyCodecOptions } from './redux-codec';

export { isZerocopyCollection } from './redux-internal';
export type { SharedCollection } from './redux-internal';
export { encodeZerocopyState, decodeZerocopyState, serializeZerocopyState, deserializeZerocopyState } from './redux-codec';
export type { ZerocopyCodecOptions, ZerocopyStatePacket } from './redux-codec';

/** Pass to getDefaultMiddleware({ serializableCheck: zerocopySerializableCheck }). */
export const zerocopySerializableCheck = Object.freeze({ isSerializable, getEntries });
/** Keep RTK's normal treatment of primitives and frozen objects. Collections are frozen. */
export const zerocopyImmutableCheck = Object.freeze({
  isImmutable(value: unknown): boolean {
    return value === null || typeof value !== 'object' || Object.isFrozen(value);
  },
});
/** This does not disable either development check for the rest of the state or actions. */
export const zerocopyMiddlewareOptions = Object.freeze({
  serializableCheck: zerocopySerializableCheck,
  immutableCheck: zerocopyImmutableCheck,
});

/**
 * One-entry selector cache, keyed by arena object, immutable leaf address and type.
 * An unrelated map edit retains the leaf, even when the shared JSON decode cache is full.
 * Create one selector per component/independent key stream. Use ordinary === for whole maps.
 */
export function createSharedMapEntrySelector<State, Args extends unknown[], Type extends string>(
  selectMap: (state: State, ...args: Args) => SharedMap<Type>,
  selectKey: (state: State, ...args: Args) => string,
): (state: State, ...args: Args) => ValueOf<Type> | undefined {
  let previousArena: Arena | undefined, previousLeaf = -1, previousType: string | undefined;
  let selected: ValueOf<Type> | undefined;
  return (state: State, ...args: Args) => {
    const map = selectMap(state, ...args), key = selectKey(state, ...args);
    if (!(map instanceof SharedMap)) throw new TypeError('Expected a SharedMap in createSharedMapEntrySelector');
    const arena = arenaOf(map), leaf = arena.find(map.root, key);
    if (arena !== previousArena || leaf !== previousLeaf || map.valueType !== previousType) {
      selected = map.get(key);
      previousArena = arena; previousLeaf = leaf; previousType = map.valueType;
    }
    return selected;
  };
}

/** Debug-only view. Never reads collection entries, JSON values, or shared memory bytes. */
export function sanitizeZerocopyState<State>(state: State): State {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown, depth: number): unknown => {
    const kind = collectionKind(value);
    if (kind && isZerocopyCollection(value)) {
      return Object.freeze({ $zerocopy: kind, size: value.size, valueType: 'valueType' in value ? value.valueType : 'string | number' });
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

export interface ZerocopyDevToolsOptions extends ZerocopyCodecOptions {
  /** summary: fast display; portable: full checkpoint serializer. Default: summary. */
  mode?: 'summary' | 'portable';
  /** Number of in-process history states to retain. Default: 50. */
  maxAge?: number;
}
const DEVTOOLS_TAG = '__zerocopy_redux_devtools_v1__';

/**
 * Summary mode keeps in-process history intact but disables export/import/persist
 * in the monitor because summaries are not data. Portable mode copies live bytes
 * and can reconstruct collection classes; it is intentionally not zero-copy.
 */
export function createZerocopyDevTools(options: ZerocopyDevToolsOptions = {}) {
  const maxAge = options.maxAge ?? 50;
  if (!Number.isSafeInteger(maxAge) || maxAge < 2) throw new RangeError('DevTools maxAge must be at least 2');
  if (options.mode !== undefined && options.mode !== 'summary' && options.mode !== 'portable') throw new TypeError('Unknown zerocopy DevTools mode');
  if (options.mode !== 'portable') {
    return {
      maxAge,
      stateSanitizer: sanitizeZerocopyState,
      actionSanitizer: sanitizeZerocopyState,
      features: { import: false, export: false, persist: false },
    };
  }
  return {
    maxAge,
    serialize: {
      options: true as const,
      replacer(_key: string, value: unknown): unknown {
        // Escape ordinary user objects with the reserved key as well. A checkpoint's
        // state tree is tagged arrays, so it cannot accidentally invoke this reviver.
        if (isZerocopyCollection(value) || (isPlainRecord(value) && Object.hasOwn(value, DEVTOOLS_TAG))) {
          return { [DEVTOOLS_TAG]: true, checkpoint: encodeZerocopyState(value, options) };
        }
        return value;
      },
      reviver(_key: string, value: unknown): unknown {
        if (isPlainRecord(value) && value[DEVTOOLS_TAG] === true && Object.hasOwn(value, 'checkpoint') && Object.keys(value).length === 2) {
          return decodeZerocopyState(value.checkpoint, options);
        }
        return value;
      },
    },
  };
}
