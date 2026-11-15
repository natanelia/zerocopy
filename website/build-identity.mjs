import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Hash the complete copied library, including embedded-Wasm chunks. Hashing
// shared.js alone does not identify the implementation imported by that entry.
export function fileHashes(directory, names) {
  return Object.fromEntries([...names].sort().map(name => [name,
    createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
  ]));
}

function version(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function buildIdentity(root, website, benchmarkFiles) {
  const dist = join(root, 'dist');
  let sourceDirty = null;
  try { sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() !== ''; }
  catch { /* Archive builds still carry their explicitly supplied source SHA. */ }
  return {
    sourceDirty,
    libraryFilesSHA256: fileHashes(dist, readdirSync(dist).filter(name => name.endsWith('.js'))),
    wasmFilesSHA256: fileHashes(root, readdirSync(root).filter(name => name.endsWith('.wasm'))),
    benchmarkFilesSHA256: fileHashes(join(website, 'assets'), benchmarkFiles),
    vendorFilesSHA256: fileHashes(join(website, '_site/vendor'), ['immutable.mjs', 'immer.mjs', 'version.mjs']),
    buildEnvironment: {
      node: process.version,
      bun: version('bun', ['--version']),
      rustCompiler: version('rustc', ['--version']),
      rustToolchain: /channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'))?.[1] ?? null,
    },
  };
}
