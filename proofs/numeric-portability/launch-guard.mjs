// Small injectable spawn guard; importing it launches nothing.
export function guardEngineSpawn(childProcess,{executable,profile,onSpawn=()=>{},ownership=null}){
  const original=childProcess.spawn,state={attempts:0,child:null,identity:null,sealed:false};
  childProcess.spawn=function(command,...rest){
    const args=rest[0]??[];
    if(command!==executable||(args.length===1&&['--version','-version','-v'].includes(args[0])))return original.call(this,command,...rest);
    if(state.sealed)throw Error('Browser spawn adapter already sealed');
    if(!args.some(arg=>arg===profile||arg==='--user-data-dir='+profile))throw Error('Measured engine must use the explicit fresh profile');
    if(++state.attempts!==1)throw Error('Internal browser launch retry forbidden');
    if(ownership&&rest[1]?.detached!==true)throw Error('Measured engine requires a detached process group');
    ownership?.beforeSpawn();
    state.child=original.call(this,command,...rest);
    // No browser work resumes until its PID/birth/group registration is durable.
    state.identity=ownership?.register(state.child)??null;
    onSpawn(state.child,args,state.attempts,state.identity);return state.child;
  };
  return {state,seal(){ownership?.seal(state.child);state.sealed=true;},restore(){childProcess.spawn=original;}};
}
