"""Retained JSON comparison only. Does not import either subject."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
names = ['table-states-and-aliases', 'public-input-trace', 'partial-failure-boundaries', 'reentry-and-set-dispatch', 'collision-and-growth']
reports = {}
pins = []
for engine in ['bun-source', 'node-portable']:
    for arm in ['baseline', 'candidate']:
        path = root / 'execution' / f'{engine}-{arm}.json'
        raw = path.read_bytes(); value = json.loads(raw)
        assert set(value) == {'schema', 'kind', 'engine', 'groups', 'workers'}
        assert value['schema'] == 1 and value['kind'] == 'primitive-bulk-correctness' and value['engine'] == engine
        assert [group['name'] for group in value['groups']] == names
        assert len(value['groups'][0]['results']) == 12
        assert len(value['groups'][1]['observations']) == 5
        assert len(value['groups'][2]['results']) == 7
        assert len(value['groups'][4]['results']) == 3
        if engine == 'node-portable':
            assert [item['copy'] for item in value['workers']] == [False, True]
            assert all(item['collectionCount'] == len(item['results']) == 7 for item in value['workers'])
            assert [item['name'] for item in value['workers'][0]['results']] == ['string-old', 'string-new', 'number-old', 'number-new', 'boolean-old', 'boolean-new', 'set']
            assert value['workers'][0]['results'] == value['workers'][1]['results']
        else:
            assert value['workers'] == []
        reports[engine, arm] = value
        pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    # Within each engine this includes every persistent-byte digest, native used
    # total/capacity/root, callback trace, decoded value and raw error message.
    assert reports[engine, 'baseline'] == reports[engine, 'candidate'], engine

def portable_semantics(value):
    if isinstance(value, dict):
        # Preserve original files. Runtime trap wording and NaN payload bit
        # choices are not cross-engine contracts; within-engine bytes remain exact.
        return {key: portable_semantics(item) for key, item in value.items() if key not in ['runtimeMessage', 'payloadSHA256']}
    if isinstance(value, list):
        return [portable_semantics(item) for item in value]
    return value
assert portable_semantics(reports['bun-source', 'baseline']['groups']) == portable_semantics(reports['node-portable', 'baseline']['groups'])
result = {'schema': 1, 'kind': 'primitive-bulk-reconciliation', 'passed': True, 'groups': names,
          'commonGroupsPerEngineArm': 5, 'realNodeWorkerCasesPerArm': 2, 'snapshotsPerWorker': 7,
          'withinEnginePersistentBytesAndAllocationEqual': True, 'crossEngineSemanticGroupsEqual': True,
          'rawReports': pins}
with (root / 'execution/reconciliation.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
