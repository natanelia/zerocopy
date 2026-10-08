/** Reject unrelated production/build changes before a diagnostic comparison. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const baseline = process.argv[2], kind = process.argv[3];
assert.match(baseline ?? '', /^[a-f0-9]{40}$/);
assert(['bulk', 'link'].includes(kind));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const runtime = kind === 'bulk' ? 'arena.ts' : 'persistent-core.as.ts';
const workflow = kind === 'bulk' ? '.github/workflows/bulk-leaf-alignment.yml' : '.github/workflows/core-link-range.yml';
const before = execFileSync('git', ['show', `${baseline}:${runtime}`], { encoding: 'utf8' });
const old = kind === 'bulk' ? '(16 + n + length + 7) & ~7' : 'if (root) memory.copy(p, root, 128); else memory.fill(p, 0, 128);';
const replacement = kind === 'bulk' ? '(16 + n + length + 3) & ~3' : 'if (root) copyWords(p, root, 128); else memory.fill(p, 0, 128);';
assert.equal(before.split(old).length - 1, kind === 'bulk' ? 2 : 1, 'Baseline layout changed; review the intended patch');
const expected = before.replaceAll(old, replacement), actual = readFileSync(runtime, 'utf8');
assert.equal(actual, expected, `Candidate ${runtime} contains edits beyond the exact intended optimization`);
const changed = git('diff', '--name-only', baseline, '--').split('\n').filter(Boolean);
const production = path => {
  if (/^(proofs|docs|type-tests)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (path.startsWith('.github/workflows/')) return true;
  return /\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(package\.json|(?:bun|package|yarn|pnpm)[^/]*lock[^/]*|(?:ts|as)config[^/]*\.json)$/.test(path);
};
const productionDiff = changed.filter(production);
assert.deepEqual(productionDiff.filter(path => path !== runtime && path !== workflow), [], 'Unrelated production/build source changes would confound this diagnostic');
assert(productionDiff.includes(runtime), 'The intended runtime change is absent');
const sha256 = text => createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({ baselineCommit: baseline, candidateCommit: git('rev-parse', 'HEAD'), kind, runtime, productionDiff,
  baselineSourceSha256: sha256(before), candidateSourceSha256: sha256(actual),
  guardSha256: sha256(readFileSync(new URL(import.meta.url))), exactPatchVerified: true }, null, 2));
