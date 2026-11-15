import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readRawEvidence } from './raw-evidence.mjs';

const parameters = process.argv.slice(2);
if (parameters.length !== 2) throw new Error('Usage: node archive.mjs SOURCE_STUDY NEW_ARCHIVE_DIRECTORY');
const source = realpathSync(resolve(parameters[0])), destination = resolve(parameters[1]);
if (existsSync(destination)) throw new Error('Archive destination already exists; never overwrite evidence');
if (destination.startsWith(source + sep)) throw new Error('Archive destination must be outside the source study');
if (existsSync(resolve(source, 'archive.json'))) throw new Error('Source is already archived; preserve and use that archive');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = readFileSync(resolve(source, 'manifest.json'));
const completionsBytes = readFileSync(resolve(source, 'completions.json'));
const completions = JSON.parse(completionsBytes);
JSON.parse(manifestBytes);
if (!Array.isArray(completions)) throw new Error('Expected a completion array');

// Validate all raw sources before creating the destination. Earlier failed or
// incomplete studies can be archived; their original status is never changed.
const rawFiles = new Map(), destinations = new Set();
for (const completion of completions) {
  const raw = readRawEvidence(source, completion.file);
  if (hash(raw.bytes) !== completion.sha256) throw new Error(`Raw checksum mismatch: ${completion.file}`);
  const original = relative(source, raw.path), archived = original.endsWith('.gz') ? original : original + '.gz';
  if (rawFiles.has(original) || destinations.has(archived)) throw new Error('Duplicate raw completion filename');
  destinations.add(archived);
  rawFiles.set(original, { ...raw, original, archived, rawSha256: completion.sha256, compressedBytes: gzipSync(raw.bytes, { level: 9 }) });
}
function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Evidence archive refuses symlinks: ${path}`);
    if (entry.isDirectory()) paths.push(...walk(resolve(directory, entry.name), path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Unsupported evidence file: ${path}`);
  }
  return paths.sort();
}
const originals = walk(source);
for (const path of originals) if (!rawFiles.has(path) && destinations.has(path)) throw new Error(`Archive filename collision: ${path}`);
mkdirSync(destination, { recursive: true });
const files = [];
for (const original of originals) {
  const raw = rawFiles.get(original);
  const archived = raw?.archived ?? original, destinationFile = resolve(destination, archived);
  mkdirSync(dirname(destinationFile), { recursive: true });
  if (raw) {
    writeFileSync(destinationFile, raw.compressedBytes, { flag: 'wx' });
    files.push({ original, archived, compression: 'gzip', originalBytes: raw.bytes.length, archivedBytes: raw.compressedBytes.length,
      originalSHA256: raw.rawSha256, archivedSHA256: hash(raw.compressedBytes) });
  } else {
    copyFileSync(resolve(source, original), destinationFile, constants.COPYFILE_EXCL);
    const bytes = readFileSync(destinationFile);
    files.push({ original, archived, compression: 'none', originalBytes: bytes.length, archivedBytes: bytes.length,
      originalSHA256: hash(bytes), archivedSHA256: hash(bytes) });
  }
}
// These metadata files keep their original bytes, commit identities, hashes,
// filenames and medians. Readers resolve a missing .jsonl to its .jsonl.gz copy.
if (!readFileSync(resolve(destination, 'manifest.json')).equals(manifestBytes)
    || !readFileSync(resolve(destination, 'completions.json')).equals(completionsBytes)) throw new Error('Metadata changed during archival');
const archive = { schema: 'zerocopy-standard-get-archive/v1', createdAt: new Date().toISOString(), sourceDirectory: source,
  sourceModified: false, completionChecksums: 'SHA-256 of original uncompressed NDJSON',
  manifestSHA256: hash(manifestBytes), completionsSHA256: hash(completionsBytes), files,
  originalBytes: files.reduce((sum, file) => sum + file.originalBytes, 0), archivedBytes: files.reduce((sum, file) => sum + file.archivedBytes, 0) };
writeFileSync(resolve(destination, 'archive.json'), JSON.stringify(archive, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ destination, rawFiles: rawFiles.size, originalBytes: archive.originalBytes, archivedBytes: archive.archivedBytes, originalsPreserved: true }) + '\n');
