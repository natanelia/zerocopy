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
const root = mkdtempSync(path.join(tmpdir(),'sorted-delete-report-test-'));
try {
  for (const name of ['report.mjs','math.mjs','protocol.json']) copyFileSync(path.join(here,name),path.join(root,name));
  const manifest = '{}\n';
  writeFileSync(path.join(root,'manifest.json'),manifest);
  writeFileSync(path.join(root,'admission.json'),'{"mode":"synthetic-test","promotionAllowed":false}\n');
  let checks = 0;
  for (const state of [
    {name:'complete',status:'complete',verificationAfter:{ok:true},admitted:true},
    {name:'late-final-verification',status:'incomplete',deadline:{sourceAfterVerified:false},admitted:false},
    {name:'missing-final-verification',status:'complete',admitted:false},
  ]) {
    const output = path.join(root,state.name); mkdirSync(output);
    const slots = slotPlan(protocol).map(slot => {
      const rows = protocol.cases.flatMap(spec => [
        {kind:'case',case:spec.id,rows:Array.from({length:7},(_,sample)=>({phase:'measurement',sample,nsPerOperation:slot.arm==='candidate'?90:100,durationMs:12,operations:1}))},
        {kind:'diagnostics',case:spec.id},
      ]);
      const bytes = rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
      writeFileSync(path.join(output,slot.id+'.stdout.jsonl'),bytes);
      return {...slot,status:'complete',stdoutSha256:sha(bytes)};
    });
    writeFileSync(path.join(output,'ledger.json'),JSON.stringify({mode:'run',manifestSha256:sha(manifest),...state,slots}));
    execFileSync(process.execPath,[path.join(root,'report.mjs'),output],{stdio:'pipe'});
    const result = JSON.parse(readFileSync(path.join(output,'analysis.json')));
    assert.equal(result.cells.length,18); checks++;
    assert.equal(result.runAdmission.complete,state.admitted); checks++;
    for (const cell of result.cells) {
      assert(Math.abs(cell.pointwise95PercentInterval.ratio-0.9)<1e-12); checks++;
      if(state.admitted) assert.equal(cell.decision,'worthwhile gain supported in this cell');
      else assert.match(cell.decision,/^inconclusive/);
      checks++;
    }
  }
  console.log(JSON.stringify({syntheticReportChecks:checks,passed:true,candidateClocks:false}));
} finally { rmSync(root,{recursive:true,force:true}); }
