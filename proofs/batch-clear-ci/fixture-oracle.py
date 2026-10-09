"""Independent deterministic Python fixed-input oracle; never loads the library."""
from pathlib import Path
import json, hashlib
HERE = Path(__file__).resolve().parent
protocol = json.loads((HERE/'protocol.json').read_text())
def number(i):
    value = i*.25-512
    return int(value) if int(value) == value else value
def key(i): return 'key-ascii-'+str(i).zfill(5)
def digest(value): return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
expected = {}
for spec in protocol['cases']:
    entries = [[key(i), number(i)] for i in range(spec['size'])]; seed = []
    if spec['shape'] == 'half-replace':
        seed = entries
        entries = [[key(i), number(i)+10000] for i in [*range(2048), *range(4096, 6144)]]
    elif spec['shape'] == 'mixed':
        entries = [[('key-é-界-🙂-' if i%4 == 0 else 'key-ascii-')+str(i).zfill(5),
                    ('value-é-界-🙂-' if i%4 == 1 else 'value-ascii-')+str(i).zfill(5)] for i in range(4096)]
    elif spec['operation'] == 'compact': seed = entries
    model = dict(seed)
    if spec['operation'] == 'setMany': model.update(entries)
    expected[spec['id']] = {'inputDigest':digest([entries, seed]), 'expectedDigest':digest(sorted(model.items())),
        'independentOracle':'Python fixed inputs and UTF-8 JSON digest; integral quarter values serialized as integers',
        'entries':len(entries), 'seed':len(seed), 'resultSize':len(model)}
assert expected == json.loads((HERE/'fixture-expected.json').read_text())
print(json.dumps({'independentFixtureCases':len(expected), 'passed':True, 'operationClocks':False}))
