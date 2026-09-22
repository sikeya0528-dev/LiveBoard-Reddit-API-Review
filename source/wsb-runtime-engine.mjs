import {WsbProvider} from './wsb-provider.mjs';
import {WSB_STAGE08_LIMITS} from './wsb-provider-core.mjs';

const clean=v=>String(v??'').trim();
const asThread=v=>{const s=clean(v);if(!s)throw new Error('wsb_runtime_thread_missing');return s.startsWith('t3_')?s:`t3_${s}`};
const redditUrl=c=>{const p=clean(c?.permalink);return p?new URL(p,'https://www.reddit.com').toString():''};
const headersObject=value=>{if(!value)return{};if(typeof value.entries==='function')return Object.fromEntries(value.entries());return {...value}};

export const WSB_STAGE06_RUNTIME=Object.freeze({tickMs:100,contentCheckMs:60_000,maxInfoIds:100});

export class WsbRuntimeEngine{
  constructor({redditConfig,transport,translate,onEvent=()=>{},now=()=>Date.now()}={}){
    if(typeof transport!=='function')throw new Error('wsb_transport_required');
    if(typeof translate!=='function')throw new Error('wsb_translate_required');
    this.provider=new WsbProvider({redditConfig,now});this.transport=transport;this.translate=translate;this.onEvent=onEvent;this.now=now;
    this.threads=new Map();this.paused=false;this.helperBusy=false;this.tickBusy=false;this.candidateState={nextAt:0,previous:new Map(),last:null};
  }
  emit(event){try{this.onEvent(Object.freeze({...event}))}catch{}}
  async request(kind,args={}){
    const now=this.now(),reserve=this.provider.rateBudget.reserve(now);if(!reserve.ok){const e=new Error('reddit_rate_budget');e.code='reddit_rate_budget';e.nextAllowedAt=reserve.nextAllowedAt;throw e}
    let response;try{response=await this.transport({kind,...args})}catch(e){this.provider.rateBudget.recordResponse({status:599,headers:{}},this.now());throw e}
    const status=Number(response?.status)||0,headers=headersObject(response?.headers);this.provider.rateBudget.recordResponse({status,headers},this.now());
    if(status<200||status>=300){const e=new Error(response?.reason||`reddit_http_${status||'error'}`);e.code=response?.reason||`reddit_http_${status||'error'}`;e.status=status;e.retryAfter=headers['retry-after']||headers['Retry-After']||'';throw e}
    return response?.json;
  }
  async discoverCandidates({force=false}={}){
    const now=this.now();if(!force&&this.candidateState.last&&now<this.candidateState.nextAt)return this.candidateState.last;
    const [hot,newest]=await Promise.all([this.request('hot'),this.request('new')]);
    const ranked=this.provider.rankCandidates({hot,newest,nowUtc:now/1000,previousSamples:this.candidateState.previous});
    const previous=new Map();for(const item of ranked.ranked)previous.set(item.candidate.id,{id:item.candidate.id,sampledAtUtc:now/1000,numComments:item.candidate.numComments});this.candidateState.previous=previous;
    const normalize=c=>c?{id:c.id,fullname:c.fullname,title:c.title,url:redditUrl(c),createdUtc:c.createdUtc,numComments:c.numComments,family:c.family,stickied:c.stickied}:null;
    const result={ambiguous:ranked.ambiguous,automatic:normalize(ranked.automatic),menu:ranked.menu.map(normalize),ranked:ranked.ranked.slice(0,5).map(x=>({...normalize(x.candidate),score:x.score,growthPerMinute:x.growthPerMinute}))};
    this.candidateState.last=result;this.candidateState.nextAt=now+WSB_STAGE08_LIMITS.candidateRefreshMs;return result;
  }
  async startThread({threadFullname,generation=1,title='',url=''}={}){
    const thread=asThread(threadFullname);if(this.threads.has(thread)){const s=this.threads.get(thread);if(Number(generation)>s.generation){s.generation=Number(generation);s.state=this.provider.sharedStateForPane(s.paneId);s.state.translation.setGeneration(s.generation)}return this.snapshotThread(thread)}
    const paneId=`runtime:${thread}`,state=this.provider.subscribe(paneId,thread),entry={thread,paneId,generation:Number(generation)||1,title:clean(title),url:clean(url),state,busy:false,nextPollAt:0,nextContentCheckAt:0,lastError:'',activeAbort:null,startedAt:this.now()};
    this.threads.set(thread,entry);await this.seed(entry);return this.snapshotThread(thread)
  }
  async seed(entry){
    entry.busy=true;try{const json=await this.request('threadComments',{threadId:entry.thread});const seeded=entry.state.stream.seedInitial(json,{generation:entry.state.subscription.generation,limit:WSB_STAGE08_LIMITS.initialThreadComments});this.enqueue(entry,seeded.added||[]);entry.nextPollAt=this.now()+WSB_STAGE08_LIMITS.latestPollMs;entry.nextContentCheckAt=this.now()+WSB_STAGE06_RUNTIME.contentCheckMs;this.emitStatus(entry)}catch(e){entry.lastError=e.code||e.message||'reddit_seed_failed';this.emitStatus(entry)}finally{entry.busy=false}await this.driveTranslations()}
  enqueue(entry,comments){if(!comments?.length)return;const q=entry.state.translation.enqueue(comments.map(c=>({commentId:c.fullname,text:c.body,createdUtc:c.createdUtc})),{generation:entry.state.translation.generation,now:this.now()});if(!q.accepted){entry.lastError=q.reason;this.emitStatus(entry)}}
  async poll(entry){
    if(entry.busy||this.paused)return;const decision=this.provider.pollDecision(entry.paneId,this.now());if(decision.action==='pause'||decision.action==='wait'){entry.nextPollAt=Math.max(this.now()+500,Number(decision.nextAllowedAt)||this.now()+WSB_STAGE08_LIMITS.latestPollMs);this.emitStatus(entry);return}
    entry.busy=true;try{
      const pages=[];let after=entry.state.stream.snapshot().latestCursor||'';for(let i=0;i<WSB_STAGE08_LIMITS.maxBackfillPages;i++){const page=await this.request('latestComments',{after,threadId:entry.thread});pages.push(page);const next=clean(page?.data?.after);if(!next)break;after=next;if(i===0&&entry.state.stream.snapshot().comments.some(c=>(page?.data?.children||[]).some(ch=>String(ch?.data?.name||'')===c.fullname)))break}
      const ingest=entry.state.stream.ingestLatestPages(pages,{generation:entry.state.subscription.generation,polledAt:this.now()});this.enqueue(entry,ingest.added||[]);if(ingest.gap)this.emit({type:'gap',threadFullname:entry.thread,generation:entry.generation,gap:true,reason:ingest.gap.reason});entry.nextPollAt=this.now()+(decision.action==='slow'?WSB_STAGE08_LIMITS.latestPollMs*2:WSB_STAGE08_LIMITS.latestPollMs);entry.lastError='';
    }catch(e){entry.lastError=e.code||e.message||'reddit_poll_failed';entry.nextPollAt=Math.max(this.now()+WSB_STAGE08_LIMITS.latestPollMs,Number(e.nextAllowedAt)||0);this.emitStatus(entry)}finally{entry.busy=false}
  }
  async contentCheck(entry){
    const ids=entry.state.stream.snapshot().comments.slice(-WSB_STAGE06_RUNTIME.maxInfoIds).map(c=>c.fullname);entry.nextContentCheckAt=this.now()+WSB_STAGE06_RUNTIME.contentCheckMs;if(!ids.length)return;
    try{const json=await this.request('info',{ids});const records=json?.data?.children||[];const result=this.provider.applyContentChecks(entry.paneId,records);if(result.removed?.length)this.emit({type:'deleted',threadFullname:entry.thread,generation:entry.generation,commentIds:[...result.removed]});if(result.updated?.length)this.enqueue(entry,result.updated)}catch(e){entry.lastError=e.code||e.message||'reddit_content_check_failed';this.emitStatus(entry)}
  }
  async refreshCandidatesForThreads(){
    try{const candidates=await this.discoverCandidates({force:true});this.emit({type:'candidates',...candidates});for(const entry of this.threads.values()){const current=entry.thread.replace(/^t3_/,'');const ranked=(candidates.ranked||[]).map(x=>({candidate:{...x,id:x.id,fullname:x.fullname,title:x.title,permalink:new URL(x.url).pathname,createdUtc:x.createdUtc,numComments:x.numComments,family:x.family,stickied:x.stickied,sources:[]},score:x.score,growthPerMinute:x.growthPerMinute}));const mode='live';const advice=this.provider.observeSwitch(entry.paneId,{currentId:current,ranked,mode});if(advice.action==='switch'||advice.action==='notify'){const c=advice.challenger;this.emit({type:'switch-candidate',threadFullname:entry.thread,generation:entry.generation,action:advice.action,candidate:{id:c.id,fullname:c.fullname,title:c.title,url:redditUrl(c),createdUtc:c.createdUtc,numComments:c.numComments}})}}
    }catch(e){this.candidateState.nextAt=Math.max(this.now()+1_000,Number(e?.nextAllowedAt)||0);for(const entry of this.threads.values()){entry.lastError=e.code||e.message||'reddit_candidate_failed';this.emitStatus(entry)}}
  }
  async driveTranslations(){
    if(this.paused||this.helperBusy)return;for(const entry of this.threads.values()){
      const timed=entry.state.translation.checkTimeout(this.now());if(timed.timedOut)this.emitStatus(entry);
      const batch=entry.state.translation.takeBatch({now:this.now()});if(!batch)continue;this.helperBusy=true;const controller=new AbortController();entry.activeAbort=controller;
      try{const response=await this.translate({jobId:`${entry.thread}:${entry.generation}:${batch.batchId}`,batchId:batch.batchId,threadFullname:entry.thread,generation:entry.generation,items:batch.items,signal:controller.signal});if(this.threads.get(entry.thread)!==entry||entry.generation!==Number(response?.generation??entry.generation)){entry.state.translation.helperCrashed({now:this.now()});return}const results=(response?.results||[]).map(r=>({commentId:r.commentId,ok:r.ok===true,text:String(r.text??r.translatedText??''),error:clean(r.error)}));entry.state.translation.acceptResults({batchId:batch.batchId,generation:entry.state.translation.generation,results,now:this.now()})}catch(e){entry.state.translation.helperCrashed({now:this.now()});entry.lastError=e?.name==='AbortError'?'translation_cancelled':(e?.code||e?.message||'translation_helper_failed')}finally{entry.activeAbort=null;this.helperBusy=false}
      if(this.threads.get(entry.thread)!==entry)return;this.commit(entry);this.emitStatus(entry);queueMicrotask(()=>this.driveTranslations());break
    }
  }
  commit(entry){const ready=entry.state.translation.commitReady(this.now());if(!ready.committed?.length)return;const originals=new Map(entry.state.stream.snapshot().comments.map(c=>[c.fullname,c]));const items=ready.committed.map(row=>{const src=originals.get(row.commentId);entry.state.stream.markTranslated(row.commentId,{generation:entry.state.stream.generation});return {...row,original:src?.body||'',sourceText:src?.body||'',author:src?.author||'',createdUtc:src?.createdUtc||0}});this.emit({type:'translated-batch',threadFullname:entry.thread,generation:entry.generation,items})}
  emitStatus(entry){const q=entry.state.translation.status(this.now()),stream=entry.state.stream.snapshot();this.emit({type:'status',threadFullname:entry.thread,generation:entry.generation,backlog:q.backlog,oldestWaitMs:q.oldestWaitMs,highWater:q.highWater,retentionPaused:stream.pausedForRetention,error:entry.lastError})}
  async tick(){
    if(this.tickBusy)return false;this.tickBusy=true;try{const now=this.now();if(!this.paused){if(this.threads.size>0&&now>=this.candidateState.nextAt)await this.refreshCandidatesForThreads();for(const entry of this.threads.values()){if(now>=entry.nextPollAt)await this.poll(entry);if(now>=entry.nextContentCheckAt)await this.contentCheck(entry);this.commit(entry)}}await this.driveTranslations();return true}finally{this.tickBusy=false}
  }
  setRetention({threadFullname,paused}={}){const entry=this.threads.get(asThread(threadFullname));if(!entry)return false;entry.state.stream.pausedForRetention=!!paused;this.emitStatus(entry);return true}
  pause(){this.paused=true;for(const entry of this.threads.values()){entry.activeAbort?.abort?.();this.emitStatus(entry)}return this.snapshot()}
  resume({markGap=false}={}){this.paused=false;for(const entry of this.threads.values()){entry.nextPollAt=0;if(markGap)this.emit({type:'gap',threadFullname:entry.thread,generation:entry.generation,gap:true,reason:'resume-after-pause'})}return this.snapshot()}
  async stopThread({threadFullname}={}){const thread=asThread(threadFullname),entry=this.threads.get(thread);if(!entry)return this.snapshot();entry.activeAbort?.abort?.();this.provider.unsubscribe(entry.paneId);this.threads.delete(thread);return this.snapshot()}
  async stopAll(){for(const thread of [...this.threads.keys()])await this.stopThread({threadFullname:thread});this.paused=true;return this.snapshot()}
  snapshotThread(threadFullname){const entry=this.threads.get(asThread(threadFullname));if(!entry)return null;return {threadFullname:entry.thread,generation:entry.generation,active:true,error:entry.lastError}}
  snapshot(){return {active:this.threads.size>0,paused:this.paused,threadCount:this.threads.size,threads:[...this.threads.values()].map(e=>this.snapshotThread(e.thread))}}
}
