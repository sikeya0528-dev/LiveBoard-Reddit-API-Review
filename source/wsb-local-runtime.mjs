import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

const clean=v=>String(v??'').trim();
const nowIso=()=>new Date().toISOString();
const safeClientId=v=>{const s=clean(v);if(!s)return '';if(s.length>128||/\s/.test(s))throw new Error('reddit_client_id_invalid');return s};
const isExecutable=p=>{try{fsSync.accessSync(p,fsSync.constants.X_OK);return true}catch{return false}};

export const WSB_STAGE05_SAMPLE=Object.freeze({
  threadFullname:'t3_lbsample1',
  url:'https://www.reddit.com/r/wallstreetbets/comments/lbsample1/liveboard_sample/',
  title:'r/wallstreetbets サンプル',
  items:Object.freeze([
    Object.freeze({commentId:'t1_lbs001',original:'NVDA is cooked after that guidance cut.',sampleJa:'NVDAはガイダンス引き下げ後で厳しい、という投稿例です。'}),
    Object.freeze({commentId:'t1_lbs002',original:'Diamond hands until CPI. Calls are printing.',sampleJa:'CPIまでは握る。コールが利益になっている、という投稿例です。'}),
    Object.freeze({commentId:'t1_lbs003',original:'I am not chasing this pump. Waiting for the pullback.',sampleJa:'この上昇は追わず、押し目を待つ、という投稿例です。'}),
    Object.freeze({commentId:'t1_lbs004',original:'SPY volume is dead. Do not overtrade the chop.',sampleJa:'SPYの出来高が薄いので、往復相場で売買しすぎない、という投稿例です。'}),
    Object.freeze({commentId:'t1_lbs005',original:'Bought the dip with a tiny position. Risk is capped.',sampleJa:'小さいポジションで押し目買いし、損失上限を決めている、という投稿例です。'})
  ])
});

function candidatePaths({resourcesPath='',appPath='',isPackaged=false,name}){
  const out=[];
  if(isPackaged&&resourcesPath)out.push(path.join(resourcesPath,'wsb-native',name));
  if(appPath){
    out.push(path.join(appPath,'native-bin',name));
    out.push(path.join(appPath,'native','wsb-translation-helper','build',name));
    out.push(path.join(appPath,'native','wsb-translation-preparer','build',name));
  }
  return [...new Set(out)];
}

