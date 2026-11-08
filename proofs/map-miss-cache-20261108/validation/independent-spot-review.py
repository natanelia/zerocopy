#!/usr/bin/env python3
"""Independent, untimed numerical spot audit; requires Python 3 and scipy.

Usage: independent-spot-review.py RECORDS_DIR CANDIDATE_REPO BASELINE_REPO OUTPUT_JSON
This does not execute the benchmark driver, its verifier, or any timed operation.
"""
import datetime as dt
import gzip
import hashlib
import json
import math
import pathlib
import statistics as stats
import sys
from scipy.stats import t

records_dir, candidate, baseline, output = map(pathlib.Path, sys.argv[1:])
proof = candidate / 'proofs/map-miss-cache-20261108'
BASELINE = 'a4265a0608ec25eec5719496225212db6b251989'
CANDIDATE = '2671a2b19725758f749280d9b0dedfde645baf2b'
CASE_NAMES = ['get-repeated-ascii-16', 'has-repeated-ascii-128', 'get-repeated-unicode-128',
              'get-short-repeated-misses', 'get-cold-misses', 'get-short-cold-misses',
              'get-cold-hits', 'get-streaming-misses', 'get-over-budget-misses', 'get-mixed',
              'get-alternating-roots', 'get-warm-hits', 'get-warm-hits-after-miss', 'has-warm-hits']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12), (actual, expected)


def load(name):
    path = records_dir / (name + '.json')
    if not path.exists():
        path = records_dir / (name + '.json.gz')
    raw = path.read_bytes()
    if path.suffix == '.gz':
        raw = gzip.decompress(raw)
    return json.loads(raw), sha(raw)


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


records, raw_hashes = {}, {}
for name in ('formal', 'aa', 'pilot'):
    records[name], raw_hashes[name] = load(name)
formal = records['formal']
assert formal['source']['before']['commit'] == BASELINE
assert formal['source']['after']['commit'] == CANDIDATE
identity_counts = {}
for side, repository in [('before', baseline), ('after', candidate)]:
    identity_counts[side] = {}
    for kind in ('sources', 'wasm', 'bundles'):
        directory = repository / 'dist' if kind == 'bundles' else repository
        identity_counts[side][kind] = len(formal['source'][side][kind])
        for filename, digest in formal['source'][side][kind].items():
            assert sha((directory / filename).read_bytes()) == digest, (side, kind, filename)


def audit(name, record):
    runs, method = record['runs'], record['method']
    pairs = {'formal': 6, 'aa': 4, 'pilot': 2}[name]
    cases = method['cases']
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete' and 'failure' not in record
    assert record['mode'] == name and method['pairs'] == pairs
    assert [spec['name'] for spec in cases] == CASE_NAMES
    assert len(runs) == 14 * pairs * 4
    assert method['minimumWarmupMs'] == 500 and method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'].isdigit()
    for kind in ('sources', 'wasm', 'bundles'):
        assert record['source']['before'][kind] == formal['source']['before'][kind]
        assert record['source']['after'][kind] == formal['source']['before' if name == 'aa' else 'after'][kind]
    assert record['source']['before']['wasm'] == record['source']['after']['wasm']
    assert record['study']['changedSources'] == ['arena.ts'] and record['study']['changedWasm'] == []
    assert set(record['snapshots']) == {'arena.ts'}
    for side, content in record['snapshots']['arena.ts'].items():
        assert sha(content.encode()) == record['source'][side]['sources']['arena.ts']
    for field, filename in [('driver', 'paired-benchmark.mjs'), ('workload', 'workloads.mjs')]:
        assert sha((proof / filename).read_bytes()) == record[field]['sha256']
    expected_schedule = [(pair, runtime, spec['name'], variant)
                         for pair in range(pairs)
                         for runtime in (['node', 'bun'] if pair % 2 == 0 else ['bun', 'node'])
                         for spec in (cases if pair % 2 == 0 else cases[::-1])
                         for variant in (['before', 'after'] if pair % 2 == 0 else ['after', 'before'])]
    assert expected_schedule == [(r['pair'], r['runtime'], r['caseName'], r['variant']) for r in runs]
    estimates, late, versions, fixtures = {}, [], {}, {}
    last_end = timestamp(record['startedAt'])
    for run in runs:
        spec = next(s for s in cases if s['name'] == run['caseName'])
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert not run['stderr'] and run['executable'] == method['runtimes'][run['runtime']]
        versions.setdefault(run['runtime'], run['versions'])
        assert versions[run['runtime']] == run['versions']
        fixtures.setdefault(run['caseName'], (run['fixture'], run['expectedDigest']))
        assert fixtures[run['caseName']] == (run['fixture'], run['expectedDigest'])
        warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
        assert len(warm) >= 8 and sum(warm) >= 500 and len(samples) == 9
        assert all(math.isfinite(ms) and ms > 0 for ms in warm + samples)
        assert len(warm) == 8 or sum(warm[:-1]) < 500
        estimate = stats.median(samples) / spec['repetitions']
        close(estimate, run['medianMs'])
        assert run['verifiedOutputs'] == (len(warm) + len(samples)) * spec['repetitions']
        close(run['batchTiming']['minimumObservedMs'], min(warm + samples))
        close(run['batchTiming']['minimumMeasuredMs'], min(samples))
        assert run['batchTiming']['measuredBelow2ms'] == sum(ms < 2 for ms in samples)
        assert run['batchTiming']['warmupBelow2ms'] == sum(ms < 2 for ms in warm)
        estimates[run['pair'], run['runtime'], run['caseName'], run['variant']] = estimate
        late_warm = stats.median(samples) / stats.median(warm[-9:])
        late_samples = stats.median(samples[-3:]) / stats.median(samples[:3])
        if abs(late_warm - 1) > .20 or abs(late_samples - 1) > .20:
            late.append({'pair': run['pair'], 'runtime': run['runtime'], 'name': run['caseName'],
                         'variant': run['variant'], 'sampleMedianOverLastNineWarmupMedian': late_warm,
                         'lastThreeSamplesOverFirstThreeSamples': late_samples})
        start, end = timestamp(run['startedAt']), timestamp(run['completedAt'])
        assert start >= last_end and end >= start
        assert sum(warm + samples) <= (end - start) * 1000 + 1
        last_end = end
    assert timestamp(record['completedAt']) >= last_end
    assert [(r['runtime'], r['name']) for r in record['summary']] == [
        (runtime, spec['name']) for runtime in ('node', 'bun') for spec in cases]
    rows = []
    for row in record['summary']:
        before = [estimates[p, row['runtime'], row['name'], 'before'] for p in range(pairs)]
        after = [estimates[p, row['runtime'], row['name'], 'after'] for p in range(pairs)]
        ratios = [a / b for a, b in zip(after, before)]
        assert len(row['points']) == pairs
        for pair, point in enumerate(row['points']):
            assert point['pair'] == pair
            close(point['before'], before[pair]); close(point['after'], after[pair]); close(point['ratio'], ratios[pair])
        logs = [math.log(r) for r in ratios]
        center = stats.mean(logs)
        ratio = math.exp(center)
        close(ratio, row['pairedRatio'])
        close(stats.median(before), row['beforeMs']); close(stats.median(after), row['afterMs'])
        assert row['fasterPairs'] == sum(r < 1 for r in ratios)
        interval = None
        if pairs > 2:
            halfwidth = t.ppf(.975, pairs - 1) * stats.stdev(logs) / math.sqrt(pairs)
            interval = [math.exp(center - halfwidth), math.exp(center + halfwidth)]
            for actual, expected in zip(row['interval95'], interval):
                close(actual, expected)
        else:
            assert row['interval95'] is None
        rows.append({'runtime': row['runtime'], 'name': row['name'],
                     'beforeMs': stats.median(before), 'afterMs': stats.median(after),
                     'pairedRatio': ratio, 'changePercent': (ratio - 1) * 100,
                     'interval95': interval, 'fasterPairs': sum(r < 1 for r in ratios), 'pairs': pairs,
                     'classification': 'pilot-only' if interval is None else 'faster' if interval[1] < 1 else
                                       'slower' if interval[0] > 1 else 'inconclusive'})
    samples = [ms for run in runs for ms in run['sampleBatchMs']]
    return {'rawSha256': raw_hashes[name], 'processes': len(runs), 'measuredBatches': len(samples),
            'verifiedOutputs': sum(r['verifiedOutputs'] for r in runs),
            'measuredBatchesBelow2ms': sum(ms < 2 for ms in samples), 'minimumMeasuredBatchMs': min(samples),
            'runsWithoutStrategyField': sum('strategy' not in r for r in runs),
            'processesWithOver20PercentLateMovement': len(late), 'lateMovement': late, 'rows': rows}


