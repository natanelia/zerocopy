import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: 'node_modules/.vite',
  test: {
    bundler: 'rolldown',
    pool: 'threads',
    isolate: false,
    fileParallelism: true,
    globals: true,
    testTimeout: 5000,
    teardownTimeout: 1000,
    minWorkers: 1,
    maxWorkers: 4,
    // The website uses node:test against a generated site, in its own CI job.
    // Do not discover those suites before the site's build dependencies exist.
    exclude: ['**/node_modules/**', '**/demo/**', '**/website/**'],
  },
});
