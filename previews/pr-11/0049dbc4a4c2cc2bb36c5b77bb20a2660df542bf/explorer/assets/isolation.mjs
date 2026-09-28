/** Browser setup for the website demos, not part of the collection library.
 * Server COOP/COEP headers take the zero-registration, zero-reload path.
 * Static hosts get one automatic, demo-scoped service-worker navigation.
 */
export const ATTEMPT_PARAMETER = '__zerocopy_isolation';

function canHandleNavigation(worker, url) {
  return worker?.scriptURL === url.href &&
    (worker.state === 'activating' || worker.state === 'activated');
}
function hasControl(container, url) {
  return canHandleNavigation(container.controller, url);
}

/** Wait for a matching active registration, not a claim on this old document.
 * An active service worker handles the next in-scope navigation. Some WebKit
 * tabs can keep an old 'activating' state after a concurrent install. An active
 * slot is already eligible for navigation; the browser's Handle Fetch algorithm
 * waits for activation before dispatch. Do not duplicate that wait in the old
 * document. Installing/waiting slots are not eligible. Only the new document's
 * crossOriginIsolated is success, not an active registration or controller.
 * https://w3c.github.io/ServiceWorker/#on-fetch-request
 */
function waitForActive(environment, url, scope, timeoutMs) {
  const container = environment.navigator.serviceWorker;
  if (hasControl(container, url)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false, registration, refreshTimer;
    const watched = new Set();
    const cleanup = () => {
      environment.clearTimeout(timer);
      if (refreshTimer !== undefined) environment.clearTimeout(refreshTimer);
      container.removeEventListener('controllerchange', check);
      registration?.removeEventListener('updatefound', check);
      for (const worker of watched) worker.removeEventListener('statechange', changed);
    };
    const finish = error => {
      if (finished) return;
      finished = true; cleanup();
      error ? reject(error) : resolve();
    };
    const watch = worker => {
      if (!worker || watched.has(worker)) return;
      watched.add(worker); worker.addEventListener('statechange', changed);
    };
    function check() {
      if (finished) return;
      if (hasControl(container, url)) { finish(); return; }
      const workers = [registration?.installing, registration?.waiting, registration?.active];
      if (workers.some(worker => worker && worker.state !== 'redundant') &&
          !workers.some(worker => worker?.scriptURL === url.href && worker.state !== 'redundant')) {
        finish(new Error('The browser returned an unexpected demo registration.')); return;
      }
      if (container.controller?.scriptURL === url.href) watch(container.controller);
      for (const worker of workers) if (worker?.scriptURL === url.href) watch(worker);
      const active = registration?.active;
      if (canHandleNavigation(active, url)) finish();
    }
    function adopt(value, allowEmpty = false) {
      const workers = [value?.installing, value?.waiting, value?.active];
      const empty = workers.every(worker => !worker);
      if (finished || value?.scope !== scope.href ||
          !(allowEmpty && empty) &&
          !workers.some(worker => worker?.scriptURL === url.href && worker.state !== 'redundant')) return false;
      registration?.removeEventListener('updatefound', check);
      registration = value; registration.addEventListener('updatefound', check); check();
      return true;
    }
    function refresh() {
      if (finished || refreshTimer !== undefined || typeof container.getRegistration !== 'function') return;
      // During concurrent installation WebKit can return an exact-scope
      // registration before its worker slots are populated. Events remain the
      // fast path. Refresh the registration until the same bounded deadline in
      // case another process updates a different registration wrapper.
      refreshTimer = environment.setTimeout(async () => {
        const value = await existingRegistration();
        environment.clearTimeout(refreshTimer); refreshTimer = undefined;
        if (finished) return;
        if (value?.scope === scope.href) {
          if (!adopt(value, true)) { finish(new Error('The browser returned an unexpected demo registration.')); return; }
        }
        check(); refresh();
      }, 100);
    }
    async function existingRegistration() {
      // getRegistration can return a broader-scope worker. adopt requires an
      // exact scope and script match, and never removes another registration.
      try { return await container.getRegistration(scope.href); }
      catch { return undefined; }
    }
    function changed(event) {
      check();
      // Another tab can replace an installing worker. Wait for a live successor.
      if (!finished && event.target.state === 'redundant' && registration &&
          ![registration.installing, registration.waiting, registration.active].some(worker => worker && worker.state !== 'redundant')) {
        finish(new Error('The browser could not install the demo setup.'));
      }
    }
    const timer = environment.setTimeout(() => finish(new Error('Demo setup timed out. Check your connection and try again.')), timeoutMs);
    container.addEventListener('controllerchange', check);
    // Reuse another tab's installation before starting a competing job. A
    // rejected job may still have a matching installation created by that tab.
    // Recheck once on failure; do not retry arbitrary policy or network errors.
    Promise.resolve().then(async () => {
      const existing = await existingRegistration();
      if (finished) return;
      if (adopt(existing)) { refresh(); return; }
      const value = await container.register(url, { scope: scope.href, updateViaCache: 'none' });
      // A successful register() may return before updatefound fills the slots.
      // An empty registration is not success: only a matching active worker
      // permits navigation, and the new page still checks crossOriginIsolated.
      if (!finished && !adopt(value, true)) throw new Error('The browser returned an unexpected demo registration.');
      refresh();
    }).catch(async error => {
      if (finished) return;
      check();
      if (finished) return;
      const existing = await existingRegistration();
      if (finished) return;
      if (adopt(existing)) refresh(); else finish(error);
    });
    check();
  });
}

