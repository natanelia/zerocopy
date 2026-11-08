#!/usr/bin/env python3
"""Independent saved-record audit. Does not run collection code or timings."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys


def near(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-13), (actual, expected)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def base36(number):
    alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
    output = ''
    while number:
        number, remainder = divmod(number, 36)
        output = alphabet[remainder] + output
    return output or '0'


def fixture_digest(spec):
    entries = [[f'id/{i}', i + 0.25] for i in range(spec['count'])]
    oracle = dict(entries)

    def missing(index):
        if spec['mode'] == 'unicode':
            return f'absent/é/界/🙂/{index}'
        if spec['mode'] == 'short':
            return '?' + base36(index).rjust(2, '0')
        return f'absent/record/{index:06d}'

    keys = [entries[(i * 73 + 19) % spec['count']][0]
            if spec['mode'] == 'hit' or spec['mode'] == 'mixed' and i % 5 != 0
            else missing(i % spec['pool']) for i in range(spec['queries'])]
    roots = [(i // spec['pool']) % 2 if spec['mode'] == 'alternating' else 0
             for i in range(spec['queries'])]
    stream_keys = ([[f'{key}/request-{batch}' for key in keys] for batch in range(spec['repetitions'])]
                   if spec['state'] == 'streaming' else None)
    expected = [(key in oracle) if spec['method'] == 'has' else oracle.get(key, ['undefined']) for key in keys]
    fixture = {'fixture': {'entries': entries, 'keys': keys, 'roots': roots},
               'streamKeys': stream_keys, 'expected': expected}
    payload = json.dumps(fixture, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    return digest(payload), len(set(keys)), sum(key in oracle for key in keys)


def audit(path):
    raw = path.read_bytes()
    record = json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete'
    mode = record['mode']
    pairs = {'pilot': 2, 'formal': 6, 'aa': 4}[mode]
    critical = {4: 3.182446305284263, 6: 2.5705818356363155}.get(pairs)
    method, study, runs = record['method'], record['study'], record['runs']
    assert study['id'] == 'map-miss-cache-20261108'
    assert method['pairs'] == pairs and method['minimumWarmupMs'] == 500
    assert method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert method['cases'] == study['cases'], 'Every declared case must remain in every study'
    assert len(runs) == pairs * len(method['cases']) * 4
    names = [case['name'] for case in method['cases']]
    assert len(names) == len(set(names)) == 14
    assert record['source']['before']['commit'] == study['baseline']
    assert record['source']['before']['wasm'] == record['source']['after']['wasm']
    changed = sorted(name for name in record['source']['before']['sources']
                     if record['source']['before']['sources'][name] != record['source']['after']['sources'][name])
    assert changed == ([] if mode == 'aa' else ['arena.ts'])
    if mode == 'aa':
        assert record['source']['before']['bundles'] == record['source']['after']['bundles']
    for name, snapshots in record['snapshots'].items():
        for variant in ['before', 'after']:
            assert digest(snapshots[variant].encode()) == record['source'][variant]['sources'][name]

    schedule = []
    for pair in range(pairs):
        ordered_names = list(reversed(names)) if pair % 2 else names
        runtimes = ['bun', 'node'] if pair % 2 else ['node', 'bun']
        variants = ['after', 'before'] if pair % 2 else ['before', 'after']
        schedule.extend((pair, runtime, name, variant) for runtime in runtimes
                        for name in ordered_names for variant in variants)
    assert schedule == [(r['pair'], r['runtime'], r['caseName'], r['variant']) for r in runs]
    fixture_digests = {spec['name']: fixture_digest(spec) for spec in method['cases']}
    measured_short = warm_short = outputs = scalars = 0
    minimum_measured = math.inf
    for run in runs:
        spec = next(spec for spec in method['cases'] if spec['name'] == run['caseName'])
        assert run['spec'] == spec
        assert run['affinity'] == record['host']['affinity']
        assert run['versions']['node'] == '24.22.1' if run['runtime'] == 'node' else run['versions']['bun'] == '1.4.2'
        expected_hash, distinct, hit_count = fixture_digests[spec['name']]
        assert run['expectedDigest'] == expected_hash, (spec['name'], run['expectedDigest'], expected_hash)
        assert run['fixture']['requestCount'] == 1024
        assert run['fixture']['distinctKeys'] == distinct and run['fixture']['hitCount'] == hit_count
        assert run['fixture']['method'] == spec['method']
        assert run['fixture']['unit'] == f"{spec['queries']} complete scalar {spec['method']} calls plus result-array creation and retention"
        warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
        assert len(warm) >= 8 and sum(warm) >= 500 and len(samples) == 9
        assert all(math.isfinite(x) and x > 0 for x in warm + samples)
        near(run['medianMs'], statistics.median(samples) / spec['repetitions'])
        expected_outputs = (len(warm) + len(samples)) * spec['repetitions']
        assert run['verifiedOutputs'] == expected_outputs
        assert run['batchTiming']['measuredBelow2ms'] == sum(x < 2 for x in samples)
        assert run['batchTiming']['warmupBelow2ms'] == sum(x < 2 for x in warm)
        near(run['batchTiming']['minimumMeasuredMs'], min(samples))
        measured_short += sum(x < 2 for x in samples)
        warm_short += sum(x < 2 for x in warm)
        minimum_measured = min(minimum_measured, *samples)
        outputs += expected_outputs
        scalars += expected_outputs * spec['queries']

    indexed = {(r['pair'], r['runtime'], r['caseName'], r['variant']): r for r in runs}
    rows = []
    assert len(record['summary']) == len(names) * 2
    for row in record['summary']:
        points = []
        for pair in range(pairs):
            before = indexed[(pair, row['runtime'], row['name'], 'before')]
            after = indexed[(pair, row['runtime'], row['name'], 'after')]
            for field in ['versions', 'fixture', 'expectedDigest', 'affinity']:
                assert before[field] == after[field]
            points.append({'pair': pair, 'before': before['medianMs'], 'after': after['medianMs'],
                           'ratio': after['medianMs'] / before['medianMs']})
        assert points == row['points']
        near(row['beforeMs'], statistics.median(p['before'] for p in points))
        near(row['afterMs'], statistics.median(p['after'] for p in points))
        logs = [math.log(p['ratio']) for p in points]
        average = statistics.mean(logs)
        ratio = math.exp(average)
        near(row['pairedRatio'], ratio)
        assert row['fasterPairs'] == sum(p['ratio'] < 1 for p in points)
        interval = None
        if critical:
            margin = critical * statistics.stdev(logs) / math.sqrt(pairs)
            interval = [math.exp(average - margin), math.exp(average + margin)]
            for actual, expected in zip(row['interval95'], interval):
                near(actual, expected)
        else:
            assert row['interval95'] is None
        rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                     'beforeMicroseconds': row['beforeMs'] * 1000, 'afterMicroseconds': row['afterMs'] * 1000,
                     'pairedRatio': ratio, 'percentChange': (ratio - 1) * 100, 'interval95': interval,
                     'result': 'faster' if interval and interval[1] < 1 else
                               'slower' if interval and interval[0] > 1 else 'inconclusive'})
    return {'file': str(path), 'verified': True, 'mode': mode, 'processes': len(runs),
            'timedBatches': len(runs) * 9, 'verifiedOutputs': outputs, 'verifiedScalars': scalars,
            'measuredBatchesBelow2ms': measured_short, 'warmupBatchesBelow2ms': warm_short,
            'minimumMeasuredBatchMs': minimum_measured, 'fixtureDigestsReconstructed': len(fixture_digests),
            'rows': rows}


if __name__ == '__main__':
    assert len(sys.argv) > 1, 'Supply one or more complete raw JSON or JSON.gz records'
    print(json.dumps([audit(Path(path)) for path in sys.argv[1:]], indent=2, ensure_ascii=False))
