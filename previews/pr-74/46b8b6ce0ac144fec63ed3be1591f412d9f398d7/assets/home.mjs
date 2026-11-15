const card = document.querySelector('.sharing-card');
const range = document.querySelector('#worker-count');
const cells = [...document.querySelectorAll('.memory-grid i')];
const readerNames = ['UI', 'Search', 'Validation', 'Export'];
const readerIcons = ['◈', '⌕', '✓', '↑'];
let mode = 'shared', revision = 1;

// This is a model of ownership, not a benchmark or an actual shared arena.
// Keep it separate from the library-backed, opt-in snapshot studio.
function render() {
  const count = Number(range.value);
  const label = `r${String(revision).padStart(2, '0')}`;
  card.dataset.model = mode;
  document.querySelector('#worker-count-value').textContent = String(count);
  document.querySelector('#arena-label').textContent = mode === 'shared' ? 'Shared backing storage' : 'Owner storage';
  document.querySelector('#arena-revision').textContent = label;
  document.querySelector('#storage-count').textContent = mode === 'shared' ? '1 backing store' : `${count + 1} separate stores`;
  document.querySelector('#concept-state').textContent = mode === 'shared'
    ? `${label} · Same bytes. Independent readers.`
    : `${label} · Each reader receives a copy.`;
  const list = document.querySelector('#reader-nodes');
  list.style.setProperty('--readers', count);
  list.replaceChildren();
  for (let i = 0; i < count; i++) {
    const node = document.createElement('div'); node.className = 'reader-node';
    const icon = document.createElement('span'); icon.className = 'reader-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = readerIcons[i];
    const name = document.createElement('span'); name.textContent = readerNames[i];
    const description = document.createElement('small'); description.textContent = mode === 'shared' ? 'READ-ONLY VIEW' : 'LOCAL COPY';
    name.append(description); node.append(icon, name);
    if (mode === 'cloned') {
      const memory = document.createElement('div'); memory.className = 'mini-memory'; memory.setAttribute('aria-hidden', 'true');
      for (let j = 0; j < 4; j++) memory.append(document.createElement('i'));
      node.append(memory);
    }
    list.append(node);
  }
  document.querySelectorAll('[data-storage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storage === mode)));
}
range.addEventListener('input', render);
document.querySelectorAll('[data-storage]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.storage; render(); }));
document.querySelector('#publish-concept').addEventListener('click', () => {
  revision++;
  cells.forEach((cell, index) => cell.classList.toggle('memory-hot', (index + revision * 7) % 19 < 4));
  render();
});
render();

const tabs = [...document.querySelectorAll('[data-code-tab]')];
function select(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  }
}
tabs.forEach(tab => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[1 - tabs.indexOf(tab)];
    select(next); next.focus();
  });
});
