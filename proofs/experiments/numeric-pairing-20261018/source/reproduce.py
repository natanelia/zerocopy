#!/usr/bin/env python3
"""Rebuild both sealed diagnostic methods offline from the exact retained input ZIP."""
import argparse,hashlib,json,pathlib,shutil,subprocess,tarfile,zipfile
SOURCE=pathlib.Path(__file__).resolve().parent
DIGEST='c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb'
FILES=['paired.mjs','paired.test.mjs','run.py','audit.mjs','audit.py']
def prepare(archive,output):
 assert not output.exists(), 'Use a fresh output directory'
 assert hashlib.sha256(archive.read_bytes()).hexdigest()==DIGEST, 'Wrong input archive'
 output.mkdir(parents=True)
 shutil.copyfile(archive,output/'numeric-tree-X64-d16d82c9.zip')
 work=output/'work';work.mkdir();evidence=work/'evidence';evidence.mkdir()
 with zipfile.ZipFile(archive) as z:
  for name in z.namelist():
   if name.startswith(('baseline-build/','candidate-build/')) or name=='candidate-source.tar':z.extract(name,evidence)
 with tarfile.open(evidence/'candidate-source.tar') as t:t.extractall(work/'repo',filter='data')
 assert hashlib.sha256((work/'repo/proofs/numeric-tree-process.mjs').read_bytes()).hexdigest()=='77842c9459547c616ea4f90ade8bb32118d2f4175408aecf2269e2d8d7d5d033'
 first=work/'pairing';first.mkdir()
 for name in FILES:shutil.copyfile(SOURCE/name,first/name)
 return first

def followup(first):
 second=first.parent/'pairing-longbatch';second.mkdir()
 for name in FILES:shutil.copyfile(first/name,second/name)
 p=second/'paired.mjs';s=p.read_text().replace("version: 'paired-diagnostic-1'", "version: 'paired-diagnostic-2', batchMultiplier: 4")
 old='Math.min(1_000_000, Math.max(8, Math.ceil(METHOD.work / size)))';assert s.count(old)==2
 p.write_text(s.replace(old,'METHOD.batchMultiplier * '+old))
 p=second/'paired.test.mjs';p.write_text(p.read_text().replace('1000000','4000000'))
 p=second/'run.py';s=p.read_text().replace("'sizes':[2,1024,32768]", "'sizes':[2], 'batchMultiplier':4")
 s=s.replace("groups=['separate-aa','paired-aa','paired-ab']", "groups=['paired-aa','paired-ab']").replace('groups[block%3:]+groups[:block%3]','groups[block%2:]+groups[:block%2]')
 s=s.replace('Three preselected diagnostic sizes, not full coverage.', 'Follow-up after pairing method 1: size 2 only, plus the size-1024 two-call control. Four times as many iterations per batch. This is a changed diagnostic workload, not acceptance under the original workload. All method-1 failures stay retained.')
 s=s.replace("'purpose':'diagnostic only; neither clears original plan version 2 nor replaces failed evidence'", "'purpose':'Fixed 4x batching follow-up; diagnosis only, not original performance acceptance', 'parentPlanSha256':sha(WORK/'pairing/raw/plan.json'), 'parentAuditSha256':sha(WORK/'pairing/audit.json')")
 p.write_text(s)
 p=second/'audit.mjs';p.write_text(p.read_text().replace('plan.schedule.length, 76','plan.schedule.length, 12').replace('cohorts.size, 10','cohorts.size, 3'))
 return second

def execute(directory):
 for args,log in [(['node','--test','paired.test.mjs'],'tests-before-run.txt'),(['python3','run.py'],'controller.log'),
                  (['node','audit.mjs'],'audit.log'),(['python3','audit.py'],'independent-audit.log')]:
  with (directory/log).open('xb') as out:
   result=subprocess.run(args,cwd=directory,stdout=out,stderr=subprocess.STDOUT)
  assert result.returncode==0, f'Failed command {args}; retain all output at {directory}'

def main():
 parser=argparse.ArgumentParser();parser.add_argument('archive',type=pathlib.Path);parser.add_argument('output',type=pathlib.Path);parser.add_argument('--prepare-only',action='store_true')
 args=parser.parse_args();first=prepare(args.archive.resolve(),args.output.resolve())
 if args.prepare_only:followup(first)
 else:
  execute(first);second=followup(first);execute(second)
 print(args.output.resolve())
if __name__=='__main__':main()
