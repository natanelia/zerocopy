// Synthetic report admission only; no candidate imports or performance clocks.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {slotPlan} from './math.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(readFileSync(path.join(here,'protocol.json')));
const sha = text => createHash('sha256').update(text).digest('hex');
const root = mkdtempSync(path.join(tmpdir(),'sorted-compaction-report-test-'));
try {
  for (const name of ['report.mjs','math.mjs','protocol.json','historical-evidence.json']) copyFileSync(path.join(here,name),path.join(root,name));
  const manifest = '{}\n';
  writeFileSync(path.join(root,'manifest.json'),manifest);
  writeFileSync(path.join(root,'admission.json'),'{"mode":"synthetic-test","promotionAllowed":false}\n');
  let checks = 0, originalLimitations;
  for (const state of [
    {name:'complete',status:'complete',verificationAfter:{ok:true},admitted:true},
    {name:'late-final-verification',status:'incomplete',deadline:{sourceAfterVerified:false},admitted:false},
    {name:'missing-final-verification',status:'complete',admitted:false},
    {name:'adverse-control',status:'complete',verificationAfter:{ok:true},admitted:true,adverse:true},
    {name:'secondary-only-gain',status:'complete',verificationAfter:{ok:true},admitted:true,secondaryOnly:true},
  ]) {
    const output = path.join(root,state.name); mkdirSync(output);
    const slots = slotPlan(protocol).map(slot => {
      const rows = protocol.cases.flatMap(spec => [
        {kind:'case',case:spec.id,rows:Array.from({length:7},(_,sample)=>({phase:'measurement',sample,nsPerOperation:slot.arm==='candidate'?(state.adverse && spec.role==='control'?110:state.secondaryOnly && spec.role!=='secondary'?100:90):100,durationMs:12,operations:1}))},
        {kind:'diagnostics',case:spec.id},
      ]);
      const observations = [];
      for (const record of rows.filter(row => row.kind === 'case')) for (const [i, row] of record.rows.entries()) {
        row.observationId = `${slot.id}/${record.case}/${i}`;
        observations.push({kind:'body-observation',observationId:row.observationId,case:record.case,phase:row.phase,operations:row.operations,durationMs:row.durationMs,nsPerOperation:row.nsPerOperation,validated:false});
      }
      const bytes = [...observations,...rows].map(row=>JSON.stringify(row)).join('\n')+'\n';
      writeFileSync(path.join(output,slot.id+'.stdout.jsonl'),bytes);
      return {...slot,status:'complete',stdoutSha256:sha(bytes)};
    });
    writeFileSync(path.join(output,'ledger.json'),JSON.stringify({mode:'run',manifestSha256:sha(manifest),...state,slots}));
    execFileSync(process.execPath,[path.join(root,'report.mjs'),output],{stdio:'pipe'});
    const result = JSON.parse(readFileSync(path.join(output,'analysis.json')));
    assert.equal(result.cells.length,20); checks++;
    assert.equal(result.runAdmission.complete,state.admitted); checks++;
    assert.equal(result.historicalLimitations.originalBaselineSuite.passed,138); checks++;
    assert.equal(result.historicalLimitations.originalBaselineSuite.timeouts,3); checks++;
    assert.equal(result.historicalLimitations.originalBaselineSuite.resolved,false); checks++;
    assert.equal(result.historicalLimitations.focusedRepositoryTests.transferredToNewHead,false); checks++;
    assert.match(result.historicalLimitations.contractLimitation,/120 to 119/); checks++;
    assert.match(result.historicalLimitations.actualWorkers,/in-process/); checks++;
    if(originalLimitations) assert.deepEqual(result.historicalLimitations,originalLimitations);
    else originalLimitations=result.historicalLimitations;
    checks++;
    assert.equal(result.memoryReporting.resourceUsageMaxRSS.unit,'KiB'); checks++;
    assert.equal(result.memoryReporting.resourceUsageMaxRSS.bytesPerUnit,1024); checks++;
    assert.deepEqual(result.memoryReporting.resourceUsageMaxRSS.runtimes,{node:'v22.23.3',bun:'1.4.2'}); checks++;
    assert.equal(result.memoryReporting.sampledSubjectRss.unit,'bytes'); checks++;
    assert.equal(result.memoryReporting.sampledControllerRss.unit,'bytes'); checks++;
    assert.equal(result.memoryReporting.arenaCapacity.unit,'bytes'); checks++;
    for (const cell of result.cells) {
      const expectedRatio = state.adverse && cell.role==='control'?1.1:state.secondaryOnly && cell.role!=='secondary'?1:0.9;
      assert(Math.abs(cell.pointwise95PercentInterval.ratio-expectedRatio)<1e-12); checks++;
      assert.equal(cell.units,protocol.cases.find(spec=>spec.id===cell.case).unit); checks++;
      if(state.admitted) {
        if(expectedRatio>1.02) assert.equal(cell.decision,'material loss supported in this cell');
        else if(expectedRatio<0.95) assert.equal(cell.decision,'worthwhile gain supported in this cell');
        else assert.match(cell.decision,/2% loss excluded/);
      }
      else assert.match(cell.decision,/^inconclusive/);
      checks++;
    }
    if(state.adverse) assert.match(result.screenDecision,/^No promotion/);
    if(state.secondaryOnly) assert.match(result.screenDecision,/^Weak or inconclusive/);
    checks++;
  }
  console.log(JSON.stringify({syntheticReportChecks:checks,passed:true,candidateClocks:false}));
} finally { rmSync(root,{recursive:true,force:true}); }
