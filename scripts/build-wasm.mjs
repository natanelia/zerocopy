import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'shared-runtime.as.ts', '-o', 'persistent-core.wasm', ...flags], { stdio: 'inherit' });
// Keep legacy filenames for direct WASM reader examples. The current implementation is shared.
for (const name of ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue']) copyFileSync('persistent-core.wasm', `${name}.wasm`);
