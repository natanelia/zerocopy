/* Opt-in, network-only isolation for this demo's path. No cache or telemetry.
 * Server headers are preferred. This fallback lets static hosts serve demos.
 * COOP/COEP: https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
 */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
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
