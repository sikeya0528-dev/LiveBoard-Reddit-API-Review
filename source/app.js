import {
  normalizeThreadRef, identifyThreadRef, paneRequestToken, isCurrentPaneRequest, rankContinuationCandidates, continuationTitleInfo, continuationTitleSimilarity, continuationChannelConflict, continuationSeriesMatch, continuationShortPrefixMatch, continuationAutoEvidence, selectAutoAdvanceCandidate, continuationActivityRate, createHistoryEntry, normalizeHistory, pushHistory, moveHistory, initialRenderWindow, logicalDateBoundaryIndexes, navigationResponseUsable, validatePersistedState, gestureDecision, postSignature, postBaseGeometrySignature, postGeometrySignature, postAnalysisSignature, normalizeFutabaDisplayTitle, choosePopoverPlacement, chooseClientRect
} from './core.mjs';
import {LocalRepository,MemoryStorage} from './repository.mjs';
import {ThreadStore} from './thread-store.mjs';
import {createNavigationCoordinator,createViewportController,normalizeLegacyViewportState} from './r5-navigation-core.mjs';
import {createVirtualLayoutAdapter} from './r5-virtual-layout.mjs';
import {collectCueRefs, continuationSeedCandidates, resolveContinuationCandidates} from './r5-continuation-resolver.mjs';
import {createLiveTransitionCoordinator, immediateForwardHistoryIndex, threadNotificationPlan} from './r5-live-transition.mjs';
import {saveTickerRestoreAnchor,takeTickerRenderAnchor,commitTickerRestoreAnchor,nearestSurvivingTickerKey} from './r5-ticker-continuity.mjs';
import {WsbPaneLifecycle,WSB_STAGE09_LIMITS,mapTranslatedWsbRow,trimWsbPosts} from './wsb-pane-lifecycle.mjs';

const boards = [
  {id:'edge',space:'stocks',name:'エッヂ',label:'EDGE',limit:1000,supportsExport:true},
  {id:'5ch',space:'stocks',name:'5ch株式',label:'5CH',limit:1000,supportsExport:true},
  {id:'futaba',space:'stocks',name:'ふたばmay',label:'2CHAN',limit:1000,supportsExport:true},
  {id:'holo',space:'vtuber',name:'hololive',label:'HOLO',limit:3000,supportsExport:true},
  {id:'niji',space:'vtuber',name:'にじさんじ',label:'NIJI',limit:4000,supportsExport:true},
  {id:'wsb',space:'stocks',name:'r/wallstreetbets',label:'WSB',limit:Infinity,supportsExport:false,provider:'reddit'},
];
const initialPanes = [
  {board:'edge',title:'投資部投機部',url:'https://bbs.eddibb.cc/liveedge/1789717505'},
  {board:'5ch',title:'米国株',url:'https://egg.5ch.io/test/read.cgi/stock/1789721696/'},
  {board:'holo',title:'hololive',url:'https://bbs.jpnkn.com/test/read.cgi/hololiveneet/1789720702/'},
  {board:'niji',title:'にじさんじ',url:'https://bbs.jpnkn.com/test/read.cgi/nijifunbbs/1789709833/'},
];

let panes=[];
let saveTimer=0;
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(save,250)}
let activeBoard='edge';
let activeSort='hot';
let drawerPinned=false;
let drawerCloseTimer=0;
let menuInputMode='pointer';
let drawerReplacePaneId='';
const HOT_FEEDS={edge:{board:'edge',label:'エッヂ',limit:9},futaba:{board:'futaba',label:'ふたばMay',limit:30}};
const makeTickerFeedState=()=>({rankSnapshot:[],pendingSnapshot:null,requestEpoch:0,rankHistory:new Map(),observedKeys:new Set(),normalSnapshotCount:0,eventLog:[],initialized:false,error:'',lastSuccessAt:0,restoreAnchor:null});
const tickerEvents=new Map();
let hotFeed='edge';
let toolbarMode='hot',tickerState={feeds:{edge:makeTickerFeedState(),futaba:makeTickerFeedState()},scrolling:false,scrollTimer:0,manualTimer:0,resumeTimer:0,restoreDepth:0,renderToken:0,raf:0,lastTs:0,pointerInside:false,pointerDown:false,manualActive:false,resumeAfter:0,expectedScrollLeft:null,logicalScrollLeft:null,logicalPhase:0,cycleWidth:0,centerCycle:0,cycleCount:1,viewportWidth:0,compositionKeys:[],animation:null,animationDuration:0,animationGeneration:0,eventMotionTime:null,dragPointerId:null,dragStartX:0,dragStartPhase:0};
let headerHoverTimer=0,headerCloseTimer=0,tooltipTimer=0;
let paneDrag=null,suppressPaneTitleClick=false,paneSwapAnimatingUntil=0;
let cancelHistoryGesture=()=>false;
let mediaPopoverHold=null,mediaHoldSession=0,lightboxMediaSession=0,lightboxMediaTimer=0,lightboxTooltipTimer=0,lightboxTooltipSession=0,lastPointer={x:-1,y:-1,kind:'pointer'};
let gallerySession=null,gallerySessionSeq=0;
const inlineImageAttempts=new WeakMap();
const MEDIA_LOAD_TIMEOUT_MS=15000;
const boardCaches=new Map();
const previewCache=new Map();
const futabaCoverCache=new Map();
const futabaTitleCache=new Map(),futabaTitleBackoff=new Map(),futabaTitleQueued=new Set(),futabaTitleQueue=[];
const futabaTitleObservers=new WeakMap();
const futabaTitleMetrics={requests:0,cacheHits:0,paneHits:0,completed:0,failures:0,maxActive:0};
let futabaTitleActive=0;
const FUTABA_TITLE_CACHE_MS=10*60_000,FUTABA_TITLE_BACKOFF_MS=30_000,FUTABA_TITLE_MAX_CONCURRENT=2;
function cacheRemember(cache,key,value,maxEntries=600){if(cache.has(key))cache.delete(key);cache.set(key,value);while(cache.size>maxEntries)cache.delete(cache.keys().next().value);return value}
const MAX_PANES=9;
const threadActivity=new Map();
const readPositionOwnerByThread=new Map();
let repository=new LocalRepository(localStorage);
let desktopRevision=0,desktopSaveTimer=0,lastActivePaneId='';
const markdownUi={snapshot:null,partIndex:0,lastCompletionJob:'',lastSaveFailureJob:'',panelOpen:false};
const threadStore=new ThreadStore();
let wsbPaneLifecycle=null,wsbBridgeUnsubscribe=null,wsbAuthPending=false;
const wsbCapability={checked:false,available:false,reason:'reddit_api_approval_required',translationReady:false,reddit:{status:'unconfigured',reason:'reddit_client_id_missing'},translation:{status:'unprepared',reason:'helper_not_checked'}};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const boardOf=id=>boards.find(b=>b.id===id);
const fmtTime=(time=Date.now())=>new Date(time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function safeUrl(s){try{const u=new URL(String(s));return /^https?:$/.test(u.protocol)?u.href:''}catch{return ''}}
function openExternalUrl(url){const u=safeUrl(url);if(!u)return;if(window.liveboardDesktop?.openExternal)void window.liveboardDesktop.openExternal(u).catch(()=>toast('外部リンクを開けませんでした'));else window.open(u,'_blank','noopener')}
function internalThreadRef(url){return identifyThreadRef(url)}
function futabaThreadKey(value=''){const s=typeof value==='object'?(value?.key||value?.url||''):value,m=String(s||'').match(/(?:res\/|[?&]res=)(\d+)/i);return m?.[1]||(/^\d+$/.test(String(s||''))?String(s):'')}
function threadDisplayTitle(boardId,title=''){return boardId==='futaba'?normalizeFutabaDisplayTitle(title):String(title??'')}
function normalizePersistedThreadTitles(history){if(!history||!Array.isArray(history.entries))return history;return {...history,entries:history.entries.map(entry=>entry?.board==='futaba'?{...entry,title:threadDisplayTitle('futaba',entry.title)}:entry)}}
function normalizeFutabaThreadRecord(t){if(!t)return t;const raw=String(t.rawTitle??t.title??'');const display=normalizeFutabaDisplayTitle(t.title??raw);if(raw&&!t.rawTitle)t.rawTitle=raw;t.displayTitle=display;if(display)t.title=display;return t}
function validFutabaTitleRecord(rec){return !!rec&&Number(rec.expiresAt)>Date.now()}
function setFutabaThreadTitle(t,rec){if(!t||!rec)return false;const raw=String(rec.rawTitle??rec.title??'').replace(/\s+/g,' ').trim(),title=normalizeFutabaDisplayTitle(rec.title??raw);if(raw&&!t.rawTitle)t.rawTitle=raw;if(title){t.title=title;t.displayTitle=title}t.titleNeedsCompletion=false;t.titleSource=rec.source||'thread';t.titleCatalogComplete=true;return true}
function knownFutabaTitleRecord(t){const key=String(t?.key||futabaThreadKey(t?.url)||'');if(!key)return null;const cached=futabaTitleCache.get(key);if(validFutabaTitleRecord(cached)){futabaTitleMetrics.cacheHits++;return cached}if(cached)futabaTitleCache.delete(key);const pane=panes.find(p=>p.kind==='thread'&&p.board==='futaba'&&p.initialized&&futabaThreadKey(p.url)===key&&String(p.title||'').trim());if(pane){const rec={rawTitle:String(pane.rawTitle||pane.title).trim(),title:normalizeFutabaDisplayTitle(pane.title),source:'open-pane',confirmed:true,expiresAt:Date.now()+FUTABA_TITLE_CACHE_MS};cacheRemember(futabaTitleCache,key,rec,480);futabaTitleMetrics.paneHits++;return rec}return null}
function applyKnownFutabaTitles(threads=[]){for(const t of threads||[]){if(t?.board!=='futaba'&&!/may\.2chan\.net/i.test(String(t?.url||'')))continue;normalizeFutabaThreadRecord(t);const rec=knownFutabaTitleRecord(t);if(rec)setFutabaThreadTitle(t,rec)}return threads}
function patchFutabaTitleEverywhere(key,rec){key=String(key||'');if(!key||!rec)return;for(const data of boardCaches.values())for(const t of data?.threads||[])if(String(t.key)===key)setFutabaThreadTitle(t,rec);for(const state of Object.values(tickerState.feeds||{})){for(const list of [state?.rankSnapshot,state?.pendingSnapshot])for(const t of list||[])if(t?.board==='futaba'&&String(t.key)===key)setFutabaThreadTitle(t,rec)}document.querySelectorAll(`[data-thread-key="${key}"],[data-key="${key}"]`).forEach(el=>{const label=el.querySelector('.rankTitle,.catTitle');if(label&&rec.title)label.textContent=rec.title;if(rec.title)el.title=rec.title;el.dataset.titleNeedsCompletion='0'})}
function rememberFutabaThreadTitle(key,title,{source='thread',confirmed=true,rawTitle=''}={}){key=String(key||'');const raw=String(rawTitle||title||'').replace(/\s+/g,' ').trim();title=normalizeFutabaDisplayTitle(title||raw);if(!key)return null;const rec={rawTitle:raw,title,source,confirmed:!!confirmed,expiresAt:Date.now()+FUTABA_TITLE_CACHE_MS};cacheRemember(futabaTitleCache,key,rec,480);futabaTitleBackoff.delete(key);patchFutabaTitleEverywhere(key,rec);return rec}
function futabaTitleRequestAllowed(key){const rec=futabaTitleCache.get(key);if(validFutabaTitleRecord(rec))return false;return Date.now()>=Number(futabaTitleBackoff.get(key)||0)}
function drainFutabaTitleQueue(){while(futabaTitleActive<FUTABA_TITLE_MAX_CONCURRENT&&futabaTitleQueue.length){const job=futabaTitleQueue.shift();if(!job||!futabaTitleQueued.has(job.key))continue;if(!futabaTitleRequestAllowed(job.key)){futabaTitleQueued.delete(job.key);continue}futabaTitleActive++;futabaTitleMetrics.maxActive=Math.max(futabaTitleMetrics.maxActive,futabaTitleActive);futabaTitleMetrics.requests++;void api(`/api/thread?board=futaba&url=${encodeURIComponent(job.url)}&purpose=background`,{timeoutMs:10000}).then(j=>{const title=String(j?.title||job.currentTitle||'').replace(/\s+/g,' ').trim();rememberFutabaThreadTitle(job.key,title,{source:'thread-body',confirmed:true,rawTitle:j?.rawTitle||title});futabaTitleMetrics.completed++}).catch(()=>{cacheRemember(futabaTitleBackoff,job.key,Date.now()+FUTABA_TITLE_BACKOFF_MS,480);futabaTitleMetrics.failures++}).finally(()=>{futabaTitleActive=Math.max(0,futabaTitleActive-1);futabaTitleQueued.delete(job.key);drainFutabaTitleQueue()})}}
function queueFutabaTitleCompletion({key,url,currentTitle=''}){key=String(key||futabaThreadKey(url)||'');url=safeUrl(url);if(!key||!url||!futabaTitleRequestAllowed(key)||futabaTitleQueued.has(key))return false;futabaTitleQueued.add(key);futabaTitleQueue.push({key,url,currentTitle:String(currentTitle||'')});drainFutabaTitleQueue();return true}
function observeFutabaTitleCandidates(root){if(!root)return;const selector='[data-title-needs-completion="1"][data-thread-url][data-thread-key], [data-title-needs-completion="1"][data-thread-url][data-key]';const nodes=[...root.querySelectorAll(selector)];if(!nodes.length)return;if(!('IntersectionObserver' in window)){for(const el of nodes.slice(0,2)){const key=el.dataset.threadKey||el.dataset.key;queueFutabaTitleCompletion({key,url:el.dataset.threadUrl,currentTitle:el.title})}return}let ob=futabaTitleObservers.get(root);if(!ob){ob=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;const el=entry.target;ob.unobserve(el);const key=el.dataset.threadKey||el.dataset.key;const rec=knownFutabaTitleRecord({key,url:el.dataset.threadUrl,board:'futaba'});if(rec){patchFutabaTitleEverywhere(key,rec);continue}queueFutabaTitleCompletion({key,url:el.dataset.threadUrl,currentTitle:el.title})}},{root,rootMargin:'80px'});futabaTitleObservers.set(root,ob)}for(const el of nodes)ob.observe(el)}
function trimUrlPunct(u=''){return u.replace(/[\])}>,.!?。、；;]+$/g,'')}
function extractUrls(text=''){
  const out=[]; const re=/https?:\/\/[^\s<>"']+/gi; let m;
  while((m=re.exec(text))){const u=trimUrlPunct(m[0]);if(u&&!out.includes(u))out.push(u)}
  return out;
}
function isImageUrl(u=''){
  if(/\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(u))return true;
  try{const x=new URL(u),format=(x.searchParams.get('format')||'').toLowerCase();return x.hostname==='pbs.twimg.com'&&/^\/media\//.test(x.pathname)&&/^(?:png|jpe?g|gif|webp|avif)$/.test(format)}catch{return false}
}
function isVideoUrl(u=''){return /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(u)}
function xStatusId(u=''){return (u.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)||[])[1]||''}
function youtubeId(u=''){
  try{const x=new URL(u);if(/(?:^|\.)youtu\.be$/i.test(x.hostname))return x.pathname.split('/').filter(Boolean)[0]||'';
    if(/(?:^|\.)youtube\.com$/i.test(x.hostname)||/(?:^|\.)youtube-nocookie\.com$/i.test(x.hostname)){
      if(x.pathname==='/watch')return x.searchParams.get('v')||'';
      const m=x.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);return m?.[1]||'';
    }
  }catch{}return '';
}
function parseTimeSeconds(v=''){
  v=String(v||'').trim();if(!v)return 0;if(/^\d+$/.test(v))return Number(v)||0;
  let total=0;const re=/(\d+)(h|m|s)/gi;let m,hit=false;while((m=re.exec(v))){hit=true;const n=Number(m[1])||0;total+=m[2].toLowerCase()==='h'?n*3600:m[2].toLowerCase()==='m'?n*60:n}return hit?total:0;
}
function youtubeStart(u=''){
  try{const x=new URL(u);return parseTimeSeconds(x.searchParams.get('t')||x.searchParams.get('start')||x.hash.replace(/^#t=/,''))}catch{return 0}
}
function scopedPath(path){const m=location.pathname.match(/^\/__lb\/[^/]+/);return m?m[0]+path:path}
function boardMediaSrc(url){const u=safeUrl(url);if(!u)return '';try{const h=new URL(u).hostname;if(h.endsWith('.2chan.net'))return scopedPath('/api/image?url='+encodeURIComponent(u))}catch{}return scopedPath('/api/media?url='+encodeURIComponent(u))}
function mediaAttemptSrc(url,attempt=0){const src=boardMediaSrc(url);if(!src||!attempt)return src;return src+(src.includes('?')?'&':'?')+'__lb_retry='+encodeURIComponent(String(attempt))}
function videoMediaSrc(url){const u=safeUrl(url);return u?scopedPath('/api/video?url='+encodeURIComponent(u)):''}
async function api(path,{timeoutMs=0,signal}={}){const signals=[];if(signal)signals.push(signal);if(timeoutMs>0)signals.push(AbortSignal.timeout(timeoutMs));const requestSignal=signals.length>1?AbortSignal.any(signals):signals[0];const r=await fetch(scopedPath(path),{cache:'no-store',signal:requestSignal});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`${r.status}`);return j}
function cacheKey(board,sort='hot'){return `${board}:${sort}`}
function toast(msg){const el=$('#toast');el.textContent=msg;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,2400)}

function isNoticeThread(boardId,title=''){
  if(boardId!=='5ch')return false;
  return /5ちゃんねるから新しいお知らせです|UPLIFT\s*(?:プレミアム|Premium)?[^\n]*サービスのお知らせ/i.test(title);
}
function isThreadOpenable(boardId,t){const limit=boardOf(boardId)?.limit||Infinity;return (Number(t.count)||0)<limit&&!isNoticeThread(boardId,t.title||'')}


function isWsbPane(p){return !!p&&p.kind==='thread'&&p.board==='wsb'}
function isWsbSamplePane(p){return isWsbPane(p)&&p.wsbSample===true}
function wsbThreadFullnameForPane(p){const ref=normalizeThreadRef('wsb',p?.url||'');return ref?`t3_${ref.sourceThreadId}`:''}
function defaultWsbBridge(){const d=window.liveboardDesktop||{};return {
  startThread:payload=>d.startWsbThread?.(payload)??Promise.resolve({ok:false,reason:'reddit_api_approval_required'}),
  stopThread:payload=>d.stopWsbThread?.(payload)??Promise.resolve({ok:true}),
  pauseAll:payload=>d.pauseWsb?.(payload)??Promise.resolve({ok:true}),
  resumeAll:payload=>d.resumeWsb?.(payload)??Promise.resolve({ok:true}),
  stopHelper:payload=>d.stopWsbHelper?.(payload)??Promise.resolve({ok:true}),
  setRetention:payload=>d.setWsbRetention?.(payload)??Promise.resolve({ok:true})
}}
function installWsbLifecycle(bridge=defaultWsbBridge()){
  try{wsbBridgeUnsubscribe?.()}catch{}wsbBridgeUnsubscribe=null;
  wsbPaneLifecycle=new WsbPaneLifecycle({bridge});
  if(typeof window.liveboardDesktop?.onWsbEvent==='function')wsbBridgeUnsubscribe=window.liveboardDesktop.onWsbEvent(event=>dispatchWsbRuntimeEvent(event));
  return wsbPaneLifecycle
}
function ensureWsbLifecycle(){return wsbPaneLifecycle||installWsbLifecycle()}
function wsbPaneFields(p){if(!isWsbPane(p))return p;p.wsbOrdinalById=p.wsbOrdinalById instanceof Map?p.wsbOrdinalById:new Map();p.wsbOrdinalSeq=Number(p.wsbOrdinalSeq)||0;p.wsbProviderGeneration=Number(p.wsbProviderGeneration)||0;p.wsbStatus=p.wsbStatus&&typeof p.wsbStatus==='object'?p.wsbStatus:{};p.draft='';return p}
function wsbBannerText(p){const s=p?.wsbStatus||{},parts=[];if(isWsbSamplePane(p))parts.push('サンプル・実際の投稿ではありません');if(s.hiddenPaused)parts.push('非表示中は取得・翻訳を停止しています');if(s.gap)parts.push('この区間に未取得あり');if(s.retentionPaused)parts.push('閲覧位置保護のため新着取得を停止');else if(s.trimmed)parts.push(`古いデータを${Number(s.trimmed)||0}件切り捨てました`);const backlog=Math.max(0,Number(s.backlog)||0),delay=Math.max(0,Number(s.oldestWaitMs)||0);if(backlog||delay){const mins=Math.max(1,Math.ceil(delay/60000));parts.push(`翻訳待ち${backlog}・約${mins}分遅延`)}if(s.highWater)parts.push('翻訳待ちのため新着取得を一時停止');if(s.switchNotice)parts.push(String(s.switchNotice));if(s.error)parts.push(String(s.error));return parts.join(' · ')}
function updateWsbStatusBanner(p){if(!isWsbPane(p))return;const el=paneElement(p),banner=el?.querySelector('.wsbStatusBanner');if(!banner)return;const text=wsbBannerText(p),hidden=!text,warning=!!(p.wsbStatus?.highWater||p.wsbStatus?.gap||p.wsbStatus?.error||p.wsbStatus?.retentionPaused);if(banner.textContent===text&&banner.hidden===hidden&&banner.classList.contains('warning')===warning)return;banner.textContent=text;banner.hidden=hidden;banner.classList.toggle('warning',warning);schedulePanePosition(p,'wsb-status')}
async function attachWsbPane(p){if(!isWsbPane(p)||p.disposed||isWsbSamplePane(p))return null;wsbPaneFields(p);const thread=wsbThreadFullnameForPane(p);if(!thread)return null;try{const snap=await ensureWsbLifecycle().openPane({paneId:p.paneId,threadFullname:thread,url:p.url,title:p.title});p.wsbProviderGeneration=Number(snap?.generation)||1;p.threadStatus='active';p.loading=true;p.source='Reddit / ローカル機械翻訳';p.wsbStatus={...p.wsbStatus,hiddenPaused:!!snap?.hiddenPaused};updatePaneStatus(paneElement(p),p,'WSB 翻訳を準備中…');updateWsbStatusBanner(p);return snap}catch(e){p.loading=false;p.error=String(e?.message||e);p.wsbStatus={...p.wsbStatus,error:'WSB接続を開始できません'};updatePaneStatus(paneElement(p),p);updateWsbStatusBanner(p);return null}}
async function detachWsbPane(p){if(!isWsbPane(p)||isWsbSamplePane(p)||!wsbPaneLifecycle)return;try{await wsbPaneLifecycle.closePane(p.paneId)}catch{}}
function wsbSyncPostMap(p){p.postMap=new Map((p.posts||[]).map(x=>[String(x.n),x]));p.quoteComponentByPost=new Map();syncPostLayoutMetadata(p)}
function enforceWsbRetention(p,box=null){if(!isWsbPane(p))return {removed:[]};if((p.posts?.length||0)<=WSB_STAGE09_LIMITS.retainedPostsPerPane){if(p.wsbStatus?.retentionPaused){p.wsbStatus={...p.wsbStatus,retentionPaused:false};void wsbPaneLifecycle?.updateRetention?.(p.paneId,false);updateWsbStatusBanner(p)}return {removed:[]}};const protectedKeys=[p.anchorPostId,p.readingAnchor?.key,p.stableAnchor?.key,p.history?.entries?.[p.history?.index]?.anchorPostId].filter(Boolean),trim=trimWsbPosts(p.posts,{limit:WSB_STAGE09_LIMITS.retainedPostsPerPane,protectedKeys});if(trim.removed.length||trim.paused){p.posts=trim.posts;for(const key of trim.removed)if(String(key).startsWith('reddit:'))p.wsbOrdinalById?.delete?.(String(key).slice(7));wsbSyncPostMap(p);p.wsbStatus={...p.wsbStatus,trimmed:(Number(p.wsbStatus?.trimmed)||0)+trim.removed.length,retentionPaused:!!trim.paused};void wsbPaneLifecycle?.updateRetention?.(p.paneId,!!trim.paused);if(box){const anchor=!p.follow?capturePostAnchor(box):null,index=anchor?postIndexForKey(p,anchor.key):Math.max(0,p.posts.length-1),range=virtualWindowForIndex(p,index>=0?index:0);renderVirtualWindow(p,box,range[0],range[1],{anchor,reason:'wsb-retention',revision:p.userIntentRevision,force:true})}updateWsbStatusBanner(p)}return trim}
function mergeWsbTranslatedIntoPane(p,incoming=[]){const el=paneElement(p);if(!el||!incoming.length)return;const box=el.querySelector('.posts'),first=!p.initialized||!p.posts.length,wasFollow=p.follow,revision=Number(p.userIntentRevision)||0,anchor=!wasFollow?capturePostAnchor(box):null;const diff=threadStore.merge(p,incoming,{complete:false});wsbSyncPostMap(p);p.total=p.posts.length;p.initialized=true;p.loading=false;p.lastSuccessAt=fmtTime();if(diff.inserted.length){if(wasFollow)p.newCount=0;else p.newCount+=diff.inserted.length}enforceWsbRetention(p,box);if(first){paintInitial(el,p)}else if(wasFollow){const [start,end]=virtualWindowForIndex(p,Math.max(0,p.posts.length-1));renderVirtualWindow(p,box,start,end,{reason:'wsb-batch-tail',revision,force:true})}else{const index=anchor?postIndexForKey(p,anchor.key):Math.max(0,p.renderWindowStart),[start,end]=virtualWindowForIndex(p,index>=0?index:0);renderVirtualWindow(p,box,start,end,{anchor,reason:'wsb-batch',revision,force:true})}schedulePanePosition(p,'wsb-batch');updateNewButton(el,p);updatePaneStatus(el,p,'WSB 翻訳済み '+p.posts.length+'件');updateWsbStatusBanner(p)}
function applyWsbTranslatedBatch(p,event={}){if(!isWsbPane(p)||p.disposed)return false;wsbPaneFields(p);const thread=wsbThreadFullnameForPane(p);if(event.threadFullname&&String(event.threadFullname)!==thread)return false;if(event.generation!=null&&Number(event.generation)!==Number(p.wsbProviderGeneration))return false;const rows=Array.isArray(event.items)?event.items:Array.isArray(event.rows)?event.rows:[],posts=[];for(const row of rows){const fullname=String(row.commentId||row.fullname||row.id||'');if(!/^t1_[a-z0-9]+$/i.test(fullname))continue;let ordinal=p.wsbOrdinalById.get(fullname);if(!ordinal){ordinal=++p.wsbOrdinalSeq;p.wsbOrdinalById.set(fullname,ordinal)}try{posts.push(mapTranslatedWsbRow(row,ordinal))}catch{}}if(!posts.length)return false;mergeWsbTranslatedIntoPane(p,posts);return true}
function removeWsbComments(p,ids=[]){if(!isWsbPane(p)||!ids?.length)return;const keys=new Set(ids.map(x=>String(x).startsWith('reddit:')?String(x):`reddit:${x}`)),before=p.posts.length;p.posts=p.posts.filter(post=>!keys.has(String(post.key)));if(p.posts.length===before)return;for(const key of keys)if(String(key).startsWith('reddit:'))p.wsbOrdinalById?.delete?.(String(key).slice(7));wsbSyncPostMap(p);const box=paneElement(p)?.querySelector('.posts');enforceWsbRetention(p,box);const anchor=box&&!p.follow?capturePostAnchor(box):null,index=anchor?postIndexForKey(p,anchor.key):Math.max(0,p.posts.length-1),range=virtualWindowForIndex(p,index>=0?index:0);if(box)renderVirtualWindow(p,box,range[0],range[1],{anchor,reason:'wsb-delete',revision:p.userIntentRevision,force:true});p.total=p.posts.length;updateWsbStatusBanner(p)}
function applyWsbStatus(p,event={}){if(!isWsbPane(p))return;p.wsbStatus={...p.wsbStatus,backlog:Number(event.backlog)||0,oldestWaitMs:Number(event.oldestWaitMs)||0,highWater:!!event.highWater,gap:!!event.gap,retentionPaused:!!event.retentionPaused,hiddenPaused:!!event.hiddenPaused,error:String(event.error||'')};updateWsbStatusBanner(p)}
function dispatchWsbRuntimeEvent(event={}){const type=String(event.type||''),targets=panes.filter(p=>isWsbPane(p)&&(!event.paneId||p.paneId===event.paneId)&&(!event.threadFullname||wsbThreadFullnameForPane(p)===event.threadFullname)&&(event.generation==null||Number(event.generation)===Number(p.wsbProviderGeneration)));for(const p of targets){if(type==='translated-batch')applyWsbTranslatedBatch(p,event);else if(type==='status'||type==='gap')applyWsbStatus(p,{...event,gap:type==='gap'||event.gap});else if(type==='deleted')removeWsbComments(p,event.commentIds||event.ids||[]);else if(type==='switch-candidate'){const next=event.thread||event.candidate;if(!next?.url)continue;if(p.follow&&p.liveMode)void navigateWsbPane(p,next,{kind:'live-next'});else{p.wsbStatus={...p.wsbStatus,switchNotice:`後継候補: ${String(next.title||'新しい実況スレッド')}`};updateWsbStatusBanner(p)}}}}
async function addWsbPane(t={}){const ref=normalizeThreadRef('wsb',t.url||'');if(!ref){toast('WSBスレッドURLを確認できません');return null}if(panes.length>=MAX_PANES){toast(`ペインは最大${MAX_PANES}個です`);return null}const p=paneState({board:'wsb',url:ref.canonicalUrl,title:t.title||'WallStreetBets',liveMode:t.liveMode!==false,follow:t.follow!==false,viewIntent:t.follow===false?'top':'tail'});wsbPaneFields(p);p.history=normalizeHistory(null,p);panes.push(p);save();renderPanes();await attachWsbPane(p);requestAnimationFrame(()=>focusPane(p));return p}
async function navigateWsbPane(p,targetInput,{kind='link',historyIndex=null}={}){if(!isWsbPane(p)||p.disposed)return false;if(isWsbSamplePane(p))return navigateWsbSamplePane(p,targetInput,{kind,historyIndex});cancelHistoryGesture('pane-navigation',p.paneId);const ref=normalizeThreadRef('wsb',targetInput?.url||targetInput||'');if(!ref)return false;if(ref.threadId===p.threadId&&kind!=='history')return true;const box=paneElement(p)?.querySelector('.posts');commitPaneDepartureSnapshot(p,box,{reason:`wsb-${kind}`,settleFollowing:true});const oldHistory=p.history,nextTitle=targetInput?.title||(kind==='history'?oldHistory?.entries?.[historyIndex]?.title:'')||'WallStreetBets';let snap;try{snap=await ensureWsbLifecycle().switchPane({paneId:p.paneId,threadFullname:`t3_${ref.sourceThreadId}`,url:ref.canonicalUrl,title:nextTitle})}catch(e){p.wsbStatus={...p.wsbStatus,error:`WSBスレッドを切り替えられません: ${String(e?.message||e)}`};updateWsbStatusBanner(p);return false}if(p.disposed)return false;p.generation++;p.analysisEpoch++;p.positionEpoch++;if(kind==='history')p.history=moveHistory(oldHistory,historyIndex);else p.history=pushHistory(oldHistory,{board:'wsb',threadId:ref.threadId,url:ref.canonicalUrl,title:nextTitle,anchorPostId:'',anchorOffset:0,follow:p.follow,unreadCount:0});if(kind!=='live-next'){p.liveMode=false;p.follow=false}p.threadId=ref.threadId;p.url=ref.canonicalUrl;p.title=nextTitle||p.history.entries[p.history.index]?.title||'WallStreetBets';p.posts=[];p.postMap=new Map();p.initialized=false;p.newCount=0;p.wsbOrdinalById=new Map();p.wsbOrdinalSeq=0;p.wsbStatus={};p.anchorPostId=kind==='history'?(p.history.entries[p.history.index]?.anchorPostId||''):'';p.anchorOffset=kind==='history'?(Number(p.history.entries[p.history.index]?.anchorOffset)||0):0;p.lastReadPostId=kind==='history'?(p.history.entries[p.history.index]?.lastReadPostId||''):'';p.viewIntent=kind==='history'?'restore':(p.follow?'tail':'top');resetRenderSessionState(p);p.wsbProviderGeneration=Number(snap?.generation)||1;save();renderPanes();updateHistoryButtons(paneElement(p),p);updateWsbStatusBanner(p);return true}
const WSB_REDDIT_STATUS_LABELS={unconfigured:'未設定',approval_pending:'承認確認待ち',auth_required:'認証が必要',connectable:'接続可能',failed:'接続失敗'};
const WSB_TRANSLATION_STATUS_LABELS={unprepared:'未準備',language_not_ready:'未準備',preparing:'言語データ準備中',ready:'使用可能',helper_error:'helperエラー',unsupported_platform:'helperエラー'};
const WSB_REASON_LABELS={reddit_client_id_missing:'Reddit public client IDが未設定です',reddit_api_approval_not_confirmed:'Reddit API利用承認済みであることが確認されていません',reddit_oauth_required:'Reddit OAuth認証が必要です',secure_storage_unavailable:'安全なtoken保存領域を使用できません',reddit_oauth_timeout:'Reddit認証が時間切れになりました',reddit_oauth_cancelled:'Reddit認証を中止しました',reddit_forbidden:'Reddit APIから403が返されました',reddit_http_403_forbidden:'Reddit APIから403が返されました',reddit_rate_limited:'Reddit APIのrate limit（429）です',reddit_http_429_rate_limited:'Reddit APIのrate limit（429）です',reddit_network_error:'Redditとの通信に失敗しました',reddit_network_timeout:'Redditとの通信が時間切れになりました',helper_missing:'翻訳helperが見つかりません',helper_binary_missing:'翻訳helperが見つかりません',helper_not_executable:'翻訳helperを実行できません',language_not_ready:'英語→日本語の言語データが未準備です',language_assets_not_ready:'英語→日本語の言語データが未準備です',translation_helper_timeout:'翻訳helperが時間切れになりました',unsupported_platform:'この環境ではApple Translationを使用できません',apple_translation_requires_macos:'Apple TranslationはmacOSでのみ使用できます'};
function wsbStatusLabel(map,key,fallback='未準備'){return map[String(key||'')]||fallback}
function wsbReasonLabel(reason=''){const key=String(reason||'');return WSB_REASON_LABELS[key]||key||'詳細なし'}
function renderWsbSetupStatus(caps=wsbCapability){
  const reddit=caps.reddit||{},translation=caps.translation||{};
  const r=$('#wsbRedditStatus'),t=$('#wsbTranslationStatus'),detail=$('#wsbReasonDetail');
  if(r)r.textContent=wsbStatusLabel(WSB_REDDIT_STATUS_LABELS,reddit.status,'未設定');
  if(t)t.textContent=wsbStatusLabel(WSB_TRANSLATION_STATUS_LABELS,translation.status,'未準備');
  if(detail)detail.textContent=[reddit.reason&&`Reddit: ${wsbReasonLabel(reddit.reason)} (${reddit.reason})`,translation.reason&&`翻訳: ${wsbReasonLabel(translation.reason)} (${translation.reason})`].filter(Boolean).join('\n')||'詳細なエラーはありません';
  const test=$('#wsbTranslationTest');if(test)test.disabled=translation.status!=='ready';
  const candidates=$('#wsbCandidates');if(candidates)candidates.disabled=reddit.status!=='connectable';
  const disconnect=$('#wsbDisconnect');if(disconnect){disconnect.disabled=!wsbAuthPending&&!reddit.authenticated&&reddit.status!=='connectable';disconnect.textContent=wsbAuthPending?'認証を中止':'Reddit接続を解除'};
}
async function configureWsbCapability(){
  const btn=$('#wsbBtn');if(!btn)return wsbCapability;let caps={available:false,reason:'reddit_api_approval_required',translationReady:false,reddit:{status:'unconfigured',reason:'reddit_client_id_missing'},translation:{status:'unprepared',reason:'helper_not_checked'}};
  try{caps=await window.liveboardDesktop?.wsbCapabilities?.()||caps}catch(e){caps={...caps,reason:'capability_check_failed',translation:{status:'helper_error',reason:String(e?.message||e)}}}
  Object.assign(wsbCapability,{checked:true,...caps,reddit:{...caps.reddit},translation:{...caps.translation}});btn.hidden=false;btn.disabled=false;btn.title='r/wallstreetbets の準備・サンプル・接続状態';renderWsbSetupStatus(wsbCapability);return wsbCapability
}
async function loadWsbSettings(){try{const settings=await window.liveboardDesktop?.getWsbSettings?.(),input=$('#wsbClientId'),approval=$('#wsbApprovalConfirmed');if(input)input.value=String(settings?.redditClientId||'');if(approval)approval.checked=settings?.redditApprovalConfirmed===true}catch{}}
async function openWsbSetupPanel(){const panel=$('#wsbSetupPanel');if(!panel)return;panel.hidden=false;$('#wsbCandidateArea').hidden=true;$('#wsbCandidateList').innerHTML='';$('#wsbStatusOutput').textContent='';await Promise.allSettled([loadWsbSettings(),configureWsbCapability()]);if(wsbCapability.reddit?.status==='connectable')void loadWsbCandidatesUi({quiet:true});requestAnimationFrame(()=>$('#wsbSetupClose')?.focus())}
function closeWsbSetupPanel(){const panel=$('#wsbSetupPanel');if(panel)panel.hidden=true;$('#wsbSettingsFields')?.setAttribute('hidden','')}
function setWsbOutput(text='',ok=null){const out=$('#wsbStatusOutput');if(!out)return;out.textContent=String(text||'');if(ok==null)delete out.dataset.ok;else out.dataset.ok=String(!!ok)}
async function saveWsbSettingsUi(){const bridge=window.liveboardDesktop;if(!bridge?.saveWsbSettings)return;try{const approval=$('#wsbApprovalConfirmed')?.checked===true,result=await bridge.saveWsbSettings({redditClientId:$('#wsbClientId')?.value||'',redditApprovalConfirmed:approval});Object.assign(wsbCapability,result?.capabilities||{});renderWsbSetupStatus(wsbCapability);$('#wsbCandidateArea').hidden=true;setWsbOutput(approval?'設定を保存しました。承認済みclient IDとしてOAuth認証を開始できます。チェック自体はRedditの承認を取得する操作ではありません。':'設定を保存しました。API利用承認済みになるまで実Reddit接続は行いません。',true)}catch(e){setWsbOutput(`設定を保存できません: ${e?.message||e}`,false)}}
async function prepareWsbTranslationUi(){const bridge=window.liveboardDesktop;if(!bridge?.prepareWsbTranslation)return;setWsbOutput('言語データ準備画面を開いています…');const btn=$('#wsbPrepareTranslation');if(btn)btn.disabled=true;try{const result=await bridge.prepareWsbTranslation();await configureWsbCapability();setWsbOutput(result?.translation?.ready?'英語→日本語の言語データを使用できます。':'言語データの準備結果を確認してください。',!!result?.translation?.ready)}catch(e){setWsbOutput(`翻訳準備を開始できません: ${e?.message||e}`,false)}finally{if(btn)btn.disabled=false}}
async function testWsbTranslationUi(){const bridge=window.liveboardDesktop;if(!bridge?.testWsbTranslation)return;const btn=$('#wsbTranslationTest');if(btn)btn.disabled=true;setWsbOutput('ローカル翻訳helperを確認しています…');try{const result=await bridge.testWsbTranslation('Markets are green today.');setWsbOutput(result?.ok?`offline翻訳: ${result.target}`:`ローカル翻訳テスト失敗: ${result?.reason||'unknown'}`,!!result?.ok)}catch(e){setWsbOutput(`ローカル翻訳テスト失敗: ${e?.message||e}`,false)}finally{if(btn)btn.disabled=false}}
async function testWsbConnectionUi(){const bridge=window.liveboardDesktop;if(!bridge?.testWsbConnection)return;try{const r=await bridge.testWsbConnection(),label=wsbStatusLabel(WSB_REDDIT_STATUS_LABELS,r?.status,'接続失敗');setWsbOutput(r?.ok?`Reddit接続: ${label}`:`Reddit接続: ${label}（${wsbReasonLabel(r?.reason)}）`,!!r?.ok);await configureWsbCapability()}catch(e){setWsbOutput(`接続テスト失敗: ${wsbReasonLabel(e?.message||e)}`,false)}}
async function connectWsbRedditUi(){const bridge=window.liveboardDesktop;if(!bridge?.connectWsbReddit)return;const btn=$('#wsbConnect');if(btn)btn.disabled=true;wsbAuthPending=true;renderWsbSetupStatus(wsbCapability);setWsbOutput('ブラウザでReddit OAuth認証を完了してください。tokenはLiveBoardのmain processだけで暗号化保存されます。');try{const r=await bridge.connectWsbReddit();if(r?.capabilities)Object.assign(wsbCapability,r.capabilities);else await configureWsbCapability();setWsbOutput('Reddit OAuth認証が完了しました。実況候補を取得します。',true);await loadWsbCandidatesUi()}catch(e){await configureWsbCapability();setWsbOutput(`Reddit認証を完了できません: ${wsbReasonLabel(e?.message||e)}`,false)}finally{wsbAuthPending=false;renderWsbSetupStatus(wsbCapability);if(btn)btn.disabled=false}}
async function disconnectWsbRedditUi(){const bridge=window.liveboardDesktop;if(!bridge)return;try{if(wsbAuthPending&&bridge.cancelWsbRedditAuth){await bridge.cancelWsbRedditAuth();wsbAuthPending=false;await configureWsbCapability();renderWsbSetupStatus(wsbCapability);setWsbOutput('Reddit OAuth認証を中止しました。',true);return}if(!bridge.disconnectWsbReddit)return;const r=await bridge.disconnectWsbReddit();if(r?.capabilities)Object.assign(wsbCapability,r.capabilities);else await configureWsbCapability();renderWsbSetupStatus(wsbCapability);$('#wsbCandidateArea').hidden=true;setWsbOutput('Reddit OAuth tokenを削除し、WSB取得・翻訳runtimeを停止しました。',true)}catch(e){setWsbOutput(`接続解除に失敗しました: ${e?.message||e}`,false)}}
function renderWsbCandidates(result={}){const area=$('#wsbCandidateArea'),list=$('#wsbCandidateList');if(!area||!list)return;const rows=(Array.isArray(result.ranked)&&result.ranked.length?result.ranked:Array.isArray(result.menu)?result.menu:[]).slice(0,5);list.innerHTML=rows.map((c,i)=>`<button class="wsbCandidate" type="button" data-index="${i}"><span class="wsbCandidateTitle">${esc(c.title||'r/wallstreetbets')}</span><span class="wsbCandidateMeta">${Number(c.numComments)||0} comments</span><span class="wsbCandidateHint">${result.ambiguous?'候補が拮抗しています。開くスレッドを選択してください。':(result.automatic?.id===c.id?'自動候補':'候補')}</span></button>`).join('')||'<div class="wsbSettingsHint">現在開ける実況候補が見つかりませんでした。</div>';area.hidden=false;list.querySelectorAll('.wsbCandidate').forEach(btn=>btn.onclick=async()=>{const c=rows[Number(btn.dataset.index)||0];if(!c?.url)return;btn.disabled=true;const pane=await addWsbPane({url:c.url,title:c.title||'r/wallstreetbets',liveMode:true,follow:true});if(pane)closeWsbSetupPanel();else btn.disabled=false})}
async function loadWsbCandidatesUi({quiet=false}={}){const bridge=window.liveboardDesktop;if(!bridge?.getWsbCandidates)return null;const btn=$('#wsbCandidates');if(btn)btn.disabled=true;if(!quiet)setWsbOutput('Redditから現在の実況候補を取得しています…');try{const result=await bridge.getWsbCandidates();renderWsbCandidates(result||{});if(!quiet)setWsbOutput(result?.ambiguous?'候補が拮抗しています。開くスレッドを選択してください。':'実況候補を更新しました。',true);return result}catch(e){if(!quiet)setWsbOutput(`実況候補を取得できません: ${wsbReasonLabel(e?.message||e)}`,false);return null}finally{if(btn)btn.disabled=wsbCapability.reddit?.status!=='connectable'}}
function wsbSamplePosts(variant=1){const rows=[
  ['NVDA is cooked after that guidance cut.','NVDAはガイダンス引き下げ後で厳しい、という投稿例です。'],
  ['Diamond hands until CPI. Calls are printing.','CPIまでは握る。コールが利益になっている、という投稿例です。'],
  ['I am not chasing this pump. Waiting for the pullback.','この上昇は追わず、押し目を待つ、という投稿例です。'],
  ['SPY volume is dead. Do not overtrade the chop.','SPYの出来高が薄いので、往復相場で売買しすぎない、という投稿例です。'],
  ['Bought the dip with a tiny position. Risk is capped.','小さいポジションで押し目買いし、損失上限を決めている、という投稿例です。']
];return Array.from({length:120},(_,i)=>{const r=rows[i%rows.length],n=i+1,id=`t1_lbs${variant}${String(n).padStart(3,'0')}`;return {key:`reddit:${id}`,n,name:`u/sample_${(i%7)+1}`,id,date:`2026/09/22 ${variant?20:19}:${String(i%60).padStart(2,'0')}:00`,body:`${r[1]}（サンプル ${variant+1}-${n}）`,attachments:[],redditSampleTranslated:true,redditOriginal:r[0]}})}
function setWsbSampleContent(p,variant=1){p.wsbSampleVariant=variant;p.posts=wsbSamplePosts(variant);p.postMap=new Map(p.posts.map(x=>[String(x.n),x]));p.total=p.posts.length;p.initialized=true;p.loading=false;p.source='synthetic sample fixture';p.threadStatus='active';p.wsbStatus={sample:true};p.wsbOrdinalById=new Map();p.wsbOrdinalSeq=0;syncPostLayoutMetadata(p)}
async function navigateWsbSamplePane(p,targetInput,{kind='history',historyIndex=null}={}){const ref=normalizeThreadRef('wsb',targetInput?.url||targetInput||'');if(!ref)return false;const variant=String(ref.sourceThreadId||'').endsWith('0')?0:1,oldHistory=p.history;commitPaneDepartureSnapshot(p,paneElement(p)?.querySelector('.posts'),{reason:`wsb-sample-${kind}`,settleFollowing:true});p.history=kind==='history'?moveHistory(oldHistory,historyIndex):oldHistory;p.threadId=ref.threadId;p.url=ref.canonicalUrl;p.title=targetInput?.title||`r/wallstreetbets サンプル ${variant+1}`;p.generation++;p.follow=false;p.liveMode=false;p.viewIntent=kind==='history'?'restore':'top';resetRenderSessionState(p);setWsbSampleContent(p,variant);renderPanes();updateHistoryButtons(paneElement(p),p);updateWsbStatusBanner(p);return true}
function addWsbSamplePane(){const existing=panes.find(isWsbSamplePane);if(existing){focusPane(existing);return existing}if(panes.length>=MAX_PANES){toast(`ペインは最大${MAX_PANES}個です`);return null}const urls=['https://www.reddit.com/r/wallstreetbets/comments/lbsample0/liveboard_sample_older/','https://www.reddit.com/r/wallstreetbets/comments/lbsample1/liveboard_sample/'],p=paneState({board:'wsb',url:urls[1],title:'r/wallstreetbets サンプル 2',liveMode:false,follow:false,viewIntent:'top',wsbSample:true});const r0=normalizeThreadRef('wsb',urls[0]),r1=normalizeThreadRef('wsb',urls[1]);p.history=normalizeHistory({index:1,entries:[{board:'wsb',threadId:r0.threadId,url:r0.canonicalUrl,title:'r/wallstreetbets サンプル 1',anchorPostId:'',anchorOffset:0,follow:false,unreadCount:0},{board:'wsb',threadId:r1.threadId,url:r1.canonicalUrl,title:'r/wallstreetbets サンプル 2',anchorPostId:'',anchorOffset:0,follow:false,unreadCount:0}]},p);setWsbSampleContent(p,1);panes.push(p);renderPanes();requestAnimationFrame(()=>focusPane(p));return p}

function renderBoardNav(){
  $('#boardNav').innerHTML=boards.filter(b=>b.id!=='wsb').map(b=>`<button data-board="${b.id}">${b.name}</button>`).join('')+'<button id="wsbBtn" class="wsbMenuButton" type="button">r/wallstreetbets</button><button id="markdownBtn" class="markdownMenuButton" type="button">AI用Markdown</button><button id="clear" class="clearAll" type="button">全て閉じる</button>';
  $$('#boardNav button[data-board]').forEach(btn=>{
    const open=()=>{drawerPinned=false;drawerReplacePaneId='';void showDrawer(btn.dataset.board,btn,false,{resetTop:true})};
    btn.addEventListener('pointerenter',()=>{menuInputMode='pointer';open()});
    btn.addEventListener('pointerdown',()=>{menuInputMode='pointer'});
    btn.addEventListener('keydown',()=>{menuInputMode='keyboard'});
    btn.addEventListener('focus',()=>{if(menuInputMode==='keyboard')open()});
    btn.addEventListener('click',e=>{e.preventDefault();open()});
  });
  $('#wsbBtn')?.addEventListener('click',e=>{e.preventDefault();openWsbSetupPanel()});
  $('#clear')?.addEventListener('click',()=>{cancelPaneDrag();for(const p of panes)disposePane(p);panes=[];save();renderPanes();hideDrawer();setToolbarMode('hot')});
}

function positionDrawer(anchor){
  const d=$('#threadDrawer'),r=anchor?.getBoundingClientRect();if(!r)return;
  const width=Math.min(426,Math.max(0,window.innerWidth-16));
  const left=Math.max(8,Math.min(r.left,window.innerWidth-width-8));d.style.width=`${width}px`;d.style.left=`${left}px`;d.style.top=`${Math.round(($('#toolbar')?.getBoundingClientRect().bottom||52)+4)}px`;
}
function setToolbarMode(mode='hot'){toolbarMode=mode==='menu'?'menu':'hot';const menu=$('#boardNav'),hot=$('#toolbarHot'),btn=$('#menuBtn'),toolbar=$('#toolbar');if(menu)menu.hidden=toolbarMode!=='menu';if(hot)hot.hidden=toolbarMode!=='hot';if(btn)btn.setAttribute('aria-expanded',String(toolbarMode==='menu'));toolbar?.classList.toggle('menuMode',toolbarMode==='menu');if(toolbarMode==='hot')applyPendingTickerSnapshot();syncTickerAnimationPlayback($('#tickerTrack'))}
function closeMenuToHot(){if($('#threadDrawer')?.classList.contains('open'))return;setToolbarMode('hot')}
function cancelDrawerClose(){clearTimeout(drawerCloseTimer)}
function menuHoverInside(){const d=$('#threadDrawer'),t=$('#toolbar'),keyboard=menuInputMode==='keyboard';return !!(t?.matches(':hover')||d?.matches(':hover')||(keyboard&&(t?.contains(document.activeElement)||d?.contains(document.activeElement))))}
function scheduleDrawerClose(){cancelDrawerClose();drawerCloseTimer=setTimeout(()=>{if(!drawerPinned&&!menuHoverInside())hideDrawer()},180)}
function hideDrawer(){const d=$('#threadDrawer');d.classList.remove('open');d.setAttribute('aria-hidden','true');$$('#boardNav button').forEach(x=>x.classList.remove('active'));drawerReplacePaneId='';closeMenuToHot()}
async function showDrawer(boardId,anchor,pin=false,{resetTop=false,replacePaneId=''}={}){
  cancelDrawerClose();activeBoard=boardId;drawerPinned=pin||drawerPinned;if(replacePaneId)drawerReplacePaneId=replacePaneId;positionDrawer(anchor);
  const d=$('#threadDrawer');d.classList.add('open');d.setAttribute('aria-hidden','false');
  $$('#boardNav button').forEach(x=>x.classList.toggle('active',x.dataset.board===boardId));
  $('#drawerBoardName').textContent=boardOf(boardId)?.name||boardId;updateDrawerHotFeedButton(boardId);
  activeSort=$('#sort').value||'hot';
  await refreshBoard(boardId,activeSort,true);
  const list=$('#threadList');if(resetTop){list.scrollTop=0;requestAnimationFrame(()=>{list.scrollTop=0;requestAnimationFrame(()=>{if($('#threadDrawer').classList.contains('open')&&activeBoard===boardId)list.scrollTop=0})})}
}

function activityNow(){return globalThis.performance?.now?.()??Date.now()}
function observeThreadActivity(boardId,threads=[],observedAt=activityNow(),sourceVersion=''){
  const now=Number(observedAt);if(!Number.isFinite(now))return;
  const listVersion=String(sourceVersion||`list:${now}`);
  for(const t of threads){
    const ref=normalizeThreadRef(boardId,t.url);if(!ref)continue;
    const count=Number(t.count);if(!Number.isFinite(count)||count<0)continue;
    const version=String(t.sourceVersion||listVersion),prev=threadActivity.get(ref.threadId),last=prev?.samples?.at?.(-1);
    let samples=Array.isArray(prev?.samples)?prev.samples.slice():[];
    if(last&&count<last.count)samples=[];
    const sameVersion=samples.findIndex(x=>x.sourceVersion===version);
    if(sameVersion<0)samples.push({count,at:now,sourceVersion:version});
    samples=samples.filter(x=>now-x.at<=120000).sort((a,b)=>a.at-b.at).slice(-120);
    threadActivity.set(ref.threadId,{boardId,samples,lastSeen:now,lastSourceVersion:version});
  }
  const boardEntries=[...threadActivity.entries()].filter(([,v])=>v.boardId===boardId).sort((a,b)=>(b[1].lastSeen||0)-(a[1].lastSeen||0));
  for(const [id] of boardEntries.slice(500))threadActivity.delete(id);
}
function observedActivity(boardId,url){
  const ref=normalizeThreadRef(boardId,url),rec=ref?threadActivity.get(ref.threadId):null,samples=rec?.samples||[],rate=continuationActivityRate(samples);
  let activitySpanMs=0,activityGrowth=0;
  if(rate!=null&&samples.length>=2){const latest=samples.at(-1);const base=samples.find(x=>latest.at-x.at>=20000);if(base){activitySpanMs=Math.max(0,latest.at-base.at);activityGrowth=Math.max(0,latest.count-base.count)}}
  return {rate,sampleCount:samples.length,count:samples.at(-1)?.count??null,activitySpanMs,activityGrowth,sourceVersion:samples.at(-1)?.sourceVersion||'',samples:samples.slice()};
}
const drawerRequestEpoch=new Map();
async function refreshBoard(boardId,sort='hot',render=false){
  const key=cacheKey(boardId,sort),old=boardCaches.get(key);
  const epoch=render?(drawerRequestEpoch.get(key)||0)+1:(drawerRequestEpoch.get(key)||0);if(render)drawerRequestEpoch.set(key,epoch);
  if(render&&!old&&activeBoard===boardId&&activeSort===sort)$('#threadList').innerHTML='<div class="loading">取得中…</div>';
  try{
    const j=await api(`/api/board?board=${encodeURIComponent(boardId)}&sort=${encodeURIComponent(sort)}`);
    observeThreadActivity(boardId,j.threads||[],Number(j.fetchedAt||j.time||Date.now()),`board:${Number(j.fetchedAt||j.time||Date.now())}`);j.threads=(j.threads||[]).filter(t=>isThreadOpenable(boardId,t));if(boardId==='futaba')applyKnownFutabaTitles(j.threads);boardCaches.set(key,{...j,time:Date.now()});
    if(render&&drawerRequestEpoch.get(key)===epoch&&activeBoard===boardId&&activeSort===sort&&$('#threadDrawer').classList.contains('open'))renderThreadList(j);
    return j;
  }catch(e){
    if(render&&drawerRequestEpoch.get(key)===epoch&&activeBoard===boardId&&activeSort===sort&&$('#threadDrawer').classList.contains('open'))$('#threadList').innerHTML=`<div class="error">一覧取得エラー
${esc(e.message)}<br><button class="retryBoard">再試行</button></div>`;
    throw e;
  }
}
function boardRows(data,boardId,sort='hot',filter=''){
  const q=String(filter||'').trim().toLowerCase();let a=(data?.threads||[]).filter(x=>isThreadOpenable(boardId,x)&&(x.title||'').toLowerCase().includes(q));
  if(boardId!=='futaba'){if(sort==='hot')a.sort((x,y)=>(y.heat-x.heat)||(y.count-x.count));if(sort==='count')a.sort((x,y)=>y.count-x.count)}return a;
}
function renderBoardListInto({list,data,boardId,sort='hot',filter='',onOpen,preserveScroll=true,sourceEl=null}){
  if(!list||!data)return;const oldTop=list.scrollTop,a=boardRows(data,boardId,sort,filter),b=boardOf(boardId);list.classList.add('threadList');list.classList.toggle('futabaCatalog',boardId==='futaba');if(sourceEl)sourceEl.textContent=`${fmtTime(data.time||Date.now())} · ${data.source||''}`;
  if(!a.length){list.innerHTML='<div class="empty">該当スレッドなし</div>';return}
  if(boardId==='futaba'){applyKnownFutabaTitles(a);list.innerHTML=a.slice(0,240).map(x=>`<button class="thread futabaCard" data-key="${esc(x.key)}" data-thread-key="${esc(x.key)}" data-thread-url="${esc(x.url)}" data-title-needs-completion="${x.titleNeedsCompletion?'1':'0'}" title="${esc(x.title||'')}"><div class="catThumb">${x.image?`<img loading="lazy" src="${esc(boardMediaSrc(x.image))}" data-thread-url="${esc(x.url)}" alt="">`:'<div class="noThumb">2chan</div>'}</div><div class="catTitle">${esc(x.title)}</div><div class="catMeta"><span>${(x.count||0).toLocaleString()} res</span></div></button>`).join('');hydrateFutabaCovers(list);observeFutabaTitleCandidates(list)}else list.innerHTML=a.slice(0,350).map(x=>`<button class="thread" data-key="${esc(x.key)}"><div class="name" title="${esc(x.title||'')}">${esc(x.title)}</div><div class="meta"><span class="badge">${b?.label||''}</span>${x.heat?`<span class="heat">${x.heat.toLocaleString()}/day</span>`:''}<span class="countMeta">${(x.count||0).toLocaleString()} res</span></div></button>`).join('');
  list.querySelectorAll('.thread').forEach(el=>el.onclick=()=>{const t=a.find(x=>String(x.key)===el.dataset.key);if(t)onOpen?.(t)});if(preserveScroll)requestAnimationFrame(()=>list.scrollTop=oldTop);
}
function renderThreadList(data=boardCaches.get(cacheKey(activeBoard,activeSort))){renderBoardListInto({list:$('#threadList'),data,boardId:activeBoard,sort:activeSort,filter:$('#filter').value,onOpen:t=>{const replace=drawerReplacePaneId&&panes.find(p=>p.paneId===drawerReplacePaneId);drawerPinned=false;if(replace){drawerReplacePaneId='';hideDrawer();void switchToNextThread(replace,t)}else{addPane(t);hideDrawer()}},sourceEl:$('#drawerSource')})}

const futabaObservers=new WeakMap();
function hydrateFutabaCovers(root){
  if(!('IntersectionObserver' in window)||!root)return;let ob=futabaObservers.get(root);if(!ob){ob=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;const img=entry.target;ob.unobserve(img);loadFutabaCover(img)}},{root,rootMargin:'180px'});futabaObservers.set(root,ob)}
  root.querySelectorAll('img[data-thread-url]').forEach(img=>ob.observe(img));
}
async function loadFutabaCover(img){
  const url=img.dataset.threadUrl;if(!url)return;
  try{
    let data=futabaCoverCache.get(url);if(!data){data=await api('/api/futaba-cover?url='+encodeURIComponent(url));cacheRemember(futabaCoverCache,url,data,320)}
    if(data?.url&&img.isConnected&&img.dataset.threadUrl===url)img.src=boardMediaSrc(data.url);
  }catch{}
}

function newPaneId(){return globalThis.crypto?.randomUUID?.()||`pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}
function boardPaneState(x){return {paneId:x.paneId||newPaneId(),kind:'board',board:x.board,sort:['hot','count','source'].includes(x.sort)?x.sort:'hot',filter:String(x.filter||''),anchorThreadKey:'',anchorOffset:0,data:null,loading:false,error:'',requestEpoch:0,controller:null,requestKey:'',disposed:false,lastSuccessAt:'',observer:null,renderSignature:''}}
function paneState(x){
  if(x?.kind==='board')return boardPaneState(x);
  x={...x,title:threadDisplayTitle(x?.board,x?.title),history:normalizePersistedThreadTitles(x?.history)};
  const ref=normalizeThreadRef(x.board,x.url),paneId=x.paneId||newPaneId(),threadId=ref?.threadId||`${x.board}:invalid:${x.url}`;
  let saved=ref&&x.board!=='wsb'?repository.getReadPosition(threadId):null;
  const historyEntry=x.history?.entries?.[x.history?.index??0]||null;
  const paneAnchorPostId=x.anchorPostId||historyEntry?.anchorPostId||historyEntry?.snapshot?.anchorPostId||'';
  const paneAnchorOffset=Number(x.anchorOffset??historyEntry?.anchorOffset??historyEntry?.snapshot?.anchorOffset)||0;
  const paneLastReadPostId=x.lastReadPostId||historyEntry?.lastReadPostId||historyEntry?.snapshot?.lastReadPostId||paneAnchorPostId||'';
  // R4 migration: a persisted pane/history anchor is the authoritative app-restart snapshot.
  // Legacy viewIntent=top must not repeatedly override a valid saved anchor.
  if(ref&&!saved&&!x.follow&&paneAnchorPostId){repository.saveReadPosition(threadId,{board:ref.boardId,url:ref.canonicalUrl,anchorPostId:paneAnchorPostId,anchorOffset:paneAnchorOffset,lastReadPostId:paneLastReadPostId,mode:'reading',version:2,updatedAt:0});saved=repository.getReadPosition(threadId)}
  const canRestore=!x.liveMode,hasPaneSnapshot=canRestore&&!!paneAnchorPostId,hasThreadSnapshot=canRestore&&!hasPaneSnapshot&&!!saved;
  const restoreSnapshot=hasPaneSnapshot?{anchorPostId:paneAnchorPostId,anchorOffset:paneAnchorOffset,lastReadPostId:paneLastReadPostId}:hasThreadSnapshot?saved:null;
  const legacyTopWithAnchor=x.viewIntent==='top'&&!!restoreSnapshot;
  const resolvedViewIntent=x.liveMode?'tail':((x.viewIntent==='restore'||legacyTopWithAnchor||(!x.viewIntent&&restoreSnapshot))?'restore':(x.viewIntent||'top'));
  const base={...x,kind:'thread',paneId,threadId,generation:Number(x.generation)||0,loading:false,loadingToken:null,error:'',posts:[],postMap:new Map(),initialized:false,liveMode:!!x.liveMode,follow:!!x.liveMode||!!x.follow,newCount:Number(x.unreadCount)||0,anchorPostId:restoreSnapshot?.anchorPostId||'',anchorOffset:Number(restoreSnapshot?.anchorOffset)||0,updated:'',lastSuccessAt:'',source:'',total:0,threadStatus:'unknown',endReason:'',complete:false,lastPostNo:0,observedCount:0,fetchDiagnostics:null,ended:false,endHint:false,endConfirmed:false,retryDelayMs:0,nextRetryAt:0,consecutiveFetchFailures:0,navigationState:{targetThreadId:'',token:'',kind:'',phase:'ready',loading:false,error:'',startedAt:0},nextCandidates:[],nextAutoCandidates:[],nextAmbiguous:false,nextStatus:'',nextCheckedAt:0,nextChecking:false,nextAttemptedAt:0,nextEndBaseline:{},candidateEvidenceCache:new Map(),candidateVerifyCursor:0,nextCandidateMeta:{unresolvedCompetitors:0,relatedTotal:0,searchState:'noMatch'},candidateSearchState:'noMatch',liveEpoch:0,liveObservation:null,liveDominantObservations:0,liveRetryTarget:'',liveRetryAt:0,uiState:{candidatePanelOpen:false},draft:repository.loadDraft(threadId,x.url),disposed:false,requestController:null,navigationController:null,candidateController:null,pendingNavigation:null,viewIntent:resolvedViewIntent,applyingScroll:false,userScrollIntent:false,userIntentRevision:0,positionWriteRevision:0,positionWrite:null,positionState:'preparing',stableAnchor:null,renderEpoch:0,renderTimer:0,renderWindowRaf:0,renderWindowStart:0,renderWindowEnd:0,renderWindowSize:180,renderQueue:[],domMap:new Map(),heightCache:new Map(),heightEstimate:64,heightCacheWidth:0,heightCacheFontKey:'',pendingMerge:null,analysisPending:false,analysisEpoch:0,positionRaf:0,positionEpoch:0,positionMode:'',positionObserver:null,readingAnchor:null,userIntentTimer:0,positionRetry:0,readSaveTimer:0,readRestoreTimer:0,readRestorePending:false,readRestoreUserCancelled:false,lastReadPostId:restoreSnapshot?.lastReadPostId||'',perf:null,stale:false};base.history=normalizeHistory(x.history,base);if(base.board==='wsb')wsbPaneFields(base);resetRenderSessionState(base);return base;
}
function persistedPanes(){return panes.filter(p=>!isWsbSamplePane(p))}
function desktopState(){return repository.exportState(persistedPanes())}
function flushDesktopState(){if(!window.liveboardDesktop?.flushState)return Promise.resolve();return window.liveboardDesktop.flushState(++desktopRevision,desktopState()).catch(()=>{})}
function scheduleDesktopSave(){if(!window.liveboardDesktop?.saveState)return;clearTimeout(desktopSaveTimer);desktopSaveTimer=setTimeout(()=>window.liveboardDesktop.saveState(++desktopRevision,desktopState()).catch(()=>{}),250)}
function save(){repository.savePaneRecords(persistedPanes());scheduleDesktopSave()}
function load(){try{panes=repository.loadPaneRecords(initialPanes).filter(x=>boardOf(x.board)&&(x.kind==='board'||normalizeThreadRef(x.board,x.url))).map(x=>paneState(x.kind?x:{...x,kind:'thread'}))}catch{panes=initialPanes.map(x=>paneState({...x,kind:'thread',follow:false,viewIntent:'top'}))}}
function disposePane(p){if(!p||p.disposed)return;if(p.kind==='thread')commitPaneDepartureSnapshot(p,paneElement(p)?.querySelector('.posts'),{reason:'pane-dispose',settleFollowing:true});if(isWsbPane(p))void detachWsbPane(p);cancelHistoryGesture('pane-dispose',p.paneId);p.disposed=true;if(p.kind==='board'){p.requestEpoch++;try{p.controller?.abort()}catch{};p.observer?.disconnect?.();return}p.generation++;p.analysisEpoch++;p.positionEpoch++;for(const c of [p.requestController,p.navigationController,p.candidateController])try{c?.abort()}catch{};if(p.renderTimer)cancelAnimationFrame(p.renderTimer);if(p.renderWindowRaf)cancelAnimationFrame(p.renderWindowRaf);if(p.positionRaf)cancelAnimationFrame(p.positionRaf);p.positionObserver?.disconnect?.();clearTimeout(p.userIntentTimer);clearTimeout(p.readSaveTimer);clearTimeout(p.readRestoreTimer);p.renderQueue.length=0;p.pendingMerge=null;const paneEl=paneElement(p),posts=paneEl?.querySelector('.posts');previewObservers.get(posts)?.disconnect?.();for(let i=previewJobs.length-1;i>=0;i--){if(previewJobs[i]?.closest?.('.pane')===paneEl)previewJobs.splice(i,1)}document.querySelectorAll(`.hoverPopover[data-pane-id="${CSS.escape(p.paneId)}"]`).forEach(x=>{if(x.id==='hoverPopover'){x.hidden=true;x.innerHTML='';delete x.dataset.paneId}else x.remove()});if(mediaPopoverHold?.paneId===p.paneId)releaseMediaPopoverHold(true);if($('#lightbox')?.dataset.ownerPaneId===p.paneId)closeLightbox(false)}
function addPane(t){if(t?.board==='wsb')return addWsbPane(t);if(t?.board==='futaba')t={...t,title:threadDisplayTitle('futaba',t.title)};const ref=normalizeThreadRef(t.board,t.url);const existing=ref&&panes.find(p=>p.kind==='thread'&&p.threadId===ref.threadId);if(existing){toast('すでに開いています');requestAnimationFrame(()=>focusPane(existing));return existing}if(panes.length>=MAX_PANES){toast(`ペインは最大${MAX_PANES}個です`);return null}const saved=ref?repository.getReadPosition(ref.threadId):null;const p=paneState({...t,kind:'thread',liveMode:false,follow:false,viewIntent:saved?'restore':'top',anchorPostId:saved?.anchorPostId||'',anchorOffset:Number(saved?.anchorOffset)||0});p.history=normalizeHistory(null,p);p.perf={kind:'open',click:performance.now()};panes.push(p);save();renderPanes();requestAnimationFrame(()=>{if(!p.disposed&&panes.includes(p))focusPane(p)});refreshPane(p,true);return p}
function removePane(paneId){const p=panes.find(x=>x.paneId===paneId);if(paneDrag&&(paneDrag.p===p||paneDrag.target===p))cancelPaneDrag();disposePane(p);panes=panes.filter(x=>x.paneId!==paneId);save();renderPanes()}
function paneElement(p){return document.querySelector(`.pane[data-pane-id="${CSS.escape(p?.paneId||'')}"]`)}
function focusPane(p){const el=paneElement(p),grid=$('#grid');if(!el||!grid)return;lastActivePaneId=p.paneId;const er=el.getBoundingClientRect(),gr=grid.getBoundingClientRect();if(er.left<gr.left)grid.scrollLeft-=gr.left-er.left;else if(er.right>gr.right)grid.scrollLeft+=er.right-gr.right;if(er.top<gr.top)grid.scrollTop-=gr.top-er.top;else if(er.bottom>gr.bottom)grid.scrollTop+=er.bottom-gr.bottom;el.classList.add('paneFocusFlash');setTimeout(()=>el.classList.remove('paneFocusFlash'),700)}
function isNearBottom(box){return box.scrollHeight-box.scrollTop-box.clientHeight<100}
function updateHistoryCurrent(p,viewportSnapshot=null){if(!p.history?.entries?.length)return;const i=p.history.index;p.history.entries[i]={...p.history.entries[i],...createHistoryEntry(p,viewportSnapshot)}}

function threadKeyFromUrl(boardId,url=''){return normalizeThreadRef(boardId,url)?.sourceThreadId||''}
function normalizeThreadTitle(title='',boardId=''){return continuationTitleInfo(title,boardId).normalized}
function titleSequence(title='',boardId=''){return continuationTitleInfo(title,boardId).sequence}
function titleSimilarity(a,b,boardId=''){return continuationTitleSimilarity(a,b,boardId)}
function channelTagsConflict(a,b,boardId=''){return continuationChannelConflict(a,b,boardId)}
function hasVerifiedPreviousLink(p,posts=[]){
  const current=normalizeThreadRef(p.board,p.url);if(!current)return false;
  return collectCueRefs(posts,p.board,'previous',{postLimit:24,maxLines:24,maxLinks:8}).refs.some(ref=>ref.threadId===current.threadId);
}
async function mapLimited(items,limit,fn){let cursor=0;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;await fn(items[i],i)}});await Promise.allSettled(workers)}
function candidatePinnedKey(p){const el=paneElement(p);return el?.querySelector('.nextCandidate:hover')?.dataset.nextThread||document.activeElement?.closest?.('.nextCandidate')?.dataset.nextThread||''}
function stabilizeCandidateOrder(p,next=[]){
  const key=candidatePinnedKey(p);if(!key||!p.nextCandidates?.length)return next;
  const oldIndex=p.nextCandidates.findIndex(c=>normalizeThreadRef(p.board,c.t.url)?.threadId===key),newIndex=next.findIndex(c=>normalizeThreadRef(p.board,c.t.url)?.threadId===key);
  if(oldIndex<0||newIndex<0||oldIndex===newIndex)return next;const a=next.slice(),[item]=a.splice(newIndex,1);a.splice(Math.min(oldIndex,a.length),0,item);return a;
}
function candidateVerdict(candidates=[]){const top=candidates[0],second=candidates[1];if(!top)return {label:'',strong:false,ambiguous:false};const margin=second?top.score-second.score:Infinity,strong=top.score>=70&&margin>=15;return {label:strong?'最有力':'候補拮抗',strong,ambiguous:!strong}}
function resetLiveObservation(p){p.liveObservation=null;p.liveDominantObservations=0}
function updateLiveButton(el,p){const b=el?.querySelector?.('.liveModeBtn');if(!b)return;b.setAttribute('aria-pressed',String(!!p.liveMode));b.title=`ライブモード：${p.liveMode?'ON':'OFF'}`;b.setAttribute('aria-label',b.title);b.classList.toggle('active',!!p.liveMode)}
function ensureLiveTransitionCoordinator(p){
  if(!p)return null;
  if(!p.liveTransitionCoordinator)p.liveTransitionCoordinator=createLiveTransitionCoordinator({enabled:!!p.liveMode,initialEpoch:Number(p.liveEpoch)||0,context:{paneId:p.paneId},diagnostic:e=>{if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard R5 live]',e)}});
  return p.liveTransitionCoordinator;
}
let liveReevaluationTimer=0;
function scheduleLiveReevaluation(delay=0){clearTimeout(liveReevaluationTimer);liveReevaluationTimer=setTimeout(()=>{liveReevaluationTimer=0;for(const p of panes)if(p.kind==='thread'&&p.liveMode&&!p.disposed)void maybeLiveAutoAdvance(p)},Math.max(0,delay))}
function setLiveMode(p,on,{moveTail=true}={}){
  if(!p||p.kind!=='thread')return;const next=!!on,coordinator=ensureLiveTransitionCoordinator(p);
  if(p.liveMode===next){updateLiveButton(paneElement(p),p);return}
  const transitionState=coordinator?.setEnabled?.(next,{reason:next?'user-live-on':'user-live-off'});p.liveMode=next;p.liveEpoch=Number(transitionState?.epoch??p.liveEpoch)||0;resetLiveObservation(p);p.liveRetryTarget='';p.liveRetryAt=0;
  if(!next){const box=paneElement(p)?.querySelector('.posts'),snapshot=capturePaneViewportSnapshot(p,box,{settleFollowing:true,reason:'live-off'}),anchor=snapshot?{key:snapshot.anchorPostId,offset:snapshot.anchorOffset}:capturePostAnchor(box);if(snapshot)commitPaneViewportSnapshot(p,snapshot,{saveReadPosition:true});p.follow=false;if(anchor){p.anchorPostId=anchor.key||'';p.anchorOffset=Number(anchor.offset)||0;p.readingAnchor=anchor;p.stableAnchor={...anchor,revision:p.userIntentRevision}}p.viewportController?.liveOff?.({generation:p.generation,postId:anchor?.key||p.anchorPostId,offset:anchor?.offset??p.anchorOffset});p.positionState='reading'}
  if(!next&&p.pendingNavigation?.kind==='live-next'){try{p.navigationController?.abort()}catch{};coordinator?.fail?.(p.pendingNavigation.liveIntent,'live-off');p.pendingNavigation=null;p.navigationState={targetThreadId:'',token:'',kind:'',phase:'ready',loading:false,error:'',startedAt:0};p.nextStatus=p.nextCandidates?.length?'ready':''}
  const el=paneElement(p);if(next&&moveTail){p.follow=true;p.viewIntent='tail';p.viewportController?.followTail?.({generation:p.generation,reason:'live-on'});p.positionState='following';p.readingAnchor=null;p.newCount=0;schedulePanePosition(p,'live-on')}updateLiveButton(el,p);updateNewButton(el,p);save();
  if(next&&['ended','missing'].includes(p.threadStatus))setTimeout(()=>{if(p.liveMode)void maybeAdvanceThread(p,{forceCheck:true})},0);
}
function liveInteractionBlockers(p){
  const out=[],el=paneElement(p);if(!el)return ['pane-missing'];if(document.hidden)out.push('document-hidden');if(p.userScrollIntent)out.push('user-scroll');if(paneDrag)out.push('pane-drag');if(p.uiState?.candidatePanelOpen)out.push('candidate-ui');if(p.analysisPending)out.push('analysis');if(String(p.draft||'').trim())out.push('draft');if($('#lightbox')&&!$('#lightbox').hidden)out.push('lightbox');if(getSelection()?.toString())out.push('selection');
  const active=document.activeElement;if(active&&el.contains(active)&&active.matches?.('.composerInput,.nextCandidate,.nextCandidateTitle,.manualNextPick,.retryCurrentThread,.notificationCandidates,.notificationControl'))out.push('focused-control');
  if(el.querySelector('.gestureCue:not([hidden])'))out.push('gesture');if([...document.querySelectorAll('.hoverPopover:not([hidden]),.headerPopover:not([hidden])')].some(x=>x.dataset?.paneId===p.paneId||x.id==='headerPopover'&&x.dataset?.paneId===p.paneId))out.push('popover');return out;
}
function liveInteractionBlocked(p){return liveInteractionBlockers(p).length>0}
function liveDiagnostic(p,phase,detail={}){if(!globalThis.__LIVEBOARD_DEBUG__)return;const el=paneElement(p),box=el?.querySelector('.posts'),gap=box?box.scrollHeight-box.scrollTop-box.clientHeight:null;console.debug('[LiveBoard live]',{phase,paneId:p?.paneId,threadId:p?.threadId,generation:p?.generation,status:p?.threadStatus,follow:!!p?.follow,bottomGap:gap,liveEpoch:p?.liveEpoch,blockers:liveInteractionBlockers(p),related:Number(p?.nextCandidateMeta?.relatedTotal)||0,displayed:Number(p?.nextCandidateMeta?.displayedCount)||0,unverified:Number(p?.nextCandidateMeta?.unresolvedCompetitors)||0,retryAt:Number(p?.liveRetryAt)||0,candidates:(p?.nextAutoCandidates||[]).map(c=>({threadId:c.threadId,verifiedAt:c.verifiedAt,sourceVersion:c.sourceVersion,activitySourceVersion:c.activitySourceVersion,autoEvidence:c.autoEvidence||continuationAutoEvidence(c,Date.now())})),...detail})}
function currentAutoSelection(p){return selectAutoAdvanceCandidate(p.nextAutoCandidates||p.nextCandidates||[],{unresolvedCompetitors:Number(p.nextCandidateMeta?.unresolvedCompetitors)||0,now:Date.now()})}
function recordLiveCandidateObservation(p,candidates=[]){
  const selection=selectAutoAdvanceCandidate(candidates,{unresolvedCompetitors:Number(p.nextCandidateMeta?.unresolvedCompetitors)||0}),top=selection.candidate,ref=top&&normalizeThreadRef(p.board,top.t?.url||'');
  if(!ref){resetLiveObservation(p);return null}
  const now=activityNow(),version=String(top.sourceVersion||top.verifiedAt||top.observedAt||''),old=p.liveObservation;
  let obs;if(old?.threadId===ref.threadId){const freshVersion=version&&version!==old.sourceVersion,separated=now-Number(old.lastObservedAt??old.firstAt)>=10000;obs={...old,lastSeenAt:now};if(freshVersion&&separated){obs.observations=Number(obs.observations)||1;obs.observations++;obs.lastObservedAt=now;obs.sourceVersion=version}}else obs={threadId:ref.threadId,firstAt:now,lastObservedAt:now,lastSeenAt:now,observations:1,sourceVersion:version};
  obs.spanMs=Math.max(0,(obs.lastObservedAt??now)-obs.firstAt);p.liveObservation=obs;return obs;
}
function liveNavigationIntentValid(p,ref,intent={}){
  const coordinator=ensureLiveTransitionCoordinator(p);if(!p||!ref||!intent||!p.liveMode||!coordinator?.validate?.(intent,{generation:p.generation,fromThreadId:p.threadId,toThreadId:ref.threadId}))return false;
  if(!['ended','missing'].includes(p.threadStatus)||!p.follow||document.hidden||liveInteractionBlocked(p))return false;
  const box=paneElement(p)?.querySelector('.posts');if(!box||Math.abs(box.scrollHeight-box.scrollTop-box.clientHeight)>2)return false;
  const selection=currentAutoSelection(p),selected=selection.candidate&&normalizeThreadRef(p.board,selection.candidate.t?.url||''),evidence=selection.candidate?continuationAutoEvidence(selection.candidate,Date.now()):'';
  return !!selected&&selected.threadId===ref.threadId&&!!evidence&&(selection.eligible.length===1||evidence==='mutual-link');
}
async function maybeLiveAutoAdvance(p){
  if(!p?.liveMode)return false;const selection=currentAutoSelection(p),top=selection.candidate,el=paneElement(p),box=el?.querySelector('.posts'),bottomSettled=!!box&&Math.abs(box.scrollHeight-box.scrollTop-box.clientHeight)<=2,ref=top&&normalizeThreadRef(p.board,top.t?.url||''),evidence=top?continuationAutoEvidence(top,Date.now()):'';
  const coordinator=ensureLiveTransitionCoordinator(p),verdict=coordinator?.evaluate?.({liveMode:p.liveMode,status:p.threadStatus,following:p.follow,bottomSettled,pendingNavigation:!!p.pendingNavigation,analysisPending:!!p.analysisPending||!!p.nextChecking,documentVisible:!document.hidden,userBlocked:liveInteractionBlocked(p),retryAt:ref&&p.liveRetryTarget===ref.threadId?p.liveRetryAt:0,generation:p.generation,fromThreadId:p.threadId,toThreadId:ref?.threadId||'',evidence,unresolvedCompetitors:Number(p.nextCandidateMeta?.unresolvedCompetitors)||0,eligibleAutoCount:selection.eligible.length})||{allowed:false,reason:'coordinator-missing'};
  liveDiagnostic(p,'auto-evaluate',{allowed:!!verdict.allowed,reason:verdict.reason,targetThreadId:ref?.threadId||'',eligibleAutoCount:selection.eligible.length});
  if(!verdict.allowed||!ref)return false;const reserved=coordinator.reserve(verdict);if(!reserved?.ok)return false;const intent=reserved.intent;p.liveEpoch=intent.epoch;p.liveRetryTarget=ref.threadId;
  const ok=await navigatePane(p,{board:p.board,url:top.t.url,title:top.t.title},{kind:'live-next',liveEpoch:intent.epoch,liveIntent:intent});liveDiagnostic(p,ok?'navigated':'navigate-failed',{targetThreadId:ref.threadId});
  if(!ok){coordinator.fail(intent,'navigation-failed');if(p.liveMode&&p.liveEpoch===intent.epoch&&p.threadId===intent.fromThreadId){p.liveRetryAt=Date.now()+30000;updateNextCandidateUi(p)}}return ok;
}

function candidateCacheFor(p){if(!(p.candidateEvidenceCache instanceof Map))p.candidateEvidenceCache=new Map();return p.candidateEvidenceCache}
function candidateCacheRead(p,threadId){const cache=candidateCacheFor(p),hit=cache.get(threadId);if(!hit)return null;if(Date.now()-Number(hit.cachedAt)>120000){cache.delete(threadId);return null}return hit}
function candidateCacheWrite(p,c){candidateCacheFor(p).set(c.threadId,{cachedAt:Date.now(),verificationAttempted:!!c.verificationAttempted,lastAttemptAt:Number(c.lastAttemptAt)||0,retryAt:Number(c.retryAt)||0,verified:!!c.verified,fetchSuccess:!!c.fetchSuccess,candidateStatus:c.candidateStatus||'unknown',postCount:Number(c.postCount)||0,bodySeriesMatch:!!c.bodySeriesMatch,bodyPrefixMatch:!!c.bodyPrefixMatch,catalogPrefixMatch:!!c.catalogPrefixMatch,verifiedAt:Number(c.verifiedAt)||0,bodySourceVersion:String(c.bodySourceVersion||c.sourceVersion||''),bodyTitle:c.bodyTitle||'',openingExcerpt:c.openingExcerpt||'',verificationError:c.verificationError||'',relationState:c.relationState||'',evidenceReasons:Array.isArray(c.evidenceReasons)?c.evidenceReasons.slice(0,12):[]})}
function candidateVerificationDue(c,now=Date.now()){
  if(Number(c.retryAt)>now)return false;
  if(!c.verificationAttempted)return true;
  const age=now-Number(c.lastAttemptAt||0);
  return c.fetchSuccess?age>=10000:age>=30000;
}
function candidateOpeningSupports(p,c,posts=[],title='',boardId=''){
  if(boardId!=='futaba')return false;
  const current=continuationTitleInfo(p?.title||'',boardId).normalized.replace(/\s+/g,''),catalog=continuationTitleInfo(c.catalogTitle||c.t?.title||'',boardId).normalized.replace(/\s+/g,'');
  if(!continuationShortPrefixMatch(boardId,p?.title||'',c.catalogTitle||c.t?.title||'',3))return false;
  const opening=[title,...(posts||[]).slice(0,3).map(x=>String(x?.body||''))].join(' ').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const suffix=current.startsWith(catalog)?current.slice(catalog.length):'',topicSuffix=suffix.replace(/^(?:では|とは|から|まで|について|は|で|の|が|を|に)+/,'');
  // The candidate's own short title is not evidence of relation. Require concrete
  // topic material from the current thread beyond that short title.
  if([...topicSuffix].length>=2&&opening.includes(topicSuffix.toLowerCase()))return true;
  return [...current].length>=4&&opening.includes(current.toLowerCase());
}
async function nextThreadCandidates(p,token=paneRequestToken(p)){
  p.candidateController?.abort?.();const candidateController=new AbortController();p.candidateController=candidateController;
  let d;try{d=await api(`/api/board?board=${encodeURIComponent(p.board)}&sort=source&includeEnded=1&purpose=background`,{signal:candidateController.signal,timeoutMs:10000})}catch(e){if(e?.name==='AbortError'||!isCurrentPaneRequest(p,token))return [];p.nextCandidateMeta={...(p.nextCandidateMeta||{}),unresolvedCompetitors:0,relatedTotal:0,confirmedCount:0,fetchErrorCount:1,waitingCount:0,displayedCount:0,verificationQueueCount:0,verifiedCount:0,searchState:'fetchError',listError:String(e?.message||e)};p.candidateSearchState='fetchError';return []}if(!d||!isCurrentPaneRequest(p,token))return [];
  const observedAt=Number(d.fetchedAt||d.time||Date.now()),listVersion=String(d.sourceVersion||`board:${observedAt}`);observeThreadActivity(p.board,d.threads||[],observedAt,listVersion);
  const pool=(d.threads||[]).filter(t=>isThreadOpenable(p.board,t)),seedResult=continuationSeedCandidates({boardId:p.board,currentUrl:p.url,currentTitle:p.title,currentPosts:p.posts||[],threads:pool}),curKey=seedResult.current?.sourceThreadId||threadKeyFromUrl(p.board,p.url),curInfo=seedResult.currentInfo||continuationTitleInfo(p.title,p.board),curSeq=curInfo.sequence,raw=[];
  const terminal=['ended','missing'].includes(p.threadStatus);p.nextEndBaseline=p.nextEndBaseline||{};
  for(const seed of seedResult.candidates){
    const t=seed.t,ref=normalizeThreadRef(p.board,t.url);if(!ref)continue;const cache=candidateCacheRead(p,ref.threadId)||{},activity=observedActivity(p.board,t.url),count=Number(t.count)||0;if(terminal&&p.nextEndBaseline[ref.threadId]==null)p.nextEndBaseline[ref.threadId]=count;const baseline=p.nextEndBaseline[ref.threadId],endGrowth=terminal&&Number.isFinite(Number(baseline))&&count>=Number(baseline)?count-Number(baseline):null;
    raw.push({...seed,count,heat:Number(t.heat)||0,verificationAttempted:!!cache.verificationAttempted,lastAttemptAt:Number(cache.lastAttemptAt)||0,retryAt:Number(cache.retryAt)||0,verified:!!cache.verified,fetchSuccess:!!cache.fetchSuccess,candidateStatus:cache.candidateStatus||'unknown',postCount:Number(cache.postCount)||0,bodySeriesMatch:!!cache.bodySeriesMatch,bodyPrefixMatch:!!cache.bodyPrefixMatch,verifiedAt:Number(cache.verifiedAt)||0,bodySourceVersion:cache.bodySourceVersion||'',bodyTitle:cache.bodyTitle||'',openingExcerpt:cache.openingExcerpt||'',verificationError:cache.verificationError||'',relationState:cache.relationState||'',evidenceReasons:Array.isArray(cache.evidenceReasons)?cache.evidenceReasons:[],listFetchedAt:observedAt,listEvidence:d.listingEvidence||null,rate:activity.rate,activitySamples:activity.sampleCount,activitySpanMs:activity.activitySpanMs,activityGrowth:activity.activityGrowth,activitySourceVersion:activity.sourceVersion,endGrowth,observedAt,listSourceVersion:listVersion});
  }
  const direct=raw.filter(c=>c.explorationEligible||c.verified),probeUniverse=raw.filter(c=>c.probeOnly&&!c.fetchSuccess).sort((a,b)=>Number(b.key)-Number(a.key)).slice(0,5),probeIds=new Set(probeUniverse.map(c=>c.threadId)),exploration=rankContinuationCandidates({currentTitle:p.title,currentSeq:curSeq,currentKey:curKey,candidates:[...direct,...probeUniverse.filter(c=>!direct.some(d=>d.threadId===c.threadId))]});
  exploration.forEach(c=>{c.probeOnly=probeIds.has(c.threadId)&&!c.explorationEligible});
  exploration.sort((a,b)=>Number(b.explicit)-Number(a.explicit)||(Number(a.gap)===1? -1:Number(b.gap)===1?1:0)||Number(b.seriesMatch)-Number(a.seriesMatch)||Number(a.probeOnly)-Number(b.probeOnly)||b.score-a.score||Number(b.key)-Number(a.key));
  const now=Date.now(),n=exploration.length,startIndex=n?Number(p.candidateVerifyCursor||0)%n:0,verify=[];let scanned=0;
  while(n&&scanned<n&&verify.length<3){const c=exploration[(startIndex+scanned)%n];if(candidateVerificationDue(c,now))verify.push(c);scanned++}
  if(n)p.candidateVerifyCursor=(startIndex+Math.max(1,scanned))%n;
  await mapLimited(verify,2,async c=>{
    c.verificationAttempted=true;c.lastAttemptAt=Date.now();c.verificationError='';
    try{
      const j=await api(`/api/thread?board=${encodeURIComponent(p.board)}&url=${encodeURIComponent(c.t.url)}&purpose=background`,{signal:candidateController.signal,timeoutMs:10000});if(!isCurrentPaneRequest(p,token))return;
      const responseRef=normalizeThreadRef(p.board,j?.url||c.t.url),posts=Array.isArray(j?.posts)?j.posts:[],fetchSuccess=!j?.unavailable&&posts.length>0&&!!responseRef&&responseRef.threadId===c.threadId,title=String(j?.title||''),sourceFetchedAt=Number(j?.sourceFetchedAt??j?.fetchedAt??0),hasSourceTime=Number.isFinite(sourceFetchedAt)&&sourceFetchedAt>0,sourceVersion=String(j?.sourceVersion||`body:${sourceFetchedAt||'unknown'}`),info=continuationTitleInfo(title||c.catalogTitle,p.board);
      c.fetchSuccess=fetchSuccess&&hasSourceTime;c.ownerMatch=!!responseRef&&responseRef.threadId===c.threadId;c.candidateStatus=c.fetchSuccess?(j?.status||'unknown'):'unknown';c.postCount=posts.length;c.verified=c.fetchSuccess&&hasVerifiedPreviousLink(p,posts);c.verifiedAt=c.fetchSuccess?sourceFetchedAt:0;c.bodySourceVersion=c.fetchSuccess?sourceVersion:'';c.bodyTitle=title;c.openingExcerpt=c.fetchSuccess?posts.slice(0,3).map(x=>String(x?.body||'')).join(' ').slice(0,600):'';c.bodySeriesMatch=c.fetchSuccess&&!!title&&continuationSeriesMatch(p.board,p.title,title);c.bodyPrefixMatch=c.fetchSuccess&&candidateOpeningSupports(p,c,posts,title,p.board);c.seriesMatch=c.seriesMatch||c.bodySeriesMatch;c.seq=info.sequence??c.seq;c.gap=curSeq!=null&&c.seq!=null?c.seq-curSeq:null;c.similarity=Math.max(c.similarity,title?titleSimilarity(p.title,title,p.board):0);c.sourceVersion=c.bodySourceVersion;
      if(c.fetchSuccess){c.retryAt=0}else{c.retryAt=Date.now()+30000;c.verificationError=j?.errorMessage||'candidate-unavailable'}candidateCacheWrite(p,c);
    }catch(e){if(e?.name==='AbortError')throw e;c.fetchSuccess=false;c.retryAt=Date.now()+30000;c.verificationError=String(e?.message||e);candidateCacheWrite(p,c)}
  });
  if(!isCurrentPaneRequest(p,token))return [];
  const resolved=resolveContinuationCandidates({boardId:p.board,currentUrl:p.url,currentTitle:p.title,candidates:exploration,now:Date.now(),maxDisplay:5});
  for(const candidate of resolved.all)candidateCacheWrite(p,candidate);
  const ranked=resolved.autoRanked,relatedAll=resolved.relatedAll,decorated=resolved.all,display=stabilizeCandidateOrder(p,resolved.display),unresolved=resolved.unresolved;
  p.nextAutoCandidates=ranked;const confirmedCount=relatedAll.filter(c=>c.relationState==='confirmed').length,fetchErrorCount=relatedAll.filter(c=>c.relationState==='fetchError').length,waitingCount=relatedAll.filter(c=>c.relationState==='waitingEvidence').length,autoSelection=selectAutoAdvanceCandidate(ranked,{unresolvedCompetitors:unresolved,now:Date.now()});
  const searchState=autoSelection.reason==='ambiguous'?'ambiguous':confirmedCount?'confirmed':fetchErrorCount&&fetchErrorCount===relatedAll.length?'fetchError':waitingCount||fetchErrorCount?'waitingEvidence':relatedAll.length?'related':'noMatch';
  p.nextCandidateMeta={unresolvedCompetitors:unresolved,relatedTotal:relatedAll.length,confirmedCount,fetchErrorCount,waitingCount,displayedCount:display.length,verificationQueueCount:decorated.filter(c=>c.relationState!=='noMatch'&&candidateVerificationDue(c,Date.now())).length,verifiedCount:decorated.filter(c=>c.fetchSuccess).length,searchState,observedAt,listSourceVersion:listVersion,resolverDiagnostics:seedResult.diagnostics};p.candidateSearchState=searchState;
  return display;
}
function decisiveNextCandidate(p,candidates,token=paneRequestToken(p)){const selection=selectAutoAdvanceCandidate(candidates,{unresolvedCompetitors:Number(p.nextCandidateMeta?.unresolvedCompetitors)||0,now:Date.now()});return {top:selection.candidate||candidates?.[0]||null,auto:!!selection.candidate,ambiguous:selection.reason==='ambiguous'||selection.reason==='unresolved-competition',label:selection.reason};}
async function navigatePane(p,targetInput,{kind='link',historyIndex=null,liveEpoch=null,liveIntent=null}={}){
  if(!p||p.disposed||!panes.includes(p))return false;
  if(isWsbPane(p))return navigateWsbPane(p,targetInput,{kind,historyIndex});
  cancelHistoryGesture('pane-navigation',p.paneId);
  const liveIntentEpoch=Number(liveIntent?.epoch??liveEpoch??p.liveEpoch)||0;
  if(kind==='live-next'&&(!p.liveMode||p.liveEpoch!==liveIntentEpoch))return false;
  const ref=typeof targetInput==='string'?identifyThreadRef(targetInput):normalizeThreadRef(targetInput?.board||p.board,targetInput?.url||'');
  if(!ref){toast('対応掲示板のスレッドとして確認できません');return false}
  if(kind==='live-next'&&liveIntent&&!liveNavigationIntentValid(p,ref,liveIntent))return false;
  if(ref.threadId===p.threadId&&kind!=='history'){focusPane(p);return true}
  if(p.navigationState?.loading&&p.navigationState.targetThreadId===ref.threadId)return false;
  const preserveLive=!!p.liveMode&&kind==='live-next';
  closeHeaderPopover();
  try{p.navigationController?.abort()}catch{}
  const navTx=p.navigationCoordinator?.begin?.({targetURL:ref.canonicalUrl,intent:kind})||null;
  const controller=new AbortController(),token=navTx?.token||`${p.paneId}:nav:${Date.now()}:${Math.random().toString(36).slice(2)}`,startedAt=performance.now(),previousNextStatus=p.nextStatus;
  p.navigationController=controller;p.perf={kind,click:startedAt,apiStart:performance.now()};
  p.pendingNavigation={target:ref,kind,historyIndex,token,startedAt,liveEpoch:liveIntentEpoch,liveIntent:liveIntent||null};
  p.navigationState={targetThreadId:ref.threadId,token,kind,phase:'loadingTarget',loading:true,error:'',startedAt};p.nextStatus='switching';updateNextCandidateUi(p);updatePaneStatus(paneElement(p),p,'移動先を読み込み中…');
  const oldThread=p.threadId,oldUrl=p.url,oldTitle=p.title;
  let committed=false;
  try{
    const j=await api(`/api/thread?board=${encodeURIComponent(ref.boardId)}&url=${encodeURIComponent(ref.canonicalUrl)}&purpose=foreground`,{signal:controller.signal,timeoutMs:10000});p.perf&&(p.perf.apiReceived=performance.now());
    if(p.disposed||!panes.includes(p)||p.navigationState?.token!==token||navTx&& !p.navigationCoordinator?.isCurrent?.(navTx))return false;
    if(kind==='live-next'&&(!p.liveMode||p.liveEpoch!==liveIntentEpoch||liveIntent&&!liveNavigationIntentValid(p,ref,liveIntent)))return false;
    const targetPosts=Array.isArray(j?.posts)?j.posts:[];
    if(!navigationResponseUsable({...j,posts:targetPosts})){
      const message=j?.errorMessage||j?.endReason||(targetPosts.length===0?'本文を取得できません':'取得不能');
      p.navigationState={...p.navigationState,loading:false,error:String(message)};
      if(kind==='live-next'){p.liveRetryTarget=ref.threadId;p.liveRetryAt=Date.now()+30000}
      toast(`移動先を読み込めませんでした: ${message}`);return false;
    }
    // Commit only after the target has a usable body. Until this point the current thread owns all visible/read state.
    p.navigationState={...p.navigationState,phase:'preparingTarget'};
    const departureBox=paneElement(p)?.querySelector('.posts'),departureSnapshot=commitPaneDepartureSnapshot(p,departureBox,{reason:`navigate-${kind}`,settleFollowing:true});
    if(gallerySession?.ownerPaneId===p.paneId)closeLightbox(false);
    if(kind!=='live-next'&&p.liveMode&&['history','link','next'].includes(kind))setLiveMode(p,false,{moveTail:false});
    const oldHistory=p.history,targetTitle=threadDisplayTitle(ref.boardId,j.title||targetInput?.title||'');
    for(const c of [p.requestController,p.candidateController])try{c?.abort()}catch{}
    p.generation++;p.renderEpoch++;p.analysisEpoch++;p.positionEpoch++;if(p.positionRaf)cancelAnimationFrame(p.positionRaf);p.positionObserver?.disconnect?.();
    const liveForwardIndex=kind==='live-next'?immediateForwardHistoryIndex(oldHistory,ref.threadId):-1;
    if(kind==='history'){p.history=moveHistory(oldHistory,historyIndex)}else if(liveForwardIndex>=0){p.history=moveHistory(oldHistory,liveForwardIndex)}else p.history=pushHistory(oldHistory,{board:ref.boardId,threadId:ref.threadId,url:ref.canonicalUrl,title:targetTitle,anchorPostId:'',anchorOffset:0,follow:preserveLive,unreadCount:0});
    repository.recordTransition({paneId:p.paneId,fromThreadId:oldThread,fromUrl:oldUrl,fromTitle:oldTitle,toThreadId:ref.threadId,toUrl:ref.canonicalUrl,toTitle:targetTitle});
    const savedRead=kind==='history'||preserveLive?null:repository.getReadPosition(ref.threadId);p.board=ref.boardId;p.threadId=ref.threadId;p.url=ref.canonicalUrl;p.title=targetTitle||threadDisplayTitle(ref.boardId,p.title);p.posts=[];p.postMap=new Map();p.initialized=false;p.follow=kind==='history'?false:preserveLive;p.newCount=0;p.anchorPostId=kind==='history'?(p.history.entries[p.history.index]?.anchorPostId||p.history.entries[p.history.index]?.snapshot?.anchorPostId||''):(preserveLive?'':(savedRead?.anchorPostId||''));p.anchorOffset=kind==='history'?(Number(p.history.entries[p.history.index]?.anchorOffset??p.history.entries[p.history.index]?.snapshot?.anchorOffset)||0):(preserveLive?0:(Number(savedRead?.anchorOffset)||0));p.lastReadPostId=kind==='history'?(p.history.entries[p.history.index]?.lastReadPostId||p.history.entries[p.history.index]?.snapshot?.lastReadPostId||''):(preserveLive?'':(savedRead?.lastReadPostId||''));p.readRestorePending=false;p.readRestoreUserCancelled=false;clearTimeout(p.readRestoreTimer);p.viewIntent=kind==='history'?'restore':(preserveLive?'tail':(savedRead?'restore':'top'));resetRenderSessionState(p);p.total=0;p.threadStatus='unknown';p.endReason='';p.complete=false;p.lastPostNo=0;p.observedCount=0;p.fetchDiagnostics=null;p.ended=false;p.endHint=false;p.endConfirmed=false;p.retryDelayMs=0;p.nextRetryAt=0;p.consecutiveFetchFailures=0;p.nextCandidates=[];p.nextAutoCandidates=[];p.nextAmbiguous=false;p.nextStatus='';p.nextChecking=false;p.nextAttemptedAt=0;p.nextEndBaseline={};p.candidateEvidenceCache=new Map();p.candidateVerifyCursor=0;p.nextCandidateMeta={unresolvedCompetitors:0,relatedTotal:0,searchState:'noMatch'};p.candidateSearchState='noMatch';p.uiState.candidatePanelOpen=false;p.draft=repository.loadDraft(p.threadId,p.url);resetLiveObservation(p);p.liveRetryTarget='';p.liveRetryAt=0;
    if(navTx){const navCommit=p.navigationCoordinator?.commit?.(navTx,{threadId:ref.threadId});if(!navCommit?.ok)return false}
    if(kind==='live-next'&&liveIntent){const liveCommit=ensureLiveTransitionCoordinator(p)?.commit?.(liveIntent);if(!liveCommit?.ok)liveDiagnostic(p,'commit-state-mismatch',{targetThreadId:ref.threadId,reason:liveCommit?.reason||'unknown'})}
    committed=true;p.navigationState={...p.navigationState,phase:'committed',loading:false};save();renderPanes();applyThreadResponse(p,j,true);toast(`${kind==='history'?'履歴へ移動':kind==='live-next'?'ライブで次スレへ移動':'スレッドへ移動'}: ${p.title}`);return true;
  }catch(e){
    if(e?.name==='AbortError')return false;
    if(p.navigationState?.token===token){p.navigationState={...p.navigationState,loading:false,error:String(e?.message||e)};if(kind==='live-next'){p.liveRetryTarget=ref.threadId;p.liveRetryAt=Date.now()+30000}toast(`移動先を読み込めませんでした: ${e.message}`)}
    return false;
  }finally{
    if(kind==='live-next'&&liveIntent&&!committed)ensureLiveTransitionCoordinator(p)?.fail?.(liveIntent,'navigation-not-committed');
    if(p.navigationState?.token===token){
      p.navigationState={targetThreadId:'',token:'',kind:'',phase:'ready',loading:false,error:p.navigationState.error||'',startedAt:0};p.pendingNavigation=null;updateHistoryButtons(paneElement(p),p);
      if(!committed){p.nextStatus=previousNextStatus==='switching'?'':previousNextStatus;updatePaneStatus(paneElement(p),p);updateNextCandidateUi(p);setTimeout(()=>{if(!p.disposed&&!p.pendingNavigation)void refreshPane(p,false)},250)}
    }
  }
}
function existingHistoryViewportSnapshot(p){
  const e=p?.history?.entries?.[p?.history?.index],snap=e?.snapshot&&typeof e.snapshot==='object'?e.snapshot:e;if(!snap)return null;const anchorPostId=String(snap.anchorPostId||'');if(!anchorPostId)return null;return {board:p.board,url:p.url,anchorPostId,anchorOffset:Number(snap.anchorOffset??snap.viewportOffset)||0,lastReadPostId:String(snap.lastReadPostId||anchorPostId),mode:'reading',version:2,updatedAt:Number(snap.updatedAt)||Date.now()}
}
function tailViewportSnapshotFromLayout(p,box){
  if(!p?.posts?.length||!box)return null;const total=estimatedTotalHeight(p),viewport=Math.max(0,Number(box.clientHeight)||0),tailTop=Math.max(0,total-viewport),index=indexAtEstimatedOffset(p,tailTop),anchorPostId=postKeyAt(p,index),lastReadPostId=postKeyAt(p,p.posts.length-1);if(!anchorPostId)return null;return {board:p.board,url:p.url,anchorPostId,anchorOffset:estimatedOffsetForIndex(p,index)-tailTop,lastReadPostId:lastReadPostId||anchorPostId,mode:'reading',version:2,updatedAt:Date.now()}
}
function settleFollowingViewportForSnapshot(p,box,reason='following-snapshot'){
  if(!p||!box||!p.posts?.length)return false;const revision=Number(p.userIntentRevision)||0,[start,end]=virtualWindowForIndex(p,Math.max(0,p.posts.length-1));renderVirtualWindow(p,box,start,end,{reason:`${reason}-tail-window`,revision,force:true});writePaneScrollTop(p,box,Math.max(0,box.scrollHeight-box.clientHeight),reason,revision);measureVirtualWindow(p,box,`${reason}-tail-measure`);writePaneScrollTop(p,box,Math.max(0,box.scrollHeight-box.clientHeight),`${reason}-remeasured`,revision);updateTailVisibility(p,box);return true
}
function capturePaneViewportSnapshot(p,box,{settleFollowing=false,reason='viewport-snapshot'}={}){
  if(!p||p.kind!=='thread'||!box)return existingHistoryViewportSnapshot(p);const mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading');
  if(mode==='following'||p.follow){if(settleFollowing)settleFollowingViewportForSnapshot(p,box,reason);const gap=box.scrollHeight-box.scrollTop-box.clientHeight;if(Math.abs(gap)<=2){const anchor=capturePostAnchor(box);if(anchor)return {board:p.board,url:p.url,anchorPostId:anchor.key||'',anchorOffset:anchor.top-box.getBoundingClientRect().top,lastReadPostId:visibleLastPostId(box)||postKeyAt(p,p.posts.length-1)||anchor.key||'',mode:'reading',version:2,updatedAt:Date.now()}}return tailViewportSnapshotFromLayout(p,box)||existingHistoryViewportSnapshot(p)}
  if(p.userScrollIntent||['preparing','restoring','userInteracting'].includes(p.positionState))return existingHistoryViewportSnapshot(p);const anchor=capturePostAnchor(box);if(!anchor)return existingHistoryViewportSnapshot(p);return {board:p.board,url:p.url,anchorPostId:anchor.key||'',anchorOffset:anchor.top-box.getBoundingClientRect().top,lastReadPostId:visibleLastPostId(box)||anchor.key||'',mode:'reading',version:2,updatedAt:Date.now()}
}
function commitPaneViewportSnapshot(p,snapshot,{saveReadPosition=false}={}){
  if(!p||!snapshot?.anchorPostId)return false;p.anchorPostId=String(snapshot.anchorPostId);p.anchorOffset=Number(snapshot.anchorOffset)||0;p.lastReadPostId=String(snapshot.lastReadPostId||snapshot.anchorPostId);updateHistoryCurrent(p,snapshot);if(saveReadPosition&&!isWsbPane(p)){const owner=readPositionOwnerByThread.get(p.threadId);if(!owner||owner===p.paneId){readPositionOwnerByThread.set(p.threadId,p.paneId);repository.saveReadPosition(p.threadId,snapshot);scheduleDesktopSave()}}return true
}
function commitPaneDepartureSnapshot(p,box,{reason='departure',settleFollowing=true}={}){const snapshot=capturePaneViewportSnapshot(p,box,{settleFollowing,reason});return commitPaneViewportSnapshot(p,snapshot,{saveReadPosition:true})?snapshot:null}
async function switchToNextThread(p,candidate){return navigatePane(p,{board:p.board,url:candidate?.url||'',title:candidate?.title||''},{kind:'next'})}
function historyNavigate(p,delta){if(!p)return;cancelHistoryGesture('history-navigation',p.paneId);const base=p.pendingNavigation?.kind==='history'?p.pendingNavigation.historyIndex:p.history.index,target=base+delta;if(target<0||target>=p.history.entries.length)return;const e=p.history.entries[target];void navigatePane(p,{board:e.board,url:e.url,title:e.title},{kind:'history',historyIndex:target})}

function openManualNextPicker(p){
  setToolbarMode('menu');const anchor=$(`#boardNav [data-board="${p.board}"]`);if(!anchor)return;
  drawerPinned=true;activeSort='hot';$('#sort').value='hot';requestAnimationFrame(()=>showDrawer(p.board,anchor,true,{resetTop:true,replacePaneId:p.paneId}));
}

function positionFloating(el,anchor,{gap=6,maxWidth=420}={}){if(!el||!anchor)return;el.style.maxWidth=`min(${maxWidth}px, calc(100vw - 16px))`;el.hidden=false;const r=anchor.getBoundingClientRect(),pr=el.getBoundingClientRect();let left=Math.max(8,Math.min(r.left,innerWidth-pr.width-8)),top=r.bottom+gap;if(top+pr.height>innerHeight-8)top=Math.max(8,r.top-pr.height-gap);el.style.left=`${left}px`;el.style.top=`${top}px`}
function closeUiTooltip(){clearTimeout(tooltipTimer);const tip=$('#uiTooltip');if(tip){tip.hidden=true;tip.textContent='';delete tip.dataset.threadId}}
function installCandidateTooltips(root,p){root.querySelectorAll('.nextCandidate').forEach(btn=>{const el=btn.querySelector('.nextCandidateTitle');if(!el)return;const clipped=()=>el.scrollHeight>el.clientHeight+1||el.scrollWidth>el.clientWidth+1;const open=()=>{clearTimeout(tooltipTimer);if(!clipped())return;const threadId=btn.dataset.nextThread||'';tooltipTimer=setTimeout(()=>{const current=p.nextCandidates.find(x=>normalizeThreadRef(p.board,x.t.url)?.threadId===threadId);if(!current||!el.isConnected||!clipped())return;const tip=$('#uiTooltip');tip.textContent=current.t.title||'';tip.dataset.threadId=threadId;btn.setAttribute('aria-describedby','uiTooltip');positionFloating(tip,el)},400)};const close=()=>{clearTimeout(tooltipTimer);setTimeout(()=>{if(!btn.matches(':hover,:focus')&&!$('#uiTooltip')?.matches(':hover'))closeUiTooltip()},80)};btn.addEventListener('pointerenter',open);btn.addEventListener('focus',open);btn.addEventListener('pointerleave',close);btn.addEventListener('blur',close)})}
function threadCandidateEligible(p){if(isWsbPane(p))return false;const status=p?.threadStatus||'unknown';return status==='ended'||status==='missing'}
function threadStateLabel(p){const status=p?.threadStatus||'unknown';if(status==='ended')return 'スレッド終了';if(status==='missing')return '取得できません';if(status==='partial')return '一部のみ取得';if(status==='active')return '取得中';return p?.error?'現在取得できません':'状態確認中'}
function fetchRetryLabel(p){if(!p?.nextRetryAt||p.nextRetryAt<=Date.now())return '';const sec=Math.max(1,Math.ceil((p.nextRetryAt-Date.now())/1000));return `自動再試行 ${sec}秒後`}
function updateNextCandidateUi(p){
  const tip=$('#uiTooltip');if(tip&&!tip.hidden&&tip.dataset.threadId){const current=p.nextCandidates?.find(x=>normalizeThreadRef(p.board,x.t.url)?.threadId===tip.dataset.threadId);if(current)tip.textContent=current.t.title||'';else closeUiTooltip()}
  const el=paneElement(p);if(!el)return;updateNewButton(el,p);
  const pop=el.querySelector('.nextCandidates');if(!pop)return;
  const eligible=threadCandidateEligible(p),has=eligible&&!!p.nextCandidates?.length,available=eligible;
  if(!available){p.uiState.candidatePanelOpen=false;pop.hidden=true;el.querySelectorAll('.newPosts,.notificationCandidates').forEach(btn=>btn.setAttribute('aria-expanded','false'));return}
  const focusKey=document.activeElement?.closest?.('.nextCandidate')?.dataset.nextThread||'';
  let body='';
  if(p.nextStatus==='searching'&&!has)body='<div class="nextCandidateEmpty">次スレ候補を確認しています…</div>';
  else if(!has&&p.candidateSearchState==='waitingEvidence')body='<div class="nextCandidateEmpty">関連候補の証拠を確認しています…</div>';
  else if(!has&&p.candidateSearchState==='fetchError')body='<div class="nextCandidateEmpty">候補を取得できません。再試行できます。</div>';
  else if(has)body=p.nextCandidates.slice(0,3).map(c=>{
    const ref=normalizeThreadRef(p.board,c.t.url),count=Number(c.t.count)||0;
    const heat=p.board==='futaba'?'—':Number.isFinite(Number(c.heat))?Number(c.heat).toLocaleString():'—';
    return `<button class="nextCandidate" data-next-thread="${esc(ref?.threadId||'')}"><span class="nextCandidateTitle" data-full-title="${esc(c.t.title||'')}" aria-label="${esc(c.t.title||'')}">${esc(c.t.title||'')}</span><small>${count}レス · 勢い ${heat}${heat==='—'?'':' レス/日'}</small></button>`;
  }).join('');
  else body=`<div class="nextCandidateEmpty">${p.nextStatus==='error'||p.candidateSearchState==='fetchError'?'候補の確認に失敗しました。':'条件を満たす次スレ候補が見つかりません。'}</div>`;
  pop.innerHTML=`<div class="nextCandidateHead">${has?`次スレ候補 ${p.nextCandidates.length}件`:'次スレを選択'}</div>${body}<button class="manualNextPick">板一覧から選ぶ</button>${p.error?'<button class="retryCurrentThread">現在スレを再試行</button>':''}`;
  pop.hidden=!p.uiState.candidatePanelOpen;
  el.querySelectorAll('.newPosts,.notificationCandidates').forEach(btn=>btn.setAttribute('aria-expanded',String(!!p.uiState.candidatePanelOpen)));
  if(focusKey){const keep=pop.querySelector(`[data-next-thread="${CSS.escape(focusKey)}"]`);if(keep)keep.focus({preventScroll:true})}
  pop.querySelectorAll('[data-next-thread]').forEach(btn=>btn.onclick=()=>{const c=p.nextCandidates.find(x=>normalizeThreadRef(p.board,x.t.url)?.threadId===btn.dataset.nextThread);if(c)void switchToNextThread(p,c.t)});
  pop.querySelector('.manualNextPick')?.addEventListener('click',()=>openManualNextPicker(p));
  pop.querySelector('.retryCurrentThread')?.addEventListener('click',()=>refreshPane(p,true));installCandidateTooltips(pop,p);
}
async function maybeAdvanceThread(p,{forceCheck=false}={}){
  if(isWsbPane(p)){p.nextCandidates=[];p.nextAutoCandidates=[];p.nextStatus='';p.uiState.candidatePanelOpen=false;updateNextCandidateUi(p);return}
  p.ended=['ended','missing'].includes(p.threadStatus);p.endConfirmed=p.ended;
  if(!threadCandidateEligible(p)){p.nextCandidates=[];p.nextAutoCandidates=[];p.nextAmbiguous=false;p.nextStatus='';p.candidateSearchState='noMatch';p.uiState.candidatePanelOpen=false;resetLiveObservation(p);updateNextCandidateUi(p);return}
  if(!forceCheck&&p.threadStatus==='partial'&&!p.error){updateNextCandidateUi(p);return}
  if(p.nextChecking)return;if(!forceCheck&&Date.now()-(p.nextAttemptedAt||0)<10000){updateNextCandidateUi(p);return}
  const token=paneRequestToken(p);p.nextChecking=true;p.nextAttemptedAt=Date.now();p.nextStatus='searching';p.candidateSearchState='searching';updateNextCandidateUi(p);
  try{const c=await nextThreadCandidates(p,token);if(!isCurrentPaneRequest(p,token))return;p.nextCandidates=c;const verdict=decisiveNextCandidate(p,p.nextAutoCandidates||[],token);p.nextAmbiguous=verdict.ambiguous||p.candidateSearchState==='ambiguous';p.nextStatus=c.length?'ready':(p.candidateSearchState==='fetchError'?'error':'none');if(p.liveMode)recordLiveCandidateObservation(p,p.nextAutoCandidates||p.nextCandidates);else resetLiveObservation(p);updateNextCandidateUi(p)}
  catch(e){if(isCurrentPaneRequest(p,token)){p.nextStatus='error';p.candidateSearchState='fetchError';console.warn('next-thread detection',e);updateNextCandidateUi(p)}}
  finally{if(isCurrentPaneRequest(p,token)){p.nextChecking=false;if(p.liveMode)queueMicrotask(()=>void maybeLiveAutoAdvance(p))}}
}

document.addEventListener('pointerdown',e=>{const paneEl=e.target.closest?.('.pane');if(!paneEl)return;const p=panes.find(x=>x.paneId===paneEl.dataset.paneId);if(!p?.uiState?.candidatePanelOpen)return;if(e.target.closest('.nextCandidates,.notificationControl'))return;p.uiState.candidatePanelOpen=false;updateNextCandidateUi(p);scheduleLiveReevaluation(0)},true);
document.addEventListener('click',e=>{const btn=e.target.closest?.('.wsbOriginalToggle');if(!btn)return;const assist=btn.closest('.wsbOriginalAssist');if(!assist)return;const open=!assist.classList.contains('open');assist.classList.toggle('open',open);btn.setAttribute('aria-expanded',String(open));e.stopPropagation()});
document.addEventListener('selectionchange',()=>{if(!getSelection()?.toString())scheduleLiveReevaluation(0)});
document.addEventListener('focusout',()=>scheduleLiveReevaluation(80),true);
function parseDateParts(raw=''){
  const s=String(raw||'');let m=s.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/);let y,mo,d;
  if(m){y=Number(m[1]);mo=Number(m[2]);d=Number(m[3])}else{m=s.match(/(?:^|\s)(\d{2})\/(\d{1,2})\/(\d{1,2})/);if(m){y=2000+Number(m[1]);mo=Number(m[2]);d=Number(m[3])}}
  if(y){const dt=new Date(Date.UTC(y,mo-1,d));if(mo<1||mo>12||d<1||d>31||dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)y=mo=d=undefined}
  const tm=s.match(/(?:^|\s|\))([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?/);
  return {key:y?`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`:'',label:y?`${y}年${mo}月${d}日`:'',time:tm?`${String(tm[1]).padStart(2,'0')}:${tm[2]}`:''};
}
function cleanName(name=''){return String(name).split(/[◆◇]/)[0].replace(/^Name\s+/i,'').trim()}
function cleanPostId(id=''){return String(id||'').replace(/(?:No\.?\s*\d+.*)$/i,'').replace(/[;,]+$/,'').trim()}
function isDefaultName(boardId,name=''){
  const n=cleanName(name);
  if(!n)return true;
  if(boardId==='edge')return /^エッヂの名無し(?:\s|[（(]|$)/.test(n);
  if(boardId==='5ch')return /^山師さん(?:\s|[（(]|$)/.test(n);
  if(boardId==='futaba')return /^(?:としあき|無念\s+としあき)(?:\s|$)/.test(n);
  if(boardId==='holo'||boardId==='niji'){
    if(/^(?:名無しさん|名無し|無名)/.test(n)&&/(?:@|＠)転載禁止/.test(n))return true;
    if(/^(?:名無しの太陽|無名さん|名無しさん)(?:\s|[（(]|$)/.test(n))return true;
  }
  return false;
}
function displayHn(boardId,name=''){const n=cleanName(name);return n&&!isDefaultName(boardId,n)?n:''}
function quoteLineDepth(line=''){
  const m=String(line||'').match(/^\s*(>+)/);return m?m[1].length:0
}
function normalizeQuoteText(s=''){return String(s||'').replace(/^\s*>+\s*/,'').replace(/\s+/g,' ').trim()}
function normalizeQuoteAttachmentUrl(raw=''){
  const safe=safeUrl(trimUrlPunct(String(raw||'').trim()));if(!safe)return '';
  try{const u=new URL(safe);u.hash='';return u.href}catch{return safe}
}
function quoteAttachmentFileName(raw=''){
  const safe=normalizeQuoteAttachmentUrl(raw);if(!safe)return '';
  try{const p=new URL(safe).pathname;const name=p.slice(p.lastIndexOf('/')+1);return decodeURIComponent(name).trim().toLowerCase()}catch{return ''}
}
function quoteIndexState(){return {byDepth:new Map(),sourceLines:[],attachmentExact:new Map(),attachmentNormalized:new Map(),attachmentNames:new Map(),globalNoToLocal:new Map()}}
function addIndexSet(map,key,postNo){if(!key)return;let set=map.get(key);if(!set){set=new Set();map.set(key,set)}set.add(String(postNo))}
function depthTextMap(index,depth){let map=index.byDepth.get(depth);if(!map){map=new Map();index.byDepth.set(depth,map)}return map}
function quoteCandidates(q,index,{sourceDepth=0,allowContains=true}={}){
  const map=index.byDepth.get(sourceDepth),exact=map?.get(q);if(exact?.size)return new Set(exact);
  if(!allowContains||q.length<20)return new Set();
  const out=new Set();for(const row of index.sourceLines)if(row.depth===sourceDepth&&row.text.includes(q))out.add(row.postNo);return out
}
function futabaAttachmentQuoteRows(post){
  const rows=[],seen=new Set();
  const add=raw=>{const originalUrl=safeUrl(raw);if(!originalUrl||seen.has(originalUrl))return;seen.add(originalUrl);const normalizedUrl=normalizeQuoteAttachmentUrl(originalUrl),fileName=quoteAttachmentFileName(originalUrl);rows.push({originalUrl,normalizedUrl,fileName})};
  for(const a of (post.attachments||[]))add(a?.originalUrl||a?.url||'');
  if(post.imageFull)add(post.imageFull);
  return rows
}
function addQuoteSource(post,index){
  const postNo=String(post.n||'');
  for(const line of String(post.body||'').split('\n')){const depth=quoteLineDepth(line),q=normalizeQuoteText(line);if(!q)continue;addIndexSet(depthTextMap(index,depth),q,postNo);index.sourceLines.push({text:q,depth,postNo})}
  for(const row of futabaAttachmentQuoteRows(post)){addIndexSet(index.attachmentExact,row.originalUrl,postNo);addIndexSet(index.attachmentNormalized,row.normalizedUrl,postNo);addIndexSet(index.attachmentNames,row.fileName,postNo)}
  const globalNo=String(post.postNo||'').trim();if(globalNo)index.globalNoToLocal.set(globalNo,postNo)
}
function uniqueSetValue(set){return set?.size===1?[...set][0]:''}
function attachmentQuoteCandidates(q,index){
  const raw=trimUrlPunct(String(q||'').trim()),safe=safeUrl(raw);
  if(safe){const exact=index.attachmentExact.get(safe);if(exact?.size)return new Set(exact);const norm=index.attachmentNormalized.get(normalizeQuoteAttachmentUrl(safe));if(norm?.size)return new Set(norm);return new Set()}
  const name=quoteAttachmentFileName(`https://quote.invalid/${raw.replace(/^\/+/, '')}`);if(!name||!/\.(?:jpe?g|png|gif|webp|bmp|avif|mp4|webm|mov|m4v)$/i.test(name))return new Set();
  return new Set(index.attachmentNames.get(name)||[])
}
function directFutabaQuoteTarget(line,index){
  const raw=normalizeQuoteText(line);if(!raw)return '';
  const no=raw.match(/^No\.?\s*(\d+)$/i)?.[1];if(no)return index.globalNoToLocal.get(String(no))||'';
  const numeric=raw.match(/^(\d+)$/)?.[1];if(numeric&&quoteLineDepth(line)>=2)return index.globalNoToLocal.get(String(numeric))||'';
  return ''
}
function intersectCandidateSets(rows){
  if(!rows.length||rows.some(row=>!row.candidates.size))return new Set();
  let common=new Set(rows[0].candidates);for(const row of rows.slice(1))for(const n of [...common])if(!row.candidates.has(n))common.delete(n);return common
}
function assignQuoteRowTarget(post,targets,row,target){
  if(!target)return;targets.add(target);post.quoteLineTargets[row.i]=target
}
function resolveFutabaQuoteRun(post,targets,rows){
  if(!rows.length)return;
  const confirmed=new Set();
  for(const row of rows){const target=uniqueSetValue(row.candidates);if(target){row.resolved=target;confirmed.add(target);assignQuoteRowTarget(post,targets,row,target)}}
  if(confirmed.size===1){
    const target=[...confirmed][0];
    for(const row of rows)if(!row.resolved&&row.candidates.has(target)){row.resolved=target;assignQuoteRowTarget(post,targets,row,target)}
    return
  }
  if(confirmed.size>1)return;
  const common=intersectCandidateSets(rows),target=uniqueSetValue(common);
  if(target)for(const row of rows){row.resolved=target;assignQuoteRowTarget(post,targets,row,target)}
}
function annotateFutabaQuoteLines(post,index,targets){
  const lines=String(post.body||'').split('\n');
  for(let begin=0;begin<lines.length;){
    if(quoteLineDepth(lines[begin])<1){begin++;continue}
    let end=begin+1;while(end<lines.length&&quoteLineDepth(lines[end])>=1)end++;
    const rows=[];
    for(let i=begin;i<end;i++){
      const depth=quoteLineDepth(lines[i]),q=normalizeQuoteText(lines[i]);if(!q){rows.push({i,depth,q,candidates:new Set()});continue}
      const direct=directFutabaQuoteTarget(lines[i],index);if(direct){rows.push({i,depth,q,candidates:new Set([direct]),direct:true});continue}
      const attachment=attachmentQuoteCandidates(q,index);if(attachment.size){rows.push({i,depth,q,candidates:attachment,attachment:true});continue}
      const oneLine=end-begin===1;if(oneLine&&q.length<8){rows.push({i,depth,q,candidates:new Set()});continue}
      rows.push({i,depth,q,candidates:quoteCandidates(q,index,{sourceDepth:Math.max(0,depth-1),allowContains:q.length>=20})})
    }
    for(let runStart=0;runStart<rows.length;){
      while(runStart<rows.length&&!rows[runStart].candidates.size)runStart++;
      if(runStart>=rows.length)break;
      let runEnd=runStart+1;while(runEnd<rows.length&&rows[runEnd].candidates.size)runEnd++;
      resolveFutabaQuoteRun(post,targets,rows.slice(runStart,runEnd));runStart=runEnd
    }
    begin=end;
  }
}
function annotateOnePost(board,post,map,seen,index){
  post.n=String(post.n||post.postNo||'');post.quoteBoard=board;post.quoteTargets=[];post.quoteLineTargets={};post.backrefs=[];const targets=new Set();
  if(board!=='futaba')for(const m of String(post.body||'').matchAll(/>>\s*(\d+)/g)){const n=String(m[1]);if(seen.has(n)&&map.has(n))targets.add(n)}
  if(board==='futaba')annotateFutabaQuoteLines(post,index,targets);
  post.quoteTargets=[...targets];seen.add(post.n);if(board==='futaba')addQuoteSource(post,index);return post
}
function buildQuoteComponentIndex(posts,map){
  const adjacency=new Map();for(const post of posts){const n=String(post.n);adjacency.set(n,new Set())}
  for(const post of posts){const child=String(post.n),edges=adjacency.get(child);for(const raw of [...(post.quoteTargets||[]),...(post.backrefs||[])]){const parent=String(raw);if(!map.has(parent)||parent===child)continue;edges.add(parent);adjacency.get(parent)?.add(child)}}
  const byPost=new Map(),visited=new Set();
  for(const post of posts){const start=String(post.n);if(visited.has(start))continue;const members=new Set(),queue=[start];visited.add(start);while(queue.length){const n=queue.shift();members.add(n);for(const next of (adjacency.get(n)||[]))if(!visited.has(next)){visited.add(next);queue.push(next)}}const component={members,size:members.size};for(const n of members){byPost.set(n,component);const item=map.get(n);if(item)item.quoteComponentSize=component.size}}
  return byPost;
}
function annotatePosts(p,posts){
  const map=new Map();for(const post of posts){post.n=String(post.n||post.postNo||'');post.quoteTargets=[];post.quoteLineTargets={};post.backrefs=[];post.quoteComponentSize=1;map.set(post.n,post)}
  const seen=new Set(),index=quoteIndexState();for(const post of posts)annotateOnePost(p.board,post,map,seen,index);
  for(const post of posts){for(const target of post.quoteTargets||[]){const t=map.get(String(target));if(t&&!t.backrefs.includes(post.n))t.backrefs.push(post.n)}}
  for(const post of posts)post.related=[...new Set([...(post.quoteTargets||[]),...(post.backrefs||[])])];
  p.postMap=map;p.quoteComponentByPost=buildQuoteComponentIndex(posts,map);return posts;
}

function attachmentList(x){
  const out=[],relatedThumbs=new Set();
  const add=(url,thumb='',type='',relatedThumb=false,width=0,height=0,sourceUrl='')=>{
    url=safeUrl(url);thumb=safeUrl(thumb)||url;sourceUrl=safeUrl(sourceUrl)||url;if(!url)return;
    if(relatedThumb&&thumb&&thumb!==url)relatedThumbs.add(thumb);
    if(out.some(v=>v.url===url))return;
    type=type||(isVideoUrl(url)?'video':'image');out.push({url,thumb,type,width:Number(width)||0,height:Number(height)||0,sourceUrl});
  };
  for(const a of (x.attachments||[]))add(a.url,a.thumb,a.type,true,a.width,a.height,a.sourceUrl);
  if(x.image)add(x.imageFull||x.image,x.image,isVideoUrl(x.imageFull||'')?'video':'image',true,x.imageWidth,x.imageHeight,x.imageSourceUrl);
  for(const u of (x.media||[]))add(u,u,isVideoUrl(u)?'video':'image',false);
  for(const raw of extractUrls(x.body||'')){
    const u=safeUrl(raw);if(!u||relatedThumbs.has(u))continue;
    if(isImageUrl(u)||isVideoUrl(u))add(u,u,isVideoUrl(u)?'video':'image',false);
  }
  return out;
}
function mediaAspect(m){const w=Number(m?.width)||0,h=Number(m?.height)||0;return w>0&&h>0?`${w}/${h}`:'16/9'}
function mediaAttachmentHtml(m,standalone=false){
  const cls=standalone?' standalone':'',source=safeUrl(m.sourceUrl)||safeUrl(m.url)||'',style=`--media-aspect:${esc(mediaAspect(m))}`;
  if(m.type==='video')return `<div class="attachmentWrap${standalone?' standaloneWrap':''}" style="${style}"><button class="attachment${cls} videoThumb" data-lightbox-src="${esc(m.url)}" data-lightbox-source-url="${esc(source)}" data-lightbox-type="video"><video class="previewVideoThumb" muted playsinline preload="none" ${m.thumb?`poster="${esc(boardMediaSrc(m.thumb))}"`:``} data-src="${esc(videoMediaSrc(m.url))}"></video><span class="playBadge">▶</span><span class="videoState" aria-live="polite"></span></button></div>`;
  return `<div class="attachmentWrap${standalone?' standaloneWrap':''}" style="${style}" data-media-url="${esc(m.url)}" data-media-attempt="0"><button class="attachment${cls}" data-lightbox-src="${esc(m.url)}" data-lightbox-source-url="${esc(source)}" data-lightbox-type="image"><img loading="lazy" data-media-attempt="0" src="${esc(mediaAttemptSrc(m.thumb||m.url,0))}" alt=""></button><div class="mediaLoadError" role="status" hidden><span class="mediaErrorIcon" aria-hidden="true">▧</span><span class="mediaErrorText">画像を読み込めません</span><button type="button" class="retryInlineImage">再試行</button></div></div>`;
}
function previewUrls(x,attachments=attachmentList(x),limit=3){
  const attached=new Set(attachments.flatMap(a=>[a.url,a.thumb]).map(safeUrl).filter(Boolean));
  const candidates=[...extractUrls(x.body||''),...(x.links||[])].map(safeUrl).filter(Boolean);
  const all=[...new Set(candidates)].filter(u=>!attached.has(u));
  return Number.isFinite(limit)?all.slice(0,Math.max(0,limit)):all;
}
function mediaDisplayPlan(post){
  const attachments=attachmentList(post),previews=previewUrls(post,attachments),allPreviews=previewUrls(post,attachments,Infinity),hiddenUrls=new Set();
  const attachmentByUrl=new Map();
  for(const a of attachments){const u=safeUrl(a.url),thumb=safeUrl(a.thumb);if(u){hiddenUrls.add(u);attachmentByUrl.set(u,a)}if(thumb){hiddenUrls.add(thumb);attachmentByUrl.set(thumb,a)}}
  const sourceUrls=[...extractUrls(post.body||''),...(post.links||[])].map(safeUrl).filter(Boolean),sourceSet=new Set(sourceUrls);
  const mediaItems=[],emittedAttachments=new Set(),emittedYoutube=new Set();
  // A board-native attachment that is not represented in body/link text keeps the old attachment-first position.
  for(const a of attachments){const u=safeUrl(a.url),thumb=safeUrl(a.thumb);if(!sourceSet.has(u)&&!sourceSet.has(thumb)){mediaItems.push({kind:'attachment',media:a});emittedAttachments.add(a)}}
  // Text-origin media follows the original URL order, allowing images/videos and YouTube to share one grid.
  for(const u of sourceUrls){const a=attachmentByUrl.get(u);if(a&&!emittedAttachments.has(a)){mediaItems.push({kind:'attachment',media:a});emittedAttachments.add(a);continue}const id=youtubeId(u);if(id&&!emittedYoutube.has(u)){mediaItems.push({kind:'youtube',url:u,id});emittedYoutube.add(u)}}
  for(const a of attachments)if(!emittedAttachments.has(a)){mediaItems.push({kind:'attachment',media:a});emittedAttachments.add(a)}
  for(const u of allPreviews){const id=youtubeId(u);if(id&&!emittedYoutube.has(u)){mediaItems.push({kind:'youtube',url:u,id});emittedYoutube.add(u)}}
  const linkPreviews=allPreviews.filter(u=>!youtubeId(u)).slice(0,3);
  for(const item of mediaItems)if(item.kind==='youtube'){const safe=safeUrl(item.url);if(safe)hiddenUrls.add(safe)}
  for(const u of linkPreviews){const safe=safeUrl(u);if(safe)hiddenUrls.add(safe)}
  return {attachments,previews,mediaItems,linkPreviews,hiddenUrls};
}
function youtubeGridMediaHtml(url,id){
  const thumb=`https://i.ytimg.com/vi/${id}/hqdefault.jpg`,start=youtubeStart(url);
  return `<div class="youtubeGridMedia" data-youtube-id="${esc(id)}" data-youtube-url="${esc(url)}" data-youtube-start="${start}"><button class="previewMedia" type="button" aria-label="YouTubeを拡大再生"><img class="previewImage" loading="lazy" src="${thumb}" alt="YouTube"><span class="playBadge">▶</span><span class="youtubeGridLabel">YouTube${start?` · ${Math.floor(start/60)}:${String(start%60).padStart(2,'0')}`:''}</span></button></div>`;
}
function mediaGridHtml(x,plan=mediaDisplayPlan(x)){
  const items=plan.mediaItems||[];if(!items.length)return '';
  const single=items.length===1;
  return `<div class="mediaGrid ${single?'single':'multiple'}" data-media-count="${items.length}">${items.map((item,index)=>{if(item.kind==='youtube'){const html=single?youtubePreviewHtml(item.url,item.id):youtubeGridMediaHtml(item.url,item.id);return `<div class="mediaCell youtubeMediaCell" data-media-index="${index}">${html}</div>`}return `<div class="mediaCell attachmentMediaCell" data-media-index="${index}">${mediaAttachmentHtml(item.media,false)}</div>`}).join('')}</div>`;
}
function attachmentsHtml(x,plan=mediaDisplayPlan(x)){return mediaGridHtml(x,plan)}
function previewPlaceholders(x,plan=mediaDisplayPlan(x)){
  const urls=plan.linkPreviews||[];if(!urls.length)return '';
  return `<div class="previewStack">${urls.map(u=>`<div class="previewLoading" data-preview-url="${esc(u)}"><span class="loadingDot"></span>リンクを展開中…</div>`).join('')}</div>`;
}
function linkifyLine(line='',post,lineIndex=0,hiddenUrls=null){
  const raw=String(line),re=/https?:\/\/[^\s<>"']+/gi;let out='',last=0,m;
  while((m=re.exec(raw))){
    const url=trimUrlPunct(m[0]),safe=safeUrl(url),suffix=m[0].slice(url.length);out+=esc(raw.slice(last,m.index));
    if(!(safe&&hiddenUrls?.has(safe))){const ref=internalThreadRef(url);out+=`<a class="inlineLink${ref?' internalThreadLink':''}" href="${esc(url)}" ${ref?`data-thread-board="${esc(ref.boardId)}" data-thread-id="${esc(ref.threadId)}"`:'target="_blank" rel="noreferrer"'}>${esc(url)}</a>`}
    out+=esc(suffix);last=m.index+m[0].length;
  }
  out+=esc(raw.slice(last));
  const futabaTarget=post?.quoteLineTargets?.[lineIndex];
  if(futabaTarget&&/^&gt;/.test(out.trim()))return `<span class="quoteLineRef" data-quote-target="${esc(futabaTarget)}" role="button" tabindex="0">${out}</span>`;
  const futabaNumericFile=post?.quoteBoard==='futaba'&&/^\s*>>\s*\d+\.(?:jpe?g|png|gif|webp|bmp|avif|mp4|webm|mov|m4v)(?:\s|$)/i.test(raw);
  if(!futabaNumericFile)out=out.replace(/&gt;&gt;\s*(\d+)/g,(m,n)=>`<span class="quoteRef" data-quote-target="${esc(n)}" role="button" tabindex="0">&gt;&gt;${esc(n)}</span>`);return out;
}
function aaLineScore(line=''){
  const raw=String(line).replace(/\t/g,'    '),t=raw.trim();if(!t||/^https?:\/\//i.test(t))return 0;
  const chars=[...raw],nonSpace=chars.filter(c=>! /\s/.test(c));if(!nonSpace.length)return 0;
  const artClass=/[\\/|｜_＿￣.,，、。;:：'`´｀~^＾()（）\[\]「」『』<>＜＞\-ー=+*＊・…ﾟ彡ミﾉヽ乂人へ]/u;
  const structural=nonSpace.filter(c=>artClass.test(c)).length/nonSpace.length;
  let score=0;
  if(structural>=.52)score+=3;else if(structural>=.34)score+=2;else if(structural>=.20)score+=1;
  if(/^\s{2,}\S/.test(raw))score+=1;
  if(/[\\/|｜_＿￣]{2,}|[.,，、;:'`´｀]{3,}|[─━┌┐└┘├┤┬┴┼╋]/u.test(raw))score+=1.7;
  if(/[（(][^\n]{0,12}[）)]|[／＼][^\n]{0,8}[／＼]|(?:ﾟ|ω|д|Д|∀|・|へ|ﾉ|ヽ|彡|ミ)/u.test(raw))score+=.7;
  const prose=(t.match(/[ぁ-んァ-ン一-龯A-Za-z0-9]{2,}/gu)||[]).join('').length/Math.max(1,t.length);
  if(prose>.72&&structural<.22)score-=1.4;
  return score;
}
function isAsciiArt(text=''){
  const lines=String(text).replace(/\t/g,'    ').split('\n'),nonEmpty=lines.filter(x=>x.trim());if(nonEmpty.length<2)return false;
  const scores=lines.map(aaLineScore),strong=scores.filter(x=>x>=2.4).length,medium=scores.filter(x=>x>=1.5).length;
  const total=nonEmpty.join('').length;
  return (strong>=2)||(strong>=1&&medium>=2&&total>=24)||(nonEmpty.length>=5&&medium>=Math.ceil(nonEmpty.length*.55));
}
function renderAsciiArt(text='',post=null,startLine=0){
  const lines=String(text).split('\n');
  return `<pre class="asciiArt" aria-label="ASCII art">${lines.map((line,i)=>linkifyLine(line,post,startLine+i)).join('\n')}</pre>`;
}
function quoteDisplayLine(line=''){return /^\s*>+/.test(String(line))}
function renderBodyLine(line,post,lineIndex,hiddenUrls){const html=linkifyLine(line,post,lineIndex,hiddenUrls);return quoteDisplayLine(line)?`<span class="quoteLine">${html}</span>`:html}
function standaloneHiddenMediaLine(line,hiddenUrls){
  const raw=String(line),m=raw.match(/^\s*(https?:\/\/[^\s<>"']+)\s*$/i);if(!m)return false;
  const url=trimUrlPunct(m[1]),suffix=m[1].slice(url.length),safe=safeUrl(url);
  return !!(safe&&hiddenUrls.has(safe)&&!suffix);
}
function renderBody(post,plan=mediaDisplayPlan(post)){
  const text=String(post.body||''),hidden=plan.hiddenUrls;
  const sourceLines=text.split('\n'),kept=sourceLines.map((line,i)=>({line,i,removed:standaloneHiddenMediaLine(line,hidden)})).filter(x=>!x.removed);
  const visibleText=kept.map(x=>x.line).join('\n');
  if(isAsciiArt(visibleText))return `<pre class="asciiArt" aria-label="ASCII art">${kept.map(x=>linkifyLine(x.line,post,x.i)).join('\n')}</pre>`;
  return kept.map(x=>renderBodyLine(x.line,post,x.i,hidden)).join('\n');
}
function fitAsciiArt(root=document){return root}
function sideMetaHtml(p,x){
  const no=esc(x.n||'');const id=cleanPostId(x.id||((x.meta||'').match(/ID:([^\s·]+)/)||[])[1]||'');const d=parseDateParts(x.date||x.meta||'');const hn=displayHn(p.board,x.name||'');const componentSize=Math.max(1,Number(x.quoteComponentSize)||1);
  const row1=(no||hn)?`<div class="postMetaLine postMetaPrimary">${no?`<span class="postNo">${no}</span>`:''}${hn?`<span class="hn" title="${esc(hn)}">${esc(hn)}</span>`:''}</div>`:'';
  const row2=id?`<div class="postMetaLine postMetaId"><button class="postId" data-post-id="${esc(id)}" title="ID:${esc(id)}" aria-label="ID ${esc(id)}">ID:${esc(id)}</button></div>`:'';
  const row3=(d.time||componentSize>1)?`<div class="postMetaLine postMetaFooter">${d.time?`<span class="postClock">${esc(d.time)}</span>`:''}${componentSize>1?`<button class="quoteTreeBtn" data-tree-post="${no}" title="引用ツリー"><span class="treeGlyph">↳</span>${componentSize}</button>`:''}</div>`:'';
  return `<div class="postSide">${row1}${row2}${row3}</div>`;
}
function wsbOriginalAssistHtml(x){
  if(!x?.redditMachineTranslated&&!x?.redditSampleTranslated)return '';
  const original=String(x.redditOriginal||''),label=x?.redditSampleTranslated?'サンプル訳文・翻訳動作の証拠ではありません':'ローカル機械翻訳';
  return `<div class="wsbTranslationMeta"><span class="wsbMachineLabel">${esc(label)}</span>${original?`<span class="wsbOriginalAssist"><button type="button" class="wsbOriginalToggle" aria-expanded="false">原文</button><span class="wsbOriginalText" role="tooltip">${esc(original).replace(/\n/g,'<br>')}</span></span>`:''}</div>`
}
function postHtml(p,x,fresh=false){
  const d=parseDateParts(x.date||x.meta||'');
  const plan=x.deleted?null:mediaDisplayPlan(x),mediaCount=plan?.mediaItems?.length||0,mediaClass=mediaCount?(mediaCount===1?' hasMedia mediaSingle':' hasMedia mediaMultiple'):'';return `<article class="post ${fresh?'new':''} ${x.deleted?'deleted':''}" data-key="${esc(x.key||`${p.board}-${x.n}`)}" data-post-no="${esc(x.n||'')}" data-date-key="${esc(d.key)}"><div class="messageColumn${mediaClass}"><div class="postBubble"><div class="postBody">${x.deleted?'[取得元から消えたレス]':renderBody(x,plan)}</div>${x.deleted?'':wsbOriginalAssistHtml(x)}${x.deleted?'':attachmentsHtml(x,plan)}${x.deleted?'':previewPlaceholders(x,plan)}</div></div>${sideMetaHtml(p,x)}</article>`;
}
function dateSeparator(label,key,postKey=''){return `<div class="dateSeparator" data-date-key="${esc(key)}" data-boundary-post="${esc(postKey)}"><span>${esc(label)}</span></div>`}
function postHeaderDateParts(x){return parseDateParts(x?.date||'')}
function postsHtml(p,posts,fresh=false){return posts.map(x=>postHtml(p,x,fresh)).join('')}
function reconcileDateSeparators(p,box){
  const content=postsContent(box);if(!content)return;content.querySelectorAll('.dateSeparator').forEach(n=>n.remove());
  const boundarySet=new Set(logicalDateBoundaryIndexes(p.posts||[],post=>postHeaderDateParts(post).key));
  const indexByKey=new Map((p.posts||[]).map((post,index)=>[String(post.key||`${p.board}-${post.n}`),index]));
  for(const node of content.querySelectorAll('.post')){const key=String(node.dataset.key||''),index=indexByKey.get(key);if(index==null)continue;const d=postHeaderDateParts(p.posts[index]);node.dataset.dateKey=d.key||'';if(!d.key||!boundarySet.has(index))continue;node.insertAdjacentHTML('beforebegin',dateSeparator(d.label,d.key,key));}
}
function paneViewportAtTail(el,p){const box=el?.querySelector?.('.posts');if(!box)return !!p?.follow;return Math.abs(box.scrollHeight-box.scrollTop-box.clientHeight)<=2}
function updateNewButton(el,p){
  const control=el.querySelector('.notificationControl'),btn=el.querySelector('.newPosts'),secondary=el.querySelector('.notificationCandidates');
  if(!control||!btn||!secondary)return;
  const status=p.threadStatus||'unknown',terminal=status==='ended'||status==='missing',newCount=Math.max(0,Number(p.newCount)||0),hasNew=newCount>0,atTail=paneViewportAtTail(el,p),retryable=status==='partial'||(status==='unknown'&&!!p.error),isError=!!p.error||p.nextStatus==='error';
  const plan=threadNotificationPlan({terminal,newCount,atTail,follow:!!p.follow,retryable,status,nextStatus:p.nextStatus||'',candidateCount:p.nextCandidates?.length||0});
  control.classList.toggle('hasNew',hasNew);control.classList.toggle('threadEnded',terminal);control.classList.toggle('notificationError',isError);
  btn.classList.toggle('hasNew',hasNew);btn.classList.toggle('threadEnded',terminal);btn.classList.toggle('notificationError',isError);
  el.classList.toggle('following',!!(p.follow&&atTail&&!plan.showPrimary&&!plan.showSecondary));
  btn.hidden=!plan.showPrimary;btn.textContent=plan.primaryLabel;btn.dataset.notificationAction=plan.primaryAction;btn.disabled=!!plan.disabled;btn.setAttribute('aria-expanded',String(plan.primaryAction==='candidates'&&!!p.uiState.candidatePanelOpen));
  secondary.hidden=!plan.showSecondary;secondary.dataset.notificationAction=plan.secondaryAction;secondary.textContent=plan.secondaryLabel;secondary.disabled=!!plan.disabled;secondary.setAttribute('aria-expanded',String(plan.secondaryAction==='candidates'&&!!p.uiState.candidatePanelOpen));
  control.classList.toggle('hasSecondary',!!plan.showSecondary);control.hidden=!plan.showPrimary&&!plan.showSecondary;
}

function paneShellHtml(p){
  if(p.kind==='board')return `<section class="pane boardPane" data-pane-id="${esc(p.paneId)}"><div class="paneHead"><span class="paneTitleActionArea"><button class="paneTitleBtn" aria-label="${esc(boardOf(p.board)?.name||p.board)}">${esc(boardOf(p.board)?.name||p.board)}</button><span class="paneStatus srOnly" aria-live="polite"></span><span class="closeSlot"><button class="close" title="閉じる" aria-label="閉じる">×</button></span></span></div><div class="boardPaneTools"><input class="boardFilter" placeholder="スレッドを検索" value="${esc(p.filter||'')}"><select class="boardSort"><option value="hot" ${p.sort==='hot'?'selected':''}>勢い順</option><option value="count" ${p.sort==='count'?'selected':''}>レス数順</option><option value="source" ${p.sort==='source'?'selected':''}>取得順</option></select></div><div class="threadList boardPaneList"><div class="loading">取得中…</div></div></section>`;
  const plusIcon='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',sendIcon='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5"/></svg>';
  return `<section class="pane${isWsbPane(p)?' wsbPane':''}" data-pane-id="${esc(p.paneId)}"><div class="paneHead"><span class="historyHover historyBackWrap" data-history-direction="back"><button class="historyBack" aria-label="戻る">‹</button></span><span class="historyHover historyForwardWrap" data-history-direction="forward"><button class="historyForward" aria-label="進む">›</button></span><span class="paneTitleActionArea"><button class="paneTitleBtn" aria-label="${esc(p.title||'Loading…')}">${esc(p.title||'Loading…')}</button><span class="paneStatus srOnly" aria-live="polite">取得中…</span><button class="liveModeBtn" type="button" aria-pressed="${p.liveMode?'true':'false'}" title="ライブモード：${p.liveMode?'ON':'OFF'}" aria-label="ライブモード：${p.liveMode?'ON':'OFF'}">◉</button><span class="closeSlot"><button class="close" title="閉じる" aria-label="閉じる">×</button></span></span></div>${isWsbPane(p)?'<div class="wsbStatusBanner" role="status" aria-live="polite" hidden></div>':''}<div class="posts" tabindex="0"><div class="postsContent"><div class="loading">レスを取得中…</div></div></div><div class="historyGestureOverlay" aria-hidden="true"></div><div class="notificationControl" role="group" aria-label="スレッド通知"><button class="newPosts" type="button" aria-expanded="false">↓ 最新レス</button><button class="notificationCandidates" type="button" aria-expanded="false" hidden>次スレ ▾</button></div><div class="nextCandidates" hidden></div><div class="composerHotZone"${isWsbPane(p)?' hidden':''}><div class="composerDock"><div class="composerBar"><button class="composerPlus" title="元スレを開く" aria-label="元スレを開く">${plusIcon}</button><textarea class="composerInput" rows="1" placeholder="メッセージ…">${esc(p.draft||'')}</textarea><button class="composerSend" title="下書きをコピーして元スレを開く" aria-label="下書きをコピーして元スレを開く">${sendIcon}</button></div><div class="composerHint">⌘/Ctrl + Enter でコピーして元スレを開く</div></div></div></section>`;
}

function closeHeaderPopover(){clearTimeout(headerHoverTimer);clearTimeout(headerCloseTimer);const pop=$('#headerPopover');if(pop){pop.hidden=true;pop.innerHTML='';for(const key of ['paneId','kind','direction','generation','trigger','ownerKey'])delete pop.dataset[key]}scheduleLiveReevaluation(0)}
function scheduleHeaderClose(){clearTimeout(headerCloseTimer);headerCloseTimer=setTimeout(()=>{const pop=$('#headerPopover');if(!pop?.matches(':hover')&&!document.querySelector('.paneHead [data-header-hover="1"]:hover'))closeHeaderPopover()},120)}
function headerPopoverOwnerKey(p,kind,dir='',trigger=''){return `${p?.paneId||''}|${Number(p?.generation)||0}|${kind}|${trigger}|${dir}`}
function setHeaderPopoverOwner(pop,p,kind,dir='',trigger=''){pop.dataset.paneId=p.paneId;pop.dataset.kind=kind;pop.dataset.direction=dir;pop.dataset.generation=String(Number(p.generation)||0);pop.dataset.trigger=trigger;pop.dataset.ownerKey=headerPopoverOwnerKey(p,kind,dir,trigger)}
function renderPaneDetailPopover(p,anchor,trigger='title'){if(!p||!anchor)return;const pop=$('#headerPopover');setHeaderPopoverOwner(pop,p,'detail','',trigger);const state=p.error?`エラー: ${p.error}`:p.pendingNavigation?'移動中':p.stale?'キャッシュ表示':p.loading?'取得中':'正常';pop.innerHTML=`<div class="headerPopoverTitle">${esc(p.title||'未取得')}</div><dl><dt>板</dt><dd>${esc(boardOf(p.board)?.name||p.board)}</dd><dt>レス数</dt><dd>${Number(p.total)||0}</dd><dt>状態</dt><dd>${esc(state)}</dd><dt>最終取得</dt><dd>${esc(p.lastSuccessAt||'未取得')}</dd><dt>URL</dt><dd><a href="${esc(p.url)}" target="_blank" rel="noreferrer" title="${esc(p.url)}">スレッドを開く</a></dd></dl>`;positionFloating(pop,anchor,{gap:5,maxWidth:280})}
function historyItems(p,dir){if(!p?.history)return[];const out=[];if(dir==='back'){for(let i=p.history.index-1;i>=0;i--)out.push({entry:p.history.entries[i],index:i})}else{for(let i=p.history.index+1;i<p.history.entries.length;i++)out.push({entry:p.history.entries[i],index:i})}return out}
function renderHistoryPopover(p,anchor,dir,trigger=`history-${dir}`){if(!p||!anchor)return;const pop=$('#headerPopover'),items=historyItems(p,dir);setHeaderPopoverOwner(pop,p,'history',dir,trigger);const label=dir==='back'?'戻る':'進む';pop.innerHTML=`<div class="headerPopoverTitle">${label}履歴</div><div class="historyList">${items.length?items.map(({entry,index})=>`<button data-history-index="${index}" data-history-thread="${esc(entry.threadId||'')}"><span>${esc(entry.title||entry.url||'Untitled')}</span><small>${esc(boardOf(entry.board)?.name||entry.board||'')}</small></button>`).join(''):`<div class="historyEmpty">${label}履歴はありません</div>`}</div>`;pop.querySelectorAll('[data-history-index]').forEach(btn=>btn.onclick=()=>{const idx=Number(btn.dataset.historyIndex),entry=p.history.entries[idx];if(!entry||String(entry.threadId||'')!==btn.dataset.historyThread){closeHeaderPopover();return}if(p.pendingNavigation)return;closeHeaderPopover();void navigatePane(p,{board:entry.board,url:entry.url,title:entry.title},{kind:'history',historyIndex:idx})});positionFloating(pop,anchor,{gap:5,maxWidth:420})}
function bindHeaderHover(el,p){const title=el.querySelector('.paneTitleBtn');const arm=(anchor,kind,dir='',trigger='')=>{if(!anchor)return;anchor.dataset.headerHover='1';const open=()=>{clearTimeout(headerCloseTimer);clearTimeout(headerHoverTimer);const ownerKey=headerPopoverOwnerKey(p,kind,dir,trigger);headerHoverTimer=setTimeout(()=>{if(!anchor.isConnected||(!anchor.matches(':hover')&&!anchor.matches(':focus-within')&&!anchor.matches(':focus')))return;const pop=$('#headerPopover');if(!pop.hidden&&pop.dataset.ownerKey&&pop.dataset.ownerKey!==ownerKey)closeHeaderPopover();kind==='detail'?renderPaneDetailPopover(p,anchor,trigger):renderHistoryPopover(p,anchor,dir,trigger);pop.hidden=false},400)};const leave=()=>{clearTimeout(headerHoverTimer);scheduleHeaderClose()};anchor.addEventListener('pointerenter',open);anchor.addEventListener('focusin',open);anchor.addEventListener('pointerleave',leave);anchor.addEventListener('focusout',leave)};arm(title,'detail','','title');arm(el.querySelector('.historyBackWrap'),'history','back','history-back');arm(el.querySelector('.historyForwardWrap'),'history','forward','history-forward')}
function updateHistoryButtons(el,p){const back=el?.querySelector?.('.historyBack'),forward=el?.querySelector?.('.historyForward');if(back)back.disabled=!(p.pendingNavigation||p.history.index>0);if(forward)forward.disabled=!!p.pendingNavigation||p.history.index>=p.history.entries.length-1}

function captureBoardAnchor(p,list){const first=[...list.querySelectorAll('.thread')].find(el=>el.getBoundingClientRect().bottom>list.getBoundingClientRect().top);p.anchorThreadKey=first?.dataset.key||'';p.anchorOffset=first?first.getBoundingClientRect().top-list.getBoundingClientRect().top:0}
function restoreBoardAnchor(p,list){if(!p.anchorThreadKey)return;const el=[...list.querySelectorAll('.thread')].find(x=>x.dataset.key===p.anchorThreadKey);if(el)list.scrollTop+=el.getBoundingClientRect().top-list.getBoundingClientRect().top-(Number(p.anchorOffset)||0)}
function renderBoardPane(p,{resetTop=false,force=false}={}){const el=paneElement(p);if(!el)return;const list=el.querySelector('.boardPaneList'),source=el.querySelector('.boardPaneSource');if(!list){console.error('[LiveBoard board structure error]',{paneId:p.paneId,board:p.board,list:false});return}if(!p.data){p.renderSignature='';if(p.loading)list.innerHTML='<div class="loading">取得中…</div>';else if(p.error)list.innerHTML=`<div class="error">一覧取得エラー<br>${esc(p.error)}<br><button class="retryBoardPane">再試行</button></div>`;el.querySelector('.retryBoardPane')?.addEventListener('click',()=>refreshBoardPane(p,true));return}const signature=`${p.data.time||0}|${p.sort}|${p.filter}`;if(force||resetTop||p.renderSignature!==signature){renderBoardListInto({list,data:p.data,boardId:p.board,sort:p.sort,filter:p.filter,onOpen:t=>addPane(t),preserveScroll:false,sourceEl:source});p.renderSignature=signature;if(resetTop)list.scrollTop=0;else restoreBoardAnchor(p,list)}else if(source)source.textContent=`${fmtTime(p.data.time||Date.now())} · ${p.data.source||''}`;const status=el.querySelector('.paneStatus');if(status)status.textContent=p.error?`${p.lastSuccessAt||'最終成功'} · 更新失敗: ${p.error}`:`最終成功 ${fmtTime(p.data?.time||Date.now())}`;const title=el.querySelector('.paneTitleBtn');if(title)title.title=`${p.filter?`検索: ${p.filter} · `:''}${p.sort==='hot'?'勢い順':p.sort==='count'?'レス数順':'取得順'} · ${status?.textContent||''}`;if(p.error&&source)source.textContent=`${p.lastSuccessAt||'最終成功'} · 更新失敗: ${p.error}`}
async function refreshBoardPane(p,manual=false,{sortChanged=false}={}){if(!p||p.disposed||p.kind!=='board')return;const key=cacheKey(p.board,p.sort);if(p.loading&&p.requestKey===key&&!sortChanged)return;if(sortChanged&&p.loading&&p.requestKey!==key)try{p.controller?.abort()}catch{};const epoch=++p.requestEpoch,controller=new AbortController();p.controller=controller;p.requestKey=key;p.loading=true;p.error='';if(!p.data)renderBoardPane(p);try{const j=await api(`/api/board?board=${encodeURIComponent(p.board)}&sort=${encodeURIComponent(p.sort)}`,{signal:controller.signal,timeoutMs:10000});if(p.disposed||p.requestEpoch!==epoch)return;observeThreadActivity(p.board,j.threads||[],Number(j.fetchedAt||j.time||Date.now()),`board:${Number(j.fetchedAt||j.time||Date.now())}`);j.threads=(j.threads||[]).filter(t=>isThreadOpenable(p.board,t));if(p.board==='futaba')applyKnownFutabaTitles(j.threads);const fetchedAt=Date.now();p.data={...j,time:fetchedAt};boardCaches.set(key,p.data);p.lastSuccessAt=fmtTime(fetchedAt);p.error='';renderBoardPane(p);save()}catch(e){if(e?.name==='AbortError'||p.disposed||p.requestEpoch!==epoch)return;p.error=e.message;renderBoardPane(p);if(manual)toast(`${boardOf(p.board)?.name||p.board}: ${e.message}`)}finally{if(!p.disposed&&p.requestEpoch===epoch){p.loading=false;p.requestKey='';if(p.controller===controller)p.controller=null}}}
function pinActiveBoardPane(){const existing=panes.find(p=>p.kind==='board'&&p.board===activeBoard);if(existing){existing.anchorThreadKey='';existing.anchorOffset=0;const list=paneElement(existing)?.querySelector('.boardPaneList');if(list)list.scrollTop=0;focusPane(existing);hideDrawer();return}if(panes.length>=MAX_PANES){toast(`ペインは最大${MAX_PANES}個です`);return}const p=boardPaneState({kind:'board',board:activeBoard,sort:activeSort,filter:$('#filter').value});p.data=boardCaches.get(cacheKey(p.board,p.sort))||null;panes.push(p);save();renderPanes();hideDrawer();void refreshBoardPane(p)}
function bindPaneTitleActions(el){const area=el.querySelector('.paneTitleActionArea');if(!area)return;area.addEventListener('pointerenter',()=>el.classList.add('headerActionsVisible'));area.addEventListener('pointerleave',()=>el.classList.remove('headerActionsVisible'))}
function bindBoardPaneShell(el,p){if(el.dataset.bound==='1')return;el.dataset.bound='1';bindPaneTitleActions(el);el.addEventListener('pointerdown',()=>lastActivePaneId=p.paneId,{capture:true});el.querySelector('.close').onclick=()=>removePane(p.paneId);const list=el.querySelector('.boardPaneList'),filter=el.querySelector('.boardFilter'),sort=el.querySelector('.boardSort'),title=el.querySelector('.paneTitleBtn');title?.addEventListener('click',()=>{if(suppressPaneTitleClick)return;const top=list.scrollTop;el.classList.toggle('toolsOpen');requestAnimationFrame(()=>list.scrollTop=top)});title?.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.altKey&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey){e.preventDefault();title.click()}});filter.addEventListener('input',()=>{p.filter=filter.value;renderBoardPane(p,{resetTop:true});scheduleSave()});sort.addEventListener('change',()=>{p.sort=sort.value;p.anchorThreadKey='';p.anchorOffset=0;p.data=boardCaches.get(cacheKey(p.board,p.sort))||null;renderBoardPane(p,{resetTop:true});scheduleSave();void refreshBoardPane(p,true,{sortChanged:true})});list.addEventListener('scroll',()=>captureBoardAnchor(p,list),{passive:true});installPaneDrag(el,p)}
function paneSwap(a,b){const ia=panes.indexOf(a),ib=panes.indexOf(b);if(ia<0||ib<0||ia===ib)return false;const before=new Map($$('.pane').map(el=>[el.dataset.paneId,el.getBoundingClientRect()]));[panes[ia],panes[ib]]=[panes[ib],panes[ia]];renderPanes();if(!matchMedia('(prefers-reduced-motion: reduce)').matches){paneSwapAnimatingUntil=performance.now()+180;for(const el of $$('.pane')){const r0=before.get(el.dataset.paneId),r1=el.getBoundingClientRect();if(!r0)continue;el.animate([{transform:`translate(${r0.left-r1.left}px,${r0.top-r1.top}px)`},{transform:'translate(0,0)'}],{duration:180,easing:'ease'})}}else paneSwapAnimatingUntil=0;save();return true}
function cancelPaneDrag(){if(paneDrag){try{paneDrag.head?.releasePointerCapture?.(paneDrag.pointerId)}catch{};paneDrag.ghost?.remove();paneDrag.sourceEl?.classList.remove('dragSource');$$('.pane').forEach(x=>x.classList.remove('dragTarget'));paneDrag=null}suppressPaneTitleClick=false;scheduleLiveReevaluation(0)}
function installPaneDrag(el,p){
  const head=el.querySelector('.paneHead'),title=el.querySelector('.paneTitleBtn');if(!head||!title||head.dataset.dragBound)return;head.dataset.dragBound='1';
  head.addEventListener('pointerdown',e=>{if(performance.now()<paneSwapAnimatingUntil||e.button!==0||e.target.closest('button:not(.paneTitleBtn),input,select,textarea'))return;cancelHistoryGesture('pane-drag-start',p.paneId);paneDrag={p,sourceEl:el,head,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,active:false,target:null,ghost:null}});
  head.addEventListener('pointermove',e=>{const d=paneDrag;if(!d||d.pointerId!==e.pointerId)return;if(!d.active&&Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<6)return;if(!d.active){d.active=true;try{d.head.setPointerCapture?.(d.pointerId)}catch{};closeHeaderPopover();d.sourceEl.classList.add('dragSource');const g=document.createElement('div');g.className='paneDragGhost';g.textContent=p.kind==='board'?(boardOf(p.board)?.name||p.board):(p.title||'Untitled');document.body.appendChild(g);d.ghost=g}suppressPaneTitleClick=true;if(d.ghost){d.ghost.style.left=`${e.clientX+12}px`;d.ghost.style.top=`${e.clientY+12}px`}const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.pane');$$('.pane').forEach(x=>x.classList.toggle('dragTarget',!!hit&&x===hit&&x!==d.sourceEl));d.target=hit&&hit!==d.sourceEl?panes.find(x=>x.paneId===hit.dataset.paneId):null});
  const finish=e=>{const d=paneDrag;if(!d||d.pointerId!==e.pointerId)return;const hit=d.active?document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.pane'):null;const target=hit&&hit!==d.sourceEl?panes.find(x=>x.paneId===hit.dataset.paneId):null;cancelPaneDrag();if(target)paneSwap(p,target)};
  head.addEventListener('pointerup',finish);head.addEventListener('pointercancel',cancelPaneDrag);
  title.addEventListener('keydown',e=>{if(!(e.altKey&&e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)))return;const i=panes.indexOf(p);const cols=Number(getComputedStyle($('#grid')).getPropertyValue('--cols'))||1;let delta=0;if(e.key==='ArrowLeft')delta=-1;else if(e.key==='ArrowRight')delta=1;else if(e.key==='ArrowUp')delta=-cols;else delta=cols;const j=i+delta;if(j>=0&&j<panes.length){e.preventDefault();paneSwap(p,panes[j]);requestAnimationFrame(()=>paneElement(p)?.querySelector('.paneTitleBtn')?.focus());const st=paneElement(p)?.querySelector('.paneStatus');if(st)st.textContent=`位置 ${j+1} / ${panes.length}`}});
  title.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.altKey&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey){e.preventDefault();title.click()}})
}
function bindPaneShell(el,p){
  if(p.kind==='board')return bindBoardPaneShell(el,p);if(el.dataset.bound==='1')return;el.dataset.bound='1';installPaneDrag(el,p);
  const box=el.querySelector('.posts');bindPaneTitleActions(el);el.addEventListener('pointerdown',()=>lastActivePaneId=p.paneId,{capture:true});
  el.querySelector('.close').onclick=()=>removePane(p.paneId);el.querySelector('.historyBack').onclick=()=>historyNavigate(p,-1);el.querySelector('.historyForward').onclick=()=>historyNavigate(p,1);el.querySelector('.liveModeBtn').onclick=()=>setLiveMode(p,!p.liveMode);bindHeaderHover(el,p);
  el.querySelector('.paneTitleBtn').onclick=()=>{if(suppressPaneTitleClick)return;lastActivePaneId=p.paneId;readPositionOwnerByThread.set(p.threadId,p.paneId);cancelPendingReadRestore(p);p.follow=false;p.viewIntent='top';p.readingAnchor=null;p.stableAnchor=null;p.userIntentRevision=(Number(p.userIntentRevision)||0)+1;p.positionState='reading';renderVirtualWindow(p,box,0,Math.min(p.posts.length,Number(p.renderWindowSize)||VIRTUAL_WINDOW_SIZE),{reason:'title-top-window',revision:p.userIntentRevision,force:true});writePaneScrollTop(p,box,0,'title-top',p.userIntentRevision);const firstKey=postKeyAt(p,0);p.viewportController?.userScroll?.({generation:p.generation,postId:firstKey,offset:0,reason:'title-top'});requestAnimationFrame(()=>{rememberPaneAnchor(p,box);flushReadPosition(p,box)});updateNewButton(el,p)};
  const newBtn=el.querySelector('.newPosts'),candidateToggle=el.querySelector('.notificationCandidates'),notification=el.querySelector('.notificationControl');
  const toggleCandidates=()=>{p.uiState.candidatePanelOpen=!p.uiState.candidatePanelOpen;updateNextCandidateUi(p);schedulePanePosition(p,'candidate-panel');if(p.uiState.candidatePanelOpen&&['','none','error'].includes(p.nextStatus))void maybeAdvanceThread(p,{forceCheck:true});else if(!p.uiState.candidatePanelOpen&&p.liveMode)queueMicrotask(()=>void maybeLiveAutoAdvance(p))};
  const goLatest=()=>{p.follow=true;p.viewIntent='tail';p.viewportController?.followTail?.({generation:p.generation,reason:'latest-button'});p.positionState='following';p.readingAnchor=null;p.newCount=0;settleFollowingViewportForSnapshot(p,box,'latest-button');schedulePanePosition(p,'latest-button');updateNewButton(el,p);if(p.liveMode&&threadCandidateEligible(p))setTimeout(()=>void maybeAdvanceThread(p,{forceCheck:true}),0)};
  newBtn.onclick=()=>{const action=newBtn.dataset.notificationAction;if(action==='candidates')toggleCandidates();else if(action==='retry')void refreshPane(p,true);else goLatest()};candidateToggle.onclick=()=>{if(candidateToggle.dataset.notificationAction==='retry')void refreshPane(p,true);else toggleCandidates()};
  notification.addEventListener('pointerenter',()=>{el.classList.add('newPostsHover');el.classList.remove('composerOpen');schedulePanePosition(p,'notification-hover')});
  notification.addEventListener('pointerleave',()=>{el.classList.remove('newPostsHover');schedulePanePosition(p,'notification-leave')});
  let bottomDebounce=0,scrollbarDrag=false;
  const markUser=(duration=220)=>{
    cancelPendingReadRestore(p);
    p.userIntentRevision=(Number(p.userIntentRevision)||0)+1;
    p.positionEpoch++;
    if(p.positionRaf){cancelAnimationFrame(p.positionRaf);p.positionRaf=0}
    if(p.renderWindowRaf){cancelAnimationFrame(p.renderWindowRaf);p.renderWindowRaf=0}
    lastActivePaneId=p.paneId;readPositionOwnerByThread.set(p.threadId,p.paneId);
    p.userScrollIntent=true;p.positionState='userInteracting';p.stableAnchor=null;p.readingAnchor=null;
    clearTimeout(p.userIntentTimer);
    p.userIntentTimer=setTimeout(()=>{
      if(scrollbarDrag)return;
      p.userScrollIntent=false;
      const anchor=capturePostAnchor(box);
      if(anchor){p.stableAnchor={...anchor,revision:p.userIntentRevision};p.readingAnchor=anchor}
      p.positionState=p.follow?'following':'reading';
      if(p.follow)p.viewportController?.followTail?.({generation:p.generation,reason:'user-bottom'});else if(anchor)p.viewportController?.userScroll?.({generation:p.generation,postId:anchor.key,offset:anchor.offset,reason:'user-scroll'});
      flushDeferredGeometryAfterUser(p,box,'user-settle');rememberPaneAnchor(p,box);scheduleReadPositionSave(p,box);if(p.liveMode)scheduleLiveReevaluation(0);
    },duration)
  };
  box.addEventListener('wheel',e=>{if(Math.abs(e.deltaY)>Math.abs(e.deltaX))markUser(260)},{passive:true});
  box.addEventListener('touchstart',()=>markUser(500),{passive:true});
  box.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')markUser(500);if(e.offsetX>=box.clientWidth-18){scrollbarDrag=true;markUser(60000)}});
  window.addEventListener('pointerup',()=>{if(scrollbarDrag){scrollbarDrag=false;p.userScrollIntent=false;const anchor=capturePostAnchor(box);if(anchor){p.stableAnchor={...anchor,revision:p.userIntentRevision};p.readingAnchor=anchor}p.positionState=p.follow?'following':'reading';if(p.follow)p.viewportController?.followTail?.({generation:p.generation,reason:'scrollbar-bottom'});else if(anchor)p.viewportController?.userScroll?.({generation:p.generation,postId:anchor.key,offset:anchor.offset,reason:'scrollbar'});flushDeferredGeometryAfterUser(p,box,'scrollbar-settle');rememberPaneAnchor(p,box);scheduleReadPositionSave(p,box);if(p.liveMode)scheduleLiveReevaluation(0)}});
  box.addEventListener('keydown',e=>{if(['ArrowUp','PageUp','Home','ArrowDown','PageDown','End',' '].includes(e.key))markUser(320)});
  box.addEventListener('scroll',()=>{
    if(isExpectedPaneScrollWrite(p,box)){scheduleVirtualWindowUpdate(p,box,'programmatic-scroll');return}
    if(!p.userScrollIntent)return;
    const was=p.follow;p.follow=isNearBottom(box);
    if(p.follow){p.viewportController?.followTail?.({generation:p.generation,reason:'user-bottom'});p.positionState='following';p.newCount=0;p.readingAnchor=null;p.stableAnchor=null;if(threadCandidateEligible(p)&&!was){clearTimeout(bottomDebounce);bottomDebounce=setTimeout(()=>void maybeAdvanceThread(p,{forceCheck:true}),120)}}
    else{const anchor=capturePostAnchor(box);p.positionState='reading';p.readingAnchor=anchor;if(anchor){p.stableAnchor={...anchor,revision:p.userIntentRevision};p.viewportController?.userScroll?.({generation:p.generation,postId:anchor.key,offset:anchor.offset,reason:'user-scroll'})}}
    updateNewButton(el,p);rememberPaneAnchor(p,box);scheduleReadPositionSave(p,box);scheduleVirtualWindowUpdate(p,box,'user-scroll')
  });
  if(isWsbPane(p)){bindPositionObserver(p,box);updateWsbStatusBanner(p);return}
  const hotZone=el.querySelector('.composerHotZone');hotZone.addEventListener('pointerenter',()=>{if(!el.classList.contains('newPostsHover')){el.classList.add('composerOpen');schedulePanePosition(p,'composer-open')}});hotZone.addEventListener('pointerleave',()=>{if(!hotZone.querySelector(':focus')){el.classList.remove('composerOpen');schedulePanePosition(p,'composer-close')}});
  const input=el.querySelector('.composerInput'),send=el.querySelector('.composerSend');input.addEventListener('focus',()=>{el.classList.add('composerOpen');schedulePanePosition(p,'composer-focus')});input.addEventListener('blur',()=>setTimeout(()=>{if(!hotZone.matches(':hover')){el.classList.remove('composerOpen');schedulePanePosition(p,'composer-blur')}if(p.liveMode)void maybeLiveAutoAdvance(p)},80));
  const fit=()=>{input.style.height='auto';input.style.height=Math.min(72,Math.max(24,input.scrollHeight))+'px';send.disabled=!input.value.trim();requestAnimationFrame(()=>{const dock=el.querySelector('.composerDock');if(dock)el.style.setProperty('--composer-dock-height',`${Math.ceil(dock.getBoundingClientRect().height)+6}px`);schedulePanePosition(p,'composer-fit')})};fit();
  input.addEventListener('input',()=>{p.draft=input.value;repository.saveDraft(p.threadId,p.draft);scheduleSave();fit();if(p.liveMode&&!p.draft.trim())queueMicrotask(()=>void maybeLiveAutoAdvance(p))});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send.click()}});
  el.querySelector('.composerPlus').onclick=()=>openExternalUrl(p.url);send.onclick=async()=>{if(!input.value.trim())return;try{await navigator.clipboard.writeText(input.value);toast('本文をコピーしました。元スレで投稿してください')}catch{toast('本文を選択してコピーしてください')}openExternalUrl(p.url)};
  bindPositionObserver(p,box)
}


function renderPanes(){
  const grid=$('#grid');
  grid.className=`grid count-${Math.min(Math.max(panes.length,1),9)}`;
  const wanted=new Set(panes.map(p=>p.paneId));
  grid.querySelectorAll('.pane').forEach(el=>{if(!wanted.has(el.dataset.paneId))el.remove()});
  grid.querySelector('.splash')?.remove();
  if(!panes.length){
    if(!grid.querySelector('.splash'))grid.innerHTML='<div class="splash"><div><strong>メニューから板を選んでスレッドを開く</strong><br>通常時はスレッド表示を最大化します。</div></div>';
    return;
  }
  for(const p of panes){
    if(paneElement(p))continue;
    const tpl=document.createElement('template');
    tpl.innerHTML=paneShellHtml(p);
    grid.appendChild(tpl.content.firstElementChild);
  }
  panes.forEach((p,i)=>{const el=paneElement(p);if(el)el.style.order=String(i)});
  for(const p of panes){
    const el=paneElement(p);if(!el)continue;
    try{
      bindPaneShell(el,p);
      const title=el.querySelector('.paneTitleBtn');
      if(title){title.textContent=p.kind==='board'?(boardOf(p.board)?.name||p.board):(p.title||'Loading…');title.setAttribute('aria-label',title.textContent||'')}
      if(p.kind==='board'){renderBoardPane(p);continue}
      updatePaneStatus(el,p);updateHistoryButtons(el,p);updateLiveButton(el,p);
      if(p.posts.length&&!el.querySelector('.post'))paintInitial(el,p);
      updateNextCandidateUi(p);if(isWsbPane(p))updateWsbStatusBanner(p);schedulePanePosition(p,'render-panes');
    }catch(error){
      console.error('[LiveBoard pane render error]',{paneId:p.paneId,kind:p.kind,error});
      const target=p.kind==='board'?el.querySelector('.boardPaneList'):el.querySelector('.postsContent');
      if(target)target.innerHTML=`<div class="error">表示エラー<br>${esc(error?.message||String(error))}<br><button class="retryPaneRender">再試行</button></div>`;
      target?.querySelector('.retryPaneRender')?.addEventListener('click',()=>renderPanes());
    }
  }
  hydratePreviews(grid);layoutGrid();
}

function layoutGrid(){const grid=$('#grid');const n=Math.max(1,panes.length),w=grid.clientWidth||innerWidth;const cols=n===1?1:w<640?1:w<1200?Math.min(2,n):Math.min(n>=5?3:2,n);const rows=Math.ceil(n/cols);grid.style.setProperty('--cols',cols);grid.style.setProperty('--rows',rows);grid.classList.toggle('scrollWorkspace',rows*300>Math.max(300,grid.clientHeight))}

const VIRTUAL_WINDOW_SIZE=180,VIRTUAL_WINDOW_EDGE=36,VIRTUAL_DEFAULT_HEIGHT=64;
function postsContent(box){return box?.querySelector?.('.postsContent')||box}
function updateTailVisibility(p,box){const nodes=[...postsContent(box).querySelectorAll('.post')];for(const n of nodes)n.classList.remove('tailVisible');for(const n of nodes.slice(-3))n.classList.add('tailVisible')}
function updatePaneBottomPadding(p){const el=paneElement(p),box=el?.querySelector('.posts');if(!el||!box)return;let pad=8;const candidate=el.querySelector('.nextCandidates:not([hidden])');const notice=el.querySelector('.notificationControl:not([hidden])');const dock=el.classList.contains('composerOpen')?el.querySelector('.composerDock'):null;if(candidate)pad+=candidate.getBoundingClientRect().height+8;if(notice)pad+=notice.getBoundingClientRect().height+8;if(dock)pad+=dock.getBoundingClientRect().height+8;box.style.setProperty('--pane-bottom-pad',`${Math.ceil(pad)}px`)}

function resetRenderSessionState(p){
  if(!p)return;
  if(p.renderTimer)cancelAnimationFrame(p.renderTimer);
  if(p.renderWindowRaf)cancelAnimationFrame(p.renderWindowRaf);
  if(p.positionRaf)cancelAnimationFrame(p.positionRaf);
  p.renderTimer=0;p.renderWindowRaf=0;p.positionRaf=0;
  p.renderWindowStart=0;p.renderWindowEnd=0;p.domMap=new Map();
  p.heightCache=new Map();p.heightEstimate=VIRTUAL_DEFAULT_HEIGHT;p.heightCacheWidth=0;p.heightCacheFontKey='';
  p.postIndexByKey=new Map();p.layoutSignatureByKey=new Map();p.baseGeometrySignatureByKey=new Map();p.layoutRevisionByKey=new Map();p.layoutRevisionSeq=0;
  p.analysisSignatureByKey=new Map();p.analysisRevisionByKey=new Map();p.analysisRevisionSeq=0;
  p.geometryMeasurementStore=p.geometryMeasurementStore instanceof Map?p.geometryMeasurementStore:new Map();p.geometryContextByThread=p.geometryContextByThread instanceof Map?p.geometryContextByThread:new Map();p.geometryTransactionSeq=Number(p.geometryTransactionSeq)||0;
  p.heightMeasurementTrace=[];p.pendingGeometryRevision=-1;p.pendingGeometryReason='';p.geometryFlushRaf=0;
  p.virtualLayout=createVirtualLayoutAdapter({defaultHeight:VIRTUAL_DEFAULT_HEIGHT});
  if(!p.navigationCoordinator)p.navigationCoordinator=createNavigationCoordinator({initialGeneration:Number(p.generation)||0,context:{paneId:p.paneId},diagnostic:e=>{if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard R5 nav]',e)}});
  const legacyViewport=normalizeLegacyViewportState({follow:p.follow,viewIntent:p.viewIntent,anchorPostId:p.anchorPostId,anchorOffset:p.anchorOffset,source:p.viewIntent==='restore'?'restore':''});
  p.viewportController=createViewportController({generation:Number(p.generation)||0,initial:legacyViewport,context:{paneId:p.paneId,threadId:p.threadId},diagnostic:e=>{if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard R5 viewport]',e)}});
  if(legacyViewport.mode==='restoring'&&legacyViewport.anchorPostId)p.viewportController.startRestore({generation:Number(p.generation)||0,postId:legacyViewport.anchorPostId,offset:legacyViewport.anchorOffset,deadlineMs:2000,reason:'session-restore'});
  const viewportState=p.viewportController.snapshot();p.follow=viewportState.mode==='following';p.viewIntent=viewportState.mode==='following'?'tail':viewportState.mode==='restoring'?'restore':p.viewIntent;
  p.positionWrite=null;p.positionState=viewportState.mode;p.stableAnchor=null;p.readingAnchor=null;
  p.positionRetry=0;
}
function postKeyAt(p,index){const post=p?.posts?.[index];return post?String(post.key||`${p.board}-${post.n}`):''}
function syncPostLayoutMetadata(p){
  if(!p)return;
  const posts=p.posts||[],oldGeomSig=p.layoutSignatureByKey instanceof Map?p.layoutSignatureByKey:new Map(),oldBaseSig=p.baseGeometrySignatureByKey instanceof Map?p.baseGeometrySignatureByKey:new Map(),oldGeomRev=p.layoutRevisionByKey instanceof Map?p.layoutRevisionByKey:new Map(),oldAnalysisSig=p.analysisSignatureByKey instanceof Map?p.analysisSignatureByKey:new Map(),oldAnalysisRev=p.analysisRevisionByKey instanceof Map?p.analysisRevisionByKey:new Map(),nextGeomSig=new Map(),nextBaseSig=new Map(),nextGeomRev=new Map(),nextAnalysisSig=new Map(),nextAnalysisRev=new Map(),nextIndex=new Map(),carryForward=[];
  let geomSeq=Number(p.layoutRevisionSeq)||0,analysisSeq=Number(p.analysisRevisionSeq)||0;
  for(let i=0;i<posts.length;i++){
    const post=posts[i],key=postKeyAt(p,i),baseSig=postBaseGeometrySignature(post),geomSig=postGeometrySignature(post),analysisSig=postAnalysisSignature(post);nextIndex.set(key,i);nextBaseSig.set(key,baseSig);nextGeomSig.set(key,geomSig);nextAnalysisSig.set(key,analysisSig);
    if(oldGeomSig.get(key)===geomSig&&oldGeomRev.has(key))nextGeomRev.set(key,oldGeomRev.get(key));else{nextGeomRev.set(key,`g${++geomSeq}`);if(oldBaseSig.get(key)===baseSig){const rec=p.heightCache?.get?.(key);if(rec?.height>0)carryForward.push([key,rec])}}
    if(oldAnalysisSig.get(key)===analysisSig&&oldAnalysisRev.has(key))nextAnalysisRev.set(key,oldAnalysisRev.get(key));else nextAnalysisRev.set(key,`a${++analysisSeq}`);
  }
  p.layoutSignatureByKey=nextGeomSig;p.baseGeometrySignatureByKey=nextBaseSig;p.layoutRevisionByKey=nextGeomRev;p.analysisSignatureByKey=nextAnalysisSig;p.analysisRevisionByKey=nextAnalysisRev;p.postIndexByKey=nextIndex;p.layoutRevisionSeq=geomSeq;p.analysisRevisionSeq=analysisSeq;
  for(const [key,rec] of carryForward){const index=nextIndex.get(key);if(index==null)continue;p.virtualLayout?.measure?.(key,rec.height,{width:rec.width||p.heightCacheWidth,fontKey:rec.fontKey||p.heightCacheFontKey,revision:nextGeomRev.get(key)})}
}
function ensurePostLayoutMetadata(p){if(!(p?.postIndexByKey instanceof Map)||p.postIndexByKey.size!==(p?.posts?.length||0))syncPostLayoutMetadata(p)}
function postIndexForKey(p,key){if(!key)return -1;ensurePostLayoutMetadata(p);const index=p.postIndexByKey.get(String(key));return Number.isInteger(index)?index:-1}
function postLayoutRevision(p,index){ensurePostLayoutMetadata(p);return p.layoutRevisionByKey.get(postKeyAt(p,index))||''}
function layoutMetaForIndex(p,index){return {width:p.heightCacheWidth,fontKey:p.heightCacheFontKey,revision:postLayoutRevision(p,index)}}
function fontLayoutKey(box){const sample=postsContent(box)?.querySelector?.('.postBody');if(!sample)return '';const cs=getComputedStyle(sample);return `${cs.fontFamily}|${cs.fontSize}|${cs.lineHeight}|${cs.fontWeight}`}
function geometryThreadId(p){return String(p?.threadId||p?.url||'')}
function geometryThreadMeasurements(p,create=false){if(!(p?.geometryMeasurementStore instanceof Map))p.geometryMeasurementStore=new Map();const threadId=geometryThreadId(p);if(!threadId)return null;let rows=p.geometryMeasurementStore.get(threadId);if(!rows&&create){rows=new Map();p.geometryMeasurementStore.set(threadId,rows)}return rows||null}
function geometryContextForThread(p){return p?.geometryContextByThread instanceof Map?p.geometryContextByThread.get(geometryThreadId(p))||null:null}
function rememberGeometryMeasurement(p,key,{height,width,fontKey,geometrySignature}){const rows=geometryThreadMeasurements(p,true);if(!rows)return;rows.set(String(key),{height:Number(height)||0,width:Number(width)||0,fontKey:String(fontKey||''),geometrySignature:String(geometrySignature||'')});while(rows.size>5000)rows.delete(rows.keys().next().value)}
function restoreGeometryMeasurements(p,width,fontKey){const rows=geometryThreadMeasurements(p,false),restored=new Set();if(!rows||!p?.virtualLayout)return restored;ensurePostLayoutMetadata(p);for(let i=0;i<(p.posts?.length||0);i++){const key=postKeyAt(p,i),rec=rows.get(key);if(!rec||rec.height<=0)continue;if(width&&rec.width&&Math.abs(rec.width-width)>1)continue;if(fontKey&&rec.fontKey&&rec.fontKey!==fontKey)continue;if(rec.geometrySignature!==p.layoutSignatureByKey.get(key))continue;p.virtualLayout.measure(key,rec.height,{width:width||rec.width,fontKey:fontKey||rec.fontKey,revision:postLayoutRevision(p,i)});restored.add(key)}return restored}
function prepareGeometryContext(p,box){const width=Math.round((box?.clientWidth||0)*100)/100,renderedFont=fontLayoutKey(box),saved=geometryContextForThread(p),fontKey=renderedFont||(saved&&(!width||!saved.width||Math.abs(saved.width-width)<=1)?saved.fontKey:'')||p.heightCacheFontKey||'';p.heightCacheWidth=width;p.heightCacheFontKey=fontKey;p.virtualLayout?.reset?.({keys:p.posts.map((_,i)=>postKeyAt(p,i)),layoutWidth:width,font:fontKey,contentRevision:String(p.layoutRevisionSeq||0)});const restored=restoreGeometryMeasurements(p,width,fontKey);return {width,fontKey,restored}}
function estimatedPostHeight(p,index){const key=postKeyAt(p,index);return p.virtualLayout?.estimate?.(key,layoutMetaForIndex(p,index))??VIRTUAL_DEFAULT_HEIGHT}
function estimatedOffsetForIndex(p,index){ensurePostLayoutMetadata(p);return p.virtualLayout?.offset?.(Math.min(Math.max(0,Number(index)||0),p?.posts?.length||0),i=>layoutMetaForIndex(p,i))??0}
function estimatedTotalHeight(p){ensurePostLayoutMetadata(p);return p.virtualLayout?.total?.(i=>layoutMetaForIndex(p,i))??0}
function indexAtEstimatedOffset(p,offset){const n=p?.posts?.length||0;if(!n)return 0;ensurePostLayoutMetadata(p);return p.virtualLayout?.indexAt?.(offset,i=>layoutMetaForIndex(p,i))??0}
function virtualWindowForIndex(p,index,{size=VIRTUAL_WINDOW_SIZE}={}){const n=p?.posts?.length||0;if(!n)return [0,0];const count=Math.min(n,Math.max(80,Number(p.renderWindowSize)||size)),before=Math.floor(count*.42);let start=Math.max(0,Math.min(n-count,Math.max(0,index-before)));return [start,Math.min(n,start+count)]}
function virtualSpacer(content,edge){return content?.querySelector?.(`.virtualSpacer[data-edge="${edge}"]`)||null}
function outerBlockMeasurement(node){
  if(!node)return {height:0,nodeHeight:0,separatorHeight:0};
  const r=node.getBoundingClientRect(),cs=getComputedStyle(node),margin=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0),prev=node.previousElementSibling,sep=prev?.classList?.contains('dateSeparator')?prev.getBoundingClientRect().height:0;
  return {height:r.height+margin+sep,nodeHeight:r.height,separatorHeight:sep};
}
function mediaGeometryPending(node){
  if(!node)return false;if(node.querySelector('.previewLoading'))return true;
  for(const img of node.querySelectorAll('.attachment img,.previewThumb')){
    const wrap=img.closest?.('.attachmentWrap'),state=String(wrap?.dataset?.mediaState||'');
    if(state==='error'||state==='timedOut')continue;
    if(state==='loading')return true;
    if(!img.complete)return true;
    // complete + naturalWidth=0 is a terminal browser failure even if the error
    // handler has not run yet; never keep height reservation pending forever.
    if(img.naturalWidth<=0)continue;
  }
  for(const video of node.querySelectorAll('video.previewVideoThumb'))if(video.dataset.videoState!=='ready'&&video.dataset.videoState!=='error')return true;
  return false;
}
function setSpacerHeight(node,value){if(!node)return;const next=Math.max(0,Math.round((Number(value)||0)*100)/100),prev=parseFloat(node.style.height)||0;if(Math.abs(prev-next)>.25)node.style.height=`${next}px`}
function updateVirtualSpacers(p,content){if(!content)return;setSpacerHeight(virtualSpacer(content,'top'),estimatedOffsetForIndex(p,p.renderWindowStart));setSpacerHeight(virtualSpacer(content,'bottom'),Math.max(0,estimatedTotalHeight(p)-estimatedOffsetForIndex(p,p.renderWindowEnd)))}
function classifyHeightMeasurement(reason,{cached=false,pendingMedia=false,reused=false,delta=0}={}){
  if(reused)return 'remount-cache-reuse';if(/image|video|preview|media/i.test(String(reason)))return 'media-geometry';if(/resize/i.test(String(reason)))return 'resize-observer';if(cached&&Math.abs(delta)<=.25)return 'stable-remeasure';if(pendingMedia)return 'pending-media';return 'layout-measure';
}
function recordHeightMeasurementBatch(p,box,reason,rows,totalBefore,totalAfter){
  if(!p||!box)return;const anchor=capturePostAnchor(box),content=postsContent(box),entry={at:Math.round(performance.now()*10)/10,reason:String(reason||'measure'),revision:Number(p.userIntentRevision)||0,geometryRevision:Number(p.layoutRevisionSeq)||0,analysisRevision:Number(p.analysisRevisionSeq)||0,state:p.positionState,totalBefore:Math.round(totalBefore*100)/100,totalAfter:Math.round(totalAfter*100)/100,scrollTop:Math.round(box.scrollTop*100)/100,anchorKey:anchor?.key||'',anchorOffset:anchor?Math.round(anchor.offset*100)/100:null,topSpacer:Math.round((parseFloat(virtualSpacer(content,'top')?.style?.height)||0)*100)/100,bottomSpacer:Math.round((parseFloat(virtualSpacer(content,'bottom')?.style?.height)||0)*100)/100,rows};
  p.heightMeasurementTrace=Array.isArray(p.heightMeasurementTrace)?p.heightMeasurementTrace:[];const diagnosticRows=rows.filter(r=>r.classification!=='stable-remeasure'||Math.abs((r.measured||0)-(r.effective||0))>.5);entry.measuredCount=rows.length;entry.rows=(diagnosticRows.length?diagnosticRows:rows.slice(0,8)).slice(0,32);p.heightMeasurementTrace.push(entry);if(p.heightMeasurementTrace.length>96)p.heightMeasurementTrace.splice(0,p.heightMeasurementTrace.length-96);if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard height]',entry)
}
function measureVirtualWindow(p,box,reason='measure'){
  if(!p||!box)return null;ensurePostLayoutMetadata(p);const content=postsContent(box),ctx=prepareGeometryContext(p,box),{width,fontKey,restored}=ctx;
  if(!(p.geometryContextByThread instanceof Map))p.geometryContextByThread=new Map();if(geometryThreadId(p))p.geometryContextByThread.set(geometryThreadId(p),{width,fontKey});
  const totalBefore=estimatedTotalHeight(p),rows=[];
  for(const node of content?.querySelectorAll?.('.post')||[]){
    const key=String(node.dataset.key||'');if(!key)continue;const index=postIndexForKey(p,key);if(index<0)continue;const meta=layoutMetaForIndex(p,index),cached=p.virtualLayout?.measurement?.(key,meta)||null,pendingMedia=mediaGeometryPending(node),restoredFromStore=restored.has(key);
    if(node.dataset.heightCacheReserved==='1'&&!pendingMedia){node.style.minHeight='';delete node.dataset.heightCacheReserved}
    const measured=outerBlockMeasurement(node);if(!(measured.height>0))continue;let effective=measured.height,reused=false;
    if(cached&&pendingMedia&&cached.height>measured.height+.5){const delta=cached.height-measured.height;node.style.minHeight=`${Math.max(0,measured.nodeHeight+delta)}px`;node.dataset.heightCacheReserved='1';effective=cached.height;reused=true}
    else if(node.dataset.heightCacheReserved==='1'&&pendingMedia&&cached&&measured.height>=cached.height-.5){effective=Math.max(measured.height,cached.height)}
    p.heightCache.set(key,{height:effective,width,fontKey,version:meta.revision});p.virtualLayout?.measure?.(key,effective,meta);rememberGeometryMeasurement(p,key,{height:effective,width,fontKey,geometrySignature:p.layoutSignatureByKey.get(key)});
    rows.push({key,geometryRevision:meta.revision,analysisRevision:p.analysisRevisionByKey?.get?.(key)||'',estimated:Math.round((cached?.height??VIRTUAL_DEFAULT_HEIGHT)*100)/100,measured:Math.round(measured.height*100)/100,effective:Math.round(effective*100)/100,classification:restoredFromStore&&!pendingMedia?'remount-cache-reuse':classifyHeightMeasurement(reason,{cached:!!cached,pendingMedia,reused,delta:effective-(cached?.height??VIRTUAL_DEFAULT_HEIGHT)})})
  }
  updateVirtualSpacers(p,content);const totalAfter=estimatedTotalHeight(p);recordHeightMeasurementBatch(p,box,reason,rows,totalBefore,totalAfter);return {totalBefore,totalAfter,rows,width,fontKey,restoredCount:restored.size}
}
function runGeometryTransaction(p,box,reason,{anchor=null,mode=null}={}){
  if(!p||!box||p.disposed)return false;const revision=Number(p.userIntentRevision)||0,effectiveMode=mode||p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading');
  if(p.userScrollIntent){p.pendingGeometryRevision=revision;p.pendingGeometryReason=String(reason||'geometry');recordHeightControlEvent(p,box,'geometry-deferred-during-user',{requestedReason:String(reason||'geometry')});return false}
  const stableAnchor=anchor||(effectiveMode==='reading'?capturePostAnchor(box):null),transactionId=++p.geometryTransactionSeq;measureVirtualWindow(p,box,`${reason}:tx${transactionId}`);
  if(revision!==p.userIntentRevision||p.userScrollIntent){recordHeightControlEvent(p,box,'geometry-transaction-stale',{transactionId,requestedReason:String(reason||'geometry'),attemptedRevision:revision});return false}
  let corrected=false;if(effectiveMode==='following')corrected=writePaneScrollTop(p,box,Math.max(0,box.scrollHeight-box.clientHeight),`${reason}:tx${transactionId}:tail`,revision);else if(effectiveMode==='reading'&&stableAnchor)corrected=restorePostAnchor(box,stableAnchor,p,`${reason}:tx${transactionId}:anchor`,revision);
  positionTrace(p,box,`${reason}:geometry-transaction`,{transactionId,geometryRevision:Number(p.layoutRevisionSeq)||0,analysisRevision:Number(p.analysisRevisionSeq)||0,corrected});return true
}
function recordHeightControlEvent(p,box,reason,detail={}){
  if(!p||!box)return;const total=estimatedTotalHeight(p),anchor=p.stableAnchor?.revision===p.userIntentRevision?p.stableAnchor:p.readingAnchor,entry={at:Math.round(performance.now()*10)/10,reason:String(reason||'control'),revision:Number(p.userIntentRevision)||0,geometryRevision:Number(p.layoutRevisionSeq)||0,analysisRevision:Number(p.analysisRevisionSeq)||0,state:p.positionState,totalBefore:Math.round(total*100)/100,totalAfter:Math.round(total*100)/100,scrollTop:Math.round(box.scrollTop*100)/100,anchorKey:anchor?.key||'',anchorOffset:anchor?Math.round((Number(anchor.offset)||0)*100)/100:null,measuredCount:0,rows:[],...detail};
  p.heightMeasurementTrace=Array.isArray(p.heightMeasurementTrace)?p.heightMeasurementTrace:[];p.heightMeasurementTrace.push(entry);if(p.heightMeasurementTrace.length>48)p.heightMeasurementTrace.splice(0,p.heightMeasurementTrace.length-48);if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard height control]',entry)
}
function writePaneScrollTop(p,box,value,reason='program',revision=p?.userIntentRevision){
  if(!p||!box)return false;if(Number(revision)!==(Number(p.userIntentRevision)||0)){recordHeightControlEvent(p,box,'stale-correction-rejected',{attemptedRevision:Number(revision)||0,requestedReason:String(reason||'program')});if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard stale position write]',{reason,revision,current:p.userIntentRevision});return false}const top=Math.max(0,Number(value)||0),nextRevision=(Number(p.positionWriteRevision)||0)+1;p.positionWriteRevision=nextRevision;
  p.positionWrite={writeRevision:nextRevision,userRevision:Number(revision)||0,expectedTop:top,reason,expiresAt:performance.now()+160};
  p.applyingScroll=true;box.scrollTop=top;p.applyingScroll=false;return true
}
function isExpectedPaneScrollWrite(p,box){
  const w=p?.positionWrite;if(!w||!box)return false;if(performance.now()>Number(w.expiresAt||0)){p.positionWrite=null;return false}
  if(Math.abs(box.scrollTop-Number(w.expectedTop||0))<=1.5){p.positionWrite=null;return true}return false
}
function positionTrace(p,box,reason,extra={}){
  if(!p||!box)return;const anchor=capturePostAnchor(box),content=postsContent(box),entry={at:Math.round(performance.now()*10)/10,reason,state:p.positionState,revision:p.userIntentRevision,geometryRevision:Number(p.layoutRevisionSeq)||0,analysisRevision:Number(p.analysisRevisionSeq)||0,anchor:anchor?.key||'',offset:anchor?Math.round(anchor.offset*10)/10:null,scrollTop:Math.round(box.scrollTop*10)/10,topSpacer:Math.round((parseFloat(virtualSpacer(content,'top')?.style?.height)||0)*10)/10,bottomSpacer:Math.round((parseFloat(virtualSpacer(content,'bottom')?.style?.height)||0)*10)/10,window:[p.renderWindowStart,p.renderWindowEnd],dom:content.querySelectorAll('.post').length,...extra};
  p.positionTrace=Array.isArray(p.positionTrace)?p.positionTrace:[];p.positionTrace.push(entry);if(p.positionTrace.length>120)p.positionTrace.splice(0,p.positionTrace.length-120);if(globalThis.__LIVEBOARD_DEBUG__)console.debug('[LiveBoard position]',entry)
}
function makePostNode(p,post){const tpl=document.createElement('template');tpl.innerHTML=postHtml(p,post,false);return tpl.content.firstElementChild}
function renderVirtualWindow(p,box,start,end,{anchor=null,reason='window',revision=p?.userIntentRevision,force=false,replaceKeys=null}={}){
  if(!p||!box||p.disposed)return false;const content=postsContent(box),n=p.posts.length;
  start=Math.max(0,Math.min(n,Number(start)||0));end=Math.max(start,Math.min(n,Number(end)||0));
  if(!force&&start===p.renderWindowStart&&end===p.renderWindowEnd&&content.querySelector('.post'))return false;
  const rev=Number(revision)||0;if(rev!==p.userIntentRevision)return false;
  const previousMap=p.domMap instanceof Map?p.domMap:new Map(),frag=document.createDocumentFragment(),top=document.createElement('div'),bottom=document.createElement('div');
  top.className='virtualSpacer virtualSpacerTop';top.dataset.edge='top';top.setAttribute('aria-hidden','true');bottom.className='virtualSpacer virtualSpacerBottom';bottom.dataset.edge='bottom';bottom.setAttribute('aria-hidden','true');
  ensurePostLayoutMetadata(p);prepareGeometryContext(p,box);const planned=p.virtualLayout?.spacers?.(start,end,i=>layoutMetaForIndex(p,i))||{top:estimatedOffsetForIndex(p,start),bottom:Math.max(0,estimatedTotalHeight(p)-estimatedOffsetForIndex(p,end))};setSpacerHeight(top,planned.top);setSpacerHeight(bottom,planned.bottom);frag.appendChild(top);
  for(let i=start;i<end;i++){const post=p.posts[i],key=postKeyAt(p,i);let node=replaceKeys?.has?.(key)?null:previousMap.get(key);if(!node||node.dataset.postNo!==String(post.n||''))node=makePostNode(p,post);frag.appendChild(node)}
  frag.appendChild(bottom);content.replaceChildren(frag);p.renderWindowStart=start;p.renderWindowEnd=end;
  reconcileDateSeparators(p,box);rebuildDomMap(p,content);hydratePreviews(content);updateTailVisibility(p,box);measureVirtualWindow(p,box,reason);
  if(anchor&&rev===p.userIntentRevision)restorePostAnchor(box,anchor,p,`${reason}-anchor`,rev);
  const current=capturePostAnchor(box);if(current&&!p.follow&&rev===p.userIntentRevision){p.readingAnchor=current;p.stableAnchor={...current,revision:rev}}
  positionTrace(p,box,reason,{published:content.style.visibility!=='hidden'});return true
}
function virtualAnchorForScrollPosition(p,box){
  const index=indexAtEstimatedOffset(p,box.scrollTop),key=postKeyAt(p,index);if(!key)return null;
  return {key,offset:estimatedOffsetForIndex(p,index)-box.scrollTop}
}
function ensureVirtualWindowForViewport(p,box,reason='scroll'){
  if(!p||!box||p.disposed||!p.posts.length)return;
  const revision=Number(p.userIntentRevision)||0,current=capturePostAnchor(box);let index=current?postIndexForKey(p,current.key):-1,anchor=current;
  if(index<0){anchor=virtualAnchorForScrollPosition(p,box);index=anchor?postIndexForKey(p,anchor.key):0}
  const nearEdge=index<p.renderWindowStart+VIRTUAL_WINDOW_EDGE||index>=p.renderWindowEnd-VIRTUAL_WINDOW_EDGE||!postsContent(box).querySelector('.post');
  if(!nearEdge)return;
  const [start,end]=virtualWindowForIndex(p,index);renderVirtualWindow(p,box,start,end,{anchor,reason,revision})
}
function scheduleVirtualWindowUpdate(p,box,reason='scroll'){
  if(!p||!box||p.disposed)return;const revision=Number(p.userIntentRevision)||0;if(p.renderWindowRaf)cancelAnimationFrame(p.renderWindowRaf);
  p.renderWindowRaf=requestAnimationFrame(()=>{p.renderWindowRaf=0;if(p.disposed||revision!==p.userIntentRevision||!box.isConnected)return;ensureVirtualWindowForViewport(p,box,reason)})
}
function schedulePanePosition(p,reason='layout'){
  if(!p||p.disposed)return;const el=paneElement(p),box=el?.querySelector('.posts');if(!box)return;
  if(p.readRestorePending&&!p.userScrollIntent&&finishPendingReadRestore(p,box))return;
  updatePaneBottomPadding(p);const epoch=++p.positionEpoch,revision=Number(p.userIntentRevision)||0;if(p.positionRaf)cancelAnimationFrame(p.positionRaf);
  p.positionRaf=requestAnimationFrame(()=>{
    p.positionRaf=0;if(p.disposed||epoch!==p.positionEpoch||revision!==p.userIntentRevision||!paneElement(p))return;
    const mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading');
    if(mode==='following'){
      p.follow=true;p.positionState='following';const [start,end]=virtualWindowForIndex(p,Math.max(0,p.posts.length-1));renderVirtualWindow(p,box,start,end,{reason:`${reason}-tail-window`,revision});
      writePaneScrollTop(p,box,Math.max(0,box.scrollHeight-box.clientHeight),reason,revision);p.newCount=0;updateNewButton(el,p);updateTailVisibility(p,box)
    }else if(mode==='loading'&&p.viewIntent==='top'&&!p.initialized){
      p.positionState='restoring';writePaneScrollTop(p,box,0,reason,revision)
    }else if(mode==='restoring'&&!p.userScrollIntent){
      p.positionState='restoring';if(!restorePersistedPaneAnchor(p,box)&&p.readRestorePending)finishPendingReadRestore(p,box)
    }else if(mode==='reading'&&!p.userScrollIntent&&p.stableAnchor?.revision===revision){
      p.positionState='reading';const anchor={key:p.stableAnchor.key,offset:p.stableAnchor.offset};runGeometryTransaction(p,box,reason,{anchor,mode:'reading'})
    }
    positionTrace(p,box,reason);
    if(p.follow){const gap=box.scrollHeight-box.scrollTop-box.clientHeight;if(gap>2&&p.positionRetry<2){p.positionRetry++;schedulePanePosition(p,'settle')}else{p.positionRetry=0;if(gap<=2&&p.liveMode)queueMicrotask(()=>void maybeLiveAutoAdvance(p))}}
  })
}
function flushDeferredGeometryAfterUser(p,box,reason='user-settle'){
  if(!p||!box||p.disposed||p.userScrollIntent||p.pendingGeometryRevision<0)return false;const revision=Number(p.userIntentRevision)||0,mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading'),anchor=mode==='reading'?capturePostAnchor(box):null,pendingReason=String(p.pendingGeometryReason||'');
  p.pendingGeometryRevision=-1;p.pendingGeometryReason='';
  if(revision!==p.userIntentRevision)return false;
  return runGeometryTransaction(p,box,pendingReason?`${reason}:${pendingReason}`:reason,{anchor,mode})
}
function bindPositionObserver(p,box){
  p.positionObserver?.disconnect?.();if(!('ResizeObserver' in window))return;const content=postsContent(box),generation=Number(p.generation)||0;
  p.positionObserver=new ResizeObserver(()=>{
    if(p.disposed||generation!==(Number(p.generation)||0)||!box.isConnected)return;
    if(p.userScrollIntent){p.pendingGeometryRevision=Number(p.userIntentRevision)||0;p.pendingGeometryReason='resize-during-user';return}
    const revision=Number(p.userIntentRevision)||0,width=Math.round((box.clientWidth||0)*100)/100,widthChanged=!!p.heightCacheWidth&&Math.abs(width-p.heightCacheWidth)>1;
    const fontKey=fontLayoutKey(box),fontChanged=!!p.heightCacheFontKey&&fontKey!==p.heightCacheFontKey,mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading');
    if(widthChanged||fontChanged){p.heightCacheWidth=width;p.heightCacheFontKey=fontKey;p.virtualLayout?.invalidateGeometry?.({layoutWidth:width,font:fontKey})}
    if(mode==='following'){measureVirtualWindow(p,box,widthChanged||fontChanged?'resize-geometry-following':'resize-following');schedulePanePosition(p,'resize-following');return}
    if(mode==='restoring'){measureVirtualWindow(p,box,widthChanged||fontChanged?'resize-geometry-restoring':'resize-restoring');if(p.readRestorePending)finishPendingReadRestore(p,box);else restorePersistedPaneAnchor(p,box);return}
    const anchor=p.stableAnchor?.revision===revision?{key:p.stableAnchor.key,offset:p.stableAnchor.offset}:capturePostAnchor(box);
    if(widthChanged||fontChanged)renderVirtualWindow(p,box,p.renderWindowStart,p.renderWindowEnd,{anchor,reason:'resize-width',revision,force:true});
    else runGeometryTransaction(p,box,'resize-observer',{anchor,mode})
  });
  p.positionObserver.observe(content);p.positionObserver.observe(box)
}
function preparePostsForFastPaint(p,incoming=[]){
  const posts=incoming.map((x,i)=>({...x,n:String(x.n||x.postNo||i+1),quoteTargets:[],quoteLineTargets:{},backrefs:[],related:[],quoteComponentSize:1}));
  p.posts=posts;p.postMap=new Map(posts.map(x=>[String(x.n),x]));p.quoteComponentByPost=new Map();syncPostLayoutMetadata(p);return posts;
}
function patchPostAnalysisUi(p,node,post){
  if(!node||!post)return;const plan=post.deleted?null:mediaDisplayPlan(post),body=node.querySelector('.postBody');
  if(body&&!post.deleted){const html=renderBody(post,plan);if(body.innerHTML!==html)body.innerHTML=html}
  const currentSide=node.querySelector('.postSide'),tpl=document.createElement('template');tpl.innerHTML=sideMetaHtml(p,post);const nextSide=tpl.content.firstElementChild;if(currentSide&&nextSide)currentSide.replaceWith(nextSide)
}
function scheduleQuoteAnalysis(p){
  const epoch=++p.analysisEpoch,generation=p.generation,source=p.posts.map(x=>({...x,quoteTargets:[],quoteLineTargets:{},backrefs:[],related:[]}));
  p.analysisPending=true;const byNo=new Map(source.map(x=>[String(x.n),x])),seen=new Set(),quoteIndex=quoteIndexState();let i=0,phase=0,backrefIndex=0;
  const valid=()=>!p.disposed&&panes.includes(p)&&epoch===p.analysisEpoch&&generation===p.generation;
  const finishInvalid=()=>{if(epoch===p.analysisEpoch&&generation===p.generation)p.analysisPending=false};
  const step=()=>{
    if(!valid()){finishInvalid();return}
    const began=performance.now();let count=0;
    if(phase===0){while(i<source.length&&count<100&&performance.now()-began<8){const post=source[i++];annotateOnePost(p.board,post,byNo,seen,quoteIndex);count++}if(i>=source.length)phase=1}
    if(phase===1&&performance.now()-began<8){while(backrefIndex<source.length&&count<200&&performance.now()-began<8){const post=source[backrefIndex++];for(const target of post.quoteTargets||[]){const t=byNo.get(String(target));if(t&&!t.backrefs.includes(post.n))t.backrefs.push(post.n)}count++}if(backrefIndex>=source.length){for(const post of source)post.related=[...new Set([...(post.quoteTargets||[]),...(post.backrefs||[])])];phase=2}}
    if(phase<2){requestAnimationFrame(step);return}if(!valid()){finishInvalid();return}
    const componentIndex=buildQuoteComponentIndex(source,byNo),box=paneElement(p)?.querySelector('.posts'),revision=Number(p.userIntentRevision)||0,anchor=!p.follow?capturePostAnchor(box):null;p.posts=source;p.postMap=byNo;p.quoteComponentByPost=componentIndex;p.analysisPending=false;syncPostLayoutMetadata(p);
    if(box){for(const [key,node] of [...p.domMap]){const post=byNo.get(String(node.dataset.postNo||''))||source.find(x=>String(x.key)===String(key));if(post)patchPostAnalysisUi(p,node,post)}reconcileDateSeparators(p,box);runGeometryTransaction(p,box,'quote-analysis',{anchor,mode:p.follow?'following':'reading'});hydratePreviews(box);updateTailVisibility(p,box);const now=capturePostAnchor(box);if(now&&!p.follow){p.readingAnchor=now;p.stableAnchor={...now,revision}}}
    updateNextCandidateUi(p);if(p.pendingMerge&&!p.renderTimer){const pending=p.pendingMerge;p.pendingMerge=null;mergeIntoPane(paneElement(p),p,pending.incoming,false,pending.complete)}
  };requestAnimationFrame(step)
}
function initialRenderRange(p){const anchorIndex=p.anchorPostId?postIndexForKey(p,p.anchorPostId):-1,mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':p.viewIntent==='restore'?'restoring':'reading');if(mode==='restoring'&&anchorIndex>=0)return virtualWindowForIndex(p,anchorIndex);if(mode==='following')return virtualWindowForIndex(p,Math.max(0,p.posts.length-1));return [0,Math.min(p.posts.length,Number(p.renderWindowSize)||VIRTUAL_WINDOW_SIZE)]}
function rebuildDomMap(p,box){p.domMap=new Map();box.querySelectorAll('.post').forEach(n=>p.domMap.set(String(n.dataset.key),n))}
function appendRenderBatch(p,box,start,end,prepend=false){const anchor=!p.follow?capturePostAnchor(box):null;renderVirtualWindow(p,box,Math.max(0,start),Math.min(p.posts.length,end),{anchor,reason:prepend?'prepend-window':'append-window',revision:p.userIntentRevision,force:true})}
function paintInitial(el,p){
  const box=el.querySelector('.posts'),content=postsContent(box);if(p.renderTimer)cancelAnimationFrame(p.renderTimer);if(p.renderWindowRaf)cancelAnimationFrame(p.renderWindowRaf);p.renderEpoch++;const [start,end]=initialRenderRange(p),revision=Number(p.userIntentRevision)||0;
  p.positionState='preparing';content.style.visibility='hidden';renderVirtualWindow(p,box,start,end,{reason:'initial-window',revision,force:true});if(p.perf)p.perf.firstBatchInserted=performance.now();bindPositionObserver(p,box);updateNewButton(el,p);
  let restored=true;const mode=p.viewportController?.snapshot?.().mode||(p.follow?'following':p.viewIntent==='restore'?'restoring':'reading');p.positionState=mode;
  if(mode==='restoring'){restored=restorePersistedPaneAnchor(p,box);if(!restored&&p.anchorPostId)startPendingReadRestore(p,box)}
  else if(p.viewIntent==='top'&&mode!=='following')writePaneScrollTop(p,box,0,'initial-top',revision);
  else if(mode==='following')writePaneScrollTop(p,box,Math.max(0,box.scrollHeight-box.clientHeight),'initial-tail',revision);
  if(!p.follow){const anchor=capturePostAnchor(box);p.readingAnchor=anchor;if(anchor)p.stableAnchor={...anchor,revision}}
  content.style.visibility='';p.positionState=p.viewportController?.snapshot?.().mode||(p.follow?'following':'reading');positionTrace(p,box,restored?'initial-restored':'initial-pending',{published:true});
  requestAnimationFrame(()=>{if(p.perf){p.perf.firstPaint=performance.now();if(p.perf.click)console.debug('[LiveBoard perf]',{kind:p.perf.kind,clickToFirstPaint:Math.round((p.perf.firstPaint-p.perf.click)*10)/10,api:p.perf.apiReceived&&p.perf.apiStart?Math.round((p.perf.apiReceived-p.perf.apiStart)*10)/10:null,posts:p.posts.length,stale:p.stale})}schedulePanePosition(p,restored?'initial-settled':'initial-pending')})
}
function capturePostAnchor(box){if(!box)return null;const br=box.getBoundingClientRect();const node=[...box.querySelectorAll('.post')].find(n=>n.getBoundingClientRect().bottom>br.top+1&&n.getBoundingClientRect().top<br.bottom);if(!node)return null;const top=node.getBoundingClientRect().top;return {key:node.dataset.key,top,offset:top-br.top}}
function visibleLastPostId(box){if(!box)return'';const br=box.getBoundingClientRect();let last='';for(const n of box.querySelectorAll('.post')){const r=n.getBoundingClientRect();if(r.bottom>br.top+1&&r.top<br.bottom-1)last=n.dataset.key||''}return last}
function readPositionRecord(p,box){if(!p||p.kind!=='thread'||!box||p.follow||p.userScrollIntent||['preparing','restoring','userInteracting'].includes(p.positionState))return null;const anchor=capturePostAnchor(box);if(!anchor)return null;return {board:p.board,url:p.url,anchorPostId:anchor.key||'',anchorOffset:anchor.top-box.getBoundingClientRect().top,lastReadPostId:visibleLastPostId(box)||anchor.key||'',mode:'reading',version:2,updatedAt:Date.now()}}
function flushReadPosition(p,box){if(!p||p.kind!=='thread')return;clearTimeout(p.readSaveTimer);p.readSaveTimer=0;if(p.follow||p.userScrollIntent||['preparing','restoring','userInteracting'].includes(p.positionState))return;const owner=readPositionOwnerByThread.get(p.threadId);if(owner&&owner!==p.paneId)return;const record=readPositionRecord(p,box);if(!record)return;readPositionOwnerByThread.set(p.threadId,p.paneId);if(!isWsbPane(p))repository.saveReadPosition(p.threadId,record);p.anchorPostId=record.anchorPostId;p.anchorOffset=record.anchorOffset;p.lastReadPostId=record.lastReadPostId;updateHistoryCurrent(p);scheduleDesktopSave()}
function scheduleReadPositionSave(p,box){if(!p||p.kind!=='thread'||p.follow||p.userScrollIntent||['preparing','restoring','userInteracting'].includes(p.positionState))return;clearTimeout(p.readSaveTimer);p.readSaveTimer=setTimeout(()=>flushReadPosition(p,box),250)}
function cancelPendingReadRestore(p){if(!p?.readRestorePending)return;p.readRestorePending=false;p.readRestoreUserCancelled=true;clearTimeout(p.readRestoreTimer);p.readRestoreTimer=0}
function postNumberFromId(v=''){const m=String(v).match(/(\d+)(?!.*\d)/);return m?Number(m[1]):0}
function finishPendingReadRestore(p,box,{fallback=false}={}){
  if(!p?.readRestorePending||p.readRestoreUserCancelled||!box)return false;
  const targetIndex=postIndexForKey(p,p.anchorPostId);if(targetIndex>=0&&!(p.domMap?.has?.(String(p.anchorPostId)))){const [start,end]=virtualWindowForIndex(p,targetIndex);renderVirtualWindow(p,box,start,end,{reason:'pending-restore-window',revision:p.userIntentRevision,force:true})}
  if(restorePersistedPaneAnchor(p,box)){p.readRestorePending=false;clearTimeout(p.readRestoreTimer);p.readRestoreTimer=0;p.positionState='reading';return true}
  if(!fallback)return false;const target=postNumberFromId(p.anchorPostId||p.lastReadPostId);let candidate=null;
  if(target){for(const post of p.posts){const n=Number(post.n)||postNumberFromId(post.key);if(n>=target){candidate=post;break}}if(!candidate){for(let i=p.posts.length-1;i>=0;i--){const post=p.posts[i],n=Number(post.n)||postNumberFromId(post.key);if(n<=target){candidate=post;break}}}}
  p.readRestorePending=false;clearTimeout(p.readRestoreTimer);p.readRestoreTimer=0;
  if(candidate){p.anchorPostId=candidate.key||'';p.anchorOffset=0;const index=postIndexForKey(p,p.anchorPostId),range=virtualWindowForIndex(p,index);renderVirtualWindow(p,box,range[0],range[1],{reason:'restore-fallback',revision:p.userIntentRevision,force:true});restorePersistedPaneAnchor(p,box);p.positionState='reading';return true}
  writePaneScrollTop(p,box,0,'restore-fallback-top',p.userIntentRevision);p.follow=false;p.viewportController?.userScroll?.({generation:p.generation,postId:postKeyAt(p,0),offset:0,reason:'restore-fallback-top'});p.positionState='reading';return false
}
function startPendingReadRestore(p,box){if(!p?.anchorPostId||p.readRestoreUserCancelled||p.readRestorePending)return;p.readRestorePending=true;p.positionState='restoring';p.viewportController?.startRestore?.({generation:p.generation,postId:p.anchorPostId,offset:p.anchorOffset,deadlineMs:2000,reason:'pending-restore'});clearTimeout(p.readRestoreTimer);p.readRestoreTimer=setTimeout(()=>finishPendingReadRestore(p,box,{fallback:true}),2000)}
function restorePostAnchor(box,anchor,p=null,reason='anchor',revision=p?.userIntentRevision){if(!anchor||!box)return false;const node=[...box.querySelectorAll('.post')].find(n=>n.dataset.key===anchor.key);if(!node)return false;const br=box.getBoundingClientRect(),target=Number.isFinite(Number(anchor.offset))?br.top+Number(anchor.offset):Number(anchor.top);if(!Number.isFinite(target))return false;const next=box.scrollTop+node.getBoundingClientRect().top-target;if(p)writePaneScrollTop(p,box,next,reason,revision);else box.scrollTop=next;return true}
function rememberPaneAnchor(p,box){if(!p||!box||p.follow||['preparing','restoring'].includes(p.positionState))return;const anchor=capturePostAnchor(box);p.anchorPostId=anchor?.key||'';p.anchorOffset=anchor?anchor.top-box.getBoundingClientRect().top:0;if(anchor){p.readingAnchor=anchor;p.stableAnchor={...anchor,revision:p.userIntentRevision}}p.unreadCount=p.newCount;updateHistoryCurrent(p);if(!p.userScrollIntent&&p.positionState!=='userInteracting')scheduleSave()}
function restorePersistedPaneAnchor(p,box){
  if(!p?.anchorPostId||!box)return false;let node=p.domMap?.get(String(p.anchorPostId));
  if(!node){const index=postIndexForKey(p,p.anchorPostId);if(index<0)return false;const [start,end]=virtualWindowForIndex(p,index);renderVirtualWindow(p,box,start,end,{reason:'restore-target-window',revision:p.userIntentRevision,force:true});node=p.domMap?.get(String(p.anchorPostId));if(!node)return false}
  const br=box.getBoundingClientRect(),next=box.scrollTop+node.getBoundingClientRect().top-br.top-(Number(p.anchorOffset)||0);writePaneScrollTop(p,box,next,'restore-persisted',p.userIntentRevision);
  const anchor=capturePostAnchor(box);if(anchor){p.readingAnchor=anchor;p.stableAnchor={...anchor,revision:p.userIntentRevision}}p.follow=false;p.viewportController?.finishRestore?.({generation:p.generation,postId:p.anchorPostId,offset:p.anchorOffset,reason:'restore-complete'});p.positionState='reading';return true
}
function mergeIntoPane(el,p,incoming,firstLoad,complete=false){
  if(firstLoad){p.analysisEpoch++;preparePostsForFastPaint(p,incoming);if(el)paintInitial(el,p);scheduleQuoteAnalysis(p);return}
  if(!el){threadStore.merge(p,incoming,{complete,annotate:annotatePosts});syncPostLayoutMetadata(p);return}
  if(p.renderTimer||p.analysisPending){p.pendingMerge={incoming,complete};return}
  const box=el.querySelector('.posts'),wasFollow=p.follow,revision=Number(p.userIntentRevision)||0,anchor=!wasFollow?capturePostAnchor(box):null;
  const diff=threadStore.merge(p,incoming,{complete,annotate:annotatePosts});syncPostLayoutMetadata(p);
  if(diff.inserted.length){const tail=diff.inserted.filter(x=>!x.deleted);if(tail.length){if(wasFollow)p.newCount=0;else p.newCount+=tail.length;scheduleSave()}}
  if(!postsContent(box).querySelector('.post')){paintInitial(el,p);return}
  const replaceKeys=new Set((diff.updated||[]).map(post=>String(post.key||`${p.board}-${post.n}`)));
  if(wasFollow){const [start,end]=virtualWindowForIndex(p,Math.max(0,p.posts.length-1));renderVirtualWindow(p,box,start,end,{reason:'merge-tail',revision,force:true,replaceKeys})}
  else{
    const index=anchor?postIndexForKey(p,anchor.key):Math.max(0,p.renderWindowStart);const [start,end]=virtualWindowForIndex(p,index>=0?index:0);renderVirtualWindow(p,box,start,end,{anchor,reason:'merge',revision,force:true,replaceKeys})
  }
  schedulePanePosition(p,'merge');updateNewButton(el,p)
}
function updatePaneStatus(el,p,override=''){const status=el?.querySelector?.('.paneStatus');if(!status)return;const state=threadStateLabel(p),text=override||(p.error?(p.lastSuccessAt?`${state} · 最終 ${p.lastSuccessAt}`:`${state} · 未取得`):(p.stale?'キャッシュ · 更新中':p.pendingNavigation?'移動中':p.lastSuccessAt?`${state} · ${p.lastSuccessAt}`:'取得中…'));status.classList.toggle('error',!!p.error);status.textContent=text;status.title=[p.error,p.endReason,fetchRetryLabel(p)].filter(Boolean).join(' · ');const pop=$('#headerPopover');if(pop?.dataset.paneId!==p.paneId||pop.hidden)return;if(Number(pop.dataset.generation)!==(Number(p.generation)||0)){closeHeaderPopover();return}if(pop.dataset.kind==='detail'){renderPaneDetailPopover(p,el.querySelector('.paneTitleBtn'),pop.dataset.trigger||'title');return}if(pop.dataset.kind==='history'){const dir=pop.dataset.direction==='forward'?'forward':'back',anchor=el.querySelector(dir==='forward'?'.historyForwardWrap':'.historyBackWrap');renderHistoryPopover(p,anchor,dir,pop.dataset.trigger||`history-${dir}`)}}
function markPaneFetchFailure(p,message){p.consecutiveFetchFailures=(Number(p.consecutiveFetchFailures)||0)+1;const delay=p.consecutiveFetchFailures<=1?15000:p.consecutiveFetchFailures===2?30000:60000;p.retryDelayMs=delay;p.nextRetryAt=Date.now()+delay;p.error=String(message||'取得できません');p.updated=fmtTime()}
function clearPaneFetchFailure(p){p.consecutiveFetchFailures=0;p.retryDelayMs=0;p.nextRetryAt=0;p.error=''}
function renderInitialThreadFailure(p){const el=paneElement(p),content=el?.querySelector('.postsContent');if(!content)return;content.innerHTML=`<div class="error">${esc(threadStateLabel(p))}<br>${esc(p.error||p.endReason||'スレッドを取得できません')}<br><button class="retryPane">再試行</button></div>`;content.querySelector('.retryPane')?.addEventListener('click',()=>refreshPane(p,true));updateNextCandidateUi(p)}
async function refreshPane(p,manual=false){if(!p||p.disposed||p.pendingNavigation)return;if(isWsbPane(p)){await attachWsbPane(p);return}if(!manual&&p.nextRetryAt>Date.now()){updateNextCandidateUi(p);return}const token=paneRequestToken(p);if(p.loadingToken&&isCurrentPaneRequest(p,p.loadingToken,panes))return;p.loading=true;p.loadingToken=token;const first=!p.initialized;if(first&&!p.perf)p.perf={kind:'initial',click:performance.now(),apiStart:performance.now()};else if(first&&p.perf&&!p.perf.apiStart)p.perf.apiStart=performance.now();p.requestController?.abort?.();const controller=new AbortController();p.requestController=controller;let slowTimer=setTimeout(()=>{if(isCurrentPaneRequest(p,token,panes))updatePaneStatus(paneElement(p),p,'掲示板の応答を待っています…')},3000);try{const j=await api(`/api/thread?board=${encodeURIComponent(p.board)}&url=${encodeURIComponent(p.url)}&purpose=${first?'foreground':'refresh'}`,{signal:controller.signal,timeoutMs:10000});if(first&&p.perf)p.perf.apiReceived=performance.now();if(!isCurrentPaneRequest(p,token,panes))return;applyThreadResponse(p,j,first)}catch(e){if(e?.name==='AbortError'||!isCurrentPaneRequest(p,token,panes))return;p.threadStatus='unknown';p.endReason='transport-unavailable';p.endHint=false;p.endConfirmed=false;p.ended=false;markPaneFetchFailure(p,e.message);const el=paneElement(p);if(el)updatePaneStatus(el,p);if(!p.initialized)renderInitialThreadFailure(p);void maybeAdvanceThread(p,{forceCheck:true});if(manual)toast(`${p.title}: ${e.message}`)}finally{clearTimeout(slowTimer);if(isCurrentPaneRequest(p,token,panes)){p.loading=false;p.loadingToken=null;updateNextCandidateUi(p)}}}
function applyThreadResponse(p,j,first=false){if(p.perf)p.perf.dataReady=performance.now();if(p.board==='futaba'){p.rawTitle=String(j.rawTitle||j.title||p.rawTitle||p.title||'');p.title=threadDisplayTitle('futaba',j.title||p.title);if(p.title)rememberFutabaThreadTitle(futabaThreadKey(p.url),p.title,{source:'opened-thread',confirmed:true,rawTitle:p.rawTitle})}else p.title=j.title||p.title;p.source=j.source||'';p.stale=!!j.stale;p.updated=fmtTime();p.threadStatus=['active','ended','missing','partial','unknown'].includes(j.status)?j.status:'unknown';p.endReason=String(j.endReason||'');p.complete=!!j.complete;p.lastPostNo=Number(j.lastPostNo)||0;p.observedCount=Number(j.observedCount)||Number(j.posts?.length)||0;p.fetchDiagnostics=j.diagnostics||null;p.endHint=!!j.endHint;p.endConfirmed=p.threadStatus==='ended'||p.threadStatus==='missing';p.ended=p.endConfirmed;const incoming=(j.posts||[]),unavailable=!!j.unavailable;
  if(unavailable){markPaneFetchFailure(p,j.errorMessage||p.endReason||'現在スレッドを取得できません');const el=paneElement(p);if(el){const t=el.querySelector('.paneTitleBtn');t.textContent=p.title||'Untitled';t.setAttribute('aria-label',p.title||'');updatePaneStatus(el,p)}if(!p.initialized)renderInitialThreadFailure(p);save();void maybeAdvanceThread(p,{forceCheck:true});return}
  clearPaneFetchFailure(p);p.lastSuccessAt=p.updated;p.total=incoming.length;const el=paneElement(p);if(el){const t=el.querySelector('.paneTitleBtn');t.textContent=p.title||'Untitled';t.setAttribute('aria-label',p.title||'');updatePaneStatus(el,p);mergeIntoPane(el,p,incoming,first||!p.initialized,!!j.complete)}else if(first||!p.initialized){threadStore.replace(p,incoming,{annotate:annotatePosts});syncPostLayoutMetadata(p)}else{threadStore.merge(p,incoming,{complete:!!j.complete,annotate:annotatePosts});syncPostLayoutMetadata(p)}p.initialized=true;p.viewIntent=p.viewIntent==='restore'?'restore':p.viewIntent;save();void maybeAdvanceThread(p)}
async function hydrateOnePreview(node){
  if(!node?.isConnected)return;node.dataset.hydrated='1';const url=node.dataset.previewUrl;const xid=xStatusId(url),yid=youtubeId(url);
  if(xid){
    try{let data=previewCache.get(url);if(!data){data=await api('/api/unfurl?url='+encodeURIComponent(url),{timeoutMs:6500});cacheRemember(previewCache,url,data,600)}node.outerHTML=unfurlHtml(url,{...data,siteName:data.siteName||'X',title:data.title||'X の投稿'});}
    catch{node.outerHTML=`<a class="previewCard compactCard failedPreview" href="${esc(url)}" target="_blank" rel="noreferrer"><div class="compactText"><div class="previewSite">X</div><div class="previewTitle">X の投稿を開く</div></div></a>`;}return
  }
  if(yid){node.outerHTML=youtubePreviewHtml(url,yid);return}
  if(isImageUrl(url)){node.outerHTML=mediaAttachmentHtml({url,thumb:url,type:'image'},true);return}
  if(isVideoUrl(url)){node.outerHTML=mediaAttachmentHtml({url,thumb:url,type:'video'},true);requestAnimationFrame(()=>hydrateVideoThumbs(document));return}
  try{
    let data=previewCache.get(url);if(!data){data=await api('/api/unfurl?url='+encodeURIComponent(url),{timeoutMs:8500});cacheRemember(previewCache,url,data,600)}
    node.outerHTML=unfurlHtml(url,data);
  }catch{let host='リンク';try{host=new URL(url).hostname.replace(/^www\./,'')}catch{}node.outerHTML=`<a class="previewCard compactCard failedPreview" href="${esc(url)}" target="_blank" rel="noreferrer"><div class="compactText"><div class="previewSite">${esc(host)}</div><div class="previewTitle">リンクを開く</div></div></a>`}
}
const previewJobs=[],previewInflight=new Map();let previewActive=0;const previewObservers=new WeakMap();
function previewVisibleNode(node){const pane=node.closest?.('.pane');if(pane){const r=pane.getBoundingClientRect();if(r.bottom<0||r.top>innerHeight)return false}const root=node.closest?.('.posts');if(root&&node!==root){const nr=node.getBoundingClientRect(),rr=root.getBoundingClientRect();return nr.bottom>=rr.top-300&&nr.top<=rr.bottom+300}return true}
function enqueuePreview(node){if(!node?.isConnected||node.dataset.previewState&&node.dataset.previewState!=='idle')return;node.dataset.previewState='queued';previewJobs.push(node);pumpPreviewQueue()}
function pumpPreviewQueue(){while(previewActive<4&&previewJobs.length){const node=previewJobs.shift();if(!node?.isConnected||!previewVisibleNode(node)){if(node)node.dataset.previewState='idle';continue}const url=node.dataset.previewUrl;if(!url){node.dataset.previewState='error';continue}node.dataset.previewState='loading';previewActive++;let promise=previewInflight.get(url);if(!promise){promise=hydrateOnePreview(node).finally(()=>previewInflight.delete(url));previewInflight.set(url,promise)}else promise=promise.then(()=>node.isConnected?hydrateOnePreview(node):undefined);promise.catch(()=>{if(node?.isConnected)node.dataset.previewState='error'}).finally(()=>{previewActive--;pumpPreviewQueue()})}}
function resetVideoThumb(v){if(!v)return;v.dataset.frameReady='';v.dataset.videoState='idle';v.removeAttribute('src');try{v.load()}catch{};const host=v.closest('.attachmentWrap')||v.closest('.attachment');host?.classList.remove('videoError','videoReady');const state=host?.querySelector('.videoState');if(state)state.innerHTML=''}
function hydrateVideoThumb(v){if(!v?.isConnected||v.dataset.videoState==='loading'||v.dataset.videoState==='ready')return;const host=v.closest('.attachmentWrap')||v.closest('.attachment')||v;if(!previewVisibleNode(host))return;v.dataset.videoState='loading';const src=v.dataset.src||v.getAttribute('data-src');if(src&&!v.src)v.src=src;v.preload='metadata';const state=host.querySelector?.('.videoState');if(state)state.textContent='読み込み中…';const fail=()=>{if(!v.isConnected)return;v.dataset.videoState='error';host.classList.add('videoError');if(state)state.innerHTML='<span>読み込み失敗</span><button type="button" class="retryVideo">再試行</button>';state?.querySelector?.('.retryVideo')?.addEventListener('click',e=>{e.stopPropagation();resetVideoThumb(v);hydrateVideoThumb(v)},{once:true})};v.addEventListener('error',fail,{once:true});v.addEventListener('loadedmetadata',()=>{try{if(Number.isFinite(v.duration)&&v.duration>0&&v.currentTime===0)v.currentTime=Math.min(.18,Math.max(.03,v.duration/50))}catch{}},{once:true});v.addEventListener('loadeddata',()=>{if(!v.isConnected)return;v.dataset.frameReady='1';v.dataset.videoState='ready';host.classList.remove('videoError');host.classList.add('videoReady');if(state)state.textContent='';try{v.pause()}catch{}},{once:true});try{v.load()}catch{fail()}}
function observerFor(root){let ob=previewObservers.get(root);if(ob)return ob;ob=new IntersectionObserver(entries=>{for(const e of entries){if(!e.isIntersecting)continue;if(e.target.matches?.('video.previewVideoThumb'))hydrateVideoThumb(e.target);else if(e.target.matches?.('.attachmentWrap[data-media-url]')){const img=e.target.querySelector('.attachment img');if(img&&!inlineImageAttempts.has(e.target))armInlineImage(e.target,img,Number(e.target.dataset.mediaAttempt)||0);ob.unobserve(e.target)}else enqueuePreview(e.target)}},{root:root?.classList?.contains('posts')?root:null,rootMargin:'300px 0px'});previewObservers.set(root,ob);return ob}
function hydrateVideoThumbs(root=document){root.querySelectorAll?.('video.previewVideoThumb:not([data-frame-ready])').forEach(hydrateVideoThumb)}
function hydratePreviews(root=document){fitAsciiArt(root);const groups=root.matches?.('.posts,.hoverPopover')?[root]:[...root.querySelectorAll?.('.posts,.hoverPopover')||[]];if(!groups.length)groups.push(document);for(const group of groups){const ob=observerFor(group);group.querySelectorAll?.('[data-preview-url]:not([data-preview-state])').forEach(node=>{node.dataset.previewState='idle';ob.observe(node)});group.querySelectorAll?.('video.previewVideoThumb:not([data-frame-ready])').forEach(v=>ob.observe(v));group.querySelectorAll?.('.attachmentWrap[data-media-url]').forEach(wrap=>{if(!inlineImageAttempts.has(wrap))ob.observe(wrap)})}hydrateVideoThumbs(root)}

function youtubePreviewHtml(url,id){const thumb=`https://i.ytimg.com/vi/${id}/hqdefault.jpg`,start=youtubeStart(url);return `<div class="previewCard compactCard youtubeCard" data-youtube-id="${esc(id)}" data-youtube-url="${esc(url)}" data-youtube-start="${start}"><button class="compactMedia previewMedia" type="button" aria-label="YouTubeを拡大再生"><img class="previewImage" loading="lazy" src="${thumb}" alt="YouTube"><span class="playBadge">▶</span></button><div class="compactText"><div class="previewSite">YouTube${start?` · ${Math.floor(start/60)}:${String(start%60).padStart(2,'0')}`:''}</div><div class="previewTitle">動画を再生</div></div></div>`}
function unfurlHtml(url,d){
  if(d.kind==='image')return mediaAttachmentHtml({url:d.url||url,thumb:d.url||url,type:'image',width:d.width,height:d.height,sourceUrl:d.sourceUrl||url},true);
  if(d.kind==='video')return mediaAttachmentHtml({url:d.url||url,thumb:d.url||url,type:'video',sourceUrl:d.sourceUrl||url},true);
  const image=d.image?`<img class="compactThumb previewThumb" loading="lazy" src="${esc(boardMediaSrc(d.image))}" alt="">`:'';
  return `<a class="previewCard compactCard ${image?'hasPreviewImage':'noPreviewImage'}" href="${esc(url)}" target="_blank" rel="noreferrer"><div class="compactText"><div class="previewSite">${esc(d.siteName||d.host||'リンク')}</div><div class="previewTitle">${esc(d.title||url)}</div>${d.description?`<div class="previewDesc">${esc(d.description)}</div>`:''}</div>${image}</a>`;
}

let lightboxSource=null;

function holdChainElements(hold=mediaPopoverHold){return (hold?.chain||[]).filter(x=>x?.isConnected)}
function releaseMediaPopoverHold(close=false){const hold=mediaPopoverHold;if(!hold)return;clearTimeout(hold.returnTimer||0);for(const pop of holdChainElements(hold)){pop.inert=false;delete pop.dataset.mediaHold}mediaPopoverHold=null;if(close)hidePopoversFrom(0);else schedulePopoverCleanup()}
function beginMediaPopoverHold(sourceEl){const owner=sourceEl?.closest?.('.hoverPopover');if(!owner){if(mediaPopoverHold)releaseMediaPopoverHold(true);return}const p=paneForElement(sourceEl);if(!p)return;if(mediaPopoverHold&&(mediaPopoverHold.paneId!==p.paneId||mediaPopoverHold.ownerElement!==owner))releaseMediaPopoverHold(true);const depth=Number(owner.dataset.depth||0),chain=[...document.querySelectorAll('.hoverPopover:not([hidden])')].filter(x=>x.dataset.paneId===p.paneId&&Number(x.dataset.depth||0)<=depth);clearTimeout(popoverHideTimer);for(const t of popoverOpenTimers.values())clearTimeout(t);popoverOpenTimers.clear();mediaPopoverHold={sessionId:++mediaHoldSession,paneId:p.paneId,generation:p.generation,ownerDepth:depth,ownerElement:owner,chain,phase:'mediaOpen',lastPointer:{...lastPointer},keyboard:lastPointer.kind==='keyboard',returnTimer:0};for(const pop of chain){pop.dataset.mediaHold='1';pop.inert=true}}
function mediaHoldOwnerContainsTarget(target){const hold=mediaPopoverHold;if(!hold)return false;return holdChainElements(hold).some(pop=>pop===target||pop.contains?.(target))}
function markMediaHoldReturned(target=null,viaKeyboard=false){const hold=mediaPopoverHold;if(!hold||hold.phase!=='awaitReturn')return;if(viaKeyboard||mediaHoldOwnerContainsTarget(target)){hold.phase='returned';hold.keyboard=viaKeyboard;releaseMediaPopoverHold(false)}}
function hideLightboxUrlTooltip(){clearTimeout(lightboxTooltipTimer);lightboxTooltipTimer=0;const tip=$('#lightboxUrlTooltip');if(tip){tip.hidden=true;tip.textContent=''}}
function scheduleLightboxUrlTooltip(){hideLightboxUrlTooltip();const box=$('#lightbox'),tip=$('#lightboxUrlTooltip');if(!box||box.hidden||!tip)return;const session=lightboxTooltipSession,url=safeUrl(box.dataset.sourceUrl||'');if(!url)return;lightboxTooltipTimer=setTimeout(()=>{if(session!==lightboxTooltipSession||box.hidden||safeUrl(box.dataset.sourceUrl||'')!==url)return;tip.textContent=url;tip.hidden=false},300)}
function mediaCleanup(){clearTimeout(lightboxMediaTimer);lightboxMediaTimer=0;const stage=$('#lightboxStage'),host=$('#lightboxMediaHost');stage?.querySelectorAll('video').forEach(v=>{try{v.pause();v.removeAttribute('src');v.load()}catch{}});stage?.querySelectorAll('iframe').forEach(f=>{try{f.src='about:blank'}catch{};f.remove()});if(host)host.innerHTML=''}
function setBackgroundInert(on){['#toolbar','.workspace','#threadDrawer'].forEach(sel=>{const el=$(sel);if(el)el.inert=!!on});if(on)document.querySelectorAll('.hoverPopover:not([hidden])').forEach(x=>x.inert=true);else if(!mediaPopoverHold)document.querySelectorAll('.hoverPopover').forEach(x=>x.inert=false)}
function galleryItemSnapshot(item){
  if(item?.kind==='youtube'){const raw=String(item.url||item.id||''),url=safeUrl(raw),id=item.id||youtubeId(url)||raw.replace(/[^\w-]/g,'');if(!id)return null;return {kind:'youtube',src:url||id,sourceUrl:url,id,start:url?youtubeStart(url):0}}
  const m=item?.media||item||{},src=safeUrl(m.url);if(!src)return null;return {kind:m.type==='video'?'video':'image',src,sourceUrl:safeUrl(m.sourceUrl)||src,thumb:safeUrl(m.thumb)||'',width:Number(m.width)||0,height:Number(m.height)||0}
}
function galleryOwnerForElement(sourceEl){
  const p=paneForElement(sourceEl);if(!p||p.kind!=='thread')return null;const host=sourceEl?.closest?.('.post,.popoverPost');if(!host)return null;
  const no=String(host.dataset.postNo||''),key=String(host.dataset.postKey||host.dataset.key||'');let post=no?p.postMap?.get(no):null;if(!post&&key)post=(p.posts||[]).find(x=>String(x.key||x.n||'')===key);if(!post)return null;
  return {p,post,postKey:String(post.key||post.n||key),postNo:String(post.n||no)}
}
function gallerySnapshotForElement(sourceEl){
  const owner=galleryOwnerForElement(sourceEl);if(!owner)return null;const raw=mediaDisplayPlan(owner.post).mediaItems||[],items=raw.map(galleryItemSnapshot).filter(Boolean);if(!items.length)return null;
  let index=Number(sourceEl?.closest?.('.mediaCell')?.dataset?.mediaIndex);if(!Number.isInteger(index)||index<0||index>=items.length){const type=sourceEl?.dataset?.lightboxType||'',src=safeUrl(sourceEl?.dataset?.lightboxSrc||sourceEl?.closest?.('[data-youtube-url]')?.dataset?.youtubeUrl||'');index=items.findIndex(x=>x.src===src&&(type?x.kind===type:true));if(index<0)index=0}
  return {...owner,items,index}
}
function galleryRestoreTarget(session){
  if(session?.sourceEl?.isConnected)return session.sourceEl;const pane=paneElement(panes.find(p=>p.paneId===session?.ownerPaneId));if(!pane)return null;const key=CSS.escape(String(session.postKey||'')),no=CSS.escape(String(session.postNo||'')),root=pane.querySelector(`.post[data-key="${key}"]`)||pane.querySelector(`.post[data-post-no="${no}"]`);return root?.querySelector?.(`.mediaCell[data-media-index="${Number(session.sourceIndex)||0}"] button`)||pane.querySelector('.posts')||null
}
function gallerySessionCurrent(session,generation,mediaSession){return !!session&&gallerySession===session&&!$('#lightbox')?.hidden&&generation===session.generation&&mediaSession===lightboxMediaSession}
function syncGalleryControls(session=gallerySession){const count=$('#lightboxCount'),prev=$('#lightboxPrev'),next=$('#lightboxNext'),total=session?.items?.length||0,index=Number(session?.currentIndex)||0;if(count)count.textContent=total?`${index+1} / ${total}`:'';for(const b of [prev,next])if(b)b.hidden=total<=1;if(prev)prev.disabled=!total||index<=0;if(next)next.disabled=!total||index>=total-1}
function renderGalleryItem(){
  const session=gallerySession,box=$('#lightbox'),stage=$('#lightboxStage'),host=$('#lightboxMediaHost');if(!session||!box||box.hidden||!stage||!host)return false;const item=session.items[session.currentIndex];if(!item)return false;
  hideLightboxUrlTooltip();lightboxTooltipSession++;lightboxMediaSession++;mediaCleanup();const mediaSession=lightboxMediaSession,generation=++session.generation;box.dataset.galleryGeneration=String(generation);box.dataset.sourceUrl=item.sourceUrl||item.src||'';$('#lightboxExternal').hidden=!safeUrl(box.dataset.sourceUrl||'');syncGalleryControls(session);
  let html='';if(item.kind==='youtube'){const params=new URLSearchParams({autoplay:'1'});if(item.start)params.set('start',String(item.start));html=`<iframe class="lightboxFrame" referrerpolicy="strict-origin-when-cross-origin" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?${params}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`}
  else if(item.kind==='video')html=`<div class="lightboxVideoWrap"><video controls autoplay playsinline src="${esc(videoMediaSrc(item.src))}"></video><div class="lightboxMediaError" hidden>読み込み失敗 <button type="button" class="lightboxRetryVideo">再試行</button></div></div>`;
  else html=`<div class="lightboxImageWrap"><div class="lightboxMediaError" role="status"><span class="lightboxMediaStatus">読み込み中…</span><button type="button" class="lightboxRetryImage" hidden>再試行</button></div></div>`;
  host.innerHTML=html;
  if(item.kind==='video'){
    const v=host.querySelector('video'),err=host.querySelector('.lightboxMediaError');const current=()=>gallerySessionCurrent(session,generation,mediaSession)&&v?.isConnected;const fail=()=>{if(current()&&err)err.hidden=false};v?.addEventListener('error',fail,{once:true});const wait=setTimeout(fail,MEDIA_LOAD_TIMEOUT_MS);lightboxMediaTimer=wait;v?.addEventListener('loadeddata',()=>{if(!current())return;clearTimeout(wait);if(lightboxMediaTimer===wait)lightboxMediaTimer=0;if(err)err.hidden=true},{once:true});err?.querySelector('.lightboxRetryVideo')?.addEventListener('click',()=>{if(!current())return;if(err)err.hidden=true;try{v.pause();v.removeAttribute('src');v.load();v.src=videoMediaSrc(item.src);v.load();v.play().catch(()=>{})}catch{}})
  }else if(item.kind==='image'){
    const wrap=host.querySelector('.lightboxImageWrap'),err=host.querySelector('.lightboxMediaError'),status=err?.querySelector('.lightboxMediaStatus'),retry=err?.querySelector('.lightboxRetryImage');let attempt=0,activeAttempt=0,activeState=null;
    const currentBase=()=>gallerySessionCurrent(session,generation,mediaSession)&&wrap?.isConnected;const showState=(message,retryable=false)=>{if(!currentBase()||!err)return;err.hidden=false;if(status)status.textContent=message;if(retry)retry.hidden=!retryable};
    const startAttempt=()=>{if(!currentBase())return;clearTimeout(lightboxMediaTimer);lightboxMediaTimer=0;const token=++activeAttempt,candidate=document.createElement('img'),state={token,ended:false};activeState=state;candidate.className='zoomImage';candidate.alt='';candidate.dataset.mediaAttempt=String(token);showState(attempt?'再試行中…':'読み込み中…',false);const current=()=>currentBase()&&candidate.isConnected&&token===activeAttempt&&activeState===state&&!state.ended;const fail=message=>{if(!current())return;state.ended=true;clearTimeout(lightboxMediaTimer);lightboxMediaTimer=0;candidate.remove();showState(message,true)};candidate.addEventListener('error',()=>fail('画像を読み込めません'),{once:true});candidate.addEventListener('load',async()=>{if(!current())return;if(!(candidate.naturalWidth>0&&candidate.naturalHeight>0)){fail('画像を読み込めません');return}try{if(candidate.decode)await candidate.decode()}catch{fail('画像をデコードできません');return}if(!current())return;state.ended=true;clearTimeout(lightboxMediaTimer);lightboxMediaTimer=0;if(err)err.hidden=true;if(retry)retry.hidden=true},{once:true});const prior=wrap.querySelector('.zoomImage');if(prior)prior.replaceWith(candidate);else wrap.insertBefore(candidate,err||null);lightboxMediaTimer=setTimeout(()=>{if(!current())return;state.ended=true;lightboxMediaTimer=0;candidate.remove();showState('読み込みに時間がかかっています',true)},MEDIA_LOAD_TIMEOUT_MS);candidate.src=mediaAttemptSrc(item.src,attempt)};startAttempt();retry?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();attempt++;startAttempt()})
  }
  return true
}
function moveGallery(delta){const session=gallerySession;if(!session)return false;const next=session.currentIndex+(delta<0?-1:1);if(next<0||next>=session.items.length)return false;session.currentIndex=next;return renderGalleryItem()}
function beginGallerySession(snapshot,sourceEl){
  if(!snapshot?.items?.length)return false;if(!$('#lightbox')?.hidden)closeLightbox(false);if(mediaPopoverHold&&sourceEl&&!sourceEl.closest?.('.hoverPopover'))releaseMediaPopoverHold(true);beginMediaPopoverHold(sourceEl);
  const p=snapshot.p,box=$('#lightbox');gallerySession={sessionId:++gallerySessionSeq,ownerPaneId:p.paneId,ownerGeneration:p.generation,threadKey:p.threadId,postKey:snapshot.postKey,postNo:snapshot.postNo,items:snapshot.items.map(x=>({...x})),currentIndex:snapshot.index,sourceIndex:snapshot.index,generation:0,sourceEl};lightboxSource=sourceEl;box.dataset.ownerPaneId=p.paneId;box.dataset.threadKey=p.threadId;box.hidden=false;syncTickerAnimationPlayback($('#tickerTrack'));setBackgroundInert(true);renderGalleryItem();requestAnimationFrame(()=>box.querySelector('.lightboxClose')?.focus());return true
}
function openGalleryFromElement(sourceEl){const snapshot=gallerySnapshotForElement(sourceEl);return snapshot?beginGallerySession(snapshot,sourceEl):false}
function openLightbox(src,type='image',sourceEl=null,sourceUrl=''){
  const snap=sourceEl?gallerySnapshotForElement(sourceEl):null;if(snap)return beginGallerySession(snap,sourceEl);src=safeUrl(src)||String(src||'');const item=type==='youtube'?galleryItemSnapshot({kind:'youtube',url:src,id:youtubeId(src)||String(src).replace(/[^\w-]/g,'')}):galleryItemSnapshot({url:safeUrl(src),type,sourceUrl:safeUrl(sourceUrl)||safeUrl(src)});if(!item)return false;const p=paneForElement(sourceEl)||{paneId:'',generation:0,threadId:''};return beginGallerySession({p,postKey:'',postNo:'',items:[item],index:0},sourceEl)
}
function closeLightbox(restore=true){
  hideLightboxUrlTooltip();lightboxTooltipSession++;const box=$('#lightbox');if(!box||box.hidden)return;lightboxMediaSession++;const hold=mediaPopoverHold,session=hold?.sessionId,gallery=typeof gallerySession==='undefined'?null:gallerySession;mediaCleanup();if(typeof gallerySession!=='undefined')gallerySession=null;box.hidden=true;if(typeof syncGalleryControls==='function')syncGalleryControls(null);syncTickerAnimationPlayback($('#tickerTrack'));const source=(typeof galleryRestoreTarget==='function'?galleryRestoreTarget(gallery):null)||lightboxSource;lightboxSource=null;delete box.dataset.ownerPaneId;delete box.dataset.threadKey;delete box.dataset.galleryGeneration;if(hold&&hold.sessionId===session){for(const pop of holdChainElements(hold))pop.inert=false;hold.phase='awaitReturn';const p=panes.find(x=>x.paneId===hold.paneId);if(!p||p.disposed||p.generation!==hold.generation||!hold.ownerElement?.isConnected){releaseMediaPopoverHold(true)}else{hold.returnTimer=setTimeout(()=>{if(mediaPopoverHold?.sessionId===session&&mediaPopoverHold.phase==='awaitReturn')releaseMediaPopoverHold(false)},180);const atPoint=document.elementFromPoint?.(lastPointer.x,lastPointer.y);if(atPoint&&mediaHoldOwnerContainsTarget(atPoint))markMediaHoldReturned(atPoint,false)}}setBackgroundInert(false);if(restore&&source?.isConnected){try{source.focus?.({preventScroll:true})}catch{source.focus?.()}if(hold?.keyboard)markMediaHoldReturned(source,true)}queueMicrotask(()=>panes.filter(p=>p.kind==='thread'&&p.liveMode).forEach(p=>void maybeLiveAutoAdvance(p)))
}
function lightboxOutsideClick(e){const box=$('#lightbox');if(box.hidden)return;const media=e.target.closest?.('img,video,iframe,a,button');if(!media)closeLightbox()}

function setInlineImageState(wrap,state,message=''){
  if(!wrap)return;wrap.dataset.mediaState=state;
  const note=wrap.querySelector('.mediaLoadError'),text=note?.querySelector('.mediaErrorText'),retry=note?.querySelector('.retryInlineImage');
  const failed=state==='error'||state==='timedOut'||state==='loading';wrap.classList.toggle('mediaImageError',failed);wrap.classList.toggle('mediaImageLoading',state==='loading');
  if(note){note.hidden=!failed;if(text)text.textContent=message||({loading:'読み込み中…',timedOut:'読み込みに時間がかかっています',error:'画像を読み込めません'}[state]||'');if(retry){retry.hidden=state==='loading';retry.disabled=state==='loading'}}
}
function clearInlineImageAttempt(wrap){const rec=inlineImageAttempts.get(wrap);if(rec?.timer)clearTimeout(rec.timer);if(rec)rec.ended=true;inlineImageAttempts.delete(wrap)}
function armInlineImage(wrap,img,attempt=0,{retrying=false}={}){
  if(!wrap||!img)return;clearInlineImageAttempt(wrap);wrap.dataset.mediaAttempt=String(attempt);img.dataset.mediaAttempt=String(attempt);
  const rec={attempt,img,ended:false,timer:0};inlineImageAttempts.set(wrap,rec);
  if(retrying)setInlineImageState(wrap,'loading','読み込み中…');
  rec.timer=setTimeout(()=>{if(rec.ended||inlineImageAttempts.get(wrap)!==rec||!wrap.isConnected)return;rec.ended=true;rec.timer=0;setInlineImageState(wrap,'timedOut','読み込みに時間がかかっています');const p=paneForElement(wrap);if(p)schedulePanePosition(p,'image-timeout')},MEDIA_LOAD_TIMEOUT_MS);
  if(img.complete&&(img.currentSrc||img.getAttribute('src'))){queueMicrotask(()=>{if(!img.isConnected||inlineImageAttempts.get(wrap)!==rec||rec.ended)return;if(img.naturalWidth>0)finishInlineImageAttempt(wrap,img,true);else finishInlineImageAttempt(wrap,img,false)})}
}
function finishInlineImageAttempt(wrap,img,ok){
  const rec=inlineImageAttempts.get(wrap);if(!rec||rec.ended||rec.img!==img||String(rec.attempt)!==String(img.dataset.mediaAttempt||'0'))return false;
  rec.ended=true;if(rec.timer)clearTimeout(rec.timer);rec.timer=0;
  if(ok&&img.naturalWidth>0&&img.naturalHeight>0){setInlineImageState(wrap,'ready');inlineImageAttempts.delete(wrap)}else setInlineImageState(wrap,'error','画像を読み込めません');
  const p=paneForElement(wrap);if(p)schedulePanePosition(p,ok?'image-load':'image-error');return true;
}
function startInlineImageAttempt(wrap,url){
  const prior=inlineImageAttempts.get(wrap);if(prior&&!prior.ended&&wrap.dataset.mediaState==='loading')return;
  const old=wrap.querySelector('.attachment img'),button=wrap.querySelector('.attachment');if(!button||!url)return;
  const attempt=(Number(wrap.dataset.mediaAttempt)||0)+1,candidate=document.createElement('img');candidate.loading='eager';candidate.alt=old?.alt||'';candidate.dataset.mediaAttempt=String(attempt);
  if(old)old.replaceWith(candidate);else button.append(candidate);armInlineImage(wrap,candidate,attempt,{retrying:true});candidate.src=mediaAttemptSrc(url,attempt);
}
function armInlineImages(root=document){root.querySelectorAll?.('.attachmentWrap[data-media-url]').forEach(wrap=>{const img=wrap.querySelector('.attachment img');if(!img||inlineImageAttempts.has(wrap))return;armInlineImage(wrap,img,Number(wrap.dataset.mediaAttempt)||0)})}

document.addEventListener('click',e=>{const retry=e.target.closest?.('.retryInlineImage');if(retry){e.preventDefault();e.stopPropagation();const wrap=retry.closest('.attachmentWrap'),url=safeUrl(wrap?.dataset?.mediaUrl||'');if(wrap&&url)startInlineImageAttempt(wrap,url);return}const lb=e.target.closest?.('[data-lightbox-src]');if(lb){e.preventDefault();if(!openGalleryFromElement(lb))openLightbox(lb.dataset.lightboxSrc,lb.dataset.lightboxType||'image',lb,lb.dataset.lightboxSourceUrl||'');return}const yt=e.target.closest?.('[data-youtube-url] .previewMedia');if(yt){e.preventDefault();const card=yt.closest('[data-youtube-url]');if(!openGalleryFromElement(yt))openLightbox(card.dataset.youtubeUrl||card.dataset.youtubeId,'youtube',yt);return}const a=e.target.closest?.('a[href]');if(!a)return;const ref=internalThreadRef(a.href),unmodified=e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey;if(ref&&unmodified&&!a.closest('.composerBar')){const p=paneForElement(a);if(p){e.preventDefault();void navigatePane(p,{board:ref.boardId,url:ref.canonicalUrl,title:a.textContent||''},{kind:'link'});return}}if(/^https?:/i.test(a.href)&&window.liveboardDesktop&&unmodified){e.preventDefault();openExternalUrl(a.href)}});

document.addEventListener('error',e=>{
  const img=e.target;if(!(img instanceof HTMLImageElement))return;
  const wrap=img.closest('.attachmentWrap'),attachment=img.closest('.attachment[data-lightbox-type="image"]');
  if(attachment&&wrap){if(!inlineImageAttempts.has(wrap))armInlineImage(wrap,img,Number(wrap.dataset.mediaAttempt)||0);finishInlineImageAttempt(wrap,img,false);return}
  if(img.classList.contains('previewThumb')||img.closest('.previewCard')){
    const card=img.closest('.previewCard');if(card){img.remove();card.classList.remove('hasPreviewImage');card.classList.add('noPreviewImage')}
  }
},true);


document.addEventListener('load',e=>{if(e.target instanceof HTMLImageElement){const wrap=e.target.closest('.attachmentWrap');if(wrap){if(!inlineImageAttempts.has(wrap))armInlineImage(wrap,e.target,Number(wrap.dataset.mediaAttempt)||0);finishInlineImageAttempt(wrap,e.target,true);return}const p=paneForElement(e.target);if(p)schedulePanePosition(p,'image-load')}},true);
document.addEventListener('loadedmetadata',e=>{if(e.target instanceof HTMLVideoElement){const p=paneForElement(e.target);if(p)schedulePanePosition(p,'video-metadata')}},true);
let popoverHideTimer=0;
const POPOVER_HOVER_DELAY=500;
const popoverOpenTimers=new Map();
const popoverAnchors=new Map();
const popoverKeyboardAnchors=new Map();
let popoverPlacementState=null;
function paneForElement(el){const paneEl=el.closest?.('.pane');if(paneEl)return panes.find(p=>p.paneId===paneEl.dataset.paneId)||null;const pop=el.closest?.('.hoverPopover');return pop?.dataset?.paneId?panes.find(p=>p.paneId===pop.dataset.paneId)||null:null}
function popoverDepthForAnchor(anchor){const parent=anchor.closest?.('.hoverPopover');return parent?Number(parent.dataset.depth||0)+1:0}
function cancelPopoverOpen(anchor){const t=popoverOpenTimers.get(anchor);if(t){clearTimeout(t);popoverOpenTimers.delete(anchor)}}
function cancelPopoverOpenFrom(depth=0){for(const [anchor,t] of popoverOpenTimers){if(Math.min(4,popoverDepthForAnchor(anchor))>=depth&&!anchor.matches?.(':hover')){clearTimeout(t);popoverOpenTimers.delete(anchor)}}}
function schedulePopoverOpen(anchor,fn){cancelPopoverOpen(anchor);const t=setTimeout(()=>{popoverOpenTimers.delete(anchor);if(anchor.isConnected&&anchor.matches(':hover'))fn()},POPOVER_HOVER_DELAY);popoverOpenTimers.set(anchor,t)}
function handlePopoverPointerEnter(pop,e){const entered=Number(pop?.dataset?.depth||0),from=e?.relatedTarget?.closest?.('.hoverPopover'),fromDepth=from?Number(from.dataset.depth||0):-1;if(from&&fromDepth>entered)schedulePopoverCleanup();else clearTimeout(popoverHideTimer)}
function ensurePopover(depth){
  if(depth===0){const base=$('#hoverPopover');base.dataset.depth='0';base.style.zIndex='260';return base}
  let pop=document.querySelector(`.hoverPopover[data-depth="${depth}"]`);if(!pop){pop=document.createElement('div');pop.className='hoverPopover nestedPopover';pop.dataset.depth=String(depth);pop.hidden=true;document.body.appendChild(pop);pop.style.zIndex=String(260+depth*6);pop.addEventListener('pointerenter',e=>handlePopoverPointerEnter(pop,e));pop.addEventListener('pointerleave',schedulePopoverCleanup)}return pop;
}
function prunePopoverPlacementFrom(depth=0){
  if(!popoverPlacementState)return;
  for(const d of [...popoverPlacementState.layers.keys()])if(d>=depth)popoverPlacementState.layers.delete(d);
  if(depth<=0||!popoverPlacementState.layers.has(0))popoverPlacementState=null;
}
function hidePopoversFrom(depth=0){cancelPopoverOpenFrom(depth);let held=false;document.querySelectorAll('.hoverPopover').forEach(pop=>{const d=Number(pop.dataset.depth||0);if(d>=depth){if(mediaPopoverHold&&holdChainElements().includes(pop)){held=true;return}pop.hidden=true;popoverAnchors.delete(d);popoverKeyboardAnchors.delete(d);delete pop.dataset.placementMode;delete pop.dataset.placementDirection}});if(!held||depth>0)prunePopoverPlacementFrom(depth);scheduleLiveReevaluation(0)}
function popoverAnchorRect(anchor,keyboard=false){
  const focusRect=keyboard?anchor?.getBoundingClientRect?.():null,pointer=keyboard?null:lastPointer;
  const chosen=focusRect||chooseClientRect(anchor?.getClientRects?.()||[],pointer,{keyboard:false});
  const r=chosen||anchor?.getBoundingClientRect?.();
  return r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null;
}
function popoverOpenPoint(anchorRect,keyboard=false){
  if(keyboard||lastPointer.kind==='keyboard')return {x:(anchorRect.left+anchorRect.right)/2,y:(anchorRect.top+anchorRect.bottom)/2,kind:'keyboard'};
  return {x:lastPointer.x,y:lastPointer.y,kind:'pointer'};
}
function popoverPosition(pop,anchor,depth=Math.min(4,popoverDepthForAnchor(anchor))){
  const keyboard=lastPointer.kind==='keyboard',anchorRect=popoverAnchorRect(anchor,keyboard);if(!anchorRect)return null;
  pop.hidden=false;const pr=pop.getBoundingClientRect(),pointer=popoverOpenPoint(anchorRect,keyboard),parent=depth>0?document.querySelector(`.hoverPopover[data-depth="${depth-1}"]:not([hidden])`):null,parentRect=parent?.getBoundingClientRect?.()||null;
  if(depth===0||!popoverPlacementState){popoverPlacementState={primaryDirection:null,rootRect:null,rootPointer:{...pointer},paneId:String(pop.dataset.paneId||''),layers:new Map()}}
  const placement=choosePopoverPlacement({anchorRect,parentRect,popSize:{width:pr.width,height:pr.height},viewport:{width:window.innerWidth,height:window.innerHeight},primaryDirection:popoverPlacementState.primaryDirection,depth,pointer});
  if(depth===0){popoverPlacementState.primaryDirection=placement.primaryDirection;popoverPlacementState.rootRect={left:placement.left,top:placement.top,right:placement.right,bottom:placement.bottom,width:placement.width,height:placement.height};popoverPlacementState.rootPointer={...pointer}}
  pop.style.left=`${placement.left}px`;pop.style.top=`${placement.top}px`;pop.dataset.placementMode=placement.mode;pop.dataset.placementDirection=placement.direction;
  const layer={depth,anchorRect:{...anchorRect},parentRect:parentRect?{left:parentRect.left,top:parentRect.top,right:parentRect.right,bottom:parentRect.bottom,width:parentRect.width,height:parentRect.height}:null,pointer:{...pointer},placement:{left:placement.left,top:placement.top,right:placement.right,bottom:placement.bottom,width:placement.width,height:placement.height,mode:placement.mode,direction:placement.direction}};
  popoverPlacementState.layers.set(depth,layer);return layer;
}
function compactPostForPopover(p,post,current=false){const d=parseDateParts(post.date||post.meta||'');const hn=displayHn(p.board,post.name||'');const id=cleanPostId(post.id||'');const plan=mediaDisplayPlan(post),postKey=String(post.key||post.n||'');return `<div class="popoverPost ${current?'current':''}" data-post-key="${esc(postKey)}" data-post-no="${esc(post.n||'')}"><div class="popoverMeta"><b>${esc(post.n)}</b>${hn?`<span>${esc(hn)}</span>`:''}${id?`<span class="postIdText">ID:${esc(id)}</span>`:''}${d.time?`<span>${esc(d.time)}</span>`:''}</div><div class="popoverBody">${renderBody(post,plan)}</div>${attachmentsHtml(post,plan)}${previewPlaceholders(post,plan)}</div>`}
function showPopover(anchor,p,html){clearTimeout(popoverHideTimer);const depth=Math.min(4,popoverDepthForAnchor(anchor));hidePopoversFrom(depth);const pop=ensurePopover(depth);popoverAnchors.set(depth,anchor);pop.dataset.paneId=p.paneId;pop.innerHTML=html;popoverPosition(pop,anchor,depth);hydratePreviews(pop);fitAsciiArt(pop)}
function showQuotePopover(anchor,p,targetNo){const post=p?.postMap?.get(String(targetNo));if(!post)return;showPopover(anchor,p,`<div class="popoverTitle">引用元</div>${compactPostForPopover(p,post,true)}`)}
function showIdPopover(anchor,p,id){
  id=cleanPostId(id);if(!p||!id)return;const same=(p.posts||[]).filter(post=>cleanPostId(post.id||'')===id);if(!same.length)return;const shown=same.slice(-24);
  showPopover(anchor,p,`<div class="popoverTitle">ID:${esc(id)} · ${same.length}件</div>${shown.map(post=>compactPostForPopover(p,post,false)).join('')}${same.length>shown.length?`<div class="popoverMore">直近${shown.length}件を表示</div>`:''}`);
}
function connectedPosts(p,startNo){
  const start=String(startNo),indexed=p.quoteComponentByPost?.get(start);if(indexed?.members)return indexed.members;
  const seen=new Set([start]),queue=[start];
  while(queue.length){const n=queue.shift(),post=p.postMap.get(n);if(!post)continue;for(const x of [...(post.quoteTargets||[]),...(post.backrefs||[])]){const key=String(x);if(p.postMap.has(key)&&!seen.has(key)){seen.add(key);queue.push(key)}}}
  return seen;
}
let quoteTreeInstanceSeq=0;
function quoteTreeSortNos(a,b){return String(a).localeCompare(String(b),'ja',{numeric:true,sensitivity:'base'})}
function quoteTreeNodeKey(post){return String(post?.key||post?.n||'')}
function renderQuoteTree(p,startNo){
  const comp=connectedPosts(p,startNo),children=new Map(),incoming=new Map();
  for(const n of comp){const post=p.postMap.get(n);for(const t of (post?.quoteTargets||[])){const parent=String(t),child=String(n);if(!comp.has(parent)||parent===child&&comp.size===1)continue;if(!children.has(parent))children.set(parent,[]);if(!children.get(parent).includes(child))children.get(parent).push(child);if(!incoming.has(child))incoming.set(child,[]);if(!incoming.get(child).includes(parent))incoming.get(child).push(parent)}}
  for(const list of children.values())list.sort(quoteTreeSortNos);for(const list of incoming.values())list.sort(quoteTreeSortNos);
  const start=String(startNo),rendered=new Set(),parts=[];let roots=[...comp].filter(n=>!(incoming.get(n)||[]).length).sort(quoteTreeSortNos);if(!roots.length&&comp.has(start))roots=[start];
  const indentFor=depth=>Math.min(36,Math.max(0,Number(depth)||0)*12);
  const reference=(n,depth)=>`<div class="treeReferenceRow" style="--tree-indent:${indentFor(depth)}px"><a href="#" class="treeReference" data-quote-target="${esc(n)}">参照 No.${esc(n)}</a></div>`;
  function branch(n,depth=0){
    if(rendered.has(n)){parts.push(reference(n,depth));return}rendered.add(n);const post=p.postMap.get(n);if(!post)return;
    const key=quoteTreeNodeKey(post),indent=indentFor(depth),current=String(n)===start;
    parts.push(`<div class="treeNode" data-tree-node-key="${esc(key)}" data-tree-post-no="${esc(n)}" data-tree-depth="${depth}" style="--tree-indent:${indent}px">${compactPostForPopover(p,post,current)}</div>`);
    for(const child of (children.get(n)||[]))branch(child,depth+1);
  }
  for(const root of roots)branch(root,0);for(const n of [...comp].sort(quoteTreeSortNos))if(!rendered.has(n))branch(n,0);return parts.join('');
}
function showTreePopover(anchor,p,startNo){
  clearTimeout(popoverHideTimer);const depth=Math.min(4,popoverDepthForAnchor(anchor)),pop=ensurePopover(depth);
  hidePopoversFrom(depth);popoverAnchors.set(depth,anchor);pop.dataset.paneId=p.paneId;pop.dataset.quoteTreeInstance=String(++quoteTreeInstanceSeq);const count=connectedPosts(p,startNo).size;pop.innerHTML=`<div class="popoverTitle">引用ツリー · ${count}件</div><div class="quoteTree">${renderQuoteTree(p,startNo)}</div>`;popoverPosition(pop,anchor,depth);hydratePreviews(pop);fitAsciiArt(pop);
}
function setKeyboardPopoverAnchor(depth,anchor){for(const d of [...popoverKeyboardAnchors.keys()])if(d>=depth)popoverKeyboardAnchors.delete(d);popoverKeyboardAnchors.set(depth,anchor)}
function keyboardPopoverDepth(){const active=document.activeElement;if(!active)return -1;let deepest=-1,maxHeld=-1;for(const [d,anchor] of [...popoverKeyboardAnchors]){const pop=document.querySelector(`.hoverPopover[data-depth="${d}"]`);if(!anchor?.isConnected||!pop||pop.hidden){popoverKeyboardAnchors.delete(d);continue}maxHeld=Math.max(maxHeld,d);if(active===anchor||anchor.contains?.(active))deepest=Math.max(deepest,d)}if(maxHeld>=0)for(const pop of document.querySelectorAll('.hoverPopover:not([hidden])')){const d=Number(pop.dataset.depth||0);if(pop===active||pop.contains(active))deepest=Math.max(deepest,Math.min(d,maxHeld))}return deepest}
function schedulePopoverCleanup(){clearTimeout(popoverHideTimer);popoverHideTimer=setTimeout(()=>{if(mediaPopoverHold&&['mediaOpen','awaitReturn'].includes(mediaPopoverHold.phase))return;let deepest=keyboardPopoverDepth();document.querySelectorAll('.hoverPopover:not([hidden])').forEach(pop=>{const d=Number(pop.dataset.depth||0),anchor=popoverAnchors.get(d);if(pop.matches(':hover')||anchor?.matches?.(':hover'))deepest=Math.max(deepest,d)});if(deepest<0)hidePopoversFrom(0);else hidePopoversFrom(deepest+1)},140)}
function triggerPopoverFor(el){
  const tree=el.closest('[data-tree-post]');if(tree){const p=paneForElement(tree);if(p)showTreePopover(tree,p,tree.dataset.treePost);return}
  const q=el.closest('[data-quote-target]');if(q){const p=paneForElement(q);if(p)showQuotePopover(q,p,q.dataset.quoteTarget);return}
  const id=el.closest('[data-post-id]');if(id){const p=paneForElement(id);if(p)showIdPopover(id,p,id.dataset.postId)}
}
function closeDeepestPopover(restoreFocus=true){const open=[...document.querySelectorAll('.hoverPopover:not([hidden])')];if(!open.length)return false;const depth=Math.max(...open.map(pop=>Number(pop.dataset.depth||0))),anchor=popoverAnchors.get(depth)||popoverKeyboardAnchors.get(depth);if(mediaPopoverHold&&mediaPopoverHold.ownerDepth>=depth)releaseMediaPopoverHold(false);hidePopoversFrom(depth);if(restoreFocus&&anchor?.isConnected){try{anchor.focus?.({preventScroll:true})}catch{anchor.focus?.()}}return true}
document.addEventListener('click',e=>{const trigger=e.target.closest?.('[data-tree-post],[data-quote-target],[data-post-id]');if(trigger){e.preventDefault();cancelPopoverOpen(trigger);triggerPopoverFor(trigger);return}if(!e.target.closest?.('.hoverPopover'))schedulePopoverCleanup()});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('[data-tree-post],[data-quote-target],[data-post-id]')){e.preventDefault();lastPointer.kind='keyboard';const trigger=e.target,depth=Math.min(4,popoverDepthForAnchor(trigger));cancelPopoverOpen(trigger);triggerPopoverFor(trigger);const pop=document.querySelector(`.hoverPopover[data-depth="${depth}"]`);if(pop&&!pop.hidden)setKeyboardPopoverAnchor(depth,trigger)}});
document.addEventListener('pointerover',e=>{
  const trigger=e.target.closest('[data-tree-post],[data-quote-target],[data-post-id]');if(!trigger||trigger.contains(e.relatedTarget))return;
  lastPointer.kind='pointer';const depth=Math.min(4,popoverDepthForAnchor(trigger)),current=popoverAnchors.get(depth);if(current&&current!==trigger)schedulePopoverCleanup();else clearTimeout(popoverHideTimer);schedulePopoverOpen(trigger,()=>triggerPopoverFor(trigger));
});
document.addEventListener('pointerout',e=>{
  const trigger=e.target.closest('[data-tree-post],[data-quote-target],[data-post-id]');if(trigger&&!trigger.contains(e.relatedTarget)){cancelPopoverOpen(trigger);schedulePopoverCleanup()}
});
document.addEventListener('focusin',schedulePopoverCleanup);
document.addEventListener('focusout',schedulePopoverCleanup);
$('#hoverPopover')?.addEventListener('pointerenter',e=>handlePopoverPointerEnter(e.currentTarget,e));
$('#hoverPopover')?.addEventListener('pointerleave',schedulePopoverCleanup);


document.addEventListener('pointermove',e=>{lastPointer={x:e.clientX,y:e.clientY,kind:'pointer'};if(mediaPopoverHold?.phase==='awaitReturn'&&mediaHoldOwnerContainsTarget(e.target))markMediaHoldReturned(e.target,false)},{passive:true});
document.addEventListener('keydown',()=>{lastPointer.kind='keyboard'},{capture:true});
document.addEventListener('pointerdown',e=>{if(mediaPopoverHold?.phase==='awaitReturn'&&!e.target.closest?.('.lightbox')&&!mediaHoldOwnerContainsTarget(e.target)){releaseMediaPopoverHold(true)}},true);
const EDGE_RANK_MIN_POSTS=30;
function tickerFeedState(feed=hotFeed){return tickerState.feeds[HOT_FEEDS[feed]?feed:'edge']}
function tickerFeedConfig(feed=hotFeed){return HOT_FEEDS[feed]||HOT_FEEDS.edge}
function edgeRankScore(t){const count=Number(t.count)||0,heat=Number(t.heat)||0;if(count<EDGE_RANK_MIN_POSTS)return -1;return heat}
function tickerEventKey(t,feed=hotFeed){return `${feed}:${t.key}`}
function tickerEventFor(t,feed=hotFeed){return tickerEvents.get(tickerEventKey(t,feed))||null}
function logTickerEvent(feed,type,data={}){const state=tickerFeedState(feed),entry={at:Date.now(),type,...data};state.eventLog.push(entry);if(state.eventLog.length>120)state.eventLog.splice(0,state.eventLog.length-120);return entry}
function makeTickerEvent(type,delta=0){return {type,delta,detectedAt:Date.now(),periodPx:0,progressPx:0,started:false,displayStartedAt:0,lastVisible:false,seenAfterCycle:false,singleVisibleMs:0,lastTick:0,present:true}}
function tickerProgressPaused(){return toolbarMode!=='hot'||document.hidden||!$('#lightbox')?.hidden||tickerState.pointerInside||tickerState.manualActive||performance.now()<tickerState.resumeAfter||matchMedia('(prefers-reduced-motion: reduce)').matches}
function advanceTickerEventDistance(delta,feed=hotFeed){delta=Math.max(0,Number(delta)||0);if(!delta)return;for(const [key,e] of tickerEvents){if(!key.startsWith(feed+':')||!e.present||!e.started)continue;if(!(e.periodPx>0)&&tickerState.cycleWidth>0)e.periodPx=tickerState.cycleWidth;e.progressPx+=delta}}

function tickerStatText(t,feed=hotFeed){return feed==='futaba'?`${(t.count||0).toLocaleString()}res`:`${(t.heat||0).toLocaleString()}/day · ${(t.count||0).toLocaleString()}res`}
function tickerItemHtml(t,rank,{feed=hotFeed,cycle=0,logical=false}={}){const may=feed==='futaba',thumb=may&&t.image?safeUrl(t.image):'',tab=logical?'':' tabindex="-1" aria-hidden="true"',logicalAttr=logical?' data-logical-copy="1"':'';return `<button class="rankItem${may?' mayRankItem':''}" data-open-url="${esc(t.url)}" data-thread-key="${esc(t.key)}" data-thread-url="${esc(t.url)}" data-title-needs-completion="${may&&t.titleNeedsCompletion?'1':'0'}" data-feed="${feed}" data-cycle="${cycle}"${logicalAttr}${tab} title="${esc(t.title||'')}">${may?`<span class="tickerThumbWrap">${thumb?`<img class="tickerThumb" loading="lazy" src="${esc(boardMediaSrc(thumb))}" alt=""><span class="tickerThumbFallback" aria-hidden="true">画像なし</span>`:`<span class="tickerThumbFallback noImage" aria-hidden="true">画像なし</span>`}</span>`:''}<span class="rankNo">${rank}</span><span class="rankMain"><span class="rankTitle">${esc(t.title)}</span><span class="rankStats">${esc(tickerStatText(t,feed))}</span></span><span class="rankMove"></span></button>`}
const TICKER_CARD_WIDTH=220;
const TICKER_GAP=4;
const TICKER_AUTO_SPEED=48;
function tickerItemSpan(){return TICKER_CARD_WIDTH+TICKER_GAP}
function tickerPeriodWidth(itemCount){return Math.max(0,Number(itemCount)||0)*tickerItemSpan()}
function tickerCycleCopies(itemCount,viewportWidth=0,cycleWidth=0){if(itemCount<=1)return 1;const width=cycleWidth>0?cycleWidth:tickerPeriodWidth(itemCount);if(viewportWidth>0&&width>0)return Math.max(3,Math.ceil(viewportWidth/width)+2);return itemCount<=3?5:3}
function tickerWrappedScrollLeft(left,delta,centerStart,cycleWidth){let next=(Number(left)||0)+(Number(delta)||0);if(!(cycleWidth>0))return next;while(next>=centerStart+cycleWidth)next-=cycleWidth;while(next<centerStart)next+=cycleWidth;return next}
function tickerNormalizePhase(value,width=tickerState.cycleWidth){value=Number(value)||0;if(!(width>0))return 0;value%=width;if(value<0)value+=width;return value}
function tickerAnimationTime(){const a=tickerState.animation,t=Number(a?.currentTime);return Number.isFinite(t)?t:null}
function tickerCurrentPhase(){const width=Number(tickerState.cycleWidth)||0,duration=Number(tickerState.animationDuration)||0,time=tickerAnimationTime();let phase=Number(tickerState.logicalPhase)||0;if(width>0&&duration>0&&time!=null)phase=tickerNormalizePhase((time%duration)/duration*width,width);tickerState.logicalPhase=tickerNormalizePhase(phase,width);tickerState.logicalScrollLeft=tickerState.logicalPhase;return tickerState.logicalPhase}
function tickerSetPhase(phase){const width=Number(tickerState.cycleWidth)||0;phase=tickerNormalizePhase(phase,width);tickerState.logicalPhase=phase;tickerState.logicalScrollLeft=phase;const a=tickerState.animation,duration=Number(tickerState.animationDuration)||0;if(a&&duration>0){try{a.currentTime=phase/width*duration}catch{}}tickerState.eventMotionTime=tickerAnimationTime();return phase}
function tickerScrollMax(track){return Math.max(0,(tickerState.cycleWidth||0)-(tickerState.viewportWidth||track?.parentElement?.clientWidth||0))}
function tickerCycleStart(){return 0}
function measureTickerCycleWidth(){return Number(tickerState.cycleWidth)||tickerPeriodWidth((tickerState.compositionKeys||[]).length)}
function tickerPhaseAnchor(order=tickerState.compositionKeys,phase=tickerCurrentPhase()){order=(order||[]).map(String);if(!order.length)return {key:'',offset:0,scrollLeft:0,phase:0,index:0,order:[]};const span=tickerItemSpan(),normalized=tickerNormalizePhase(phase,tickerPeriodWidth(order.length)),index=Math.max(0,Math.min(order.length-1,Math.floor(normalized/span)));return {key:order[index]||order[0],offset:normalized-index*span,scrollLeft:normalized,phase:normalized,index,order:[...order]}}
function captureTickerAnchor(track){const order=(tickerState.compositionKeys?.length?tickerState.compositionKeys:tickerLogicalKeys(track));return tickerPhaseAnchor(order,tickerCurrentPhase())}
function tickerPhaseForAnchor(anchor,nextKeys){nextKeys=(nextKeys||[]).map(String);if(!nextKeys.length)return 0;const key=nearestSurvivingTickerKey(anchor,nextKeys),index=Math.max(0,nextKeys.indexOf(key)),offset=Math.max(0,Math.min(tickerItemSpan()-.001,Number(anchor?.offset)||0));return tickerNormalizePhase(index*tickerItemSpan()+offset,tickerPeriodWidth(nextKeys.length))}
function syncTickerLogicalFromDom(track){const legacy=Number(track?.scrollLeft)||0;if(Math.abs(legacy)>.001&&!tickerState.pointerDown)return tickerSetPhase(legacy);return tickerCurrentPhase()}
function setTickerScrollLeft(track,left){return tickerSetPhase(left)}
function restoreTickerAnchor(track,anchor){if(!track||!anchor)return;const keys=(tickerState.compositionKeys?.length?tickerState.compositionKeys:tickerLogicalKeys(track)),phase=tickerPhaseForAnchor(anchor,keys);tickerState.restoreDepth++;tickerSetPhase(phase);tickerState.restoreDepth=Math.max(0,tickerState.restoreDepth-1)}
function normalizeTickerPosition(track,{force=false}={}){if(!track||tickerState.cycleCount<=1)return;if(!force&&(tickerState.manualActive||tickerState.scrolling))return;tickerSetPhase(tickerCurrentPhase())}
function updateTickerCard(el,t,rank,feed=hotFeed){el.dataset.openUrl=t.url;el.dataset.threadKey=t.key;el.dataset.threadUrl=t.url||'';el.dataset.titleNeedsCompletion=feed==='futaba'&&t.titleNeedsCompletion?'1':'0';el.dataset.feed=feed;el.title=t.title||'';el.querySelector('.rankNo').textContent=String(rank);el.querySelector('.rankTitle').textContent=t.title||'';el.querySelector('.rankStats').textContent=tickerStatText(t,feed);const e=tickerEventFor(t,feed),move=el.querySelector('.rankMove');el.classList.toggle('rankEvent',!!e);el.classList.toggle('newRank',e?.type==='new');move.textContent=e?.type==='new'?'NEW':e?.type==='up'?`↑${Math.min(99,e.delta)}`:'';move.className=`rankMove ${e?.type==='new'?'rankNew':e?.type==='up'?'rankUp':''}`;if(feed==='futaba'){const wrap=el.querySelector('.tickerThumbWrap'),src=t.image?safeUrl(t.image):'',resolved=src?boardMediaSrc(src):'',fallback=wrap?.querySelector('.tickerThumbFallback');let img=wrap?.querySelector('.tickerThumb');if(wrap&&resolved&&!img){img=document.createElement('img');img.className='tickerThumb';img.loading='lazy';img.alt='';wrap.insertBefore(img,fallback||wrap.firstChild)}if(img&&resolved&&img.getAttribute('src')!==resolved)img.setAttribute('src',resolved);if(img&&!resolved)img.remove();if(fallback)fallback.classList.toggle('noImage',!resolved)}}
function tickerLogicalKeys(track){if(tickerState.compositionKeys?.length)return [...tickerState.compositionKeys];return [...(track?.querySelectorAll?.('.rankItem[data-logical-copy="1"][data-thread-key]')||[])].map(el=>String(el.dataset.threadKey||''))}
function tickerViewportWidth(track){return Number(track?.parentElement?.clientWidth)||Number(tickerState.viewportWidth)||0}
function tickerCanUpdateInPlace(track,top){if(!track||!top.length||tickerFeedState().restoreAnchor)return false;const first=track.querySelector('.rankItem[data-thread-key]');if(first&&first.dataset.feed!==hotFeed)return false;const keys=tickerLogicalKeys(track),next=top.map(t=>String(t.key));if(keys.length!==next.length||keys.some((k,i)=>k!==next[i]))return false;const expected=top.length*Math.max(1,tickerState.cycleCount);return track.querySelectorAll('.rankItem[data-thread-key]').length===expected}
function updateTickerCardsInPlace(track,top,feed=hotFeed){const byKey=new Map(top.map((t,i)=>[String(t.key),{t,rank:i+1}]));track.querySelectorAll('.rankItem[data-thread-key]').forEach(el=>{const row=byKey.get(String(el.dataset.threadKey||''));if(row)updateTickerCard(el,row.t,row.rank,feed)});bindTickerClicks(top,feed);bindTickerThumbErrors(track)}
function tickerCreateCard(t,rank,{feed=hotFeed,cycle=0,logical=false}={}){const template=document.createElement('template');template.innerHTML=tickerItemHtml(t,rank,{feed,cycle,logical}).trim();return template.content.firstElementChild}
function patchTickerCycles(track,top,feed,cycleCount){const existing=new Map();track.querySelectorAll('.rankItem[data-thread-key]').forEach(el=>existing.set(`${el.dataset.feed||''}:${el.dataset.cycle||0}:${el.dataset.threadKey||''}`,el));const frag=document.createDocumentFragment();for(let cycle=0;cycle<cycleCount;cycle++){for(let i=0;i<top.length;i++){const t=top[i],key=String(t.key),mapKey=`${feed}:${cycle}:${key}`,logical=cycle===0;let el=existing.get(mapKey);if(!el)el=tickerCreateCard(t,i+1,{feed,cycle,logical});existing.delete(mapKey);el.dataset.cycle=String(cycle);if(logical){el.dataset.logicalCopy='1';el.removeAttribute('aria-hidden');el.tabIndex=0}else{delete el.dataset.logicalCopy;el.setAttribute('aria-hidden','true');el.tabIndex=-1}updateTickerCard(el,t,i+1,feed);frag.appendChild(el)}}track.replaceChildren(frag);bindTickerClicks(top,feed);bindTickerThumbErrors(track)}
function bindTickerClicks(snapshot,feed=hotFeed){const byKey=new Map(snapshot.map(x=>[String(x.key),x]));$$('#tickerTrack [data-thread-key]').forEach(el=>el.onclick=()=>{const t=byKey.get(el.dataset.threadKey);if(t)addPane({...t,board:t.board||tickerFeedConfig(feed).board})})}
function bindTickerThumbErrors(track){track?.querySelectorAll?.('.tickerThumb').forEach(img=>{if(img.dataset.boundError==='1')return;img.dataset.boundError='1';img.addEventListener('error',()=>img.closest('.tickerThumbWrap')?.classList.add('imageError'));img.addEventListener('load',()=>img.closest('.tickerThumbWrap')?.classList.remove('imageError'))})}
function tickerAutoPaused(track){const count=tickerFeedState().rankSnapshot.length;return !track||count<=1||toolbarMode!=='hot'||document.hidden||!$('#lightbox')?.hidden||tickerState.pointerInside||tickerState.manualActive||performance.now()<tickerState.resumeAfter||matchMedia('(prefers-reduced-motion: reduce)').matches}
function tickerAutoAdvance(logical,dt,start,width){return tickerWrappedScrollLeft(logical,TICKER_AUTO_SPEED*Math.max(0,Number(dt)||0)/1000,start,width)}
function cancelTickerResumeTimer(){if(tickerState.resumeTimer){clearTimeout(tickerState.resumeTimer);tickerState.resumeTimer=0}}
function scheduleTickerResume(track){cancelTickerResumeTimer();const delay=Math.max(0,(Number(tickerState.resumeAfter)||0)-performance.now());if(delay>0&&Number.isFinite(delay))tickerState.resumeTimer=setTimeout(()=>{tickerState.resumeTimer=0;syncTickerAnimationPlayback(track)},delay+8)}
function syncTickerAnimationPlayback(track=$('#tickerTrack')){const a=tickerState.animation;if(!a)return;const paused=tickerAutoPaused(track);try{if(paused){if(a.playState!=='paused')a.pause();tickerState.eventMotionTime=tickerAnimationTime();scheduleTickerResume(track)}else{cancelTickerResumeTimer();if(a.playState!=='running')a.play();tickerState.eventMotionTime=tickerAnimationTime()}}catch{}}
function stopTickerAnimation(track=$('#tickerTrack')){cancelTickerResumeTimer();const a=tickerState.animation;const phase=tickerCurrentPhase();try{a?.cancel?.()}catch{}tickerState.animation=null;tickerState.animationDuration=0;tickerState.eventMotionTime=null;tickerState.logicalPhase=phase;tickerState.logicalScrollLeft=phase;if(track)track.style.transform='translate3d(0,0,0)'}
function startTickerAnimation(track,phase=0){if(!track)return;const width=Number(tickerState.cycleWidth)||0;if(!(width>0)||tickerState.cycleCount<=1||tickerState.compositionKeys.length<=1||typeof track.animate!=='function'){stopTickerAnimation(track);tickerSetPhase(0);return}const duration=width/TICKER_AUTO_SPEED*1000;try{tickerState.animation?.cancel?.()}catch{}track.style.transform='';const animation=track.animate([{transform:'translate3d(0,0,0)'},{transform:`translate3d(-${width}px,0,0)`}],{duration,iterations:Infinity,easing:'linear',fill:'both'});tickerState.animation=animation;tickerState.animationDuration=duration;tickerState.animationGeneration=(Number(tickerState.animationGeneration)||0)+1;try{animation.pause();animation.currentTime=tickerNormalizePhase(phase,width)/width*duration}catch{}tickerState.logicalPhase=tickerNormalizePhase(phase,width);tickerState.logicalScrollLeft=tickerState.logicalPhase;tickerState.eventMotionTime=tickerAnimationTime();syncTickerAnimationPlayback(track)}
function ensureTickerAutoScroll(){syncTickerAnimationPlayback($('#tickerTrack'))}
function shiftTickerPhase(delta,{manual=true}={}){const track=$('#tickerTrack');if(!track||!(tickerState.cycleWidth>0))return 0;if(manual)markTickerManual('direct');const next=tickerSetPhase(tickerCurrentPhase()+(Number(delta)||0));syncTickerAnimationPlayback(track);return next}
function markTickerManual(kind='wheel'){tickerState.manualActive=true;tickerState.resumeAfter=Infinity;clearTimeout(tickerState.manualTimer);syncTickerAnimationPlayback($('#tickerTrack'));if(kind==='wheel')tickerState.manualTimer=setTimeout(()=>releaseTickerManual(),220)}
function releaseTickerManual(){if(tickerState.pointerDown)return;if(!tickerState.manualActive){tickerState.resumeAfter=0;syncTickerAnimationPlayback($('#tickerTrack'));return}tickerState.manualActive=false;tickerState.resumeAfter=performance.now()+240;tickerState.eventMotionTime=tickerAnimationTime();scheduleTickerResume($('#tickerTrack'));applyPendingTickerSnapshot()}
function bindTickerTrack(){const track=$('#tickerTrack');if(!track||track.dataset.bound==='1')return;track.dataset.bound='1';track.addEventListener('pointerenter',()=>{tickerState.pointerInside=true;syncTickerAnimationPlayback(track)});track.addEventListener('pointerleave',()=>{tickerState.pointerInside=false;if(!tickerState.manualActive)tickerState.resumeAfter=0;syncTickerAnimationPlayback(track)});track.addEventListener('wheel',e=>{const dx=Math.abs(Number(e.deltaX)||0)>=Math.abs(Number(e.deltaY)||0)?Number(e.deltaX)||0:(e.shiftKey?Number(e.deltaY)||0:0);if(!dx)return;e.preventDefault();markTickerManual('wheel');tickerSetPhase(tickerCurrentPhase()+dx);syncTickerAnimationPlayback(track)},{passive:false});track.addEventListener('pointerdown',e=>{if(e.button!=null&&e.button!==0)return;tickerState.pointerDown=true;tickerState.dragPointerId=e.pointerId;tickerState.dragStartX=e.clientX;tickerState.dragStartPhase=tickerCurrentPhase();markTickerManual('pointer');try{track.setPointerCapture?.(e.pointerId)}catch{}});track.addEventListener('pointermove',e=>{if(!tickerState.pointerDown||e.pointerId!==tickerState.dragPointerId)return;const dx=tickerState.dragStartX-e.clientX;if(Math.abs(dx)<1)return;tickerSetPhase(tickerState.dragStartPhase+dx);e.preventDefault()});const finishPointer=e=>{if(!tickerState.pointerDown||e.pointerId!==tickerState.dragPointerId)return;tickerState.pointerDown=false;tickerState.dragPointerId=null;try{track.releasePointerCapture?.(e.pointerId)}catch{}clearTimeout(tickerState.manualTimer);tickerState.manualTimer=setTimeout(()=>releaseTickerManual(),120)};track.addEventListener('pointerup',finishPointer);track.addEventListener('pointercancel',finishPointer);track.addEventListener('focusin',e=>{const item=e.target.closest?.('.rankItem[data-logical-copy="1"]');if(!item)return;const keys=tickerState.compositionKeys||[],index=keys.indexOf(String(item.dataset.threadKey||''));if(index<0)return;const phase=tickerCurrentPhase(),period=tickerState.cycleWidth||1,left=tickerNormalizePhase(index*tickerItemSpan()-phase,period),visible=left<tickerState.viewportWidth||left>period-TICKER_CARD_WIDTH;if(!visible){markTickerManual('key');tickerSetPhase(index*tickerItemSpan());tickerState.manualTimer=setTimeout(()=>releaseTickerManual(),240)}});track.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();markTickerManual('key');tickerSetPhase(tickerCurrentPhase()+(e.key==='ArrowRight'?1:-1)*tickerItemSpan());tickerState.manualTimer=setTimeout(()=>releaseTickerManual(),240)});ensureTickerAutoScroll()}
function tickerEmptyText(feed=hotFeed,error=''){if(error)return `${tickerFeedConfig(feed).label} 更新失敗`;return feed==='futaba'?'ふたばMayカタログを取得中…':'30レス以上のエッヂ上位スレを集計中…'}
function updateTickerFeedStatus(feed=hotFeed){const status=$('#tickerFeedStatus'),state=tickerFeedState(feed);if(!status)return;status.hidden=!state.error;status.textContent=state.error?'更新失敗':'';status.title=state.error||''}
function renderTicker(){const track=$('#tickerTrack');if(!track)return;bindTickerTrack();const state=tickerFeedState(),top=(state.rankSnapshot||[]).slice(0,tickerFeedConfig().limit);++tickerState.renderToken;updateTickerFeedStatus();const viewportWidth=tickerViewportWidth(track);if(!top.length){stopTickerAnimation(track);tickerState.cycleCount=1;tickerState.centerCycle=0;tickerState.cycleWidth=0;tickerState.viewportWidth=viewportWidth;tickerState.compositionKeys=[];tickerState.logicalPhase=0;tickerState.logicalScrollLeft=0;const empty=document.createElement('span');empty.className='tickerEmpty';empty.textContent=tickerEmptyText(hotFeed,state.error);track.replaceChildren(empty);return}const nextKeys=top.map(t=>String(t.key)),period=tickerPeriodWidth(top.length),desiredCopies=tickerCycleCopies(top.length,viewportWidth,period),liveAnchor=captureTickerAnchor(track),renderAnchor=takeTickerRenderAnchor(state,liveAnchor),anchor=renderAnchor.anchor?.key?renderAnchor.anchor:{key:nextKeys[0],offset:0,scrollLeft:0,phase:0,index:0,order:[...nextKeys]},sameKeys=tickerCanUpdateInPlace(track,top),sameViewport=Math.abs((Number(tickerState.viewportWidth)||0)-viewportWidth)<.5,sameCopies=tickerState.cycleCount===desiredCopies;if(sameKeys&&sameViewport&&sameCopies){tickerState.viewportWidth=viewportWidth;updateTickerCardsInPlace(track,top,hotFeed);syncTickerAnimationPlayback(track);updateTickerVisibleEvents();if(hotFeed==='futaba')observeFutabaTitleCandidates(track);return}const phase=tickerPhaseForAnchor(anchor,nextKeys);tickerState.cycleCount=desiredCopies;tickerState.centerCycle=0;tickerState.cycleWidth=period;tickerState.viewportWidth=viewportWidth;tickerState.compositionKeys=[...nextKeys];patchTickerCycles(track,top,hotFeed,desiredCopies);startTickerAnimation(track,phase);for(const [key,e] of tickerEvents)if(key.startsWith(hotFeed+':')&&!(e.periodPx>0)&&period>0)e.periodPx=period;if(renderAnchor.reason==='saved-restore')commitTickerRestoreAnchor(state,renderAnchor.anchor);updateTickerVisibleEvents();if(hotFeed==='futaba')observeFutabaTitleCandidates(track)}
function applyTickerSnapshot(snapshot,feed=hotFeed){const state=tickerFeedState(feed);state.rankSnapshot=(snapshot||[]).slice(0,tickerFeedConfig(feed).limit);state.pendingSnapshot=null;if(feed===hotFeed)renderTicker()}
function applyPendingTickerSnapshot(){const state=tickerFeedState();if(toolbarMode!=='hot'||tickerState.scrolling||tickerState.manualActive||!state.pendingSnapshot)return;const latest=state.pendingSnapshot;state.pendingSnapshot=null;applyTickerSnapshot(latest,hotFeed)}
function queueTickerSnapshot(snapshot,feed=hotFeed){const state=tickerFeedState(feed);if(feed!==hotFeed){state.rankSnapshot=(snapshot||[]).slice(0,tickerFeedConfig(feed).limit);state.pendingSnapshot=null;return}if(toolbarMode==='menu'||tickerState.scrolling||tickerState.manualActive){state.pendingSnapshot=snapshot;return}applyTickerSnapshot(snapshot,feed)}
function detectTickerEvents(snapshot,prior,feed=hotFeed){const state=tickerFeedState(feed),items=Array.isArray(snapshot)?snapshot:[];if(!items.length){logTickerEvent(feed,'ignored-empty-snapshot');return false}const currentKeys=new Set(items.map(t=>String(t.key)));for(const [eventKey,e] of tickerEvents){if(!eventKey.startsWith(feed+':'))continue;const logicalKey=eventKey.slice(feed.length+1);e.present=currentKeys.has(logicalKey);if(!e.present)e.lastTick=0}if(!state.initialized){items.forEach(t=>state.observedKeys.add(String(t.key)));state.normalSnapshotCount=1;logTickerEvent(feed,'initial-snapshot',{count:items.length});return true}for(let i=0;i<items.length;i++){const t=items[i],rank=i+1,logicalKey=String(t.key),prev=prior.get(t.key),eventKey=tickerEventKey(t,feed),existing=tickerEvents.get(eventKey);if(!state.observedKeys.has(logicalKey)){state.observedKeys.add(logicalKey);tickerEvents.set(eventKey,makeTickerEvent('new',0));logTickerEvent(feed,'new',{key:logicalKey,rank})}else if(prev!=null&&prev-rank>0&&existing?.type!=='new'){tickerEvents.set(eventKey,makeTickerEvent('up',prev-rank));logTickerEvent(feed,'up',{key:logicalKey,from:prev,to:rank,delta:prev-rank})}const current=tickerEvents.get(eventKey);if(current)current.present=true}state.normalSnapshotCount++;return true}
function tickerVisibilityByKey(track,{logicalOnly=false}={}){const keys=(tickerState.compositionKeys?.length?tickerState.compositionKeys:tickerLogicalKeys(track)),visible=new Map(),period=Number(tickerState.cycleWidth)||tickerPeriodWidth(keys.length),viewport=Math.max(0,Number(tickerState.viewportWidth)||tickerViewportWidth(track));if(!keys.length||!(period>0)||!(viewport>0))return visible;let phase=tickerCurrentPhase();const legacy=Number(track?.scrollLeft)||0;if(Math.abs(legacy)>.001)phase=tickerNormalizePhase(legacy,period);const overlap=left=>Math.max(0,Math.min(left+TICKER_CARD_WIDTH,viewport)-Math.max(left,0))/TICKER_CARD_WIDTH;for(let i=0;i<keys.length;i++){const rawLeft=i*tickerItemSpan()-phase;if(logicalOnly){visible.set(String(keys[i]),overlap(rawLeft));continue}const left=tickerNormalizePhase(rawLeft,period),ratio=Math.max(overlap(left),overlap(left-period));visible.set(String(keys[i]),ratio)}return visible}
function syncTickerEventDom(track,key,e){const event=!!e,isNew=e?.type==='new',text=isNew?'NEW':e?.type==='up'?`↑${Math.min(99,e.delta)}`:'',className=`rankMove ${isNew?'rankNew':e?.type==='up'?'rankUp':''}`;track.querySelectorAll('.rankItem[data-thread-key]').forEach(el=>{if(el.dataset.threadKey!==key)return;const move=el.querySelector('.rankMove');if(el.classList.contains('rankEvent')!==event)el.classList.toggle('rankEvent',event);if(el.classList.contains('newRank')!==isNew)el.classList.toggle('newRank',isNew);if(move.textContent!==text)move.textContent=text;if(move.className!==className)move.className=className})}
function sampleTickerEventMotion(){const now=tickerAnimationTime();if(now==null){tickerState.eventMotionTime=null;return 0}const last=Number(tickerState.eventMotionTime);tickerState.eventMotionTime=now;if(!Number.isFinite(last)||tickerProgressPaused())return 0;const dt=Math.max(0,now-last),distance=TICKER_AUTO_SPEED*dt/1000;advanceTickerEventDistance(distance);return distance}
function updateTickerVisibleEvents(){if(document.hidden||toolbarMode!=='hot')return;const track=$('#tickerTrack');if(!track)return;const logicalVisible=tickerVisibilityByKey(track,{logicalOnly:true}),writes=[];for(const [eventKey,e] of tickerEvents){if(!eventKey.startsWith(hotFeed+':')||!e.present)continue;const key=eventKey.slice(hotFeed.length+1),visible=(logicalVisible.get(key)||0)>.01;if(!(e.periodPx>0)&&tickerState.cycleWidth>0)e.periodPx=tickerState.cycleWidth;if(visible&&!e.started){e.started=true;e.displayStartedAt=performance.now();e.lastTick=0}if(e.periodPx>0&&e.progressPx>=e.periodPx&&visible)e.seenAfterCycle=true;e.lastVisible=visible;writes.push([key,e])}for(const [key,e] of writes)syncTickerEventDom(track,key,e)}
function tickTickerEventBudget(){const track=$('#tickerTrack');if(!track)return;syncTickerAnimationPlayback(track);if(document.hidden||toolbarMode!=='hot'){tickerState.eventMotionTime=tickerAnimationTime();for(const e of tickerEvents.values())e.lastTick=0;return}sampleTickerEventMotion();const logicalVisible=tickerVisibilityByKey(track,{logicalOnly:true}),now=performance.now(),paused=tickerProgressPaused(),single=tickerFeedState().rankSnapshot.length===1,expired=[],writes=[];for(const [eventKey,e] of tickerEvents){if(!eventKey.startsWith(hotFeed+':'))continue;const key=eventKey.slice(hotFeed.length+1);if(!e.present){e.lastTick=0;e.lastVisible=false;continue}if(!(e.periodPx>0)&&tickerState.cycleWidth>0)e.periodPx=tickerState.cycleWidth;const visible=(logicalVisible.get(key)||0)>.01;if(visible&&!e.started){e.started=true;e.displayStartedAt=now;e.lastTick=now}if(paused||!e.started){e.lastTick=0;e.lastVisible=visible;writes.push([key,e]);continue}if(!e.lastTick)e.lastTick=now;const dt=Math.max(0,now-e.lastTick);e.lastTick=now;if(single&&visible)e.singleVisibleMs+=dt;if(e.periodPx>0&&e.progressPx>=e.periodPx&&visible)e.seenAfterCycle=true;if((single&&e.singleVisibleMs>=12000)||(e.seenAfterCycle&&e.lastVisible&&!visible))expired.push([eventKey,key,e]);else writes.push([key,e]);e.lastVisible=visible}for(const [eventKey,key,e] of expired){tickerEvents.delete(eventKey);logTickerEvent(hotFeed,'expire',{key,eventType:e.type,progressPx:Math.round(e.progressPx),periodPx:Math.round(e.periodPx)});writes.push([key,null])}for(const [key,e] of writes)syncTickerEventDom(track,key,e)}

function saveTickerAnchor(feed=hotFeed){const track=$('#tickerTrack');if(!track)return null;return saveTickerRestoreAnchor(tickerFeedState(feed),captureTickerAnchor(track))}
function updateDrawerHotFeedButton(boardId=activeBoard){const btn=$('#drawerHotFeedButton');if(!btn)return;const supported=!!HOT_FEEDS[boardId];btn.hidden=!supported;if(!supported){btn.setAttribute('aria-pressed','false');btn.textContent='HOTに表示';return}const selected=boardId===hotFeed;btn.setAttribute('aria-pressed',String(selected));btn.textContent=selected?'HOT表示中':'HOTに表示';btn.setAttribute('aria-label',`${boardOf(boardId)?.name||boardId}をHOTに表示`)}
function updateHotFeedControl(){updateDrawerHotFeedButton(activeBoard);$('#toolbarHot')?.setAttribute('aria-label',`${tickerFeedConfig().label} HOT`)}
function setHotFeed(feed,{persist=true,refresh=true}={}){feed=HOT_FEEDS[feed]?feed:'edge';if(feed===hotFeed){updateHotFeedControl();return}saveTickerAnchor(hotFeed);hotFeed=feed;updateHotFeedControl();if(persist){repository.saveUiSettings({hotFeed});scheduleDesktopSave()}renderTicker();if(refresh)void refreshHotFeed(feed)}
async function refreshHotFeed(feed=hotFeed){feed=HOT_FEEDS[feed]?feed:'edge';const state=tickerFeedState(feed),cfg=tickerFeedConfig(feed),epoch=++state.requestEpoch;try{const d=await refreshBoard(cfg.board,'hot',false);if(epoch!==state.requestEpoch)return;let snapshot;if(feed==='edge')snapshot=(d?.threads||[]).filter(t=>isThreadOpenable('edge',t)&&edgeRankScore(t)>=0).sort((a,b)=>edgeRankScore(b)-edgeRankScore(a)).slice(0,cfg.limit).map(t=>({...t,board:'edge'}));else snapshot=boardRows(d,'futaba','hot','').slice(0,cfg.limit).map(t=>({...t,board:'futaba'}));if(!snapshot.length){state.error='空の更新を無視しました';logTickerEvent(feed,'ignored-empty-refresh');if(feed===hotFeed){updateTickerFeedStatus(feed);renderTicker()}return}const prior=state.rankHistory,current=new Map(snapshot.map((t,i)=>[t.key,i+1]));if(!detectTickerEvents(snapshot,prior,feed))return;state.rankHistory=current;state.initialized=true;state.error='';state.lastSuccessAt=Date.now();queueTickerSnapshot(snapshot,feed);if($('#threadDrawer').classList.contains('open')&&activeBoard===cfg.board&&activeSort==='hot')renderThreadList()}catch(e){if(epoch!==state.requestEpoch)return;state.error=String(e?.message||e||'取得失敗');if(feed===hotFeed)renderTicker()}}

function closeTopUi(){if(cancelHistoryGesture('escape'))return true;if(paneDrag){cancelPaneDrag();return true}if(!$('#lightbox').hidden){closeLightbox();return true}if(document.fullscreenElement)return false;if(!$('#headerPopover')?.hidden){closeHeaderPopover();return true}if(!$('#uiTooltip')?.hidden){closeUiTooltip();return true}const openPop=[...document.querySelectorAll('.hoverPopover:not([hidden])')];if(openPop.length){return closeDeepestPopover(true)}if(!$('#markdownPanel')?.hidden){closeMarkdownPanel();return true}if($('#threadDrawer').classList.contains('open')){drawerPinned=false;hideDrawer();return true}const candidate=panes.find(p=>p.uiState?.candidatePanelOpen);if(candidate){candidate.uiState.candidatePanelOpen=false;updateNextCandidateUi(candidate);scheduleLiveReevaluation(0);return true}if(toolbarMode==='menu'){setToolbarMode('hot');return true}if(!$('#markdownDialog')?.hidden){closeMarkdownDialog();return true}if(!$('#settingsMenu').hidden){$('#settingsMenu').hidden=true;return true}return false}
function openLightboxKeyboard(e){const box=$('#lightbox'),open=!!box&&!box.hidden;if(e.key==='Escape'){if(closeTopUi())e.preventDefault();return}if(open){if((e.metaKey||e.ctrlKey)&&(e.key==='['||e.key===']')){e.preventDefault();return}const interactive=e.target?.closest?.('input,textarea,select,[contenteditable],video,iframe');if(!interactive&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){if(moveGallery(e.key==='ArrowLeft'?-1:1))e.preventDefault()}return}if((e.metaKey||e.ctrlKey)&&!e.isComposing&&!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName||'')&&(e.key==='['||e.key===']')){const p=panes.find(x=>x.paneId===lastActivePaneId&&x.kind==='thread')||panes.find(x=>x.kind==='thread');if(p){e.preventDefault();historyNavigate(p,e.key==='['?-1:1)}}}
function installSwipeNavigation(){
  let g=null,cooldownUntil=0,nativeSeenLifecycle=false,nativeAwaitBegin=false,gestureGeneration=0,nativeCancelledUntilEnd=0,fallbackCancelledUntilReset=false;
  const nativeApi=!!(window.liveboardDesktop?.onGestureLifecycle&&window.liveboardDesktop?.gestureSessionSnapshot),fallback=!nativeApi;
  const debug=()=>{try{return localStorage.getItem('liveboard-gesture-debug')==='1'}catch{return false}};
  const log=(event,detail={})=>{if(debug())console.debug('[LiveBoard gesture]',event,detail)};
  const ownerInfo=e=>{const posts=e.target.closest?.('.posts');if(!posts)return null;const p=paneForElement(posts);const el=paneElement(p);return p&&el?{id:p.paneId,generation:p.generation,posts,el,p}:null};
  const blockedStart=e=>e.ctrlKey||e.deltaMode!==0||getSelection()?.toString()||e.target.closest?.('input,textarea,select,[contenteditable],video,iframe,.lightbox,.threadDrawer,.hoverPopover,.nextCandidates,.headerPopover,.uiTooltip,.asciiArt,.tickerViewport');
  const sameOwner=(a,b)=>!!a&&!!b&&a.id===b.id&&a.generation===b.generation&&a.posts===b.posts&&a.p===b.p;
  const targetFor=(owner,sign)=>{const p=owner.p;if(sign<0&&p.pendingNavigation&&p.pendingNavigation.kind!=='history')return {action:'abort',token:p.pendingNavigation.token||'',direction:-1};const base=p.pendingNavigation?.kind==='history'?p.pendingNavigation.historyIndex:p.history.index,targetIndex=base+(sign<0?-1:1);if(targetIndex<0||targetIndex>=p.history.entries.length)return {action:'none',direction:sign};const entry=p.history.entries[targetIndex],ref=normalizeThreadRef(entry.board,entry.url);return {action:'history',direction:sign,baseIndex:base,targetIndex,threadId:String(entry.threadId||ref?.threadId||''),url:String(entry.url||'')};};
  const targetValid=state=>{const current=panes.find(p=>p.paneId===state.owner.id);if(!current||current!==state.owner.p||current.disposed||current.generation!==state.owner.generation)return false;const t=state.target;if(!t||t.action==='none')return false;if(t.action==='abort')return !!current.pendingNavigation&&current.pendingNavigation.kind!=='history'&&String(current.pendingNavigation.token||'')===t.token;const base=current.pendingNavigation?.kind==='history'?current.pendingNavigation.historyIndex:current.history.index;if(base!==t.baseIndex)return false;const entry=current.history.entries[t.targetIndex],ref=entry&&normalizeThreadRef(entry.board,entry.url);return !!entry&&String(entry.threadId||ref?.threadId||'')===t.threadId&&String(entry.url||'')===t.url};
  const overlayFor=o=>o?.el?.querySelector?.('.historyGestureOverlay');
  const visualCueState=progress=>{const px=Math.min(100,Math.max(24,Number(progress||0)*100)),points=[[24,6,14],[40,10,26],[60,14,48],[80,18,72],[100,22,100]];let a=points[0],b=points.at(-1);for(let i=1;i<points.length;i++)if(px<=points[i][0]){a=points[i-1];b=points[i];break}const t=b[0]===a[0]?1:(px-a[0])/(b[0]-a[0]),lerp=(x,y)=>x+(y-x)*t,offset=lerp(a[1],b[1]),mix=lerp(a[2],b[2]);return {offset,mix,opacity:.58+.42*Math.min(1,(px-24)/76),scale:1+.04*Math.min(1,(px-24)/76)}};
  const cue=(state,progress,enabled)=>{const overlay=overlayFor(state.owner);if(!overlay)return;overlay.dataset.gestureGeneration=String(state.gestureGeneration);let c=overlay.querySelector('.gestureCue');if(!c){c=document.createElement('button');c.type='button';c.className='gestureCue';c.tabIndex=-1;c.innerHTML='<svg class="gestureArrow" viewBox="0 0 44 44" aria-hidden="true" focusable="false"><path d="M36 16 L30 22 L36 28"/></svg>';c.addEventListener('pointerdown',e=>{if(fallback)e.stopPropagation()});c.addEventListener('click',e=>{if(!fallback)return;e.preventDefault();e.stopPropagation();if(g?.armed)commit('fallback-click')});overlay.appendChild(c)}const sign=state.direction||1,visual=visualCueState(progress);c.className=`gestureCue ${sign<0?'left':'right'} ${enabled?'':'disabled'} ${state.armed?'armed':''}`;c.style.setProperty('--offset',`${visual.offset.toFixed(2)}px`);c.style.setProperty('--cue-mix',`${visual.mix.toFixed(1)}%`);c.style.setProperty('--cue-opacity',visual.opacity.toFixed(3));c.style.setProperty('--cue-scale',visual.scale.toFixed(3));const arrow=c.querySelector('.gestureArrow path'),arrowShift=(sign<0?1:-1)*(11-visual.offset/2);c.style.setProperty('--arrow-shift',`${arrowShift.toFixed(2)}px`);if(arrow)arrow.setAttribute('d',sign<0?'M36 16 L30 22 L36 28':'M8 16 L14 22 L8 28');c.setAttribute('aria-label',sign<0?'履歴へ戻る':'履歴へ進む');c.disabled=!enabled;c.hidden=false;overlay.classList.toggle('webFallback',fallback);overlay.setAttribute('aria-hidden',fallback&&state.armed?'false':'true');let hint=overlay.querySelector('.gestureHint');if(fallback){if(!hint){hint=document.createElement('span');hint.className='gestureHint';hint.textContent='Enterで移動';overlay.appendChild(hint)}hint.hidden=!state.armed}else if(hint)hint.hidden=true};
  const hideCue=(state,outcome='cancelled')=>{const overlay=overlayFor(state.owner),c=overlay?.querySelector?.('.gestureCue');if(!overlay||!c)return;const generation=String(state.gestureGeneration);overlay.dataset.gestureGeneration=generation;c.classList.remove('armed');c.classList.add(outcome);if(outcome==='cancelled')c.style.setProperty('--offset','0px');overlay.querySelector('.gestureHint')?.setAttribute('hidden','');const delay=outcome==='committed'?180:120;setTimeout(()=>{if(!c.isConnected||overlay.dataset.gestureGeneration!==generation)return;c.hidden=true;c.className='gestureCue';overlay.classList.remove('webFallback');overlay.setAttribute('aria-hidden','true')},delay)};
  const activeNativeSession=state=>Number(state?.nativeSessionId)||Number(window.liveboardDesktop?.gestureSessionSnapshot?.()?.activeSessionId)||0;
  const consumeSession=state=>{if(nativeApi){const id=activeNativeSession(state);if(id)nativeCancelledUntilEnd=id}else fallbackCancelledUntilReset=true};
  const cancel=(reason='cancel',paneId='',consume=true)=>{if(!g)return false;if(paneId&&g.owner.id!==paneId)return false;const state=g;g=null;if(consume)consumeSession(state);hideCue(state,'cancelled');log('cancel',{reason,paneId:state.owner.id,sessionId:state.nativeSessionId||0,consumed:consume});return true};
  cancelHistoryGesture=cancel;
  const cancelUntilEnd=(reason,e=null)=>{if(!g)return false;const state=g;g=null;consumeSession(state);hideCue(state,'cancelled');if(e&&Math.abs(Number(e.deltaX)||0)>Math.abs(Number(e.deltaY)||0))e.preventDefault();log('cancel-until-end',{reason,paneId:state.owner.id,sessionId:activeNativeSession(state),direction:state.direction});return true};
  const commit=(reason='end')=>{if(!g)return;const state=g;g=null;if(state.consumed||!state.armed||!targetValid(state)){hideCue(state,'cancelled');log('cancel',{reason:'invalid-'+reason,paneId:state.owner.id,sessionId:state.nativeSessionId||0});return}state.consumed=true;hideCue(state,'committed');cooldownUntil=performance.now()+500;log('commit',{reason,paneId:state.owner.id,sessionId:state.nativeSessionId||0,direction:state.direction});const p=state.owner.p;if(state.target.action==='abort'){try{p.navigationController?.abort()}catch{};p.pendingNavigation=null;updatePaneStatus(paneElement(p),p)}else historyNavigate(p,state.direction<0?-1:1)};
  const startState=(owner,nativeSessionId=0)=>({owner,x:0,sumAbsY:0,phase:'tracking',armed:false,direction:0,target:null,nativeSessionId:Number(nativeSessionId)||0,consumed:false,gestureGeneration:++gestureGeneration});
  document.addEventListener('wheel',e=>{
    const eventOwner=ownerInfo(e),blocked=!!blockedStart(e);
    if(g&&(blocked||!sameOwner(eventOwner,g.owner))){cancel(blocked?'blocked-region':'owner-changed');return}
    if(!g&&blocked)return;
    if(fallback&&fallbackCancelledUntilReset)return;
    if(fallback&&g&&Math.abs(e.deltaY)>Math.abs(e.deltaX)&&Math.abs(e.deltaY)>=12){cancel('fallback-vertical');return}
    const now=performance.now();if(now<cooldownUntil)return;
    if(!g){const owner=eventOwner;if(!owner)return;let sessionId=0;if(nativeApi){const snap=window.liveboardDesktop.gestureSessionSnapshot?.()||{};sessionId=Number(snap.activeSessionId)||0;const lastSessionId=Number(snap.lastSessionId)||0,lastPhase=String(snap.lastPhase||'');if(sessionId&&nativeCancelledUntilEnd===sessionId)return;if((nativeAwaitBegin||nativeSeenLifecycle)&&!sessionId)return;if(!sessionId&&lastSessionId>0&&(lastPhase==='end'||lastPhase==='cancel')){nativeAwaitBegin=true;return}}g=startState(owner,sessionId)}
    g.x+=e.deltaX;g.sumAbsY+=Math.abs(e.deltaY);
    if(g.phase==='tracking'){
      const initial=gestureDecision({signedX:g.x,sumAbsY:g.sumAbsY,phase:'tracking',armed:false});
      if(initial.phase==='cancelled'){cancel('axis');return}
      if(initial.phase==='tracking')return;
      g.direction=initial.sign;g.target=targetFor(g.owner,g.direction);g.phase='locked';
    }
    const directed=g.direction*g.x;
    if(directed<=0){cancelUntilEnd('origin-crossed',e);return}
    const step=gestureDecision({signedX:directed,sumAbsY:g.sumAbsY,phase:'locked',armed:g.armed}),enabled=g.target?.action!=='none'&&targetValid(g);
    g.armed=!!step.armed&&enabled;e.preventDefault();cue(g,enabled?step.progress:Math.min(step.progress,.22),enabled)
  },{passive:false});
  if(nativeApi){
    window.liveboardDesktop.onGestureLifecycle(msg=>{const phase=String(msg?.phase||''),sessionId=Number(msg?.sessionId)||0,sequence=Number(msg?.sequence)||0;nativeSeenLifecycle=true;if(phase==='begin'){nativeAwaitBegin=false;if(nativeCancelledUntilEnd&&nativeCancelledUntilEnd!==sessionId)nativeCancelledUntilEnd=0;if(g){if(!g.nativeSessionId)g.nativeSessionId=sessionId;else if(g.nativeSessionId!==sessionId)cancel('native-new-session')}log('begin',{sessionId,sequence});return}if(phase==='end'||phase==='cancel'){nativeAwaitBegin=true;if(g&&(g.nativeSessionId===sessionId||(!g.nativeSessionId&&sessionId))){if(phase==='end')commit(String(msg?.reason||'native-end'));else cancel(String(msg?.reason||'native-cancel'))}if(nativeCancelledUntilEnd===sessionId)nativeCancelledUntilEnd=0;log(phase,{sessionId,sequence,reason:String(msg?.reason||'')})}})
  }
  window.addEventListener('blur',()=>cancel('blur'));document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel('hidden')});window.addEventListener('resize',()=>cancel('resize'));
  document.addEventListener('pointerdown',e=>{if(fallback&&g&&!e.target.closest?.('.gestureCue')){cancel('fallback-click-away');return}if(fallback&&fallbackCancelledUntilReset)fallbackCancelledUntilReset=false},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(g){cancel('escape');return}if(fallback)fallbackCancelledUntilReset=false;return}if(fallback&&e.key==='Enter'&&g?.armed){e.preventDefault();commit('fallback-enter');return}if(fallback&&fallbackCancelledUntilReset)fallbackCancelledUntilReset=false})
}

function exportSettings(){updateHistoryAnchors();const data=desktopState(),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`LiveBoard-settings-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

const markdownRunningState=state=>['listing','fetching','finalizing'].includes(String(state||''));
const markdownBusyState=state=>markdownRunningState(state)||String(state||'')==='saving';
function fmtBytes(bytes){const n=Math.max(0,Number(bytes)||0);if(n<1024)return `${n} B`;if(n<1024*1024)return `${(n/1024).toFixed(1)} KiB`;return `${(n/1024/1024).toFixed(2)} MiB`}
function ensureMarkdownBoards(){const field=$('#markdownBoards');if(!field||field.childElementCount>1)return;for(const b of boards.filter(board=>board.supportsExport===true)){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=b.id;box.checked=true;box.dataset.markdownBoard=b.id;label.append(box,document.createTextNode(b.name));field.appendChild(label)}}
function markdownSelectedBoards(){return $$('#markdownBoards input[data-markdown-board]:checked').map(x=>x.value)}
function setMarkdownFormDisabled(disabled){$('#markdownMinPosts').disabled=disabled;$$('#markdownBoards input').forEach(x=>x.disabled=disabled);$('#markdownStart').disabled=disabled;$('#markdownCancel').disabled=!markdownRunningState(markdownUi.snapshot?.state);$('#markdownCancelPartialRow').hidden=!markdownRunningState(markdownUi.snapshot?.state)}
function markdownCoverageHtml(manifest){const rows=[];for(const item of manifest?.listing||[]){if(item.ok){const ev=item.coverage||{},detail=[item.source?`source=${item.source}`:'',ev.parseStatus?`parse=${ev.parseStatus}`:'',typeof ev.complete==='boolean'?`complete=${ev.complete}`:'',typeof ev.validForAbsence==='boolean'?`absenceEvidence=${ev.validForAbsence}`:''].filter(Boolean).join(' / ');rows.push(`<li>${esc(boardOf(item.boardId)?.name||item.boardId)}: 一覧${Number(item.count)||0}件 / ${esc(item.listedAt||'')}${detail?` / ${esc(detail)}`:''}</li>`)}else rows.push(`<li>${esc(boardOf(item.boardId)?.name||item.boardId)}: 一覧取得失敗</li>`)}const failures=(manifest?.failures||[]).slice(0,5).map(f=>`<li>${esc(boardOf(f.boardId)?.name||f.boardId||'不明')}: ${esc(f.kind||'error')} ${esc(f.message||'')}</li>`).join('');return rows.length||failures?`<div class="markdownCoverage">coverage（板ごとに取得時刻が異なります）${rows.length?`<ul>${rows.join('')}</ul>`:''}${failures?`<div>失敗例</div><ul>${failures}</ul>`:''}</div>`:''}
function markdownProgressText(s){const state=String(s?.state||'idle'),p=s?.progress||{},m=s?.result?.manifest||null;if(state==='listing')return `一覧取得中 ${Number(p.boardsDone)||0}/${Number(p.boardsTotal)||s.boardIds?.length||0}板`;if(state==='fetching')return `${Number(p.processed)||0}/${Number(p.total)||0}スレッド処理済み（成功${Number(p.counts?.success??p.success)||Number(m?.successCount)||0}・失敗${Number(p.counts?.failed??p.failed)||Number(m?.failureCount)||0}・除外${Number(p.counts?.excluded??p.excluded)||Number(m?.excludedCount)||0}）`;if(state==='finalizing')return 'Markdownを確定中…';if(state==='saving')return 'Markdownをダウンロードへ保存中…';if(state==='saved')return 'ダウンロードに保存しました';if(state==='partial-saved')return '部分結果をダウンロードに保存しました';if(state==='save-failed')return `保存失敗${s?.error?.message?`: ${s.error.message}`:''}`;if(state==='ready')return '完了';if(state==='partial')return '部分結果で完了';if(state==='cancelled')return '取消しました';if(state==='failed')return `作成失敗${s?.error?.message?`: ${s.error.message}`:''}`;return '待機中'}
function markdownChipText(s){const state=String(s?.state||'idle'),p=s?.progress||{};if(state==='listing')return `Markdown取得中 ${Number(p.boardsDone)||0}/${Number(p.boardsTotal)||s.boardIds?.length||0}板`;if(state==='fetching')return `Markdown取得中 ${Number(p.processed)||0}/${Number(p.total)||0}`;if(state==='finalizing')return 'Markdown確定中…';if(state==='saving')return 'Markdown保存中…';if(state==='saved')return 'Markdown保存済み';if(state==='partial-saved')return 'Markdown部分保存';if(state==='save-failed')return 'Markdown保存失敗';if(state==='failed')return 'Markdown作成失敗';if(state==='cancelled')return 'Markdown取消';if(state==='ready'||state==='partial')return 'Markdown完了';return ''}
function openMarkdownPanel(){const panel=$('#markdownPanel'),chip=$('#markdownStatusChip');if(!panel)return;panel.hidden=false;markdownUi.panelOpen=true;if(chip)chip.setAttribute('aria-expanded','true')}
function closeMarkdownPanel(){const panel=$('#markdownPanel'),chip=$('#markdownStatusChip');if(panel)panel.hidden=true;markdownUi.panelOpen=false;if(chip)chip.setAttribute('aria-expanded','false')}
function renderMarkdownPanel(s){const state=String(s?.state||'idle'),chip=$('#markdownStatusChip'),panelProgress=$('#markdownPanelProgress'),panelResult=$('#markdownPanelResult'),details=$('#markdownPanelDetailBody'),m=s?.result?.manifest||null,save=s?.save||null;const chipText=markdownChipText(s);if(chip){chip.textContent=chipText;chip.hidden=!chipText||state==='idle'}if(panelProgress)panelProgress.textContent=markdownProgressText(s);if(panelResult){panelResult.hidden=!m;if(m){const partial=['partial','partial-saved'].includes(String(s?.generationState||s?.result?.state||state));panelResult.innerHTML=`<b>${state==='save-failed'?'取得済み・保存待ち':state==='saved'?'保存完了':state==='partial-saved'?'部分結果を保存':'取得結果'}</b><div>対象 ${Number(m.targetCount)||0} / 成功 ${Number(m.successCount)||0} / 失敗 ${Number(m.failureCount)||0} / 除外 ${Number(m.excludedCount)||0}</div>${save?.bytes?`<div>${fmtBytes(save.bytes)} / SHA-256 ${esc(String(save.sha256||'').slice(0,16))}…${partial?' / 部分結果':''}</div>`:''}`}}if(details)details.innerHTML=m?markdownCoverageHtml(m):'';const running=markdownRunningState(state);$('#markdownPanelCancel').hidden=!running;$('#markdownRetrySave').hidden=state!=='save-failed';$('#markdownSaveAs').hidden=state!=='save-failed';$('#markdownShowInFolder').hidden=!['saved','partial-saved'].includes(state)||!save?.path;if(['saved','partial-saved'].includes(state)&&s?.jobId&&markdownUi.lastCompletionJob!==s.jobId){markdownUi.lastCompletionJob=s.jobId;toast(state==='saved'?'ダウンロードに保存しました':'部分結果をダウンロードに保存しました')}if(state==='save-failed'&&s?.jobId&&markdownUi.lastSaveFailureJob!==s.jobId){markdownUi.lastSaveFailureJob=s.jobId;toast('Markdownの保存に失敗しました。取得済みデータから再試行できます')}}
function renderMarkdownSnapshot(snapshot){
  markdownUi.snapshot=snapshot&&typeof snapshot==='object'?snapshot:{state:'idle',jobId:null};const s=markdownUi.snapshot,state=String(s.state||'idle'),running=markdownBusyState(state),m=s.result?.manifest||null,copy=s.result?.copy||null;
  setMarkdownFormDisabled(running);const progress=markdownProgressText(s);$('#markdownProgress').textContent=progress;renderMarkdownPanel(s);
  const result=$('#markdownResult'),area=$('#markdownCopyArea');result.hidden=!m;area.hidden=true;if(!m){result.textContent='';return}
  const generatedState=String(s.generationState||s.result?.state||state),created=state==='saved'?'AI用Markdownを保存しました':state==='partial-saved'?'AI用Markdownの部分結果を保存しました':generatedState==='ready'?'AI用Markdownを作成しました':generatedState==='partial'?'AI用Markdownの部分結果を作成しました':generatedState==='cancelled'?'AI用Markdown作成を取消しました':'AI用Markdownを作成できませんでした';const limitations=[];if(m.cancelled)limitations.push('取消により未取得あり');if(m.capacityLimited)limitations.push('容量上限で未取得あり');if(m.limited&&!m.capacityLimited)limitations.push('時間/取得上限で未取得あり');if(Number(m.listingFailureCount)>0)limitations.push(`一覧失敗 ${m.listingFailureCount}板`);if(Number(m.threadFailureCount)>0)limitations.push(`本文失敗 ${m.threadFailureCount}件`);
  result.innerHTML=`<b>${esc(created)}</b><div>対象 ${Number(m.targetCount)||0} / 成功 ${Number(m.successCount)||0} / 失敗 ${Number(m.failureCount)||0} / 除外 ${Number(m.excludedCount)||0}</div><div>WSB: 対象外 / 全板同時snapshotではありません。</div>${limitations.length?`<div>${esc(limitations.join(' / '))}</div>`:''}${markdownCoverageHtml(m)}`;
  if(!copy||!['ready','partial','saved','partial-saved','save-failed'].includes(state)||!(Number(copy.bytes)>0))return;area.hidden=false;const info=$('#markdownCopyInfo'),parts=Math.max(1,Number(copy.partCount)||1);if(copy.mode==='full'){markdownUi.partIndex=0;info.textContent=`補助操作: 全文 ${fmtBytes(copy.bytes)}。全文を一度にコピーできます。必要な場合だけクリップボードへコピーしてください。`;$('#markdownPartControls').hidden=true;$('#markdownCopy').textContent='全文をコピー'}else{markdownUi.partIndex=Math.min(markdownUi.partIndex,parts-1);info.textContent=`全文取得済み ${fmtBytes(copy.bytes)}。全文は一度にコピーできないため ${parts} 分割でコピーします。${copy.oversizePartCount?` 単一レスが大きいため約1MiBを超えるpartが${copy.oversizePartCount}件あります。`:''}`;$('#markdownPartControls').hidden=false;$('#markdownPartPrev').disabled=markdownUi.partIndex<=0;$('#markdownPartNext').disabled=markdownUi.partIndex>=parts-1;$('#markdownPartLabel').textContent=`${markdownUi.partIndex+1}/${parts}`;$('#markdownCopy').textContent=`${markdownUi.partIndex+1}/${parts}をコピー`}$('#markdownCopyStatus').textContent='';delete $('#markdownCopyStatus').dataset.ok;
}
async function refreshMarkdownStatus(){try{const bridge=window.liveboardDesktop;if(!bridge?.markdownExportStatus)return;renderMarkdownSnapshot(await bridge.markdownExportStatus())}catch(e){$('#markdownProgress').textContent=`状態取得失敗: ${e?.message||e}`}}
function openMarkdownDialog(){ensureMarkdownBoards();$('#markdownDialogBackdrop').hidden=false;$('#markdownDialog').hidden=false;closeMarkdownPanel();drawerPinned=false;if($('#threadDrawer').classList.contains('open'))hideDrawer();setToolbarMode('hot');void refreshMarkdownStatus();setTimeout(()=>$('#markdownMinPosts')?.focus(),0)}
function closeMarkdownDialog(){if($('#markdownDialog'))$('#markdownDialog').hidden=true;if($('#markdownDialogBackdrop'))$('#markdownDialogBackdrop').hidden=true}
async function openMarkdownEntry(){await refreshMarkdownStatus();if(markdownUi.snapshot?.jobId&&String(markdownUi.snapshot?.state||'idle')!=='idle'){closeMarkdownDialog();openMarkdownPanel();return}openMarkdownDialog()}
async function startMarkdownExportUi(){const bridge=window.liveboardDesktop;if(!bridge?.startMarkdownExport){$('#markdownProgress').textContent='AI用Markdownはデスクトップ版で利用できます';return}const minimumPosts=Number($('#markdownMinPosts').value),boardIds=markdownSelectedBoards();if(!Number.isInteger(minimumPosts)||minimumPosts<0){$('#markdownProgress').textContent='最低レス数は0以上の整数で指定してください';return}if(!boardIds.length){$('#markdownProgress').textContent='対象板を1つ以上選択してください';return}markdownUi.partIndex=0;try{const snap=await bridge.startMarkdownExport(boardIds,minimumPosts);renderMarkdownSnapshot(snap);if(snap?.jobId){closeMarkdownDialog();openMarkdownPanel()}}catch(e){$('#markdownProgress').textContent=`開始できません: ${e?.message||e}`}}
async function cancelMarkdownExportUi(){const s=markdownUi.snapshot,bridge=window.liveboardDesktop;if(!s?.jobId||!bridge?.cancelMarkdownExport)return;try{renderMarkdownSnapshot(await bridge.cancelMarkdownExport(s.jobId,$('#markdownCancelPartial').checked))}catch(e){$('#markdownProgress').textContent=`取消できません: ${e?.message||e}`}}
async function retryMarkdownSaveUi(){const s=markdownUi.snapshot,bridge=window.liveboardDesktop;if(!s?.jobId||!bridge?.retryMarkdownSave)return;$('#markdownRetrySave').disabled=true;try{renderMarkdownSnapshot(await bridge.retryMarkdownSave(s.jobId))}catch(e){toast(`保存再試行に失敗: ${e?.message||e}`)}finally{$('#markdownRetrySave').disabled=false}}
async function saveMarkdownAsUi(){const s=markdownUi.snapshot,bridge=window.liveboardDesktop;if(!s?.jobId||!bridge?.saveMarkdownAs)return;$('#markdownSaveAs').disabled=true;try{renderMarkdownSnapshot(await bridge.saveMarkdownAs(s.jobId))}catch(e){toast(`別の場所への保存に失敗: ${e?.message||e}`)}finally{$('#markdownSaveAs').disabled=false}}
async function showMarkdownInFolderUi(){try{await window.liveboardDesktop?.showMarkdownInFolder?.()}catch(e){toast(`Finderで表示できません: ${e?.message||e}`)}}
async function copyMarkdownExportUi(){const s=markdownUi.snapshot,bridge=window.liveboardDesktop,status=$('#markdownCopyStatus');if(!s?.jobId||!bridge?.copyMarkdownExport)return;$('#markdownCopy').disabled=true;try{const r=await bridge.copyMarkdownExport(s.jobId,markdownUi.partIndex);status.dataset.ok=String(!!r?.verified);status.textContent=r?.verified?(r.selection==='full'?`全文をコピーし、clipboard読戻しhashを確認しました（${fmtBytes(r.bytes)}）`:`${r.index+1}/${r.total}をコピーし、clipboard読戻しhashを確認しました（${fmtBytes(r.bytes)}）`):'clipboard読戻しhashが一致しませんでした'}catch(e){status.dataset.ok='false';status.textContent=`コピー失敗: ${e?.message||e}`}finally{$('#markdownCopy').disabled=false}}
function importSettingsText(text){try{const data=JSON.parse(String(text||''));if(!validateImportedState(data))throw new Error('設定形式が不正です');for(const p of panes)disposePane(p);const normalized=data.panes.map(p=>{const q=p.kind?p:{...p,kind:'thread'};return q.kind==='thread'&&q.board==='futaba'?{...q,title:threadDisplayTitle('futaba',q.title),history:normalizePersistedThreadTitles(q.history)}:q}),mem=repository.storage;mem.setItem('liveboard-panes-v8',JSON.stringify(normalized));repository.importDrafts(data.drafts||{});repository.importReadPositions(data.readPositions||{});repository.importUiSettings(data.uiSettings||{});hotFeed=repository.loadUiSettings().hotFeed;updateHotFeedControl();panes=normalized.map(paneState);save();renderPanes();panes.forEach(p=>p.kind==='board'?refreshBoardPane(p,true):refreshPane(p,true));toast('設定を読み込みました')}catch(e){toast(`設定を読み込めません: ${e.message}`)}}
function validateImportedState(v){return !!validatePersistedState(v,{maxPanes:MAX_PANES})}
function importSettingsFile(file){const r=new FileReader();r.onload=()=>importSettingsText(String(r.result||''));r.readAsText(file)}
function updateHistoryAnchors(){for(const p of panes){if(p.kind!=='thread')continue;const box=paneElement(p)?.querySelector('.posts');if(box)commitPaneDepartureSnapshot(p,box,{reason:'state-flush',settleFollowing:true});else updateHistoryCurrent(p)}}
async function bootstrapRepository(){if(!window.liveboardDesktop?.loadState)return;try{const state=await window.liveboardDesktop.loadState();const mem=new MemoryStorage();if(Array.isArray(state?.panes))mem.setItem('liveboard-panes-v8',JSON.stringify(state.panes));else mem.setItem('liveboard-panes-v8',JSON.stringify(initialPanes.map(x=>({...x,follow:false,viewIntent:'top'}))));for(const [k,v] of Object.entries(state?.drafts||{}))mem.setItem('liveboard-draft:'+k,v);mem.setItem('liveboard-read-positions-v1',JSON.stringify(state?.readPositions||{}));mem.setItem('liveboard-ui-settings-v1',JSON.stringify(state?.uiSettings||{hotFeed:'edge'}));repository=new LocalRepository(mem);if(state?.storageReset)queueMicrotask(()=>toast('保存状態を初期化しました'));if(state?.storageUnsupportedSchema)queueMicrotask(()=>toast(`保存形式 schema ${state.storageUnsupportedSchema} はこの版より新しいため読み取り専用です`))}catch(e){console.warn('desktop state load',e)}}
let startupPhase='idle';
let startupRuntimeIntervals=[];
function setStartupMarker(state,message=''){
  const root=document.documentElement;
  root.dataset.liveboardInit=state;
  if(message)root.dataset.liveboardInitError=String(message).slice(0,240);else delete root.dataset.liveboardInitError;
}
function registerRuntimeInterval(fn,ms){const id=setInterval(fn,ms);startupRuntimeIntervals.push(id);return id}
function stopStartupRuntime(){for(const id of startupRuntimeIntervals)clearInterval(id);startupRuntimeIntervals=[];clearTimeout(tickerState.scrollTimer);clearTimeout(tickerState.manualTimer);if(tickerState.raf)cancelAnimationFrame(tickerState.raf);tickerState.raf=0}
function reportStartupFailure(error){
  if(startupPhase==='failed')return;
  startupPhase='failed';stopStartupRuntime();
  const err=error instanceof Error?error:new Error(String(error||'Unknown startup error'));
  console.error('[LiveBoard startup failure]',err);
  setStartupMarker('failed',err.message);
  const ticker=$('#tickerTrack');if(ticker){ticker.replaceChildren();const msg=document.createElement('span');msg.className='tickerEmpty';msg.textContent='LiveBoardの初期化に失敗しました';ticker.appendChild(msg)}
  const grid=$('#grid');if(grid){grid.className='grid count-1';const splash=document.createElement('div');splash.className='splash startupFailure';const box=document.createElement('div');const strong=document.createElement('strong');strong.textContent='アプリの初期化に失敗しました';const note=document.createElement('p');note.textContent='再読み込みしても直らない場合は、起動ログを確認してください。';const retry=document.createElement('button');retry.type='button';retry.className='startupReload';retry.textContent='再読み込み';retry.addEventListener('click',()=>location.reload());box.append(strong,note,retry);splash.appendChild(box);grid.replaceChildren(splash)}
}
async function init(){
  if(startupPhase!=='idle')return;
  startupPhase='starting';setStartupMarker('starting');
  await bootstrapRepository();hotFeed=repository.loadUiSettings().hotFeed;renderBoardNav();void configureWsbCapability();updateHotFeedControl();setToolbarMode('hot');load();renderPanes();panes.forEach(p=>p.kind==='board'?refreshBoardPane(p,true):refreshPane(p,true));refreshHotFeed(hotFeed);
  const drawer=$('#threadDrawer'),toolbar=$('#toolbar');drawer.addEventListener('pointerenter',()=>{menuInputMode='pointer';cancelDrawerClose()});drawer.addEventListener('pointerleave',scheduleDrawerClose);toolbar.addEventListener('pointerenter',()=>{menuInputMode='pointer';cancelDrawerClose()});toolbar.addEventListener('pointerleave',scheduleDrawerClose);toolbar.addEventListener('keydown',()=>{menuInputMode='keyboard'});drawer.addEventListener('keydown',()=>{menuInputMode='keyboard'});toolbar.addEventListener('focusin',()=>{if(menuInputMode==='keyboard')cancelDrawerClose()});toolbar.addEventListener('focusout',scheduleDrawerClose);drawer.addEventListener('focusin',()=>{if(menuInputMode==='keyboard')cancelDrawerClose()});drawer.addEventListener('focusout',scheduleDrawerClose);$('#drawerClose').onclick=()=>{drawerPinned=false;hideDrawer()};$('#drawerPin').onclick=pinActiveBoardPane;$('#filter').addEventListener('input',()=>renderThreadList());$('#sort').addEventListener('change',async()=>{activeSort=$('#sort').value;await refreshBoard(activeBoard,activeSort,true).catch(()=>{})});
  $('#menuBtn').addEventListener('pointerdown',()=>{menuInputMode='pointer'});$('#menuBtn').onclick=()=>{if(toolbarMode==='menu'){drawerPinned=false;hideDrawer();setToolbarMode('hot')}else setToolbarMode('menu')};$('#drawerHotFeedButton').onclick=e=>{e.preventDefault();e.stopPropagation();if(HOT_FEEDS[activeBoard]&&activeBoard!==hotFeed)setHotFeed(activeBoard)};$('#menuBtn').addEventListener('contextmenu',e=>{e.preventDefault();$('#settingsMenu').hidden=false});$('#menuBtn').addEventListener('keydown',e=>{if(e.shiftKey&&e.key==='F10'){$('#settingsMenu').hidden=false;e.preventDefault()}});$('#exportSettings').onclick=exportSettings;$('#importSettings').onclick=()=>$('#importSettingsFile').click();$('#importSettingsFile').onchange=e=>{const f=e.target.files?.[0];if(f)importSettingsFile(f);e.target.value=''};window.liveboardDesktop?.onDataExport?.(exportSettings);window.liveboardDesktop?.onDataImport?.(importSettingsText);$('#markdownBtn').onclick=e=>{e.preventDefault();void openMarkdownEntry()};$('#markdownStatusChip').onclick=e=>{e.preventDefault();e.stopPropagation();if($('#markdownPanel').hidden)openMarkdownPanel();else closeMarkdownPanel()};$('#markdownPanelClose').onclick=closeMarkdownPanel;$('#markdownPanelCancel').onclick=cancelMarkdownExportUi;$('#markdownRetrySave').onclick=retryMarkdownSaveUi;$('#markdownSaveAs').onclick=saveMarkdownAsUi;$('#markdownShowInFolder').onclick=showMarkdownInFolderUi;$('#markdownDialogClose').onclick=closeMarkdownDialog;$('#markdownDialogBackdrop').onclick=closeMarkdownDialog;$('#markdownStart').onclick=startMarkdownExportUi;$('#markdownCancel').onclick=cancelMarkdownExportUi;$('#markdownCopy').onclick=copyMarkdownExportUi;$('#markdownPartPrev').onclick=()=>{markdownUi.partIndex=Math.max(0,markdownUi.partIndex-1);renderMarkdownSnapshot(markdownUi.snapshot)};$('#markdownPartNext').onclick=()=>{const n=Math.max(1,Number(markdownUi.snapshot?.result?.copy?.partCount)||1);markdownUi.partIndex=Math.min(n-1,markdownUi.partIndex+1);renderMarkdownSnapshot(markdownUi.snapshot)};window.liveboardDesktop?.onMarkdownExportProgress?.(snapshot=>renderMarkdownSnapshot(snapshot));void refreshMarkdownStatus();$('#wsbSetupClose').onclick=closeWsbSetupPanel;$('#wsbSettingsToggle').onclick=()=>{$('#wsbSettingsFields').hidden=!$('#wsbSettingsFields').hidden};$('#wsbSettingsSave').onclick=saveWsbSettingsUi;$('#wsbPrepareTranslation').onclick=prepareWsbTranslationUi;$('#wsbTranslationTest').onclick=testWsbTranslationUi;$('#wsbConnectionTest').onclick=testWsbConnectionUi;$('#wsbConnect').onclick=connectWsbRedditUi;$('#wsbDisconnect').onclick=disconnectWsbRedditUi;$('#wsbCandidates').onclick=()=>loadWsbCandidatesUi();$('#wsbSample').onclick=()=>{addWsbSamplePane();closeWsbSetupPanel()};
  $('#headerPopover').addEventListener('pointerenter',()=>clearTimeout(headerCloseTimer));$('#headerPopover').addEventListener('pointerleave',scheduleHeaderClose);$('#uiTooltip').addEventListener('pointerenter',()=>clearTimeout(tooltipTimer));$('#uiTooltip').addEventListener('pointerleave',closeUiTooltip);
  document.addEventListener('pointerdown',e=>{if(!$('#wsbSetupPanel')?.hidden&&!e.target.closest('#wsbSetupPanel,#wsbBtn'))closeWsbSetupPanel();if(!$('#markdownPanel')?.hidden&&!e.target.closest('#markdownPanel,#markdownStatusChip'))closeMarkdownPanel();if(toolbarMode==='menu'&&!e.target.closest('#toolbar,#threadDrawer')&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){drawerPinned=false;if($('#threadDrawer').classList.contains('open'))hideDrawer();else setToolbarMode('hot')}if(!e.target.closest('.headerPopover,.paneHead'))closeHeaderPopover()},true);
  let downInside=false;$('#lightbox').addEventListener('pointerdown',e=>{downInside=!!e.target.closest('img,video,iframe,a,button')});$('#lightbox').addEventListener('click',e=>{if(e.target.closest('.lightboxClose')||e.target.classList.contains('zoomImage')){closeLightbox();return}if(!downInside)lightboxOutsideClick(e);downInside=false});$('#lightboxPrev').onclick=()=>moveGallery(-1);$('#lightboxNext').onclick=()=>moveGallery(1);$('#lightboxExternal').onclick=()=>openExternalUrl($('#lightbox').dataset.sourceUrl||'');$('#lightboxExternal').addEventListener('pointerenter',scheduleLightboxUrlTooltip);$('#lightboxExternal').addEventListener('pointerleave',hideLightboxUrlTooltip);$('#lightboxExternal').addEventListener('focus',scheduleLightboxUrlTooltip);$('#lightboxExternal').addEventListener('blur',hideLightboxUrlTooltip);
  document.addEventListener('keydown',openLightboxKeyboard);window.liveboardDesktop?.onEscape?.(()=>closeTopUi());window.liveboardDesktop?.onFlushRequest?.(()=>{updateHistoryAnchors();void flushDesktopState()});
  installSwipeNavigation();registerRuntimeInterval(()=>{if(!document.hidden)panes.filter(p=>p.kind==='thread'&&!isWsbPane(p)).forEach(p=>refreshPane(p,false))},4000);registerRuntimeInterval(()=>{if(!document.hidden)refreshHotFeed(hotFeed)},8000);registerRuntimeInterval(()=>{if(!document.hidden){if($('#threadDrawer').classList.contains('open')&&activeBoard!=='edge')refreshBoard(activeBoard,activeSort,true).catch(()=>{});panes.filter(p=>p.kind==='board').forEach(p=>refreshBoardPane(p,false))}},15000);registerRuntimeInterval(tickTickerEventBudget,250);document.addEventListener('visibilitychange',()=>{syncTickerAnimationPlayback($('#tickerTrack'));tickerState.eventMotionTime=tickerAnimationTime();void ensureWsbLifecycle().setHidden(document.hidden).then(snap=>{for(const p of panes.filter(isWsbPane)){p.wsbStatus={...p.wsbStatus,hiddenPaused:!!snap.hiddenPaused};if(!document.hidden)p.wsbStatus.gap=true;updateWsbStatusBanner(p)}}).catch(()=>{});if(document.hidden){for(const e of tickerEvents.values())e.lastTick=0}else{renderTicker();panes.forEach((p,i)=>setTimeout(()=>p.kind==='board'?refreshBoardPane(p,false):isWsbPane(p)?updateWsbStatusBanner(p):refreshPane(p,false),i*160));setTimeout(()=>refreshHotFeed(hotFeed),Math.min(160*panes.length,1200));scheduleLiveReevaluation(0)}});window.addEventListener('resize',()=>{cancelPaneDrag();layoutGrid();saveTickerAnchor();renderTicker();const btn=$(`#boardNav [data-board="${activeBoard}"]`);if($('#threadDrawer').classList.contains('open'))positionDrawer(btn);panes.filter(p=>p.kind==='thread').forEach(p=>schedulePanePosition(p,'window-resize'))});window.addEventListener('blur',cancelPaneDrag);window.addEventListener('beforeunload',()=>{updateHistoryAnchors();void wsbPaneLifecycle?.shutdown();void flushDesktopState()});
  startupPhase='ready';setStartupMarker('ready');
}
window.addEventListener('error',e=>{if(startupPhase==='starting')reportStartupFailure(e.error||new Error(e.message||'Renderer startup error'))});
window.addEventListener('unhandledrejection',e=>{if(startupPhase==='starting')reportStartupFailure(e.reason instanceof Error?e.reason:new Error(String(e.reason||'Renderer startup rejection')))});
const params=new URLSearchParams(location.search),r2Step1TestMode=params.get('r2step1test')==='1',r2Step5TestMode=params.get('r2step5test')==='1',r2Step6TestMode=params.get('r2step6test')==='1';
if(r2Step6TestMode){
  globalThis.__liveboardR2Step6Test={tickerCycleCopies,tickerWrappedScrollLeft,tickerAutoAdvance,TICKER_AUTO_SPEED,captureTickerAnchor,restoreTickerAnchor,normalizeTickerPosition,applyTickerSnapshot,renderTicker,setHotFeed,tickerFeedState,saveTickerAnchor,takeTickerRenderAnchor,commitTickerRestoreAnchor,nearestSurvivingTickerKey,detectTickerEvents,tickTickerEventBudget,updateTickerVisibleEvents,advanceTickerEventDistance,tickerEvents,getHotFeed:()=>hotFeed,setHotFeedDirect:v=>{hotFeed=HOT_FEEDS[v]?v:'edge';updateHotFeedControl()},tickerState};
  setStartupMarker('test-ready');
}else if(r2Step5TestMode){
  globalThis.__liveboardR2Step5Test={renderQuoteTree,showTreePopover,openLightbox,closeLightbox,quoteTreeNodeKey,mediaAttachmentHtml,hydratePreviews,armInlineImages,startInlineImageAttempt,MEDIA_LOAD_TIMEOUT_MS,setPanes(next){panes=next},getPanes(){return panes}};
  globalThis.__liveboardR7Stage04Test={mediaDisplayPlan,gallerySnapshotForElement,openGalleryFromElement,moveGallery,closeLightbox,getSession(){return gallerySession?{...gallerySession,items:gallerySession.items.map(x=>({...x}))}:null},getHold(){return mediaPopoverHold?{sessionId:mediaPopoverHold.sessionId,paneId:mediaPopoverHold.paneId,phase:mediaPopoverHold.phase,ownerDepth:mediaPopoverHold.ownerDepth}:null}};
  setStartupMarker('test-ready');
}else if(r2Step1TestMode){
  globalThis.__liveboardR2Step1Test={
    paneState,renderPanes,navigatePane,refreshPane,reconcileDateSeparators,postsHtml,paintInitial,appendRenderBatch,
    ensureVirtualWindowForViewport,scheduleVirtualWindowUpdate,renderVirtualWindow,measureVirtualWindow,runGeometryTransaction,positionTrace,writePaneScrollTop,resetRenderSessionState,scheduleQuoteAnalysis,installSwipeNavigation,flushDeferredGeometryAfterUser,mediaGeometryPending,syncPostLayoutMetadata,postLayoutRevision,estimatedTotalHeight,
    mediaDisplayPlan,gallerySnapshotForElement,openGalleryFromElement,moveGallery,closeLightbox,openLightboxKeyboard,showQuotePopover,showTreePopover,popoverPosition,popoverAnchorRect,getPopoverPlacementState:()=>popoverPlacementState?{primaryDirection:popoverPlacementState.primaryDirection,rootRect:popoverPlacementState.rootRect,layers:[...popoverPlacementState.layers.values()].map(x=>structuredClone(x))}:null,
    nextThreadCandidates,maybeAdvanceThread,maybeLiveAutoAdvance,currentAutoSelection,setLiveMode,liveInteractionBlockers,
    capturePaneViewportSnapshot,commitPaneDepartureSnapshot,addPane,removePane,
    setPanes(next){panes=next},getPanes(){return panes},paneElement,applyThreadResponse,getReadPosition(threadId){return repository.getReadPosition(threadId)},getGallerySession(){return gallerySession?{...gallerySession,items:gallerySession.items.map(x=>({...x}))}:null},getMediaHold(){return mediaPopoverHold?{sessionId:mediaPopoverHold.sessionId,paneId:mediaPopoverHold.paneId,phase:mediaPopoverHold.phase,ownerDepth:mediaPopoverHold.ownerDepth}:null}
  };
  globalThis.__liveboardR7Stage06Test={openMarkdownDialog,closeMarkdownDialog,openMarkdownPanel,closeMarkdownPanel,renderMarkdownSnapshot,startMarkdownExportUi,cancelMarkdownExportUi,retryMarkdownSaveUi,saveMarkdownAsUi,copyMarkdownExportUi,ensureMarkdownBoards,markdownSelectedBoards,getMarkdownUi:()=>({snapshot:markdownUi.snapshot,partIndex:markdownUi.partIndex,panelOpen:markdownUi.panelOpen}),setMarkdownPartIndex:i=>{markdownUi.partIndex=Math.max(0,Number(i)||0)},fmtBytes};
  globalThis.__liveboardR7Stage09Test={addWsbPane,navigateWsbPane,applyWsbTranslatedBatch,dispatchWsbRuntimeEvent,applyWsbStatus,removeWsbComments,wsbBannerText,wsbThreadFullnameForPane,enforceWsbRetention,installWsbLifecycle,setWsbBridge:bridge=>installWsbLifecycle(bridge),getLifecycle:()=>wsbPaneLifecycle?.snapshot?.()||null,getCapability:()=>({...wsbCapability})};
  globalThis.__liveboardR8Stage05Test={addWsbSamplePane,navigateWsbSamplePane,isWsbSamplePane,wsbSamplePosts,openWsbSetupPanel,closeWsbSetupPanel,renderWsbSetupStatus,renderBoardNav,ensureMarkdownBoards,markdownSelectedBoards,persistedPanes,getCapability:()=>structuredClone(wsbCapability)};
  globalThis.__liveboardR8Stage06Test={connectWsbRedditUi,disconnectWsbRedditUi,loadWsbCandidatesUi,renderWsbCandidates,saveWsbSettingsUi,wsbReasonLabel,openWsbSetupPanel,getCapability:()=>structuredClone(wsbCapability)};
  setStartupMarker('test-ready');
}else void init().catch(reportStartupFailure);
