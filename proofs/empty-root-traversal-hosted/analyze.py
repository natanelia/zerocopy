"""Read retained observations; never import or invoke either subject."""
import json
import math
from pathlib import Path
import statistics


def t3_quantile(probability):
    # Exact Student-t(df=3) CDF; a fixed bisection avoids an extra dependency.
    def cdf(value):
        x = value / math.sqrt(3)
        return .5 + (math.atan(x) + x / (1 + x * x)) / math.pi
    lo, hi = 0., 1000.
    assert .5 < probability < cdf(hi)
    for _ in range(100):
        mid = (lo + hi) / 2
        if cdf(mid) < probability:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def analyze(config, observations, directory, gate_usable):
    cells = []
    for engine in config['engines']:
        for endpoint in config['endpoints']:
            selected = [x for x in observations if x['engine'] == engine and x['endpoint'] == endpoint['id']]
            assert len(selected) == 16
            cell = {'engine': engine, 'endpoint': endpoint['id'], 'primary': endpoint['primary'],
                    'observations': selected, 'status': 'unresolved', 'inference': None}
            descriptive = []
            for observation in selected:
                detail = dict(observation)
                if observation.get('output'):
                    try:
                        raw = json.loads((directory / observation['output']).read_text())
                    except (ValueError, UnicodeDecodeError):
                        detail['rawOutputParseFailed'] = True
                        descriptive.append(detail)
                        continue
                    detail['rawStatus'] = raw['status']
                    detail['warmup'] = raw.get('warmup')
                    detail['measurement'] = raw.get('measurement')
                    detail['ledger'] = raw.get('ledger', [])
                    detail['phaseDurations'] = [dict(kind=e['kind'], plannedCalls=e['calls'],
                        completed=e['completed'], validated=e.get('validated', False), durationNs=e.get('elapsedNs'),
                        nsPerCall=(e['elapsedNs'] / e['calls']) if e.get('completed') and e.get('elapsedNs') is not None else None)
                        for e in raw.get('phases', [])]
                    if raw.get('measurement'):
                        m = raw['measurement']
                        detail['durationNs'] = m['elapsedNs']
                        detail['nsPerCall'] = m['elapsedNs'] / m['calls']
                descriptive.append(detail)
            cell['descriptiveEvidence'] = descriptive
            cell['absoluteNsPerTraversal'] = {}
            for arm in config['arms']:
                values = [x['nsPerCall'] for x in descriptive if x['arm'] == arm and 'nsPerCall' in x]
                cell['absoluteNsPerTraversal'][arm] = {'count': len(values), 'values': values,
                    'median': statistics.median(values) if values else None,
                    'mean': statistics.mean(values) if values else None,
                    'sampleStdDev': statistics.stdev(values) if len(values) > 1 else None}

            complete = gate_usable and len(selected) == 16 and all(x['status'] == 'passed' for x in selected)
            if not complete:
                cell['reason'] = 'controller-not-complete-and-authenticated' if not gate_usable else 'requires-all-four-complete-valid-blocks'
                cells.append(cell)
                continue
            ratios, baseline_drift, candidate_drift, blocks = [], [], [], []
            for block in range(4):
                members = [x for x in selected if x['block'] == block]
                groups = {}
                for arm in ['baseline', 'candidate']:
                    arm_members = [x for x in members if x['arm'] == arm]
                    assert len(arm_members) == 2
                    times, counts = [], []
                    for member in arm_members:
                        raw = json.loads((directory / member['output']).read_text())
                        m = raw['measurement']
                        assert raw['status'] == 'passed' and m['elapsedNs'] >= config['measurementMinimumNs']
                        assert raw['warmup']['elapsedNs'] >= config['measurementWarmupMinimumNs']
                        assert len(raw['warmup']['batches']) == config['measurementWarmupBatches']
                        assert all(p['calls'] == m['calls'] // config['measurementWarmupDivisor'] and p['validated'] for p in raw['warmup']['batches'])
                        counts.append(m['calls'])
                        times.append(m['elapsedNs'] / m['calls'])
                    groups[arm] = times
                    assert len(set(counts)) == 1
                assert len({json.loads((directory / m['output']).read_text())['measurement']['calls'] for m in members}) == 1
                a, b = groups['baseline'], groups['candidate']
                log_ratio = statistics.mean(map(math.log, b)) - statistics.mean(map(math.log, a))
                ratios.append(log_ratio)
                baseline_drift.append(abs(math.log(a[1] / a[0])))
                candidate_drift.append(abs(math.log(b[1] / b[0])))
                blocks.append({'block': block, 'baselineNsPerCall': a, 'candidateNsPerCall': b,
                               'logRatio': log_ratio, 'ratio': math.exp(log_ratio)})
            mean = statistics.mean(ratios)
            se = statistics.stdev(ratios) / 2
            typical = max(statistics.median(baseline_drift), statistics.median(candidate_drift))
            pooled = sorted(baseline_drift + candidate_drift)
            tail = pooled[6] + .3 * (pooled[7] - pooled[6])
            stable = typical <= math.log(config['typicalDriftMaximumRatio']) and tail <= math.log(config['tailDriftMaximumRatio'])
            primary_upper_log = mean + t3_quantile(1 - config['primaryAlpha']) * se
            guard_half_width = t3_quantile(1 - config['guardAlpha']) * se
            guard_lower, guard_upper = math.exp(mean - guard_half_width), math.exp(mean + guard_half_width)
            qualifies = endpoint['primary'] and stable and all(r < 0 for r in ratios) and math.exp(primary_upper_log) <= config['primaryMaximumRatio'] and -primary_upper_log > config['gainDriftMultiple'] * typical
            regression = stable and guard_lower > config['guardMaximumRatio']
            control_supported = stable and guard_upper <= config['guardMaximumRatio']
            cell['status'] = 'regression' if regression else 'primary-qualified' if qualifies else 'scoped-guard-supported' if control_supported else 'unresolved'
            cell['inference'] = {'blocks': blocks, 'df': 3, 'meanLogRatio': mean, 'standardError': se,
                                 'geometricRatio': math.exp(mean), 'primaryUpperRatio': math.exp(primary_upper_log),
                                 'pointwiseGuardLowerRatio': guard_lower, 'pointwiseGuardUpperRatio': guard_upper,
                                 'baselineRepeatLogDrift': baseline_drift, 'candidateRepeatLogDrift': candidate_drift,
                                 'typicalLogDrift': typical, 'tailLogDrift': tail, 'stable': stable,
                                 'primaryQualifies': qualifies, 'regression': regression, 'scopedGuardSupported': control_supported}
            cell['descriptiveBlockStatistics'] = {'blocks': blocks, 'geometricRatio': math.exp(mean),
                'medianBlockRatio': statistics.median(map(math.exp, ratios)), 'sampleLogStdDev': statistics.stdev(ratios),
                'baselineRepeatLogDrift': baseline_drift, 'candidateRepeatLogDrift': candidate_drift,
                'typicalLogDrift': typical, 'tailLogDrift': tail, 'stable': stable}
            if not stable:
                cell['inference'] = None
                cell['status'] = 'unresolved'
                cell['reason'] = 'predeclared-repeated-arm-stability-gate'
            cells.append(cell)
    qualifying = [e['id'] for e in config['endpoints'] if e['primary'] and all(
        next(c for c in cells if c['engine'] == engine and c['endpoint'] == e['id'])['inference'] is not None
        and next(c for c in cells if c['engine'] == engine and c['endpoint'] == e['id'])['inference']['primaryQualifies']
        for engine in config['engines'])]
    regressions = [{'engine': c['engine'], 'endpoint': c['endpoint']} for c in cells if c['inference'] and c['inference']['regression']]
    unresolved = [{'engine': c['engine'], 'endpoint': c['endpoint']} for c in cells
                  if c['status'] == 'unresolved' or (c['inference'] and not c['inference']['stable'])]
    return {'schema': 1, 'kind': 'lazy-traversal-timing-analysis', 'methodSHA256': config['methodSHA256'],
            'intervalScope': 'Local modeled Student-t/Bonferroni intervals conditional on independent approximately normal block log ratios; pointwise regression guards do not provide universal clearance.',
            'samePrimaryQualifiesInBothEngines': qualifying, 'regressionsBlockingPromotion': regressions,
            'unresolvedCells': unresolved, 'cells': cells,
            'outcome': 'regression-blocks-promotion' if regressions else 'no-supported-primary' if not qualifying
                       else 'supported-primary-with-unresolved-controls' if unresolved else 'supported-primary-with-scoped-controls',
            'automaticPublicationAuthorized': False}


if __name__ == '__main__':
    import argparse
    import hashlib
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    result = analyze(request['config'], request['observations'], Path(request['directory']), request['gateUsable'])
    result['status'] = 'passed'
    raw = (json.dumps(result, indent=2) + '\n').encode()
    with Path(args.output).open('xb') as stream:
        stream.write(raw)
    print(json.dumps({'status': 'passed', 'outputSHA256': hashlib.sha256(raw).hexdigest()}))
