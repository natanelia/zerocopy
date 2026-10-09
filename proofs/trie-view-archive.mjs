// Packaging only: never imports or executes the performance workload.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function archiveEvidence(directory, outputDirectory) {
  // An early failed setup may have no evidence yet. Preserve even that empty state.
  mkdirSync(directory, { recursive: true });
  const source = realpathSync(directory), output = resolve(outputDirectory);
  assert(output !== source && !output.startsWith(source + sep), 'Archive must be outside evidence');
  // A repeated invocation must not replace a previously retained archive.
  mkdirSync(output);
  const name = 'radix-view.tar.gz', archive = join(output, name);
  // Archive the directory itself, not a shell glob: include hidden files and keep
  // every original path (including colons) and file byte inside the portable name.
  execFileSync('tar', ['-czf', archive, '-C', source, '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const checksum = execFileSync('sha256sum', [name], { cwd: output, encoding: 'utf8' });
  writeFileSync(`${archive}.sha256`, checksum, { flag: 'wx' });
  return { archive, checksum: `${archive}.sha256` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: trie-view-archive.mjs <evidence-directory> <new-output-directory>');
  console.log(JSON.stringify(archiveEvidence(process.argv[2], process.argv[3])));
}
