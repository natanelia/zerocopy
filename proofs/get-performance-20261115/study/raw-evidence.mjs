import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Completion checksums always describe original, uncompressed NDJSON bytes. */
export function readRawEvidence(directory, filename) {
  if (typeof filename !== 'string' || isAbsolute(filename) || !/\.jsonl(?:\.gz)?$/.test(filename)) throw new Error('Invalid raw evidence filename');
  const root = resolve(directory), requested = resolve(root, filename);
  if (!requested.startsWith(root + sep)) throw new Error('Raw evidence filename escapes the study directory');
  const path = existsSync(requested) ? requested : !requested.endsWith('.gz') && existsSync(requested + '.gz') ? requested + '.gz' : requested;
  const storedBytes = readFileSync(path), compressed = path.endsWith('.gz');
  return { path, compressed, storedBytes, bytes: compressed ? gunzipSync(storedBytes) : storedBytes };
}
