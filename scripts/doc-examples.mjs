import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Read one named code fence from the documentation, rejecting duplicate markers. */
export function extract(file, name, language) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const marker = `<!-- example: ${name} -->`;
  assert.equal(text.split(marker).length, 2, `${file}: expected one ${name} example`);
  const block = text.slice(text.indexOf(marker) + marker.length).match(/^\s*```(ts|js)\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block && block[1] === language, `${file}: missing ${language} fence after ${name}`);
  return block[2];
}

export const browserExamples = [
  { name: 'readme', file: 'README.md', owner: 'readme-browser-owner', reader: 'readme-browser-reader', expected: 30 },
  { name: 'guide', file: 'docs/worker-sharing.md', owner: 'browser-owner', reader: 'browser-reader', expected: { ok: true, value: 30 } },
];