/** Returns "ready" or "reloading"; rejects without enabling the demo on failure.
 * The URL marker survives navigation even when storage APIs are blocked. It is
 * removed after success. Its presence prevents a second automatic navigation.
 * Only an explicit retry may start another attempt. No cookies or storage used.
 */
export async function prepareIsolation({
  environment = globalThis,
  workerURL = new URL('../isolation-sw.js', import.meta.url),
  timeoutMs = 12000,
  retry = false,
} = {}) {
  const page = new URL(environment.location.href);
  if (!environment.isSecureContext) throw new Error('Open this demo over HTTPS or localhost.');
  if (typeof environment.WebAssembly === 'undefined') throw new Error('This browser does not support WebAssembly.');
  if (environment.crossOriginIsolated) {
    if (typeof environment.SharedArrayBuffer === 'undefined') throw new Error('Shared memory is disabled in this browser.');
    if (page.searchParams.has(ATTEMPT_PARAMETER)) {
      page.searchParams.delete(ATTEMPT_PARAMETER);
      try { environment.history.replaceState(environment.history.state, '', page.href); } catch { /* URL cleanup must not block a working demo. */ }
    }
    return 'ready';
  }
  if (!environment.navigator?.serviceWorker) throw new Error('This browser blocks automatic demo setup. Open it in a browser with service workers, or use a host with COOP/COEP headers.');
  if (page.searchParams.has(ATTEMPT_PARAMETER) && !retry) throw new Error('Shared memory is still unavailable after setup. Automatic reloads have stopped.');
  const url = new URL(workerURL), scope = new URL('./', url);
  if (url.origin !== page.origin || !page.pathname.startsWith(scope.pathname)) throw new Error('The setup worker must be inside this demo’s origin and path.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The setup timeout must be positive.');
  await waitForActive(environment, url, scope, timeoutMs);
  // Preserve current search and fragment, even if they changed while installing.
  const target = new URL(environment.location.href);
  if (target.origin !== page.origin || target.pathname !== page.pathname) throw new Error('The page changed during setup. Open the demo again.');
  // Toggle on explicit retry so replace() navigates even with an unchanged hash.
  target.searchParams.set(ATTEMPT_PARAMETER, target.searchParams.get(ATTEMPT_PARAMETER) === '1' ? '2' : '1');
  environment.location.replace(target.href);
  return 'reloading';
}
