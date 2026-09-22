import {app,BrowserWindow,ipcMain,session,shell,screen,nativeTheme,Menu,dialog,utilityProcess,clipboard,safeStorage} from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLiveBoardServer} from './server.mjs';
import {youtubeEmbedReferer,validatePersistedState,shouldAcceptRevision,isTrustedRuntimeFrame,migrateUiLayoutState} from './core.mjs';
import {PermitBroker} from './permit-broker.mjs';
import {MarkdownExportManager} from './markdown-export-manager.mjs';
import {WsbLocalRuntime} from './wsb-local-runtime.mjs';
import {WsbTokenStore} from './wsb-token-store.mjs';
import {WsbRuntimeManager} from './wsb-runtime-manager.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const APP_ID='local.liveboard.desktop';
const MARKDOWN_OWNER='main';
const MARKDOWN_EXPORT_BOARDS=new Set(['edge','5ch','holo','niji','futaba']);
let runtime=null,mainWindow=null,quitting=false,writeChain=Promise.resolve(),latestRevision=-1,latestState=null,flushResolve=null,lastNormalBounds=null,htmlFullscreen=false,storageWriteBlocked=false,markdownExportManager=null,wsbLocalRuntime=null,wsbRuntimeManager=null;
const sharedPermitBroker=new PermitBroker({perHost:4,maxExport:1});
let gestureSessionCounter=0,gestureSequence=0,activeGestureSessionId=0;
const cliHasFlag=name=>process.argv.includes(`--${name}`);
const cliValue=name=>{const prefix=`--${name}=`;const arg=process.argv.find(v=>String(v).startsWith(prefix));return arg?String(arg).slice(prefix.length):''};
const smokeMode=process.env.LIVEBOARD_SMOKE==='1'||cliHasFlag('liveboard-smoke-test');
const rendererTestMode=process.env.LIVEBOARD_RENDERER_TEST==='1'||cliHasFlag('liveboard-renderer-test');
const emptyRendererTestMode=process.env.LIVEBOARD_RENDERER_EMPTY_TEST==='1'||cliHasFlag('liveboard-renderer-empty-test');
const startupResultFile=cliValue('liveboard-startup-result');
const startupTestMode=smokeMode||rendererTestMode||emptyRendererTestMode;
let testUserData='',startupFixture=null,startupTestSettled=false;
if(startupTestMode){testUserData=fsSync.mkdtempSync(path.join(os.tmpdir(),'liveboard-startup-'));app.setPath('userData',testUserData)}
if(rendererTestMode||emptyRendererTestMode){const savedPanes=emptyRendererTestMode?[]:[{board:'edge',title:'saved edge',url:'https://bbs.eddibb.cc/liveedge/1789717505',follow:false},{board:'5ch',title:'saved 5ch',url:'https://egg.5ch.io/test/read.cgi/stock/1789721696/',follow:false},{board:'holo',title:'saved holo',url:'https://bbs.jpnkn.com/test/read.cgi/hololiveneet/1789720702/',follow:false},{board:'niji',title:'saved niji',url:'https://bbs.jpnkn.com/test/read.cgi/nijifunbbs/1789709833/',follow:false}];fsSync.writeFileSync(path.join(testUserData,'state.json'),JSON.stringify({schemaVersion:2,panes:savedPanes,drafts:{},windowBounds:null,uiLayoutVersion:2},null,2),'utf8')}
app.setName('LiveBoard');app.setAppUserModelId(APP_ID);app.enableSandbox();
const gotLock=app.requestSingleInstanceLock();if(!gotLock)app.quit();


