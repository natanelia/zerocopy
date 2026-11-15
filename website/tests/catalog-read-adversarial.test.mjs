import assert from 'node:assert/strict';
import test from 'node:test';
import { product, productId, queryIds, EDIT_COUNT, PRODUCT_COUNTS } from '../assets/catalog-core.mjs';
import { READ_CASES, readCase, runReadQuery, verifyReadContract } from '../assets/catalog-read-workloads.mjs';
import { readReference, verifyReadAnswer } from '../assets/catalog-read-reference.mjs';

function fakeView(value, calls = []) {
  return {
    equals(field, wanted) { calls.push(['equals', field]); return value[field] === wanted; },
    get(field) {
      calls.push(['get', field]);
      const selected = value[field];
      return selected && typeof selected === 'object' ? fakeView(selected, calls) : selected;
    },
    toObject(options) {
      calls.push(['toObject', options]);
      const copy = structuredClone(value);
      if (options?.freeze) {
        const pending = [copy];
        while (pending.length) {
          const node = pending.pop();
          if (!node || typeof node !== 'object') continue;
          pending.push(...Object.values(node)); Object.freeze(node);
        }
      }
      return copy;
    },
  };
}

test('full-object get reads each requested ID once, preserves duplicates and retains complete ordinary values', () => {
  const first = product(0), second = product(3), calls = [];
  const values = new Map([['first', first], ['second', second]]);
  const map = {
    get(id) { calls.push(id); return values.get(id); },
    getView() { assert.fail('The full-object get workload must not use getView'); },
  };
  const ids = ['missing-a', 'second', 'first', 'missing-b', 'second'];
  const answer = runReadQuery(map, ids, readCase('full-shared-get'));
  assert.deepEqual(calls, ids);
  assert.deepEqual(answer.missingIds, ['missing-a', 'missing-b']);
  assert.deepEqual(answer.rows.map(row => row.id), ['second', 'first', 'second']);
  assert.strictEqual(answer.rows[0].value, second);
  assert.strictEqual(answer.rows[1].value, first);
  assert.strictEqual(answer.rows[2].value, second);
  assert.deepEqual(answer.rows[1].value.metadata.tags, ['online', 'featured']);
  assert.deepEqual([answer.requested, answer.found, answer.missing, answer.matched], [5, 3, 2, 3]);
});

test('selective get reads no unrelated fields and returns a detached ordered projection', () => {
  const unrelated = () => { assert.fail('A selective query must not inspect unrelated fields'); };
  const selected = { name: 'Selected', category: 'books', status: 'available', revision: 0,
    attributes: { priceCents: 0, get stock() { return unrelated(); } }, get metadata() { return unrelated(); } };
  const rejected = { category: 'home', get status() { assert.fail('Category predicate must short-circuit'); } };
  const unavailable = { category: 'books', status: 'unavailable', get name() { assert.fail('Unavailable record must not be projected'); } };
  const values = new Map([['a', selected], ['b', rejected], ['c', unavailable]]), calls = [];
  const map = { get(id) { calls.push(id); return values.get(id); }, getView() { assert.fail('get variant switched API'); } };
  const ids = ['a', 'missing', 'b', 'c', 'a'];
  const answer = runReadQuery(map, ids, readCase('selective-shared-get'));
  assert.deepEqual(calls, ids);
  assert.deepEqual(answer.rows, [{ id: 'a', name: 'Selected', priceCents: 0, revision: 0 }, { id: 'a', name: 'Selected', priceCents: 0, revision: 0 }]);
  answer.rows[0].name = 'Changed projection';
  assert.equal(selected.name, 'Selected');
  assert.equal(answer.rows[1].name, 'Selected');
  assert.deepEqual([answer.requested, answer.found, answer.missing, answer.matched], [5, 4, 1, 2]);
});

test('selective views call getView once per ID, use byte predicates and never fully materialize', () => {
  const records = new Map([['a', product(0)], ['b', product(1)], ['c', product(3, 1)]]);
  const lookedUp = [], fields = [];
  const map = {
    get() { assert.fail('The view workload must not call get'); },
    getView(id) {
      lookedUp.push(id);
      const value = records.get(id);
      if (value === undefined) return undefined;
      const view = fakeView(value, fields);
      view.toObject = () => { assert.fail('The selective view workload must not materialize full objects'); };
      return view;
    },
  };
  const ids = ['a', 'b', 'missing', 'c', 'a'];
  const answer = runReadQuery(map, ids, readCase('selective-shared-view'));
  assert.deepEqual(lookedUp, ids);
  assert.deepEqual(answer.rows.map(row => row.id), ['a', 'a']);
  assert.deepEqual(fields.filter(([method]) => method === 'equals').map(([, key]) => key),
    ['category', 'status', 'category', 'category', 'status', 'category', 'status']);
  assert.deepEqual(fields.filter(([method]) => method === 'get').map(([, key]) => key),
    ['name', 'attributes', 'priceCents', 'revision', 'name', 'attributes', 'priceCents', 'revision']);
});

