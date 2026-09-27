const base = document.body.dataset.base;
const dialog = document.querySelector('.search-dialog');
const input = document.querySelector('#search-input');
const resultList = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
let searchData, loading, notifyTimer;
export function notify(text) {
  const toast = document.querySelector('.toast');
  toast.textContent = text; toast.classList.add('visible');
  clearTimeout(notifyTimer); notifyTimer = setTimeout(() => toast.classList.remove('visible'), 2300);
}
async function openSearch() {
  if (dialog.open) return;
  dialog.showModal(); input.focus();
  if (!searchData) {
    status.textContent = 'Loading the local search index…';
    try {
      loading ??= fetch(base + 'search.json').then(response => {
        if (!response.ok) throw new Error('Search index unavailable');
        return response.json();
      });
      searchData = await loading; search();
    } catch { loading = undefined; status.textContent = 'Search could not load. Open Documentation from the menu, or try again.'; }
  }
}
function search() {
  if (!searchData) return;
  const query = input.value.toLowerCase().trim().slice(0, 150);
  const terms = query.split(/\s+/).filter(Boolean);
  const results = searchData.map(page => {
    const text = (page.title + ' ' + page.description + ' ' + page.text).toLowerCase();
    return { ...page, score: terms.every(term => text.includes(term))
      ? terms.reduce((score, term) => score + (page.title.toLowerCase().includes(term) ? 20 : 1), 0) : -1 };
  }).filter(page => page.score >= 0).sort((a, b) => b.score - a.score).slice(0, 8);
  resultList.replaceChildren();
  for (const page of results) {
    const link = document.createElement('a'); link.className = 'search-result'; link.href = base + page.route;
    const title = document.createElement('strong'); title.textContent = page.title;
    const description = document.createElement('p'); description.textContent = page.description;
    link.append(title, description); resultList.append(link);
  }
  status.textContent = terms.length ? `${results.length} matching guides${results.length === 8 ? ' shown' : ''}.` : 'Start with a guide, or search for a topic.';
}
document.querySelectorAll('.search-open').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('.search-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
input.addEventListener('input', search);
dialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
  const links = [...resultList.querySelectorAll('a')];
  const index = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' && links.length) { event.preventDefault(); links[(index + 1) % links.length].focus(); }
  if (event.key === 'ArrowUp' && links.length) { event.preventDefault(); if (index <= 0) input.focus(); else links[index - 1].focus(); }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
document.querySelector('.menu-toggle').addEventListener('click', event => {
  const nav = document.querySelector('#mobile-nav'); nav.hidden = !nav.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!nav.hidden));
});
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
