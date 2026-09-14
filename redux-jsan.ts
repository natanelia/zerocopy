import { createZerocopyCodec, isPlainRecord, isSharedCollection, type ZerocopyCodec } from './redux-codec';

const TEXT_TAG = '$zerocopyReduxText';

/** Keep revived values private until the surrounding JSON object is complete. */
class Decoded {
  #value: unknown;
  constructor(value: unknown) { this.#value = value; }
  unwrap(): unknown { return this.#value; }
}

/**
 * Preserve the outer state shape, but encode special values as codec JSON strings.
 * JSAN 3.x runs a second pass when the raw text contains a "$jsan" token. That pass
 * must not reinterpret literal user keys or write into restored frozen snapshots.
 * Disable JSAN reference/special-value tags and encode every literal marker token.
 */
export function createPortableSerialization(codec: ZerocopyCodec = createZerocopyCodec()) {
  const decodedObjects = new WeakSet<object>();
  const wrap = (value: unknown) => ({ [TEXT_TAG]: codec.stringify(value) });
  const unwrap = (value: unknown): unknown => {
    if (value instanceof Decoded) {
      const result = value.unwrap();
      if (result !== null && typeof result === 'object') decodedObjects.add(result);
      return result;
    }
    if ((!Array.isArray(value) && !isPlainRecord(value)) || decodedObjects.has(value)) return value;
    for (const key of Object.keys(value)) {
      Object.defineProperty(value, key, { value: unwrap(value[key]), enumerable: true, configurable: true, writable: true });
    }
    return value;
  };
  return {
    options: {
      // Omitted JSAN flags are disabled. Toolkit types accept true or undefined,
      // not false. This shared optional flag also gives their weak type an overlap.
      date: undefined as undefined,
      refs: false,
      circular(): never { throw new TypeError('zerocopy Redux: cyclic DevTools state is not supported'); },
    },
    replacer(_key: string, value: unknown): unknown {
      if (isSharedCollection(value)) return wrap(value);
      if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) || value === '$jsan') return wrap(value);
      // Escape empty user keys too: JSON.parse uses '' for its final root visit.
      // Without this boundary an early undefined result deletes a real user field.
      if (isPlainRecord(value) && (Object.getPrototypeOf(value) === null || Object.hasOwn(value, '') || Object.hasOwn(value, '__proto__') || Object.hasOwn(value, '$jsan') || Object.hasOwn(value, '$zerocopyRedux') || Object.hasOwn(value, TEXT_TAG))) return wrap(value);
      if (Array.isArray(value)) {
        // JSAN iterates holes as undefined. The logical codec distinguishes them.
        const keys = Object.keys(value);
        if (keys.length !== value.length || keys.some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return wrap(value);
      } else if (value !== null && typeof value === 'object' && !isPlainRecord(value)) {
        return wrap(value); // The codec rejects unsupported class instances.
      }
      if (['function', 'symbol', 'bigint'].includes(typeof value)) return wrap(value);
      return value;
    },
    reviver(key: string, value: unknown): unknown {
      let result = value;
      if (isPlainRecord(value) && Object.keys(value).length === 1 && typeof value[TEXT_TAG] === 'string') {
        result = new Decoded(codec.parse(value[TEXT_TAG]));
      }
      // Literal empty user keys are inside codec text, not this wire tree.
      return key === '' ? unwrap(result) : result;
    },
  };
}
