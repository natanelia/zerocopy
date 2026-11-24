import assert from 'node:assert/strict';

// Exercise the built page at its configured hosting prefix, with a real browser
// clock. Pausing and advancing it keeps these checks independent of machine speed.
export async function checkCityHero(browser, url, screenshots) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const slots = page.locator('.worker-slot');
  const word = page.locator('.runtime-word');
  const hero = page.locator('.city-hero');
  // Clicking playback can scroll a few pixels when the host adds a preview banner.
  const documentBox = selector => page.locator(selector).evaluate(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, width, height };
  });
  const states = locator => locator.evaluateAll(items => items.map(item => item.dataset.state));
  const done = ['done', 'done', 'done'];
  try {
    await page.clock.install();
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.city-relief').evaluate(img => img.decode());
    await page.locator('.copy-install').waitFor();
    assert.deepEqual(await states(slots), done);
    assert.equal(await word.innerText(), 'Node.js');
    assert.equal(await hero.getByRole('button', { name: /animation/ }).count(), 0);
    await page.clock.runFor(20000);
    assert.deepEqual(await states(slots), done);
    assert.equal(await hero.evaluate(el => el.getAnimations({ subtree: true }).length), 0);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('.city-hero').dataset.district === 'planned');
    const start = await documentBox('.runtime-slot');
    const map = await documentBox('.city-model');
    const preceding = await documentBox('.city-actions');
    await page.clock.runFor(4600);
    assert.deepEqual(await states(slots), ['running','running','running']);
    assert.equal(await hero.getAttribute('data-district'), 'raised');
    await page.screenshot({ path: screenshots + '/city-desktop.png' });

    await page.getByRole('button', { name: 'Pause animation' }).click();
    await page.clock.runFor(20000);
    assert.deepEqual(await states(slots), ['running','running','running']);
    await page.getByRole('button', { name: 'Resume animation' }).click();
    await page.clock.runFor(3300);
    assert.equal(await word.innerText(), 'Browser');
    assert.deepEqual(await documentBox('.runtime-slot'), start);
    assert.deepEqual(await states(slots), ['done','running','running']);
    assert.deepEqual(await states(page.locator('.city-pin')), await states(slots));
    await page.clock.runFor(6000);
    assert.equal(await word.innerText(), 'Bun');
    assert.deepEqual(await states(slots), done);
    assert.deepEqual(await documentBox('.runtime-slot'), start);
    assert.deepEqual(await documentBox('.city-actions'), preceding);
    assert.deepEqual(await documentBox('.city-model'), map);
    for (let step = 0; step < 60 && await hero.getAttribute('data-district') !== 'planned'; step++) {
      await page.clock.runFor(100);
    }
    assert.equal(await word.innerText(), 'Node.js');
    assert.equal(await hero.getAttribute('data-district'), 'planned');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.runFor(5000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.city-playback').hidden);
    await page.clock.runFor(20000);
    assert.equal(await word.innerText(), 'Node.js');
    assert.deepEqual(await states(slots), done);
    assert.equal(await hero.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.screenshot({ path: screenshots + '/city-mobile.png' });
    for (const width of [320, 390, 768, 980, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const pins = await page.locator('.city-pin,.district-pin').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()));
      for (const pin of pins) assert.ok(pin.left >= 0 && pin.right <= width, 'Pin visible at ' + width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy npm install command' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'npm i zerocopy');
    const quickstart = hero.getByRole('link', { name: 'Quickstart', exact: true });
    await quickstart.click();
    assert.equal(new URL(page.url()).pathname, new URL('docs/getting-started/', url).pathname);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
