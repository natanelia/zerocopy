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

/** Only use with the exact text that JSON.parse consumed. A nested object or
 * array always needs another literal opening delimiter. Delimiters inside
 * strings and leading whitespace can only send us to the full traversal. */
export function freezeParsedJSON<T>(value: T, text: string): T {
  // For a short row, walking its few properties costs less than probing the text.
  if (text.length < 96) return freezeJSON(value);
  if (value === null || typeof value !== 'object') return value;
  if (text.indexOf('{', 1) === -1 && text.indexOf('[', 1) === -1) return Object.freeze(value);
  return freezeJSON(value);
}
