import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Map as ImmutableMap } from '../_site/lab/vendor/immutable.mjs';
import { produce } from '../_site/lab/vendor/immer.mjs';
import { immutableVersion, immerVersion } from '../_site/lab/vendor/version.mjs';
import { buildReplica, encodeReplica, attachReplica } from '../_site/lab/assets/bench-maps.mjs';

test('lab uses the pinned upstream Map implementations and keeps earlier roots', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
  assert.equal(immutableVersion, pkg.devDependencies.immutable);
  assert.equal(immerVersion, pkg.devDependencies.immer);
  const immutable = buildReplica('immutable', ['a', 'b']);
  assert.ok(ImmutableMap.isMap(immutable));
  assert.equal(immutable.set('a', 42).get('a'), 42);
  assert.equal(immutable.get('a'), 0);
  const immer = buildReplica('immer', ['a', 'b']);
  assert.ok(immer instanceof Map); assert.ok(Object.isFrozen(immer));
  assert.throws(() => immer.set('a', 42));
  const next = produce(immer, draft => { draft.set('a', 42); });
  assert.equal(next.get('a'), 42); assert.equal(immer.get('a'), 0);
});

test('full structured-cloned replicas retain every lookup and immutable semantics', () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `lane-${i}`);
  for (const path of ['immutable', 'immer']) {
    const owner = buildReplica(path, keys);
    const payload = encodeReplica(path, owner);
    if (path === 'immutable') assert.equal(payload.length, keys.length);
    else assert.equal(payload, owner);
    const replica = attachReplica(path, structuredClone(payload));
    assert.notEqual(replica, owner); assert.equal(replica.size, keys.length);
    keys.forEach((key, index) => assert.equal(replica.get(key), index));
    if (path === 'immutable') assert.ok(ImmutableMap.isMap(replica));
    else { assert.ok(Object.isFrozen(replica)); assert.throws(() => replica.set(keys[0], -1)); }
    assert.equal(owner.get(keys[0]), 0);
  }
});

test('replica helpers reject unknown paths and invalid Immer payloads', () => {
  assert.throws(() => buildReplica('native', []));
  assert.throws(() => encodeReplica('native', new Map()));
  assert.throws(() => attachReplica('native', new Map()));
  assert.throws(() => attachReplica('immer', []));
});
