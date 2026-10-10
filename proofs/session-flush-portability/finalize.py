"""Always-run, fail-closed source export plus bounded partial science retention."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from host import ROOT, read, write, sha, check_activation, check_inventory, inventory

# Reviewed literal names are independent of the mutable on-disk whitelist.
PUBLIC_SOURCE_FILES = ('ACTIVATION.json', 'DEPENDENCIES.md', 'INPUT-PINS.json', 'PROTOCOL.json', 'PROTOCOL.md', 'PUBLIC-WHITELIST.json', 'SOURCE-PROVENANCE.json', 'analyze.py', 'arms/baseline/LICENSE', 'arms/baseline/demo/session-worker.ts', 'arms/baseline/demo/sessions.browser.test.ts', 'arms/baseline/dist/chunk-8hw6gtrx.js', 'arms/baseline/dist/chunk-q6sd1gxn.js', 'arms/baseline/dist/chunk-tncfb2ad.js', 'arms/baseline/dist/chunk-y3qf8ee4.js', 'arms/baseline/dist/chunk-ytsz3xpv.js', 'arms/baseline/dist/geometry.js', 'arms/baseline/dist/numeric.js', 'arms/baseline/dist/redux.js', 'arms/baseline/dist/shared.js', 'arms/baseline/dist/state.js', 'arms/baseline/dist/tanstack-db-collection.js', 'arms/baseline/dist/worker.js', 'arms/baseline/package.json', 'arms/baseline/proofs/worker-sessions.mjs', 'arms/baseline/worker.ts', 'arms/candidate/LICENSE', 'arms/candidate/demo/session-worker.ts', 'arms/candidate/demo/sessions.browser.test.ts', 'arms/candidate/dist/chunk-42p16j0x.js', 'arms/candidate/dist/chunk-8hw6gtrx.js', 'arms/candidate/dist/chunk-q6sd1gxn.js', 'arms/candidate/dist/chunk-tncfb2ad.js', 'arms/candidate/dist/chunk-y3qf8ee4.js', 'arms/candidate/dist/geometry.js', 'arms/candidate/dist/numeric.js', 'arms/candidate/dist/redux.js', 'arms/candidate/dist/shared.js', 'arms/candidate/dist/state.js', 'arms/candidate/dist/tanstack-db-collection.js', 'arms/candidate/dist/worker.js', 'arms/candidate/package.json', 'arms/candidate/proofs/worker-sessions.mjs', 'arms/candidate/worker.ts', 'browser.config.mjs', 'browser.mjs', 'candidate.patch', 'finalize.py', 'finalizer-checks.py', 'host.py', 'prepare-host.py', 'protocol-checks.py', 'public-corpus.mjs', 'run-once.py', 'subject.mjs', 'supervise.py', 'supervisor-checks.py', 'toolchain/bun.lock', 'toolchain/package.json', 'wasm/geometry-kernels.wasm', 'wasm/numeric-kernels-simd.wasm', 'wasm/numeric-kernels.wasm', 'wasm/persistent-core.wasm', 'workflow.yml', 'workload.mjs', 'writer-check.mjs', 'writer.mjs')
TOP_SCIENCE = ('JOB.json','PREFLIGHT.json','RUNTIME.json','SCREEN.json','SUMMARY.json','AUDIT-FAILURE.json','POSTFLIGHT.json')
CASES = ('mixed-128','mixed-4','changed-single','reverted-one')
SUFFIXES = ('.json','.jsonl','.stderr','.receipt.json','.supervisor.jsonl')
MAX_FILE_BYTES = 32 * 1024 * 1024

def read_regular(root, relative, maximum=MAX_FILE_BYTES):
    """Read through no-follow directory/file descriptors; never traverse symlinks."""
    parts=relative.split('/')
    if not relative or Path(relative).is_absolute() or any(p in ('','..','.') for p in parts):
        raise ValueError('Unsafe export path')
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory);directory=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
        with os.fdopen(fd,'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size>maximum:raise ValueError('Nonregular or oversized export file')
            data=stream.read(maximum+1)
            if len(data)>maximum:raise ValueError('Export grew beyond byte cap')
            return data
    finally:os.close(directory)

def export_sources(root, destination):
    # Read and verify every source into memory before writing any source output.
    # If any pin, whitelist or source is untrusted, no source file is exported.
    pins_bytes=read_regular(root,'INPUT-PINS.json')
    pins=json.loads(pins_bytes)
    rows=pins['files'];by_name={row['path']:row for row in rows}
    expected=set(PUBLIC_SOURCE_FILES)-{'INPUT-PINS.json'}
    if len(by_name)!=len(rows) or set(by_name)!=expected:raise ValueError('Unexpected source pin set')
    verified={'INPUT-PINS.json':pins_bytes}
    for relative in sorted(expected):
        data=read_regular(root,relative);row=by_name[relative]
        if len(data)!=row['bytes'] or sha(data)!=row['sha256']:raise ValueError('Source integrity failure: '+relative)
        verified[relative]=data
    specification=json.loads(verified['PUBLIC-WHITELIST.json'])
    if specification['sourceFiles']!=list(PUBLIC_SOURCE_FILES):raise ValueError('Untrusted source whitelist')
    for relative,data in verified.items():
        path=destination/'source'/relative;path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as stream:stream.write(data)
    return [{'path':'source/'+relative,'bytes':len(data),'sha256':sha(data)} for relative,data in sorted(verified.items())]

def scientific_names(group):
    engines=('node','bun') if group=='arm' else ('chromium','firefox','webkit')
    names=set(TOP_SCIENCE)
    for setup in ('dependencies',)+(('browsers',) if group=='browsers' else ()):
        names.update('setup/'+setup+suffix for suffix in ('.jsonl','.stderr','.receipt.json'))
    preflight=(('node-public-corpus','bun-public-corpus','baseline-worker-session','candidate-worker-session') if group=='arm' else
      tuple(engine+'-'+tail for engine in engines for tail in ('baseline-sessions','candidate-sessions','probe')))
    for stem in preflight:names.update('preflight/'+stem+suffix for suffix in SUFFIXES)
    for stem in ('metadata-node-version','metadata-bun-version','metadata-os-packages'):
        names.update('preflight/'+stem+suffix for suffix in SUFFIXES)
    names.add('preflight/os-packages.txt')
    if group=='arm':names.update(('preflight/node-semantic.json','preflight/bun-semantic.json'))
    names.add('preflight/launches.jsonl')
    names.add('preflight/metadata.jsonl')
    names.add('screen/schedule.jsonl')
    for engine in engines:
        names.add('screen/frozen-'+engine+'.json')
        for case in CASES:
            stems=['cal-'+engine+'-'+case+'-'+arm for arm in ('baseline','candidate')]
            stems+=['measure-'+engine+'-'+case+'-'+str(slot) for slot in range(8)]
            for stem in stems:names.update('screen/'+stem+suffix for suffix in SUFFIXES)
    return sorted(names)

def export_science(root, group, destination):
    copied=[];rejected=[]
    for relative in scientific_names(group):
        try:data=read_regular(root,'results/'+group+'/'+relative)
        except FileNotFoundError:continue
        except (OSError,ValueError) as error:
            rejected.append({'path':relative,'reason':type(error).__name__});continue
        path=destination/'results'/relative;path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as stream:stream.write(data)
        copied.append({'path':'results/'+relative,'bytes':len(data),'sha256':sha(data)})
    return copied,rejected

def main(group):
    if group not in ['arm','browsers']:raise ValueError('Fixed group required')
    source=ROOT/'results'/group
    for directory in [ROOT/'results',source,ROOT/'public-artifacts']:
        if directory.is_symlink():raise ValueError('Symlinked artifact directory')
        directory.mkdir(exist_ok=True)
    public=ROOT/'public-artifacts'/group;public.mkdir(exist_ok=False)
    outcome={'inputPinsUnchanged':False,'installedFilesUnchanged':False,'error':None}
    source_files=[]
    try:
        check_activation() # Reject untrusted/changed source pins before exporting any source.
        source_files=export_sources(ROOT,public);outcome['inputPinsUnchanged']=True
        if (source/'RUNTIME.json').exists():
            manifest=json.loads(read_regular(source,'RUNTIME.json'))
            check_inventory(manifest['dependencies']);check_inventory(manifest['browserFiles'])
            if inventory(ROOT/'toolchain/node_modules')!=manifest['dependencies']:raise ValueError('Dependency tree changed')
            if group=='browsers' and inventory(ROOT/'browser-cache')!=manifest['browserFiles']:raise ValueError('Browser tree changed')
            for runtime,row in manifest['executables'].items():
                if sha(Path(row['path']).read_bytes())!=row['sha256']:raise ValueError('Executable changed: '+runtime)
            outcome['installedFilesUnchanged']=True
    except BaseException as error:outcome['error']=type(error).__name__+': '+str(error)
    write(source/'POSTFLIGHT.json',outcome)
    science,rejected=export_science(ROOT,group,public)
    write(public/'ARTIFACTS.json',{'group':group,'scientificFiles':science,'sourceFiles':source_files,
      'rejectedScientificFiles':rejected,'normalization':'None. Exact bounded accepted science files; sources only after complete integrity/no-symlink verification.',
      'postflight':outcome})
    if not outcome['inputPinsUnchanged'] or not outcome['installedFilesUnchanged'] or rejected:raise SystemExit(1)

if __name__=='__main__':main(sys.argv[1])
