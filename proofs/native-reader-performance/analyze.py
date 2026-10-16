"""METHOD-v2 full-sample paired analysis. Only standard-library, no subjects.

This module consumes controller-authenticated observations. It never treats a
driver's echoed sourceAuthenticated flag as evidence. Standalone use requires
the controller's verified final seal and external expected seal hash.
"""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import math
from pathlib import Path
import statistics

from specification import (ARMS, CAP_COUNTS, COLD, COMPONENT_ROWS, ENGINES, PRIMARY,
                           ROWS, SEQUENCE, T_CRITICAL, calibration_row, checksum,
                           count_valid, digest, positive, require)


def _mean(values):
    return statistics.fmean(values)


def cv(values):
    return statistics.stdev(values) / _mean(values) if len(values) > 1 else 0.0


def batch_quality(batches, field='elapsedMs'):
    values = [b.get(field) for b in batches]
    reasons = []
    if len(values) != 7 or not all(positive(v) for v in values):
        return {'qualified': False, 'reasons': ['requires seven finite positive measured batches']}
    per_operation = [value / batch['count'] for value, batch in zip(values, batches)]
    variation = cv(per_operation)
    drift = _mean(per_operation[-3:]) / _mean(per_operation[:3])
    if any(value < 20 for value in values):
        reasons.append('at least one aggregate batch below 20 ms')
    if variation > .20:
        reasons.append('seven-batch sample CV above 20%')
    if not .90 <= drift <= 1.10:
        reasons.append('last-three/first-three mean ratio outside [0.90,1.10]')
    return {'qualified': not reasons, 'reasons': reasons, 'sampleCV': variation,
            'lastThreeFirstThree': drift, 'minimumAggregateMs': min(values)}


def cold_quality(values):
    if len(values) != 12 or not all(positive(v) for v in values):
        return {'qualified': False, 'reasons': ['requires twelve finite positive cold events']}
    variation = cv(values)
    drift = _mean(values[-6:]) / _mean(values[:6])
    reasons = []
    if variation > .25:
        reasons.append('within-arm block sample CV above 25%')
    if not .90 <= drift <= 1.10:
        reasons.append('last-six/first-six mean ratio outside [0.90,1.10]')
    return {'qualified': not reasons, 'reasons': reasons, 'sampleCV': variation,
            'lastSixFirstSix': drift}


def paired_interval(numerator, denominator):
    require(len(numerator) == len(denominator) == 12, 'paired analysis requires all twelve blocks')
    require(all(positive(v) for v in numerator + denominator), 'paired analysis requires finite positive observations')
    ratios = [n/d for n,d in zip(numerator,denominator)]
    logs = [math.log(ratio) if positive(ratio) else math.log(n)-math.log(d)
            for ratio,n,d in zip(ratios,numerator,denominator)]
    center = _mean(logs)
    sd = statistics.stdev(logs)
    half = T_CRITICAL*sd/math.sqrt(12)
    # Log bounds remain evidence if exp would overflow; JSON never emits Infinity.
    def exponent(value):
        try:
            return math.exp(value)
        except OverflowError:
            return None
    return {'n': 12, 'df': 11, 'tCritical': T_CRITICAL, 'logRatios': logs,
            'blockRatios': [exponent(value) for value in logs],
            'meanLogRatio': center, 'sampleSDLogRatio': sd,
            'ratio': exponent(center), 'lower': exponent(center-half), 'upper': exponent(center+half),
            'logLower': center-half, 'logUpper': center+half}


def blocking_bias(interval):
    return interval['logLower'] > math.log(1.02) or interval['logUpper'] < math.log(.98)


def validate_source_bytes(before, after, expected=None):
    require(type(before) is dict and before.get('passed') is True and before == after, 'source bytes changed or missing')
    arenas = before.get('arenas')
    require(type(arenas) is list and len(arenas) == 26, 'fixture must have exactly 26 independent source arenas')
    import re
    for index,arena in enumerate(arenas):
        require(type(arena) is dict and arena.get('index') == index and type(arena.get('used')) is int and
                type(arena.get('capacity')) is int and 0 < arena['used'] <= arena['capacity'] <= 2**20 and
                type(arena.get('sha256')) is str and re.fullmatch('[a-f0-9]{64}',arena['sha256']), 'invalid source-byte evidence')
    require(sum(a['capacity'] for a in arenas) <= 8*2**20, 'total source-byte capacity cap')
    if expected is not None:
        require(arenas == expected, 'row/cold source bytes differ from fixture manifest')


