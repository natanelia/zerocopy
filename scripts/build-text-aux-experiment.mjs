import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Experimental scalar auxiliary control: identical loader and module contract,
// with the old detector. It is not a replacement for the scalar core fallback.
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
for (const arm of ['scalar', 'simd']) {
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'text-aux-reader.as.ts', '-o', `text-aux-${arm}.wasm`, '--textFile', `text-aux-${arm}.wat`, ...flags, ...(arm === 'simd' ? ['--enable', 'simd'] : [])], { stdio: 'inherit' });
}
mkdirSync('build/text-aux-experiment', { recursive: true });
execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'shared-text-reader.as.ts', '-o', 'build/text-aux-experiment/original-reader.wasm', ...flags], { stdio: 'inherit' });
