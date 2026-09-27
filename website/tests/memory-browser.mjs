import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const engine = process.env.BROWSER ?? 'webkit';
assert.ok(['chromium', 'webkit'].includes(engine));
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const server = createPreview({ base: meta.base });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => console.error('Browser error:', error.stack));
  await page.goto(`http://127.0.0.1:${server.address().port}${meta.base}compare/`);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  const probe = await page.evaluate(() => {
    const result = [];
    for (const maximum of [65536, 32767, 4096, 1024]) {
      try {
        const memory = new WebAssembly.Memory({ initial: 2, maximum, shared: true });
        result.push({ maximum, bytes: memory.buffer.byteLength });
      } catch (error) { result.push({ maximum, error: String(error) }); }
    }
    return result;
  });
  console.log('Shared memory constructor probe:', JSON.stringify(probe));
  for (const size of ['1000', '100000', '1000']) {
    await page.locator('#compare-size').selectOption(size);
    await page.locator('#compare-start').click();
    await page.waitForFunction(() =>
      document.querySelector('#compare-parity').dataset.verified === 'true' ||
      (!document.querySelector('#compare-start').disabled && /(?:error|stopped|failed|memory)/i.test(document.querySelector('#compare-status').textContent)));
    const status = await page.locator('#compare-status').innerText();
    assert.equal(await page.locator('#compare-parity').getAttribute('data-verified'), 'true', `${engine} ${size}: ${status}`);
    assert.equal(await page.locator('#compare-count').getAttribute('data-count'), size);
    await page.locator('#compare-stop').click();
    console.log(`Passed: ${engine} Load Both Paths, ${size} events, Stop/restart.`);
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