const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function createStartupFixture(){
  const stats={boardRequests:0,threadRequests:0};
  const urls={edge:'https://bbs.eddibb.cc/liveedge/1789717505', '5ch':'https://egg.5ch.io/test/read.cgi/stock/1789721696/', holo:'https://bbs.jpnkn.com/test/read.cgi/hololiveneet/1789720702/', niji:'https://bbs.jpnkn.com/test/read.cgi/nijifunbbs/1789709833/', futaba:'https://may.2chan.net/b/res/143570000.htm'};
  const edgeThreads=[
    {board:'edge',key:'1789717505',title:'fixture edge 1',url:urls.edge,count:180,heat:9000},
    {board:'edge',key:'1789717605',title:'fixture edge 2',url:'https://bbs.eddibb.cc/liveedge/1789717605',count:120,heat:7000},
    {board:'edge',key:'1789717705',title:'fixture edge 3',url:'https://bbs.eddibb.cc/liveedge/1789717705',count:60,heat:5000}
  ];
  return {
    stats,
    async getBoardList(id){stats.boardRequests++;const threads=id==='edge'?edgeThreads:[{board:id,key:`fixture-${id}`,title:`fixture ${id}`,url:urls[id]||urls.edge,count:42,heat:1200}];return {board:id,source:'fixture',threads}},
    async getThread(id,url){stats.threadRequests++;return {board:id,url,title:`fixture ${id}`,source:'fixture',complete:true,endHint:false,endConfirmed:false,posts:[{key:'1',n:1,name:'',id:'FIXTURE',date:'2026/09/19 17:00:00',body:`fixture body ${id}`,attachments:[]}]}}
  };
}
async function rendererStartupSnapshot(){
  if(!mainWindow||mainWindow.isDestroyed())throw new Error('Renderer window is unavailable');
  return mainWindow.webContents.executeJavaScript(`(()=>({state:document.documentElement.dataset.liveboardInit||'',error:document.documentElement.dataset.liveboardInitError||'',failureText:document.querySelector('#grid')?.textContent||'',paneCount:document.querySelectorAll('.pane').length,postCount:document.querySelectorAll('.pane .post').length,rankCount:document.querySelectorAll('#tickerTrack .rankItem').length,boardButtonCount:document.querySelectorAll('#boardNav [data-board]').length,menuHidden:document.querySelector('#boardNav')?.hidden??true,splashText:document.querySelector('#grid .splash')?.textContent||''}))()`,true);
}
async function waitForRendererInit(timeoutMs=10000){
  const deadline=Date.now()+timeoutMs;let last={state:''};
  while(Date.now()<deadline){
    last=await rendererStartupSnapshot();
    if(last.state==='ready')return last;
    if(last.state==='failed')throw new Error(`Renderer initialization failed: ${last.error||'unknown'} | ${last.failureText||''}`);
    await delay(100);
  }
  throw new Error(`Renderer initialization timed out after ${timeoutMs}ms (state=${last.state||'missing'})`);
}
async function waitForFixtureUi(timeoutMs=3000){
  const deadline=Date.now()+timeoutMs;let snap=null;
  while(Date.now()<deadline){
    snap=await rendererStartupSnapshot();
    if((startupFixture?.stats.threadRequests||0)>=4&&(startupFixture?.stats.boardRequests||0)>=1&&snap.postCount>=4&&snap.rankCount>=1)return snap;
    await delay(50);
  }
  throw new Error(`Fixture UI did not settle: ${JSON.stringify({stats:startupFixture?.stats,snap})}`);
}
function requireTest(condition,message){if(!condition)throw new Error(`Renderer startup assertion failed: ${message}`)}
async function runRendererStartupAssertions(){
  const snap=await waitForFixtureUi();
  requireTest(snap.state==='ready','ready marker missing');
  requireTest(snap.paneCount===4,`expected 4 restored panes, got ${snap.paneCount}`);
  requireTest(snap.postCount>=4,`fixture posts were not rendered (${snap.postCount})`);
  requireTest(snap.rankCount>=1,'fixture ranking was not rendered');
  requireTest(snap.boardButtonCount===5,`expected 5 board buttons, got ${snap.boardButtonCount}`);
  const initialThreadRequests=startupFixture.stats.threadRequests,initialBoardRequests=startupFixture.stats.boardRequests;
  requireTest(initialThreadRequests===4,`initial thread refresh registered more than once (${initialThreadRequests})`);
  requireTest(initialBoardRequests===1,`initial ranking refresh registered more than once (${initialBoardRequests})`);
  await delay(4300);
  requireTest(startupFixture.stats.threadRequests===initialThreadRequests+4,`4s periodic refresh is duplicated or missing (${initialThreadRequests} -> ${startupFixture.stats.threadRequests})`);
  const menu=await mainWindow.webContents.executeJavaScript(`(()=>{document.querySelector('#menuBtn').click();return {hidden:document.querySelector('#boardNav').hidden,count:document.querySelectorAll('#boardNav [data-board]').length}})()`,true);
  requireTest(menu.hidden===false&&menu.count===5,'board menu did not open');
  const menuClosed=await mainWindow.webContents.executeJavaScript(`(()=>{document.querySelector('#menuBtn').click();return document.querySelector('#boardNav').hidden})()`,true);
  requireTest(menuClosed===true,'board menu did not close');
  await mainWindow.webContents.executeJavaScript(`document.querySelector('#menuBtn').click()`,true);
  const empty=await mainWindow.webContents.executeJavaScript(`(()=>{document.querySelector('#clear').click();return {paneCount:document.querySelectorAll('.pane').length,splash:document.querySelector('#grid .splash')?.textContent||''}})()`,true);
  requireTest(empty.paneCount===0&&empty.splash.includes('メニューから板を選んでスレッドを開く'),'empty workspace was not rendered after clearing panes');
}
async function runEmptyWorkspaceAssertions(){
  const deadline=Date.now()+3000;let snap=null;
  while(Date.now()<deadline){snap=await rendererStartupSnapshot();if((startupFixture?.stats.boardRequests||0)>=1&&snap.rankCount>=1)break;await delay(50)}
  requireTest(snap?.state==='ready','ready marker missing for empty workspace');
  requireTest(snap.paneCount===0,`saved empty workspace restored ${snap.paneCount} panes`);
  requireTest((snap.splashText||'').includes('メニューから板を選んでスレッドを開く'),'saved empty workspace guidance is missing');
  requireTest(startupFixture.stats.threadRequests===0,`empty workspace unexpectedly fetched threads (${startupFixture.stats.threadRequests})`);
  const menu=await mainWindow.webContents.executeJavaScript(`(()=>{document.querySelector('#menuBtn').click();return {hidden:document.querySelector('#boardNav').hidden,count:document.querySelectorAll('#boardNav [data-board]').length}})()`,true);
  requireTest(menu.hidden===false&&menu.count===5,'board menu did not open from empty workspace');
}
async function finishStartupTest(ok,label,error=null){
  if(startupTestSettled)return;startupTestSettled=true;
  const errorText=error?.stack||String(error||'');
  if(startupResultFile){
    try{fsSync.writeFileSync(startupResultFile,JSON.stringify({ok,label,error:errorText,pid:process.pid,at:new Date().toISOString()}),'utf8')}
    catch(writeError){console.error(`LIVEBOARD_STARTUP_RESULT_WRITE_FAIL ${writeError?.stack||writeError}`)}
  }
  if(ok)console.log(label);else console.error(`LIVEBOARD_SMOKE_FAIL ${errorText||'unknown failure'}`);
  await shutdown(ok?0:1);
}
async function verifyRendererStartup(){
  try{
    await waitForRendererInit(10000);
    if(rendererTestMode){await runRendererStartupAssertions();await finishStartupTest(true,'LIVEBOARD_RENDERER_TEST_OK')}
    else if(emptyRendererTestMode){await runEmptyWorkspaceAssertions();await finishStartupTest(true,'LIVEBOARD_RENDERER_EMPTY_TEST_OK')}
    else await finishStartupTest(true,'LIVEBOARD_SMOKE_OK');
  }catch(e){await finishStartupTest(false,'',e)}
}

