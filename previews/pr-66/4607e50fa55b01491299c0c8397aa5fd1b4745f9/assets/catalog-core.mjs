/** Synthetic product catalog, keyed reads and sparse replacements. No library dependency. */
export const KINDS = ['shared', 'native', 'immutable', 'immer'];
export const LABELS = { shared: 'SharedMap', native: 'Native Map', immutable: 'Immutable.js Map', immer: 'Immer Map' };
export const MAX_PRODUCTS = 100_000;
export const PRODUCT_COUNTS = [1_000, 10_000, 100_000];
export const READ_COUNT = 1_000;
export const EDIT_COUNT = 100;
export const PAGE_SIZE = 12;
export const MAX_REVISION = 12;

export function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function validateCount(value) {
  if (!PRODUCT_COUNTS.includes(value)) throw new RangeError('Product count must be 1,000, 10,000 or 100,000');
  return value;
}
export function productId(index) { return `product/${String(integer(index, 0, MAX_PRODUCTS - 1, 'Product index')).padStart(6, '0')}`; }
export function indexOfId(id) {
  if (typeof id !== 'string' || !/^product\/\d{6}$/.test(id)) return -1;
  return Number(id.slice(8));
}
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function product(index, revision = 0) {
  integer(index, 0, MAX_PRODUCTS - 1, 'Product index'); integer(revision, 0, MAX_REVISION, 'Revision');
  return deepFreeze({ name: `${index % 5 === 0 ? '商品 · ' : 'Product '}${index}`, category: ['books', 'electronics', 'home'][index % 3],
    metadata: { sku: `SKU-${String(index).padStart(6, '0')}`, brand: ['Everyday', 'Studio', 'Essential'][index % 3], tags: ['online', index % 11 ? 'standard' : 'featured'] },
    status: revision % 2 ? 'unavailable' : 'available', revision,
    attributes: { priceCents: revision > 0 ? 2500 + index % 500 * 100 : index % 97 === 0 ? 0 : 500 + index % 500 * 100,
      stock: revision % 2 ? 0 : 5 + index % 20, currency: 'USD' } });
}
export function entriesFor(count) {
  validateCount(count);
  return Array.from({ length: count }, (_, index) => [productId(index), product(index)]);
}
/** First 100 requested IDs are also the edited IDs. Every tenth remaining ID is absent. */
export function queryIds(count, selected = 'product/000000') {
  validateCount(count);
  if (typeof selected !== 'string' || selected.length > 64) throw new RangeError('Product ID must contain at most 64 characters');
  return [selected, ...Array.from({ length: READ_COUNT - 1 }, (_, offset) => {
    const i = offset + 1;
    return i >= EDIT_COUNT && i % 10 === 0 ? `missing/${i}` : productId(i * 7919 % count);
  })];
}
export function editsFor(count, revision) {
  validateCount(count); integer(revision, 1, MAX_REVISION, 'Revision');
  return Array.from({ length: EDIT_COUNT }, (_, i) => { const index = i * 7919 % count; return [productId(index), product(index, revision)]; });
}
export function issuesFor(value) {
  const issues = [];
  if (!Number.isSafeInteger(value.attributes.priceCents) || value.attributes.priceCents < 1) issues.push('Price must be a positive integer number of cents');
  if (!Number.isSafeInteger(value.attributes.stock) || value.attributes.stock < 0) issues.push('Stock must be a nonnegative integer');
  if (value.status === 'unavailable' && value.attributes.stock !== 0) issues.push('Unavailable product must have zero stock');
  return issues;
}
function fingerprintRecord(hash, id, value) {
  const text = id + '\0' + (value === undefined ? 'missing' : JSON.stringify([value.name, value.category, value.metadata.sku, value.metadata.brand, value.metadata.tags,
    value.status, value.revision, value.attributes.priceCents, value.attributes.stock, value.attributes.currency])) + '\n';
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}
export function lookup(map, ids) {
  let found = 0, missing = 0, revisionSum = 0, fingerprint = 2166136261;
  const rows = [];
  for (const id of ids) {
    const value = map.get(id);
    fingerprint = fingerprintRecord(fingerprint, id, value);
    if (value === undefined) { missing++; continue; }
    found++; revisionSum += value.revision;
    if (rows.length < PAGE_SIZE) rows.push({ id, value });
  }
  return { requested: ids.length, found, missing, revisionSum, fingerprint, rows };
}
export function validate(map, ids) {
  let found = 0, invalid = 0, unavailable = 0, revisionSum = 0, fingerprint = 2166136261;
  const issues = [];
  for (const id of ids) {
    const value = map.get(id); fingerprint = fingerprintRecord(fingerprint, id, value); if (value === undefined) continue;
    found++; revisionSum += value.revision; if (value.status === 'unavailable') unavailable++;
    const errors = issuesFor(value);
    if (errors.length) { invalid++; if (issues.length < PAGE_SIZE) issues.push({ id, errors }); }
  }
  return { requested: ids.length, found, invalid, unavailable, revisionSum, fingerprint, issues };
}
export function calculate(map, ids, task = 'both') {
  if (!['lookup', 'validate', 'both'].includes(task)) throw new RangeError('Unknown product catalog task');
  return { ...(task !== 'validate' ? { lookup: lookup(map, ids) } : {}), ...(task !== 'lookup' ? { validation: validate(map, ids) } : {}) };
}
