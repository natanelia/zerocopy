import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture, sourcePaths, sha256, manifest } from '../worker-arena-source-guard.mjs';
import { treeManifest } from './package-tools.mjs';

export const config = JSON.parse(readFileSync(new URL('./preflight.json', import.meta.url)));
const git = (root, args, bytes = false) => execFileSync('git', args, { cwd: root, encoding: bytes ? undefined : 'utf8' });
export function expectedCleanupArena(old) {
  const declaration = '  private dependencyLookup = new Map<string, Arena>();';
  const assignment = '    if (this.readOnly && options.registry) this.dependencyLookup = options.registry.arenas;';
  assert.equal(old.split(declaration).length, 2, 'Original declaration must match exactly once');
  assert.equal(old.split(assignment).length, 2, 'Original assignment must match exactly once');
  return old.replace(declaration, '  private dependencyLookup: Map<string, Arena>;')
    .replace(assignment, '    this.dependencyLookup = this.readOnly && options.registry ? options.registry.arenas : new Map<string, Arena>();');
}
export function verifyPrimaryBytes(proofRoot) {
  const expected = git(proofRoot, ['show', config.pins.originalProof + ':' + config.pins.originalSubjectPath], true);
  const actual = readFileSync(join(proofRoot, 'proofs/registry-single-initialization/original-subject.mjs'));
  assert.deepEqual(actual, expected, 'Entire focused historical subject must be byte-identical');
  const blob = git(proofRoot, ['rev-parse', config.pins.originalProof + ':' + config.pins.originalSubjectPath]).trim();
  assert.equal(blob, config.pins.originalSubjectBlob);
  return { blob, sha256: sha256(actual), bytes: actual.length };
}
export function verifyTrackedSources(roots) {
  for (const role of config.variants) {
    assert.equal(git(roots[role], ['rev-parse', 'HEAD']).trim(), config.pins[role]);
    const paths = sourcePaths(roots[role]).filter(p => !p.endsWith('.wasm'));
    assert.equal(git(roots[role], ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths]).trim(), '', role + ' tracked source dirty');
    for (const path of paths) assert.deepEqual(readFileSync(join(roots[role], path)), git(roots[role], ['show', config.pins[role] + ':' + path], true), role + ':' + path);
  }
  const paths = [...new Set(Object.values(roots).flatMap(sourcePaths))].filter(p => !p.endsWith('.wasm')).sort();
  const changes = (a, b) => paths.filter(p => !readFileSync(join(roots[a], p)).equals(readFileSync(join(roots[b], p))));
  assert.deepEqual(changes('main', 'old'), ['arena.ts', 'shared.ts']);
  assert.deepEqual(changes('old', 'cleanup'), ['arena.ts']);
  const old = readFileSync(join(roots.old, 'arena.ts'), 'utf8');
  assert.equal(readFileSync(join(roots.cleanup, 'arena.ts'), 'utf8'), expectedCleanupArena(old), 'Cleanup must be precisely the two declared substitutions');
  return { mainOld: ['arena.ts', 'shared.ts'], oldCleanup: ['arena.ts'], exactCleanupSubstitutions: 2 };
}
export function captureBuilds(roots) {
  verifyTrackedSources(roots);
  const paths = [...new Set(Object.values(roots).flatMap(sourcePaths))].sort();
  const states = {};
  for (const role of config.variants) {
    const state = capture(roots[role], paths);
    assert.equal(state.sourceDirty, false);
    if (role !== 'cleanup') {
      assert.equal(state.source.sha256, config.pins.source[role], role + ' historical source/WASM digest mismatch');
      assert.equal(state.build.sha256, config.pins.build[role], role + ' historical emitted JS digest mismatch');
    }
    state.wasm = manifest(roots[role], paths.filter(p => p.endsWith('.wasm')));
    state.completeDist = treeManifest(join(roots[role], 'dist'));
    states[role] = state;
  }
  assert.deepEqual(states.old.wasm, states.main.wasm, 'Main/old WASM must be identical');
  assert.deepEqual(states.cleanup.wasm, states.main.wasm, 'Cleanup WASM must be identical');
  return states;
}
