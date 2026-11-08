"""Independent review of hosted raw records; never launches a benchmark.

Usage: python independent-review.py DOWNLOAD_RESULTS REPOSITORY OUTPUT_JSON
Requires scipy solely for an independently computed Student-t quantile.
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import math
import pathlib
import statistics as stats
import sys

import scipy
from scipy.stats import t

records_path, repository, output = map(pathlib.Path, sys.argv[1:])
proof = repository / 'proofs/list-set-many-20261108'
BASELINE = 'a4265a0608ec25eec5719496225212db6b251989'


def sha(value):
    return hashlib.sha256(value).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12), (actual, expected)


def load(name):
    path = records_path / (name + '.json')
    if not path.exists():
        path = path.with_suffix('.json.gz')
    raw = path.read_bytes()
    if path.suffix == '.gz':
        raw = gzip.decompress(raw)
    return json.loads(raw), sha(raw)


def json_hash(value):
    return sha(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def fixture(spec):
    """Reconstruct primitives and indexes independently of the JS workload."""
    count, edits, shape, kind = (spec[k] for k in ('count', 'edits', 'shape', 'type'))
    values = [(i % 3 == 1 if kind == 'boolean' else
               f'lane/é/界/🙂/{i}' if kind == 'string' else i + .25) for i in range(count)]
    state, seen, indexes = 0x42C0FFEE, set(), []
    for i in range(edits):
        if shape == 'clustered':
            index = min(4090, count - edits) + ((i * 73) % edits)
        elif shape == 'repeated':
            index = 4000 + i % 16
        elif shape == 'mixed' and i < 4:
            index = [0, 31, 32, count - 1][i]
        else:
            while True:
                state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
                index = state % count
                if index not in seen:
                    break
        assert 0 <= index < count
        indexes.append(index)
        seen.add(index)
    entries = [[index, (not values[index] if kind == 'boolean' else
                        f'replacement/{i}/é/🙂' if kind == 'string' else -i - .125)]
               for i, index in enumerate(indexes)]
    expected = values.copy()
    for index, value in entries:
        expected[index] = value
    return {'input': values, 'entries': entries}, expected, len(seen)


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def serial_windows(record):
    last = timestamp(record['startedAt'])
    for run in record['runs']:
        start, end = timestamp(run['startedAt']), timestamp(run['completedAt'])
        assert start >= last and end >= start
        assert sum(run['warmupBatchMs'] + run['sampleBatchMs']) <= (end - start) * 1000 + 1
        last = end
    assert timestamp(record['completedAt']) >= last


def distributions(run, minimum_ms, minimum_batches, repetitions, median_field, verified_field):
    warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
    assert len(warm) >= minimum_batches and sum(warm) >= minimum_ms
    assert len(samples) == 9
    assert all(math.isfinite(value) and value > 0 for value in warm + samples)
    estimate = stats.median(samples) / repetitions
    close(run[median_field], estimate)
    assert run[verified_field] == (len(warm) + len(samples)) * repetitions
    return estimate


def paired(record, expected_processes):
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete' and 'failure' not in record
    method, runs = record['method'], record['runs']
    cases, pairs = method['cases'], method['pairs']
    assert len(runs) == expected_processes == len(cases) * pairs * 4
    assert pairs == (6 if record['mode'] == 'formal' else 4)
    assert method['minimumWarmupMs'] == 500 and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'].isdigit()
    assert record['study']['baseline'] == record['source']['before']['commit'] == BASELINE
    assert len(record['summary']) == 2 * len(cases)
    schedule = []
    for pair in range(pairs):
        for runtime in (['node', 'bun'] if pair % 2 == 0 else ['bun', 'node']):
            for spec in (cases if pair % 2 == 0 else cases[::-1]):
                for variant in (['before', 'after'] if pair % 2 == 0 else ['after', 'before']):
                    schedule.append((pair, runtime, spec['name'], variant))
    actual_schedule = [(run['pair'], run['runtime'], run['caseName'], run['variant']) for run in runs]
    assert actual_schedule == schedule and len(set(actual_schedule)) == len(runs)
    estimates, expected_fixtures = {}, {}
    for spec in cases:
        data, _, distinct = fixture(spec)
        expected_fixtures[spec['name']] = json_hash(data), distinct
    versions = {}
    for run in runs:
        spec = next(spec for spec in cases if spec['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert not run['stderr'] and run['executable'] == method['runtimes'][run['runtime']]
        assert run['expectedDigest'] == expected_fixtures[spec['name']][0]
        assert run['fixture']['distinctEdits'] == expected_fixtures[spec['name']][1]
        versions.setdefault(run['runtime'], run['versions'])
        assert versions[run['runtime']] == run['versions']
        expected_strategy = ('SharedList.get loop' if spec['mode'] == 'get' else
                             'one SharedList.setMany call' if spec['mode'] == 'batch' and
                             record['mode'] == 'formal' and run['variant'] == 'after' else
                             'scalar SharedList.set loop')
        assert run['strategy'] == expected_strategy
        key = (run['pair'], run['runtime'], run['caseName'], run['variant'])
        estimates[key] = distributions(run, 500, 8, spec['repetitions'], 'medianMs', 'verifiedOutputs')
        timing = run['batchTiming']
        close(timing['minimumObservedMs'], min(run['warmupBatchMs'] + run['sampleBatchMs']))
        close(timing['minimumMeasuredMs'], min(run['sampleBatchMs']))
        assert timing['measuredBelow2ms'] == sum(ms < 2 for ms in run['sampleBatchMs'])
        assert timing['warmupBelow2ms'] == sum(ms < 2 for ms in run['warmupBatchMs'])
    summary_rows = []
    for row in record['summary']:
        before, after, ratios = [], [], []
        for pair in range(pairs):
            b = estimates[pair, row['runtime'], row['name'], 'before']
            a = estimates[pair, row['runtime'], row['name'], 'after']
            point = row['points'][pair]
            assert point['pair'] == pair
            close(point['before'], b); close(point['after'], a); close(point['ratio'], a / b)
            before.append(b); after.append(a); ratios.append(a / b)
            selected = [r for r in runs if r['pair'] == pair and r['runtime'] == row['runtime'] and r['caseName'] == row['name']]
            assert selected[0]['fixture'] == selected[1]['fixture']
        logs = [math.log(ratio) for ratio in ratios]
        center = stats.mean(logs)
        width = t.ppf(.975, pairs - 1) * stats.stdev(logs) / math.sqrt(pairs)
        ratio, interval = math.exp(center), [math.exp(center - width), math.exp(center + width)]
        close(row['pairedRatio'], ratio)
        close(row['beforeMs'], stats.median(before)); close(row['afterMs'], stats.median(after))
        for actual, expected in zip(row['interval95'], interval): close(actual, expected)
        assert row['fasterPairs'] == sum(r < 1 for r in ratios)
        summary_rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                             'pairedRatio': ratio, 'interval95': interval,
                             'changePercent': (ratio - 1) * 100,
                             'classification': 'faster' if interval[1] < 1 else 'slower' if interval[0] > 1 else 'inconclusive'})
    assert set(record['snapshots']) == set(record['study']['changedSources'])
    for name, variants in record['snapshots'].items():
        for variant, value in variants.items():
            assert value is not None
            assert sha(value.encode()) == record['source'][variant]['sources'][name]
    for field, filename in [('driver', 'paired-benchmark.mjs'), ('workload', 'workloads.mjs')]:
        assert sha((proof / filename).read_bytes()) == record[field]['sha256']
    if record['mode'] == 'aa':
        for field in ('sources', 'wasm', 'bundles'):
            assert record['source']['before'][field] == record['source']['after'][field]
    else:
        changed = {key for key in record['source']['before']['sources']
                   if record['source']['before']['sources'][key] != record['source']['after']['sources'][key]}
        assert changed == set(record['study']['changedSources'])
        for field, directory in [('sources', repository), ('wasm', repository), ('bundles', repository / 'dist')]:
            for name, digest in record['source']['after'][field].items():
                assert sha((directory / name).read_bytes()) == digest, name
    serial_windows(record)
    return {'processes': len(runs), 'measuredBatches': sum(len(r['sampleBatchMs']) for r in runs),
            'warmupBatches': sum(len(r['warmupBatchMs']) for r in runs),
            'verifiedOutputs': sum(r['verifiedOutputs'] for r in runs),
            'measuredBatchesBelow2ms': sum(ms < 2 for r in runs for ms in r['sampleBatchMs']),
            'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
            'warmupBatchesBelow2ms': sum(ms < 2 for r in runs for ms in r['warmupBatchMs']),
            'rows': summary_rows}


def reference(record, primary):
    assert record['schema'] == 'zerocopy-list-batch-library-comparison/v1' and record['status'] == 'complete'
    assert 'failure' not in record and record['source']['before']['commit'] == BASELINE
    method, runs = record['method'], record['runs']
    cases, implementations = method['cases'], method['implementations']
    assert method['rounds'] == 3 and len(cases) == 4 and len(runs) == 96
    assert implementations == ['zerocopy-before', 'zerocopy-after', 'immutable', 'native']
    assert method['warmupMs'] == 250 and method['samples'] == 9 and method['minimumWarmupBatches'] == 8
    assert record['host']['affinity'] == primary['host']['affinity']
    expected_schedule = []
    for round_index in range(3):
        for runtime in (['node', 'bun'] if round_index % 2 == 0 else ['bun', 'node']):
            for spec in (cases if round_index % 2 == 0 else cases[::-1]):
                offset = (round_index + cases.index(spec) + (runtime == 'bun')) % 4
                order = implementations[offset:] + implementations[:offset]
                if round_index % 2: order.reverse()
                expected_schedule.extend((round_index, runtime, spec['name'], name, tuple(order)) for name in order)
    actual_schedule = [(r['round'], r['runtime'], r['caseName'], r['implementation'], tuple(r['order'])) for r in runs]
    assert actual_schedule == expected_schedule and len(set(actual_schedule)) == 96
    fixtures, estimates = {}, {}
    for spec in cases:
        assert spec in primary['method']['cases']
        data, expected, _ = fixture(spec)
        fixtures[spec['name']] = json_hash({**data, 'expected': expected})
    immutable = runs[0]['immutable']
    versions = {}
    for run in runs:
        spec = next(s for s in cases if s['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        repetitions = max(8, min(128, 4194304 // spec['count']))
        assert run['repetitions'] == repetitions
        assert run['expectedDigest'] == fixtures[spec['name']] and run['immutable'] == immutable
        versions.setdefault(run['runtime'], run['versions'])
        assert versions[run['runtime']] == run['versions']
        assert run['versions'] == next(r['versions'] for r in primary['runs'] if r['runtime'] == run['runtime'])
        estimate = distributions(run, 250, 8, repetitions, 'medianMillisecondsPerBatch', 'verifiedFinalSnapshots')
        close(run['medianMillisecondsPerScalarEditEquivalent'], estimate / spec['edits'])
        assert run['measuredBatchesBelow2ms'] == sum(ms < 2 for ms in run['sampleBatchMs'])
        estimates[run['round'], run['runtime'], run['caseName'], run['implementation']] = estimate
    assert len(record['summary']) == 32
    for row in record['summary']:
        spec = next(s for s in cases if s['name'] == row['caseName'])
        points = [estimates[i, row['runtime'], row['caseName'], row['implementation']] for i in range(3)]
        assert row['rounds'] == 3
        close(row['millisecondsPerBatch'], stats.median(points))
        close(row['microsecondsPerScalarEditEquivalent'], stats.median(points) / spec['edits'] * 1000)
    for variant in ('before', 'after'):
        assert record['source'][variant]['commit'] == primary['source'][variant]['commit']
        for name, digest in record['source'][variant]['hashes'].items():
            if name.startswith('dist/'):
                expected = primary['source'][variant]['bundles'][name[5:]]
            elif name.endswith('.wasm'):
                expected = primary['source'][variant]['wasm'][name]
            else:
                expected = primary['source'][variant]['sources'][name]
            assert digest == expected
    assert sha((proof / 'reference-comparison.mjs').read_bytes()) == record['harnessHash']
    assert sha((proof / 'workloads.mjs').read_bytes()) == record['workloadHash'] == primary['workload']['sha256']
    package = repository / 'node_modules/immutable/package.json'
    package_data = json.loads(package.read_text())
    assert package_data['version'] == immutable['version'] == '5.1.9'
    assert sha(package.read_bytes()) == immutable['packageSha256']
    assert sha((package.parent / package_data['main']).read_bytes()) == immutable['moduleSha256']
    serial_windows(record)
    short = {}
    for implementation in implementations:
        selected = [r for r in runs if r['implementation'] == implementation]
        short[implementation] = sum(ms < 2 for r in selected for ms in r['sampleBatchMs'])
    return {'processes': len(runs), 'measuredBatches': len(runs) * 9,
            'verifiedFinalSnapshots': sum(r['verifiedFinalSnapshots'] for r in runs),
            'measuredBatchesBelow2ms': sum(short.values()), 'shortBatchesByImplementation': short,
            'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
            'equalFixtureDigestsAndRepetitions': True, 'independentlyReconstructedFixtureDigests': True,
            'fullResultAndRetainedSourceAssertionsReviewed': True,
            'nativeCopyStrategy': 'One Array.slice per complete logical batch; all private assignments included.',
            'immutableStrategy': 'One List.withMutations session per complete logical batch.',
            'noIntermediateScalarSnapshotsRetained': True,
            'sourceAndBuildHashesMatchPrimary': True, 'immutableIdentity': immutable}


formal, formal_sha = load('formal')
aa, aa_sha = load('aa')
supplement, supplement_sha = load('reference-comparison')
assert formal['source']['before'] == aa['source']['before'] == aa['source']['after']
primary_review, aa_review = paired(formal, 240), paired(aa, 48)
reference_review = reference(supplement, formal)
report = {
    'schema': 'zerocopy-list-batch-independent-review/v1',
    'reviewedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'passed': True, 'retimed': False,
    'method': 'Independent Python reconstruction of fixtures, SHA-256 identities, schedule, medians, ratios, sample counts and Student-t intervals; no use of the repository verifier.',
    'reviewerScriptSha256': sha(pathlib.Path(__file__).read_bytes()),
    'scipyVersion': scipy.__version__,
    'rawRecordSha256': {'formal.json': formal_sha, 'aa.json': aa_sha, 'reference-comparison.json': supplement_sha},
    'primary': primary_review, 'sameBuild': aa_review, 'referenceComparison': reference_review,
    'conclusions': [
        'Formal statistics, schedules, source/build provenance, warmups, output accounting and independently reconstructed fixtures all agree with the raw records.',
        'Bun four-edit batches are 94.0% slower: paired ratio 1.9402, unadjusted 95% interval 1.7849 to 2.1090.',
        'Bun 256-scattered-edit batches are 9.7% slower: paired ratio 1.0974, unadjusted 95% interval 1.0189 to 1.1821.',
        'All four unchanged formal control intervals include 1; their effects are inconclusive, not proof of zero regression.',
        'Benefits are scoped to the opt-in batch API and workload shapes. No blanket speedup over scalar set or competing libraries is established.',
        'The supplementary comparison uses fair whole-batch strategies and identical fixtures. It reports three-round medians, not paired confidence intervals; primary paired evidence carries the optimization claim.',
        'Verification accounting and assertion coverage were audited. Recorded outputs themselves are not stored for independent replay; no benchmark was rerun.',
    ],
}
assert all(row['classification'] == 'inconclusive' for row in primary_review['rows'] if row['role'] == 'control')
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('x') as handle:
    json.dump(report, handle, indent=2, ensure_ascii=False)
    handle.write('\n')
print(json.dumps({'passed': True, 'output': str(output),
                  'primary': {k: v for k, v in primary_review.items() if k != 'rows'},
                  'sameBuild': {k: v for k, v in aa_review.items() if k != 'rows'},
                  'referenceComparison': reference_review,
                  'conclusions': report['conclusions']}, indent=2))