export class WsbLocalRuntime {
  constructor({resourcesPath='',appPath='',userData='',isPackaged=false,platform=process.platform,spawnImpl=spawn,timeoutMs=7000}={}){
    this.resourcesPath=resourcesPath;this.appPath=appPath;this.userData=userData;this.isPackaged=!!isPackaged;this.platform=platform;this.spawnImpl=spawnImpl;this.timeoutMs=Math.max(1000,Number(timeoutMs)||7000);
    this.settingsPath=path.join(userData||appPath||'.','wsb-settings.json');this.lastError='';this.lastProbe=null;this.activeHelpers=new Map();
  }
  helperCandidates(){return candidatePaths({...this,name:'WSBTranslationHelper'})}
  preparerCandidates(){return candidatePaths({...this,name:'WSBTranslationPreparer'})}
  resolveExecutable(candidates){for(const p of candidates)if(fsSync.existsSync(p)&&isExecutable(p))return p;return ''}
  async readSettings(){try{const raw=JSON.parse(await fs.readFile(this.settingsPath,'utf8'));return {redditClientId:safeClientId(raw?.redditClientId||''),redditApprovalConfirmed:raw?.redditApprovalConfirmed===true,updatedAt:clean(raw?.updatedAt)}}catch{return {redditClientId:'',redditApprovalConfirmed:false,updatedAt:''}}}
  async saveSettings(input={}){const redditClientId=safeClientId(input.redditClientId||'');const value={redditClientId,redditApprovalConfirmed:input.redditApprovalConfirmed===true,updatedAt:nowIso()};await fs.mkdir(path.dirname(this.settingsPath),{recursive:true});await fs.writeFile(this.settingsPath,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});return value}
  redditStatus(settings){if(!settings?.redditClientId)return {status:'unconfigured',reason:'reddit_client_id_missing'};if(settings?.redditApprovalConfirmed!==true)return {status:'approval_pending',reason:'reddit_api_approval_not_confirmed'};return {status:'auth_required',reason:'reddit_oauth_required'}}
  binaryStatus(name,candidates){const existing=candidates.find(p=>fsSync.existsSync(p));if(!existing)return {status:'missing',path:'',reason:`${name}_binary_missing`};if(!isExecutable(existing))return {status:'not_executable',path:existing,reason:`${name}_not_executable`};return {status:'ready',path:existing,reason:''}}
  runJsonLine(binary,request,{timeoutMs=this.timeoutMs,signal=null,jobId=''}={}){return new Promise(resolve=>{
    let child,stdout='',stderr='',settled=false,timer=0;const key=clean(jobId)||`helper-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;const finish=value=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);this.activeHelpers.delete(key);try{child?.kill?.('SIGTERM')}catch{}resolve(value)};const onAbort=()=>finish({ok:false,error:'helper_cancelled',cancelled:true});
    if(signal?.aborted){finish({ok:false,error:'helper_cancelled',cancelled:true});return}
    try{child=this.spawnImpl(binary,[],{stdio:['pipe','pipe','pipe']});this.activeHelpers.set(key,child)}catch(e){finish({ok:false,error:'helper_spawn_failed',detail:String(e?.message||e)});return}
    signal?.addEventListener?.('abort',onAbort,{once:true});child.stdout?.setEncoding?.('utf8');child.stderr?.setEncoding?.('utf8');child.stdout?.on?.('data',d=>stdout+=d);child.stderr?.on?.('data',d=>stderr+=d);
    child.on?.('error',e=>finish({ok:false,error:'helper_spawn_failed',detail:String(e?.message||e)}));
    child.on?.('close',(code,signalName)=>{if(settled)return;const line=stdout.trim().split(/\n+/).filter(Boolean).at(-1)||'';let parsed=null;try{parsed=JSON.parse(line)}catch{}if(parsed)finish({...parsed,process:{code,signal:signalName,stderr:stderr.slice(0,500)}});else finish({ok:false,error:'helper_invalid_response',detail:stderr.slice(0,500),process:{code,signal:signalName}})});
    timer=setTimeout(()=>finish({ok:false,error:'helper_timeout'}),timeoutMs);try{child.stdin?.end?.(JSON.stringify(request)+'\n')}catch(e){finish({ok:false,error:'helper_write_failed',detail:String(e?.message||e)})}
  })}
  cancelTranslation(jobId=''){const key=clean(jobId),child=this.activeHelpers.get(key);if(!child)return false;try{child.kill('SIGTERM')}catch{}this.activeHelpers.delete(key);return true}
  async stopHelpers(){for(const [key,child] of [...this.activeHelpers]){try{child.kill('SIGTERM')}catch{}this.activeHelpers.delete(key)}return {ok:true,active:0}}
  async translateBatch({jobId='',batchId='',threadFullname='',generation=0,items=[],signal=null}={}){
    const probe=await this.probeTranslation();if(!probe.ready){const e=new Error(probe.reason||'translation_not_ready');e.code=probe.reason||'translation_not_ready';throw e}
    const rows=(Array.isArray(items)?items:[]).slice(0,8).map(x=>({commentId:clean(x?.commentId),text:String(x?.text??'').slice(0,4000)})).filter(x=>x.commentId&&x.text);if(!rows.length)return {ok:true,batchId,generation,results:[]};
    const resp=await this.runJsonLine(probe.helper.path,{type:'translate',batchId,source:'en',target:'ja',generation,threadFullname,items:rows},{timeoutMs:30000,signal,jobId});if(resp?.cancelled){const e=new Error('translation_cancelled');e.name='AbortError';e.code='translation_cancelled';throw e}
    const byId=new Map((resp?.results||[]).map(r=>[clean(r?.commentId),r]));const results=rows.map(row=>{const r=byId.get(row.commentId),text=clean(r?.translatedText??r?.text);return {commentId:row.commentId,ok:!!(resp?.ok&&text),text,error:clean(r?.error||resp?.error)}});return {ok:resp?.ok===true,batchId,generation,engine:clean(resp?.engine),results}
  }
  async probeTranslation(){
    if(this.platform!=='darwin'){const r={status:'unsupported_platform',ready:false,reason:'apple_translation_requires_macos',helper:this.binaryStatus('helper',this.helperCandidates())};this.lastProbe=r;return r}
    const helper=this.binaryStatus('helper',this.helperCandidates());if(helper.status!=='ready'){const r={status:'helper_error',ready:false,reason:helper.reason,helper};this.lastProbe=r;return r}
    const resp=await this.runJsonLine(helper.path,{type:'capabilities'});let status='helper_error',reason=clean(resp?.error)||'helper_capability_failed';if(resp?.ok&&resp?.offlineReady){status='ready';reason=''}else if(reason==='language_assets_not_ready'){status='language_not_ready'}else if(reason.includes('framework_unavailable')||reason.includes('macos_'))status='helper_error';
    const r={status,ready:status==='ready',reason,engine:clean(resp?.engine),helper,response:resp};this.lastProbe=r;return r
  }
  async capabilities(){const settings=await this.readSettings(),reddit=this.redditStatus(settings),translation=await this.probeTranslation();return {available:reddit.status==='connectable'&&translation.ready,approvalReady:false,translationReady:translation.ready,reddit,translation,supportsSample:true,supportsExport:false,reason:reddit.reason||translation.reason||''}}
  async prepareTranslation(){
    if(this.platform!=='darwin')return {ok:false,status:'helper_error',reason:'apple_translation_requires_macos'};
    const prep=this.binaryStatus('preparer',this.preparerCandidates());if(prep.status!=='ready')return {ok:false,status:'helper_error',reason:prep.reason,path:prep.path};
    const result=await new Promise(resolve=>{let child,stdout='',stderr='',done=false,timer=0;const finish=v=>{if(done)return;done=true;if(timer)clearTimeout(timer);resolve(v)};try{child=this.spawnImpl(prep.path,[],{stdio:['ignore','pipe','pipe']})}catch(e){finish({ok:false,reason:'preparer_spawn_failed',detail:String(e?.message||e)});return}child.stdout?.setEncoding?.('utf8');child.stderr?.setEncoding?.('utf8');child.stdout?.on?.('data',d=>stdout+=d);child.stderr?.on?.('data',d=>stderr+=d);child.on?.('error',e=>finish({ok:false,reason:'preparer_spawn_failed',detail:String(e?.message||e)}));child.on?.('close',(code,signal)=>{let parsed=null;for(const line of stdout.trim().split(/\n+/).reverse()){try{parsed=JSON.parse(line);break}catch{}}finish(parsed?{...parsed,process:{code,signal,stderr:stderr.slice(0,500)}}:{ok:false,reason:code===0?'preparer_closed_without_result':'preparer_failed',process:{code,signal,stderr:stderr.slice(0,500)}})});timer=setTimeout(()=>{try{child?.kill?.('SIGTERM')}catch{}finish({ok:false,reason:'preparer_timeout'})},10*60*1000)});
    return {...result,translation:await this.probeTranslation()}
  }
  async translationTest(text='Markets are green today.'){
    const probe=await this.probeTranslation();if(!probe.ready)return {ok:false,status:probe.status,reason:probe.reason};const source=clean(text).slice(0,500)||'Markets are green today.',batchId=`stage05-${crypto.randomBytes(4).toString('hex')}`;const resp=await this.runJsonLine(probe.helper.path,{type:'translate',batchId,source:'en',target:'ja',items:[{commentId:'stage05-test',text:source}]},{timeoutMs:30000});const item=resp?.results?.[0];return {ok:!!(resp?.ok&&item?.translatedText),status:resp?.ok?'ready':'helper_error',reason:clean(resp?.error||item?.error),source,target:clean(item?.translatedText),engine:clean(resp?.engine),offline:true}
  }
  async connectionTest(){const settings=await this.readSettings(),reddit=this.redditStatus(settings);if(reddit.status==='unconfigured')return {ok:false,status:'unconfigured',reason:reddit.reason};return {ok:false,status:'approval_pending',reason:'reddit_live_runtime_stage06_not_connected'}}
}
