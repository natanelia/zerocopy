/** Render the real built pages; graphs must remain useful with JavaScript off. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';
import { chartData } from '../memory-charts.mjs';
const base = JSON.parse(readFileSync(new URL('../_site/build.json',import.meta.url))).base;
const artifacts=fileURLToPath(new URL('../artifacts/',import.meta.url)); mkdirSync(artifacts,{recursive:true});
const server=createPreview({base});server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
// Evaluation and browser setup can wait outside Playwright's action timeouts.
// Fail the proof rather than holding the runner until its six-hour limit.
const deadline = setTimeout(() => {
  console.error('Memory chart browser checks exceeded the three-minute deadline.');
  process.exit(1);
}, 180_000);
deadline.unref();
try {
  const engines=process.env.MEMORY_CHART_BROWSERS?.split(',') || ['chromium','webkit'];
  for(const name of engines) {
    assert.ok(['chromium','webkit'].includes(name));
    const browser=await ({chromium,webkit})[name].launch({headless:true,...(name==='chromium'&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']}: {})});
    try {
      const context=await browser.newContext({javaScriptEnabled:false,reducedMotion:'reduce'});
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(15_000);
      const page=await context.newPage();
      for(const width of [1440,768,390,320]) for(const route of ['docs/memory-comparison/','compare/','investigation-benchmark/']) {
        console.log(`Checking: ${name}, ${width}px, ${route}, JavaScript disabled.`);
        await page.setViewportSize({width,height:960});await page.goto(origin+base+route);
        const figures=page.locator('[data-memory-chart]');assert.equal(await figures.count(),route.startsWith('docs/')?3:2);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} ${width} ${route}: overflow`);
        const failures=await figures.evaluateAll(nodes=>nodes.flatMap(figure=>{
          const failures=[],max=+figure.dataset.memoryMaximum;
          if(document.querySelectorAll('#'+figure.getAttribute('aria-labelledby')).length!==1)failures.push('inaccessible title');
          for(const row of figure.querySelectorAll('.memory-bar')) {
            const track=row.querySelector('.memory-track').getBoundingClientRect();
            const fill=row.querySelector('.memory-fill').getBoundingClientRect();
            if(Math.abs(fill.width/track.width-(+row.dataset.memoryBytes/max))>.007)failures.push('wrong scale');
            if(track.width<=0||fill.left!==track.left)failures.push('missing zero origin');
            for(const label of row.querySelectorAll('.memory-bar-label > *')) {
              const rect=label.getBoundingClientRect(),container=row.getBoundingClientRect();
              if(rect.left<container.left-1||rect.right>container.right+1)failures.push('clipped label');
              if(parseFloat(getComputedStyle(label).fontSize)<14)failures.push('small label');
            }
          }
          return failures;
        }));assert.deepEqual(failures,[],`${name} ${width} ${route}`);
        assert.ok((await figures.first().innerText()).includes('Recorded Node.js'));
        const disclosure=figures.first().locator('summary');await disclosure.focus();await page.keyboard.press('Enter');
        assert.equal(await figures.first().locator('details').getAttribute('open'),'');
        assert.ok((await figures.first().locator('details').innerText()).includes('not confidence intervals'));
        await page.keyboard.press('Enter');
        await page.evaluate(() => document.activeElement?.blur());
        if(route==='docs/memory-comparison/'&&(width===1440||width===390)){
          // addStyleTag waits for a stylesheet load event that Chromium does
          // not deliver with page JavaScript disabled. Change the existing
          // header style through the test driver instead; no page script runs.
          const header = page.locator('.site-header');
          const previousStyle = await header.getAttribute('style');
          await header.evaluate(node => node.style.setProperty('position', 'static', 'important'));
          try {
            for(const chart of ['retained','readers','rss'])await page.locator(`#memory-${chart}`).screenshot({path:`${artifacts}/memory-${chart}-${name}-${width}.png`});
          } finally {
            await header.evaluate((node, value) => {
              if (value === null) node.removeAttribute('style');
              else node.setAttribute('style', value);
            }, previousStyle);
          }
        }
        if(route==='compare/'&&width===1440)await page.locator('.memory-overview').screenshot({path:`${artifacts}/memory-overview-${name}.png`});
      }
      const raw=await context.request.get(origin+base+'assets/memory-chart-data.json');assert.equal(raw.status(),200);assert.deepEqual(await raw.json(),chartData);
      for(const chart of ['retained','readers','rss']) {const svg=await context.request.get(origin+base+`assets/memory-${chart}.svg`);assert.equal(svg.status(),200);assert.ok((await svg.text()).includes('Recorded Node.js'));}
      if(name==='chromium'){
        await page.emulateMedia({forcedColors:'active'});await page.goto(origin+base+'docs/memory-comparison/');
        assert.equal(await page.locator('.memory-bar-label').count(),17);
        assert.ok(await page.locator('#memory-retained').isVisible());
      }
      await context.close();console.log(`Passed: ${name} memory graphs, 4 widths, 3 pages, no JavaScript, keyboard values, exact scales and local exports (${base}).`);
    } finally {await browser.close();}
  }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));clearTimeout(deadline);}