def validate_row(row, report_row, mode, counts=None, source_manifest=None):
    """Authenticate scalar arithmetic and exact batch selection independently."""
    require(type(report_row) is dict and report_row.get('valueValid') is True, 'row not value-valid: '+row)
    validate_source_bytes(report_row.get('initialSourceBytes'),report_row.get('finalSourceBytes'),source_manifest)
    validations = report_row.get('validations')
    require(type(validations) is list and validations and all(type(v) is dict and v.get('passed') is True for v in validations),
            'missing or failed row validation: '+row)
    batches = report_row.get('batches')
    require(type(batches) is list and batches, 'missing batches: '+row)
    previous_end = None
    for index, batch in enumerate(batches):
        require(type(batch) is dict and batch.get('validated') is True and batch.get('index') == index, 'batch validation/index: '+row)
        count = batch.get('count')
        require(count_valid(row, count), 'invalid batch count: '+row)
        require(batch.get('elapsedMs') is None if mode == 'mechanism' else positive(batch.get('elapsedMs')),
                'unexpected mechanism timer or invalid main duration: '+row)
        start, end = batch.get('startVariant'), batch.get('endVariant')
        require(type(start) is int and start in (0, 1) and type(end) is int and end in (0, 1), 'batch variants: '+row)
        expected_end = 1-start if row in ('P8','P1','C8','F8') and count % 2 == 0 else start
        require(end == expected_end, 'alternating final variant: '+row)
        if index and row in ('P8','P1','C8','F8'):
            require(start == 1-batches[index-1]['endVariant'], 'alternation discontinuity: '+row)
        if row == 'R8':
            require(start == end == 0, 'R8 must retain V0')
        if row == 'W8':
            require(start == end == report_row.get('retainedVariant'), 'W8 retained variant')
        actual_expected = checksum(row, count, start, report_row.get('initialVersion'))
        require(type(batch.get('checksum')) in (int, float) and batch['checksum'] == actual_expected,
                'independent checksum mismatch: '+row)
        require(batch.get('expectedChecksum') == actual_expected, 'declared oracle mismatch: '+row)
        first, last = batch.get('sequenceStart'), batch.get('sequenceEnd')
        require(type(first) is int and type(last) is int and first >= 0 and last-first == count,
                'batch operation sequence: '+row)
        require(previous_end is None or first == previous_end, 'batch operation sequence discontinuity: '+row)
        require(index != 0 or first == 0, 'row operation offset must start at zero')
        before_variant = batch.get('beforeVariant')
        require(type(before_variant) is int and before_variant in (0,1) and
                start == (1-before_variant if row in COMPONENT_ROWS else before_variant), 'recorded before variant mismatch')
        session_first,session_last = batch.get('sessionSequenceStart'),batch.get('sessionSequenceEnd')
        require(type(session_first) is int and type(session_last) is int and session_first >= 0 and
                session_last-session_first == (count if row in COMPONENT_ROWS else 0), 'wire session sequence mismatch')
        if index:
            require(session_first == batches[index-1]['sessionSequenceEnd'], 'wire session sequence discontinuity')
        else:
            require(session_first == (1 if row == 'P8' else report_row.get('initialVersion') if row in ('N8','W8') else 0),
                    'unexpected first wire sequence')
            if row in COMPONENT_ROWS:
                require(start == (0 if row == 'P8' else 1), 'unexpected first publication target variant')
        if row in ('N8','W8'):
            require(start == end == report_row.get('retainedVariant'), 'unchanged retained variant mismatch')
        fields = {'row':row,**{key:batch[key] for key in ('count','beforeVariant','startVariant','endVariant','sequenceStart','sequenceEnd',
                                                        'sessionSequenceStart','sessionSequenceEnd')}}
        require(batch.get('sequenceReceiptSHA256') == digest(fields), 'batch sequence receipt hash mismatch')
        previous_end = last
    require(len(validations) >= len(batches)+1, 'before-row/after-batch validation schedule incomplete: '+row)
    if mode == 'calibration':
        return calibration_row(row, batches, report_row.get('calibration'))
    if mode == 'mechanism':
        require(len(batches) == 1 and batches[0].get('stage') == 'mechanism' and batches[0].get('trial') is None and
                batches[0]['count'] == (2 if row in ('N8','W8') else 1), 'mechanism row lifecycle mismatch')
        return batches
    require(mode in ('rehearsal', 'measurement'), 'unexpected batch lifecycle')
    require(len(batches) == 10 and [b.get('stage') for b in batches] == ['warmup']*3+['measured']*7,
            'exact three warm-up/seven measured batch lifecycle: '+row)
    require(all(b.get('trial') is None for b in batches), 'unexpected measurement trial')
    require(counts is not None and count_valid(row, counts.get(row)) and all(b['count'] == counts[row] for b in batches),
            'frozen count mismatch: '+row)
    return batches[3:]


