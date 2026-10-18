#!/usr/bin/env python3
"""Rebuild the failed Stage 7 screen from one exact retained GitHub artifact.

Requires Python 3.11+, Git and Node. Does not install dependencies or download
files. Add --benchmark only to run a new, labelled reproduction of the screen.
The default rebuilds the bytes and checks correctness without new timing runs.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile

ZIP_SHA = 'de53ce15b38b7406ea4a79e4250cc1aa6deb66dcf14fef2fd23ee8c49d7d69c4'
BASE_TREE = 'eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab'
PARENT_TREE = '2d232ae08272b354dffc499d0c6dcbea016caab5'
STAGE_TREE = '0023d7bf7b486747308f369727fd3da18f587988'
SCALAR_SHA = '5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95'
SIMD_SHA = '68318f611fd2fcedd3ba84a1b5bbd704bbc66ada4b9fd038b18056b27cdc4813'
KERNEL_SHA = 'eccfc79c51bc5075160ffbdeae131ecf9ae9275c6f0c04ea7900acfd358373f2'
FLAGS = ['--importMemory', '--sharedMemory', '--initialMemory', '2',
         '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub',
         '--optimizeLevel', '3', '--shrinkLevel', '0']


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str], cwd: Path, output: Path | None = None,
        env: dict[str, str] | None = None, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if output is not None:
        with output.open('x') as stream:
            stream.write(result.stdout)
    if not allow_failure:
        require(result.returncode == 0, f'Command failed ({result.returncode}): {command}\n{result.stdout[-4000:]}')
    return result


def source_tree(directory: Path) -> str:
    run(['git', 'init', '-q'], directory)
    run(['git', 'add', '-f', '.'], directory)
    return run(['git', 'write-tree'], directory).stdout.strip()


def extract_sources(data: bytes, directory: Path) -> None:
    directory.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        # The complete ZIP digest was checked first. Reject unexpected links
        # and traversal as a second check before writing its source archive.
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and '..' not in name.parts, 'Unsafe tar path')
            require(member.isdir() or member.isfile(), 'Unexpected archive link or special file')
        archive.extractall(directory, filter='data')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True, help='Original x64 artifact 12121084431 ZIP')
    parser.add_argument('--output', type=Path, required=True, help='New directory; must not exist')
    parser.add_argument('--node', default='node', help='Node executable; actual version and hash are recorded')
    parser.add_argument('--benchmark', action='store_true', help='Run one full A/A and A/B reproduction; never acceptance')
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    require(sha(artifact) == ZIP_SHA, 'Artifact ZIP digest mismatch')
    node_request = shutil.which(args.node)
    require(node_request is not None, 'Node executable not found')
    node = str(Path(node_request).resolve())
    require(shutil.which('git') is not None, 'Git is required')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    unpacked = output / 'artifact'
    unpacked.mkdir()
    with zipfile.ZipFile(artifact) as archive:
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            require(not name.is_absolute() and '..' not in name.parts, 'Unsafe ZIP path')
            mode = (entry.external_attr >> 16) & 0o170000
            require(mode in (0, 0o040000, 0o100000), 'Unexpected ZIP special file')
        archive.extractall(unpacked)
    baseline, candidate = output / 'baseline', output / 'stage7'
    extract_sources((unpacked / 'baseline-source.tar').read_bytes(), baseline)
    extract_sources((unpacked / 'candidate-source.tar').read_bytes(), candidate)
    require(source_tree(baseline) == BASE_TREE, 'Baseline source tree mismatch')
    require(source_tree(candidate) == PARENT_TREE, 'Parent candidate source tree mismatch')
    kernel = candidate / 'numeric-kernels.as.ts'
    text = kernel.read_text()
    old = '  const treeSize = (size - 1) & ~31;'
    require(text.count(old) == 1, 'Kernel edit anchor mismatch')
    kernel.write_text(text.replace(old,
        '  // A tail-only snapshot needs no tree mask, depth check or root traversal.\n'
        '  // The scalar build retains its original bytes and entry path.\n'
        '  if (ASC_FEATURE_SIMD && size <= 32) return spanCount(tail, size, lo, hi);\n' + old))
    require(sha(kernel) == KERNEL_SHA, 'Stage 7 kernel digest mismatch')
    run(['git', 'add', 'numeric-kernels.as.ts'], candidate)
    tree = run(['git', 'write-tree'], candidate).stdout.strip()
    require(tree == STAGE_TREE, 'Stage 7 source tree mismatch')
    for directory, build in [(baseline, 'baseline-build'), (candidate, 'candidate-build')]:
        shutil.copytree(unpacked / build / 'dist', directory / 'dist')
        for filename in ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm']:
            shutil.copy2(unpacked / build / filename, directory / filename)
    compiler = unpacked / 'compiler-toolkit/node_modules/assemblyscript/bin/asc.js'
    require(compiler.is_file(), 'Retained pinned compiler is missing')
    logs = output / 'logs'
    logs.mkdir()
    for simd in (False, True):
        filename = f"numeric-kernels{'-simd' if simd else ''}.wasm"
        command = [node, str(compiler), 'numeric-kernels.as.ts', '-o', filename, *FLAGS]
        if simd:
            command += ['--enable', 'simd']
        run(command, candidate, logs / f'build-{simd}.txt')
    require(sha(candidate / 'numeric-kernels.wasm') == SCALAR_SHA, 'Scalar bytes changed')
    require(sha(baseline / 'numeric-kernels.wasm') == SCALAR_SHA, 'Wrong baseline scalar bytes')
    require(sha(candidate / 'numeric-kernels-simd.wasm') == SIMD_SHA, 'SIMD build is not reproducible')
    old_literal = base64.b64encode((unpacked / 'candidate-build/numeric-kernels-simd.wasm').read_bytes())
    new_literal = base64.b64encode((candidate / 'numeric-kernels-simd.wasm').read_bytes())
    patched = []
    for path in sorted((candidate / 'dist').glob('*.js')):
        data = path.read_bytes()
        if old_literal in data:
            require(data.count(old_literal) == 1, 'Non-unique SIMD literal')
            path.write_bytes(data.replace(old_literal, new_literal))
            patched.append(path.name)
    require(patched == ['numeric.js'], 'Unexpected portable bundle edit')
    # This source tree intentionally preserves its parent inventory verbatim.
    # That inherited inventory is historical, not the Stage 7 inventory.
    # The independent tree and byte checks above identify the complete variant.
    receipt = {'artifactSha256': ZIP_SHA, 'baselineTree': BASE_TREE, 'parentTree': PARENT_TREE,
               'candidateTree': tree, 'localCommit': None, 'kernelSha256': sha(kernel),
               'scalarSha256': SCALAR_SHA, 'simdSha256': SIMD_SHA,
               'node': run([node, '--version'], output).stdout.strip(), 'nodeSha256': sha(Path(node)),
               'portableBundleEdit': 'one checked SIMD literal in dist/numeric.js; not a native Bun rebuild',
               'historicalInventory': 'The inherited parent manifest does not describe Stage 7; use the exact tree above.',
               'performanceAcceptance': False}
    run([node, '--test', 'proofs/numeric-tree-safety.node.mjs'], candidate, logs / 'safety.txt')
    run([node, 'proofs/numeric-tree-worker.mjs'], candidate, logs / 'worker.txt')
    run([node, '--test', 'proofs/numeric-tree-process.node.mjs', 'proofs/numeric-tree-manifest.node.mjs',
         'proofs/numeric-tree-gate.node.mjs'], candidate, logs / 'parent-harness.txt')
    if args.benchmark:
        results = output / 'results'
        results.mkdir()
        for kind in ['aa', 'ab']:
            env = {**os.environ, 'BASE_DIR': str(baseline), 'CANDIDATE_DIR': str(candidate),
                   'RUNTIME_BIN': node, 'KIND': kind, 'OUT_DIR': str(results / f'node-{kind}')}
            phase = run([node, 'proofs/numeric-tree-size-process.mjs'], candidate,
                        logs / f'node-{kind}.txt', env=env, allow_failure=True)
            (logs / f'node-{kind}.exit').write_text(str(phase.returncode) + '\n')
        receipt['benchmarkNotice'] = 'New reproduction, not replacement of original failed runs; all output retained.'
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
