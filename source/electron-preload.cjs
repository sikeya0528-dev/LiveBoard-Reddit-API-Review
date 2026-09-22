const {contextBridge,ipcRenderer}=require('electron');
const flushListeners=new Set(),escapeListeners=new Set(),exportListeners=new Set(),importListeners=new Set(),gestureListeners=new Set(),markdownListeners=new Set(),wsbListeners=new Set();
const gestureState={activeSessionId:0,lastSessionId:0,lastSequence:0,lastPhase:'idle',lastReason:''};
ipcRenderer.on('liveboard:flush-request',()=>{for(const fn of flushListeners){try{fn()}catch{}}});
ipcRenderer.on('liveboard:escape',()=>{for(const fn of escapeListeners){try{fn()}catch{}}});
ipcRenderer.on('liveboard:data-export',()=>{for(const fn of exportListeners){try{fn()}catch{}}});
ipcRenderer.on('liveboard:data-import',(_e,text)=>{for(const fn of importListeners){try{fn(String(text||''))}catch{}}});
ipcRenderer.on('liveboard:markdown:progress',(_e,payload)=>{for(const fn of markdownListeners){try{fn(payload)}catch{}}});
ipcRenderer.on('liveboard:markdown:state',(_e,payload)=>{for(const fn of markdownListeners){try{fn(payload)}catch{}}});
ipcRenderer.on('liveboard:wsb:event',(_e,payload)=>{for(const fn of wsbListeners){try{fn(payload)}catch{}}});
ipcRenderer.on('liveboard:gesture-lifecycle',(_e,payload)=>{const phase=String(payload?.phase||''),sessionId=Number(payload?.sessionId),sequence=Number(payload?.sequence),reason=String(payload?.reason||'');if(!['begin','end','cancel'].includes(phase)||!Number.isInteger(sessionId)||sessionId<=0||!Number.isInteger(sequence)||sequence<=0||sequence<=gestureState.lastSequence)return;const event=Object.freeze({phase,sessionId,sequence,reason});gestureState.lastSequence=sequence;gestureState.lastSessionId=sessionId;gestureState.lastPhase=phase;gestureState.lastReason=reason;if(phase==='begin')gestureState.activeSessionId=sessionId;else if(gestureState.activeSessionId===sessionId)gestureState.activeSessionId=0;for(const fn of gestureListeners){try{fn(event)}catch{}}});
contextBridge.exposeInMainWorld('liveboardDesktop',Object.freeze({
  openExternal:url=>ipcRenderer.invoke('liveboard:openExternal',String(url)),
  appInfo:()=>ipcRenderer.invoke('liveboard:appInfo'),
  loadState:()=>ipcRenderer.invoke('liveboard:storage:load'),
  saveState:(revision,state)=>ipcRenderer.invoke('liveboard:storage:save',{revision,state}),
  flushState:(revision,state)=>ipcRenderer.invoke('liveboard:storage:flush',{revision,state}),
  onFlushRequest:fn=>{if(typeof fn!=='function')return()=>{};flushListeners.add(fn);return()=>flushListeners.delete(fn)},
  onEscape:fn=>{if(typeof fn!=='function')return()=>{};escapeListeners.add(fn);return()=>escapeListeners.delete(fn)},
  onDataExport:fn=>{if(typeof fn!=='function')return()=>{};exportListeners.add(fn);return()=>exportListeners.delete(fn)},
  onDataImport:fn=>{if(typeof fn!=='function')return()=>{};importListeners.add(fn);return()=>importListeners.delete(fn)},
  gestureSessionSnapshot:()=>Object.freeze({...gestureState}),
  onGestureLifecycle:fn=>{if(typeof fn!=='function')return()=>{};gestureListeners.add(fn);return()=>gestureListeners.delete(fn)},
  startMarkdownExport:(boardIds,minimumPosts)=>ipcRenderer.invoke('liveboard:markdown:start',{boardIds,minimumPosts}),
  cancelMarkdownExport:(jobId,finalizePartial=false)=>ipcRenderer.invoke('liveboard:markdown:cancel',{jobId,finalizePartial}),
  markdownExportStatus:()=>ipcRenderer.invoke('liveboard:markdown:status'),
  copyMarkdownExport:(jobId,partIndex=0)=>ipcRenderer.invoke('liveboard:markdown:copy',{jobId,partIndex}),
  retryMarkdownSave:jobId=>ipcRenderer.invoke('liveboard:markdown:retry-save',{jobId}),
  saveMarkdownAs:jobId=>ipcRenderer.invoke('liveboard:markdown:save-as',{jobId}),
  showMarkdownInFolder:()=>ipcRenderer.invoke('liveboard:markdown:show-in-folder'),
  onMarkdownExportProgress:fn=>{if(typeof fn!=='function')return()=>{};markdownListeners.add(fn);return()=>markdownListeners.delete(fn)},
  wsbCapabilities:()=>ipcRenderer.invoke('liveboard:wsb:capabilities'),
  getWsbSettings:()=>ipcRenderer.invoke('liveboard:wsb:settings:get'),
  saveWsbSettings:payload=>ipcRenderer.invoke('liveboard:wsb:settings:save',payload||{}),
  prepareWsbTranslation:()=>ipcRenderer.invoke('liveboard:wsb:prepare-translation'),
  testWsbTranslation:text=>ipcRenderer.invoke('liveboard:wsb:translation-test',{text:String(text||'')}),
  testWsbConnection:()=>ipcRenderer.invoke('liveboard:wsb:connection-test'),
  connectWsbReddit:()=>ipcRenderer.invoke('liveboard:wsb:auth:connect'),
  cancelWsbRedditAuth:()=>ipcRenderer.invoke('liveboard:wsb:auth:cancel'),
  disconnectWsbReddit:()=>ipcRenderer.invoke('liveboard:wsb:auth:disconnect'),
  getWsbCandidates:()=>ipcRenderer.invoke('liveboard:wsb:candidates'),
  startWsbThread:payload=>ipcRenderer.invoke('liveboard:wsb:start',payload||{}),
  stopWsbThread:payload=>ipcRenderer.invoke('liveboard:wsb:stop',payload||{}),
  pauseWsb:payload=>ipcRenderer.invoke('liveboard:wsb:pause',payload||{}),
  resumeWsb:payload=>ipcRenderer.invoke('liveboard:wsb:resume',payload||{}),
  stopWsbHelper:payload=>ipcRenderer.invoke('liveboard:wsb:helper-stop',payload||{}),
  setWsbRetention:payload=>ipcRenderer.invoke('liveboard:wsb:retention',payload||{}),
  onWsbEvent:fn=>{if(typeof fn!=='function')return()=>{};wsbListeners.add(fn);return()=>wsbListeners.delete(fn)},
  closeModal:()=>ipcRenderer.send('liveboard:close-modal')
}));
