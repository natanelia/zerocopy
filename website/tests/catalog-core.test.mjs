import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_COUNTS, MAX_REVISION, entriesFor, editsFor, queryIds, calculate, product, productId, indexOfId, issuesFor } from '../assets/catalog-core.mjs';
import { reference, verifyAnswer } from '../assets/catalog-reference.mjs';

test('catalog queries retain 1,000 requests, 910 hits, 90 misses and 20% Unicode product names', () => {
  for (const count of PRODUCT_COUNTS) {
    const map = new Map(entriesFor(count)), ids = queryIds(count);
    assert.equal(map.size, count);
    assert.equal([...map.values()].filter(value => value.name.startsWith('商品 · ')).length, count / 5);
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    const answer = calculate(map, ids); verifyAnswer(answer, reference(count, 0, ids));
    assert.equal(answer.lookup.found, 910); assert.equal(answer.lookup.missing, 90);
    assert.equal(answer.validation.found, 910); assert.equal(answer.validation.unavailable, 0);
    assert.equal(answer.lookup.rows.length, 12); assert.equal(answer.validation.issues[0].id, 'product/000000');
    assert.deepEqual(answer.lookup.rows[0], { id: 'product/000000', value: {
      name: '商品 · 0', category: 'books', metadata: { sku: 'SKU-000000', brand: 'Everyday', tags: ['online', 'featured'] },
      status: 'available', revision: 0, attributes: { priceCents: 0, stock: 5, currency: 'USD' },
    } });
    const changes = editsFor(count, 1);
    assert.equal(changes.length, 100); assert.equal(new Set(changes.map(([id]) => id)).size, 100);
    assert.deepEqual(changes.map(([id]) => id), ids.slice(0, 100));
  }
});

test('100 sparse replacements preserve the initial catalog through every allowed revision', () => {
  const count = 1000, initial = new Map(entriesFor(count)), current = new Map(initial), ids = queryIds(count);
  for (let revision = 1; revision <= MAX_REVISION; revision++) {
    for (const [id, value] of editsFor(count, revision)) current.set(id, value);
    verifyAnswer(calculate(initial, ids), reference(count, 0, ids));
    const answer = calculate(current, ids); verifyAnswer(answer, reference(count, revision, ids));
    assert.equal([...current].filter(([id, value]) => value !== initial.get(id)).length, 100);
    assert.equal(answer.lookup.revisionSum, revision * 100);
    assert.equal(answer.validation.unavailable, revision % 2 ? 100 : 0);
    assert.equal(initial.get('product/000000').attributes.priceCents, 0);
    assert.equal(initial.get('product/000000').status, 'available');
    assert.equal(current.get('product/000000').attributes.priceCents, 2500);
    assert.equal(current.get('product/000000').attributes.stock, revision % 2 ? 0 : 5);
    assert.equal(current.get('product/000000').status, revision % 2 ? 'unavailable' : 'available');
    assert.deepEqual(issuesFor(current.get('product/000000')), []);
  }
  assert.throws(() => { current.get('product/000000').attributes.priceCents = 99; }, TypeError);
  assert.throws(() => { current.get('product/000000').metadata.tags.push('changed'); }, TypeError);
});

test('fingerprints and the independent oracle cover every catalog field outside the visible page', () => {
  const count = 1000, map = new Map(entriesFor(count)), ids = queryIds(count), expected = reference(count, 0, ids);
  const laterId = ids[501], original = map.get(laterId);
  assert.ok(original); assert.ok(!expected.lookup.rows.some(row => row.id === laterId));
  const corruptions = {
    name: value => { value.name += ' changed'; },
    category: value => { value.category = 'other'; },
    sku: value => { value.metadata.sku += '-changed'; },
    brand: value => { value.metadata.brand += ' changed'; },
    firstTag: value => { value.metadata.tags[0] = 'changed'; },
    secondTag: value => { value.metadata.tags[1] = 'changed'; },
    status: value => { value.status = 'unavailable'; },
    revision: value => { value.revision++; },
    priceCents: value => { value.attributes.priceCents++; },
    stock: value => { value.attributes.stock++; },
    currency: value => { value.attributes.currency = 'EUR'; },
  };
  for (const [field, corrupt] of Object.entries(corruptions)) {
    const wrong = structuredClone(original); corrupt(wrong); map.set(laterId, wrong);
    const answer = calculate(map, ids);
    assert.deepEqual(answer.lookup.rows, expected.lookup.rows, `${field} is outside the visible page`);
    assert.notEqual(answer.lookup.fingerprint, expected.lookup.fingerprint, `${field} changes the full query fingerprint`);
    assert.equal(answer.validation.fingerprint, answer.lookup.fingerprint);
    assert.throws(() => verifyAnswer(answer, expected), /reference/, field);
  }
  map.set(laterId, original); verifyAnswer(calculate(map, ids), expected);
});

test('catalog validation rejects invalid prices, stock and unavailable inventory', () => {
  const valid = structuredClone(product(0, 1));
  for (const priceCents of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '2500']) {
    assert.deepEqual(issuesFor({ ...valid, attributes: { ...valid.attributes, priceCents } }), ['Price must be a positive integer number of cents']);
  }
  for (const stock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '0']) {
    const value = { ...valid, status: 'available', attributes: { ...valid.attributes, stock } };
    assert.deepEqual(issuesFor(value), ['Stock must be a nonnegative integer']);
  }
  assert.deepEqual(issuesFor({ ...valid, attributes: { ...valid.attributes, stock: 1 } }), ['Unavailable product must have zero stock']);
});

test('oracle requires exact task coverage and preserves missing selected product behavior', () => {
  const map = new Map(entriesFor(1000)), ids = queryIds(1000, 'product/099999'), expected = reference(1000, 0, ids);
  assert.equal(expected.lookup.found, 909); assert.equal(expected.lookup.missing, 91);
  verifyAnswer(calculate(map, ids, 'lookup'), expected, 'lookup');
  verifyAnswer(calculate(map, ids, 'validate'), expected, 'validate');
  assert.throws(() => verifyAnswer(calculate(map, ids, 'lookup'), expected), /coverage/);
  assert.throws(() => verifyAnswer({ ...expected, extra: true }, expected), /coverage/);
  assert.throws(() => calculate(map, ids, 'unknown'));
  assert.equal(indexOfId('product/000000'), 0); assert.equal(indexOfId('product/099999'), 99999);
  for (const id of ['product/0', 'product/0000000', 'other/000000', null]) assert.equal(indexOfId(id), -1);
  assert.throws(() => product(-1)); assert.throws(() => productId(100000)); assert.throws(() => product(0, -1));
  assert.throws(() => editsFor(1000, 0)); assert.throws(() => editsFor(1000, MAX_REVISION + 1));
  assert.throws(() => queryIds(1000, 'x'.repeat(65))); assert.throws(() => queryIds(1000, null));
  for (const count of [7919, 1001, 15838]) {
    assert.throws(() => entriesFor(count)); assert.throws(() => queryIds(count)); assert.throws(() => editsFor(count, 1));
  }
});
