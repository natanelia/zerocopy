"""Audit Boolean encoding records without invoking any benchmark or verifier.

Usage: python independent-review.py DOWNLOAD_RESULTS REPOSITORY OUTPUT_JSON
Requires scipy for an independently calculated Student-t quantile.
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
proof = repository / 'proofs/list-boolean-encoding-20261108'
BASELINE = 'a4265a0608ec25eec5719496225212db6b251989'
fixture_cache = {}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def json_hash(value):
    return sha(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12), (actual, expected)


def load(name):
    path = records_path / (name + '.json')
    if not path.exists(): path = path.with_suffix('.json.gz')
    raw = path.read_bytes()
    if path.suffix == '.gz': raw = gzip.decompress(raw)
    return json.loads(raw), sha(raw)


def canonical(value):
    if isinstance(value, float):
        if math.isnan(value): return ['NaN']
        if value == 0 and math.copysign(1, value) < 0: return ['-0']
        if value == math.inf: return ['+Infinity']
        if value == -math.inf: return ['-Infinity']
    return value


def fixture(spec):
    """Independent reconstruction of all prefix and appended values."""
    key = json.dumps(spec, separators=(',', ':'))
    if key in fixture_cache: return fixture_cache[key]
    special = [math.nan, -0.0, math.inf, -math.inf, 5e-324, -5e-324]

    def value(index, is_prefix=False):
        kind = spec['type']
        if kind == 'boolean': return index % 5 == 0 if is_prefix else index % 3 == 0 or index % 7 == 2
        if kind == 'number': return special[(index // 127) % 6] if index % 127 == 0 else index + .25
        if kind == 'string': return f'{"prefix" if is_prefix else "value"}/é/界/🙂/{index}'
        assert kind == 'object'
        return {'id': -index - 1 if is_prefix else index,
                'flags': [index % 2 == 0, index % 3 == 0], 'point': [index, index + .25]}

    prefix = [value(i, True) for i in range(spec['prefix'])]
    incoming = [value(i) for i in range(spec['count'])]
    expected = prefix + incoming
    primary_digest = json_hash({'spec': spec, 'expected': [canonical(item) for item in expected]})
    result = prefix, incoming, expected, primary_digest
    fixture_cache[key] = result
    return result


def distributions(run, minimum_ms, repetitions, verified_field, verification_offset=0):
    warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
    assert len(warm) >= 8 and sum(warm) >= minimum_ms and len(samples) == 9
    assert all(math.isfinite(ms) and ms > 0 for ms in warm + samples)
    estimate = stats.median(samples) / repetitions
    close(run['medianMs'], estimate)
    assert run[verified_field] == (len(warm) + len(samples)) * repetitions + verification_offset
    return estimate


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


def paired(record, expected_processes):
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete' and 'failure' not in record
    mode, method, runs = record['mode'], record['method'], record['runs']
    cases, pairs = method['cases'], method['pairs']
    assert len(runs) == expected_processes == len(cases) * pairs * 4
    assert pairs == {'formal': 6, 'aa': 4, 'pilot': 2}[mode]
    warmup = 150 if mode == 'pilot' else 500
    assert method['minimumWarmupMs'] == warmup and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'].isdigit()
    assert record['study']['baseline'] == record['source']['before']['commit'] == BASELINE
    assert record['study']['changedSources'] == ['arena.ts'] and record['study']['changedWasm'] == []
    assert len(record['summary']) == len(cases) * 2
    schedule = []
    for pair in range(pairs):
        for runtime in (['node', 'bun'] if pair % 2 == 0 else ['bun', 'node']):
            for spec in (cases if pair % 2 == 0 else cases[::-1]):
                for variant in (['before', 'after'] if pair % 2 == 0 else ['after', 'before']):
                    schedule.append((pair, runtime, spec['name'], variant))
    actual_schedule = [(r['pair'], r['runtime'], r['caseName'], r['variant']) for r in runs]
    assert actual_schedule == schedule and len(set(schedule)) == len(runs)
    estimates, versions = {}, {}
    for run in runs:
        spec = next(s for s in cases if s['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert not run['stderr'] and run['executable'] == method['runtimes'][run['runtime']]
        prefix, incoming, expected, digest = fixture(spec)
        assert run['expectedDigest'] == digest
        details = run['fixture']
        assert details['type'] == spec['type'] and details['sourceCount'] == len(prefix)
        assert details['appendCount'] == len(incoming) and details['resultCount'] == len(expected)
        assert len(details['sourceHash']) == 64
        if not prefix: assert details['sourceHash'] == sha(b'')
        versions.setdefault(run['runtime'], run['versions'])
        assert versions[run['runtime']] == run['versions']
        key = (run['pair'], run['runtime'], run['caseName'], run['variant'])
        estimates[key] = distributions(run, warmup, spec['repetitions'], 'verifiedOutputs')
        timing = run['batchTiming']
        close(timing['minimumObservedMs'], min(run['warmupBatchMs'] + run['sampleBatchMs']))
        close(timing['minimumMeasuredMs'], min(run['sampleBatchMs']))
        assert timing['measuredBelow2ms'] == sum(ms < 2 for ms in run['sampleBatchMs'])
        assert timing['warmupBelow2ms'] == sum(ms < 2 for ms in run['warmupBatchMs'])
    rows = []
    for row in record['summary']:
        before, after, ratios = [], [], []
        for pair in range(pairs):
            b = estimates[pair, row['runtime'], row['name'], 'before']
            a = estimates[pair, row['runtime'], row['name'], 'after']
            point = row['points'][pair]
            assert point['pair'] == pair
            close(point['before'], b); close(point['after'], a); close(point['ratio'], a / b)
            before.append(b); after.append(a); ratios.append(a / b)
            matched = [r for r in runs if r['pair'] == pair and r['runtime'] == row['runtime'] and r['caseName'] == row['name']]
            assert matched[0]['fixture'] == matched[1]['fixture']
        logs = [math.log(r) for r in ratios]
        center = stats.mean(logs)
        ratio, interval = math.exp(center), None
        close(row['pairedRatio'], ratio)
        close(row['beforeMs'], stats.median(before)); close(row['afterMs'], stats.median(after))
        assert row['fasterPairs'] == sum(r < 1 for r in ratios)
        if pairs > 2:
            width = t.ppf(.975, pairs - 1) * stats.stdev(logs) / math.sqrt(pairs)
            interval = [math.exp(center - width), math.exp(center + width)]
            for actual, expected in zip(row['interval95'], interval): close(actual, expected)
        else:
            assert row['interval95'] is None
        classification = ('pilot-only' if interval is None else 'faster' if interval[1] < 1 else
                          'slower' if interval[0] > 1 else 'inconclusive')
        rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                     'beforeMs': stats.median(before), 'afterMs': stats.median(after),
                     'pairedRatio': ratio, 'interval95': interval, 'fasterPairs': sum(r < 1 for r in ratios),
                     'changePercent': (ratio - 1) * 100, 'classification': classification})
    assert set(record['snapshots']) == {'arena.ts'}
    for name, variants in record['snapshots'].items():
        for variant, text in variants.items():
            assert sha(text.encode()) == record['source'][variant]['sources'][name]
    assert record['source']['before']['wasm'] == record['source']['after']['wasm']
    for field, filename in [('driver', 'paired-benchmark.mjs'), ('workload', 'workloads.mjs')]:
        assert sha((proof / filename).read_bytes()) == record[field]['sha256']
    if mode == 'aa':
        for field in ('sources', 'wasm', 'bundles'):
            assert record['source']['before'][field] == record['source']['after'][field]
    else:
        changed = {name for name in record['source']['before']['sources']
                   if record['source']['before']['sources'][name] != record['source']['after']['sources'][name]}
        assert changed == {'arena.ts'}
        for field, directory in [('sources', repository), ('wasm', repository), ('bundles', repository / 'dist')]:
            for name, digest in record['source']['after'][field].items():
                assert sha((directory / name).read_bytes()) == digest, name
    serial_windows(record)
    short_by_case = []
    for runtime in ('node', 'bun'):
        for spec in cases:
            for variant in ('before', 'after'):
                selected = [r for r in runs if r['runtime'] == runtime and r['caseName'] == spec['name'] and r['variant'] == variant]
                samples = [ms for r in selected for ms in r['sampleBatchMs']]
                short = sum(ms < 2 for ms in samples)
                if short: short_by_case.append({'runtime': runtime, 'name': spec['name'], 'variant': variant,
                                               'measuredBatchesBelow2ms': short, 'minimumMeasuredBatchMs': min(samples)})
    return {'processes': len(runs), 'measuredBatches': len(runs) * 9,
            'warmupBatches': sum(len(r['warmupBatchMs']) for r in runs),
            'verifiedOutputs': sum(r['verifiedOutputs'] for r in runs),
            'measuredBatchesBelow2ms': sum(ms < 2 for r in runs for ms in r['sampleBatchMs']),
            'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
            'warmupBatchesBelow2ms': sum(ms < 2 for r in runs for ms in r['warmupBatchMs']),
            'shortMeasuredBatchesByCase': short_by_case, 'rows': rows}


def reference(record, primary):
    assert record['schema'] == 'zerocopy-boolean-list-comparison/v1'
    assert record['status'] == 'complete' and record['mode'] == 'measure'
    method, runs = record['method'], record['runs']
    cases, libraries = method['cases'], method['libraries']
    assert method['rounds'] == 3 and len(cases) == 4 and len(runs) == 72
    assert libraries == ['shared', 'immutable', 'native']
    assert method['minimumWarmupMs'] == 250 and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'] == primary['host']['affinity']
    schedule = []
    for round_index in range(3):
        for runtime in (['node', 'bun'] if round_index % 2 == 0 else ['bun', 'node']):
            for name in (cases if round_index % 2 == 0 else cases[::-1]):
                for position in range(3):
                    schedule.append((round_index, runtime, name, position, libraries[(round_index + position) % 3]))
    actual_schedule = [(r['round'], r['runtime'], r['caseName'], r['position'], r['library']) for r in runs]
    assert actual_schedule == schedule and len(set(schedule)) == 72
    estimates = {}
    strategies = {'shared': 'SharedList.pushMany(input)', 'immutable': 'Immutable.List.concat(input)', 'native': 'source.concat(input)'}
    for run in runs:
        spec = next(s for s in primary['method']['cases'] if s['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert spec['type'] == 'boolean' and spec['kind'] == 'bulk'
        assert run['expectedDigest'] == json_hash(fixture(spec)[2])
        assert run['strategy'] == strategies[run['library']]
        assert run['fullResultAndRetainedSourceVerified'] is True and run['smoke'] is False
        assert run['immutableVersion'] == ('5.1.9' if run['library'] == 'immutable' else None)
        assert run['versions'] == next(r['versions'] for r in primary['runs'] if r['runtime'] == run['runtime'])
        estimate = distributions(run, 250, spec['repetitions'], 'verifiedResults', 1)
        close(run['minimumMeasuredBatchMs'], min(run['sampleBatchMs']))
        estimates[run['round'], run['runtime'], run['caseName'], run['library']] = estimate
    assert len(record['summary']) == 24
    comparisons = []
    for row in record['summary']:
        values = [estimates[i, row['runtime'], row['caseName'], row['library']] for i in range(3)]
        assert row['processes'] == 3
        for actual, expected in zip(row['processEstimates'], values): close(actual, expected)
        close(row['medianMs'], stats.median(values))
    for runtime in ['node', 'bun']:
        for name in cases:
            medians = {library: stats.median([estimates[i, runtime, name, library] for i in range(3)]) for library in libraries}
            comparisons.append({'runtime': runtime, 'name': name, 'medianMs': medians,
                                'sharedOverImmutable': medians['shared'] / medians['immutable'],
                                'sharedOverNative': medians['shared'] / medians['native']})
    identity = record['identity']
    assert identity['sources'] == {'arena.ts': primary['source']['after']['sources']['arena.ts']}
    assert identity['wasm'] == primary['source']['after']['wasm']['persistent-core.wasm']
    assert identity['bundle'] == primary['source']['after']['bundles']['shared.js']
    assert identity['workload'] == primary['workload']['sha256']
    assert identity['comparison'] == sha((proof / 'compare.mjs').read_bytes())
    short = {library: sum(ms < 2 for r in runs if r['library'] == library for ms in r['sampleBatchMs']) for library in libraries}
    return {'processes': len(runs), 'measuredBatches': len(runs) * 9,
            'verifiedResults': sum(r['verifiedResults'] for r in runs),
            'measuredBatchesBelow2ms': sum(short.values()), 'shortBatchesByLibrary': short,
            'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
            'equalFixturesAndRepetitions': True, 'independentlyReconstructedFixtureDigests': True,
            'sourceAndBundleIdentityMatchPrimary': True, 'fullSourceAndResultAssertionsReviewed': True,
            'fairWholeBatchStrategies': 'SharedList.pushMany, persistent Immutable.List.concat, and one native Array.concat; original and all final outputs retained.',
            'qualification': 'Three process medians per arm; no paired confidence intervals. Per-process start/end timestamps and Immutable module hashes are not recorded by this supplementary harness.',
            'rows': comparisons}


formal, formal_sha = load('formal')
aa, aa_sha = load('aa')
pilot, pilot_sha = load('pilot-v2')
supplement, supplement_sha = load('reference-comparison')
assert formal['source']['before'] == aa['source']['before'] == aa['source']['after']
assert formal['source'] == pilot['source']
primary_review = paired(formal, 312)
aa_review = paired(aa, 64)
pilot_review = paired(pilot, 48)
reference_review = reference(supplement, formal)
gains = [row for row in primary_review['rows'] if row['role'] != 'control' and row['classification'] == 'faster']
inconclusive = [row for row in primary_review['rows'] if row['classification'] == 'inconclusive']
negative = [row for row in primary_review['rows'] if row['changePercent'] > 0]
control_gains = [row for row in primary_review['rows'] if row['role'] == 'control' and row['classification'] == 'faster']
report = {
    'schema': 'zerocopy-boolean-encoding-independent-review/v1',
    'reviewedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'passed': True, 'retimed': False,
    'method': 'Independent Python fixture reconstruction, source/build/hash checks, schedules, sample medians, paired ratios and Student-t intervals; no use of the repository verifier.',
    'reviewerScriptSha256': sha(pathlib.Path(__file__).read_bytes()), 'scipyVersion': scipy.__version__,
    'rawRecordSha256': {'formal.json': formal_sha, 'aa.json': aa_sha, 'pilot-v2.json': pilot_sha, 'reference-comparison.json': supplement_sha},
    'primary': primary_review, 'sameBuild': aa_review, 'pilot': pilot_review, 'referenceComparison': reference_review,
    'supportedNonControlCases': [{'runtime': r['runtime'], 'name': r['name'], 'pairedRatio': r['pairedRatio'], 'interval95': r['interval95']} for r in gains],
    'negativePointEstimates': [{'runtime': r['runtime'], 'name': r['name'], 'changePercent': r['changePercent'], 'classification': r['classification']} for r in negative],
    'inconclusiveCases': [{'runtime': r['runtime'], 'name': r['name'], 'pairedRatio': r['pairedRatio'], 'interval95': r['interval95']} for r in inconclusive],
    'unchangedControlGains': control_gains,
    'conclusions': [
        'The clearest cross-runtime scoped gain is appending 262,144 booleans: Node ratio 0.7712 (0.7155–0.8312), Bun 0.6097 (0.4881–0.7615).',
        'All six eligible Node cases have unadjusted intervals below 1, but prefix 31 is borderline at upper endpoint 0.9984 and should not anchor a broad claim.',
        'Bun supports gains for 262,144 booleans and a 32-value prefix; its 32,768/32,769 empty-source cases and prefix 31/65 cases are inconclusive.',
        'No formal interval lies wholly above 1. Negative point estimates remain visible; inconclusive intervals do not establish zero regression.',
        'The unchanged Node scalar-push control appears 4.9% faster with interval below 1; this is control variation and must not be credited to the Boolean bulk encoding path.',
        'All eight same-build control intervals include 1. The report uses unadjusted per-workload intervals and does not establish a universal gain.',
        'All 63 formal measured batches below 2 ms belong to the Bun string control (30 before, 33 after); eligible Boolean targets have no short measured batches. The reference comparison has 84 short native-Array batches.',
        'The supplementary whole-append comparison uses equal inputs, repetitions and retention. Native Array.concat is faster than SharedList in every reported context; comparisons remain separate from the paired before/after claim.',
        'Recorded output accounting and assertion coverage were audited; timed outputs are not stored for independent replay. No benchmark was rerun.',
    ],
}
assert not any(r['classification'] == 'slower' for r in primary_review['rows'])
assert all(r['classification'] == 'inconclusive' for r in aa_review['rows'])
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('x') as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2); handle.write('\n')
print(json.dumps({'passed': True, 'output': str(output),
                  'primary': {k: v for k, v in primary_review.items() if k != 'rows'},
                  'sameBuild': {k: v for k, v in aa_review.items() if k != 'rows'},
                  'pilot': {k: v for k, v in pilot_review.items() if k != 'rows'},
                  'referenceComparison': {k: v for k, v in reference_review.items() if k != 'rows'},
                  'supportedNonControlCases': report['supportedNonControlCases'],
                  'negativePointEstimates': report['negativePointEstimates'], 'conclusions': report['conclusions']}, ensure_ascii=False, indent=2))
