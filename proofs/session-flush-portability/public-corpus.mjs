// Public sessions only. No endpoints, raw memory access, patched intrinsics, or timing.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baselineRoot, candidateRoot, output] = process.argv.slice(2);
assert.ok(baselineRoot && candidateRoot && output);
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

async function run(root) {
  const { SharedMap } = await import(pathToFileURL(resolve(root, 'dist/shared.js')).href);
  const { createSharedState, createSharedSession } = await import(pathToFileURL(resolve(root, 'dist/worker.js')).href);
  const cases = [];
  const errors = [];
  const sessions = [];
  const own = session => { sessions.push(session); return session; };
  const options = { copy: false, onError: error => errors.push([error.name, error.message]) };
  const m0 = new SharedMap('number').set('n', 0);
  const m1 = m0.set('n', 1);
  const m2 = m1.set('n', 2);
  const record = (keys, value) => Object.fromEntries(keys.map(key => [key, value]));
  async function check(name, action) {
    const start = sessions.length;
    try {
      const result = await action();
      await settle();
      assert.deepEqual(errors, [], name + ': no reported subscriber/scheduling error');
      cases.push({ name, result });
    } finally {
      for (const session of sessions.splice(start)) session.dispose();
      await settle();
    }
  }

  await check('initialization-and-repeated-flush', async () => {
    for (const factory of [createSharedSession, createSharedState]) {
      const session = own(factory(m0, options));
      const seen = [];
      session.subscribe((value, version) => seen.push([version, value.get('n')]));
      await session.ready;
      assert.equal(session.current, m0);
      assert.equal(session.getSnapshot(), m0);
      assert.equal(session.version, 0);
      for (let i = 0; i < 3; i++) assert.equal(session.flush(), 0);
      assert.deepEqual(seen, []);
    }
    return { factories: 2, flushes: 6, version: 0, notifications: 0 };
  });

  await check('manual-changed-and-unchanged-publication', async () => {
    const session = own(createSharedSession(m0, options));
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.get('n')]));
    assert.equal(session.publish(m1), 1);
    assert.equal(session.current, m1);
    assert.equal(session.version, 1);
    assert.equal(session.publish(m1), 1);
    assert.equal(session.flush(), 1);
    assert.equal(session.publish(m2), 2);
    assert.equal(session.version, 2);
    assert.deepEqual(seen, [[1, 1], [2, 2]]);
    assert.equal(m0.get('n'), 0);
    assert.equal(m1.get('n'), 1);
    return seen;
  });

  await check('pending-update-explicit-flush-and-settlement', async () => {
    const session = own(createSharedState(m0, options));
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.get('n')]));
    session.update(() => m1);
    assert.equal(session.current, m1);
    assert.equal(session.version, 0);
    assert.equal(session.flush(), 1);
    await settle();
    assert.equal(session.version, 1);
    assert.equal(session.flush(), 1);
    assert.deepEqual(seen, [[1, 1]]);
    return seen;
  });

  await check('nested-and-empty-microtask-batches', async () => {
    const session = own(createSharedState(m0, options));
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.get('n')]));
    session.batch(() => session.batch(() => {}));
    await settle();
    assert.equal(session.version, 0);
    assert.deepEqual(seen, []);
    session.batch(() => {
      session.update(() => m1);
      session.batch(() => {
        session.value = m2;
        assert.equal(session.flush(), 0);
      });
      assert.equal(session.flush(), 0);
      assert.equal(session.version, 0);
    });
    assert.equal(session.version, 0);
    await settle();
    assert.equal(session.version, 1);
    session.batch(() => {});
    await settle();
    assert.equal(session.flush(), 1);
    assert.deepEqual(seen, [[1, 2]]);
    return seen;
  });

  await check('distinct-equal-record-reversion-before-flush', async () => {
    const session = own(createSharedState({ lane: m0 }, options));
    const initial = session.current;
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.lane.get('n')]));
    session.update(() => ({ lane: m1 }));
    session.update(() => ({ lane: m0 }));
    assert.notEqual(session.current, initial);
    assert.equal(session.current.lane, initial.lane);
    assert.equal(session.flush(), 0);
    await settle();
    assert.equal(session.flush(), 0);
    assert.deepEqual(seen, []);
    session.update('lane', () => m1);
    assert.equal(session.flush(), 1);
    assert.deepEqual(seen, [[1, 1]]);
    assert.equal(initial.lane.get('n'), 0);
    return { revertedVersion: 0, subsequent: seen };
  });

  await check('empty-and-unusual-key-records', async () => {
    const empty = own(createSharedState(Object.create(null), options));
    assert.equal(empty.flush(), 0);
    assert.equal(empty.publish({}), 0);
    empty.batch(() => {});
    await settle();
    assert.equal(empty.version, 0);
    const keys = ['', '__proto__', 'constructor', 'toString', '0', '雪'];
    const initialInput = Object.assign(Object.create(null), record(keys, m0));
    const session = own(createSharedState(initialInput, options));
    const initial = session.current;
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.__proto__.get('n')]));
    assert.equal(Object.getPrototypeOf(initial), null);
    assert.equal(Object.isFrozen(initial), true);
    assert.equal(session.publish(record([...keys].reverse(), m0)), 0);
    assert.equal(session.current, initial);
    session.update('__proto__', () => m1);
    assert.equal(session.flush(), 1);
    for (const key of keys) {
      assert.equal(Object.hasOwn(session.current, key), true);
      assert.equal(session.current[key], key === '__proto__' ? m1 : m0);
      assert.equal(initial[key], m0);
    }
    assert.deepEqual(seen, [[1, 1]]);
    return { keys: [...keys].sort(), emptyVersion: 0, changed: seen };
  });

  await check('subscriber-update-remains-pending-after-commit', async () => {
    const session = own(createSharedState(m0, options));
    const seen = [];
    session.subscribe((value, version) => {
      seen.push([version, value.get('n')]);
      // The newer immutable collection was prepared before publication.
      if (version === 1) session.update(() => m2);
    });
    assert.equal(session.publish(m1), 1);
    assert.equal(session.current, m2);
    assert.equal(session.version, 1);
    assert.deepEqual(seen, [[1, 1]]);
    assert.equal(session.flush(), 2);
    await settle();
    assert.equal(session.version, 2);
    assert.equal(session.flush(), 2);
    assert.deepEqual(seen, [[1, 1], [2, 2]]);
    return seen;
  });

  await check('immediate-strategy-empty-and-nested-batch', async () => {
    const session = own(createSharedState(m0, { ...options, publish: { strategy: 'immediate' } }));
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.get('n')]));
    session.batch(() => {});
    assert.equal(session.version, 0);
    session.batch(() => {
      session.update(() => m1);
      session.batch(() => assert.equal(session.publish(m2), 0));
      assert.equal(session.version, 0);
    });
    assert.equal(session.version, 1);
    assert.equal(session.publish(m2), 1);
    assert.deepEqual(seen, [[1, 2]]);
    return seen;
  });

  await check('disposed-flush-still-throws', async () => {
    const session = own(createSharedState(m0, options));
    const seen = [];
    session.subscribe((value, version) => seen.push([version, value.get('n')]));
    session.update(() => m1);
    session.dispose();
    assert.equal(session.closed, true);
    assert.throws(() => session.flush(), { name: 'Error', message: 'Shared session is closed' });
    await settle();
    assert.throws(() => session.flush(), { name: 'Error', message: 'Shared session is closed' });
    assert.equal(session.version, 0);
    assert.deepEqual(seen, []);
    return { throws: 2, version: 0, notifications: 0 };
  });
  assert.equal(sessions.length, 0);
  assert.deepEqual(errors, []);
  assert.equal(cases.length, 9);
  return cases;
}

const baseline = await run(baselineRoot);
const candidate = await run(candidateRoot);
assert.deepEqual(candidate, baseline);
const result = { passed: true, engine: typeof Bun === 'undefined' ? 'node' : 'bun',
  baselineRoot: resolve(baselineRoot), candidateRoot: resolve(candidateRoot),
  casesPerArm: 9, baseline, candidate, publicOutcomesEqual: true,
  scope: 'Portable public sessions; no peers/endpoints, library internals, timing or full-suite claim' };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