audits = {name: audit(name, record) for name, record in records.items()}
aa_excluding_one = [row for row in audits['aa']['rows'] if row['classification'] != 'inconclusive']
report = {
    'passed': True, 'decision': 'reject-miss-cache-no-pr',
    'method': 'Independent Python recomputation from retained batch samples using SciPy Student-t quantiles; no repository verifier or timing execution.',
    'baselineCommit': BASELINE, 'candidateCommit': CANDIDATE,
    'currentFrozenSourceBuildHashesMatch': True, 'identityFileCounts': identity_counts,
    'driverSha256': formal['driver']['sha256'], 'workloadSha256': formal['workload']['sha256'],
    'allThreeStudiesComplete': True, 'aaUsesIdenticalSourceWasmAndBundles': True,
    'records': audits, 'aaIntervalsExcludingOne': aa_excluding_one,
    'lateMovementDefinition': 'A process is counted once when abs(median(all9samples)/median(last9warmup)-1)>0.20 OR abs(median(last3samples)/median(first3samples)-1)>0.20. All samples remain in the estimates.',
    'knownHostedAuditFailure': 'The frozen verifier required run.strategy, which the frozen driver never records. All 672 processes finished before that metadata assertion failed. No raw fields were repaired or timing repeated for this audit.',
    'limitations': [
        'This spot review checks fixture identity consistency across all processes; the separate primary independent review reconstructs semantic fixtures.',
        'Successful scalar assertions eagerly construct error-message strings outside the timer. Their allocations may affect later GC or warmup; these records do not establish the direction or cause of such effects.',
        'A/A has three unadjusted intervals excluding 1, including a large apparent Bun warm-has improvement. It is not a correction factor, and wide controls do not establish zero regression.',
        'Student-t intervals are unadjusted across workloads; the two-pair pilot is descriptive only.',
        'Late movement identifies changes in the raw sequences, not a diagnosis of JIT, GC, scheduling, or other causes.',
        'Fresh-cache setup is outside timing. Query strings are precreated, and streaming strings are reused across separately reset batches.',
    ],
    'conclusion': 'Repeated ASCII/Unicode misses and mixed reads improve, but automatic read paths incur large repeatable cold, short-key, streaming, budget-full, and alternating-root regressions. These broad costs justify rejection without retiming or another candidate.',
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
print(json.dumps({'passed': True, 'decision': report['decision'], 'processes': {
    name: result['processes'] for name, result in audits.items()},
    'aaIntervalsExcludingOne': len(aa_excluding_one), 'output': str(output)}, indent=2))
