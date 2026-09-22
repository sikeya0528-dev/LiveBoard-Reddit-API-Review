const FUTABA_KNOWN_DISPLAY_SUFFIXES = Object.freeze([
  ' - 二次元裏＠ふたば', ' - 二次元裏@ふたば',
  ' – 二次元裏＠ふたば', ' – 二次元裏@ふたば',
  ' — 二次元裏＠ふたば', ' — 二次元裏@ふたば',
  ' － 二次元裏＠ふたば', ' － 二次元裏@ふたば'
]);

export function normalizeFutabaDisplayTitle(title=''){
  const raw=String(title??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();
  if(!raw)return raw;
  for(const suffix of FUTABA_KNOWN_DISPLAY_SUFFIXES){
    if(!raw.endsWith(suffix))continue;
    const trimmed=raw.slice(0,-suffix.length).trim();
    return trimmed||raw;
  }
  return raw;
}

const THREAD_RULES = {
  edge: {host:'bbs.eddibb.cc', path:'liveedge'},
  '5ch': {host:'egg.5ch.io', path:'stock'},
  holo: {host:'bbs.jpnkn.com', path:'hololiveneet'},
  niji: {host:'bbs.jpnkn.com', path:'nijifunbbs'},
  futaba: {host:'may.2chan.net', path:'b'},
  wsb: {host:'www.reddit.com', path:'wallstreetbets'}
};

function defaultPort(protocol, port=''){return !port || (protocol==='https:'&&port==='443') || (protocol==='http:'&&port==='80')}

export function normalizeThreadRef(boardId, input='') {
  const rule = THREAD_RULES[boardId];
  if (!rule) return null;
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !defaultPort(u.protocol,u.port) || u.hostname.toLowerCase() !== rule.host) return null;
  let sourceThreadId = '';
  if (boardId === 'futaba') {
    sourceThreadId = (u.pathname.match(/^\/b\/res\/(\d+)\.htm$/i) || [])[1] || '';
    if (!sourceThreadId && u.pathname === '/b/futaba.php') sourceThreadId = u.searchParams.get('res') || '';
  } else if (boardId === 'wsb') {
    sourceThreadId = (u.pathname.match(/^\/r\/wallstreetbets\/comments\/([a-z0-9]+)(?:\/|$)/i) || [])[1] || '';
  } else if (boardId === 'edge') {
    sourceThreadId = (u.pathname.match(/^\/liveedge\/(\d+)\/?$/i) ||
      u.pathname.match(/^\/test\/read\.cgi\/liveedge\/(\d+)(?:\/(?:l\d+|n|\d+(?:-\d+)?|\d+-|\d+n))?\/?$/i) || [])[1] || '';
  } else {
    const re = new RegExp(`^/test/read\\.cgi/${rule.path}/(\\d+)(?:/(?:l\\d+|n|\\d+(?:-\\d+)?|\\d+-|\\d+n))?/?$`, 'i');
    sourceThreadId = (u.pathname.match(re) || [])[1] || '';
  }
  if (boardId === 'wsb') {
    if (!/^[a-z0-9]+$/i.test(sourceThreadId)) return null;
  } else if (!/^\d+$/.test(sourceThreadId)) return null;
  const canonicalUrl = boardId === 'futaba'
    ? `https://${rule.host}/b/res/${sourceThreadId}.htm`
    : boardId === 'edge'
      ? `https://${rule.host}/liveedge/${sourceThreadId}`
      : boardId === 'wsb'
        ? `https://${rule.host}/r/wallstreetbets/comments/${sourceThreadId}/`
        : `https://${rule.host}/test/read.cgi/${rule.path}/${sourceThreadId}/`;
  return {boardId, sourceThreadId, threadId:`${boardId}:${sourceThreadId}`, canonicalUrl};
}

export function identifyThreadRef(input=''){
  for(const boardId of Object.keys(THREAD_RULES)){const ref=normalizeThreadRef(boardId,input);if(ref)return ref}
  return null;
}

export function paneRequestToken(pane) {
  return {paneId:pane.paneId, threadId:pane.threadId, generation:pane.generation, navToken:pane.pendingNavigation?.token||''};
}

export function isCurrentPaneRequest(pane, token, paneCollection=null) {
  if(!pane || pane.disposed || !token) return false;
  if(paneCollection && !paneCollection.includes(pane)) return false;
  return pane.paneId === token.paneId && pane.threadId === token.threadId && pane.generation === token.generation;
}

export function postBaseGeometrySignature(post={}) {
  return JSON.stringify([
    post.body ?? '', post.name ?? '', post.date ?? '', post.id ?? '', post.meta ?? '', !!post.deleted,
    post.image ?? '', post.imageFull ?? '', post.links ?? [], post.attachments ?? [],
    post.redditMachineTranslated ? String(post.redditOriginal ?? '') : ''
  ]);
}