function isSafeExternal(value=''){try{const u=new URL(String(value));return u.protocol==='https:'||u.protocol==='http:'}catch{return false}}
function runtimeUrl(){try{return new URL(runtime?.url||'')}catch{return null}}
function senderIsApp(event){return isTrustedRuntimeFrame({runtimeUrl:runtime?.url||'',frameUrl:event.senderFrame?.url||'',senderMatches:event.sender===mainWindow?.webContents,mainFrame:event.senderFrame===mainWindow?.webContents.mainFrame})}
function statePaths(){const dir=app.getPath('userData');return {file:path.join(dir,'state.json'),backup:path.join(dir,'state.backup.json'),tmp:path.join(dir,'state.tmp.json'),corrupt:path.join(dir,`state.corrupt-${Date.now()}.json`)}}
function validateState(value){return validatePersistedState(value)}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return null}}
async function loadState(){const p=statePaths(),raw=await readJson(p.file);if(raw&&Number(raw.schemaVersion)>4){storageWriteBlocked=true;return {schemaVersion:4,panes:null,drafts:{},readPositions:{},windowBounds:null,uiLayoutVersion:2,storageUnsupportedSchema:Number(raw.schemaVersion)}}const primary=validateState(raw);if(primary){storageWriteBlocked=false;return primary}const backupRaw=await readJson(p.backup);if(backupRaw&&Number(backupRaw.schemaVersion)>4){storageWriteBlocked=true;return {schemaVersion:4,panes:null,drafts:{},readPositions:{},windowBounds:null,uiLayoutVersion:2,storageUnsupportedSchema:Number(backupRaw.schemaVersion)}}const backup=validateState(backupRaw);if(backup){storageWriteBlocked=false;return {...backup,recoveredFromBackup:true}}try{await fs.access(p.file);await fs.rename(p.file,p.corrupt)}catch{}storageWriteBlocked=false;return {schemaVersion:4,panes:null,drafts:{},readPositions:{},windowBounds:null,uiLayoutVersion:2,storageReset:true}}
async function atomicWrite(state){const p=statePaths();await fs.mkdir(path.dirname(p.file),{recursive:true});try{await fs.copyFile(p.file,p.backup)}catch{}await fs.writeFile(p.tmp,JSON.stringify(state,null,2),'utf8');await fs.rename(p.tmp,p.file)}
function queueWrite(revision,state){if(storageWriteBlocked)throw new Error('State schema is newer than this LiveBoard version');const valid=validateState(state);if(!valid)throw new Error('State rejected');if(!shouldAcceptRevision(revision,latestRevision))return writeChain;latestRevision=Number(revision)||0;latestState={...valid,uiLayoutVersion:Number(latestState?.uiLayoutVersion||valid.uiLayoutVersion)||2,windowBounds:lastNormalBounds||valid.windowBounds||null};writeChain=writeChain.then(()=>atomicWrite(latestState));return writeChain}
function saneBounds(saved){const displays=screen.getAllDisplays();const primary=screen.getPrimaryDisplay().workArea;let b=saved&&typeof saved==='object'?{...saved}:{width:667,height:900,x:primary.x+40,y:primary.y+40};b.width=Math.max(667,Number(b.width)||667);b.height=Math.max(600,Math.min(Number(b.height)||900,primary.height));const visible=displays.some(d=>{const w=d.workArea;return b.x<w.x+w.width-80&&b.x+b.width>w.x+80&&b.y<w.y+w.height-80&&b.y+b.height>w.y+80});if(!visible){b.x=primary.x+Math.max(0,Math.floor((primary.width-b.width)/2));b.y=primary.y+Math.max(0,Math.floor((primary.height-b.height)/2))}return b}
async function requestRendererFlush(){if(!mainWindow||mainWindow.isDestroyed())return;await new Promise(resolve=>{flushResolve=resolve;mainWindow.webContents.send('liveboard:flush-request');setTimeout(resolve,1500)});flushResolve=null}
async function shutdown(exitCode=null){if(quitting)return;quitting=true;try{await wsbRuntimeManager?.shutdown?.()}catch{}try{await markdownExportManager?.shutdown?.()}catch{}if(!startupTestMode){try{await requestRendererFlush();await writeChain}catch{}}try{await Promise.race([runtime?.close?.(),new Promise(r=>setTimeout(r,1000))])}catch{}runtime=null;try{sharedPermitBroker.close()}catch{}if(testUserData){try{await fs.rm(testUserData,{recursive:true,force:true})}catch{}}if(startupTestMode){app.exit(Number.isInteger(exitCode)?exitCode:1);return}app.quit()}