test('materialization cases pass the explicit freeze option and return independent complete values', () => {
  for (const id of ['materialize-shared-frozen', 'materialize-shared-mutable']) {
    const definition = readCase(id), value = product(0), fields = [], view = fakeView(value, fields);
    const map = { get() { assert.fail('Materialization must use getView'); }, getView(key) { return key === 'found' ? view : undefined; } };
    const answer = runReadQuery(map, ['found', 'missing', 'found'], definition);
    assert.deepEqual(answer.rows.map(row => row.value), [value, value]);
    assert.notStrictEqual(answer.rows[0].value, value);
    assert.notStrictEqual(answer.rows[0].value, answer.rows[1].value);
    assert.deepEqual(fields, [['toObject', id.endsWith('frozen') ? { freeze: true } : undefined],
      ['toObject', id.endsWith('frozen') ? { freeze: true } : undefined]]);
    assert.equal(verifyReadContract(answer, definition).passed, true);
  }
});

test('contract verification examines captured values only and rejects deep freeze violations', () => {
  const frozen = readCase('full-shared-get'), mutable = readCase('materialize-shared-mutable');
  const value = product(0), calls = [];
  const answer = runReadQuery({ get(id) { calls.push(id); return value; } }, ['a', 'a'], frozen);
  const countBefore = calls.length;
  assert.equal(verifyReadContract(answer, frozen).passed, true);
  assert.equal(calls.length, countBefore);
  assert.throws(() => verifyReadContract({ rows: [{ value: Object.freeze({ child: {} }) }] }, frozen), /contract/);
  assert.throws(() => verifyReadContract({ rows: [{ value: { child: Object.freeze({}) } }] }, mutable), /contract/);
  assert.equal(verifyReadContract({ rows: [{ value: null }, { value: 0 }, { value: false }] }, frozen).checkedObjects, 0);
});

test('every declared case agrees across fixture sizes and retained/current revisions', () => {
  for (const count of PRODUCT_COUNTS) {
    const ids = queryIds(count), edited = new Set(Array.from({ length: EDIT_COUNT }, (_, i) => i * 7919 % count));
    for (const revision of [0, 1]) {
      const calls = [];
      const record = id => {
        const match = /^product\/(\d{6})$/.exec(id), index = match ? Number(match[1]) : -1;
        return index >= 0 && index < count ? product(index, edited.has(index) ? revision : 0) : undefined;
      };
      const map = {
        get(id) { calls.push(['get', id]); return record(id); },
        getView(id) { calls.push(['getView', id]); const value = record(id); return value === undefined ? undefined : fakeView(value); },
      };
      for (const definition of READ_CASES) {
        calls.length = 0;
        const answer = runReadQuery(map, ids, definition), expected = readReference(count, revision, ids, definition);
        assert.equal(verifyReadAnswer(answer, expected).passed, true);
        assert.equal(answer.requested, 1000); assert.equal(answer.found, 910); assert.equal(answer.missing, 90);
        assert.equal(calls.length, ids.length);
        assert.deepEqual(calls.map(([, id]) => id), ids);
        const api = definition.api === 'get' ? 'get' : 'getView';
        assert.ok(calls.every(([called]) => called === api));
      }
    }
    // Explicit expected values do not invoke the measured predicate or oracle.
    const selected = readReference(count, 1, [productId(0), productId(3)], readCase('selective-shared-get'));
    assert.ok(!selected.rows.some(row => row.id === productId(0)), 'edited product 0 is unavailable');
    const retained = readReference(count, 0, [productId(0)], readCase('full-shared-get'));
    assert.equal(retained.rows[0].value.status, 'available');
    assert.equal(retained.rows[0].value.attributes.priceCents, 0);
    assert.equal(retained.rows[0].value.revision, 0);
  }
});

test('independent verification rejects wrong IDs, fields, counts, misses and order', () => {
  for (const id of ['full-shared-get', 'selective-shared-view']) {
    const definition = readCase(id), ids = [productId(0), 'missing-a', productId(3), 'missing-b'];
    const expected = readReference(1000, 0, ids, definition);
    const mutations = [
      answer => { answer.rows[0].id = productId(6); },
      answer => { answer.rows.reverse(); },
      answer => { answer.found++; },
      answer => { answer.missing--; },
      answer => { answer.matched++; },
      answer => { answer.requested++; },
      answer => { answer.missingIds.reverse(); },
      answer => { answer.rows[0][definition.workload === 'selective-fields' ? 'name' : 'value'] = 'wrong'; },
    ];
    for (const mutate of mutations) {
      const answer = structuredClone(expected); mutate(answer);
      assert.throws(() => verifyReadAnswer(answer, expected), /independent reference/);
    }
  }
});
