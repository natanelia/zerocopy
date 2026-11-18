import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/workspace/scratch/240add2fd2cb/zerocopy-json-combined')
OUT = Path(__file__).resolve().parent
TOOLS = Path('/workspace/scratch/240add2fd2cb/tools')
env = dict(os.environ)
env['PATH'] = f"{TOOLS / 'cargo/bin'}:{TOOLS / 'node_modules/.bin'}:{env['PATH']}"
env['RUSTUP_HOME'] = str(TOOLS / 'rustup')
env['CARGO_HOME'] = str(TOOLS / 'cargo')

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def identity():
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    manifest = {p: sha(ROOT / p) for p in paths if p}
    return {
        'cursorParent': git('rev-parse', 'HEAD'),
        'stringParent': git('rev-parse', 'MERGE_HEAD'),
        'stagedTree': git('write-tree'),
        'trackedFiles': manifest,
        'trackedManifestSha256': hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        'unstagedTrackedDiff': git('diff', '--name-only'),
    }

steps = [
    ('source-whitespace', ['git', 'diff', '--cached', '--check', '--', '.', ':(exclude)**/*.patch'], 30),
    ('build-wasm', ['node', 'scripts/build-wasm.mjs'], 600),
    ('build-browser', ['bun', 'scripts/build-browser.ts'], 180),
    ('wasm-audits', ['node', '--test', 'scripts/rust-wasm.node.mjs'], 180),
    ('build-types', ['bun', 'run', 'build:types'], 180),
    ('typecheck', ['bun', 'run', 'typecheck'], 180),
    ('typecheck-redux', ['bun', 'run', 'typecheck:redux'], 180),
    ('typecheck-values', ['bun', 'run', 'typecheck:values'], 180),
    ('typecheck-geometry', ['bun', 'run', 'typecheck:geometry'], 180),
    ('full-bun-suite', ['bun', '--bun', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=4'], 300),
    ('array-cursor-workers', ['node', 'proofs/json-array-cursor-20261118/workers.mjs'], 120),
    ('string-scan-workers', ['node', 'proofs/json-string-scan-20261118/workers.mjs'], 120),
]

report = {
    'schema': 1,
    'purpose': 'Local integration correctness; no performance measurements',
    'root': str(ROOT),
    'startedAt': now(),
    'status': 'running',
    'mergeConflict': False,
    'before': identity(),
    'versions': {},
    'steps': [],
}
assert report['before']['cursorParent'] == '0b7c0960adcad3ec61b4a2557490be45df6dcdf7'
assert report['before']['stringParent'] == '3f832b150d8304250ab5f79a53f38e3fd8fe2b6d'
assert report['before']['stagedTree'] == '340a0d5a8ad0184c90ba90c60b48fc720158448e'
assert report['before']['unstagedTrackedDiff'] == ''
assert git('ls-files', '-u') == ''
assert git('rev-parse', report['before']['stringParent'] + '^{tree}') == 'adce0dc3dce5d0efb0be42787d35cf7f4e4dba73'
for name in ['node', 'bun', 'rustc', 'cargo']:
    report['versions'][name] = subprocess.check_output([name, '--version'], cwd=ROOT, env=env).decode().strip()

def save():
    (OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')

save()
for index, (name, command, timeout) in enumerate(steps, 1):
    log = OUT / f'{index:02d}-{name}.log'
    entry = {'name': name, 'command': command, 'log': log.name, 'startedAt': now()}
    report['steps'].append(entry)
    save()
    print(f'[{index}/{len(steps)}] Starting {name}', flush=True)
    start = time.monotonic()
    try:
        with log.open('wb') as stream:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        entry['exitCode'] = result.returncode
    except subprocess.TimeoutExpired:
        entry['exitCode'] = None
        entry['timedOut'] = True
    entry['elapsedSeconds'] = round(time.monotonic() - start, 3)
    entry['completedAt'] = now()
    entry['logSha256'] = sha(log)
    entry['passed'] = entry['exitCode'] == 0
    save()
    print(f"[{index}/{len(steps)}] {'Passed' if entry['passed'] else 'FAILED'} {name} ({entry['elapsedSeconds']}s)", flush=True)
    if not entry['passed']:
        report['status'] = 'failed'
        report['completedAt'] = now()
        save()
        print(log.read_text(errors='replace')[-12000:], flush=True)
        sys.exit(1)

report['after'] = identity()
report['trackedFilesUnchanged'] = report['after'] == report['before']
report['artifacts'] = {
    str(path.relative_to(ROOT)): {'bytes': path.stat().st_size, 'sha256': sha(path)}
    for path in sorted([*ROOT.glob('*.wasm'), *ROOT.glob('dist/*.js')])
}
report['status'] = 'passed' if report['trackedFilesUnchanged'] else 'failed-source-changed'
report['completedAt'] = now()
save()
print(json.dumps({key: report[key] for key in ['status', 'trackedFilesUnchanged', 'versions', 'completedAt']}, indent=2), flush=True)
sys.exit(0 if report['status'] == 'passed' else 1)
