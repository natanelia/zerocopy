import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the files exactly as a developer would copy them from the rendered page.
export async function checkHomepageExample(page) {
  const directory = mkdtempSync(join(tmpdir(), 'zerocopy-home-'));
  try {
    mkdirSync(join(directory, 'node_modules'));
    symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(directory, 'node_modules', 'zerocopy'), 'dir');
    for (const [panel, filename] of [['reader', 'worker.mjs'], ['owner', 'main.mjs']]) {
      await page.getByRole('tab', { name: filename }).click();
      const code = await page.locator('#panel-' + panel + ' code').innerText();
      writeFileSync(join(directory, filename), code);
    }
    const output = execFileSync(process.execPath, ['main.mjs'], { cwd: directory, encoding: 'utf8', timeout: 15_000 });
    assert.equal(output.trim(), '12 8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
