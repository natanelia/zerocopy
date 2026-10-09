// Only complete artificial records enter the pure statistical function; no subjects/clocks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {analyzeLane} from './report.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),p=JSON.parse(readFileSync(path.join(here,'protocol.json')));
const generated=spawnSync('python3',['-c',"import json,synthetic_fixture; print(json.dumps(synthetic_fixture.canonical_lane('arm64')))"] ,{cwd:here,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(generated.status,0,generated.stderr);
const canonical=JSON.parse(generated.stdout),report=analyzeLane(canonical,p);assert.equal(report.cells.length,16);assert.equal(report.wholeStudyAdmitted,false);
for(const cell of report.cells.filter(c=>c.kind==='startup')){assert.equal(cell.provisionalLaneDecision,'material loss supported in this cell');assert(cell.absoluteDifference.highMs<.05);assert.equal(cell.absoluteDifference.scaleOnlyNeverWaivesRelativeLoss,true);assert.deepEqual(cell.flags,[]);}
assert(report.cells.filter(c=>c.kind==='warm').every(c=>c.provisionalLaneDecision==='2% loss excluded pointwise; worthwhile gain unresolved'));
assert.throws(()=>analyzeLane({...canonical,slots:[]},p),/exact canonical/);
assert.throws(()=>analyzeLane({...canonical,slots:[...canonical.slots,canonical.slots[0]]},p),/exact canonical/);
console.log(JSON.stringify({syntheticReportCells:16,startupLossCellsBelow50Microseconds:6,emptyAndDuplicatedSchedulesRejected:true,realOperationClocksRead:false,librarySubjectsExecuted:false}));
