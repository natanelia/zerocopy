// Standalone synchronous child: all imports/setup precede prototype mutation.
// Assertions, result arrays and output run only after descriptors are restored.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [sourcePath, expectedHash, arm] = process.argv.slice(2);
assert.ok(arm === 'baseline' || arm === 'candidate');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(hash(sourcePath), expectedHash);
const { freezeJSON } = await import(pathToFileURL(sourcePath).href);
assert.equal(typeof freezeJSON, 'function');
const define = Object.defineProperty;
const descriptor = Object.getOwnPropertyDescriptor;
const isFrozen = Object.isFrozen;
const originalZero = descriptor(Array.prototype, '0');
const originalFreeze = descriptor(Object, 'freeze');
const originalPop = descriptor(Array.prototype, 'pop');
assert.equal(originalZero, undefined, 'fresh process must have no inherited index 0');

function withZero(accessor, action) {
  define(Array.prototype, '0', { configurable: true, ...accessor });
  try { return action(); }
  finally {
    if (originalZero) define(Array.prototype, '0', originalZero);
    else delete Array.prototype[0];
  }
}
function storeZero(receiver, value) {
  define(receiver, '0', { value, writable: true, enumerable: true, configurable: true });
}
function withFreeze(replacement, action) {
  define(Object, 'freeze', { ...originalFreeze, value: replacement });
  try { return action(); }
  finally { define(Object, 'freeze', originalFreeze); }
}

function flatRoots() {
  const roots = [JSON.parse('{}'), JSON.parse('[]'),
    JSON.parse('{"n":1,"nil":null,"text":"界🙂","flag":false}'),
    JSON.parse('[0,-0,null,"界🙂",true]')];
  for (const root of roots) {
    const keys = Reflect.ownKeys(root), before = Object.getOwnPropertyDescriptors(root);
    assert.equal(freezeJSON(root), root);
    assert.equal(isFrozen(root), true);
    assert.deepEqual(Reflect.ownKeys(root), keys);
    const after = Object.getOwnPropertyDescriptors(root);
    for (const key of keys) {
      assert.ok(Object.is(after[key].value, before[key].value));
      assert.equal(after[key].enumerable, before[key].enumerable);
      assert.equal(after[key].writable, false);
      assert.equal(after[key].configurable, false);
    }
  }
}

function snapshotBeforePush() {
  const root = JSON.parse('{"first":{"n":1},"later":{"n":2}}');
  const first = root.first, originalLater = root.later, replacement = { n: 3 };
  let calls = 0, firstLength, returned;
  withZero({ set(child) {
    if (child === first) {
      calls++;
      firstLength = this.length;
      root.later = replacement;
    }
    storeZero(this, child);
  } }, () => { returned = freezeJSON(root); });
  assert.equal(returned, root);
  assert.equal(calls, 1);
  assert.equal(firstLength, 0);
  assert.equal(root.later, replacement);
  assert.equal(isFrozen(root), true);
  assert.equal(isFrozen(first), true);
  assert.equal(isFrozen(originalLater), true, 'the snapshotted later child is visited');
  assert.equal(isFrozen(replacement), false, 'the replacement is not in the snapshot');
}

function firstPushThrows() {
  for (const arrayRoot of [false, true]) {
    const child = { n: 1 }, sibling = { n: 2 };
    let getterTrace = '';
    const root = arrayRoot ? [child] : {
      get first() { getterTrace += 'first,'; return child; },
      get later() { getterTrace += 'later'; return sibling; },
    };
    const sentinel = new Error('first push');
    let calls = 0, thrown;
    withZero({ set(value) {
      if (value === child) { calls++; throw sentinel; }
      storeZero(this, value);
    } }, () => {
      try { freezeJSON(root); } catch (error) { thrown = error; }
    });
    assert.equal(thrown, sentinel);
    assert.equal(calls, 1);
    assert.equal(getterTrace, arrayRoot ? '' : 'first,later');
    assert.equal(isFrozen(root), false);
    assert.equal(isFrozen(child), false);
    assert.equal(isFrozen(sibling), false);
  }
}

function swallowedWriteReadsInheritedChild() {
  for (const throws of [false, true]) {
    const child = { n: 1 }, root = [child], inheritedChild = { inherited: true };
    const sentinel = new Error('inherited get');
    let worklist, sets = 0, gets = 0, rootFrozenAtGet, returned, thrown;
    withZero({
      set(value) {
        if (value === child) { worklist = this; sets++; }
        else storeZero(this, value);
      },
      get() {
        if (this === worklist) {
          gets++;
          rootFrozenAtGet = isFrozen(root);
          if (throws) throw sentinel;
          return inheritedChild;
        }
        return undefined;
      },
    }, () => {
      try { returned = freezeJSON(root); } catch (error) { thrown = error; }
    });
    assert.equal(returned, throws ? undefined : root);
    assert.equal(thrown, throws ? sentinel : undefined);
    assert.equal(sets, 1);
    assert.equal(gets, 1);
    assert.equal(rootFrozenAtGet, true);
    assert.equal(worklist.length, throws ? 1 : 0);
    assert.equal(isFrozen(root), true);
    assert.equal(isFrozen(child), false, 'swallowed child was never stored');
    assert.equal(isFrozen(inheritedChild), !throws);
  }
}

