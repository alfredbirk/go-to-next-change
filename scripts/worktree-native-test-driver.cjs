// Disposable Mini workbench driver: expose only test RPC actions and optional native timing instrumentation.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
 const root = process.env.BGV_SWITCH_ROOT;
 const linkReceipts = [];
 if (process.env.BGV_LINK_RECEIPT_TEST === '1') {
  const showInformationMessage = vscode.window.showInformationMessage;
  fs.writeFileSync(path.join(root, 'link-receipts.json'), '[]');
  // Observe the actual notification API and leave its unresolved dismissal promise intact.
  vscode.window.showInformationMessage = function(message, ...args) {
   if (message.startsWith('Better Git: ') && message.includes(' — Worktree link received (#')) {
    linkReceipts.push(message);
    fs.writeFileSync(path.join(root, 'link-receipts.json'), JSON.stringify(linkReceipts));
   }
   return showInformationMessage.call(this, message, ...args);
  };
 }
 const usageEvents = [];
 const createOutputChannel = vscode.window.createOutputChannel;
 if (process.env.BGV_WORKTREE_USAGE_TEST === '1') vscode.window.createOutputChannel = (...args) => {
  const channel = createOutputChannel(...args);
  if (args[0] === 'Better Git') {
   const info = channel.info.bind(channel);
   channel.info = (message, ...rest) => {
    if (message.startsWith('[worktree-usage] ')) usageEvents.push(JSON.parse(message.slice('[worktree-usage] '.length)));
    info(message, ...rest);
   };
  }
  return channel;
 };
 // Native SCM group focus queues its operation but returns before that operation runs. Model a busy
 // renderer's queue in this disposable host; all actual focus/collapse commands still run natively.
 const groupFocusDelay = Number(process.env.BGV_TEST_GROUP_FOCUS_DELAY_MS ?? 0);
 const originalExecuteCommand = vscode.commands.executeCommand;
 const groupFocusTimers = new Set();
 const scmFocusTrace = [];
 const recordScmFocus = process.env.BGV_SCM_FOCUS_TRACE_TEST === '1';
 if (groupFocusDelay > 0 || recordScmFocus) vscode.commands.executeCommand = (command, ...args) => {
  if (recordScmFocus && (command.startsWith('list.') || command.startsWith('workbench.scm.'))) {
   scmFocusTrace.push({command,focused:vscode.window.state.focused});
  }
  if (groupFocusDelay <= 0 || command !== 'workbench.scm.action.focusNextResourceGroup') return originalExecuteCommand(command,...args);
  const timer=setTimeout(()=>{groupFocusTimers.delete(timer);void originalExecuteCommand(command,...args);},groupFocusDelay);
  groupFocusTimers.add(timer);
  return Promise.resolve();
 };
 const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
 const roots = JSON.parse(fs.readFileSync(path.join(root,'roots.json'),'utf8'));
 if (process.env.BGV_PREORDERED_API_TEST === '1') {
  if (vscode.extensions.getExtension('EthanSK.better-git-vscode').isActive) throw new Error('Better Git activated before the API reorder prerequisite');
  // Reproduce another extension looking up a repository before Better Git
  // activates. Git sorts its API array in place; SCM header order stays put.
  for (const p of roots.slice(0, -1)) {
   const repo = git.getRepository(vscode.Uri.file(p)) ?? await git.openRepository(vscode.Uri.file(p));
   await repo.status();
  }
  git.getRepository(vscode.Uri.file(roots[1]));
  if (git.repositories[0].rootUri.fsPath.length <= roots[1].length) throw new Error('API reorder prerequisite was not reproduced');
 }
 // Capture the real registered handler in the disposable host, avoiding OS URL
 // routing that could deliver a test link to an unrelated normal Code window.
 let uriHandler;
 const registerUriHandler = vscode.window.registerUriHandler;
 vscode.window.registerUriHandler = handler => { uriHandler=handler; return registerUriHandler(handler); };
 // Instrument the real native handoff only in this isolated ordering test.
 // Do not replace AppKit, focus checks or the production handoff itself.
 const cp = require('node:child_process');
 const originalExecFile = cp.execFile;
 const handoffEvents = [];
 const event = name => { handoffEvents.push(name); fs.writeFileSync(path.join(root, 'handoff-events.json'), JSON.stringify(handoffEvents)); };
 if (process.env.BGV_EARLY_HANDOFF_TEST === '1') cp.execFile = function(file, args, options, callback) {
  if (file !== '/usr/bin/osascript' || !args?.[3]?.includes('const destination = argv[0]')) return originalExecFile.apply(this, arguments);
  event('handoff-start');
  return originalExecFile.call(this, file, args, options, (...result) => { event('handoff-end'); callback(...result); });
 };
 let api;
 try { api = await vscode.extensions.getExtension('EthanSK.better-git-vscode').activate(); }
 finally { vscode.window.registerUriHandler=registerUriHandler; cp.execFile=originalExecFile; }
 for(const p of process.env.BGV_NATIVE_SINGLE==='1' ? [roots[1]] : roots.slice(0, -1)) { const repo=git.getRepository(vscode.Uri.file(p)) ?? await git.openRepository(vscode.Uri.file(p)); await repo.status(); }
 await vscode.commands.executeCommand('workbench.view.scm');
 if(process.env.BGV_NATIVE_SINGLE!=='1') await vscode.commands.executeCommand('workbench.scm.action.expandAllRepositories');
 const input = path.join(root,'request.json'), output=path.join(root,'result.json');
 let previous=0, busy=false;
 let watchedTabs=[];
 let tabWatch;
 const state=()=>({ repositories:git.repositories.map(repo=>({root:repo.rootUri.fsPath,selected:repo.ui.selected})), keyboardReviewActive:api.isKeyboardReviewActive?.() ?? false, mouseTrace:api.getMouseDebugTrace(), mergeEditor: Boolean(vscode.window.tabGroups.activeTabGroup.activeTab?.input?.result), focused:vscode.window.state.focused, badge:api.getCurrentReviewUri() ? api.getReviewDecorationBadge(vscode.Uri.parse(api.getCurrentReviewUri())) : undefined, trace:api.getScmTreeCommandTrace(), scmFocusTrace, active:String(vscode.window.activeTextEditor?.document.uri), tabs:vscode.window.tabGroups.activeTabGroup.tabs.map(t=>({label:t.label,active:t.isActive})) });
 fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({ roots, version:vscode.version, ...state() }));
 await new Promise(resolve=> {
  const timer=setInterval(async()=> {
   if(busy || !fs.existsSync(input)) return;
   let request; try { request=JSON.parse(fs.readFileSync(input,'utf8')); } catch {return;}
   if(request.id===previous) return;
   previous=request.id; busy=true;
   try {
    let value;
    if(request.action==='watch-tabs') {
     watchedTabs=[]; tabWatch?.dispose();
     tabWatch=vscode.window.tabGroups.onDidChangeTabs(()=>{const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input; watchedTabs.push(String(input?.modified??input?.uri));});
    }
    else if(request.action==='watched-tabs') {tabWatch?.dispose(); value=watchedTabs;}
    else if(request.action==='settle-worktree') {await api.whenWorktreePresentationSettled();}
    else if(request.action==='review-keys') {api.sampleKeyboardReviewKeys(request.keys); await api.whenKeyboardGestureSettled();}
    else if(request.action==='badge') value=api.getReviewDecorationBadge(vscode.Uri.file(path.join(roots[request.repo],request.file)));
    else if(request.action==='open') value=await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control',vscode.Uri.file(roots[request.repo]));
    else if(request.action==='plain') value=await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(path.join(roots[request.repo],request.file??'a.txt')), {preview:request.preview??true});
    else if(request.action==='working') value=await vscode.commands.executeCommand('git.openChange',vscode.Uri.file(path.join(roots[request.repo],request.file)));
    else if(request.action==='refresh') value=await git.getRepository(vscode.Uri.file(roots[request.repo])).status();
    else if(request.action==='hold-status') {
     handoffEvents.length=0; event('armed');
     const repo=git.getRepository(vscode.Uri.file(roots[request.repo])) ?? await git.openRepository(vscode.Uri.file(roots[request.repo]));
     if(!repo) throw new Error('Missing status gate repository '+roots[request.repo]);
     const prototype=Object.getPrototypeOf(repo), original=prototype.status;
     const releaseFile=path.join(root, 'release-status');
     fs.rmSync(releaseFile, {force:true});
     prototype.status=async function(...args) {
      if(this.rootUri.fsPath===roots[request.repo]) {
       prototype.status=original; event('status-start');
       await new Promise((resolve,reject)=>{ const started=Date.now(); const timer=setInterval(()=>{
        if(fs.existsSync(releaseFile)) {clearInterval(timer);resolve();}
        else if(Date.now()-started>10000) {clearInterval(timer);reject(new Error('Status gate timed out'));}
       },20); });
      }
      return original.apply(this,args);
     };
    }
    else if(request.action==='uri') {
     if(!uriHandler) throw new Error('Better Git URI handler was not captured');
     value=await uriHandler.handleUri(vscode.Uri.parse(request.uri));
    }
    else if(request.action==='uri-burst') {
     if(!uriHandler) throw new Error('Better Git URI handler was not captured');
     value=await Promise.all(request.uris.map(uri=>uriHandler.handleUri(vscode.Uri.parse(uri))));
    }
    else if(request.action==='git-config') {
     for(const [key,setting] of Object.entries(request.settings)) await vscode.workspace.getConfiguration('git').update(key,setting,vscode.ConfigurationTarget.Workspace);
    }
    else if(request.action==='scm-config') {
     for(const [key,setting] of Object.entries(request.settings)) await vscode.workspace.getConfiguration('scm').update(key,setting,vscode.ConfigurationTarget.Workspace);
    }
    else if(request.action==='config') {
     const config=vscode.workspace.getConfiguration('better-git-vscode');
     const target=request.scope==='workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
     for(const [key,setting] of Object.entries(request.settings)) await config.update(key,setting,target);
     const current=vscode.workspace.getConfiguration('better-git-vscode');
     value={enabled:current.get('worktreeLinkReturnFocus'),app:current.get('worktreeLinkReturnApp'),debugLogging:current.get('debugLogging')};
    }
    else if(request.action==='copy') {
     const before=await vscode.env.clipboard.readText();
     let copied;
     try { await vscode.commands.executeCommand('better-git-vscode.copy-worktree-link',{rootUri:vscode.Uri.file(roots[request.repo])}); copied=await vscode.env.clipboard.readText(); value=copied; }
     finally { if(copied!==undefined && await vscode.env.clipboard.readText()===copied) await vscode.env.clipboard.writeText(before); }
    }
    else if(request.action==='usage-log') value=usageEvents;
    else if(request.action==='stage-history') {
     await api.whenStageTransactionsSettled(); await api.whenStageHistorySettled();
     const file=api.getStageHistoryFile();
     value={file,records:file ? fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)) : []};
    }
    else if(request.action==='native-accessibility') value=JSON.parse(cp.execFileSync(require('node:path').join(__dirname,'../dist/scm-review-scroll'),[process.env.VSCODE_PID],{encoding:'utf8',timeout:3000,input:JSON.stringify({id:1,action:'state'})+'\n'}));
    else if(request.action==='command') value=await vscode.commands.executeCommand(request.command,...(request.args??[]));
    else if(request.action==='stop') { clearInterval(timer); resolve(); }
    fs.writeFileSync(output,JSON.stringify({id:request.id,ok:true,value,...state()}));
   } catch(error) { fs.writeFileSync(output,JSON.stringify({id:request.id,ok:false,error:String(error),...state()})); }
   finally { busy=false; }
  },30);
 });
 vscode.commands.executeCommand = originalExecuteCommand;
 vscode.window.createOutputChannel = createOutputChannel;
 for(const timer of groupFocusTimers) clearTimeout(timer);
};
