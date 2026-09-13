import { SharedMap } from './shared';
import { arenaOf, type Arena } from './arena';
import type { ValueOf } from './types';
import { createZerocopyCodec, isPlainRecord, isSharedCollection, sharedCollectionKind, type ZerocopyCodec } from './redux-codec';
export { createZerocopyCodec, isSharedCollection } from './redux-codec';
export type { SharedCollection, ZerocopyCodec, ZerocopyCodecOptions, ZerocopyReduxEnvelope, EncodedReduxValue } from './redux-codec';

/** Match RTK's plain-value policy, while admitting supported immutable snapshots.
 * Custom comparator functions remain non-serializable. The codec rejects them too.
 */
export function isZerocopySerializable(value: unknown): boolean {
  if (isSharedCollection(value)) {
    try { value.toWorkerData(); return true; } catch { return false; }
  }
  return value == null || ['undefined', 'string', 'boolean', 'number'].includes(typeof value) || Array.isArray(value) || isPlainRecord(value);
}
/** Treat snapshots as validated atomic values. Never enumerate WASM internals or
 * decode every entity on every dispatch. Other state and actions are still checked.
 */
export function getZerocopyEntries(value: unknown): [string, unknown][] {
  if (isSharedCollection(value) || value === null || typeof value !== 'object') return [];
  return Object.entries(value);
}
export const zerocopyMiddlewareOptions = Object.freeze({
  serializableCheck: Object.freeze({ isSerializable: isZerocopySerializable, getEntries: getZerocopyEntries }),
});

/** A single-entry selector cache, bounded per selector instance. It uses the
 * immutable leaf identity, not decoded-object identity or the current root alone.
 * Make one selector per row/component. Keep selectors outside reducers.
 */
export function createSharedMapValueSelector<State, T extends string>(
  selectMap: (state: State) => SharedMap<T>,
  selectKey: (state: State) => string,
): (state: State) => ValueOf<T> | undefined {
  let lastArena: Arena | undefined, lastLeaf = -1, lastType: string | undefined;
  let lastValue: ValueOf<T> | undefined;
  return state => {
    const map = selectMap(state), key = selectKey(state), arena = arenaOf(map);
    const leaf = arena.find(map.root, key);
    if (arena !== lastArena || leaf !== lastLeaf || map.valueType !== lastType) {
      lastValue = leaf ? arena.leafValue(map.valueType, leaf) : undefined;
      lastArena = arena; lastLeaf = leaf; lastType = map.valueType;
    }
    return lastValue;
  };
}
/** Immer's Draft type maps public fields even for a non-draftable class. Accept
 * that public view, then verify the real frozen class and its private arena brand.
 */
export type SharedMapView<T extends string> = Pick<SharedMap<T>, keyof SharedMap<T>>;
/** Optional no-op guard. Equality is Object.is unless the application supplies
 * a pure domain-specific comparison. The core write path is not made slower.
 */
export function setSharedMapValue<T extends string>(map: SharedMapView<T>, key: string, value: ValueOf<T>, equals: (previous: ValueOf<T>, next: ValueOf<T>) => boolean = Object.is): SharedMap<T> {
  if (sharedCollectionKind(map) !== 'SharedMap') throw new TypeError('Expected a frozen SharedMap');
  return map.has(key) && equals(map.get(key)!, value) ? map as SharedMap<T> : map.set(key, value);
}

/** Replace collections with small display-only metadata. This does not change
 * the real store or DevTools' in-page retained states. Summaries are NOT backups.
 */
export function summarizeZerocopyState(state: unknown): any {
  const seen = new WeakMap<object, unknown>();
  const walk = (value: unknown): any => {
    if (isSharedCollection(value)) {
      let descriptor: unknown;
      try { descriptor = value.toWorkerData(); } catch { descriptor = 'local comparator'; }
      return { $zerocopy: sharedCollectionKind(value), size: value.size, arena: arenaOf(value).id, snapshot: descriptor };
    }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isPlainRecord(value))) return value;
    if (seen.has(value)) return seen.get(value);
    const result: any = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
    seen.set(value, result);
    for (const key of Object.keys(value)) Object.defineProperty(result, key, { value: walk((value as any)[key]), enumerable: true, configurable: true, writable: true });
    return result;
  };
  return walk(state);
}

export interface ZerocopyDevToolsOptions {
  /** Summary is O(number of ordinary state fields), not O(number of shared items).
   * Portable mode walks collection contents and should be opt-in for large maps.
   */
  mode?: 'summary' | 'portable';
  maxAge?: number;
  codec?: ZerocopyCodec;
}
export function createZerocopyDevToolsOptions(options: ZerocopyDevToolsOptions = {}) {
  const maxAge = options.maxAge ?? 50;
  if (!Number.isSafeInteger(maxAge) || maxAge < 2) throw new RangeError('DevTools maxAge must be at least 2');
  if (options.mode !== undefined && options.mode !== 'summary' && options.mode !== 'portable') throw new TypeError('Invalid DevTools mode');
  if (options.mode !== 'portable') return { maxAge, stateSanitizer: summarizeZerocopyState, actionSanitizer: summarizeZerocopyState };
  const codec = options.codec ?? createZerocopyCodec();
  return {
    maxAge,
    serialize: {
      options: true,
      replacer(_key: string, value: any): any {
        // Escape ordinary records with the reserved marker too. User data cannot
        // accidentally become a collection when the reviver processes it.
        return isSharedCollection(value) || (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, '$zerocopyRedux')) ? codec.encode(value) : value;
      },
      reviver(_key: string, value: any): any {
        return isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, '$zerocopyRedux') ? codec.decode(value) : value;
      },
    },
  };
}