def validate_cold(report):
    require(report.get('coldValueValid') is True, 'cold value validation missing')
    evidence = report.get('coldReceipt', {})
    expected = {'initialVersion':0,'firstChangedVersion':1,'initialChecksum':19312,'firstChangedChecksum':19313,
                'firstEligibleReuse':True,'validated':True}
    require(all(evidence.get(key) == value for key,value in expected.items()), 'first eligible cold reuse evidence missing')
    validate_source_bytes(report.get('coldSourceBytesBefore'),report.get('coldSourceBytesAfter'),report.get('fixture', {}).get('sourceByteManifest'))


def validate_retained_context(report,row):
    if row not in ('N8','W8'):
        return
    p8 = report['rows']['P8']['batches']
    require(p8 and all(count_valid('P8',b.get('count')) for b in p8), 'retained P8 operation evidence missing')
    current = report['rows'][row]
    require(current.get('initialVersion') == 1+sum(b['count'] for b in p8) and
            current.get('retainedVariant') == p8[-1]['endVariant'], 'retained control differs from final P8 view')


def validate_report(report, group, counts=None):
    require(report.get('schemaVersion') == 1 and report.get('status') == 'complete', 'group report incomplete')
    require(report.get('workerCount') == 1 and report.get('valueValid') is True and not report.get('failures'), 'group value/worker failure')
    require(report.get('disposed') is True and report.get('workerTerminated') is True, 'group teardown missing')
    validate_cold(report)
    require(set(report.get('cold', {})) == set(COLD), 'cold event set mismatch')
    if group['mode'] == 'mechanism':
        require(report.get('untimed') is True and all(report['cold'][name] is None for name in COLD), 'mechanism preflight must remain untimed')
    else:
        require(all(positive(report['cold'][name]) for name in COLD), 'invalid cold duration')
    fixture = report.get('fixture', {})
    for field, cap in [('sourceArenaCount', 32), ('totalCommittedBytes', 8*2**20), ('maxArenaCommittedBytes', 2**20)]:
        require(type(fixture.get(field)) is int and 0 < fixture[field] <= cap, 'fixture resource cap: '+field)
    require(fixture.get('publicArenaCountsVerified') is True and fixture.get('sourceBytesStable') is True, 'fixture authentication missing')
    protocol = report.get('protocol', {})
    require(protocol.get('realWorker') is True and protocol.get('workerRoute') == 'node:worker_threads', 'real worker route missing')
    require(protocol.get('rowOrder') == list(ROWS) and protocol.get('sequential') is True, 'row/publication order mismatch')
    require(protocol.get('ackBeforeApplicationResponse') is True or protocol.get('bothAcknowledgementsAwaited') is True, 'ack ordering missing')
    require(protocol.get('countsVerified') is True and protocol.get('orderingVerified') is True and protocol.get('snapshotsN8') == 0,
            'protocol counts/order/no-message control missing')
    phases = report.get('phases', {})
    require(all(type(phases.get(name)) in (int, float) and math.isfinite(phases[name]) and phases[name] >= 0
                for name in ('setupMs','validationMs','teardownMs')), 'phase timing evidence missing')
    require(set(report.get('rows', {})) == set(ROWS), 'row set mismatch')
    results = {row: validate_row(row, report['rows'][row], group['mode'], counts,fixture.get('sourceByteManifest')) for row in ROWS}
    for row in ('N8','W8'):
        validate_retained_context(report,row)
    require(all((batch.get(field) is None if group['mode'] == 'mechanism' else positive(batch.get(field)))
                for row in COMPONENT_ROWS for batch in report['rows'][row]['batches']
                for field in ('acceptanceMs','queryMs')), 'invalid receiver component duration')
    wire = protocol.get('rowCounts', {})
    require(set(wire) == set(COMPONENT_ROWS), 'per-session protocol receipts missing')
    application_responses = 1
    for row in COMPONENT_ROWS:
        operations = sum(b['count'] for b in report['rows'][row]['batches'])
        application_responses += operations
        snapshots = operations + (2 if row == 'P8' else 1)
        state = wire[row]
        require(state.get('passed') is True and state.get('snapshots') == state.get('acks') == snapshots and
                state.get('lastSequence') == snapshots-1, 'per-session snapshot/ack count mismatch: '+row)
        require(state.get('copyFrames') == (snapshots if row == 'C8' else 0), 'copy transport count mismatch: '+row)
        require(state.get('fullMemoryFrames') == (snapshots if row == 'F8' else 0 if row == 'C8' else 1),
                'complete Memory frame count mismatch: '+row)
        require(state.get('omittedKnownMemoryFrames') == (snapshots-1 if row in ('P8','P1') else 0),
                'known Memory omission count mismatch: '+row)
    require(protocol.get('applicationResponses') == application_responses, 'application response count mismatch')
    if group['mode'] == 'mechanism':
        expected = {'initialP8': 8, 'laterP8': 0 if group['arm'] == 'C' else 8,
                    'laterP1': 0 if group['arm'] == 'C' else 1, 'R8': 8, 'C8': 8, 'F8': 8}
        require(report.get('mechanism', {}).get('passed') is True and report['mechanism'].get('checks') == expected,
                'mechanism instantiation evidence mismatch')
        require(all(report['rows'][row].get('initialNativeInstances') == count for row,count in [('P1',1),('C8',8),('F8',8)]),
                'initial fallback instantiation mismatch')
        return None
    if group['mode'] == 'calibration':
        require(report.get('counts') == {row: results[row]['count'] for row in ROWS}, 'reported calibrated count mismatch')
    else:
        require(report.get('counts') == counts, 'reported frozen count mismatch')
    return results


