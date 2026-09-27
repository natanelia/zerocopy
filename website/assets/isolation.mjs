/** Browser setup for the website demos, not part of the collection library.
 * Server COOP/COEP headers take the zero-registration, zero-reload path.
 * Static hosts get one automatic, demo-scoped service-worker navigation.
 */
export const ATTEMPT_PARAMETER = '__zerocopy_isolation';

function hasControl(container, url) {
  return container.controller?.scriptURL === url.href && container.controller.state === 'activated';
}

/** Registration, installation, activation AND claim share one bounded deadline. */
function waitForControl(environment, url, scope, timeoutMs) {
  const container = environment.navigator.serviceWorker;
  if (hasControl(container, url)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false, registration;
    const watched = new Set();
    const cleanup = () => {
      environment.clearTimeout(timer);
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
      watch(container.controller);
      watch(registration?.installing); watch(registration?.waiting); watch(registration?.active);
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
    // Also catches synchronous policy errors. Ignore a late registration after timeout.
    Promise.resolve().then(() => container.register(url, { scope: scope.href, updateViaCache: 'none' })).then(value => {
      if (finished) return;
      registration = value; registration.addEventListener('updatefound', check); check();
    }).catch(finish);
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
  await waitForControl(environment, url, scope, timeoutMs);
  // Preserve current search and fragment, even if they changed while installing.
  const target = new URL(environment.location.href);
  if (target.origin !== page.origin || target.pathname !== page.pathname) throw new Error('The page changed during setup. Open the demo again.');
  // Toggle on explicit retry so replace() navigates even with an unchanged hash.
  target.searchParams.set(ATTEMPT_PARAMETER, target.searchParams.get(ATTEMPT_PARAMETER) === '1' ? '2' : '1');
  environment.location.replace(target.href);
  return 'reloading';
}
