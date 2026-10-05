import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const out = new URL('../_site/', import.meta.url);
const read = path => readFileSync(new URL(path, out), 'utf8');
const meta = JSON.parse(read('build.json'));

test('production documentation publishes by default, with an explicit opt-out', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/docs-website.yml', import.meta.url), 'utf8');
  assert.match(workflow, /vars\.DOCS_PAGES != 'false'/);
});

test('the homepage identifies the library, not only its slogan', () => {
  assert.match(read('index.html'), /<title>zerocopy: Zero-copy immutable collections for JavaScript and TypeScript/);
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
