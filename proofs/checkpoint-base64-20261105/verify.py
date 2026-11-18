#!/usr/bin/env python3
"""Recompute the archived checkpoint study without importing its JS driver."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e'

def close(a, b):
    assert math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-12), (a, b)

for filename in sys.argv[1:]:
    path = Path(filename)
    raw = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
    data = json.loads(raw)
    isolated = data['schema'] == 'zerocopy-checkpoint-base64/isolated-v1'
    assert data['status'] == 'complete'
    assert data['before']['head'] == BASE
    driver = 'isolated.mjs' if isolated else 'benchmark.mjs'
    assert hashlib.sha256((ROOT / 'proofs/checkpoint-base64-20261105' / driver).read_bytes()).hexdigest() == data['driver']
    before, after = data['before']['source'], data['after']['source']
    assert before.keys() == after.keys()
    assert [key for key in before if before[key] != after[key]] == ['redux-checkpoint.ts']
    assert hashlib.sha256((ROOT / 'redux-checkpoint.ts').read_bytes()).hexdigest() == after['redux-checkpoint.ts']
    pairs = data['method']['pairs']
    specs = {item['name']: item for item in data['method']['cases']}
    assert len(data['runs']) == pairs * 4 * (len(specs) if isolated else 1)
    indexed = {}
    verified = 0
    for run in data['runs']:
        if isolated:
            assert len(run['records']) == 1 and run['records'][0]['name'] == run['caseName']
        else:
            assert run['reversed'] == bool(run['pair'] % 2)
            assert {row['name'] for row in run['records']} == specs.keys()
        for row in run['records']:
            key = run['runtime'], run['pair'], run['variant'], row['name']
            assert key not in indexed
            indexed[key] = row
            assert row['repetitions'] == specs[row['name']]['repetitions']
            warm, samples = row['warmupBatchMs'], row['sampleBatchMs']
            assert len(warm) >= 8 and sum(warm) >= 500
            assert len(samples) == 9 and all(value > 0 for value in warm + samples)
            assert row['verifiedOutputs'] == (len(warm) + 9) * row['repetitions']
            verified += row['verifiedOutputs']
            close(row['medianMs'], statistics.median(samples) / row['repetitions'])
    for summary in data['summary']:
        points = []
        for pair in range(pairs):
            first = indexed[summary['runtime'], pair, 'before', summary['name']]
            second = indexed[summary['runtime'], pair, 'after', summary['name']]
            for key in ['fixtureDigest', 'initialArenaDigests', 'arenaBytes', 'count', 'repetitions']:
                assert first[key] == second[key]
            points.append((first['medianMs'], second['medianMs']))
        close(summary['beforeMs'], statistics.median(a for a, b in points))
        close(summary['afterMs'], statistics.median(b for a, b in points))
        logs = [math.log(b / a) for a, b in points]
        mean = statistics.mean(logs)
        close(summary['pairedRatio'], math.exp(mean))
        if data['mode'] == 'formal':
            assert pairs == 6
            margin = 2.570582 * statistics.stdev(logs) / math.sqrt(pairs)
            close(summary['interval95'][0], math.exp(mean - margin))
            close(summary['interval95'][1], math.exp(mean + margin))
    assert len(data['summary']) == 2 * len(specs)
    print(json.dumps({'file': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                      'processes': len(data['runs']), 'verifiedOutputs': verified,
                      'summaries': len(data['summary']), 'passed': True}))
