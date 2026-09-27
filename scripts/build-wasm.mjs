import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'shared-runtime.as.ts', '-o', 'persistent-core.wasm', ...flags], { stdio: 'inherit' });
// Keep legacy filenames for direct WASM reader examples. The current implementation is shared.
for (const name of ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue']) copyFileSync('persistent-core.wasm', `${name}.wasm`);
// Geometry is optional. Keep its feature detection and code out of the core.
for (const simd of [false, true]) {
  const name = `geometry-kernels${simd ? '-simd' : ''}`;
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'geometry-kernels.as.ts', '-o', `${name}.wasm`, '--textFile', `${name}.wat`, ...flags, ...(simd ? ['--enable', 'simd'] : [])], { stdio: 'inherit' });
}
