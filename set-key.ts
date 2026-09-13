/** Type-tagged keys preserve number/string identity and SameValueZero numbers. */
export function encodeSetKey(value: string | number): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Set values must be strings or numbers');
  return (typeof value === 'number' ? 'n:' : 's:') + String(value);
}
export function decodeSetKey(value: string): string | number { return value.startsWith('n:') ? Number(value.slice(2)) : value.slice(2); }