def endpoint_names():
    return ([f'{row}.elapsedMs' for row in ROWS] +
            [f'{row}.{field}' for row in COMPONENT_ROWS for field in ('acceptanceMs', 'queryMs')] +
            ['cold.'+name for name in COLD])


def analyze(observations, calibration, complete=False):
    """Keep partial/wrong-value data in diagnostics, never in an interval.

    observations: controller records {group, report, authenticated, counts}.
    The controller sets authenticated after matching artifact/runtime/source hashes;
    the report's similarly named boolean is deliberately ignored.
    """
    selected = {}
    duplicates = set()
    errors = []
    for observation in observations:
        group = observation['group']
        if group['mode'] != 'measurement':
            continue
        key = (group['engine'], group['block'], group['arm'])
        index = group.get('processOrder')
        if type(index) is not int or index not in range(len(SEQUENCE)) or group != SEQUENCE[index]:
            duplicates.add(key)  # A relabeled/out-of-order observation is unavailable.
        if key in selected:
            duplicates.add(key)
        selected[key] = observation
    endpoints = {}
    for engine in ENGINES:
        engine_results = {}
        for endpoint in endpoint_names():
            row, field = endpoint.split('.')
            values = {arm: [] for arm in ARMS}
            qualities = {arm: [] for arm in ARMS}
            source_value_valid = True
            missing = []
            for block in range(1,13):
                for arm in ARMS:
                    key = (engine, block, arm)
                    observation = selected.get(key)
                    try:
                        require(key not in duplicates and observation is not None, 'missing or duplicate process')
                        require(observation.get('authenticated') is True, 'source not authenticated by controller')
                        report = observation['report']
                        if row == 'cold':
                            validate_cold(report)
                            value = report['cold'][field]
                            require(positive(value), 'nonfinite or nonpositive cold endpoint')
                        else:
                            validate_retained_context(report,row)
                            batches = validate_row(row, report['rows'][row], 'measurement', observation['counts'],
                                                   report.get('fixture',{}).get('sourceByteManifest'))
                            require(all(positive(b.get(field)) for b in batches), 'nonfinite or nonpositive repeated endpoint')
                            value = _mean([b[field]/b['count'] for b in batches])
                            qualities[arm].append(batch_quality(batches,field))
                        values[arm].append(value)
                    except (ValueError, KeyError, TypeError, OverflowError) as error:
                        source_value_valid = False
                        missing.append({'block':block,'arm':arm,'reason':str(error)})
            result = {'engine': engine, 'endpoint': endpoint, 'unit': 'milliseconds' if row == 'cold' else 'milliseconds/operation',
                      'sourceValueValidFullSample': source_value_valid, 'valuesByArmInBlockOrder': values,
                      'unavailable': missing, 'status': 'unresolved', 'veto': False}
            # Auxiliary A availability gates favorable inference, not existing
            # adverse evidence from all twelve authenticated B/C block pairs.
            candidate_baseline_valid = all(len(values[arm]) == 12 for arm in ('B','C'))
            result['candidateBaselineSourceValueValidFullSample'] = candidate_baseline_valid
            if candidate_baseline_valid:
                cb = paired_interval(values['C'], values['B'])
                veto = cb['logLower'] > math.log(1.02)
                result.update(candidateBaseline=cb, veto=veto)
                if veto:
                    result['status'] = 'adverse-veto'
            if source_value_valid:
                if row == 'cold':
                    qualities = {arm: cold_quality(values[arm]) for arm in ARMS}
                    qualified = all(q['qualified'] for q in qualities.values())
                    calibrated = True
                else:
                    qualified = all(q['qualified'] for arm in ARMS for q in qualities[arm])
                    calibrated = calibration.get(engine, {}).get(row, {}).get('qualified') is True
                ab = paired_interval(values['A'], values['B'])
                earlier, later = [], []
                for block in range(1,13):
                    a = selected[(engine,block,'A')]['group']['processOrder']
                    b = selected[(engine,block,'B')]['group']['processOrder']
                    early, late = ('A','B') if a < b else ('B','A')
                    earlier.append(values[early][block-1]); later.append(values[late][block-1])
                chronological = paired_interval(later,earlier)
                bias = blocking_bias(ab) or blocking_bias(chronological)
                result.update(candidateBaseline=cb, secondBaselineBaseline=ab, laterEarlierBaseline=chronological,
                              arithmeticMeanLatencyByArm={arm:_mean(v) for arm,v in values.items()},
                              qualityByArm=qualities, qualityQualified=qualified, calibrated=calibrated,
                              ownBaselineBias=bias, veto=veto)
                if veto:
                    result['status'] = 'adverse-veto'
                elif qualified and calibrated and not bias and cb['logUpper'] <= math.log(1.02):
                    result['status'] = 'provisionally-clear'
            engine_results[endpoint] = result
        n8_bias = engine_results['N8.elapsedMs'].get('ownBaselineBias', False)
        for row in PRIMARY:
            primary = engine_results[row+'.elapsedMs']
            primary['n8BaselineBias'] = n8_bias
            if n8_bias and primary['status'] != 'adverse-veto':
                primary['status'] = 'unresolved'
            primary['promisingWithinEngine'] = bool(primary.get('sourceValueValidFullSample') and primary.get('qualityQualified')
                and primary.get('calibrated') and not primary.get('ownBaselineBias') and not n8_bias
                and primary['candidateBaseline']['logUpper'] <= math.log(.95))
        endpoints[engine] = engine_results
    vetoes = [{'engine':engine,'endpoint':name} for engine,results in endpoints.items() for name,result in results.items() if result['veto']]
    leads = [row for row in PRIMARY if all(endpoints[engine][row+'.elapsedMs']['promisingWithinEngine'] for engine in ENGINES)]
    complete = bool(complete and not duplicates and len(selected) == 72 and all(
        result['sourceValueValidFullSample'] for results in endpoints.values() for result in results.values()))
    return {'schemaVersion':1, 'screenComplete':complete, 'independentUnit':'paired block', 'n':12,
            'endpoints':endpoints, 'adverseVetoes':vetoes,
            'qualifiedPrimaryRows': leads if complete and not vetoes else [],
            'decision': 'veto-unchanged-candidate' if vetoes else 'promising-scoped-lead' if complete and leads else 'no-lead',
            'incompleteWithAdverseEvidence': bool(vetoes and not complete),
            'performanceClaimAuthorized':False,
            'auditRequired':'Independent reconstruction and unchanged-rule audit required before any performance claim.',
            'limitations':['No engine pooling, deletion, replacement, resampling, or batch-as-replicate analysis.',
                          'Provisional clearance is not general no-regression or release readiness.',
                          'Small-sample paired intervals cannot eliminate shared-host confounding.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--expected-seal-sha256', required=True)
    args = parser.parse_args()
    from authentication import verify_final_seal, read_json
    verify_final_seal(args.evidence, args.expected_seal_sha256)
    raw = read_json(args.evidence/'observations.json')
    result = analyze(raw['observations'], raw['calibration'], raw['complete'])
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
