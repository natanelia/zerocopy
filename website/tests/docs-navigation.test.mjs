import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pages } from '../config.mjs';
import { renderMarkdown } from '../render.mjs';
import { docsLayout } from '../templates.mjs';
import { findResults, resultSnippet, validateSearchIndex } from '../assets/search.mjs';
import { extract, extractText } from '../../scripts/doc-examples.mjs';

const routes = new Map(pages.map(page => [page.source, `docs/${page.slug}/`]));
const entry = (overrides = {}) => ({ title: 'Collection guide', description: 'Learn shared collections.', heading: '', context: '', route: 'docs/collections/', text: 'Start here.', ...overrides });
function index(page, rendered) {
  return rendered.sections.map(section => ({ title: page.title, description: page.description, heading: section.title,
    context: section.context, route: `docs/${page.slug}/${section.id ? '#' + section.id : ''}`, text: section.text }));
}

test('section indexing shares unique renderer IDs, handles inline markup, and retains late text', () => {
  const source = '# Guide\n\nIntroduction.\n\n<a id="same"></a>\n\n## Same\n\n' + 'Early text. '.repeat(3000)
    + '\n\n### `Late` &amp; exact\n\nneedleBeyond28000 uses `.get()` safely.\n\n## Same\n\nLast section.\n\n#### Deep\n\nNested detail.';
  const rendered = renderMarkdown(source, 'docs/example.md', routes, '/');
  assert.deepEqual(rendered.sections.map(section => section.id), ['', 'same-1', 'late--exact', 'same-2', 'deep']);
  assert.equal(rendered.sections[2].title, 'Late & exact');
  assert.equal(rendered.sections[2].context, 'Same');
  assert.match(rendered.sections[1].text, /Early text/);
  const entries = index({ slug: 'example', title: 'Example', description: 'Intro' }, rendered);
  const result = findResults(entries, 'needleBeyond28000').results[0];
  assert.equal(result.route, 'docs/example/#late--exact');
  assert.match(resultSnippet(result, ['needlebeyond28000']), /needleBeyond28000/);
  for (const section of rendered.sections.slice(1)) assert.ok(rendered.html.includes(`id="${section.id}"`));
  assert.doesNotMatch(rendered.sections[1].text, /needleBeyond28000/);
});

test('queries rank heading matches first and snippets show the matching passage', () => {
  const entries = [entry(), entry({ heading: 'Other', route: 'docs/collections/#other', text: 'Use compaction.' }),
    entry({ heading: 'Compaction', route: 'docs/collections/#compaction', text: 'A retained snapshot. '.repeat(30) + 'Release old memory after compaction.' })];
  const found = findResults(entries, '  COMPACTION compaction  ');
  assert.equal(found.total, 2);
  assert.deepEqual(found.terms, ['compaction']);
  assert.equal(found.results[0].heading, 'Compaction');
  assert.match(resultSnippet(found.results[0], found.terms), /Release old memory after compaction/);
  assert.ok(resultSnippet(found.results[0], found.terms).length <= 192);
  assert.deepEqual(findResults(entries, '').results.map(item => item.heading), ['']);
  for (const query of ['<script>alert(1)</script>', '[.*+?^${}()|\\]', 'no-such-method']) assert.equal(findResults(entries, query).total, 0);
  assert.equal(findResults(entries, 'compaction no-such-method').total, 0);
  assert.equal(findResults(entries, 'compaction', 1).total, 2);
  assert.equal(findResults(entries, 'compaction', 1).results.length, 1);
});

test('invalid, old, or nonlocal search indexes fail before links are rendered', () => {
  assert.deepEqual(validateSearchIndex([entry()]), [entry()]);
  assert.deepEqual(validateSearchIndex([]), []);
  for (const value of [null, {}, [null], [{ title: 'Old schema', route: 'docs/collections/' }],
    [entry({ text: 42 })], [entry({ route: '//example.org/' })], [entry({ route: '../escape/' })],
    [entry({ route: 'https://example.org/' })], [entry({ route: 'docs/example/#bad"' })]]) {
    assert.throws(() => validateSearchIndex(value), /unsupported format/);
  }
  validateSearchIndex([entry({ route: 'docs/example/#日本語' })]);
});