async function createWindow(){
  if(!wsbLocalRuntime)wsbLocalRuntime=new WsbLocalRuntime({resourcesPath:process.resourcesPath,appPath:app.getAppPath(),userData:app.getPath('userData'),isPackaged:app.isPackaged,platform:process.platform});
  if(!wsbRuntimeManager){const tokenStore=new WsbTokenStore({userData:app.getPath('userData'),safeStorage});wsbRuntimeManager=new WsbRuntimeManager({utilityProcess,workerPath:path.join(__dirname,'wsb-runtime-worker.mjs'),localRuntime:wsbLocalRuntime,tokenStore,openExternal:url=>shell.openExternal(url),onEvent:event=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('liveboard:wsb:event',event)}})}
  let saved=await loadState();const needsLayoutMigration=Number(saved.uiLayoutVersion)!==2;saved=migrateUiLayoutState(saved);if(needsLayoutMigration){try{await atomicWrite(saved)}catch{}}latestState=saved;const token=crypto.randomBytes(32).toString('hex');startupFixture=startupTestMode?createStartupFixture():null;if(!markdownExportManager){markdownExportManager=new MarkdownExportManager({utilityProcess,workerPath:path.join(__dirname,'markdown-export-worker.mjs'),spoolRoot:path.join(app.getPath('userData'),'markdown-export'),downloadsDir:app.getPath('downloads'),permitBroker:sharedPermitBroker,onProgress:snapshot=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('liveboard:markdown:progress',snapshot)},onState:snapshot=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('liveboard:markdown:state',snapshot)}});await markdownExportManager.initialize()}runtime=await startLiveBoardServer({port:0,accessToken:token,testFixture:startupFixture,permitBroker:sharedPermitBroker});
  const ses=session.defaultSession;ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ses.webRequest.onBeforeSendHeaders({urls:['https://www.youtube-nocookie.com/embed/*']},(details,cb)=>{const headers={...details.requestHeaders};const referer=youtubeEmbedReferer(details,mainWindow?.webContents.id);if(referer)headers.Referer=referer;cb({requestHeaders:headers})});
  nativeTheme.themeSource='system';const b=saneBounds(saved.windowBounds);
  mainWindow=new BrowserWindow({width:b.width,height:b.height,x:b.x,y:b.y,minWidth:667,minHeight:600,backgroundColor:nativeTheme.shouldUseDarkColors?'#111214':'#f5f8fa',show:false,webPreferences:{preload:path.join(__dirname,'electron-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  lastNormalBounds={...b};const remember=()=>{if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.isMaximized()&&!mainWindow.isFullScreen())lastNormalBounds=mainWindow.getBounds()};mainWindow.on('move',remember);mainWindow.on('resize',remember);
  mainWindow.on('close',e=>{if(quitting)return;e.preventDefault();if(latestState)latestState={...latestState,windowBounds:lastNormalBounds};void shutdown()});
  nativeTheme.on('updated',()=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#111214':'#f5f8fa')});
  mainWindow.webContents.setWindowOpenHandler(({url})=>{if(isSafeExternal(url))void shell.openExternal(url);return {action:'deny'}});
  mainWindow.webContents.on('will-navigate',(event,url)=>{const base=runtimeUrl();try{const u=new URL(url);if(!base||u.origin!==base.origin||!u.pathname.startsWith(base.pathname))event.preventDefault()}catch{event.preventDefault()}});
  mainWindow.webContents.on('enter-html-full-screen',()=>{htmlFullscreen=true});mainWindow.webContents.on('leave-html-full-screen',()=>{htmlFullscreen=false});mainWindow.webContents.on('before-input-event',(event,input)=>{if(input.key==='Escape'&&!htmlFullscreen){mainWindow.webContents.send('liveboard:escape');event.preventDefault()}});
  const sendGestureLifecycle=(phase,sessionId,reason='')=>{if(!mainWindow||mainWindow.isDestroyed()||!sessionId)return;const payload={phase,sessionId,sequence:++gestureSequence,reason};if(process.env.LIVEBOARD_GESTURE_DEBUG==='1')console.debug('[LiveBoard gesture main]',payload);mainWindow.webContents.send('liveboard:gesture-lifecycle',payload)};
  mainWindow.webContents.on('input-event',(_event,input)=>{const type=input?.type;if(type==='gestureScrollBegin'){if(activeGestureSessionId)sendGestureLifecycle('cancel',activeGestureSessionId,'superseded');activeGestureSessionId=++gestureSessionCounter;sendGestureLifecycle('begin',activeGestureSessionId,'scroll-begin');return}if(type==='gestureScrollEnd'||type==='gestureFlingStart'){if(!activeGestureSessionId)return;const id=activeGestureSessionId;activeGestureSessionId=0;sendGestureLifecycle('end',id,type==='gestureFlingStart'?'fling-start':'scroll-end');return}if(type==='gestureFlingCancel'&&activeGestureSessionId){const id=activeGestureSessionId;activeGestureSessionId=0;sendGestureLifecycle('cancel',id,'fling-cancel')}});
  mainWindow.once('ready-to-show',()=>{if(!startupTestMode)mainWindow.show()});
  mainWindow.webContents.once('did-fail-load',(_event,code,description)=>{if(startupTestMode)void finishStartupTest(false,'',new Error(`did-fail-load ${code} ${description}`))});
  mainWindow.webContents.once('render-process-gone',(_event,details)=>{if(startupTestMode)void finishStartupTest(false,'',new Error(`render-process-gone ${details?.reason||''}`))});
  mainWindow.webContents.once('preload-error',(_event,_path,error)=>{if(startupTestMode)void finishStartupTest(false,'',error||new Error('preload-error'))});
  mainWindow.webContents.once('did-finish-load',()=>{if(startupTestMode)void verifyRendererStartup()});
  await mainWindow.loadURL(runtime.url);
}

ipcMain.handle('liveboard:openExternal',async(event,url)=>{if(!senderIsApp(event)||!isSafeExternal(url))throw new Error('External URL rejected');await shell.openExternal(String(url));return true});
ipcMain.handle('liveboard:appInfo',event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return {version:app.getVersion(),platform:process.platform}});
ipcMain.handle('liveboard:storage:load',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return loadState()});
ipcMain.handle('liveboard:storage:save',async(event,payload)=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');await queueWrite(payload?.revision,payload?.state);return true});
ipcMain.handle('liveboard:storage:flush',async(event,payload)=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');await queueWrite(payload?.revision,payload?.state);flushResolve?.();return true});
ipcMain.handle('liveboard:markdown:start',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const requested=Array.isArray(payload.boardIds)?payload.boardIds:['edge','5ch','holo','niji','futaba'],boardIds=[...new Set(requested.map(String).filter(id=>MARKDOWN_EXPORT_BOARDS.has(id)))],minimumPosts=payload.minimumPosts??payload.minPosts??30;if(!boardIds.length)throw new Error('No export-capable boards selected');return markdownExportManager.start({boardIds,minimumPosts,ownerId:MARKDOWN_OWNER})});
ipcMain.handle('liveboard:markdown:cancel',(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return markdownExportManager.cancel({jobId:payload.jobId,ownerId:MARKDOWN_OWNER,finalizePartial:payload.finalizePartial===true})});
ipcMain.handle('liveboard:markdown:status',event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return markdownExportManager.status({ownerId:MARKDOWN_OWNER})});
ipcMain.handle('liveboard:markdown:copy',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return markdownExportManager.copy({jobId:payload.jobId,ownerId:MARKDOWN_OWNER,partIndex:payload.partIndex,clipboard})});
ipcMain.handle('liveboard:markdown:retry-save',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return markdownExportManager.retrySave({jobId:payload.jobId,ownerId:MARKDOWN_OWNER})});
ipcMain.handle('liveboard:markdown:save-as',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const jobId=String(payload.jobId||'');const current=markdownExportManager.status({ownerId:MARKDOWN_OWNER});if(current.jobId!==jobId||current.state!=='save-failed')throw new Error('Save As is not available');const r=await dialog.showSaveDialog(mainWindow,{title:'AI用Markdownを別の場所に保存',defaultPath:path.join(app.getPath('downloads'),`LiveBoard_AI_${jobId.slice(-12)||'recovered'}.md`),filters:[{name:'Markdown',extensions:['md']}],properties:['createDirectory','showOverwriteConfirmation']});if(r.canceled||!r.filePath)return current;return markdownExportManager.saveAs({jobId,ownerId:MARKDOWN_OWNER,destinationPath:r.filePath})});
ipcMain.handle('liveboard:markdown:show-in-folder',event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const current=markdownExportManager.status({ownerId:MARKDOWN_OWNER}),target=String(current.save?.path||'');if(!target||!['saved','partial-saved'].includes(current.state))return false;shell.showItemInFolder(target);return true});
// R8 stage06: real OAuth/transport/utility poll/helper pipeline. Tokens remain in main secure storage.
ipcMain.handle('liveboard:wsb:capabilities',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.capabilities()});
ipcMain.handle('liveboard:wsb:settings:get',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.readSettings()});
ipcMain.handle('liveboard:wsb:settings:save',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const settings=await wsbRuntimeManager.saveSettings(payload);return {settings,capabilities:await wsbRuntimeManager.capabilities()}});
ipcMain.handle('liveboard:wsb:prepare-translation',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.prepareTranslation()});
ipcMain.handle('liveboard:wsb:translation-test',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.translationTest(payload.text)});
ipcMain.handle('liveboard:wsb:connection-test',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.connectionTest()});
ipcMain.handle('liveboard:wsb:auth:connect',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const result=await wsbRuntimeManager.beginAuthentication();return {...result,capabilities:await wsbRuntimeManager.capabilities()}});
ipcMain.handle('liveboard:wsb:auth:cancel',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.cancelAuthentication('user-cancelled')});
ipcMain.handle('liveboard:wsb:auth:disconnect',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');const result=await wsbRuntimeManager.disconnect();return {...result,capabilities:await wsbRuntimeManager.capabilities()}});
ipcMain.handle('liveboard:wsb:candidates',async event=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.discoverCandidates()});
ipcMain.handle('liveboard:wsb:start',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.startThread(payload)});
ipcMain.handle('liveboard:wsb:stop',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.stopThread(payload)});
ipcMain.handle('liveboard:wsb:pause',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.pause(payload)});
ipcMain.handle('liveboard:wsb:resume',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.resume(payload)});
ipcMain.handle('liveboard:wsb:helper-stop',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.stopHelper(payload)});
ipcMain.handle('liveboard:wsb:retention',async(event,payload={})=>{if(!senderIsApp(event))throw new Error('IPC sender rejected');return wsbRuntimeManager.setRetention(payload)});
ipcMain.on('liveboard:close-modal',event=>{if(senderIsApp(event))mainWindow?.webContents.send('liveboard:escape')});

app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()}});
app.whenReady().then(async()=>{if(!gotLock)return;Menu.setApplicationMenu(Menu.buildFromTemplate([{label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'ファイル',submenu:[{label:'設定を書き出す',click:()=>mainWindow?.webContents.send('liveboard:data-export')},{label:'設定を読み込む…',click:async()=>{if(!mainWindow)return;const r=await dialog.showOpenDialog(mainWindow,{properties:['openFile'],filters:[{name:'LiveBoard設定',extensions:['json']}]});if(r.canceled||!r.filePaths[0])return;try{const text=await fs.readFile(r.filePaths[0],'utf8');mainWindow.webContents.send('liveboard:data-import',text)}catch(e){console.error(e)}}}]},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]));try{await createWindow()}catch(e){console.error(e);if(startupTestMode){await finishStartupTest(false,'',e);return}try{await runtime?.close?.()}catch{}app.quit()}});
app.on('window-all-closed',()=>{if(!quitting)void shutdown()});
app.on('before-quit',e=>{if(!quitting){e.preventDefault();void shutdown()}});