function reentrantTraversal() {
  const outer = JSON.parse('{"first":{"n":1},"second":{"n":2}}');
  const inner = JSON.parse('{"child":{"n":3}}');
  let outerStack, innerStack, trace = '', outerFrozenAtEntry, innerComplete;
  let laterPopCalls = 0, laterPopsSawFrozenRoot = true;
  withZero({ set(value) {
    if (value === outer.first) {
      outerStack = this;
      trace += 'outer-enter,';
      outerFrozenAtEntry = isFrozen(outer);
      freezeJSON(inner);
      innerComplete = isFrozen(inner) && isFrozen(inner.child);
      trace += 'outer-resume';
      define(this, 'pop', { configurable: true, value: function () {
        laterPopCalls++;
        laterPopsSawFrozenRoot &&= this === outerStack && isFrozen(outer);
        return originalPop.value.call(this);
      } });
    } else if (value === inner.child) {
      innerStack = this;
      trace += 'inner-push,';
    }
    storeZero(this, value);
  } }, () => { freezeJSON(outer); });
  assert.equal(trace, 'outer-enter,inner-push,outer-resume');
  assert.equal(outerFrozenAtEntry, false);
  assert.equal(innerComplete, true);
  assert.equal(laterPopCalls, 2, 'post-exposure pop override remains dynamic');
  assert.equal(laterPopsSawFrozenRoot, true);
  assert.notEqual(outerStack, innerStack);
  assert.equal(outerStack.length, 0);
  assert.equal(innerStack.length, 0);
  assert.equal(isFrozen(outer), true);
  assert.equal(isFrozen(outer.first), true);
  assert.equal(isFrozen(outer.second), true);
}

function freezeOrder() {
  const root = JSON.parse('{"left":[{"n":1}],"right":{"leaf":{"n":2}}}');
  const left = root.left, leftLeaf = left[0], right = root.right, rightLeaf = right.leaf;
  let trace = '';
  withFreeze(value => {
    const label = value === root ? 'root' : value === left ? 'left'
      : value === leftLeaf ? 'leftLeaf' : value === right ? 'right'
      : value === rightLeaf ? 'rightLeaf' : 'unexpected';
    trace += label + ',';
    return originalFreeze.value(value);
  }, () => { freezeJSON(root); });
  assert.equal(trace, 'root,right,rightLeaf,left,leftLeaf,');
  for (const value of [root, left, leftLeaf, right, rightLeaf]) assert.equal(isFrozen(value), true);
}

function valuesGetterThrowsBeforePush() {
  const child = { n: 1 }, sentinel = new Error('values getter');
  let getterTrace = '';
  const root = { get first() { getterTrace += 'first,'; return child; } };
  define(root, 'later', { enumerable: true, get() { getterTrace += 'later'; throw sentinel; } });
  let pushes = 0, thrown;
  withZero({ set(value) { pushes++; storeZero(this, value); } }, () => {
    try { freezeJSON(root); } catch (error) { thrown = error; }
  });
  assert.equal(thrown, sentinel);
  assert.equal(getterTrace, 'first,later');
  assert.equal(pushes, 0, 'Object.values completes its snapshot before any push');
  assert.equal(isFrozen(root), false);
  assert.equal(isFrozen(child), false);
}

function parentFreezeThrowsBeforeChildVisit() {
  const child = { n: 1 }, root = { child }, sentinel = new Error('parent freeze');
  let calls = 0, thrown;
  withFreeze(value => {
    calls++;
    if (value === root) throw sentinel;
    return originalFreeze.value(value);
  }, () => {
    try { freezeJSON(root); } catch (error) { thrown = error; }
  });
  assert.equal(thrown, sentinel);
  assert.equal(calls, 1);
  assert.equal(isFrozen(root), false);
  assert.equal(isFrozen(child), false);
}

const cases = [
  ['flat-root-identity-values-and-descriptors', flatRoots],
  ['object-values-snapshot-before-push', snapshotBeforePush],
  ['first-push-throws-before-parent-freeze', firstPushThrows],
  ['swallowed-write-uses-inherited-getter', swallowedWriteReadsInheritedChild],
  ['reentrant-traversal-keeps-separate-stacks', reentrantTraversal],
  ['parent-first-lifo-freeze-order', freezeOrder],
  ['values-getter-throws-before-any-push', valuesGetterThrowsBeforePush],
  ['parent-freeze-throws-before-child-visit', parentFreezeThrowsBeforeChildVisit],
];
const passed = [];
for (const [name, run] of cases) {
  run();
  assert.deepEqual(descriptor(Array.prototype, '0'), originalZero);
  assert.deepEqual(descriptor(Object, 'freeze'), originalFreeze);
  passed.push(name);
}

// Expected difference, deliberately excluded from the equivalence case list.
const popRoot = JSON.parse('{"n":1}'), popSentinel = new Error('initial pop');
let popError;
define(Array.prototype, 'pop', { ...originalPop, value: function () {
  if (this.length === 1 && this[0] === popRoot) throw popSentinel;
  return originalPop.value.call(this);
} });
try {
  try { freezeJSON(popRoot); } catch (error) { popError = error; }
} finally { define(Array.prototype, 'pop', originalPop); }
assert.equal(popError, arm === 'baseline' ? popSentinel : undefined);
assert.equal(isFrozen(popRoot), arm === 'candidate');
assert.deepEqual(descriptor(Array.prototype, 'pop'), originalPop);
assert.equal(hash(sourcePath), expectedHash);
console.log(JSON.stringify({ status: 'passed', sourceSha256: expectedHash, cases: passed,
  expectedDifference: { name: 'initial-pop-replacement', arm,
    threwSentinel: popError === popSentinel, rootFrozen: isFrozen(popRoot) },
  performanceInference: false }));
