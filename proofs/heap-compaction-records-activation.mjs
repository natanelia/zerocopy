import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
export const RUNTIME = '21de2bf4b49d1b2cf5da698be41a27f37fd84bed';
export const INTENT = 'proofs/heap-compaction-records-intent.json';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
export function harnessIdentity(root, commit) {
  const files = git(root, 'ls-tree', '-r', commit).split('\n').map(line => {
    const [mode, type, blob, path] = line.split(/[\t ]+/); return { mode, type, blob, path };
  }).filter(f => f.path !== INTENT && (f.path.startsWith('proofs/heap-compaction-records') || f.path === '.github/workflows/heap-compaction-records.yml'));
  assert(files.length > 10);
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
export function verifyPhysicalModes(root, files) {
  for (const file of files) {
    assert.equal(file.type, 'blob', `Committed type: ${file.path}`);
    assert.equal(file.mode, '100644', `Committed mode: ${file.path}`);
    const stat = lstatSync(join(root, file.path));
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o644, `Physical mode: ${file.path}`);
  }
}
export function verifyActivation(root, event, eventName) {
  const head = git(root, 'rev-parse', 'HEAD');
  const entries = [INTENT, 'compaction.ts'].map(path => {
    const [mode, type, blob, actualPath] = git(root, 'ls-tree', head, '--', path).split(/[\t ]+/);
    assert.equal(actualPath, path, `Missing exact HEAD entry: ${path}`);
    return { mode, type, blob, path };
  });
  verifyPhysicalModes(root, entries);
  const intentBytes = readFileSync(join(root, INTENT));
  const committedIntent = execFileSync('git', ['-C', root, 'cat-file', 'blob', entries[0].blob]);
  assert.deepEqual(intentBytes, committedIntent, 'Dirty committed intent bytes');
  const intent = JSON.parse(intentBytes.toString('utf8'));
  if (intent.enabled !== true) return { enabled: false, head, reason: 'default-off intent' };
  assert.equal(eventName, 'push'); assert.equal(event.created, true); assert.equal(event.deleted, false); assert.equal(event.forced, false);
  assert.equal(event.before, '0'.repeat(40)); assert.equal(event.after, head);
  assert(/^refs\/heads\/proof\/heap-compaction-records-run-[a-z0-9-]+$/.test(event.ref));
  for (const field of ['acceptedCommit', 'acceptedTree']) assert(/^[0-9a-f]{40}$/.test(intent[field] ?? ''), `Missing accepted identity: ${field}`);
  assert(/^[0-9a-f]{64}$/.test(intent.acceptedHarnessSha256 ?? ''), 'Missing accepted harness identity');
  assert.equal(intent.publishedRuntime, RUNTIME);
  assert.equal(git(root, 'rev-parse', 'HEAD^'), intent.acceptedCommit, 'Activation must have the accepted published proof commit as sole parent');
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 2);
  assert.equal(git(root, 'rev-parse', `${intent.acceptedCommit}^{tree}`), intent.acceptedTree);
  assert.equal(git(root, 'merge-base', RUNTIME, intent.acceptedCommit), RUNTIME);
  assert.deepEqual(git(root, 'diff', '--name-only', intent.acceptedCommit, head).split('\n'), [INTENT]);
  const before = JSON.parse(execFileSync('git', ['-C', root, 'show', `${intent.acceptedCommit}:${INTENT}`], { encoding: 'utf8' }));
  assert.equal(before.enabled, false, 'The accepted preparation must have timing disabled');
  const identity = harnessIdentity(root, intent.acceptedCommit);
  assert.equal(identity.sha256, intent.acceptedHarnessSha256);
  assert.equal(harnessIdentity(root, head).sha256, identity.sha256);
  verifyPhysicalModes(root, identity.files);
  for (const file of identity.files) assert.equal(git(root, 'hash-object', file.path), file.blob, `Dirty accepted harness: ${file.path}`);
  return { enabled: true, head, publishedRuntime: RUNTIME, acceptedCommit: intent.acceptedCommit, acceptedTree: intent.acceptedTree, acceptedHarnessSha256: identity.sha256, isolatedCreationPush: true, physicalModes: 'verified-0644' };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const receipt = verifyActivation(root, event, process.env.GITHUB_EVENT_NAME);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${receipt.enabled}\n`);
  console.log(JSON.stringify(receipt));
}
