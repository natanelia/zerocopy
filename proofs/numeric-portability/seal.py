"""Seal the inactive review packet. No subject, browser, build or external action."""
import hashlib,json,pathlib
HERE=pathlib.Path(__file__).resolve().parent
REPO=HERE.parents[1]
assert json.loads((HERE/'activation.json').read_text())['enabled'] is False
files=sorted([p for p in HERE.iterdir() if p.is_file() and p.name not in ('packet.json','activation.json')]+[REPO/'.github/workflows/numeric-portability.yml'])
assert all(not p.is_symlink() for p in files)
packet={'schema':1,'origin':json.loads((HERE/'origin.json').read_text()),'files':[{'path':str(p.relative_to(REPO)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in files],'defaultOff':True,'runtimeExecutionAuthorized':False}
(HERE/'packet.json').write_text(json.dumps(packet,indent=2)+'\n')
print(hashlib.sha256((HERE/'packet.json').read_bytes()).hexdigest())
