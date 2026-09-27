import { prepareIsolation } from './isolation.mjs';

/** Prepare automatically, but never silently copy or start a heavy demo. */
export function checkCapability(onReady) {
  const panel = document.querySelector('#capability');
  const text = document.querySelector('#capability-text');
  const button = document.querySelector('#enable-isolation');
  const help = document.querySelector('#capability-help');
  let running = false, ready = false;
  async function start(retry = false) {
    if (running || ready) return;
    running = true;
    panel.dataset.state = 'preparing'; panel.setAttribute('aria-busy', 'true');
    text.textContent = 'Preparing this demo…';
    button.hidden = true; button.disabled = true; help.hidden = true;
    try {
      const result = await prepareIsolation({ retry });
      if (result === 'reloading') { text.textContent = 'Finishing setup…'; return; }
      ready = true;
      panel.dataset.state = 'ready'; panel.setAttribute('aria-busy', 'false');
      text.textContent = 'Shared memory is ready. This demo runs locally.';
      onReady();
    } catch (error) {
      panel.dataset.state = 'blocked'; panel.setAttribute('aria-busy', 'false');
      text.textContent = error instanceof Error ? error.message : 'Could not prepare this demo.';
      help.hidden = false;
      button.hidden = !globalThis.isSecureContext || !navigator.serviceWorker || typeof WebAssembly === 'undefined' || !!globalThis.crossOriginIsolated;
      button.disabled = false;
    } finally { running = false; }
  }
  button.addEventListener('click', () => { void start(true); });
  void start();
}
