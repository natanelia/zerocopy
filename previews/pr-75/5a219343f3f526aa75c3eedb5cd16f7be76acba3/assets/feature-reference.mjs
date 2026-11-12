/** Independent answer calculation over generated records, outside measured regions. */
import { feature, indexOfId, EDIT_COUNT, PAGE_SIZE } from './feature-core.mjs';
export function reference(count, revision, ids) {
  const changed = new Set(Array.from({ length: EDIT_COUNT }, (_, i) => i * 7919 % count));
  const rows = [], issues = [];
  let found = 0, missing = 0, invalid = 0, closed = 0, revisionSum = 0, fingerprint = 2166136261;
  const digest = text => { for (const char of text.split('')) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 0x01000193) >>> 0; };
  for (const id of ids) {
    const index = indexOfId(id);
    if (index < 0 || index >= count) { digest(`${id}\0missing\n`); missing++; continue; }
    const value = feature(index, changed.has(index) ? revision : 0);
    digest(id + '\0' + JSON.stringify([value.name, value.roadClass, value.bounds, value.status, value.revision, value.attributes.lanes, value.attributes.speedLimit, value.attributes.access]) + '\n');
    found++; revisionSum += value.revision;
    if (rows.length < PAGE_SIZE) rows.push({ id, value });
    if (value.status === 'closed') closed++;
    const errors = [];
    if (value.attributes.lanes < 1 || value.attributes.lanes % 1 !== 0) errors.push('Lane count must be positive');
    if (value.status === 'closed' && value.attributes.speedLimit !== 0) errors.push('Closed road must have a zero speed limit');
    const [left, top, right, bottom] = value.bounds;
    if (![left, top, right, bottom].every(Number.isFinite) || !(right > left && bottom > top)) errors.push('Bounds must have positive area');
    if (errors.length) { invalid++; if (issues.length < PAGE_SIZE) issues.push({ id, errors }); }
  }
  return { lookup: { requested: ids.length, found, missing, revisionSum, fingerprint, rows }, validation: { requested: ids.length, found, invalid, closed, revisionSum, fingerprint, issues } };
}
export function verifyAnswer(answer, expected, task = 'both') {
  const keys = task === 'both' ? ['lookup', 'validation'] : task === 'lookup' ? ['lookup'] : task === 'validate' ? ['validation'] : [];
  if (!keys.length || !answer || JSON.stringify(Object.keys(answer).sort()) !== JSON.stringify([...keys].sort())) throw new Error('Feature answer task coverage does not match');
  for (const key of Object.keys(answer)) if (!['lookup', 'validation'].includes(key) || JSON.stringify(answer[key]) !== JSON.stringify(expected[key])) throw new Error(`Feature ${key} did not match the independent reference`);
  return true;
}
