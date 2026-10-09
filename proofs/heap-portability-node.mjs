import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, fixture, fixtureIdentity, consume } from './heap-entry-workloads.mjs';
import { semanticChecks } from './heap-portability-semantic.mjs';
export async function fixtureCheck(entryUrl, name) {
  const api = await import(entryUrl), workload = CASES.find(row => row.name === name); assert(workload);
  const { item, expected } = fixture(api, workload);
  assert.deepEqual(consume(item, workload), expected); assert.deepEqual(consume(item, workload), expected);
  return { status: 'completed', workload, expected, identity: fixtureIdentity(api, item) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const request = JSON.parse(process.argv[2]);
  assert.equal(process.arch, 'arm64'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.HEAP_PORTABILITY_SUBJECT, '1'); assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.deepEqual(process.execArgv, []); assert.equal(process.env.NODE_OPTIONS ?? '', ''); assert.equal(process.env.BUN_OPTIONS ?? '', '');
  const runtime = process.versions.bun ? 'bun' : 'node', version = process.versions.bun ?? process.versions.node;
  assert.equal(version, runtime === 'bun' ? '1.4.2' : '22.23.3');
  let result;
  try {
    if (request.phase === 'correctness') result = request.kind === 'worker' ? await semanticChecks(request.entryUrl, request.copy) : await fixtureCheck(request.entryUrl, request.name);
    else {
      const { subject } = await import('./subject.mjs');
      const workload = CASES.find(row => row.name === request.name); assert(workload);
      result = await subject({ ...request, workload });
    }
  } catch (error) { result = { status: 'failed', error: String(error.stack ?? error) }; }
  result.host = { runtime, version, arch: process.arch, execArgv: process.execArgv };
  console.log(JSON.stringify(result, (_, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value))
    ? { binary64: Object.is(value, -0) ? '-0' : String(value) } : value));
  if (result.status !== 'completed') process.exitCode = 1;
}
