/* Automatic, network-only isolation for this demo's path. No cache or telemetry.
 * Server headers are preferred. This fallback lets static hosts serve demos.
 * COOP/COEP: https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
 */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// A second tab can arrive after activation's claim completed. Only an in-scope
// window can request another claim. The browser still enforces control policy.
self.addEventListener('message', event => {
  if (event.data?.type !== 'zerocopy-isolation:claim' || event.data.version !== 1 || event.source?.type !== 'window') return;
  const scope = new URL(self.registration.scope);
  let source;
  try { source = new URL(event.source.url); } catch { return; }
  if (source.origin !== scope.origin || !source.pathname.startsWith(scope.pathname)) return;
  // Failure remains visible in the page's bounded wait for controllerchange.
  event.waitUntil(self.clients.claim().catch(() => {}));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith((async () => {
    // Fetch worker bytes as a same-origin resource. Forwarding the original
    // worker-destination request can make WebKit check its network response
    // before this service worker adds COEP. The final worker response below
    // still receives, and must pass, the browser's isolation policy checks.
    const networkRequest = request.destination === 'worker'
      ? new Request(request.url, {
          method: 'GET', headers: request.headers, mode: 'same-origin',
          credentials: request.credentials, redirect: 'error', cache: 'no-store',
          signal: request.signal,
        })
      : request;
    const response = await fetch(networkRequest);
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  })());
});
