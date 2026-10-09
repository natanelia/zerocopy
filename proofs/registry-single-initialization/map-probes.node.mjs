import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { instrumentMapExpressions, loadTypeScript, HOOK } from './instrument.mjs';
import { compareResults, runMapProbes } from './run-map-probes.mjs';

const ts = loadTypeScript([]);

test('AST instrumentation preserves native Map, nested expressions, arguments, comments and string literals', () => {
  const source = `
    // new Map must remain a comment.
    const text = "new Map([['fake', 1]])";
    const before = Map;
    let sideEffects = 0;
    class Example { field = new Map; }
    const outer = new Map([["nested", new Map([["value", ++sideEffects]])]]);
    const member = new Example().field;
    globalThis.actual = { native: before === Map, outer, member, text, sideEffects };
  `;
  const { code, sites } = instrumentMapExpressions(ts, 'example.js', source);
  assert.equal(sites.length, 3);
  const constructed = [];
  const context = { [HOOK]: (site, map) => { constructed.push({ site, map }); return map; } };
  runInNewContext(code, context);
  assert.equal(context.actual.native, true);
  assert.equal(context.actual.sideEffects, 1);
  assert.equal(context.actual.outer.get('nested').get('value'), 1);
  assert.equal(context.actual.member.size, 0);
  assert.equal(context.actual.text, "new Map([['fake', 1]])");
  assert.equal(constructed.length, 3);
  assert.equal(new Set(constructed.map(record => record.map)).size, 3);
  assert(sites.some(site => site.ancestry.includes('field')));
  assert(code.includes('// new Map must remain a comment.'));
  for (const site of sites) assert.equal(source.slice(site.start, site.end), site.originalExpression);
});

test('parser refuses malformed or already instrumented source', () => {
  assert.throws(() => instrumentMapExpressions(ts, 'broken.js', 'const x = new Map('));
  assert.throws(() => instrumentMapExpressions(ts, 'duplicate.js', `globalThis.${HOOK};`));
});

function matrix() {
  const records = [];
  for (const role of ['main', 'old', 'cleanup']) {
    for (const [mode, count, copy] of [['attach', 1, false], ['attach', 1, true], ['attach', 512, false], ['attach', 512, true], ['owned', 512, false]]) {
      const lanes = mode === 'owned' ? ['allocation', 'topology'] : ['allocation', 'topology', 'traversal', 'heap'];
      for (const lane of lanes) {
        let result = { equal: true };
        if (lane === 'allocation') {
          const shared = mode === 'attach' && count > 1;
          const evaluated = mode === 'owned' ? count * 4 : role === 'cleanup' && shared ? count * 3 + 1 : count * 4 + 1;
          const settledAlive = mode === 'owned' ? count * 4 : role !== 'main' && shared ? count * 3 + 1 : count * 4;
          result = { evaluated, settledAlive, discarded: evaluated - settledAlive };
        }
        records.push({ request: { lane, role, mode, count, copy }, passed: true, result });
      }
    }
  }
  return records;
}

test('comparison accepts the exact 54-subject matrix and only the expected discarded-Map delta', () => {
  const compared = compareResults(matrix());
  assert.equal(compared.length, 5);
  assert.deepEqual(compared.map(row => row.discardedMapsRemoved), [0, 0, 512, 512, 0]);
});

for (const [name, mutate] of [
  ['wrong allocation delta', records => { records.find(r => r.request.role === 'cleanup' && r.request.count === 512 && r.request.lane === 'allocation').result.evaluated++; }],
  ['wrong settled count', records => { records.find(r => r.request.role === 'cleanup' && r.request.count === 512 && r.request.lane === 'allocation').result.settledAlive--; }],
  ['changed layout or lifetime', records => { records.find(r => r.request.role === 'cleanup' && r.request.lane === 'topology').result = { changed: true }; }],
  ['failed child', records => { records.at(-1).passed = false; }],
  ['partial matrix', records => { records.pop(); }],
  ['duplicate child', records => { records.push(records[0]); }],
]) test(`comparison rejects ${name}`, () => {
  const records = matrix(); mutate(records);
  assert.throws(() => compareResults(records));
});

test('runner refuses to overwrite an existing evidence directory', () => {
  assert.throws(() => runMapProbes('.', '.', '.', '.'), /refusing to overwrite/);
});
