// Durable browser ownership journal. Imports perform no I/O and spawn nothing.
import * as fs from 'node:fs';
import path from 'node:path';

export function readBirth(pid,read=fs.readFileSync){
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Engine spawn returned no positive PID');
  const text=read(`/proc/${pid}/stat`,'utf8'),end=text.lastIndexOf(')'),parts=text.slice(end+2).trim().split(/\s+/);
  const identity={pid,state:parts[0],ppid:Number(parts[1]),group:Number(parts[2]),session:Number(parts[3]),startTicks:Number(parts[19])};
  if(end<0||Number(text.slice(0,text.indexOf(' ')))!==pid||identity.state?.length!==1||!Number.isSafeInteger(identity.ppid)||identity.ppid<0||!['group','session','startTicks'].every(key=>Number.isSafeInteger(identity[key])&&identity[key]>0))throw Error('Process birth identity unavailable');
  return identity;
}

export function createOwnershipJournal({journalPath,binding,adapterPid=process.pid,io=fs,readIdentity=readBirth}){
  if(typeof journalPath!=='string'||!path.isAbsolute(journalPath))throw Error('Absolute ownership journal path required');
  if(!binding||!['slotId','manifestSha256','runtime','lane','arm','mode'].every(key=>typeof binding[key]==='string'&&binding[key].length))throw Error('Ownership journal binding required');
  const adapter=readIdentity(adapterPid);
  if(adapter.group!==adapterPid||adapter.session!==adapterPid)throw Error('Adapter must own its process session');
  let descriptor=io.openSync(journalPath,'wx',0o600),sequence=0,attempts=0,engine=null,sealed=false;
  const append=fields=>{
    if(descriptor===null)throw Error('Ownership journal is closed');
    const bytes=Buffer.from(JSON.stringify({schema:1,sequence,binding,...fields})+'\n');
    let written=0;
    while(written<bytes.length){const count=io.writeSync(descriptor,bytes,written,bytes.length-written);if(!Number.isSafeInteger(count)||count<=0)throw Error('Ownership journal write made no progress');written+=count;}
    io.fsyncSync(descriptor);sequence++;
  };
  try{
    append({kind:'ownership-ready',adapter});
    const directory=io.openSync(path.dirname(journalPath),'r');try{io.fsyncSync(directory);}finally{io.closeSync(directory);}
  }catch(error){io.closeSync(descriptor);descriptor=null;throw error;}
  return {
    beforeSpawn(){if(sealed||++attempts!==1)throw Error('Ownership journal permits only one engine spawn');append({kind:'engine-spawn-intent',attempt:attempts});},
    register(child){
      if(attempts!==1||engine!==null)throw Error('Engine registration order invalid');
      const birth=readIdentity(child.pid);
      if(birth.ppid!==adapter.pid||birth.group!==birth.pid||birth.session!==birth.pid)throw Error('Detached engine ownership unavailable');
      append({kind:'engine-spawned',attempt:attempts,identity:birth});engine=birth;return birth;
    },
    seal(child){
      if(sealed)throw Error('Ownership already sealed');
      if(!engine||attempts!==1||!child||child.pid!==engine.pid||!(Number.isInteger(child.exitCode)||(typeof child.signalCode==='string'&&child.signalCode.length)))throw Error('Engine exit is not established; ownership stays unknown');
      append({kind:'ownership-sealed',attempts,engineExited:true});sealed=true;
      io.closeSync(descriptor);descriptor=null;
    },
    close(){if(descriptor!==null){io.closeSync(descriptor);descriptor=null;}},
  };
}
