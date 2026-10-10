"""Small shared file/provenance helpers. Not a benchmark framework."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
def sha(data): return hashlib.sha256(data).hexdigest()
def read(path): return json.loads(Path(path).read_text())
def write(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
def check_pins():
    pins = read(ROOT / 'INPUT-PINS.json')
    for row in pins['files']:
        data = (ROOT / row['path']).read_bytes()
        if len(data) != row['bytes'] or sha(data) != row['sha256']: raise ValueError('Input mismatch: ' + row['path'])
    return sha((ROOT / 'INPUT-PINS.json').read_bytes())
def canonical_source_digest(pins):
    # Activation-only files and the self-referential pin container are excluded.
    excluded={'ACTIVATION.json','workflow.yml','INPUT-PINS.json'}
    rows=sorted((row for row in pins['files'] if row['path'] not in excluded),key=lambda row:row['path'])
    return sha(json.dumps(rows,sort_keys=True,separators=(',',':')).encode())

def check_activation():
    """One reviewed branch transition; no repository variables or persistent settings."""
    pins_hash=check_pins();intent=read(ROOT/'ACTIVATION.json')
    if intent.get('enabled') is not True or intent.get('intentId')!='session-flush-portability-20261010':
        raise ValueError('Dormant or unreviewed execution intent')
    before=intent.get('expectedBefore','')
    if type(before) is not str or not re.fullmatch('[0-9a-f]{40}',before):raise ValueError('Missing reviewed preparation predecessor')
    if os.environ.get('GITHUB_RUN_ATTEMPT')!='1' or os.environ.get('GITHUB_EVENT_NAME')!='push':raise ValueError('Wrong event or rerun')
    event=read(Path(os.environ['GITHUB_EVENT_PATH']))
    if event.get('before')!=before or event.get('ref')!='refs/heads/proof/session-flush-portability-20261010':
        raise ValueError('Not the reviewed single branch transition')
    canonical=canonical_source_digest(read(ROOT/'INPUT-PINS.json'))
    if canonical!=intent.get('canonicalSourceSHA256'):raise ValueError('Scientific/source payload differs from reviewed intent')
    actual={}
    for suffix,key in [('', 'executionHead'),('^{tree}','executionGitTree')]:
        actual[key]=subprocess.run(['git','-C',str(ROOT),'rev-parse','HEAD'+suffix],capture_output=True,text=True,timeout=5,check=True).stdout.strip()
    if actual['executionHead']!=os.environ.get('GITHUB_SHA') or not re.fullmatch('[0-9a-f]{40}',actual['executionHead']):
        raise ValueError('Checkout differs from activation execution head')
    subprocess.run(['git','-C',str(ROOT),'diff','--quiet','HEAD','--','.'],timeout=5,check=True)
    return {'intentId':intent['intentId'],'expectedBefore':before,'canonicalSourceSHA256':canonical,
      'inputPinsSHA256':pins_hash,**actual}

def inventory(directory):
    directory = Path(directory)
    rows = []
    for path in sorted(directory.rglob('*')):
        relative = str(path.relative_to(ROOT))
        if path.is_symlink(): rows.append({'path': relative, 'symlink': os.readlink(path)})
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''): digest.update(block)
            rows.append({'path': relative, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()})
    return rows
def check_inventory(rows):
    for row in rows:
        path = ROOT / row['path']
        if 'symlink' in row:
            if not path.is_symlink() or os.readlink(path) != row['symlink']: raise ValueError('Symlink changed: ' + row['path'])
        else:
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''): digest.update(block)
            if path.stat().st_size != row['bytes'] or digest.hexdigest() != row['sha256']: raise ValueError('Installed bytes changed: ' + row['path'])
def native_elf(rows):
    found=[]
    for row in rows:
        if 'sha256' not in row:continue
        with (ROOT/row['path']).open('rb') as stream:header=stream.read(20)
        if header[:4]==b'\x7fELF' and len(header)==20:
            if header[5] not in [1,2]:raise ValueError('Invalid ELF byte order')
            found.append({'path':row['path'],'elfClass':header[4],
              'machine':int.from_bytes(header[18:20],'little' if header[5]==1 else 'big'),'sha256':row['sha256']})
    return found
def supervised(command, directory, stem, seconds, rss, handshake=False, extra_env=None):
    argv = [sys.executable, str(ROOT / 'supervise.py'), '--cwd', str(directory), '--seconds', str(seconds),
            '--rss-mib', str(rss), '--output', str(stem) + '.jsonl', '--stderr', str(stem) + '.stderr',
            '--receipt', str(stem) + '.receipt.json']
    if handshake: argv.append('--handshake')
    for key, value in (extra_env or {}).items(): argv += ['--env', key + '=' + value]
    argv += ['--', *command]
    with Path(str(stem) + '.supervisor.jsonl').open('xb') as stream:
        # Supervisor owns descendant cleanup; do not independently kill its process group.
        process = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT)
        try: code = process.wait(timeout=seconds + 2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired: raise RuntimeError('Supervisor failed to finalize; hosted job must terminate')
            raise RuntimeError('Supervisor exceeded its total cap')
    receipt = read(str(stem) + '.receipt.json')
    if code or receipt['state'] != 'passed': raise RuntimeError('Command failed: ' + stem.name)
    return receipt
