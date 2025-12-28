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
    exclude: ['**/node_modules/**', '**/demo/**'],
  },
});
