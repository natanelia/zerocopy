import { findResults, resultSnippet, validateSearchIndex } from './search.mjs';

const base = document.body.dataset.base;
const dialog = document.querySelector('.search-dialog');
const input = document.querySelector('#search-input');
const resultList = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
const retry = document.querySelector('#search-retry');
let searchData, loading, notifyTimer, searchOpener;
export function notify(text) {
  const toast = document.querySelector('.toast');
  toast.textContent = text; toast.classList.add('visible');
  clearTimeout(notifyTimer); notifyTimer = setTimeout(() => toast.classList.remove('visible'), 2300);
}
async function openSearch() {
  if (dialog.open) return;
  searchOpener = document.activeElement;
  dialog.showModal(); input.focus();
  if (searchData) search();
  else await loadSearch();
}
async function loadSearch() {
  retry.hidden = true;
  status.textContent = 'Loading the local search index…';
  resultList.setAttribute('aria-busy', 'true');
  try {
    loading ??= fetch(base + 'search.json', { cache: 'no-cache' }).then(response => {
      if (!response.ok) throw new Error('Search index unavailable');
      return response.json().then(validateSearchIndex);
    });
    searchData = await loading;
    if (dialog.open) search();
  } catch {
    searchData = undefined; loading = undefined;
    status.textContent = 'Search could not load. Retry, or browse the documentation.';
    retry.hidden = false;
  } finally { resultList.setAttribute('aria-busy', 'false'); }
}
function search() {
  if (!searchData) return;
  const { results, total, terms } = findResults(searchData, input.value);
  resultList.replaceChildren();
  for (const page of results) {
    const item = document.createElement('li');
    const link = document.createElement('a'); link.className = 'search-result'; link.href = base + page.route;
    const title = document.createElement('strong'); title.textContent = page.heading || page.title;
    const context = document.createElement('span'); context.className = 'search-context';
    context.textContent = page.heading ? [page.title, page.context].filter(Boolean).join(' › ') : 'Guide';
    const description = document.createElement('p'); description.textContent = resultSnippet(page, terms);
    link.append(context, title, description); item.append(link); resultList.append(item);
  }
  status.textContent = !terms.length ? 'Start with a guide, or search for a topic or method.'
    : total ? `${total} matching ${total === 1 ? 'result' : 'results'}${total > results.length ? `; showing ${results.length}` : ''}.`
    : 'No results. Try a collection name, method, or a shorter phrase.';
}
document.querySelectorAll('.search-open').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('.search-close').addEventListener('click', () => dialog.close());
retry.addEventListener('click', async () => { input.focus(); await loadSearch(); });
resultList.addEventListener('click', event => { if (event.target.closest('a')) dialog.close(); });
dialog.addEventListener('close', () => { if (!dialog.open && searchOpener?.isConnected) searchOpener.focus({ preventScroll: true }); });
dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
input.addEventListener('input', search);
dialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
  const links = [...resultList.querySelectorAll('a')];
  const index = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' && links.length) { event.preventDefault(); links[(index + 1) % links.length].focus(); }
  if (event.key === 'ArrowUp' && links.length) { event.preventDefault(); if (index <= 0) input.focus(); else links[index - 1].focus(); }
  if (event.key === 'Enter' && document.activeElement === input && links.length) { event.preventDefault(); links[0].click(); }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
document.querySelector('.menu-toggle').addEventListener('click', event => {
  const nav = document.querySelector('#mobile-nav'); nav.hidden = !nav.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!nav.hidden));
});
// A menu opened on a narrow screen must not cover the desktop after a resize.
const mobileWidth = matchMedia('(max-width: 850px)');
function resetDesktopMenu() {
  if (mobileWidth.matches) return;
  document.querySelector('#mobile-nav').hidden = true;
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
}
mobileWidth.addEventListener('change', resetDesktopMenu);
resetDesktopMenu();
document.addEventListener('click', async event => {
  const button = event.target.closest('.copy-code, .copy-page');
  if (!button) return;
  try {
    let text;
    if (button.matches('.copy-code')) text = button.closest('.code-block').querySelector('code').textContent;
    else { const response = await fetch(button.dataset.markdown); if (!response.ok) throw new Error('Unavailable'); text = await response.text(); }
    await navigator.clipboard.writeText(text); notify('Copied.');
  } catch { notify('Copy was blocked. Select the code and copy it manually.'); }
});
