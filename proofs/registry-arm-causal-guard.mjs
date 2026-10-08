import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROOF_PATHS as ORIGINAL_PATHS, pinnedGuard } from './registry-attachment-guard.mjs';
import { manifest, sha256 } from './worker-arena-source-guard.mjs';
import { protocol } from './registry-arm-causal-protocol.mjs';
export { sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment } from './registry-attachment-guard.mjs';
export const NEW_PATHS = [
  '.github/workflows/registry-arm-causal.yml',
  'proofs/registry-arm-causal.manifest.json', 'proofs/registry-arm-causal.md',
  'proofs/registry-arm-causal-protocol.mjs', 'proofs/registry-arm-causal-guard.mjs',
  'proofs/registry-arm-causal-subject.mjs', 'proofs/registry-arm-causal-graph.mjs',
  'proofs/registry-arm-causal-census.mjs', 'proofs/run-registry-arm-causal.mjs',
  'proofs/registry-arm-causal-tests.node.mjs',
];
export const PROOF_PATHS = [...ORIGINAL_PATHS, ...NEW_PATHS];
export function assertPublicationDelta(delta) {
  const rows = delta.trim().split('\n').map(line => line.split('\t'));
  assert(rows.every(([status, path, extra]) => status === 'A' && NEW_PATHS.includes(path) && extra === undefined), 'Only new causal proof files may change');
  assert.deepEqual(rows.map(row => row[1]).sort(), [...NEW_PATHS].sort(), 'Publication must contain the entire reviewed proof file set');
}
export function publicationReceipt(proofRoot, expectedHead) {
  assert(/^[a-f0-9]{40}$/.test(expectedHead ?? ''), 'Exact workflow head required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proofRoot, encoding: 'utf8' }).trim();
  assert.equal(head, expectedHead);
  const delta = execFileSync('git', ['diff', '--name-status', '--no-renames', protocol.publication.before, head], { cwd: proofRoot, encoding: 'utf8' });
  assertPublicationDelta(delta);
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...PROOF_PATHS], { cwd: proofRoot, encoding: 'utf8' });
  assert.equal(status, '', 'Every live proof file must be clean on the timed route');
  for (const path of PROOF_PATHS) assert.equal(sha256(readFileSync(join(proofRoot, path))), sha256(execFileSync('git', ['show', `${head}:${path}`], { cwd: proofRoot })), `Live proof differs from HEAD: ${path}`);
  return { head, base: protocol.publication.before, delta, liveProofs: manifest(proofRoot, PROOF_PATHS) };
}
export function causalGuard(baseline, candidate, proofRoot) {
  const guard = pinnedGuard(baseline, candidate, proofRoot);
  guard.causalProofs = manifest(proofRoot, NEW_PATHS);
  assert(guard.causalProofs.files.every(file => file.sha256));
  const graph = readFileSync(join(proofRoot, 'proofs/registry-arm-causal-graph.mjs'));
  assert.equal(sha256(graph), '6e5c856598f0db6c4b66895c6153234e29ff7468efacd10f496893d3f26fdb78', 'Frozen graph helper changed');
  return guard;
}
export function internalExports(context) {
  const matches = readdirSync(context.dist).filter(name => name.endsWith('.js') && readFileSync(join(context.dist, name), 'utf8').includes('class Arena {'));
  assert.equal(matches.length, 1);
  assert(/^[a-zA-Z0-9_-]+\.js$/.test(matches[0]));
  const source = readFileSync(join(context.dist, matches[0]), 'utf8');
  assert(/export \{[^}]*\barenaOf\b[^}]*\bArena\b[^}]*\};/.test(source));
  return `export { Arena, arenaOf } from './dist/${matches[0]}';\n`;
}
