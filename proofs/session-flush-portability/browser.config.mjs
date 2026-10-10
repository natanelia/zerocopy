import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
const engine=process.env.SCREEN_BROWSER, arm=process.env.SCREEN_ARM;
if(!['chromium','firefox','webkit'].includes(engine)||!['baseline','candidate'].includes(arm)) throw new Error('Explicit engine and arm required');
export default defineConfig({
  root:new URL(`./arms/${arm}/`,import.meta.url).pathname,
  test:{browser:{enabled:true,provider:playwright({launchOptions:{...(engine==='chromium'?{channel:'chromium'}:{})}}),
    instances:[{browser:engine}],headless:true},include:['demo/sessions.browser.test.ts']},
  server:{headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}
});
