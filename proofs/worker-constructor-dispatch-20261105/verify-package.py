"""Verify archived dispatch evidence and exact source overlays; runs no benchmarks."""
import gzip
import hashlib
import json
from datetime import datetime
from pathlib import Path
from verify import verify

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'manifest.json').read_text())
for name, item in manifest['artifacts'].items():
    raw = (ROOT / name).read_bytes()
    assert len(raw) == item['bytes'], name
    assert hashlib.sha256(raw).hexdigest() == item['sha256'], name
records, checked = {}, []
for name in manifest['evidence']:
    path = ROOT / name
    checked.append(verify(path))
    records[name] = json.loads(gzip.decompress(path.read_bytes()))
assert set(records) == {'pilot-01.json.gz', 'pilot-02.json.gz', 'formal-01.json.gz', 'aa-01.json.gz', 'aa-early-01.json.gz'}
for version, source in manifest['sourceSnapshots'].items():
    text = (ROOT / source['path']).read_text()
    assert hashlib.sha256(text.encode()).hexdigest() == source['sha256']
    for name, side in source['recordings']:
        assert text == records[name]['snapshots']['shared.ts'][side]
        assert source['sha256'] == records[name]['source'][side]['sources']['shared.ts']
original = (ROOT / 'workloads.mjs').read_text()
additional = (ROOT / 'workloads-early-aa.mjs').read_text()
assert additional == original.replace(
    "  aaCases: ['mixed-128-shared', 'late-128-shared', 'single-map-shared'],",
    "  aaCases: ['early-map-128-control'],")
formal = records['formal-01.json.gz']
declared = datetime.fromisoformat(manifest['extraAaDeclaredAt'])
assert datetime.fromisoformat(formal['startedAt'].replace('Z', '+00:00')) <= declared < datetime.fromisoformat(formal['completedAt'].replace('Z', '+00:00'))
primary = [row for row in formal['summary'] if row['role'] == 'primary target']
assert len(primary) == 4
for row in primary:
    assert row['pairedRatio'] <= 0.9 and row['interval95'][1] < 1 and row['fasterPairs'] == 6
processes = sum(result['processes'] for result in checked)
batches = sum(result['measuredBatches'] for result in checked)
assert processes == 360 and batches == 3240
print(f'Verified five recordings, {processes} processes, {batches} measured batches, exact source overlays and predeclared A/A scope; no timings run.')
