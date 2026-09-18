import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Omit fenced code while retaining line boundaries for Markdown checks. */
export function prose(markdown) {
  let fence = null;
  return markdown.split('\n').map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && match) { fence = match[1]; return ''; }
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}

/** Collect explicit anchors and GitHub-style IDs for ATX headings. */
export function anchors(markdown) {
  const text = prose(markdown), result = new Set();
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) result.add(match[1]);
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*~]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    let name = base, index = 0;
    while (result.has(name)) name = `${base}-${++index}`;
    result.add(name);
  }
  return result;
}

/** Report broken local paths and Markdown fragments without network requests. */
export function checkLinks(file, root) {
  const text = prose(readFileSync(file, 'utf8')), errors = [];
  const targets = [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(match => match[1]);
  targets.push(...[...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1]));
  for (let target of targets) {
    target = target.trim().replace(/^<([^>]+)>.*$/, '$1').split(/\s+["']/)[0];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const hash = target.indexOf('#');
    const path = (hash < 0 ? target : target.slice(0, hash)).split('?')[0];
    let decoded, fragment;
    try {
      decoded = decodeURIComponent(path);
      fragment = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
    } catch { errors.push(`${target}: invalid URL encoding`); continue; }
    const destination = decoded ? resolve(decoded.startsWith('/') ? root : dirname(file), decoded.replace(/^\//, '')) : file;
    if (relative(root, destination).split(sep).includes('..')) { errors.push(`${target}: outside repository`); continue; }
    if (!existsSync(destination)) { errors.push(`${target}: missing path`); continue; }
    if (fragment && statSync(destination).isFile() && extname(destination) === '.md' && !anchors(readFileSync(destination, 'utf8')).has(fragment)) {
      errors.push(`${target}: missing heading`);
    }
  }
  return errors;
}

/** Normalize table spacing without rounding or changing numeric cell text. */
export function numericRows(markdown) {
  return markdown.split('\n').filter(line => /^\s*\|/.test(line) && line.split('|').some(cell => /^\s*\d/.test(cell)))
    .map(line => line.split('|').map(cell => cell.trim()).join('|'));
}

/** Find missing numeric rows, including duplicate occurrences, in a revision. */
export function preservedRows(before, after) {
  const remaining = new Map();
  for (const row of numericRows(after)) remaining.set(row, (remaining.get(row) ?? 0) + 1);
  const missing = [];
  for (const row of numericRows(before)) {
    const count = remaining.get(row) ?? 0;
    if (count) remaining.set(row, count - 1); else missing.push(row);
  }
  return { total: numericRows(before).length, missing };
}

/** Run repository checks; strict preservation requires an explicit base commit. */
function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const index = process.argv.indexOf('--base');
  const preserve = process.argv.includes('--preserve');
  if (preserve && index === -1) throw new Error('--preserve requires --base <commit>');
  const files = git('ls-files', '-z', '*.md').split('\0').filter(Boolean);
  const failures = files.flatMap(file => checkLinks(resolve(root, file), root).map(error => `${file}: ${error}`));
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const region = readme.match(/<!-- library-timing-tables:start -->([\s\S]*?)<!-- library-timing-tables:end -->/);
  if (!region) failures.push('README.md: missing benchmark markers');
  else {
    const groups = region[1].match(/^\*\*Shared.*\*\*$/gm) ?? [];
    const rows = numericRows(region[1]);
    if (groups.length !== 8 || rows.length !== 36) failures.push(`README.md: expected 8 benchmark groups and 36 operation rows; found ${groups.length} and ${rows.length}`);
  }
  if (index !== -1) {
    const base = process.argv[index + 1];
    if (!/^[a-f\d]{7,40}$/i.test(base ?? '')) throw new Error('--base requires a commit SHA');
    const result = preservedRows(git('show', `${base}:README.md`), readme);
    console.log(`README benchmark rows unchanged: ${result.total - result.missing.length}/${result.total}`);
    if (result.missing.length) console.log('Changed or removed numerical rows:\n' + result.missing.join('\n'));
    const evidence = git('diff', '--name-only', base, '--', 'proofs/results').trim().split('\n').filter(path => path && !path.endsWith('.md'));
    console.log(`Recorded evidence files changed: ${evidence.length}`);
    if (preserve && (result.missing.length || evidence.length)) failures.push('Recorded benchmark data changed');
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Documentation links and benchmark structure passed (${files.length} Markdown files).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