export function postGeometrySignature(post={}) {
  // Quote graph metadata is analysis-only. The only quote-derived geometry token is
  // whether the tree button exists and how many digits its badge needs.
  const componentSize=Math.max(1,Number(post.quoteComponentSize)||1),quoteTreeWidthBucket=componentSize>1?String(componentSize).length:0;
  return JSON.stringify([postBaseGeometrySignature(post),quoteTreeWidthBucket]);
}

export function postAnalysisSignature(post={}) {
  return JSON.stringify([
    post.quoteTargets ?? [], post.quoteLineTargets ?? {}, post.backrefs ?? [], post.related ?? [],
    Math.max(1, Number(post.quoteComponentSize)||1)
  ]);
}

export function postSignature(post={}) {
  // Full semantic signature remains the merge/update detector. Layout code uses the
  // geometry and analysis signatures above independently.
  return JSON.stringify([postGeometrySignature(post), postAnalysisSignature(post)]);
}

function postOrder(post){const n=Number(post?.n ?? post?.postNo);return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER}
export function reconcilePosts(previous=[], incoming=[], {complete=false}={}) {
  const prevMap = new Map(previous.map(p => [String(p.key), p]));
  const incomingMap = new Map(incoming.map(p => [String(p.key), {...p,deleted:false}]));
  const keys = complete ? new Set([...prevMap.keys(),...incomingMap.keys()]) : new Set([...prevMap.keys(),...incomingMap.keys()]);
  const next=[];
  for(const key of keys){
    if(incomingMap.has(key)) next.push(incomingMap.get(key));
    else if(prevMap.has(key)) next.push(complete?{...prevMap.get(key),deleted:true}:prevMap.get(key));
  }
  next.sort((a,b)=>postOrder(a)-postOrder(b));
  const nextMap=new Map(next.map(p=>[String(p.key),p]));
  const inserted=[],updated=[],unchanged=[];
  for(const post of next){const old=prevMap.get(String(post.key));if(!old)inserted.push(post);else if(postSignature(old)!==postSignature(post))updated.push(post);else unchanged.push(post)}
  return {posts:next,inserted,updated,unchanged,removed:complete?previous.filter(p=>!incomingMap.has(String(p.key))):[],nextMap};
}

export function createHistoryEntry(pane={},viewportSnapshot=null){
  const snap=viewportSnapshot&&typeof viewportSnapshot==='object'?viewportSnapshot:null;
  const anchorPostId=String(snap?.anchorPostId??pane.anchorPostId??''),anchorOffset=Number(snap?.anchorOffset??pane.anchorOffset)||0,lastReadPostId=String(snap?.lastReadPostId??pane.lastReadPostId??anchorPostId??'');
  const mode=snap?.mode==='following'?'following':snap?'reading':pane.follow?'following':'reading',follow=mode==='following',updatedAt=Number(snap?.updatedAt)||Date.now();
  return {board:pane.board||'',threadId:pane.threadId||'',url:pane.url||'',title:pane.title||'',anchorPostId,anchorOffset,lastReadPostId,follow,unreadCount:Number(pane.newCount??pane.unreadCount)||0,snapshot:{threadId:pane.threadId||'',anchorPostId,anchorOffset,viewportOffset:anchorOffset,lastReadPostId,mode,version:Number(snap?.version)||2,updatedAt}};
}
export function normalizeHistory(history,current){
  const entries=Array.isArray(history?.entries)?history.entries.filter(Boolean).slice(-50):[];
  if(!entries.length&&current)entries.push(createHistoryEntry(current));
  let index=Number.isInteger(history?.index)?history.index:entries.length-1;index=Math.min(Math.max(index,0),Math.max(0,entries.length-1));
  return {entries,index};
}
export function pushHistory(history,entry){
  const h=normalizeHistory(history);let entries=h.entries.slice(0,h.index+1);entries.push({...entry});if(entries.length>50)entries=entries.slice(entries.length-50);return {entries,index:entries.length-1};
}
export function moveHistory(history,index){const h=normalizeHistory(history);const next=Math.min(Math.max(Number(index)||0,0),Math.max(0,h.entries.length-1));return {entries:h.entries.slice(),index:next}}

const CONTINUATION_NOISE_TAG_RE=/【(?:転載|禁止)】/g;
const CONTINUATION_CHANNEL_RE=/^(?:nhk(?:総合|eテレ)?|bs(?:11|12|日テレ|朝日|tbs|テレ東|フジ)?|tokyo\s*mx|mx\d*|ntv|tbs|cx|ex|tx|at-?x|wowow|フジ|日テレ|テレ朝|テレ東|毎日放送|mbs|abc|ytv)$/i;
const CONTINUATION_GENERIC_SHORT_RE=/^(?:無題|雑談|実況|総合|本スレ|避難所|スレ)$/i;

function continuationCleanSource(title='',boardId=''){
  let source=String(title||'').normalize('NFKC').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();
  if(boardId==='futaba')source=normalizeFutabaDisplayTitle(source);
  return source;
}

