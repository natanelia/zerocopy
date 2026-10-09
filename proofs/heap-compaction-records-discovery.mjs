import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { glob } from 'tinyglobby';
import picomatch from 'picomatch';
import { configDefaults } from 'vitest/config';
const inside = (parent, child) => { const r = relative(parent, child); return !r || r !== '..' && !r.startsWith('../') && !isAbsolute(r); };
export function assertDisjointRoots(a, b) {
  const left = realpathSync(a), right = realpathSync(b);
  assert(!inside(left, right) && !inside(right, left), 'Candidate/baseline roots must be physically disjoint, with no ancestor overlap');
  return [left, right];
}
function literal(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => { assert(ts.isPropertyAssignment(p)); return [p.name.text, literal(p.initializer)]; }));
  throw new Error('Discovery requires the unchanged literal Vitest config; no config is executed or emitted');
}
export function discoveryPolicy(root) {
  const text = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  const ast = ts.createSourceFile('vitest.config.ts', text, ts.ScriptTarget.Latest, true);
  const exported = ast.statements.find(ts.isExportAssignment); assert(ts.isCallExpression(exported.expression));
  const config = literal(exported.expression.arguments[0]);
  return { include: config.test.include ?? configDefaults.include, exclude: config.test.exclude ?? configDefaults.exclude,
    cacheDir: config.cacheDir, timeout: config.test.testTimeout, configSha256: createHash('sha256').update(text).digest('hex') };
}
export async function discover(root, policy) {
  return (await glob(policy.include, { dot: true, cwd: root, ignore: policy.exclude, expandDirectories: false })).sort();
}
export async function inspectArms(baseline, candidate, { initializeCaches = false } = {}) {
  const roots = assertDisjointRoots(baseline, candidate), rows = [];
  for (const [index, arm] of ['baseline', 'candidate'].entries()) {
    const root = roots[index], policy = discoveryPolicy(root), discovered = await discover(root, policy);
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const include = picomatch(policy.include, { dot: true }), exclude = picomatch(policy.exclude, { dot: true });
    const expected = tracked.filter(p => include(p) && !exclude(p)).sort();
    assert.deepEqual(discovered, expected, `${arm}: discovery differs from its own tracked standard suite`);
    for (const file of discovered) assert(inside(root, realpathSync(join(root, file))) && !inside(roots[1 - index], realpathSync(join(root, file))));
    const modules = join(root, 'node_modules'); assert(!lstatSync(modules).isSymbolicLink());
    const caches = [resolve(root, policy.cacheDir), join(modules, '.cache')].map(path => {
      if (initializeCaches) mkdirSync(path, { recursive: true });
      const exists = (() => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
      assert(!exists?.isSymbolicLink());
      const physical = exists ? realpathSync(path) : join(realpathSync(modules), relative(modules, path));
      const entries = exists ? readdirSync(path) : [];
      assert.equal(entries.length, 0, `${arm}: initial cache is not empty`);
      return { path, physical, initiallyEmpty: true };
    });
    rows.push({ arm, root, modules: realpathSync(modules), policy, discovered, expected, caches });
  }
  assertDisjointRoots(rows[0].modules, rows[1].modules);
  assert.deepEqual(rows[0].policy, rows[1].policy); assert.deepEqual(rows[0].expected, rows[1].expected);
  for (const a of rows[0].caches) for (const b of rows[1].caches) assert.notEqual(a.physical, b.physical);
  return rows;
}
