"""Independent Map evidence audit. No benchmark, build or runtime is invoked.

Usage: python independent-review.py DOWNLOAD_RESULTS REPOSITORY OUTPUT_JSON
Accepts plain or gzip records. Requires scipy for Student-t quantiles.
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import math
import pathlib
import re
import statistics as stats
import sys

import scipy
from scipy.stats import t

records_path, repository, output = map(pathlib.Path, sys.argv[1:])
proof = repository / 'proofs/map-batch-delete-direct-20261108'
BASELINE = 'a4265a0608ec25eec5719496225212db6b251989'
CHANGED_SOURCES = {'arena.ts', 'persistent-core.as.ts', 'shared-map.ts'}
CORE_ALIASES = {'persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm',
                'linked-list.wasm', 'singly-linked-list.wasm', 'doubly-linked-list.wasm',
                'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm'}
ALL_CASES = [
    'delete-100-of-4096', 'delete-1000-of-8192', 'delete-4096-of-8192',
    'delete-cold-1000-of-8192', 'delete-unicode-1000-of-8192', 'delete-32-control',
    'delete-511-boundary', 'delete-512-boundary', 'delete-1-control', 'delete-empty-control',
    'delete-missing-1000', 'delete-late-hits-1000', 'delete-sparse-hits-1000',
    'delete-dense-prefix-missing-1000', 'delete-duplicate-1000', 'delete-all-4096',
    'get-many-control', 'set-one-control',
]
PILOT_CASES = ['delete-4096-of-8192', 'delete-cold-1000-of-8192', 'delete-511-boundary',
               'delete-512-boundary', 'delete-missing-1000', 'delete-late-hits-1000',
               'delete-sparse-hits-1000', 'delete-dense-prefix-missing-1000']
AA_CASES = ['delete-4096-of-8192', 'delete-1-control']
REFERENCE_CASES = ['delete-100-of-4096', 'delete-1000-of-8192', 'delete-4096-of-8192']
fixture_cache = {}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12), (actual, expected)


def load(name):
    path = records_path / (name + '.json')
    if not path.exists(): path = path.with_suffix('.json.gz')
    raw = path.read_bytes()
    if path.suffix == '.gz': raw = gzip.decompress(raw)
    return json.loads(raw), sha(raw)


def json_hash(value):
    return sha(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())


def canonical(value):
    if isinstance(value, float):
        if math.isnan(value): return ['NaN']
        if value == 0 and math.copysign(1, value) < 0: return ['-0']
        if value == math.inf: return ['+Infinity']
        if value == -math.inf: return ['-Infinity']
    return value


def fnv_utf8(text):
    """FNV-1a computed independently with exact unsigned 32-bit arithmetic."""
    value = 2166136261
    for byte in text.encode('utf-8'):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value


def trie_order(key_hash):
    # The HAMT compares low four-bit digits first, not ordinary integer order.
    return tuple((key_hash >> shift) & 15 for shift in range(0, 32, 4))


def fixture(spec):
    """Reconstruct source values, exact requests and all expected public values."""
    cache_key = json.dumps(spec, separators=(',', ':'))
    if cache_key in fixture_cache: return fixture_cache[cache_key]
    count, requested, pattern, kind = (spec[k] for k in ('count', 'requested', 'pattern', 'kind'))
    special = [math.nan, -0.0, math.inf, -math.inf, 5e-324, sys.float_info.max]

    def key_at(index):
        return ('路/é/🙂/' if spec.get('unicode', False) else 'lane/') + str(index).zfill(5)

    initial = [[key_at(i), special[(i // 257) % 6] if i % 257 == 0 else i + .25] for i in range(count)]
    hashes = {key: fnv_utf8(key) for key, _ in initial}
    assert len(hashes) == len(set(hashes.values())) == count
    keys = []
    for i in range(requested):
        missing = (pattern == 'missing' or pattern == 'late-hits' and i < 32 or
                   pattern == 'sparse-hits' and i % 16 != 0 or pattern == 'dense-prefix-missing' and i >= 32)
        if missing: key = f'missing/{i}'
        elif pattern == 'duplicate': key = key_at(7)
        elif pattern == 'all': key = key_at(i)
        else: key = key_at((i * 8191) % count)
        keys.append(key)
    model = dict(initial)
    remaining_probe = set(model)
    probe_hits = 0
    for key in keys[:32]:
        if key in remaining_probe:
            probe_hits += 1
            remaining_probe.remove(key)
    if kind == 'delete':
        for key in keys: model.pop(key, None)
    elif kind == 'set':
        model[key_at(0)] = -99.5
    else:
        assert kind == 'get'
    expected = [[key, value] for key, value in sorted(model.items(), key=lambda item: trie_order(hashes[item[0]]))]
    reads = [model.get(key) for key in keys]
    expected_wire = ([canonical(value) for value in reads] if kind == 'get' else
                     [[key, canonical(value)] for key, value in expected])
    source_wire = [[key, canonical(value)] for key, value in initial]
    result = {
        'expectedDigest': json_hash(expected_wire),
        'sourceFixtureDigest': json_hash({'initial': source_wire, 'keys': keys, 'expected': expected_wire}),
        'resultCount': len(reads) if kind == 'get' else len(expected),
        'initialCount': len(initial), 'requestedCount': len(keys), 'distinctRequests': len(set(keys)),
        'removedCount': count - len(model) if kind == 'delete' else 0,
        'first32ActualRemovals': probe_hits if kind == 'delete' else None,
        'qualifiesForGroupedRemainder': kind == 'delete' and requested >= 512 and probe_hits >= 16 and count > probe_hits,
        'sourceConstruction': ('one independent new arena and source per operation, all built outside timed batch'
                               if spec.get('mode') == 'cold' else
                               'one new arena/source per timed batch; repeated operations fork that same immutable source'),
    }
    fixture_cache[cache_key] = result
    return result


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


def distributions(run, minimum_ms, repetitions, recorded_count=True):
    warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
    assert len(warm) >= 8 and sum(warm) >= minimum_ms and len(samples) == 9
    assert all(math.isfinite(ms) and ms > 0 for ms in warm + samples)
    estimate = stats.median(samples) / repetitions
    close(run['medianMs'], estimate)
    if recorded_count:
        assert run['verifiedOutputs'] == (len(warm) + len(samples)) * repetitions
    return estimate


def paired(record, expected_processes):
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete' and 'failure' not in record
    mode, method, runs = record['mode'], record['method'], record['runs']
    cases, pairs = method['cases'], method['pairs']
    expected_names = {'formal': ALL_CASES, 'aa': AA_CASES, 'pilot': PILOT_CASES}[mode]
    assert [spec['name'] for spec in cases] == expected_names
    assert len(runs) == expected_processes == len(cases) * pairs * 4
    assert pairs == {'formal': 6, 'aa': 4, 'pilot': 2}[mode]
    warmup = 150 if mode == 'pilot' else 500
    assert method['minimumWarmupMs'] == warmup and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'].isdigit()
    assert record['study']['baseline'] == record['source']['before']['commit'] == BASELINE
    assert set(record['study']['changedSources']) == CHANGED_SOURCES
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
        independent = fixture(spec)
        assert run['expectedDigest'] == independent['expectedDigest'], spec['name']
        details = run['fixture']
        for key in ('kind', 'count', 'requested', 'pattern'): assert details[key] == spec[key]
        assert details['unicode'] == spec.get('unicode', False)
        assert details['resultCount'] == independent['resultCount']
        assert details['sourceConstruction'] == independent['sourceConstruction']
        assert re.fullmatch('[0-9a-f]{64}', details['sourceHash'])
        expected_operation = {'get': 'source.getMany(keys)', 'set': 'source.set(key0, -99.5)', 'delete': 'source.deleteMany(keys)'}
        assert details['timedOperation'] == expected_operation[spec['kind']]
        versions.setdefault(run['runtime'], run['versions'])
        assert versions[run['runtime']] == run['versions']
        key = (run['pair'], run['runtime'], run['caseName'], run['variant'])
        estimates[key] = distributions(run, warmup, spec['repetitions'])
        timing = run['batchTiming']
        close(timing['minimumObservedMs'], min(run['warmupBatchMs'] + run['sampleBatchMs']))
        close(timing['minimumMeasuredMs'], min(run['sampleBatchMs']))
        assert timing['measuredBelow2ms'] == sum(ms < 2 for ms in run['sampleBatchMs'])
        assert timing['warmupBelow2ms'] == sum(ms < 2 for ms in run['warmupBatchMs'])
    rows = []
    for row in record['summary']:
        spec = next(s for s in cases if s['name'] == row['name'])
        assert row['role'] == spec['role']
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
        logs = [math.log(ratio) for ratio in ratios]
        center = stats.mean(logs)
        ratio, interval = math.exp(center), None
        close(row['pairedRatio'], ratio)
        close(row['beforeMs'], stats.median(before)); close(row['afterMs'], stats.median(after))
        assert row['fasterPairs'] == sum(value < 1 for value in ratios)
        if pairs > 2:
            width = t.ppf(.975, pairs - 1) * stats.stdev(logs) / math.sqrt(pairs)
            interval = [math.exp(center - width), math.exp(center + width)]
            for actual, expected in zip(row['interval95'], interval): close(actual, expected)
        else:
            assert row['interval95'] is None
        classification = ('pilot-only' if interval is None else 'faster' if interval[1] < 1 else
                          'slower' if interval[0] > 1 else 'inconclusive')
        rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                     'sourceMode': 'independent source per operation' if spec.get('mode') == 'cold' else 'repeated forks',
                     'beforeMs': stats.median(before), 'afterMs': stats.median(after),
                     'pairedRatio': ratio, 'interval95': interval, 'fasterPairs': sum(value < 1 for value in ratios),
                     'changePercent': (ratio - 1) * 100, 'classification': classification})
    assert set(record['snapshots']) == CHANGED_SOURCES
    for name, variants in record['snapshots'].items():
        for variant, text in variants.items():
            assert sha(text.encode()) == record['source'][variant]['sources'][name]
    for identity in record['source'].values():
        assert all(identity['wasm'][name] == identity['wasm']['persistent-core.wasm'] for name in CORE_ALIASES)
    for field, filename in [('driver', 'paired-benchmark.mjs'), ('workload', 'workloads.mjs')]:
        assert sha((proof / filename).read_bytes()) == record[field]['sha256']
    if mode == 'aa':
        for field in ('sources', 'wasm', 'bundles'):
            assert record['source']['before'][field] == record['source']['after'][field]
    else:
        for field, expected_changed in [('sources', CHANGED_SOURCES), ('wasm', CORE_ALIASES)]:
            assert set(record['source']['before'][field]) == set(record['source']['after'][field])
            changed = {name for name in record['source']['before'][field]
                       if record['source']['before'][field][name] != record['source']['after'][field][name]}
            assert changed == expected_changed
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
    assert record['schema'] == 'zerocopy-map-delete-comparison/v1'
    assert record['status'] == 'complete' and record['mode'] == 'measure'
    method, runs = record['method'], record['runs']
    cases, libraries = method['cases'], method['libraries']
    assert method['rounds'] == 3 and cases == REFERENCE_CASES and len(runs) == 54
    assert libraries == ['shared', 'immutable', 'native']
    assert method['warmupMs'] == 250 and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'] == primary['host']['affinity']
    schedule = []
    for round_index in range(3):
        for runtime in (['node', 'bun'] if round_index % 2 == 0 else ['bun', 'node']):
            for name in (cases if round_index % 2 == 0 else cases[::-1]):
                for position in range(3):
                    schedule.append((round_index, runtime, name, position, libraries[(round_index + position) % 3]))
    actual_schedule = [(r['round'], r['runtime'], r['caseName'], r['position'], r['library']) for r in runs]
    assert actual_schedule == schedule and len(set(schedule)) == 54
    estimates, inferred_verified = {}, 0
    strategies = {'shared': 'SharedMap.deleteMany(keys)',
                  'immutable': 'source.withMutations(draft => keys.forEach(k => draft.delete(k)))',
                  'native': 'one new Map(source), followed by every requested delete'}
    for run in runs:
        spec = next(s for s in primary['method']['cases'] if s['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert spec['kind'] == 'delete' and spec['pattern'] == 'spread'
        assert run['expectedDigest'] == fixture(spec)['expectedDigest']
        assert run['strategy'] == strategies[run['library']]
        assert run['fullResultAndRetainedSourceVerified'] is True and run['smoke'] is False
        assert run['immutableVersion'] == ('5.1.9' if run['library'] == 'immutable' else None)
        assert run['versions'] == next(r['versions'] for r in primary['runs'] if r['runtime'] == run['runtime'])
        estimate = distributions(run, 250, spec['repetitions'], False)
        estimates[run['round'], run['runtime'], run['caseName'], run['library']] = estimate
        inferred_verified += (len(run['warmupBatchMs']) + len(run['sampleBatchMs'])) * spec['repetitions'] + 1
    assert len(record['summary']) == 18
    comparisons = []
    for row in record['summary']:
        values = [estimates[i, row['runtime'], row['caseName'], row['library']] for i in range(3)]
        assert row['processes'] == 3
        for actual, expected in zip(row['processEstimates'], values): close(actual, expected)
        close(row['medianMs'], stats.median(values))
    for runtime in ('node', 'bun'):
        for name in cases:
            medians = {library: stats.median([estimates[i, runtime, name, library] for i in range(3)]) for library in libraries}
            comparisons.append({'runtime': runtime, 'name': name, 'medianMs': medians,
                                'sharedOverImmutable': medians['shared'] / medians['immutable'],
                                'sharedOverNative': medians['shared'] / medians['native']})
    assert record['sources'] == {name: primary['source']['after']['sources'][name] for name in CHANGED_SOURCES}
    assert record['wasm'] == primary['source']['after']['wasm']['persistent-core.wasm']
    short = {library: sum(ms < 2 for r in runs if r['library'] == library for ms in r['sampleBatchMs']) for library in libraries}
    return {'processes': len(runs), 'measuredBatches': len(runs) * 9,
            'inferredVerifiedResultsFromLoopCounts': inferred_verified,
            'measuredBatchesBelow2ms': sum(short.values()), 'shortBatchesByLibrary': short,
            'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
            'equalFixturesAndRepetitions': True, 'independentlyReconstructedFixtureDigests': True,
            'sourceAndWasmHashesMatchPrimary': True, 'fullSourceAndResultAssertionsReviewed': True,
            'inspectedComparisonHarnessSha256': sha((proof / 'compare.mjs').read_bytes()),
            'fairWholeBatchStrategies': 'One SharedMap.deleteMany call, one Immutable.Map.withMutations session, or one native new Map(source) followed by all requested deletes; source and all final results retained.',
            'qualification': 'Three process medians per arm without confidence intervals. This supplementary record stores source/core-WASM hashes but does not independently record the imported bundle, harness/workload hashes, per-process timestamps, Immutable module hashes, or verified-output counts. Inferred counts are labelled separately from primary recorded counts.',
            'rows': comparisons}


formal, formal_sha = load('formal')
aa, aa_sha = load('aa')
pilot, pilot_sha = load('pilot-v3')
supplement, supplement_sha = load('reference-comparison')
assert formal['source']['before'] == aa['source']['before'] == aa['source']['after']
assert formal['source'] == pilot['source']
primary_review = paired(formal, 432)
aa_review = paired(aa, 32)
pilot_review = paired(pilot, 64)
reference_review = reference(supplement, formal)
rows = primary_review['rows']
supported = [r for r in rows if r['role'] in ('target', 'boundary') and r['classification'] == 'faster']
regressions = [r for r in rows if r['classification'] == 'slower']
inconclusive = [r for r in rows if r['classification'] == 'inconclusive']
negative = [r for r in rows if r['changePercent'] > 0]
controls = [r for r in rows if r['role'] == 'control' and r['classification'] != 'inconclusive']
diagnostics = [{'name': spec['name'], **fixture(spec)} for spec in formal['method']['cases']]
report = {
    'schema': 'zerocopy-map-delete-independent-review/v1',
    'reviewedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'passed': True, 'retimed': False,
    'method': 'Independent Python reconstruction of UTF-8 FNV-1a hashes, low-nibble HAMT order, exact special values and request shapes; SHA-256 provenance, schedules, medians, paired ratios and Student-t intervals. No repository verifier or benchmark is invoked.',
    'reviewerScriptSha256': sha(pathlib.Path(__file__).read_bytes()), 'scipyVersion': scipy.__version__,
    'rawRecordSha256': {'formal.json': formal_sha, 'aa.json': aa_sha, 'pilot-v3.json': pilot_sha, 'reference-comparison.json': supplement_sha},
    'primary': primary_review, 'sameBuild': aa_review, 'pilot': pilot_review, 'referenceComparison': reference_review,
    'independentFixtureDiagnostics': diagnostics,
    'supportedTargetAndBoundaryCases': supported, 'clearRegressions': regressions,
    'negativePointEstimates': negative, 'inconclusiveCases': inconclusive, 'nonInconclusiveUnchangedControls': controls,
    'interpretation': [
        'Only explicitly supported workload/runtime combinations establish a gain; all adverse, threshold and unchanged-control rows remain visible.',
        'Independent-source first deletions and repeated-fork throughput are distinct workloads and must not be combined into one claim.',
        'A missing or sparse scalar probe can retain scalar execution; a dense probe followed by misses can incur batching cost. These shapes are independently reconstructed and audited.',
        'Intervals are unadjusted per workload. Inconclusive intervals do not establish zero regression, and unchanged control changes are not attributable to the grouped deletion path.',
        'Primary identities include exact sources, all WASM aliases and portable bundles; the supplementary comparison has the narrower provenance fields stated in its audit section.',
        'Recorded output accounting and assertion coverage were reviewed. Timed output objects are not stored for independent replay; no benchmark was rerun.',
    ],
}
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('x') as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2); handle.write('\n')
print(json.dumps({'passed': True, 'output': str(output),
                  'primary': {k: v for k, v in primary_review.items() if k != 'rows'},
                  'sameBuild': {k: v for k, v in aa_review.items() if k != 'rows'},
                  'pilot': {k: v for k, v in pilot_review.items() if k != 'rows'},
                  'referenceComparison': {k: v for k, v in reference_review.items() if k != 'rows'},
                  'supportedTargetAndBoundaryCases': supported, 'clearRegressions': regressions,
                  'inconclusiveCases': inconclusive, 'nonInconclusiveUnchangedControls': controls}, ensure_ascii=False, indent=2))
