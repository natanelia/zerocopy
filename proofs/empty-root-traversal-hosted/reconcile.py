"""Retained JSON comparison only. Does not import either subject."""
from pathlib import Path
import hashlib
import json
import copy

root = Path(__file__).resolve().parent
expected = json.loads((root / 'EXPECTED.json').read_text())
reports, pins = {}, []
def empty_checks(kind):
    projections = ['entries', 'keys', 'values'] if kind == 'map' else ['values']
    return {'kind': kind, 'root': 0, 'size': 0,
            'projections': {name: [] for name in projections}, 'forEachCalls': 0,
            'iterators': [{'method': method, 'firstNext': {'done': True}, 'afterFirstNext': {'done': True},
                           'returnBeforeNext': {'done': True, 'value': 17}, 'afterReturn': {'done': True},
                           'throwBeforeNextSameError': True, 'afterThrow': {'done': True}}
                          for method in ['leaves', *projections]]}

def check_empty_boundaries(group):
    assert set(group) == {'name', 'rows', 'borrowed', 'lazyErrors', 'malformed', 'direct',
                          'retainedNonemptySnapshots', 'rootRatherThanSize', 'nonzeroFirstNextViewReads'}
    assert group['name'] == 'empty-public-boundaries'
    assert group['rows'] == [{'name': name, 'kind': kind, 'checks': empty_checks(kind)}
                             for name, kind in expected['mainEmptyCases']]
    borrowed = [{'kind': 'map', 'method': method, 'trace': ['arena-get', 'leaves-get', 'root-get', ['leaves-call', 0]], 'callbacks': 0}
                for method in ['entries', 'keys', 'values', 'forEach']]
    borrowed += [{'kind': 'set', 'method': method,
                  'trace': (['values-get'] if method == 'forEach' else []) + ['map-get', 'keys-get', 'keys-call', 'arena-get', 'root-get'], 'callbacks': 0}
                 for method in ['values', 'forEach']]
    assert group['borrowed'] == borrowed
    lazy_errors = [{'kind': kind, 'method': method, 'firstNextGetterReads': 1, 'closedBeforeNextReads': 0, 'thrownBeforeNextReads': 0}
                   for kind, methods in [('map', ['entries', 'keys', 'values']), ('set', ['values'])] for method in methods]
    lazy_errors += [{'kind': kind, 'method': 'forEach', 'synchronousGetterReads': 1, 'callbacks': 0} for kind in ['map', 'set']]
    assert group['lazyErrors'] == lazy_errors
    malformed = []
    for kind, methods in [('map', ['entries', 'keys', 'values']), ('set', ['values'])]:
        malformed += [{'kind': kind, 'method': method, 'error': 'RangeError', 'firstNext': True} for method in methods]
        malformed.append({'kind': kind, 'method': 'forEach', 'error': 'RangeError', 'callbacks': 0})
    assert group['malformed'] == malformed
    assert group['direct'] == [{'label': label, 'completed': True, 'viewReads': 0} for label in ['zero', 'negative-zero', 'nan']]
    assert group['retainedNonemptySnapshots'] is True and group['rootRatherThanSize'] is True
    assert group['nonzeroFirstNextViewReads'] == 1

def identity_view(value):
    """Validate retained real IDs, then alias only those IDs for cross-process comparison."""
    result = copy.deepcopy(value)
    for worker in result['workers']:
        diagnostic = worker['transportDiagnostics']
        assert set(diagnostic) == {'structureIDs', 'observedStructureIDs', 'stages'}
        stages = diagnostic['stages']; assert [row['stage'] for row in stages] == ['attach', 'pause', 'resume']
        initial = stages[0]['expected']; ids = [row['id'] for row in initial]
        assert len(ids) == len(set(ids)) == 3 and all(isinstance(id, str) for id in ids)
        aliases = {id: slot for slot, id in enumerate(ids)}
        structures = diagnostic['structureIDs']
        assert [row[0] for row in structures] == expected['workerSnapshots']
        assert all(len(row) == 2 for row in structures) and {row[1] for row in structures} == set(ids)
        assert diagnostic['observedStructureIDs'] == structures
        initial_by_id = {row['id']: row for row in initial}
        for number, stage in enumerate(stages):
            assert set(stage) == {'stage', 'expected', 'observed'}
            by_side = {}
            for side in ['expected', 'observed']:
                rows = stage[side]
                assert len(rows) == len(ids) and {row['id'] for row in rows} == set(ids)
                assert all(set(row) == {'id', 'capacity', 'used', 'prefixSHA256'} for row in rows)
                by_side[side] = {row['id']: row for row in rows}
            assert by_side['expected'] == by_side['observed'], stage
            for id, row in by_side['observed'].items():
                first = initial_by_id[id]
                assert row['used'] == first['used'] and row['prefixSHA256'] == first['prefixSHA256']
                assert row['capacity'] == first['capacity'] + (0 if worker['copy'] else number * 65536)
            for side in ['expected', 'observed']:
                stage[side] = [{**row, 'id': aliases[row['id']]} for row in stage[side]]
        diagnostic['structureIDs'] = [[name, aliases[id]] for name, id in structures]
        diagnostic['observedStructureIDs'] = [[name, aliases[id]] for name, id in diagnostic['observedStructureIDs']]
    return result

