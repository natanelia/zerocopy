import { product, EDIT_COUNT } from './catalog-core.mjs';

/** Independent expected answers: generated fixture data, never a tested map. */
export function readReference(count, revision, ids, definition) {
  const editedIndices = new Set();
  for (let i = 0; i < EDIT_COUNT; i++) editedIndices.add(i * 7919 % count);
  const rows = [], missingIds = [];
  let found = 0;
  for (const id of ids) {
    const match = /^product\/(\d{6})$/.exec(id), index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= count) { missingIds.push(id); continue; }
    found++;
    const recordRevision = editedIndices.has(index) ? revision : 0;
    const record = product(index, recordRevision);
    if (definition.workload === 'selective-fields') {
      // The fixture assigns books to every third record; odd edits mark it
      // unavailable. This deliberately does not call the measured predicate.
      if (index % 3 === 0 && recordRevision % 2 === 0) {
        rows.push({ id, name: record.name, priceCents: record.attributes.priceCents, revision: recordRevision });
      }
    } else rows.push({ id, value: record });
  }
  return { requested: ids.length, found, missing: missingIds.length, matched: rows.length, missingIds, rows };
}

/** Exact IDs, fields, counts, missing IDs and ordering, after measured queries. */
export function verifyReadAnswer(answer, expected) {
  if (JSON.stringify(answer) !== JSON.stringify(expected)) throw new Error('Catalog read output did not match the independent reference');
  return { passed: true, requested: expected.requested, found: expected.found, missing: expected.missing, matched: expected.matched,
    completeValuesChecked: expected.rows.length, idsFieldsCountsMissesAndOrder: true };
}
