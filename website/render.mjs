import { marked } from 'marked';
import ts from 'typescript';
import { posix } from 'node:path';
import { repository } from './config.mjs';

export const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const unescape = text => text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }[name]));
/** Use the project's TypeScript scanner, not client-side highlighting code. */
export function highlight(code, language = 'ts') {
  if (!/^(ts|tsx|js|jsx|typescript|javascript)$/.test(language)) return escape(code);
  const scan = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  let html = '';
  for (let kind = scan.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scan.scan()) {
    const cls = kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword ? 'kw'
      : [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateTail].includes(kind) ? 'str'
      : [ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(kind) ? 'comment'
      : kind === ts.SyntaxKind.NumericLiteral ? 'num' : '';
    const text = escape(scan.getTokenText());
    html += cls ? `<span class="${cls}">${text}</span>` : text;
  }
  return html;
}
export function codeBlock(code, label = 'TypeScript', language = 'ts') {
  return `<div class="code-block"><div class="code-label"><span>${escape(label)}</span><button type="button" class="copy-code" aria-label="Copy ${escape(label)} code">Copy</button></div><pre tabindex="0"><code>${highlight(code, language)}</code></pre></div>`;
}
export function slug(text) {
  return unescape(text.replace(/<[^>]*>/g, '').replace(/[`*~]/g, '')).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
}
/** Only checked-in Markdown is rendered. Search input never enters this renderer. */
export function renderMarkdown(source, file, routes, base) {
  const toc = [], used = new Set();
  // Prevent duplicate h1s: the page shell supplies the title.
  let html = marked.parse(source.replace(/^# .+\r?\n/, ''), { gfm: true, headerIds: false });
  for (const match of html.matchAll(/<a\b[^>]*\b(?:id|name)="([^"]+)"/g)) used.add(match[1]);
  html = html.replace(/<h([2-6])(?:\s+[^>]*)?>([\s\S]*?)<\/h\1>/g, (_, depth, text) => {
    const original = slug(text); let id = original, count = 0;
    while (used.has(id)) id = `${original}-${++count}`;
    used.add(id);
    if (+depth <= 3) toc.push({ id, text: unescape(text.replace(/<[^>]*>/g, '')), depth: +depth });
    return `<h${depth} id="${id}">${text}<a class="heading-link" href="#${id}" aria-label="Link to ${escape(unescape(text.replace(/<[^>]*>/g, '')))}">#</a></h${depth}>`;
  });
  html = html.replace(/href="([^"]*)"/g, (_, raw) => {
    const href = unescape(raw);
    if (/^(https?:|mailto:|#)/.test(href)) return `href="${escape(href)}"`;
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) return 'href="#"';
    const hash = href.indexOf('#'), path = hash < 0 ? href : href.slice(0, hash), fragment = hash < 0 ? '' : href.slice(hash);
    const resolved = posix.normalize(posix.join(posix.dirname(file), path));
    const legacy = resolved === 'README.md' ? {
      '#build-from-source': 'docs/getting-started/#install-the-source-package',
      '#read-shared-state-directly': 'docs/getting-started/',
      '#run-a-typed-task': 'docs/tasks/',
      '#performance': 'docs/benchmarks/',
      '#memory-shared-vs-immutablejs-vs-native': 'docs/benchmarks/#memory-shared-vs-immutablejs-vs-native',
      '#reproduce-the-timing-and-memory-comparisons': 'docs/benchmarks/#reproduce-the-timing-and-memory-comparisons',
    }[fragment] : undefined;
    const demo = resolved === 'website/README.md' ? { '#playground': 'playground/', '#benchmark-lab': 'lab/', '#log-explorer': 'explorer/', '#investigation-benchmark': 'investigation-benchmark/' }[fragment] : undefined;
    const route = routes.get(resolved);
    const target = demo ? base + demo : legacy ? base + legacy : route !== undefined ? base + route + fragment : repository + '/blob/main/' + resolved + fragment;
    return `href="${escape(target)}"`;
  });
  html = html.replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, lang = 'text', code) => codeBlock(unescape(code).replace(/\n$/, ''), lang, lang));
  html = html.replace(/<table>/g, '<div class="table-scroll" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, toc };
}
