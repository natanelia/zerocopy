/** Freeze decoded JSON and internally built JSON trees, not caller input.
 * Their arrays are dense and have no extra properties. Scan those arrays
 * directly so each coordinate or nested array needs no Object.values copy.
 * Keep an explicit work list so deeply nested JSON does not use the call stack.
 */
export function freezeJSON<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const todo: object[] = [value as object];
  while (todo.length) {
    const item = todo.pop()!;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const child = item[i];
        if (child !== null && typeof child === 'object') todo.push(child);
      }
    } else {
      for (const child of Object.values(item)) {
        if (child !== null && typeof child === 'object') todo.push(child);
      }
    }
    Object.freeze(item);
  }
  return value;
}
