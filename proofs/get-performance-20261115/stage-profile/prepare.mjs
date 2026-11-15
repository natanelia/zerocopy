/**
 * Copy and instrument source without editing its repository or runtime hooks.
 * No build or profile executes unless explicitly requested.
 * node prepare.mjs --repo REPO --harness HARNESS_REPO --out NEW_DIRECTORY
 * Add --build --bun /absolute/path/to/bun to build the diagnostic copy.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flags = new Set(['build', 'allow-dirty']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  assert.ok(token.startsWith('--'), `Unexpected argument: ${token}`);
  const key = token.slice(2);
  args[key] = flags.has(key) ? true : process.argv[++i];
}
for (const key of ['repo', 'harness', 'out']) assert.equal(typeof args[key], 'string', `Missing --${key}`);
const repo = realpathSync(resolve(args.repo)), harness = realpathSync(resolve(args.harness)), destination = resolve(args.out);
assert.ok(!existsSync(destination), 'Output already exists; keep earlier diagnostic evidence');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...parameters) => execFileSync('git', parameters, { cwd: root, encoding: 'utf8' }).trim();
const sourceCommit = git(repo, 'rev-parse', 'HEAD'), harnessCommit = git(harness, 'rev-parse', 'HEAD');
const sourceDirty = git(repo, 'status', '--porcelain', '--untracked-files=no');
const harnessDirty = git(harness, 'status', '--porcelain', '--untracked-files=no');
if (!args['allow-dirty']) {
  assert.equal(sourceDirty, '', 'Source has tracked changes; commit them or explicitly use --allow-dirty');
  assert.equal(harnessDirty, '', 'Harness has tracked changes; pin it or explicitly use --allow-dirty');
}
const harnessNames = ['catalog-core.mjs', 'catalog-reference.mjs', 'catalog-read-workloads.mjs', 'catalog-read-reference.mjs'];
const harnessHashes = Object.fromEntries(harnessNames.map(name => [name, sha(readFileSync(join(harness, 'website/assets', name)))]));
const names = readdirSync(repo).filter(name => (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.startsWith('vitest.') && !name.startsWith('benchmark')) || name.endsWith('.wasm'));
names.push('package.json', 'tsconfig.json', 'rust-toolchain.toml', 'scripts/build-browser.ts');
const sourceHashes = {};
mkdirSync(join(destination, 'scripts'), { recursive: true });
for (const name of names) {
  const bytes = readFileSync(join(repo, name));
  sourceHashes[name] = sha(bytes);
  copyFileSync(join(repo, name), join(destination, name));
}
if (existsSync(join(repo, 'node_modules'))) symlinkSync(realpathSync(join(repo, 'node_modules')), join(destination, 'node_modules'), 'dir');
copyFileSync(join(here, 'stages.ts'), join(destination, 'get-profile-stages.ts'));

function once(source, before, after, label = before.slice(0, 90)) {
  assert.equal(source.split(before).length - 1, 1, `Instrumentation anchor changed: ${label}`);
  return source.replace(before, after);
}
function wrap(source, startMarker, endMarker, stage) {
  assert.equal(source.split(startMarker).length - 1, 1, `Method anchor changed: ${startMarker}`);
  const start = source.indexOf(startMarker), end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end > start, `Missing end anchor: ${endMarker}`);
  const original = source.slice(start, end), open = original.indexOf('{'), close = original.lastIndexOf('}');
  assert.ok(open >= 0 && close > open && original.slice(close + 1).trim() === '', `Unexpected method body: ${stage}`);
  const replaced = `${original.slice(0, open + 1)}\n    const __zcProfileStart = profileStart();\n    try {${original.slice(open + 1, close)}} finally { profileEnd(${JSON.stringify(stage)}, __zcProfileStart); }\n  ${original.slice(close)}`;
  return source.slice(0, start) + replaced + source.slice(end);
}
const instrumentationImport = "import { profileStart, profileEnd, profileCount } from './get-profile-stages';\n";
function patch(name, transform) {
  const original = readFileSync(join(destination, name), 'utf8');
  writeFileSync(join(destination, name), instrumentationImport + transform(original));
}

patch('arena.ts', source => {
  source = once(source, 'if (this.buffer !== this.memory.buffer) {', 'if (this.buffer !== this.memory.buffer) {\n      profileCount("memory.viewRebuilds");');
  source = wrap(source, '  refresh(): void {', '\n  get used():', 'memory.refresh');
  for (const [expression, label] of [['this.objects.get(raw + 4)', 'fromDecode'], ['this.objects.get(ptr)', 'fromDecodeAt']]) {
    const original = `const cached = ${expression};`;
    source = once(source, original, `const __decodedProbe = profileStart();\n    ${original}\n    profileEnd("cache.decoded.${label}", __decodedProbe);\n    profileCount(cached !== undefined ? "cache.decoded.${label}.hit" : "cache.decoded.${label}.miss");`);
  }
  source = once(source, 'const hit = this.objectKeys?.get(key);', 'const __objectProbe = profileStart();\n          const hit = this.objectKeys?.get(key);\n          profileEnd("cache.objectKey.probe", __objectProbe);\n          profileCount(hit !== undefined ? "cache.objectKey.hit" : "cache.objectKey.miss");');
  source = once(source, 'const hit = this.valueMap?.get(key);', 'const __primitiveProbe = profileStart();\n        const hit = this.valueMap?.get(key);\n        profileEnd("cache.primitiveKey.probe", __primitiveProbe);\n        profileCount(hit !== undefined && hit !== PRESENT ? "cache.primitiveKey.hit" : "cache.primitiveKey.miss");');
  source = once(source, 'const parsed = JSON.parse(decodeUtf8(decoder, this.bytes.subarray(ptr, ptr + len)));', `const __utf8Start = profileStart();
    const __jsonText = decodeUtf8(decoder, this.bytes.subarray(ptr, ptr + len));
    profileEnd("json.utf8AndSubview", __utf8Start);
    profileCount("json.payloadBytes", len);
    const __parseStart = profileStart();
    const parsed = JSON.parse(__jsonText);
    profileEnd("json.nativeParse", __parseStart);`);
  source = once(source, 'const nested = parseNestedType(type);\n    let result: any;', 'const __descriptorStart = profileStart();\n    const nested = parseNestedType(type);\n    profileEnd("json.descriptor", __descriptorStart);\n    let result: any;');
  source = once(source, "result = factory.fromWorkerData({ ...parsed.__d, valueType: parsed.__d.valueType ?? parsed.__i }, source);", "const __factoryStart = profileStart();\n      result = factory.fromWorkerData({ ...parsed.__d, valueType: parsed.__d.valueType ?? parsed.__i }, source);\n      profileEnd(\"json.nestedFactory\", __factoryStart);");
  source = once(source, 'if (this.objects.size < 2048 && this.objectBytes + len <= 2097152) { this.objects.set(ptr, result); this.objectBytes += len; }', `const __admissionStart = profileStart();
    if (this.objects.size < 2048 && this.objectBytes + len <= 2097152) {
      this.objects.set(ptr, result); this.objectBytes += len;
      profileCount("cache.decoded.admitted"); profileCount("cache.decoded.admittedSerializedBytes", len);
    } else profileCount("cache.decoded.notAdmitted");
    profileEnd("cache.decoded.admission", __admissionStart);`);
  source = once(source, 'const leaf = this.findUncached(root, key);\n    if (!leaf) return undefined;\n    const ascii = this.lastReadAscii, view = this.dv;', 'const leaf = this.findUncached(root, key);\n    if (!leaf) return undefined;\n    const __headerStart = profileStart();\n    const ascii = this.lastReadAscii, view = this.dv;');
  source = once(source, 'const value = this.leafValue(type, leaf, prefix, view);\n    // The address cache', 'profileEnd("map.objectHeader", __headerStart);\n    const value = this.leafValue(type, leaf, prefix, view);\n    const __objectAdmissionStart = profileStart();\n    // The address cache');
  source = once(source, 'map.set(cacheKey, value);', 'map.set(cacheKey, value);\n          profileCount("cache.objectKey.set");');
  source = once(source, '    return value;\n  }\n  private readPrimitive(', '    profileEnd("cache.objectKey.admissionAndConfirm", __objectAdmissionStart);\n    return value;\n  }\n  private readPrimitive(');
  source = once(source, 'private findUncached(root: number, key: string): number {\n    let hash', 'private findUncached(root: number, key: string): number {\n    const __keyStart = profileStart();\n    let hash');
  source = once(source, 'this.lastReadAscii = !encoded;', 'this.lastReadAscii = !encoded;\n    profileEnd("lookup.keyHashAndEncoding", __keyStart);\n    profileCount(encoded ? "lookup.nonAsciiKeys" : "lookup.asciiKeys");');
  source = once(source, 'const length = encoded?.length ?? key.length, view = this.dv, bytes = this.bytes;', 'const length = encoded?.length ?? key.length, view = this.dv, bytes = this.bytes;\n    profileCount("lookup.keyBytes", length);');
  source = once(source, '    let candidate: number;', '    const __traversalStart = profileStart();\n    let candidate: number;');
  source = once(source, '    if (!candidate) return 0;', '    profileEnd("lookup.prefixAndWasmCandidate", __traversalStart);\n    if (!candidate) { profileCount("lookup.noCandidate"); return 0; }\n    const __collisionStart = profileStart();\n    try {');
  source = once(source, '    return 0;\n  }\n\n  delete(root:', '    return 0;\n    } finally { profileEnd("lookup.fullKeyVerification", __collisionStart); }\n  }\n\n  delete(root:');
  source = wrap(source, '  private findUncached(root:', '\n\n  delete(root:', 'lookup.findUncached');
  source = wrap(source, '  find(root:', '\n  private findUncached(root:', 'lookup.findWithLeafCache');
  source = wrap(source, '  private readObject(root:', '\n  private readPrimitive(root:', 'map.readObject');
  source = wrap(source, '  value(root:', '\n  private readObject(root:', 'arena.valueDispatchInclusive');
  source = wrap(source, '  leafValue(type:', '\n  sameValue(root:', 'arena.leafValueInclusive');
  source = wrap(source, '  decodeAt(type:', '\n  string(ptr:', 'arena.decodeAt');
  source = wrap(source, '  decode(type:', '\n  decodeAt(type:', 'arena.decode');
  return source;
});

patch('freeze-json.ts', source => {
  source = once(source, 'if (Array.isArray(item)) {', 'if (Array.isArray(item)) {\n      profileCount("freeze.arrays"); profileCount("freeze.arrayElements", item.length);');
  source = once(source, 'for (const child of Object.values(item)) {', 'const __valuesStart = profileStart();\n      const __values = Object.values(item);\n      profileEnd("freeze.objectValues", __valuesStart);\n      profileCount("freeze.objects"); profileCount("freeze.objectProperties", __values.length);\n      for (const child of __values) {');
  source = once(source, 'Object.freeze(item);', 'const __nativeFreezeStart = profileStart();\n    Object.freeze(item);\n    profileEnd("freeze.nativeObjectFreeze", __nativeFreezeStart);');
  return wrap(source, 'export function freezeJSON<T>', undefined, 'freeze.traversalInclusive');
});

patch('utf8.ts', source => {
  source = once(source, 'const input = bytes.slice();', 'const __copyStart = profileStart();\n    const input = bytes.slice();\n    profileEnd("utf8.independentCopy", __copyStart);\n    profileCount("utf8.independentCopiedBytes", bytes.length);');
  source = once(source, 'scratch.set(bytes);', 'const __copyStart = profileStart();\n    scratch.set(bytes);\n    profileEnd("utf8.scratchCopy", __copyStart);\n    profileCount("utf8.scratchCopiedBytes", bytes.length);');
  source = once(source, 'return decoder.decode(input);', 'const __decodeStart = profileStart();\n    try { return decoder.decode(input); } finally { profileEnd("utf8.decoderCallInclusive", __decodeStart); }');
  source = once(source, 'return Reflect.apply(decode, decoder, [decode === nativeDecode ? input : input.slice()]);', 'const __decodeStart = profileStart();\n    try { return Reflect.apply(decode, decoder, [decode === nativeDecode ? input : input.slice()]); } finally { profileEnd("utf8.decoderCallInclusive", __decodeStart); }');
  source = once(source, 'return decoder.decode(bytes);', 'const __decodeStart = profileStart();\n  try { return decoder.decode(bytes); } finally { profileEnd("utf8.decoderCallInclusive", __decodeStart); }');
  source = wrap(source, 'function decodeSharedUtf8(', '\n\nexport function decodeUtf8(', 'utf8.sharedFallback');
  source = once(source, 'export function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {', 'export function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {\n  profileCount("utf8.requestBytes", bytes.length);\n  profileCount(bytes.buffer instanceof SharedArrayBuffer ? "utf8.sharedRequests" : "utf8.ordinaryRequests");');
  return wrap(source, 'export function decodeUtf8(', '\n\nconst supportsEncodeInto', 'utf8.totalInclusive');
});

patch('read-cache.ts', source => once(source,
  'slot(key: string): number | undefined { return this.slots.get(key); }',
  'slot(key: string): number | undefined { const started = profileStart(); const value = this.slots.get(key); profileEnd("cache.leafSlot.probe", started); profileCount(value === undefined ? "cache.leafSlot.miss" : "cache.leafSlot.hit"); return value; }'));
patch('shared-map.ts', source => once(source,
  'get(key: string): ValueOf<T> | undefined { return this.arena.value(this.root, key, this.valueType); }',
  'get(key: string): ValueOf<T> | undefined { const started = profileStart(); try { return this.arena.value(this.root, key, this.valueType); } finally { profileEnd("api.SharedMap.get", started); } }'));
patch('shared-list.ts', source => wrap(source, '  get(index: number):', '\n  /** Read selected JSON', 'api.SharedList.get'));

const changed = ['arena.ts', 'freeze-json.ts', 'utf8.ts', 'read-cache.ts', 'shared-map.ts', 'shared-list.ts', 'get-profile-stages.ts'];
const manifest = {
  schema: 'zerocopy-get-stage-profile-source/v1', createdAt: new Date().toISOString(), diagnosticOnly: true,
  source: { repo, commit: sourceCommit, trackedDirtyStatus: sourceDirty, sha256: sourceHashes },
  harness: { repo: harness, commit: harnessCommit, trackedDirtyStatus: harnessDirty, sha256: harnessHashes },
  instrumentation: { files: changed, sha256: Object.fromEntries(changed.map(name => [name, sha(readFileSync(join(destination, name)))])),
    mechanism: 'Source-level timers/counters in a separate copied build. No decoder or prototype-method replacement. Native JSON.parse and the original freeze traversal are retained. Every reported time is inclusive; named stages do not cover all bookkeeping or instrumentation overhead.',
    warning: 'Instrumentation changes code layout, allocation, JIT behavior and timing. Stages are nested inclusive timings and MUST NOT be summed or interpreted as uninstrumented costs. No speedup claims.' },
  build: { requested: !!args.build, success: false },
};
writeFileSync(join(destination, 'profile-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (args.build) {
  assert.equal(typeof args.bun, 'string', '--build requires an explicit --bun executable');
  try {
    manifest.build.bun = execFileSync(args.bun, ['--version'], { encoding: 'utf8' }).trim();
    const log = execFileSync(args.bun, ['scripts/build-browser.ts'], { cwd: destination, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(destination, 'profile-build.log'), log);
    manifest.build.success = true;
    manifest.build.sha256 = Object.fromEntries(readdirSync(join(destination, 'dist')).filter(name => name.endsWith('.js')).map(name => [name, sha(readFileSync(join(destination, 'dist', name)))]));
  } catch (error) {
    manifest.build.failure = { message: error.message, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    process.exitCode = 1;
  } finally { writeFileSync(join(destination, 'profile-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); }
}
console.log(JSON.stringify({ destination, sourceCommit, harnessCommit, built: manifest.build.success, diagnosticOnly: true }));
