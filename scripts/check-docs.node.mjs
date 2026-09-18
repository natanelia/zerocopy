import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { anchors, checkLinks, numericRows, preservedRows, prose } from './check-docs.mjs';

// Run explicitly with node --test; keep this out of Vitest's *.test.* discovery.
test('ignores fenced examples but retains surrounding prose', () => {
  assert.equal(prose('one\n```ts\n[bad](missing.md)\n```\ntwo'), 'one\n\n\n\ntwo');
  assert.equal(prose('~~~\n# Hidden\n~~~\n# Visible').includes('Hidden'), false);
});
test('matches punctuation, duplicate headings, and explicit anchors', () => {
  assert.deepEqual([...anchors('# JSAN\'s reserved property\n# Repeat\n# Repeat\n<a id="old"></a>')], ['old', 'jsans-reserved-property', 'repeat', 'repeat-1']);
});
test('checks local links and anchors without fetching external URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'zerocopy-doc-links-'));
  try {
    const file = join(root, 'README.md');
    writeFileSync(join(root, 'guide.md'), '# Working heading\n');
    writeFileSync(file, '[ok](guide.md#working-heading)\n[external](https://example.invalid)\n```\n[ignored](missing.md)\n```\n[bad](guide.md#missing)\n[missing](absent.md)\n');
    assert.deepEqual(checkLinks(file, root), ['guide.md#missing: missing heading', 'absent.md: missing path']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('compares numeric table rows as a multiset, without changing precision', () => {
  const row = '| get | 0.2339ms | 3.99x faster |';
  assert.equal(numericRows('| Operation | Time |\n|---|---|\n' + row).length, 1);
  assert.deepEqual(preservedRows(row + '\n' + row, row), { total: 2, missing: ['|get|0.2339ms|3.99x faster|'] });
  assert.equal(preservedRows(row, '| get | 0.234ms | 3.99x faster |').missing.length, 1);
});

test('strict CLI rejects changed rows and evidence, not documentation edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'zerocopy-doc-preserve-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'proofs/results'), { recursive: true });
    copyFileSync(new URL('./check-docs.mjs', import.meta.url), join(root, 'scripts/check-docs.mjs'));
    const readme = '# Benchmarks\n<!-- library-timing-tables:start -->\n' +
      Array.from({ length: 8 }, (_, group) => `**Shared${group}**\n` +
        Array.from({ length: group < 4 ? 5 : 4 }, (_, row) => `| op${group}-${row} | 1.000ms |`).join('\n')).join('\n') +
      '\n<!-- library-timing-tables:end -->\n';
    const evidence = join(root, 'proofs/results/sample.json');
    writeFileSync(join(root, 'README.md'), readme);
    writeFileSync(evidence, '{"samples":[1,2,3]}\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=Docs test', '-c', 'user.email=docs@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const base = git('rev-parse', 'HEAD').trim();
    const run = (...args) => spawnSync(process.execPath, ['scripts/check-docs.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
    const strict = () => run('--base', base, '--preserve');
    assert.equal(strict().status, 0);

    writeFileSync(join(root, 'README.md'), readme.replace('1.000ms', '1.001ms'));
    assert.equal(run('--base', base).status, 0, 'report-only mode remains available');
    const changedRow = strict();
    assert.equal(changedRow.status, 1);
    assert.match(changedRow.stderr, /Recorded benchmark data changed/);

    writeFileSync(join(root, 'README.md'), readme);
    writeFileSync(evidence, '{"samples":[1,2,4]}\n');
    assert.equal(strict().status, 1, 'modified raw samples must fail');
    rmSync(evidence);
    assert.equal(strict().status, 1, 'deleted raw samples must fail');

    writeFileSync(evidence, '{"samples":[1,2,3]}\n');
    writeFileSync(join(root, 'README.md'), readme + '\nA clearer explanation.\n');
    assert.equal(strict().status, 0, 'prose-only edits must pass');
    const noBase = run('--preserve');
    assert.equal(noBase.status, 1);
    assert.match(noBase.stderr, /--preserve requires --base/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
