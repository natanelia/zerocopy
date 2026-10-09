// Untimed installed-file provenance; the Playwright launcher is not the native engine.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { json, sha256, manifest } from './radix-portability-source.mjs';

export function installedBrowserManifest(executable) {
  const root = dirname(resolve(executable)), files = {}, symlinks = {}, nativeElfFiles = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative(root, path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        const target = realpathSync(path); assert(target.startsWith(root + sep), `External browser symlink: ${name}`);
        symlinks[name] = readlinkSync(path);
      } else {
        assert(entry.isFile()); const bytes = readFileSync(path); files[name] = sha256(bytes);
        if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) nativeElfFiles[name] = files[name];
      }
    }
  }
  visit(root);
  assert(Object.keys(nativeElfFiles).length > 0, 'Missing native WebKit ELF identity');
  const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return { root, launcher: { path: executable, sha256: sha256(readFileSync(executable)) }, files: sorted(files), symlinks: sorted(symlinks), nativeElfFiles: sorted(nativeElfFiles),
    scope: 'Installed Playwright WebKit distribution, including launcher and native ELF files; excludes host system libraries and is not a claim of every dynamically loaded byte.' };
}
export function comparableEngine(identity, browser) {
  const { path: bunPath, ...bun } = identity.bun;
  const { path: controllerPath, ...controller } = identity.controller;
  if (!browser) return { bun, controller };
  const { root, launcher, ...installed } = identity.installed;
  return { bun, controller, playwright: identity.playwright, packages: identity.packages,
    browsersJsonSha256: identity.browsersJsonSha256, revision: identity.revision,
    installed: { ...installed, launcherSha256: launcher.sha256 } };
}
export async function engineIdentity(lane) {
  const bunPath = realpathSync(execFileSync('which', ['bun'], { encoding: 'utf8', timeout: 10000 }).trim());
  assert(lstatSync(bunPath).isFile());
  const bun = { path: bunPath, sha256: sha256(readFileSync(bunPath)), version: execFileSync(bunPath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
    revision: execFileSync(bunPath, ['-e', 'console.log(Bun.revision)'], { encoding: 'utf8', timeout: 10000 }).trim() };
  assert.equal(bun.version, '1.4.2'); assert.equal(bun.revision, '744846f844374847c902b5e7fd59b4342a51ef99');
  const controller = { version: process.versions.node, path: realpathSync(process.execPath), sha256: sha256(readFileSync(process.execPath)) };
  assert.equal(controller.version, '22.23.3');
  if (!lane.browser) return { bun, controller };
  const { webkit } = await import('playwright');
  const playwright = json(new URL('../node_modules/playwright/package.json', import.meta.url)).version;
  const browsersBytes = readFileSync(new URL('../node_modules/playwright-core/browsers.json', import.meta.url));
  const browsersJsonSha256 = sha256(browsersBytes), pins = json(new URL('./radix-portability-pins.json', import.meta.url));
  assert.equal(playwright, '1.63.0'); assert.equal(browsersJsonSha256, pins.playwright.browsersJsonSha256);
  const revision = JSON.parse(browsersBytes).browsers.find(item => item.name === 'webkit');
  assert.equal(revision.revision, '2359'); assert.equal(revision.browserVersion, '26.6');
  const installed = installedBrowserManifest(webkit.executablePath());
  assert.equal(installed.root.split(sep).at(-1), 'webkit-2359');
  const packages = Object.fromEntries(['playwright', 'playwright-core'].map(name => {
    const files = manifest(fileURLToPath(new URL(`../node_modules/${name}/`, import.meta.url)));
    return [name, { sha256: sha256(JSON.stringify(files)), files }];
  }));
  return { bun, controller, playwright, packages, browsersJsonSha256, revision, installed };
}
