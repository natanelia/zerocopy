/** JSON serialization for the opt-in typed value descriptor. */
type Task =
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'end'; value: object; text: string };

/**
 * Serialize plain data without invoking getters or toJSON methods. The explicit
 * stack accepts deep trees and detects cycles without rejecting repeated values.
 * Unlike legacy `object`, this path rejects data that JSON would silently drop.
 */
export function stringifyJsonObject(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Typed JSON values must be plain objects or arrays');
  }
  const active = new WeakSet<object>();
  const pending: Task[] = [{ kind: 'value', value }];
  const parts: string[] = [];
  while (pending.length) {
    const task = pending.pop()!;
    if (task.kind === 'text') { parts.push(task.text); continue; }
    if (task.kind === 'end') {
      active.delete(task.value); parts.push(task.text); continue;
    }
    const item = task.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      parts.push(JSON.stringify(item)); continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new TypeError('Typed JSON numbers must be finite');
      }
      parts.push(Object.is(item, -0) ? '-0' : JSON.stringify(item)); continue;
    }
    if (typeof item !== 'object') {
      throw new TypeError(`Unsupported typed JSON value: ${typeof item}`);
    }
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Typed JSON values must contain only plain objects and arrays');
    }
    if (active.has(item)) throw new TypeError('Typed JSON values must not contain cycles');
    const properties = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(properties);
    const length = array ? properties.length.value as number : 0;
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('Typed JSON values must not contain symbol keys');
      if (array && key === 'length') continue;
      const property = properties[key];
      if (!Object.hasOwn(property, 'value') || !property.enumerable) {
        throw new TypeError('Typed JSON values must contain only enumerable data properties');
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
        throw new TypeError('Typed JSON arrays must not contain extra properties');
      }
    }
    if (array && keys.length !== length + 1) throw new TypeError('Typed JSON arrays must not contain holes');
    active.add(item);
    parts.push(array ? '[' : '{');
    pending.push({ kind: 'end', value: item, text: array ? ']' : '}' });
    if (array) {
      for (let index = length - 1; index >= 0; index--) {
        pending.push({ kind: 'value', value: properties[index].value });
        if (index) pending.push({ kind: 'text', text: ',' });
      }
    } else {
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index] as string;
        pending.push({ kind: 'value', value: properties[key].value });
        pending.push({ kind: 'text', text: `${JSON.stringify(key)}:` });
        if (index) pending.push({ kind: 'text', text: ',' });
      }
    }
  }
  return parts.join('');
}