for (const base of ['/', '/zerocopy/', '/zerocopy/previews/pr-99/8a9075aa530f4cc65c577ed665389ba440d5d156/']) {
  test(`all source guides have valid section destinations and grouped navigation at ${base}`, () => {
    for (const page of pages) {
      const source = readFileSync(new URL('../../' + page.source, import.meta.url), 'utf8');
      const rendered = renderMarkdown(source, page.source, routes, base);
      const entries = validateSearchIndex(index(page, rendered));
      assert.equal(entries.filter(item => !item.heading).length, 1);
      for (const result of entries) {
        const target = new URL(base + result.route, 'https://example.org');
        assert.equal(target.origin, 'https://example.org');
        assert.equal(target.pathname, `${base}docs/${page.slug}/`);
        if (target.hash) assert.ok(rendered.html.includes(`id="${decodeURIComponent(target.hash.slice(1))}"`));
      }
      const html = docsLayout(page, rendered.html, rendered.toc, pages, base, 'a'.repeat(40));
      const mobileGuides = html.match(/<details class="mobile-docs-menu">([\s\S]*?)<\/details>/)[1];
      assert.equal((mobileGuides.match(/aria-current="page"/g) ?? []).length, 1);
      assert.ok(mobileGuides.includes(`href="${base}docs/${page.slug}/" aria-current="page"`));
      for (const group of new Set(pages.map(item => item.group))) assert.ok(mobileGuides.includes(`<h2>${group}</h2>`));
      if (rendered.toc.length) {
        const mobileContents = html.match(/<details class="mobile-page-menu">([\s\S]*?)<\/details>/)[1];
        for (const heading of rendered.toc) assert.ok(mobileContents.includes(`href="#${heading.id}"`));
      }
      const group = pages.filter(item => item.group === page.group), position = group.indexOf(page);
      const pagination = html.match(/<nav class="doc-pagination"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
      for (const [neighbor, rel] of [[group[position - 1], 'prev'], [group[position + 1], 'next']]) {
        if (neighbor) assert.ok(pagination.includes(`rel="${rel}" href="${base}docs/${neighbor.slug}/"`));
        else assert.ok(!pagination.includes(`rel="${rel}"`));
      }
    }
  });
}

test('quickstart keeps existing link targets and puts first success before source builds', () => {
  const source = readFileSync(new URL('../../docs/getting-started.md', import.meta.url), 'utf8');
  const { html } = renderMarkdown(source, 'docs/getting-started.md', routes, '/');
  for (const id of ['install-zerocopy', 'set-up-the-browser', 'copy-these-two-files', 'install-the-source-package', 'next-steps']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.ok(source.indexOf('## Run it and check the result') < source.indexOf('## Install the source package'));
  assert.match(source, /zerocopy@0\.2\.1/);
  assert.match(source, /vite@8\.3\.4/);
});

test('starter extraction includes exact HTML and retains duplicate/missing/language checks', () => {
  const html = extract('docs/getting-started.md', 'starter-html', 'html');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<script type="module" src="\/main.ts"><\/script>/);
  assert.match(extract('docs/getting-started.md', 'starter-vite-config', 'js'), /worker: \{ format: 'es' \}/);
  for (const language of ['ts', 'js', 'html']) {
    const source = `<!-- example: one -->\n\`\`\`${language}\nexact contents\n\`\`\``;
    assert.equal(extractText(source, 'one', language), 'exact contents');
    assert.throws(() => extractText(source + source, 'one', language), /expected one/);
    assert.throws(() => extractText(source, 'missing', language), /expected one/);
    assert.throws(() => extractText(source, 'one', 'wrong'), /missing wrong fence/);
  }
  assert.throws(() => extractText('<!-- example: one -->\nno fence', 'one', 'html'), /missing html fence/);
});
