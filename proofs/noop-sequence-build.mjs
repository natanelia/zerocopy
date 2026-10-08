/** CI build receipt: capture commands and toolchain, then verify the exact outputs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilerContext, prepareComparison, verifyProofSources } from './noop-sequence-source.mjs';
export function buildComparison(baseline, candidate, output) {
  const paths = { baseline: resolve(baseline), candidate: resolve(candidate) };
  const compiler = Object.fromEntries(Object.entries(paths).map(([role, root]) => [role, compilerContext(root)]));
  assert.deepEqual(compiler.baseline, compiler.candidate);
  const commands = [];
  for (const [role, cwd] of Object.entries(paths)) for (const target of ['build:wasm', 'build:browser']) {
    const executable = process.env.BUN_BINARY ?? 'bun', args = ['run', target];
    const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 120000 });
    commands.push({ role, cwd, executable, args, status: result.status, stdout: result.stdout, stderr: result.stderr });
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(`${output}.partial`, JSON.stringify({ compiler, commands }, null, 2));
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  }
  const compared = prepareComparison(resolve(paths.baseline, 'dist/shared.js'), resolve(paths.candidate, 'dist/shared.js'));
  const proofs = verifyProofSources(paths.candidate, compared.candidateCommit);
  const result = { schema: 'noop-sequence-build/v1', date: new Date().toISOString(), compiler, commands, proofs, ...compared };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output] = process.argv.slice(2); assert(baseline && candidate && output);
  buildComparison(baseline, candidate, resolve(output));
}
