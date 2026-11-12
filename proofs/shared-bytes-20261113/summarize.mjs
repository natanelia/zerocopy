// node summarize.mjs — reproducible summaries and audit of the saved Node runs
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const read=name=>JSON.parse(gunzipSync(readFileSync(new URL(name+'.json.gz',import.meta.url))));
const codec=read('node-results'),reader=read('node-reader-results');
const median=a=>{const s=[...a].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
function compare(before,after) {
  if(before.length!==7||after.length!==7)throw Error('Expected seven pairs');
  const b=new Map(before.map(x=>[x.pair,x.ms]));
  const ratios=after.map(x=>x.ms/b.get(x.pair)),logs=ratios.map(Math.log),average=mean(logs);
  const spread=Math.sqrt(logs.reduce((s,x)=>s+(x-average)**2,0)/(logs.length-1)),delta=2.446911851*Math.sqrt(1/logs.length)*spread;
  return {beforeMs:median(before.map(x=>x.ms)),afterMs:median(after.map(x=>x.ms)),ratio:Math.exp(average),ci95:[Math.exp(average-delta),Math.exp(average+delta)],fasterPairs:ratios.filter(x=>x<1).length,pairs:ratios.length};
}
if(codec.rows.length!==210||reader.rows.length!==14||!codec.completedAt||!reader.completedAt)throw Error('Incomplete evidence');
for(const row of [...codec.rows,...reader.rows])if(row.verified!==true)throw Error('Unverified row');
for(const row of codec.rows)if(!Number.isFinite(row.ms)||row.ms<0)throw Error('Invalid timing');
const groups=[];
for(const kind of ['catalog','unicode','numeric','large-early','large-late'])for(const [before,after,field]of [['codec-native','codec-direct','category'],['query-native','query-bytes','category'],['query-native','query-bytes','absent']]) {
  const select=method=>codec.rows.filter(x=>x.kind===kind&&x.method===method&&x.field===field);
  if(select(before).length)groups.push({kind,before,after,field,...compare(select(before),select(after))});
}
const phases=Object.keys(reader.rows[0].times).map(phase=>({phase,...compare(...['before','after'].map(arm=>reader.rows.filter(x=>x.arm===arm).map(x=>({pair:x.pair,ms:x.times[phase]}))))}));
for(const row of reader.rows) {
  const t=row.times;
  if(t.readyMs!==t.constructionMs+t.publicationMs+t.firstQueryMs)throw Error('Incorrect combined timing');
  if(row.verification.found!==910||row.verification.missing!==90||row.verification.lookup!==2425954933||row.verification.validation!==2425954933)throw Error('Unexpected reader output');
  if(row.arenaUsedBytes!==2715440||row.arenaCapacityBytes!==2752512)throw Error('Unexpected arena allocation');
}
const summary={status:'pass',codecSamples:codec.rows.length,readerSamples:reader.rows.length,groups,phases,
  note:'Exploratory unadjusted paired log-ratio intervals; lower is faster. Same-build scheduling noise is not estimated in this experiment. No outliers removed.'};
writeFileSync(new URL('summary.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
