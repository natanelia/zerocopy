/** Fresh builds, extracted archives, and actual Node/Bun compilation receipts. No latency work. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { compilerContext, prepareComparison, verifyProofSources, bundleManifest, sha256, CORE_HASHES } from './vector-reservation-source.mjs';
export function buildComparison(baseline, candidate, output) {
  const paths = { baseline: resolve(baseline), candidate: resolve(candidate) };
  assert(!paths.baseline.startsWith(paths.candidate + '/'), 'Baseline must be outside candidate test discovery');
  const compiler = Object.fromEntries(Object.entries(paths).map(([role, root]) => [role, compilerContext(root)]));
  assert.deepEqual(compiler.baseline, compiler.candidate);
  const commands = [], packages = {}, packageCommands = [];
  mkdirSync(dirname(output), { recursive: true });
  const save = () => writeFileSync(`${output}.partial`, JSON.stringify({ compiler, commands, packages, packageCommands }, null, 2) + '\n');
  function run(executable, args, cwd, records, role) {
    const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    records.push({ role, cwd, executable, args, status: result.status, stdout: result.stdout, stderr: result.stderr }); save();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  }
  for (const [role, cwd] of Object.entries(paths)) for (const target of ['build:wasm', 'build:browser', 'build:types']) {
    run(process.env.BUN_BINARY ?? 'bun', ['run', target], cwd, commands, role);
  }
  const compared = prepareComparison(join(paths.baseline, 'dist/shared.js'), join(paths.candidate, 'dist/shared.js'));
  const proofs = verifyProofSources(paths.candidate, compared.candidateCommit);
  for (const [role, cwd] of Object.entries(paths)) {
    const destination = resolve(dirname(output), 'packages', role);
    rmSync(destination, { recursive: true, force: true }); mkdirSync(destination, { recursive: true });
    const [archive] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], cwd, packageCommands, role));
    assert.equal(archive.filename, 'zerocopy-0.2.1.tgz');
    const tarball = join(destination, archive.filename);
    run('tar', ['-xzf', tarball, '-C', destination], cwd, packageCommands, role);
    const root = join(destination, 'package'), entry = join(root, 'dist/shared.js');
    assert.equal(sha256(readFileSync(join(root, 'persistent-core.wasm'))), CORE_HASHES[role]);
    assert.equal(sha256(readFileSync(join(root, 'package.json'))), sha256(readFileSync(join(cwd, 'package.json'))));
    assert.deepEqual(bundleManifest(entry), compared.manifests[role], 'Packed portable files differ from measured checkout files');
    const actualImports = {};
    for (const [runtime, executable] of [['node', process.execPath], ['bun', process.env.BUN_BINARY ?? 'bun']]) {
      const result = JSON.parse(run(executable, [fileURLToPath(new URL('./vector-reservation-case.mjs', import.meta.url)), JSON.stringify({ mode: 'checks', module: entry, reuse: role === 'candidate', expectedWasm: CORE_HASHES[role] })], cwd, packageCommands, role));
      assert.deepEqual(result.actualCompiledWasm, [CORE_HASHES[role]]);
      assert.equal(result.rows.length, 16);
      actualImports[runtime] = result;
    }
    packages[role] = { root, tarball, tarballSha256: sha256(readFileSync(tarball)), files: archive.files, manifests: bundleManifest(entry), actualImports }; save();
  }
  const final = prepareComparison(join(paths.baseline, 'dist/shared.js'), join(paths.candidate, 'dist/shared.js'));
  assert.deepEqual(final, compared);
  const result = { schema: 'vector-reservation-build/v1', date: new Date().toISOString(), compiler, commands, packageCommands, packages, proofs, ...compared };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output] = process.argv.slice(2); assert(baseline && candidate && output);
  buildComparison(baseline, candidate, resolve(output));
}
