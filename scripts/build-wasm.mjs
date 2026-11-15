import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { finishRustModule } from './rust-wasm.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const abi = JSON.parse(readFileSync(new URL('../rust/wasm-abi.json', import.meta.url), 'utf8'));
const flags = [
  '-C', 'target-feature=+atomics,+bulk-memory,-simd128',
  '-C', 'link-arg=--import-memory', '-C', 'link-arg=--export-memory',
  '-C', 'link-arg=--shared-memory', '-C', 'link-arg=--initial-memory=131072',
  '-C', 'link-arg=--max-memory=4294967296', '-C', 'link-arg=--global-base=65536',
  '-C', 'link-arg=-zstack-size=0',
];
const targets = [
  ['persistent-core', 'collections,json-views', false],
  ['numeric-kernels', 'numeric', false],
  ['numeric-kernels-simd', 'numeric', true],
  ['geometry-kernels', 'geometry', false],
];
for (const [name, features, simd] of targets) {
  const targetDir = resolve(root, 'rust/target', name);
  execFileSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--release',
    '--target', 'wasm32-unknown-unknown', '--no-default-features', '--features', features], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: targetDir,
      CARGO_ENCODED_RUSTFLAGS: flags.map(arg => simd ? arg.replace('-simd128', '+simd128') : arg).join('\x1f') },
  });
  const raw = readFileSync(resolve(targetDir, 'wasm32-unknown-unknown/release/zerocopy_kernels.wasm'));
  const result = finishRustModule(raw, abi[name]);
  writeFileSync(resolve(root, `${name}.wasm`), result.binary);
  if (name === 'geometry-kernels') writeFileSync(resolve(root, `${name}.wat`), result.text);
  writeFileSync(resolve(targetDir, 'audit.json'), `${JSON.stringify(result.audit, null, 2)}\n`);
  console.log(`${name}.wasm: ${result.binary.length} bytes; ${result.audit.readOnlyFunctions} audited reader functions; no linear stack or data segments`);
}
for (const name of ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue']) {
  copyFileSync(resolve(root, 'persistent-core.wasm'), resolve(root, `${name}.wasm`));
}
