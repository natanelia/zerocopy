import { SharedMap } from './shared';
import { arenaOf, type Arena } from './arena';
import type { ValueOf } from './types';
import { createZerocopyCodec, isPlainRecord, isSharedCollection, sharedCollectionKind, type ZerocopyCodec } from './redux-codec';
export { createZerocopyCodec, isSharedCollection } from './redux-codec';
export type { SharedCollection, ZerocopyCodec, ZerocopyCodecOptions, ZerocopyReduxEnvelope, EncodedReduxValue } from './redux-codec';

/** Admit plain Redux values and supported immutable snapshots. Custom comparator
 * functions are not portable and remain non-serializable.
 */
export function isZerocopySerializable(value: unknown): boolean {
  if (isSharedCollection(value)) {
    try { value.toWorkerData(); return true; } catch { return false; }
  }
  return value == null || ['undefined', 'string', 'boolean', 'number'].includes(typeof value) || Array.isArray(value) || isPlainRecord(value);
}
/** Treat validated snapshots as atomic values. Never scan their items on dispatch. */
export function getZerocopyEntries(value: unknown): [string, unknown][] {
  if (isSharedCollection(value) || value === null || typeof value !== 'object') return [];
  return Object.entries(value);
}
export const zerocopyMiddlewareOptions = Object.freeze({
  serializableCheck: Object.freeze({ isSerializable: isZerocopySerializable, getEntries: getZerocopyEntries }),
});

/** A bounded single-entry cache keyed by immutable leaf and arena identity.
 * Use one selector per row/component. Keep selectors outside reducers.
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
 * that view, then verify the frozen class and its actual private arena brand.
 */
export type SharedMapView<T extends string> = Pick<SharedMap<T>, keyof SharedMap<T>>;
/** Optional no-op guard. The core write path is unchanged. */
export function setSharedMapValue<T extends string>(map: SharedMapView<T>, key: string, value: ValueOf<T>, equals: (previous: ValueOf<T>, next: ValueOf<T>) => boolean = Object.is): SharedMap<T> {
  if (sharedCollectionKind(map) !== 'SharedMap') throw new TypeError('Expected a frozen SharedMap');
  return map.has(key) && equals(map.get(key)!, value) ? map as SharedMap<T> : map.set(key, value);
}

/** Display-only metadata. This does not change the real store or retained states.
 * The result is NOT a portable backup.
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

/** JSAN 3.1.14 can reinterpret an ordinary $jsan property after JSON revival.
 * Reject this boundary explicitly instead of silently changing application data.
 * createZerocopyCodec().stringify/parse has no such reserved-key restriction.
 */
function assertDevToolsRecord(value: unknown): void {
  const seen = new WeakSet<object>(), pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || isSharedCollection(item) || seen.has(item)) continue;
    seen.add(item);
    if (Object.prototype.hasOwnProperty.call(item, '$jsan')) {
      throw new TypeError('zerocopy Redux: $jsan is reserved by DevTools; use createZerocopyCodec for this backup');
    }
    if (Array.isArray(item) || isPlainRecord(item)) for (const child of Object.values(item)) pending.push(child);
  }
}

export interface ZerocopyDevToolsOptions {
  /** Summary does not scan shared items. Portable mode walks collection contents. */
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
        if (isSharedCollection(value)) return codec.encode(value);
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, '$jsan')) assertDevToolsRecord(value);
        // Escape collisions with our own marker, including its whole plain subtree.
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, '$zerocopyRedux')) {
          assertDevToolsRecord(value); return codec.encode(value);
        }
        return value;
      },
      reviver(_key: string, value: any): any {
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, '$zerocopyRedux')) {
          const restored = codec.decode(value); assertDevToolsRecord(restored); return restored;
        }
        return value;
      },
    },
  };
}
