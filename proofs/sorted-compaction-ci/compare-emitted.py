import collections, difflib, json, re, sys
from pathlib import Path
out=Path(sys.argv[1]); data=json.loads((out/'emitted-functions.json').read_text()); base=data['arms']['baseline']['functions']; candidate=data['arms']['candidate']['functions']
def sig(f): return [f['params'],f['results'],f['vars']]
def shape(f): return json.dumps(sig(f))+re.sub(r'\(call \$\d+', '(call $FUNCTION', f['body'])
groups=collections.defaultdict(list)
for f in candidate: groups[shape(f)].append(f['index'])
mapping={}; ambiguous=[]
for f in base:
 matches=groups[shape(f)]
 if len(matches)==1: mapping[matches[0]]=f['index']
 elif len(matches)>1: ambiguous.append({'baseline':f['index'],'candidates':matches})
be={e['name']:e for e in data['arms']['baseline']['exports']}; ce={e['name']:e for e in data['arms']['candidate']['exports']}; exports=[]
bnames={f['name']:f['index'] for f in base}; cnames={f['name']:f['index'] for f in candidate}
for name,e in be.items():
 assert name in ce
 c=ce[name]; assert e['kind']==c['kind']
 if e['value'] in bnames and c['value'] in cnames:
  bi=bnames[e['value']];ci=cnames[c['value']]
  if ci in mapping: assert mapping[ci]==bi
  mapping[ci]=bi
  exports.append({'name':name,'baseline':bi,'candidate':ci,'signatureEqual':sig(base[bi])[:2]==sig(candidate[ci])[:2]})
existing=[]
for ci,bi in sorted(mapping.items(),key=lambda x:x[1]):
 b=base[bi];c=candidate[ci]; normalized=re.sub(r'\(call \$(\d+)',lambda m:'(call $'+str(mapping.get(int(m[1]),'NEW_'+m[1])),c['body']); equal=sig(b)==sig(c) and b['body']==normalized
 existing.append({'baseline':bi,'candidate':ci,'literalAfterCallRelocation':equal})
 if not equal:(out/f'old-function-{bi}-candidate-{ci}.diff').write_text(''.join(difflib.unified_diff(b['body'].splitlines(True),normalized.splitlines(True),fromfile=f'baseline/{bi}',tofile=f'candidate/{ci}')))
result={'baselineFunctions':len(base),'candidateFunctions':len(candidate),'mappedOldFunctions':len(mapping),'existing':existing,'unmatchedOldFunctions':[f['index'] for f in base if f['index'] not in mapping.values()],'unmatchedCandidateFunctions':[f['index'] for f in candidate if f['index'] not in mapping],'ambiguous':ambiguous,'exports':exports,'addedExports':sorted(set(ce)-set(be)),'method':'Unique signature/local/literal-body shapes ignoring direct-call indices, augmented by exact export names; all matched bodies then rechecked after restoring mapped call targets. Unmatched or changed old bodies require manual review.'}
(out/'emitted-comparison.json').write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps({k:v for k,v in result.items() if k not in ['existing','exports']})); assert all(e['signatureEqual'] for e in exports)
