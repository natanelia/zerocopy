/** Enable demos only after a real capability check; never silently copy instead. */
export function checkCapability(onReady) {
  const panel = document.querySelector('#capability');
  const text = document.querySelector('#capability-text');
  const button = document.querySelector('#enable-isolation');
  if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && typeof WebAssembly !== 'undefined') {
    text.textContent = 'Shared memory is available. This demo runs locally.';
    panel.dataset.state = 'ready'; onReady(); return;
  }
  panel.dataset.state = 'blocked';
  text.textContent = 'Shared memory needs a secure, cross-origin-isolated page.';
  document.querySelector('#capability-help').hidden = false;
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator)) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true; text.textContent = 'Enabling isolation for this demo…';
    try {
      const registration = await navigator.serviceWorker.register(new URL('isolation-sw.js', location.href), { scope: './' });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (!worker) throw new Error('No service worker was installed');
      if (worker.state !== 'activated') await new Promise((resolve, reject) => {
        const clean = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
        const changed = () => {
          if (worker.state === 'activated') { clean(); resolve(); }
          else if (worker.state === 'redundant') { clean(); reject(new Error('Service worker installation failed')); }
        };
        const timer = setTimeout(() => { clean(); reject(new Error('Service worker activation timed out')); }, 10000);
        worker.addEventListener('statechange', changed); changed();
      });
      // This explicit user action causes one reload. There is no reload loop.
      location.reload();
    } catch (error) {
      text.textContent = `Could not enable shared memory: ${error.message}. Use a host with COOP/COEP headers.`;
      button.disabled = false;
    }
  });
}
