import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { webkit } from 'playwright';
import { createPreview } from '../serve.mjs';
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const library = new URL('../_site/compare/library/', import.meta.url);
const originals = new Map(readdirSync(library).filter(name => name.endsWith('.js')).map(name => [new URL(name, library), readFileSync(new URL(name, library), 'utf8')]));
const server = createPreview({ base: meta.base });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  for (const maximum of [65536, 32767, 4096, 1024]) {
    for (const [file, original] of originals) {
      let source = original;
      if (/maximum:\s*65536/.test(source)) {
        source = source.replace(/maximum:\s*65536/g, `maximum: ${maximum}`);
        source = `for (const name of ['Memory', 'Instance']) { const Original = WebAssembly[name]; let count = 0; WebAssembly[name] = new Proxy(Original, { construct(target, args) { count++; try { return Reflect.construct(target, args); } catch (error) { throw new RangeError(name + ' #' + count + ': ' + error.message + '\\n' + error.stack); } } }); }\n` + source;
      }
      writeFileSync(file, source);
    }
    const browser = await webkit.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}${meta.base}compare/`);
      await page.locator('#compare-size').selectOption('1000');
      await page.locator('#compare-start').click();
      await page.waitForFunction(() => document.querySelector('#compare-parity').dataset.verified === 'true' || (!document.querySelector('#compare-start').disabled && /(?:error|stopped|failed|memory)/i.test(document.querySelector('#compare-status').textContent)), null, { timeout: 90000 });
      console.log(JSON.stringify({ maximum, status: await page.locator('#compare-status').innerText(), verified: await page.locator('#compare-parity').getAttribute('data-verified') }));
    } catch (error) { console.log(JSON.stringify({ maximum, error: String(error) })); }
    finally { await browser.close(); }
  }
} finally {
  for (const [file, original] of originals) writeFileSync(file, original);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
