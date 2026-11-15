import { KINDS, LABELS, READ_COUNT } from './catalog-core.mjs';

/** Fixed application queries. Changing these semantics requires a new version. */
export const READ_WORKLOAD_VERSION = 1;
export const READ_CASES = [
  ...KINDS.map(kind => ({ id: `full-${kind}-get`, kind, api: 'get', workload: 'full-object-get', freeze: 'deeply-frozen', label: `${LABELS[kind]} · .get()` })),
  ...KINDS.map(kind => ({ id: `selective-${kind}-get`, kind, api: 'get', workload: 'selective-fields', freeze: 'source-frozen; projection-mutable', label: `${LABELS[kind]} · .get()` })),
  { id: 'selective-shared-view', kind: 'shared', api: 'getView', workload: 'selective-fields', freeze: 'read-only-view; projection-mutable', label: 'SharedMap · getView()' },
  { id: 'materialize-shared-frozen', kind: 'shared', api: 'getView().toObject({ freeze: true })', workload: 'view-to-object-frozen', freeze: 'deeply-frozen', label: 'SharedMap · toObject({ freeze: true })' },
  { id: 'materialize-shared-mutable', kind: 'shared', api: 'getView().toObject()', workload: 'view-to-object-mutable', freeze: 'mutable-detached', label: 'SharedMap · toObject() · mutable' },
].map(definition => Object.freeze({ ...definition, collectionType: 'map', valueType: 'object', version: READ_WORKLOAD_VERSION }));

export function readCase(id) {
  const definition = READ_CASES.find(item => item.id === id);
  if (!definition) throw new RangeError('Unknown catalog read case');
  return definition;
}

export function validateReadIds(ids) {
  if (!Array.isArray(ids) || ids.length > READ_COUNT || ids.some(id => typeof id !== 'string' || id.length > 64)) {
    throw new RangeError(`A read query accepts at most ${READ_COUNT} bounded product IDs`);
  }
  return ids;
}

/**
 * The measured local operation: look up every ID, consume its declared output,
 * and keep the ordered answer. No verification, full-record fingerprint or
 * hidden materialization belongs in a selective query.
 */
export function runReadQuery(map, ids, definition) {
  const rows = [], missingIds = [];
  let found = 0;
  if (definition.workload === 'selective-fields') {
    if (definition.api === 'getView') {
      for (const id of ids) {
        const view = map.getView(id);
        if (view === undefined) { missingIds.push(id); continue; }
        found++;
        if (!view.equals('category', 'books') || !view.equals('status', 'available')) continue;
        rows.push({ id, name: view.get('name'), priceCents: view.get('attributes').get('priceCents'), revision: view.get('revision') });
      }
    } else {
      for (const id of ids) {
        const value = map.get(id);
        if (value === undefined) { missingIds.push(id); continue; }
        found++;
        if (value.category !== 'books' || value.status !== 'available') continue;
        rows.push({ id, name: value.name, priceCents: value.attributes.priceCents, revision: value.revision });
      }
    }
  } else {
    const materialize = definition.workload !== 'full-object-get';
    const frozen = definition.workload === 'view-to-object-frozen';
    for (const id of ids) {
      const source = materialize ? map.getView(id) : map.get(id);
      if (source === undefined) { missingIds.push(id); continue; }
      found++;
      const value = materialize ? frozen ? source.toObject({ freeze: true }) : source.toObject() : source;
      rows.push({ id, value });
    }
  }
  return { requested: ids.length, found, missing: missingIds.length, matched: rows.length, missingIds, rows };
}

/** Inspect already captured values after cold AND repeat; never read the map. */
export function verifyReadContract(answer, definition) {
  if (definition.workload === 'selective-fields') return { checkedObjects: 0, contract: 'projected-values', passed: true };
  const expectFrozen = definition.freeze === 'deeply-frozen';
  const pending = answer.rows.map(row => row.value), seen = new Set();
  let checkedObjects = 0;
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); checkedObjects++;
    if (Object.isFrozen(value) !== expectFrozen) throw new Error(`Read result violates ${definition.freeze} contract`);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
  }
  return { checkedObjects, contract: definition.freeze, passed: true };
}
