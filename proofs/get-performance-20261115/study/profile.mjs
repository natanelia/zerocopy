// Diagnostic profiles only. Never mix these instrumented observations into A/B.
import { Session } from 'node:inspector';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CASES, makeFixture, expectedPlain } from './fixtures.mjs';
import { exact, buildOwner, verifyPlainCapture } from './study-core.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((value, i, all) => value.startsWith('--') ? [value.slice(2), all[i + 1]] : []).filter(item => item.length));
for (const key of ['repo', 'harness', 'out']) if (!args[key]) throw new Error(`Missing --${key}`);
const directory = resolve(args.out);
if (existsSync(directory)) throw new Error('Profile output exists; preserve rejected experiments');
const definition = CASES.find(item => item.id === (args.case ?? 'catalog-full-get'));
if (!definition) throw new Error('Unknown case');
const iterations = Number(args.iterations ?? 16);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 128) throw new Error('Invalid profile iteration count');
const importAt = (root, path) => import(pathToFileURL(resolve(root, path)).href);
const api = await importAt(args.repo, 'dist/shared.js');
const [catalog, reads, readReference, catalogReference] = await Promise.all(['catalog-core.mjs', 'catalog-read-workloads.mjs', 'catalog-read-reference.mjs', 'catalog-reference.mjs'].map(path => importAt(args.harness, `website/assets/${path}`)));
const fixture = makeFixture(definition, catalog);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = directory => ({ directory: resolve(directory), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
  dirtyTrackedFiles: execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: directory, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  libraryHashes: Object.fromEntries(readdirSync(resolve(directory, 'dist')).filter(file => file.endsWith('.js')).map(file => [file, sha256(readFileSync(resolve(directory, 'dist', file)))])) });
const identities = { runtime: identity(args.repo), harness: identity(args.harness),
  fixtureSHA256: sha256(JSON.stringify({ definition, entries: fixture.entries, requests: fixture.requests })),
  profilerSHA256: sha256(readFileSync(new URL(import.meta.url))) };
const owner = buildOwner(api, definition, fixture);
const payload = api.getWorkerData({ data: owner }, { copy: false }), readers = [];
for (let i = 0; i < iterations; i++) readers.push((await api.initWorker(payload)).data);
const measured = collection => definition.workload === 'full-object-get' ? reads.runReadQuery(collection, fixture.requests, reads.readCase('full-shared-get'))
  : definition.workload.startsWith('legacy-') ? catalog.calculate(collection, fixture.requests, definition.workload === 'legacy-lookup' ? 'lookup' : 'validate')
  : fixture.requests.map(key => collection.get(key));
const captures = [], stageCounters = {}, undo = [], stack = [];
if (args.instrument === 'true') {
  const prototype = Object.getPrototypeOf(readers[0].arena);
  for (const name of ['value', 'readObject', 'readPrimitive', 'find', 'findUncached', 'key', 'leafValue', 'decode', 'decodeAt', 'refresh']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') continue;
    const original = descriptor.value;
    stageCounters[name] = { calls: 0, inclusiveMs: 0, exclusiveMs: 0 };
    Object.defineProperty(prototype, name, { ...descriptor, value: function (...parameters) {
      const frame = { start: performance.now(), childMs: 0 }; stack.push(frame);
      try { return original.apply(this, parameters); }
      finally {
        const elapsed = performance.now() - frame.start; stack.pop();
        const counter = stageCounters[name]; counter.calls++; counter.inclusiveMs += elapsed; counter.exclusiveMs += Math.max(0, elapsed - frame.childMs);
        if (stack.length) stack.at(-1).childMs += elapsed;
      }
    } });
    undo.push(() => Object.defineProperty(prototype, name, descriptor));
  }
}
mkdirSync(directory, { recursive: true });
const session = new Session(); session.connect();
const post = (method, parameters = {}) => new Promise((resolvePost, reject) => session.post(method, parameters, (error, value) => error ? reject(error) : resolvePost(value)));
let failure;
await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start');
try { for (const reader of readers) captures.push(measured(reader)); }
catch (error) { failure = { name: error?.name, message: error?.message, stack: error?.stack }; }
finally {
  const { profile } = await post('Profiler.stop');
  writeFileSync(resolve(directory, 'cold-get.cpuprofile'), JSON.stringify(profile));
  session.disconnect(); for (const restore of undo) restore();
}
if (!failure) {
  const expected = definition.workload === 'full-object-get' ? readReference.readReference(definition.size, 0, fixture.requests, reads.readCase('full-shared-get'))
    : definition.workload.startsWith('legacy-') ? (() => { const all = catalogReference.reference(definition.size, 0, fixture.requests); return definition.workload === 'legacy-lookup' ? { lookup: all.lookup } : { validation: all.validation }; })()
    : expectedPlain(fixture, definition);
  try { for (const result of captures) definition.workload === 'ordinary-get' ? verifyPlainCapture(api, definition, result, expected) : exact(result, expected); }
  catch (error) { failure = { name: error?.name, message: error?.message, stack: error?.stack }; }
}
writeFileSync(resolve(directory, 'profile.json'), JSON.stringify({ definition, iterations, identities, instrumented: args.instrument === 'true', stageCounters,
  runtime: { version: process.version, versions: process.versions }, status: failure ? 'failed' : 'passed', failure,
  warning: 'Profiling and optional wrappers change the hot path. Inclusive/exclusive wrapper times include instrumentation overhead, and must not be used as uninstrumented costs or as speedup evidence. TextDecoder is not overridden because that changes shared-input fallback selection. The sampling profile includes ordinary get work on pre-attached cold readers only.' }, null, 2));
if (failure) process.exitCode = 1;
