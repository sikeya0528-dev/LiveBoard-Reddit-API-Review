import {WsbRuntimeEngine,WSB_STAGE06_RUNTIME} from './wsb-runtime-engine.mjs';
const port=process.parentPort;if(!port)throw new Error('wsb runtime utility requires process.parentPort');
const pending=new Map();let serial=0,engine=null,timer=0;
const post=m=>port.postMessage(m);
function rpc(kind,payload={},signal){const requestId=`w${++serial}`;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(requestId);const e=new Error(`${kind}_timeout`);e.code=`${kind}_timeout`;reject(e)},20_000);const abort=()=>{clearTimeout(timeout);pending.delete(requestId);post({type:`${kind}-cancel`,requestId});reject(Object.assign(new Error('aborted'),{name:'AbortError'}))};if(signal?.aborted)return abort();signal?.addEventListener?.('abort',abort,{once:true});pending.set(requestId,{resolve:v=>{clearTimeout(timeout);signal?.removeEventListener?.('abort',abort);resolve(v)},reject:e=>{clearTimeout(timeout);signal?.removeEventListener?.('abort',abort);reject(e)}});post({type:`${kind}-request`,requestId,...payload})})}
async function command(d){
  if(d.type==='init'){engine=new WsbRuntimeEngine({redditConfig:d.redditConfig,transport:args=>rpc('transport',args),translate:args=>rpc('translate',{jobId:args.jobId,batchId:args.batchId,threadFullname:args.threadFullname,generation:args.generation,items:args.items},args.signal),onEvent:event=>post({type:'event',event})});if(!timer)timer=setInterval(()=>engine?.tick?.().catch(e=>post({type:'runtime-error',error:String(e?.message||e)})),WSB_STAGE06_RUNTIME.tickMs);return {ok:true,snapshot:engine.snapshot()}}
  if(!engine)throw new Error('wsb_runtime_not_initialized');
  if(d.type==='start-thread')return {ok:true,snapshot:await engine.startThread(d.payload)};
  if(d.type==='stop-thread')return {ok:true,snapshot:await engine.stopThread(d.payload)};
  if(d.type==='pause')return {ok:true,snapshot:engine.pause()};
  if(d.type==='resume')return {ok:true,snapshot:engine.resume(d.payload)};
  if(d.type==='retention')return {ok:true,changed:engine.setRetention(d.payload),snapshot:engine.snapshot()};
  if(d.type==='discover-candidates')return {ok:true,candidates:await engine.discoverCandidates({force:true})};
  if(d.type==='snapshot')return {ok:true,snapshot:engine.snapshot()};
  if(d.type==='shutdown'){const snap=await engine.stopAll();if(timer)clearInterval(timer);timer=0;setTimeout(()=>process.exit(0),20);return {ok:true,snapshot:snap}}
  throw new Error('wsb_runtime_command_unknown');
}
port.on('message',async message=>{const d=message?.data??message;if(d?.type==='transport-response'||d?.type==='translate-response'){const p=pending.get(d.requestId);if(!p)return;pending.delete(d.requestId);if(d.ok)p.resolve(d.result);else{const e=new Error(d.reason||'rpc_failed');e.code=d.reason||'rpc_failed';p.reject(e)}return}if(!d?.commandId)return;try{const result=await command(d);post({type:'command-response',commandId:d.commandId,ok:true,result})}catch(e){post({type:'command-response',commandId:d.commandId,ok:false,reason:e?.code||e?.message||'command_failed'})}});
process.on('disconnect',()=>{if(timer)clearInterval(timer);for(const p of pending.values())p.reject(new Error('parent_disconnected'));pending.clear()});
