import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export const HOOK = '__registryMapExpressionProbe_20261009';

export function loadTypeScript(roots, explicitPath = process.env.REGISTRY_TYPESCRIPT_PATH) {
  const candidates = explicitPath ? [explicitPath] : roots.map(root => createRequire(resolve(root, 'package.json')));
  candidates.push(createRequire(resolve(process.cwd(), 'package.json')), createRequire(import.meta.url));
  const errors = [];
  for (const candidate of candidates) {
    try {
      const ts = typeof candidate === 'string' ? createRequire(import.meta.url)(resolve(candidate)) : candidate('typescript');
      assert.equal(ts.version, '5.9.3', 'The expression parser must be existing TypeScript 5.9.3');
      return ts;
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`Existing TypeScript 5.9.3 was not resolved; set REGISTRY_TYPESCRIPT_PATH to its typescript.js. ${errors.join('; ')}`);
}

// Insert wrappers around AST NewExpressions. The actual native new Map
// expression and its arguments remain byte-for-byte intact. No global Map
// replacement, constructor proxy, source rewrite, or code printer is involved.
export function instrumentMapExpressions(ts, filename, source) {
  assert(!source.includes(HOOK), `Already instrumented: ${filename}`);
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, `Cannot parse ${filename}`);
  const sites = [], insertions = [];
  function visit(node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Map') {
      const start = node.getStart(ast), end = node.end;
      const { line, character } = ast.getLineAndCharacterOfPosition(start);
      const ancestry = [];
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (ts.isConstructorDeclaration(parent)) ancestry.push('constructor');
        else if (parent.name && (ts.isPropertyDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isGetAccessorDeclaration(parent))) ancestry.push(parent.name.getText(ast));
      }
      const id = `${filename}:${line + 1}:${character + 1}`;
      const prefix = `(globalThis.${HOOK}(${JSON.stringify(id)}, `, suffix = '))';
      sites.push({ id, start, end, line: line + 1, column: character + 1, ancestry, originalExpression: source.slice(start, end), prefix, suffix });
      insertions.push({ offset: start, text: prefix }, { offset: end, text: suffix });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let code = source;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
  const parsed = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, `Instrumentation produced invalid JavaScript: ${filename}`);
  return { code, sites };
}
