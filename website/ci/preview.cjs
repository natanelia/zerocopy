/* Publish only tested, same-repository PR artifacts. Never run code from the artifact. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = '<!-- zerocopy-preview:v1 -->';
const SHA = /^[a-f0-9]{40}$/;
function previewPath(repository, number, head) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(head)) throw new Error('Invalid preview identity');
  return `/${repository.split('/')[1]}/previews/pr-${number}/${head}/`;
}
function collect(directory) {
  const files = []; let total = 0;
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const relative = prefix + name, absolute = path.join(folder, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !/^[A-Za-z0-9_.\/-]+$/.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe preview path');
      if (stat.isDirectory()) { walk(absolute, relative + '/'); continue; }
      if (!stat.isFile() || !(/\.(html|json|mjs|js|css|svg|md|txt|xml)$/.test(name) || ['.nojekyll', '_headers'].includes(name))) throw new Error(`Unexpected preview file: ${relative}`);
      if (relative.startsWith('.github/') || name === '.env') throw new Error('Preview must contain only static output');
      total += stat.size;
      if (total > 32 * 1024 * 1024 || files.length >= 2000) throw new Error('Preview artifact exceeds the safety limit');
      const buffer = fs.readFileSync(absolute), content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const sha = crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
      files.push({ path: relative, content, sha });
    }
  }
  walk(directory);
  if (!files.some(file => file.path === 'index.html') || !files.some(file => file.path === 'build.json')) throw new Error('Incomplete static site');
  return files;
}
function changes(previous, files, prefix) {
  if (prefix && !/^previews\/pr-[1-9]\d*\/$/.test(prefix)) throw new Error('Invalid preview prefix');
  const old = new Map(previous.filter(item => item.type === 'blob').map(item => [item.path, item.sha]));
  const desired = new Map(files.map(file => [file.path, file]));
  const entries = [];
  for (const [name] of old) {
    const owned = prefix ? name.startsWith(prefix) : !name.startsWith('previews/');
    if (owned && !desired.has(name)) entries.push({ path: name, mode: '100644', type: 'blob', sha: null });
  }
  for (const [name, file] of desired) {
    if (prefix ? !name.startsWith(prefix) : name.startsWith('previews/')) throw new Error('File is outside the publication boundary');
    if (!old.has(name) || old.get(name) !== file.sha) entries.push({ path: name, mode: '100644', type: 'blob', content: file.content });
  }
  return entries;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function publish({ github, context, core }) {
  const repo = context.repo, repository = `${repo.owner}/${repo.repo}`;
  const event = context.payload.pull_request;
  const number = event?.number ?? context.payload.number;
  const isPR = !!event;
  let head, prefix = '', files = [], meta, url;
  async function currentPR() { return (await github.rest.pulls.get({ ...repo, pull_number: number })).data; }
  if (isPR) {
    const pr = await currentPR();
    if (pr.head.repo?.full_name !== repository) { core.info('External forks are not published on this origin.'); return; }
    head = pr.head.sha; prefix = `previews/pr-${number}/`;
    if (context.payload.action === 'closed' && pr.state !== 'closed') { core.info('PR reopened; retaining its preview.'); return; }
    if (context.payload.action !== 'closed') {
      if (pr.state !== 'open' || head !== event.head.sha) { core.info('Discarding a stale or closed PR build.'); return; }
      meta = JSON.parse(fs.readFileSync('preview-site/build.json', 'utf8'));
      const base = previewPath(repository, number, head);
      if (meta.base !== base || meta.preview?.number !== number || meta.preview?.headCommit !== head || meta.sourceCommit !== context.sha || !SHA.test(meta.sourceCommit)) throw new Error('Artifact does not match this PR and tested commit');
      files = collect('preview-site').map(file => ({ ...file, path: `${prefix}${head}/${file.path}` }));
      const landing = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0;url=./${head}/"><title>PR ${number} preview</title></head><body><a href="./${head}/">Open the latest tested preview</a></body></html>\n`;
      files.push({ path: `${prefix}index.html`, content: landing });
    }
  } else {
    if (context.ref !== 'refs/heads/main') throw new Error('Only main may publish the production root');
    const main = (await github.rest.git.getRef({ ...repo, ref: 'heads/main' })).data;
    if (main.object.sha !== context.sha) { core.info('Discarding stale production build.'); return; }
    meta = JSON.parse(fs.readFileSync('preview-site/build.json', 'utf8'));
    if (meta.base !== `/${repo.repo}/` || meta.sourceCommit !== context.sha || meta.preview) throw new Error('Unexpected production artifact');
    files = collect('preview-site');
  }
  async function comment(body) {
    if (!isPR) return;
    const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
    const existing = comments.find(item => item.body?.startsWith(MARKER) && item.user?.login === 'github-actions[bot]');
    const full = `${MARKER}\n${body}`;
    if (existing) await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body: full });
    else await github.rest.issues.createComment({ ...repo, issue_number: number, body: full });
  }
  try {
    const pages = (await github.request('GET /repos/{owner}/{repo}/pages', repo)).data;
    if (pages.source?.branch !== 'gh-pages' || pages.build_type === 'workflow') throw new Error('Set Pages Source to Deploy from a branch → gh-pages → / (root). Existing settings were not changed.');
    const origin = new URL(pages.html_url);
    if (origin.protocol !== 'https:' || origin.hostname !== `${repo.owner.toLowerCase()}.github.io`) throw new Error('The preview build expects the repository GitHub Pages URL; custom domains need an explicit deployment configuration');
    const root = `${origin.origin}/${repo.repo}/`;
    url = isPR ? `${root}${prefix}${head}/` : root;
    let updated = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (isPR) {
        const pr = await currentPR();
        if (context.payload.action === 'closed' ? pr.state !== 'closed' : pr.state !== 'open' || pr.head.sha !== head) { core.info('PR changed; skipping stale publication.'); return; }
      }
      const ref = (await github.rest.git.getRef({ ...repo, ref: 'heads/gh-pages' })).data;
      const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: ref.object.sha })).data;
      const tree = (await github.rest.git.getTree({ ...repo, tree_sha: commit.tree.sha, recursive: 'true' })).data;
      if (tree.truncated) throw new Error('Preview tree is too large to update safely');
      const entries = changes(tree.tree, files, prefix);
      if (!entries.length) { updated = true; break; }
      const nextTree = (await github.rest.git.createTree({ ...repo, base_tree: commit.tree.sha, tree: entries })).data;
      const next = (await github.rest.git.createCommit({ ...repo, tree: nextTree.sha, parents: [ref.object.sha], message: isPR ? `Preview PR #${number}: ${files.length ? head : 'closed; remove preview'}` : `Documentation: ${context.sha}` })).data;
      try { await github.rest.git.updateRef({ ...repo, ref: 'heads/gh-pages', sha: next.sha, force: false }); updated = true; break; }
      catch (error) { if (![409, 422].includes(error.status) || attempt === 3) throw error; await sleep(1000 * (attempt + 1)); }
    }
    if (!updated) throw new Error('Could not publish without overwriting another preview');
    // GITHUB_TOKEN pushes do not trigger a Pages build. Request it explicitly.
    try { await github.request('POST /repos/{owner}/{repo}/pages/builds', repo); }
    catch (error) { if (error.status !== 409) throw error; core.info('Another Pages build is in progress; checking the public result.'); }
    if (!files.length) {
      await comment('### Preview closed\nThis PR is closed. Its hosted preview files have been removed.'); return;
    }
    let live = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (isPR) { const pr = await currentPR(); if (pr.state !== 'open' || pr.head.sha !== head) { core.info('A newer revision will update the preview comment.'); return; } }
      try {
        const response = await fetch(`${url}build.json?verify=${meta.sourceCommit}`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        if (response.ok) {
          const served = await response.json();
          if (served.sourceCommit === meta.sourceCommit && served.base === meta.base) { live = true; break; }
        }
      } catch { /* Deployment propagation can briefly return an unavailable response. */ }
      if (attempt > 0 && attempt % 12 === 0) {
        try { await github.request('POST /repos/{owner}/{repo}/pages/builds', repo); } catch (error) { if (![409, 429].includes(error.status)) throw error; }
      }
      await sleep(5000);
    }
    if (!live) throw new Error('Pages did not serve the tested revision before the verification deadline');
    core.setOutput('url', url);
    const run = `https://github.com/${repository}/actions/runs/${context.runId}`;
    await comment(`### Preview ready\n\n[**Open website**](${url}) · [**zerocopy / Immutable.js / native**](${url}compare/) · [Log explorer](${url}explorer/) · [Benchmark](${url}investigation-benchmark/)\n\nHead: \`${head}\` · Tested build: \`${meta.sourceCommit}\` · [Checks](${run})\n\nThis comment updates after each successful build. The URL is commit-specific to prevent stale scripts and service workers. Shared-memory setup runs automatically (one refresh on a first visit when needed). Select **Load all three paths** to start the comparison.\n\nPublic development preview. No accounts, uploads, analytics, or production data.`);
    await core.summary.addHeading('Verified website preview').addLink('Open preview', url).addLink('Live comparison', url + 'compare/').write();
  } catch (error) {
    await comment(`### Preview not ready\n\nThe preview was not verified, so no working preview link is claimed.\n\n${String(error.message).replace(/[<>]/g, '')}\n\n[Deployment run](https://github.com/${repository}/actions/runs/${context.runId})`);
    throw error;
  }
}
module.exports = { publish, previewPath, collect, changes };
