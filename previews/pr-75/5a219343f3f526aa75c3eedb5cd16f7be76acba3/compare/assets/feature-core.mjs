/** Synthetic road attributes, keyed reads and sparse replacements. No library dependency. */
export const KINDS = ['shared', 'native', 'immutable', 'immer'];
export const LABELS = { shared: 'SharedMap', native: 'Native Map', immutable: 'Immutable.js Map', immer: 'Immer Map' };
export const MAX_FEATURES = 100_000;
export const FEATURE_COUNTS = [1_000, 10_000, 100_000];
export const READ_COUNT = 1_000;
export const EDIT_COUNT = 100;
export const PAGE_SIZE = 12;
export const MAX_REVISION = 12;
export const RPC = 'zerocopy/feature-map/v1';

export function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function validateCount(value) {
  if (!FEATURE_COUNTS.includes(value)) throw new RangeError('Feature count must be 1,000, 10,000 or 100,000');
  return value;
}
export function featureId(index) { return `road/${String(integer(index, 0, MAX_FEATURES - 1, 'Feature index')).padStart(6, '0')}`; }
export function indexOfId(id) {
  if (typeof id !== 'string' || !/^road\/\d{6}$/.test(id)) return -1;
  return Number(id.slice(5));
}
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function feature(index, revision = 0) {
  integer(index, 0, MAX_FEATURES - 1, 'Feature index'); integer(revision, 0, MAX_REVISION, 'Revision');
  const x = index % 1000, y = Math.floor(index / 1000);
  return deepFreeze({ name: `${index % 5 === 0 ? '道路 · ' : 'Road '}${index}`, roadClass: ['local', 'collector', 'arterial'][index % 3],
    bounds: [x, y, x + 0.75, y + 0.35], status: revision % 2 ? 'closed' : 'open', revision,
    attributes: { lanes: revision > 0 ? 2 : index % 97 === 0 ? 0 : 1 + index % 4, speedLimit: revision % 2 ? 0 : 30 + index % 7 * 10, access: index % 11 ? 'public' : 'private' } });
}
export function entriesFor(count) {
  validateCount(count);
  return Array.from({ length: count }, (_, index) => [featureId(index), feature(index)]);
}
/** First 100 requested IDs are also the edited IDs. Every tenth remaining ID is absent. */
export function queryIds(count, selected = 'road/000000') {
  validateCount(count);
  if (typeof selected !== 'string' || selected.length > 64) throw new RangeError('Feature ID must contain at most 64 characters');
  return [selected, ...Array.from({ length: READ_COUNT - 1 }, (_, offset) => {
    const i = offset + 1;
    return i >= EDIT_COUNT && i % 10 === 0 ? `missing/${i}` : featureId(i * 7919 % count);
  })];
}
export function editsFor(count, revision) {
  validateCount(count); integer(revision, 1, MAX_REVISION, 'Revision');
  return Array.from({ length: EDIT_COUNT }, (_, i) => { const index = i * 7919 % count; return [featureId(index), feature(index, revision)]; });
}
export function issuesFor(value) {
  const issues = [];
  if (!Number.isInteger(value.attributes.lanes) || value.attributes.lanes < 1) issues.push('Lane count must be positive');
  if (value.status === 'closed' && value.attributes.speedLimit !== 0) issues.push('Closed road must have a zero speed limit');
  if (value.bounds.length !== 4 || !value.bounds.every(Number.isFinite) || value.bounds[0] >= value.bounds[2] || value.bounds[1] >= value.bounds[3]) issues.push('Bounds must have positive area');
  return issues;
}
function fingerprintRecord(hash, id, value) {
  const text = id + '\0' + (value === undefined ? 'missing' : JSON.stringify([value.name, value.roadClass, value.bounds, value.status, value.revision, value.attributes.lanes, value.attributes.speedLimit, value.attributes.access])) + '\n';
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
  let found = 0, invalid = 0, closed = 0, revisionSum = 0, fingerprint = 2166136261;
  const issues = [];
  for (const id of ids) {
    const value = map.get(id); fingerprint = fingerprintRecord(fingerprint, id, value); if (value === undefined) continue;
    found++; revisionSum += value.revision; if (value.status === 'closed') closed++;
    const errors = issuesFor(value);
    if (errors.length) { invalid++; if (issues.length < PAGE_SIZE) issues.push({ id, errors }); }
  }
  return { requested: ids.length, found, invalid, closed, revisionSum, fingerprint, issues };
}
export function calculate(map, ids, task = 'both') {
  if (!['lookup', 'validate', 'both'].includes(task)) throw new RangeError('Unknown feature task');
  return { ...(task !== 'validate' ? { lookup: lookup(map, ids) } : {}), ...(task !== 'lookup' ? { validation: validate(map, ids) } : {}) };
}
export const yieldTask = () => new Promise(resolve => typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0));
