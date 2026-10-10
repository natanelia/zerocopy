import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { shell } from '../templates.mjs';
import { projectName, repository, npmPackage } from '../config.mjs';

const out = new URL('../_site/', import.meta.url);
const read = path => readFileSync(new URL(path, out), 'utf8');
const meta = JSON.parse(read('build.json'));

test('production documentation publishes by default, with an explicit opt-out', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/docs-website.yml', import.meta.url), 'utf8');
  assert.match(workflow, /vars\.DOCS_PAGES != 'false'/);
});

test('the homepage identifies the library, not only its slogan', () => {
  const html = read('index.html');
  assert.match(html, /<title>natanelia\/zerocopy: Immutable collections for JavaScript and TypeScript<\/title>/);
  const body = html.split('<body')[1];
  assert.ok(body.includes(`<a href="${repository}">${projectName}</a>`));
  assert.match(body, /zerocopy is a JavaScript and TypeScript library/);
  assert.ok(body.includes(`href="${npmPackage}"`));
  assert.match(read('index.html'), /SharedArrayBuffer/);
});

test('previews and the error page cannot be indexed', () => {
  assert.match(read('404.html'), /<meta name="robots" content="noindex,nofollow">/);
  for (const route of meta.pages) {
    const html = read(route + 'index.html');
    if (meta.preview) assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
    else assert.doesNotMatch(html, /<meta name="robots"[^>]*noindex/);
  }
  if (meta.preview) {
    assert.equal(existsSync(new URL('sitemap.xml', out)), false);
    // Crawlers must fetch the HTML to see its noindex directive.
    assert.doesNotMatch(read('robots.txt'), /Disallow: \/\s/);
    assert.doesNotMatch(read('robots.txt'), /Sitemap:/);
  }
});

test('production sitemap and page metadata agree on clean deployment URLs', () => {
  if (meta.preview || !existsSync(new URL('sitemap.xml', out))) return;
  const locations = [...read('sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(locations.length, meta.pages.length);
  assert.equal(new Set(locations).size, locations.length);
  for (const [index, route] of meta.pages.entries()) {
    const url = locations[index];
    assert.equal(new URL(url).pathname, meta.base + route);
    const html = read(route + 'index.html');
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), route);
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`), route);
    assert.match(html, /<meta name="twitter:card" content="summary">/);
  }
  assert.doesNotMatch(read('sitemap.xml'), /previews\/|404\.html|markdown\//);
  assert.ok(read('robots.txt').includes(`Sitemap: ${new URL('sitemap.xml', locations[0]).href}`));
});

function projectData(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
}

test('built pages describe the source project only on the canonical production homepage', () => {
  for (const route of meta.pages) {
    const html = read(route + 'index.html');
    const data = projectData(html);
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/);
    if (route || meta.preview || !canonical) {
      assert.deepEqual(data, [], route);
      continue;
    }
    assert.equal(data.length, 1);
    assert.equal(data[0]['@context'], 'https://schema.org');
    assert.equal(data[0]['@type'], 'SoftwareSourceCode');
    assert.equal(data[0]['@id'], repository);
    assert.equal(data[0].name, projectName);
    assert.equal(data[0].alternateName, 'zerocopy');
    assert.equal(data[0].url, canonical[1]);
    assert.equal(data[0].codeRepository, repository);
    assert.equal(data[0].license, `${repository}/blob/main/LICENSE`);
    assert.deepEqual(data[0].sameAs, [npmPackage]);
    assert.deepEqual(data[0].programmingLanguage, ['TypeScript', 'JavaScript']);
  }
  assert.deepEqual(projectData(read('404.html')), []);
});

test('project identity uses the deployment URL and cannot escape its JSON-LD script', () => {
  const description = 'Shared "maps" & lists </script><script>alert(1)</script>';
  const options = { title: projectName, description, body: '<main></main>', version: '0.2.1', sha: 'a'.repeat(40), origin: 'https://example.test' };
  for (const base of ['/', '/zerocopy/']) {
    const html = shell({ ...options, base });
    assert.equal(projectData(html)[0].url, options.origin + base);
    assert.equal(projectData(html)[0].description, description);
    assert.doesNotMatch(html, /<script>alert/);
    assert.ok(html.includes('\\u003c/script>'));
    assert.deepEqual(projectData(shell({ ...options, base, origin: '' })), []);
    assert.deepEqual(projectData(shell({ ...options, base, noindex: true })), []);
    assert.deepEqual(projectData(shell({ ...options, base, route: 'docs/getting-started/' })), []);
  }
});
