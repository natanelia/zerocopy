import assert from 'node:assert/strict';

// Check the entry page before interacting with the disclosure. Scrolling it into
// view must not fetch city art, even when the browser would load a lazy image.
export async function checkHomepage(browser, url, screenshots) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const artRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/singapore-relief(?:-900)?\.webp(?:\?|$)/.test(request.url())) artRequests.push(request.url());
  });
  const hero = page.locator('.product-hero');
  const word = hero.locator('.runtime-word');
  const demo = page.locator('#singapore-demo');
  const summary = demo.locator('summary');
  const states = () => demo.locator('.worker-slot').evaluateAll(items => items.map(item => item.dataset.state));
  try {
    await page.clock.install();
    // Delay the homepage module and check the initial paint before it can run.
    await page.setViewportSize({ width: 390, height: 844 });
    let releaseModule;
    const moduleReady = new Promise(resolve => { releaseModule = resolve; });
    await page.route('**/assets/home.mjs', async route => {
      await moduleReady;
      await route.continue();
    });
    try {
      await page.goto(url, { waitUntil: 'commit' });
      await hero.getByRole('tab', { name: 'worker.mjs' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await hero.locator('#panel-owner').isVisible(), false);
      assert.equal(await page.locator('.reader-node').count(), 3);
      const example = hero.locator('.worker-example');
      const firstPaint = await example.boundingBox();
      releaseModule();
      await page.waitForFunction(() => !document.querySelector('.copy-install').disabled);
      assert.deepEqual(await example.boundingBox(), firstPaint);
    } finally {
      releaseModule();
    }
    await page.setViewportSize({ width: 1440, height: 810 });
    assert.equal(await hero.locator('img,.city-example,.city-traces,.city-pin').count(), 0);
    assert.equal(await page.locator('.city-relief').count(), 0);
    assert.equal(await word.innerText(), 'Node.js');
    await page.clock.runFor(20000);
    assert.equal(await word.innerText(), 'Node.js');
    assert.equal(await hero.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.screenshot({ path: screenshots + '/hero-desktop.png' });

    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const intro = await page.locator('.product-intro').boundingBox();
      const example = await hero.locator('.worker-example').boundingBox();
      if (width <= 768) {
        assert.ok(example.y >= intro.y + intro.height - 1 && example.y <= intro.y + intro.height + 34, 'Example follows the intro at ' + width);
      } else {
        assert.ok(example.x >= intro.x + intro.width - 1, 'Example beside the intro at ' + width);
      }
      const runtimeLine = await hero.locator('.runtime-slot').boundingBox();
      assert.ok(runtimeLine.x + runtimeLine.width <= intro.x + intro.width + .1, 'Longest runtime fits at ' + width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow at ' + width);
      const source = hero.locator('[role="tabpanel"]:visible pre');
      assert.equal(await source.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'Readable example at ' + width);
      const copy = await hero.getByRole('button', { name: 'Copy worker.mjs code' }).boundingBox();
      const code = await source.boundingBox();
      assert.ok(copy.y + copy.height <= code.y + 1, 'Copy control sits above the source at ' + width);
      if (width === 390) await page.screenshot({ path: screenshots + '/hero-mobile.png' });
    }

    // Only the runtime name changes in the hero, and its reserved width stays fixed.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await hero.locator('.runtime-control').waitFor({ state: 'visible' });
    const start = await hero.locator('.runtime-slot').boundingBox();
    await page.clock.runFor(6600);
    assert.equal(await word.innerText(), 'Browser');
    const cycled = await hero.locator('.runtime-slot').boundingBox();
    for (const edge of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(cycled[edge] - start[edge]) < .1, 'Runtime cycle keeps the headline position');
    }
    const pause = hero.getByRole('button', { name: 'Pause rotating runtime name' });
    await pause.focus(); await page.keyboard.press('Space');
    await page.clock.runFor(15000);
    assert.equal(await word.innerText(), 'Browser');
    await page.keyboard.press('Enter'); await page.clock.runFor(6600);
    assert.equal(await word.innerText(), 'Bun');

    await summary.focus();
    await page.clock.runFor(20000);
    assert.deepEqual(artRequests, []);
    await page.keyboard.press('Enter');
    await demo.locator('.city-relief').evaluate(img => img.decode());
    assert.ok(artRequests.length > 0);
    const queued = ['queued', 'queued', 'queued'];
    assert.deepEqual(await states(), queued);
    await page.clock.runFor(30000);
    assert.deepEqual(await states(), queued, 'Opening the demo does not start playback');
    await page.keyboard.press('Tab');
    const next = demo.getByRole('button', { name: 'Next step' });
    assert.equal(await next.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Space');
    assert.deepEqual(await states(), ['running', 'queued', 'queued']);
    await page.keyboard.press('Enter');
    assert.deepEqual(await states(), ['running', 'running', 'running']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await hero.locator('.runtime-control').waitFor({ state: 'hidden' });
    await page.clock.runFor(30000);
    assert.equal(await word.innerText(), 'Node.js');
    assert.deepEqual(await states(), ['running', 'running', 'running']);
    assert.equal(await demo.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    assert.deepEqual(await states(), ['done', 'done', 'done']);
    await demo.getByRole('button', { name: 'Restart demo' }).press('Enter');
    assert.deepEqual(await states(), queued);
    await summary.press('Space');
    assert.equal(await demo.locator('.city-example').isVisible(), false);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await hero.getByRole('button', { name: 'Copy npm install command' }).press('Enter');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'npm i zerocopy');
    await hero.getByRole('link', { name: 'Quickstart', exact: true }).press('Enter');
    await page.waitForURL(new URL('docs/getting-started/', url).href);
    assert.match(await page.locator('article').innerText(), /connectSharedSession/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
