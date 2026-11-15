/** Build inputs and compiler identity for new recordings of either engine. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = root => root instanceof URL ? fileURLToPath(root) : resolve(root);

export function kernelSourceFiles(root) {
  root = directory(root);
  const files = ['package.json'];
  if (existsSync(join(root, 'scripts/build-wasm.mjs'))) files.push('scripts/build-wasm.mjs');
  if (existsSync(join(root, 'scripts/rust-wasm.mjs'))) files.push('scripts/rust-wasm.mjs');
  if (existsSync(join(root, 'rust/Cargo.toml'))) {
    files.push('rust-toolchain.toml', 'rust/Cargo.toml');
    if (existsSync(join(root, 'rust/Cargo.lock'))) files.push('rust/Cargo.lock');
    if (existsSync(join(root, 'rust/wasm-abi.json'))) files.push('rust/wasm-abi.json');
    const walk = relative => {
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path);
      }
    };
    walk('rust/src');
  } else {
    files.push(...readdirSync(root).filter(file => file.endsWith('.as.ts')));
  }
  return [...new Set(files)].sort();
}

export function withKernelSources(root, files) {
  return [...new Set([...files, ...kernelSourceFiles(root)])].sort();
}

export function kernelCompiler(root) {
  root = directory(root);
  if (existsSync(join(root, 'rust/Cargo.toml'))) {
    const config = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8');
    const version = /^channel\s*=\s*"([^"\n]+)"/m.exec(config)?.[1];
    if (!version) throw new Error('Missing pinned Rust compiler');
    return {
      language: 'Rust', version, target: 'wasm32-unknown-unknown',
      binaryen: JSON.parse(readFileSync(join(root, 'node_modules/binaryen/package.json'), 'utf8')).version,
    };
  }
  return {
    language: 'AssemblyScript',
    version: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'), 'utf8')).version,
  };
}
