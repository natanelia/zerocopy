import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { anchors, checkLinks, numericRows, preservedRows, prose } from './check-docs.mjs';

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
