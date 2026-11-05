"""Recompute every saved estimate from the retained per-process samples."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parent


def close(a, b):
    assert math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12), (a, b)


def verify(path):
    stored = path.read_bytes()
    raw = gzip.decompress(stored) if path.suffix == '.gz' else stored
    manifest_path = ROOT / 'manifest.json'
    if manifest_path.exists():
        evidence = json.loads(manifest_path.read_text())['evidence'].get(path.name)
        if evidence is not None:
            assert hashlib.sha256(stored).hexdigest() == evidence['sha256']
            assert hashlib.sha256(raw).hexdigest() == evidence['uncompressedSha256']
            assert len(raw) == evidence['uncompressedBytes']
    data = json.loads(raw)
    assert data['status'] == 'complete'
    assert data['schema'] == 'zerocopy-redux-descriptors/v1'
    assert data['driver'] == hashlib.sha256((ROOT / 'benchmark.mjs').read_bytes()).hexdigest()
    assert data['before']['head'] == '77599337867dbf785a5f0311d34637d0b36678fc'
    assert list(data['before']['source']) == list(data['after']['source'])
    assert [name for name, digest in data['before']['source'].items()
            if digest != data['after']['source'][name]] == ['redux-codec.ts']
    method = data['method']
    pairs = method['pairs']
    specs = {spec['name']: spec for spec in method['cases']}
    assert pairs == (6 if data['mode'] == 'formal' else 2)
    assert method['minimumWarmupMs'] == (500 if data['mode'] == 'formal' else 150)
    assert method['minimumWarmupBatches'] == 8
    assert method['samples'] == 9
    assert len(data['runs']) == pairs * 4 * len(specs)
    indexed = {}
    expected_order = []
    for runtime in ['node', 'bun']:
        for pair in range(pairs):
            names = list(specs)
            if pair % 2:
                names.reverse()
            for name in names:
                for variant in (['after', 'before'] if pair % 2 else ['before', 'after']):
                    expected_order.append((runtime, pair, variant, name))
    for expected_key, run in zip(expected_order, data['runs']):
        key = run['runtime'], run['pair'], run['variant'], run['caseName']
        assert key == expected_key
        assert key not in indexed
        indexed[key] = run
        spec = specs[run['caseName']]
        for name, value in spec.items():
            assert run[name] == value
        samples, warmup = run['sampleBatchMs'], run['warmupBatchMs']
        assert len(samples) == method['samples']
        assert len(warmup) >= method['minimumWarmupBatches']
        assert sum(warmup) >= method['minimumWarmupMs']
        assert all(math.isfinite(value) and value > 0 for value in warmup + samples)
        assert run['verifiedOutputs'] == (len(samples) + len(warmup)) * run['repetitions']
        close(run['medianMs'], statistics.median(samples) / run['repetitions'])
    assert len(data['summary']) == len(specs) * 2
    for summary in data['summary']:
        points = []
        for pair in range(pairs):
            before = indexed[summary['runtime'], pair, 'before', summary['name']]
            after = indexed[summary['runtime'], pair, 'after', summary['name']]
            assert before['expectedDigest'] == after['expectedDigest']
            assert before['versions'] == after['versions']
            points.append({'before': before['medianMs'], 'after': after['medianMs'],
                           'ratio': after['medianMs'] / before['medianMs']})
        for actual, expected in zip(summary['points'], points):
            for key in expected:
                close(actual[key], expected[key])
        assert len(summary['points']) == pairs
        close(summary['beforeMs'], statistics.median(point['before'] for point in points))
        close(summary['afterMs'], statistics.median(point['after'] for point in points))
        logs = [math.log(point['ratio']) for point in points]
        mean = statistics.mean(logs)
        close(summary['pairedRatio'], math.exp(mean))
        if data['mode'] == 'formal':
            margin = 2.570582 * statistics.stdev(logs) / math.sqrt(pairs)
            close(summary['interval95'][0], math.exp(mean - margin))
            close(summary['interval95'][1], math.exp(mean + margin))
        else:
            assert summary['interval95'] is None
    print(f"Verified {path.name}: {len(data['runs'])} processes, "
          f"{len(data['summary'])} paired estimates, {sum(len(run['sampleBatchMs']) for run in data['runs'])} measured batches")


if __name__ == '__main__':
    paths = list(map(Path, sys.argv[1:])) or sorted(ROOT.glob('*.json.gz'))
    assert paths, 'Pass a recording path or keep the compressed recordings beside this script'
    for path in paths:
        verify(path)
