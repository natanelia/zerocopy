import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CASES,STARTUP,schedule,quantum,check,freezeCounts,analyze} from './protocol.mjs';
const root=resolve(process.argv[2]);
const rows=JSON.parse(readFileSync(resolve(root,'rows.json'),'utf8'));
for(const row of rows.filter(r=>r.complete||r.validatedEndpoints?.length)) {
  const spec=schedule().find(x=>x.id===row.id);
  check(spec&&Object.entries(spec).every(([k,v])=>JSON.stringify(row[k])===JSON.stringify(v)),'schedule mismatch');
  check(row.q===quantum(row.clockReadingsNs),'clock quantum mismatch');
  if(row.complete) check(row.retainedArenas===9,'arena retention mismatch');
  for(const phase of STARTUP.filter(p=>row.validatedEndpoints.includes(p))) check(Number.isFinite(row.startup[phase])&&row.startup[phase]>0,'invalid startup duration');
  for(const name of CASES.filter(p=>row.validatedEndpoints.includes(p))) check(row.cases[name].G===row.counts[name],'count mismatch');
}
const calibrations=rows.filter(r=>r.kind==='calibration');
let frozen=null;
if(calibrations.length===4&&calibrations.every(r=>r.complete)) {
  frozen=freezeCounts(calibrations);
  const saved=JSON.parse(readFileSync(resolve(root,'frozen-counts.json'),'utf8'));
  check(JSON.stringify(saved)===JSON.stringify(frozen),'frozen calibration plan mismatch');
  for(const row of rows.filter(r=>r.kind==='observation')) for(const name of CASES) check(row.counts[name]===frozen[name].G,'candidate-influenced count');
}
const controller=JSON.parse(readFileSync(resolve(root,'hosted-result.json'),'utf8'));
const analysis={...analyze(rows,{studyFailed:true}),pendingFinalIntegrity:true,controllerReportedComplete:controller.complete,frozen,completeChildren:rows.filter(r=>r.complete).length,plannedChildren:36,unrun:schedule().filter(s=>!rows.some(r=>r.id===s.id)),failed:rows.filter(r=>!r.complete).map(r=>r.id)};
writeFileSync(resolve(root,'analysis.json'),JSON.stringify(analysis,null,2)+'\n');
console.log(JSON.stringify({primaryQualified:analysis.primaryQualified,regressionVeto:analysis.regressionVeto,guardsClear:analysis.guardsClear,completeChildren:analysis.completeChildren,unresolved:analysis.unresolved}));
