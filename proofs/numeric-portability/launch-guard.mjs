// Small injectable spawn guard; importing it launches nothing.
export function guardEngineSpawn(childProcess,{executable,profile,onSpawn=()=>{}}){
  const original=childProcess.spawn,state={attempts:0,child:null};
  childProcess.spawn=function(command,...rest){
    const args=rest[0]??[];
    if(command!==executable||(args.length===1&&['--version','-version','-v'].includes(args[0])))return original.call(this,command,...rest);
    if(!args.some(arg=>arg===profile||arg==='--user-data-dir='+profile))throw Error('Measured engine must use the explicit fresh profile');
    if(++state.attempts!==1)throw Error('Internal browser launch retry forbidden');
    state.child=original.call(this,command,...rest);onSpawn(state.child,args,state.attempts);return state.child;
  };
  return {state,restore(){childProcess.spawn=original;}};
}