function continuationSequenceMatch(source='',boardId=''){
  let best=null;
  const explicit=[
    /[★☆#]\s*(\d{1,7})(?=\s*(?:【[^】]*】\s*)*$)/g,
    /\b(?:part|pt)\.?\s*(\d{1,7})\b(?=\s*(?:【[^】]*】\s*)*$)/gi
  ];
  for(const re of explicit)for(const m of source.matchAll(re))best={number:Number(m[1]),start:m.index??-1,end:(m.index??0)+m[0].length,tailEnd:source.length,kind:'explicit'};
  if(best)return best;
  const tail=source.match(/(\d{3,7})\s*((?:【[^】]{1,80}】\s*)*)$/);
  if(!tail)return null;
  const number=Number(tail[1]),digits=tail[1],start=(tail.index??0),prefix=source.slice(0,start).trim();
  if(!prefix)return null;
  const likelyYear=digits.length===4&&number>=1900&&number<=2099;
  const boardSeries=boardId==='holo'||boardId==='niji';
  const namedSeries=/(?:スレ|実況|hololive|にじさんじ|有ンチ|株)\s*$/i.test(prefix);
  if(likelyYear&&!boardSeries&&!namedSeries)return null;
  if(likelyYear&&/(?:朝ドラ|ニュース|番組|日付|年度)\s*$/i.test(prefix))return null;
  return {number,start,end:start+digits.length,tailEnd:source.length,kind:'tail'};
}

export function continuationTitleInfo(title='',boardId='') {
  const source=continuationCleanSource(title,boardId);
  const channelTags=[...source.matchAll(/【([^】]{1,40})】/g)]
    .map(m=>m[1].trim())
    .filter(x=>x&&!/^(?:転載|禁止)$/.test(x)&&CONTINUATION_CHANNEL_RE.test(x))
    .map(x=>x.toLowerCase());
  const seqMatch=continuationSequenceMatch(source,boardId);
  let normalized=source.replace(CONTINUATION_NOISE_TAG_RE,' ');
  if(seqMatch?.start>=0)normalized=normalized.slice(0,seqMatch.start)+' '+normalized.slice(seqMatch.tailEnd);
  normalized=normalized
    .toLowerCase()
    .replace(/https?:\/\/\S+/g,' ')
    .replace(/[\s\-–—_・･:：!！?？()[\]{}「」『』<>＜＞★☆#]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return {source,normalized,seriesKey:normalized,sequence:Number.isFinite(seqMatch?.number)?seqMatch.number:null,sequenceKind:seqMatch?.kind||'',channelTags:[...new Set(channelTags)]};
}

function continuationBigrams(s=''){const x=[...String(s)];if(x.length<2)return new Set(x);const o=new Set();for(let i=0;i<x.length-1;i++)o.add(x[i]+x[i+1]);return o}

export function continuationChannelConflict(a,b,boardId=''){
  const A=continuationTitleInfo(a,boardId).channelTags,B=continuationTitleInfo(b,boardId).channelTags;
  return !!(A.length&&B.length&&!A.some(x=>B.includes(x)));
}

export function continuationTitleSimilarity(a,b,boardId=''){
  const AInfo=continuationTitleInfo(a,boardId),BInfo=continuationTitleInfo(b,boardId),x=AInfo.normalized,y=BInfo.normalized;
  if(!x||!y)return 0;if(x===y)return 1;
  const A=continuationBigrams(x),B=continuationBigrams(y);let inter=0;for(const k of A)if(B.has(k))inter++;
  const union=A.size+B.size-inter,j=union?inter/union:0;
  const contain=(x.includes(y)||y.includes(x))?Math.min(x.length,y.length)/Math.max(x.length,y.length):0;
  return Math.max(j,contain*.92);
}

export function continuationSeriesMatch(boardId,a,b){
  const A=continuationTitleInfo(a,boardId),B=continuationTitleInfo(b,boardId);
  return !!A.seriesKey&&A.seriesKey===B.seriesKey&&!continuationChannelConflict(a,b,boardId);
}

export function continuationShortPrefixMatch(boardId,currentTitle='',candidateTitle='',minChars=3){
  if(boardId!=='futaba')return false;
  const current=continuationTitleInfo(currentTitle,boardId).normalized.replace(/\s+/g,''),candidate=continuationTitleInfo(candidateTitle,boardId).normalized.replace(/\s+/g,'');
  const threshold=Math.max(3,Number(minChars)||3);
  if(!current||!candidate||[...candidate].length<threshold||CONTINUATION_GENERIC_SHORT_RE.test(candidate))return false;
  return current.startsWith(candidate)&&candidate!==current;
}

export function continuationExplorationEligible({boardId='',currentTitle='',candidateTitle='',similarity=0,explicit=false,verified=false,seriesMatch=false,channelConflict=false,currentSeq=null,seq=null}={}){
  const sim=Math.max(0,Math.min(1,Number(similarity)||0)),shortPrefix=continuationShortPrefixMatch(boardId,currentTitle,candidateTitle,3);
  if(channelConflict&&!verified)return false;
  if(currentSeq!=null&&seq!=null&&(seriesMatch||sim>=.45)&&Number(seq)<=Number(currentSeq))return false;
  return !!explicit||!!verified||!!seriesMatch||sim>=.45||shortPrefix;
}

export function continuationActivityRate(samples=[],{minIntervalMs=20000,maxAgeMs=120000}={}){
  const a=(Array.isArray(samples)?samples:[]).map(x=>({count:Number(x?.count),at:Number(x?.at)})).filter(x=>Number.isFinite(x.count)&&x.count>=0&&Number.isFinite(x.at)&&x.at>=0);
  if(a.length<2)return null;
  for(let i=1;i<a.length;i++)if(a[i].at<=a[i-1].at||a[i].count<a[i-1].count)return null;
  const latest=a[a.length-1],floor=latest.at-Math.max(minIntervalMs,maxAgeMs),valid=a.filter(x=>x.at>=floor&&latest.at-x.at>=minIntervalMs);
  if(!valid.length)return null;const base=valid[0],elapsed=latest.at-base.at;if(elapsed<minIntervalMs)return null;
  return Math.max(0,(latest.count-base.count)/(elapsed/60000));
}

export function continuationCandidateEligible({similarity=0,explicit=false,verified=false,seriesMatch=false,bodySeriesMatch=false,bodyPrefixMatch=false,catalogPrefixMatch=false,channelConflict=false,currentSeq=null,seq=null}={}){
  const sim=Math.max(0,Math.min(1,Number(similarity)||0));
  // bodyPrefixMatch is only relation evidence when it corroborates a prefix that already
  // relates the candidate title to the current thread. A candidate echoing its own title
  // must never promote itself.
  const topicCorroborated=!!catalogPrefixMatch&&!!bodyPrefixMatch;
  const relational=!!verified||!!bodySeriesMatch||topicCorroborated;
  if(!(seriesMatch||sim>=.65||!!explicit||relational))return false;
  if(channelConflict&&!(explicit&&verified))return false;
  if(currentSeq!=null&&seq!=null&&(seriesMatch||sim>=.65||bodySeriesMatch)&&Number(seq)<=Number(currentSeq))return false;
  return true;
}

export function rankContinuationCandidates({currentTitle='', currentSeq=null, currentKey='', candidates=[]}={}) {
  const knownRates=candidates.filter(c=>c.rate!=null&&Number.isFinite(Number(c.rate))).map(c=>Math.max(0,Number(c.rate))),maxRate=knownRates.length?Math.max(...knownRates):0;
  return candidates.map(c=>{const sim=Math.max(0,Math.min(1,Number(c.similarity)||0)),seq=c.seq??null,gap=currentSeq!=null&&seq!=null?seq-currentSeq:null,rate=c.rate!=null&&Number.isFinite(Number(c.rate))?Math.max(0,Number(c.rate)):null;let score=sim*50;if(gap===1)score+=10;if(c.explicit)score+=15;if(c.verified)score+=15;if(rate!=null&&maxRate>0)score+=Math.min(10,rate/maxRate*10);score=Math.max(0,Math.min(100,score));return {...c,score,gap,rate}}).sort((a,b)=>b.score-a.score||(Number(b.rate)||0)-(Number(a.rate)||0)||(Number(b.count)||0)-(Number(a.count)||0)||String(a.key||'').localeCompare(String(b.key||'')));
}

export function continuationBodyFresh(candidate={},now=Date.now(),maxAgeMs=30000){
  const verifiedAt=Number(candidate.verifiedAt);
  return Number.isFinite(verifiedAt)&&verifiedAt>0&&Number(now)>=verifiedAt&&Number(now)-verifiedAt<=Math.max(0,Number(maxAgeMs)||0)&&candidate.bodyFresh!==false;
}

export function continuationReservationCandidate(candidate={},now=Date.now()){
  if(!continuationBodyFresh(candidate,now))return false;
  if(!candidate.fetchSuccess||candidate.candidateStatus!=='active'||candidate.ownerMatch!==true||candidate.safeSameBoard!==true||candidate.newer!==true)return false;
  if(candidate.relationState&&candidate.relationState!=='confirmed')return false;
  if(!(candidate.seriesMatch||candidate.bodySeriesMatch))return false;
  const posts=Number(candidate.postCount),span=Number(candidate.activitySpanMs),growth=Number(candidate.activityGrowth);
  return Number.isFinite(posts)&&posts>0&&posts<=1&&Number.isFinite(span)&&span>=20000&&Number.isFinite(growth)&&growth===0;
}

export function continuationAutoEvidence(candidate={},now=Date.now()){
  const bodyOk=!!candidate.fetchSuccess&&candidate.candidateStatus==='active'&&Number(candidate.postCount)>0&&candidate.ownerMatch===true&&candidate.safeSameBoard===true&&candidate.newer===true&&continuationBodyFresh(candidate,now);
  if(!bodyOk)return '';
  if(candidate.relationState&&candidate.relationState!=='confirmed')return '';
  if(candidate.explicit&&candidate.verified)return 'mutual-link';
  const active=Number(candidate.postCount)>=5&&Number(candidate.activityGrowth)>=2&&Number(candidate.activitySpanMs)>=20000;
  if(!active||candidate.channelConflict)return '';
  if(candidate.boardId==='futaba'&&candidate.catalogPrefixMatch&&(candidate.bodySeriesMatch||candidate.bodyPrefixMatch||candidate.seriesMatch))return 'futaba-active-series';
  if(candidate.seriesMatch||candidate.bodySeriesMatch)return 'active-series';
  return '';
}

export function selectAutoAdvanceCandidate(candidates=[],{unresolvedCompetitors=0,now=Date.now()}={}){
  if(Number(unresolvedCompetitors)>0)return {candidate:null,eligible:[],reason:'unresolved-competition'};
  const all=Array.isArray(candidates)?candidates:[],eligible=all.filter(c=>continuationAutoEvidence(c,now));
  if(eligible.length===1)return {candidate:eligible[0],eligible,reason:'unique'};
  if(eligible.length>1){const mutual=eligible.filter(c=>continuationAutoEvidence(c,now)==='mutual-link');if(mutual.length===1)return {candidate:mutual[0],eligible,reason:'mutual-confirmed'}}
  return {candidate:null,eligible,reason:eligible.length?'ambiguous':'none'};
}

export function canAutoAdvance({liveMode=false,status='unknown',follow=false,bottomSettled=false,top=null,pendingNavigation=false,analysisPending=false,documentVisible=true,userBlocked=false,retryAt=0,now=Date.now(),visited=false,unresolvedCompetitors=0,eligibleAutoCount=null}={}){
  if(!liveMode||!['ended','missing'].includes(status)||!follow||!bottomSettled||pendingNavigation||analysisPending||!documentVisible||userBlocked||visited)return false;
  if(Number(retryAt)>Number(now))return false;
  if(!top||!continuationAutoEvidence(top,now))return false;
  if(Number(unresolvedCompetitors)>0)return false;
  if(eligibleAutoCount!=null&&Number(eligibleAutoCount)>1&&continuationAutoEvidence(top,now)!=='mutual-link')return false;
  return true;
}


export function logicalDateBoundaryIndexes(posts=[],dateKeyOf=(post)=>String(post?.dateKey||'')){
  const boundaries=[];let previous='';
  for(let i=0;i<posts.length;i++){const key=String(dateKeyOf(posts[i])||'');if(!key)continue;if(key!==previous)boundaries.push(i);previous=key}
  return boundaries;
}

export function navigationResponseUsable(response){
  return !!response&&!response.unavailable&&Array.isArray(response.posts)&&response.posts.length>0;
}
export function initialRenderWindow(total,{intent='top',anchorIndex=-1,batchSize=50}={}){
  const n=Math.max(0,Number(total)||0),size=Math.max(1,Number(batchSize)||50);if(!n)return [0,0];
  if(intent==='restore'&&Number.isInteger(anchorIndex)&&anchorIndex>=0){const before=Math.min(15,Math.max(0,size-1));const start=Math.max(0,anchorIndex-before);return [start,Math.min(n,start+size)]}
  if(intent==='tail')return [Math.max(0,n-size),n];
  return [0,Math.min(size,n)];
}

export function youtubeEmbedReferer(details={},expectedWebContentsId){
  let u;try{u=new URL(String(details.url||''))}catch{return null}
  if(details.resourceType!=='subFrame'||details.webContentsId!==expectedWebContentsId)return null;
  if(u.protocol!=='https:'||u.hostname!=='www.youtube-nocookie.com'||!u.pathname.startsWith('/embed/'))return null;
  return 'https://local.liveboard.desktop/';
}

export function validatePersistedState(value,{maxBytes=10*1024*1024,maxPanes=9,maxHistory=50,maxDraftBytes=65536,maxFilterBytes=2048}={}){
  if(!value||typeof value!=='object'||![2,3,4].includes(Number(value.schemaVersion)))return null;const panes=Array.isArray(value.panes)?value.panes:null;if(panes===null||panes.length>maxPanes)return null;
  const enc=new TextEncoder(),ids=new Set(),validBoards=new Set(['edge','5ch','futaba','holo','niji']);
  for(const rawPane of panes){if(!rawPane||typeof rawPane!=='object')return null;const p=rawPane.kind?rawPane:{...rawPane,kind:'thread'};const requirePaneId=Number(value.schemaVersion)>=3;if((requirePaneId&&!p.paneId)||(p.paneId&&ids.has(p.paneId))||!validBoards.has(p.board))return null;if(p.paneId)ids.add(p.paneId);if(p.kind==='board'){if(!['hot','count','source'].includes(p.sort||'hot'))return null;if(typeof (p.filter??'')!=='string'||enc.encode(p.filter||'').byteLength>maxFilterBytes)return null;continue}if(p.kind!=='thread'||!normalizeThreadRef(p.board,p.url))return null;if(p.liveMode!=null&&typeof p.liveMode!=='boolean')return null;const entries=p.history?.entries;if(entries&&(!Array.isArray(entries)||entries.length>maxHistory||entries.some(e=>!e||!normalizeThreadRef(e.board,e.url))))return null}
  const normalized=panes.map(p=>{const q=p.kind?{...p}:{...p,kind:'thread'};if(q.kind==='thread')q.liveMode=!!q.liveMode;return q});const drafts=value.drafts&&typeof value.drafts==='object'&&!Array.isArray(value.drafts)?value.drafts:{};for(const v of Object.values(drafts))if(typeof v!=='string'||enc.encode(v).byteLength>maxDraftBytes)return null;
  const readPositions=value.readPositions&&typeof value.readPositions==='object'&&!Array.isArray(value.readPositions)?value.readPositions:{};const readEntries=Object.entries(readPositions);if(readEntries.length>500)return null;for(const [threadId,r] of readEntries){const ref=r&&typeof r==='object'?normalizeThreadRef(r.board,r.url):null;if(!threadId||!r||typeof r!=='object'||!validBoards.has(r.board)||!ref||ref.threadId!==threadId||typeof (r.anchorPostId??'')!=='string'||typeof (r.lastReadPostId??'')!=='string'||!Number.isFinite(Number(r.anchorOffset))||!Number.isFinite(Number(r.updatedAt)))return null}
  if(Number(value.schemaVersion)<4){for(const p of normalized){if(p.kind!=='thread')continue;const ref=normalizeThreadRef(p.board,p.url);if(!ref||readPositions[ref.threadId]||(!p.anchorPostId&&!p.history?.entries?.length))continue;const h=p.history?.entries?.[p.history?.index??0];const anchorPostId=p.anchorPostId||h?.anchorPostId||'';readPositions[ref.threadId]={board:ref.boardId,url:ref.canonicalUrl,anchorPostId,anchorOffset:Number(p.anchorOffset??h?.anchorOffset)||0,lastReadPostId:anchorPostId,updatedAt:0}}}
  const uiSettings={hotFeed:value.uiSettings?.hotFeed==='futaba'?'futaba':'edge'};
  let raw;try{raw=JSON.stringify(value)}catch{return null}if(enc.encode(raw).byteLength>maxBytes)return null;return {...value,schemaVersion:4,panes:normalized,drafts,readPositions,uiSettings};
}
export function shouldAcceptRevision(incoming,current){const n=Number(incoming);return Number.isFinite(n)&&n>=Number(current??-1)}
export function isTrustedRuntimeFrame({runtimeUrl='',frameUrl='',senderMatches=false,mainFrame=false}={}){if(!senderMatches||!mainFrame)return false;try{const base=new URL(runtimeUrl),frame=new URL(frameUrl);return frame.origin===base.origin&&frame.pathname.startsWith(base.pathname)}catch{return false}}

export function migrateUiLayoutState(state={}){
  const out={...(state&&typeof state==='object'?state:{})};
  if(Number(out.uiLayoutVersion)>=2)return out;
  if(out.windowBounds&&typeof out.windowBounds==='object'){
    const width=Number(out.windowBounds.width);
    if(Number.isFinite(width)&&width<=800)out.windowBounds={...out.windowBounds,width:667};
  }
  out.uiLayoutVersion=2;
  return out;
}

export function gestureDecision({signedX=0,sumAbsY=0,phase='tracking',armed=false}={}){
  const x=Number(signedX)||0,y=Math.max(0,Number(sumAbsY)||0),ax=Math.abs(x);
  if(phase==='tracking'){
    if(y>=24&&ax<=1.8*y)return {phase:'cancelled',armed:false,progress:0};
    if(ax<24||ax<=1.8*y)return {phase:'tracking',armed:false,progress:0};
    phase='locked';
  }
  if(phase!=='locked')return {phase,armed:false,progress:0};
  let nextArmed=!!armed;
  if(nextArmed&&ax<80)nextArmed=false;
  if(ax>=100)nextArmed=true;
  return {phase:'locked',armed:nextArmed,progress:Math.min(1,ax/100),sign:Math.sign(x)||1};
}

// R8 stage03: quote popover chain placement.
const DEFAULT_MARGIN=8;
const DEFAULT_GAP=10;
const DEFAULT_CASCADE=32;
const DEFAULT_POINTER_CLEARANCE=8;

function finite(v,fallback=0){v=Number(v);return Number.isFinite(v)?v:fallback}
function normalizeRect(r={}){
  const left=finite(r.left,finite(r.x)),top=finite(r.top,finite(r.y));
  const width=Math.max(0,finite(r.width,finite(r.right)-left)),height=Math.max(0,finite(r.height,finite(r.bottom)-top));
  return {left,top,right:Number.isFinite(Number(r.right))?Number(r.right):left+width,bottom:Number.isFinite(Number(r.bottom))?Number(r.bottom):top+height,width,height};
}
function pointRectDistance(point,rect){
  if(!point)return 0;rect=normalizeRect(rect);const x=finite(point.x),y=finite(point.y);
  const dx=x<rect.left?rect.left-x:x>rect.right?x-rect.right:0;
  const dy=y<rect.top?rect.top-y:y>rect.bottom?y-rect.bottom:0;
  return Math.hypot(dx,dy);
}
function rectOverflow(rect,viewport,margin=DEFAULT_MARGIN){
  rect=normalizeRect(rect);const w=Math.max(0,finite(viewport?.width)),h=Math.max(0,finite(viewport?.height));
  return Math.max(0,margin-rect.left)+Math.max(0,rect.right-(w-margin))+Math.max(0,margin-rect.top)+Math.max(0,rect.bottom-(h-margin));
}
function clampPlacement(left,top,width,height,viewport,margin=DEFAULT_MARGIN){
  const vw=Math.max(0,finite(viewport?.width)),vh=Math.max(0,finite(viewport?.height));
  const maxLeft=Math.max(margin,vw-margin-width),maxTop=Math.max(margin,vh-margin-height);
  left=Math.min(maxLeft,Math.max(margin,finite(left,margin)));
  top=Math.min(maxTop,Math.max(margin,finite(top,margin)));
  return {left,top,right:left+width,bottom:top+height,width,height};
}
function pointerClear(rect,pointer,clearance=DEFAULT_POINTER_CLEARANCE){
  if(!pointer||pointer.kind==='keyboard')return true;rect=normalizeRect(rect);const x=finite(pointer.x,-1e9),y=finite(pointer.y,-1e9);
  return x<=rect.left-clearance||x>=rect.right+clearance||y<=rect.top-clearance||y>=rect.bottom+clearance;
}
function moveAwayFromPointer(candidate,{pointer,viewport,margin,width,height,direction,clearance}){
  if(!pointer||pointer.kind==='keyboard'||pointerClear(candidate,pointer,clearance))return candidate;
  const x=finite(pointer.x),y=finite(pointer.y),variants=[];
  if(direction==='left')variants.push([x-width-clearance,candidate.top]);
  else variants.push([x+clearance,candidate.top]);
  variants.push([candidate.left,y+clearance],[candidate.left,y-height-clearance]);
  for(const [l,t] of variants){const raw={left:l,top:t,right:l+width,bottom:t+height,width,height};if(rectOverflow(raw,viewport,margin)===0&&pointerClear(raw,pointer,clearance))return raw}
  for(const [l,t] of variants){const clamped=clampPlacement(l,t,width,height,viewport,margin);if(pointerClear(clamped,pointer,clearance))return clamped}
  return candidate;
}
function preserveParentBand(rect,parentRect,direction,band=24,viewport=null,margin=DEFAULT_MARGIN){
  if(!parentRect)return rect;rect=normalizeRect(rect);parentRect=normalizeRect(parentRect);
  const overlapX=Math.max(0,Math.min(rect.right,parentRect.right)-Math.max(rect.left,parentRect.left));
  const overlapY=Math.max(0,Math.min(rect.bottom,parentRect.bottom)-Math.max(rect.top,parentRect.top));
  if(!overlapX||!overlapY)return rect;
  let left=rect.left;
  if(direction==='right'&&left<parentRect.left+band)left=parentRect.left+band;
  if(direction==='left'&&rect.right>parentRect.right-band)left=parentRect.right-band-rect.width;
  return viewport?clampPlacement(left,rect.top,rect.width,rect.height,viewport,margin):rawCandidate(left,rect.top,rect.width,rect.height,rect.mode,direction);
}
function parentExposurePenalty(rect,parentRect,direction,cascade=DEFAULT_CASCADE){
  if(!parentRect)return 0;rect=normalizeRect(rect);parentRect=normalizeRect(parentRect);
  const overlapX=Math.max(0,Math.min(rect.right,parentRect.right)-Math.max(rect.left,parentRect.left));
  const overlapY=Math.max(0,Math.min(rect.bottom,parentRect.bottom)-Math.max(rect.top,parentRect.top));
  if(!overlapX||!overlapY)return 0;
  const visibleBand=direction==='left'?rect.right-parentRect.left:parentRect.right-rect.left;
  return Math.max(0,cascade-Math.abs(visibleBand));
}
function candidateDistance(rect,anchorRect,pointer){
  const point=pointer&&pointer.kind!=='keyboard'?pointer:{x:(anchorRect.left+anchorRect.right)/2,y:(anchorRect.top+anchorRect.bottom)/2};
  return pointRectDistance(point,rect);
}
function rawCandidate(left,top,width,height,mode,direction){return {left,top,right:left+width,bottom:top+height,width,height,mode,direction}}

export function choosePopoverPlacement({anchorRect,parentRect=null,popSize,viewport,primaryDirection=null,depth=0,pointer=null,margin=DEFAULT_MARGIN,gap=DEFAULT_GAP,cascade=DEFAULT_CASCADE,pointerClearance=DEFAULT_POINTER_CLEARANCE}={}){
  anchorRect=normalizeRect(anchorRect);parentRect=parentRect?normalizeRect(parentRect):null;
  const width=Math.min(Math.max(1,finite(popSize?.width,1)),Math.max(1,finite(viewport?.width)-margin*2));
  const height=Math.min(Math.max(1,finite(popSize?.height,1)),Math.max(1,finite(viewport?.height)-margin*2));
  const primary=primaryDirection==='left'||primaryDirection==='right'?primaryDirection:null;
  const directions=primary?[primary]:['right','left'];
  const candidates=[];
  for(const direction of directions){
    const sideLeft=direction==='right'?anchorRect.right+gap:anchorRect.left-width-gap;
    candidates.push(rawCandidate(sideLeft,anchorRect.top,width,height,'anchor-near',direction));
    if(parentRect&&depth>0){
      const cascadeLeft=direction==='right'?parentRect.left+cascade:parentRect.right-width-cascade;
      candidates.push(rawCandidate(cascadeLeft,parentRect.top+cascade,width,height,'cascade',direction));
      const parentSide=direction==='right'?parentRect.right+gap:parentRect.left-width-gap;
      candidates.push(rawCandidate(parentSide,anchorRect.top,width,height,'parent-side',direction));
    }
  }
  // Vertical-near fallback is for nested layers: keep the chain in the same stack before an extreme horizontal jump.
  if(parentRect&&depth>0){
    const stackLeft=primary==='left'?parentRect.right-width-cascade:parentRect.left+cascade;
    candidates.push(rawCandidate(stackLeft,anchorRect.bottom+gap,width,height,'vertical-stack',primary||'right'));
    candidates.push(rawCandidate(stackLeft,anchorRect.top-height-gap,width,height,'vertical-stack',primary||'right'));
  }

  const scored=candidates.map((raw,index)=>{
    const overflow=rectOverflow(raw,viewport,margin);
    let placed=overflow===0?raw:clampPlacement(raw.left,raw.top,width,height,viewport,margin);
    placed=preserveParentBand(placed,parentRect,raw.direction,24,viewport,margin);
    placed=moveAwayFromPointer(placed,{pointer,viewport,margin,width,height,direction:raw.direction,clearance:pointerClearance});
    const postOverflow=rectOverflow(placed,viewport,margin);
    const distance=candidateDistance(placed,anchorRect,pointer);
    const directionPenalty=primary&&raw.direction!==primary?1:0;
    const exposurePenalty=parentExposurePenalty(placed,parentRect,raw.direction,cascade);
    const pointerPenalty=pointerClear(placed,pointer,pointerClearance)?0:1;
    return {...placed,mode:raw.mode,direction:raw.direction,score:[overflow>0?1:0,overflow,pointerPenalty,distance,directionPenalty,exposurePenalty,index],rawOverflow:overflow,postOverflow};
  });
  if(primary&&!scored.some(x=>x.postOverflow===0&&x.score[2]===0)){
    const reverse=primary==='right'?'left':'right',fallbacks=[];
    const sideLeft=reverse==='right'?anchorRect.right+gap:anchorRect.left-width-gap;
    fallbacks.push(rawCandidate(sideLeft,anchorRect.top,width,height,'reverse-anchor',reverse));
    if(parentRect){const parentSide=reverse==='right'?parentRect.right+gap:parentRect.left-width-gap;fallbacks.push(rawCandidate(parentSide,parentRect.top+cascade,width,height,'reverse-stack',reverse))}
    for(const raw of fallbacks){const index=scored.length,overflow=rectOverflow(raw,viewport,margin);let placed=overflow===0?raw:clampPlacement(raw.left,raw.top,width,height,viewport,margin);placed=preserveParentBand(placed,parentRect,raw.direction,24,viewport,margin);placed=moveAwayFromPointer(placed,{pointer,viewport,margin,width,height,direction:raw.direction,clearance:pointerClearance});const postOverflow=rectOverflow(placed,viewport,margin),distance=candidateDistance(placed,anchorRect,pointer),exposurePenalty=parentExposurePenalty(placed,parentRect,raw.direction,cascade),pointerPenalty=pointerClear(placed,pointer,pointerClearance)?0:1;scored.push({...placed,mode:raw.mode,direction:raw.direction,score:[overflow>0?1:0,overflow,pointerPenalty,distance,1,exposurePenalty,index],rawOverflow:overflow,postOverflow})}
  }
  scored.sort((a,b)=>{for(let i=0;i<a.score.length;i++){const d=a.score[i]-b.score[i];if(d)return d}return 0});
  const best=scored[0];
  return {...best,primaryDirection:primary||best.direction};
}

export function chooseClientRect(rects,pointer=null,{keyboard=false}={}){
  const list=[...(rects||[])].map(normalizeRect).filter(r=>r.width||r.height);
  if(!list.length)return null;
  if(keyboard||!pointer)return list[0];
  const x=finite(pointer.x),y=finite(pointer.y);
  const contains=list.find(r=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom);if(contains)return contains;
  return list.slice().sort((a,b)=>pointRectDistance({x,y},a)-pointRectDistance({x,y},b))[0];
}

export const POPOVER_PLACEMENT_DEFAULTS=Object.freeze({margin:DEFAULT_MARGIN,gap:DEFAULT_GAP,cascade:DEFAULT_CASCADE,pointerClearance:DEFAULT_POINTER_CLEARANCE});

