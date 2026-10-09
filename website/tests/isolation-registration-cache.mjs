// Model WebKit's registration-wrapper cache during another tab's install.
// The first lookup can snapshot a registration before it has any workers;
// later API results reuse that wrapper even when their server data is newer.
// Installation, navigation and crossOriginIsolated still use the real browser.
export function cacheEarlyRegistration() {
  // Apply only to the two demo documents under test. A fresh homepage document
  // in the same browser context must retain native APIs for server-state checks.
  if (!location.pathname.endsWith('/compare/')) return;
  const container = navigator.serviceWorker;
  const register = container.register.bind(container);
  const getRegistration = container.getRegistration.bind(container);
  const ready = container.ready;
  let started = false, cached;
  container.getRegistration = async scope => {
    if (!started) cached ??= Object.assign(new EventTarget(), {
      scope: new URL(scope, location.href).href,
      installing: null, waiting: null, active: null,
    });
    return cached ?? await getRegistration(scope);
  };
  container.register = async (...args) => {
    started = true;
    const registration = await register(...args);
    return cached ?? registration;
  };
  Object.defineProperty(container, 'ready', { get: () => ready.then(value => cached ?? value) });
}
