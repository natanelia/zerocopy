import { createZerocopyCodec, isPlainRecord, isSharedCollection, type ZerocopyCodec } from './redux-codec';

const TEXT_TAG = '$zerocopyReduxText';

/** JSON.parse calls a reviver before JSAN restores references. Keep decoded
 * values in private holders until a root/empty-key visit unwraps them. */
class Decoded {
  #value: unknown;
  constructor(value: unknown) { this.#value = value; }
  unwrap(): unknown { return this.#value; }
}

/**
 * Keep the outer state shape readable, but encode special values in JSON strings.
 * JSAN 3.x treats any raw "$jsan" token as a request for a second decode pass,
 * even when the token is user data. Disable its reference/special-value encoding
 * and escape that token, so the second pass cannot mutate restored snapshots.
 */
export function createPortableSerialization(codec: ZerocopyCodec = createZerocopyCodec()) {
  const wrap = (value: unknown) => ({ [TEXT_TAG]: codec.stringify(value) });
  const unwrap = (value: unknown): unknown => {
    if (value instanceof Decoded) return value.unwrap();
    if (!Array.isArray(value) && !isPlainRecord(value)) return value;
    for (const key of Object.keys(value)) {
      Object.defineProperty(value, key, { value: unwrap(value[key]), enumerable: true, configurable: true, writable: true });
    }
    return value;
  };
  return {
    options: {
      date: false, function: false, regex: false, undefined: false,
      error: false, symbol: false, map: false, set: false, nan: false, infinity: false,
      refs: false,
      circular(): never { throw new TypeError('zerocopy Redux: cyclic DevTools state is not supported'); },
    },
    replacer(_key: string, value: unknown): unknown {
      if (isSharedCollection(value)) return wrap(value);
      if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) || value === '$jsan') return wrap(value);
      if (isPlainRecord(value) && (Object.hasOwn(value, '$jsan') || Object.hasOwn(value, '$zerocopyRedux') || Object.hasOwn(value, TEXT_TAG))) return wrap(value);
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
      // A user property named '' can trigger this early. Private holders make
      // unwrapping idempotent: decoded user marker objects are never re-decoded.
      return key === '' ? unwrap(result) : result;
    },
  };
}
