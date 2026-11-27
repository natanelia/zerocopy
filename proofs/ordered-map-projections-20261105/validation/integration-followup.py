#!/usr/bin/env python3
"""Verify final test discovery and proof packaging without repeating runtime builds."""
import datetime, hashlib, json, os
from pathlib import Path
import re, subprocess, sys, time

root, previous, output = (Path(p).resolve() for p in sys.argv[1:4])
output.mkdir(parents=True, exist_ok=True)
prior = json.loads(previous.read_text())
env = dict(os.environ, FORCE_COLOR="0", NO_COLOR="1")
def sources():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob('*.ts')) if not p.name.endswith('.test.ts')}
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
assert prior['status'] == 'passed'
assert sources() == prior['runtimeSourceSha256'], 'Runtime differs from the completed build/package gate'
assert not list((root/'proofs/ordered-map-projections-20261105/rejected-v1').rglob('*.test.ts'))
commands = [
    ['bun', 'run', 'test'],
    ['node', 'proofs/block-callback-20261105/verify.mjs'],
    ['node', 'scripts/check-docs.mjs', '--base', prior['base'], '--preserve'],
]
manifest = {'purpose': 'Final default test discovery and proof packaging; runtime unchanged from the V2 build/type/worker/package gate.',
    'started': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'priorCommit': prior['commit'],
    'priorManifestSha256': hashlib.sha256(previous.read_bytes()).hexdigest(), 'commit': git('rev-parse', 'HEAD'),
    'tree': git('rev-parse', 'HEAD^{tree}'), 'runtimeSourceSha256': sources(), 'steps': []}
path = output/'integration-followup-manifest.json'
with (output/'integration-followup-validation.txt').open('w') as log:
    for command in commands:
        print(json.dumps({'starting': command}), flush=True)
        log.write('\n$ ' + ' '.join(command) + '\n'); log.flush()
        start = time.monotonic()
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        step = {'command': command, 'exitCode': result.returncode, 'seconds': time.monotonic()-start}
        manifest['steps'].append(step); path.write_text(json.dumps(manifest, indent=2)+'\n')
        print(json.dumps(step), flush=True)
        if result.returncode:
            manifest['status']='failed'; path.write_text(json.dumps(manifest, indent=2)+'\n'); sys.exit(result.returncode)
assert sources() == prior['runtimeSourceSha256']
assert manifest['commit'] == git('rev-parse', 'HEAD')
raw=(output/'integration-followup-validation.txt').read_bytes()
clean=re.sub(r'\x1b\[[0-9;]*m', '', raw.decode())
assert re.search(r'Test Files\s+58 passed \(58\)', clean)
assert re.search(r'Tests\s+1127 passed \(1127\)', clean)
manifest.update(status='passed', finished=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    activeFiles=58, activeTests=1127, validationLogSha256=hashlib.sha256(raw).hexdigest())
path.write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'status':'passed','commit':manifest['commit'],'activeFiles':58,'activeTests':1127}), flush=True)
