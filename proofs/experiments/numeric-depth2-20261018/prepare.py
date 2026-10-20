#!/usr/bin/env python3
"""Rebuild sealed kernels with the archived compiler. Prepare a public JS overlay.

Usage: python3 prepare.py FIXED_INPUT_ZIP RESTORED_EVIDENCE NEW_OUTPUT_DIRECTORY
No install, network, performance run, dependency change or Git mutation.
"""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from restore import require, digest

ZIP_SHA256 = 'c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb'

def prepare(input_zip, evidence, output):
    require(digest(input_zip.read_bytes()) == ZIP_SHA256, 'wrong archived compiler input')
    require(not output.exists(), 'output already exists')
    manifest_data = (evidence / 'EVIDENCE-MANIFEST.json').read_bytes()
    require(digest(manifest_data) == 'c275267e766ddcc4bfa5c040e0d2023e10eb82658aba7dc5e86427389e270b23', 'wrong evidence manifest')
    manifest = json.loads(manifest_data)
    for name, identity in manifest.items():
        data = (evidence / name).read_bytes()
        require(digest(data) == identity['sha256'] and len(data) == identity['bytes'], 'retained input changed')
    output.mkdir(parents=True)
    with zipfile.ZipFile(input_zip) as archive:
        for info in archive.infolist():
            if not info.filename.startswith(('compiler-toolkit/', 'candidate-build/')) or info.is_dir():
                continue
            path = PurePosixPath(info.filename)
            require(not path.is_absolute() and '..' not in path.parts, 'unsafe ZIP path')
            target = output / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as out:
                out.write(archive.read(info))
    toolkit = output / 'compiler-toolkit'
    compiler = json.loads((toolkit / 'manifest.json').read_text())
    require(compiler['compiler'] == '0.28.20', 'wrong compiler version')
    for name, identity in compiler['files'].items():
        data = (toolkit / name).read_bytes()
        require(digest(data) == identity['sha256'] and len(data) == identity['bytes'], 'compiler file changed')
    shutil.copyfile(evidence / 'numeric-spatial.as.ts', output / 'numeric-spatial.as.ts')
    compiled = {}
    for stage, source in ((10, 'baseline.as.ts'), (13, 'stage13.as.ts'), (14, 'stage14.as.ts')):
        shutil.copyfile(evidence / source, output / 'numeric-kernels.as.ts')
        for mode in ('scalar', 'simd'):
            name = f'stage{stage}-{mode}.wasm'
            args = ['node', str(toolkit / 'node_modules/assemblyscript/bin/asc.js'), 'numeric-kernels.as.ts', '-o', str(output / name),
                    '--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads',
                    '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0']
            if mode == 'simd':
                args += ['--enable', 'simd']
            subprocess.run(args, cwd=output, check=True)
            compiled[name] = digest((output / name).read_bytes())
            require(compiled[name] == manifest[name]['sha256'], f'compiled bytes differ: {name}')
    overlay = output / 'candidate-build'
    old = (overlay / 'numeric-kernels-simd.wasm').read_bytes()
    new = (evidence / 'stage14-simd.wasm').read_bytes()
    bundle = overlay / 'dist/numeric.js'
    before = bundle.read_bytes()
    require(before.count(base64.b64encode(old)) == 1, 'ambiguous bundle replacement')
    after = before.replace(base64.b64encode(old), base64.b64encode(new))
    bundle.write_bytes(after)
    (overlay / 'numeric-kernels-simd.wasm').write_bytes(new)
    report = {'inputZipSha256': ZIP_SHA256, 'compiler': compiler['compiler'], 'compiled': compiled,
              'overlayBefore': digest(before), 'overlayAfter': digest(after), 'replacedLiterals': 1,
              'limit': 'Archived public JavaScript with one checked SIMD literal replaced; not a fresh Bun bundle or a performance test.'}
    (output / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    prepare(*(Path(x).resolve() for x in sys.argv[1:]))
