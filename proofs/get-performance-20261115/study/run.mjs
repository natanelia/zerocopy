import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './fixtures.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((value, i, all) => value.startsWith('--') ? [value.slice(2), all[i + 1]] : []).filter(item => item.length));
for (const required of ['baseline', 'candidate', 'harness', 'baseline-commit', 'candidate-commit', 'harness-commit', 'out']) if (!args[required]) throw new Error(`Missing --${required}`);
const root = dirname(fileURLToPath(import.meta.url)), output = resolve(args.out);
if (existsSync(output)) throw new Error('Output path already exists; never overwrite a recorded study');
const pairs = Number(args.pairs ?? 7), warmups = Number(args.warmups ?? 1);
if (!Number.isInteger(pairs) || pairs < 2 || !Number.isInteger(warmups) || warmups < 0) throw new Error('Invalid fixed pair/warmup count');
const cases = args.cases?.split(',');
if (cases?.some(id => !CASES.some(item => item.id === id))) throw new Error('Unknown requested case');
const runtimes = (args.runtimes ?? `node=${process.execPath}`).split(',').map(specification => {
  const equals = specification.indexOf('=');
  if (equals < 1) throw new Error('Runtimes must be node=/path/node,bun=/path/bun');
  const name = specification.slice(0, equals), executable = specification.slice(equals + 1);
  if (!['node', 'bun'].includes(name)) throw new Error('Only explicit node/bun runtimes are accepted');
  return { name, executable };
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function identity(directory, expected) {
  const cwd = resolve(directory);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (commit !== expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error(`Expected exact commit ${expected}, got ${commit} at ${cwd}`);
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  const sourceHashes = Object.fromEntries(tracked.filter(path => (/^[^/]+\.(ts|json|toml)$/.test(path) || path.startsWith('rust/') || path.startsWith('scripts/') || path.startsWith('website/assets/') && path.endsWith('.mjs')) && !path.endsWith('.gz')).map(path => [path, hash(readFileSync(resolve(cwd, path)))]));
  const libraryHashes = Object.fromEntries(readdirSync(resolve(cwd, 'dist')).filter(path => path.endsWith('.js')).sort().map(path => [path, hash(readFileSync(resolve(cwd, 'dist', path)))]));
  const wasmHashes = Object.fromEntries(readdirSync(cwd).filter(path => path.endsWith('.wasm')).sort().map(path => [path, hash(readFileSync(resolve(cwd, path)))]));
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json')));
  return { directory: cwd, commit, sourceHashes, libraryHashes, wasmHashes, packageVersion: pkg.version, dependencies: pkg.devDependencies };
}
const identities = { baseline: identity(args.baseline, args['baseline-commit']), candidate: identity(args.candidate, args['candidate-commit']), harness: identity(args.harness, args['harness-commit']) };
const studyHashes = Object.fromEntries(readdirSync(root).filter(path => path.endsWith('.mjs') || path.endsWith('.md')).sort().map(path => [path, hash(readFileSync(resolve(root, path)))]));
const schedule = [];
for (const runtime of runtimes) for (let pair = 0; pair < pairs; pair++) for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) schedule.push({ runtime, pair, variant });
mkdirSync(output, { recursive: true });
const manifest = { schema: 'zerocopy-standard-get-study/v1', createdAt: new Date().toISOString(), pairs, warmups, cases: cases ?? CASES.map(item => item.id),
  identities, studyHashes, schedule, cpuAffinity: args.cpu ?? null, methodology: 'Fixed alternating fresh processes. Within each process, fixed case order rotates by pair. One separate fresh-reader warmup per case by default; no decode verification between measured cold and repeat. Local attachment/publication has no worker transport. An untimed byte-canary copy touches the payload before the cold query without collection reads or decoding; CPU caches may be warm. Full website worker workload remains separate. Never pool instrumented profiles with these results.' };
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const completions = [];
for (const item of schedule) {
  const filename = `${item.runtime.name}-pair-${String(item.pair).padStart(2, '0')}-${item.variant}`;
  const config = { repo: identities[item.variant].directory, harness: identities.harness.directory, pair: item.pair, variant: item.variant, warmups, cases };
  const childArgs = [...(item.runtime.name === 'node' ? ['--expose-gc'] : []), resolve(root, 'one-process.mjs'), JSON.stringify(config)];
  const stdout = createWriteStream(resolve(output, `${filename}.jsonl`)), stderr = createWriteStream(resolve(output, `${filename}.stderr`));
  const start = performance.now();
  const status = await new Promise(resolveStatus => {
    const command = args.cpu ? 'taskset' : item.runtime.executable;
    const commandArgs = args.cpu ? ['-c', args.cpu, item.runtime.executable, ...childArgs] : childArgs;
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    child.on('error', error => resolveStatus({ error: error.message }));
    child.on('close', (code, signal) => resolveStatus({ code, signal }));
  });
  await Promise.all([new Promise(resolveDone => stdout.end(resolveDone)), new Promise(resolveDone => stderr.end(resolveDone))]);
  const completion = { ...item, ...status, file: `${filename}.jsonl`, stderr: `${filename}.stderr`, elapsedMs: performance.now() - start,
    sha256: hash(readFileSync(resolve(output, `${filename}.jsonl`))) };
  completions.push(completion);
  writeFileSync(resolve(output, 'completions.json'), JSON.stringify(completions, null, 2));
  process.stdout.write(`${item.runtime.name} pair ${item.pair + 1}/${pairs} ${item.variant}: ${status.code === 0 ? 'passed' : 'FAILED'}\n`);
}
writeFileSync(resolve(output, 'study-complete.json'), JSON.stringify({ endedAt: new Date().toISOString(), planned: schedule.length, completed: completions.length,
  failed: completions.filter(item => item.code !== 0).length }, null, 2));
process.stdout.write(`Raw records saved to ${relative(process.cwd(), output)}\n`);
if (completions.some(item => item.code !== 0)) process.exitCode = 1;
