import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.ts';
export default mergeConfig(base, { cacheDir: '.vitest-callback-cache' });