for engine in ['bun-source', 'node-portable']:
    for arm in ['baseline', 'candidate']:
        path = root / 'execution' / f'{engine}-{arm}.json'
        raw = path.read_bytes(); value = json.loads(raw)
        assert set(value) == {'schema', 'kind', 'engine', 'groups', 'workers'}
        assert value['schema'] == 1 and value['kind'] == 'empty-root-traversal-correctness' and value['engine'] == engine
        assert [group['name'] for group in value['groups']] == expected['groups']
        cases = value['groups'][0]['results']
        assert [item['name'] for item in cases] == expected['shapeCases']
        by_name = {item['name']: item for item in cases}
        for name in ['empty', 'single', 'canonical-large', 'collision', 'canonical-old']:
            assert by_name[name]['shape']['overlayNodes'] == []
        assert len(by_name['canonical-large']['pointers']) == 4096
        assert by_name['collision']['shape']['collisionCount'] == 1
        assert by_name['journal']['shape']['journalDepth'] == 1 and by_name['nested-journal']['shape']['journalDepth'] == 2
        shape = by_name['late-repeated-overlay']['shape']
        assert shape['leavesBeforeFirstOverlay'] == 1 and len(set(shape['overlayNodes'])) >= 2
        assert [(item['fixture'], item['mode']) for item in value['groups'][2]['observations']] == [
            ('late', 'full'), ('late', 'close'), ('late', 'getter-error'), ('late', 'decoder-error'), ('nested-journal', 'full')]
        check_empty_boundaries(value['groups'][3])
        if engine == 'node-portable':
            assert [item['copy'] for item in value['workers']] == [False, True]
            for item in value['workers']:
                assert item['workerThread'] and item['snapshots'] == len(item['result']) == expected['snapshotsPerWorker']
                assert list(item['result']) == expected['workerSnapshots']
                assert item['frozenObjects'] and item['readOnlyRejections'] == expected['snapshotsPerWorker'] and item['allocatedSharedBytes'] == 0
                assert item['readerObservedWriterGrowth'] == (not item['copy']) and item['interleavedIteratorsPerMap'] == 2
                assert item['shape']['leavesBeforeFirstOverlay'] == 1 and len(set(item['shape']['overlayNodes'])) >= 2
                stages = item['emptyIterationChecks']
                assert [(stage['stage'], stage['createdAt']) for stage in stages] == [tuple(row) for row in expected['workerEmptyStages']]
                wanted = [{'name': name, **empty_checks(kind)} for name, kind in expected['workerEmptyCases']]
                for stage in stages:
                    assert set(stage) == {'stage', 'createdAt', 'results'}
                    assert stage['results'] == wanted
                for name, _ in expected['workerEmptyCases']:
                    assert item['result'][name] == []
            assert value['workers'][0]['result'] == value['workers'][1]['result']
            assert value['workers'][0]['emptyIterationChecks'] == value['workers'][1]['emptyIterationChecks']
        else:
            assert value['workers'] == []
        reports[engine, arm] = value
        pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    assert identity_view(reports[engine, 'baseline']) == identity_view(reports[engine, 'candidate']), engine
assert reports['bun-source', 'baseline']['groups'] == reports['node-portable', 'baseline']['groups']

names = []
for arm in ['baseline', 'candidate']:
    path = root / 'execution' / f'tests-{arm}.json'; raw = path.read_bytes(); tests = json.loads(raw)
    assert tests['success'] and tests['numTotalTests'] == tests['numPassedTests'] == expected['testCount']
    assert tests['numFailedTests'] == tests['numPendingTests'] == tests.get('numTodoTests', 0) == 0
    actual = {Path(item['name']).name: sorted(row['title'] for row in item['assertionResults']) for item in tests['testResults']}
    assert actual == expected['titlesByFile']
    assert all(row['status'] == 'passed' for item in tests['testResults'] for row in item['assertionResults'])
    names.append(sorted(row['fullName'] for item in tests['testResults'] for row in item['assertionResults']))
    pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
assert names[0] == names[1] and len(names[0]) == expected['testCount']
result = {'schema': 1, 'kind': 'empty-root-traversal-reconciliation', 'passed': True, 'groups': expected['groups'],
          'commonGroupsPerEngineArm': len(expected['groups']), 'realNodeWorkerCasesPerArm': 2, 'snapshotsPerWorker': expected['snapshotsPerWorker'],
          'existingTestsPerArm': expected['testCount'], 'withinEngineReportsEqual': True, 'crossEngineSemanticGroupsEqual': True,
          'rawArenaIdentityDiagnosticsValidated': True, 'identityDiagnosticsComparedByPayloadSlot': True,
          'rawReports': pins}
with (root / 'execution/reconciliation.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
