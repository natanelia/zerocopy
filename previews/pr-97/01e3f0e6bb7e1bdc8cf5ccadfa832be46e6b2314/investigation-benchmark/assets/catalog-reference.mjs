/** Independent catalog answer calculation over generated records, outside measured regions. */
import { product, indexOfId, EDIT_COUNT, PAGE_SIZE } from './catalog-core.mjs';
export function reference(count, revision, ids) {
  const changed = new Set(Array.from({ length: EDIT_COUNT }, (_, i) => i * 7919 % count));
  const rows = [], issues = [];
  let found = 0, missing = 0, invalid = 0, unavailable = 0, revisionSum = 0, fingerprint = 2166136261;
  const digest = text => { for (const char of text.split('')) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 0x01000193) >>> 0; };
  for (const id of ids) {
    const index = indexOfId(id);
    if (index < 0 || index >= count) { digest(`${id}\0missing\n`); missing++; continue; }
    const value = product(index, changed.has(index) ? revision : 0);
    digest(id + '\0' + JSON.stringify([value.name, value.category, value.metadata.sku, value.metadata.brand, value.metadata.tags,
      value.status, value.revision, value.attributes.priceCents, value.attributes.stock, value.attributes.currency]) + '\n');
    found++; revisionSum += value.revision;
    if (rows.length < PAGE_SIZE) rows.push({ id, value });
    if (value.status === 'unavailable') unavailable++;
    const errors = [];
    if (value.attributes.priceCents % 1 !== 0 || value.attributes.priceCents < 1 || value.attributes.priceCents > Number.MAX_SAFE_INTEGER) errors.push('Price must be a positive integer number of cents');
    if (value.attributes.stock % 1 !== 0 || value.attributes.stock < 0 || value.attributes.stock > Number.MAX_SAFE_INTEGER) errors.push('Stock must be a nonnegative integer');
    if (value.status === 'unavailable' && value.attributes.stock !== 0) errors.push('Unavailable product must have zero stock');
    if (errors.length) { invalid++; if (issues.length < PAGE_SIZE) issues.push({ id, errors }); }
  }
  return { lookup: { requested: ids.length, found, missing, revisionSum, fingerprint, rows }, validation: { requested: ids.length, found, invalid, unavailable, revisionSum, fingerprint, issues } };
}
export function verifyAnswer(answer, expected, task = 'both') {
  const keys = task === 'both' ? ['lookup', 'validation'] : task === 'lookup' ? ['lookup'] : task === 'validate' ? ['validation'] : [];
  if (!keys.length || !answer || JSON.stringify(Object.keys(answer).sort()) !== JSON.stringify([...keys].sort())) throw new Error('Product catalog answer task coverage does not match');
  for (const key of Object.keys(answer)) if (!['lookup', 'validation'].includes(key) || JSON.stringify(answer[key]) !== JSON.stringify(expected[key])) throw new Error(`Product catalog ${key} did not match the independent reference`);
  return true;
}
