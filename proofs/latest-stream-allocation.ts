/** Build an instrumented baseline/candidate pair and check source allocations, never elapsed time. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const baseline = process.env.STREAM_BASELINE ?? '3773c6e519c7c0958da13727ed1082f449f3ee25';
const root = resolve(import.meta.dir, '..');
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-stream-proof-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const before = git('show', `${baseline}:worker.ts`);
const after = readFileSync(join(root, 'worker.ts'), 'utf8');
const digest = (source: string) => createHash('sha256').update(source).digest('hex');

function instrument(source: string) {
  const file = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reader = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Reader') as ts.ClassDeclaration;
  const snapshots = reader.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'snapshots') as ts.MethodDeclaration;
  assert.ok(snapshots?.body);
  const edits: { start: number; end: number; text: string }[] = [];
  let expressions = 0;
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      expressions++;
      edits.push({ start: node.getStart(file), end: node.end, text: `globalThis.__streamProof.allocate(${node.getText(file)})` });
    }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'queue')) {
      edits.push({ start: node.end, end: node.end, text: '\n    globalThis.__streamProof.register(() => queue);' });
    }
    ts.forEachChild(node, visit);
  };
  visit(snapshots.body!);
  assert.ok(expressions >= 2);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, expressions };
}

// Both variants share identical non-worker sources. Reject unrelated production TS changes.
const production = git('diff', '--name-only', baseline, '--', '*.ts').trim().split('\n').filter(path => path && !path.endsWith('.test.ts') && !path.startsWith('proofs/') && path !== 'worker.ts');
assert.deepEqual(production, [], 'Run this focused proof from the same production baseline');
const encoded = readFileSync(join(root, 'persistent-core.wasm')).toString('base64');
const variants: Record<string, unknown> = {};
try {
  for (const [name, source] of [['baseline', before], ['candidate', after]]) {
    const instrumented = instrument(source), outdir = join(temporary, name);
    const build = await Bun.build({
      entrypoints: [join(root, 'shared.ts'), join(root, 'worker.ts')],
      outdir, naming: '[name].mjs', target: 'browser', format: 'esm', splitting: true,
      plugins: [{ name: 'stream-proof', setup(build) {
        build.onLoad({ filter: /[\\/]worker\.ts$/ }, () => ({ contents: instrumented.source, loader: 'ts' }));
        build.onLoad({ filter: /[\\/]wasm-utils\.ts$/ }, () => ({ contents: `export function loadWasm() { const text = atob(${JSON.stringify(encoded)}); return Uint8Array.from(text, c => c.charCodeAt(0)); }`, loader: 'js' }));
      } }],
    });
    assert.equal(build.success, true, build.logs.map(String).join('\n'));
    const result = JSON.parse(execFileSync(process.env.STREAM_NODE ?? 'node', [join(root, 'proofs/latest-stream-check.mjs'), outdir, name], { encoding: 'utf8', timeout: 120000 }));
    variants[name] = { workerSourceSha256: digest(source), arrayExpressionSites: instrumented.expressions, ...result };
  }
  const a = variants.baseline as any, b = variants.candidate as any;
  assert.deepEqual(a.traces, b.traces, 'Actual-session/worker semantic traces differ');
  const result = {
    baseline: git('rev-parse', baseline).trim(), bun: Bun.version, node: a.runtime,
    wasmSha256: createHash('sha256').update(readFileSync(join(root, 'persistent-core.wasm'))).digest('hex'),
    unit: 'executed ArrayLiteralExpression evaluations inside Reader.snapshots',
    claim: 'No heap-byte, GC, retained-memory, or elapsed-time measurement.',
    variants,
  };
  if (process.env.STREAM_PROOF_OUTPUT) writeFileSync(process.env.STREAM_PROOF_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
