// Opt-in native workbench regression. CDP is confined to this disposable test host;
// Better Git itself neither needs nor connects to a debugging port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertE2EHost } from './e2e-host-guard.mjs';

assertE2EHost();
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH;
assert.ok(executable && fs.existsSync(executable), 'Set BGV_VSCODE_EXECUTABLE_PATH to the isolated VS Code executable');
const root = fs.realpathSync(fs.mkdtempSync('/tmp/bgv-native-'));
const evidence = process.env.BGV_NATIVE_EVIDENCE_DIR ?? root;
fs.mkdirSync(evidence, { recursive: true });
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const testLinkBackground = process.argv.includes('--link-background');
const testEarlyHandoff = process.argv.includes('--early-app-handoff');
const testLinkReceipt = process.argv.includes('--link-receipt');
const testLinkStayBackground = testEarlyHandoff || testLinkReceipt || process.argv.includes('--link-stay-background');
const testReturnApp = process.argv.includes('--return-app');
const testKeyboardRepeat = process.argv.includes('--keyboard-repeat');
const testHeldClick = process.argv.includes('--held-click');
const testMergeLink = process.argv.includes('--merge-link');
const testNoUnstaged = process.argv.includes('--no-unstaged');
const testStageReveal = process.argv.includes('--stage-reveal');
const testDeletedLink = process.argv.includes('--deleted-link');
const testLinkOnly = process.argv.includes('--link-only');
const testLastStaged = process.argv.includes('--last-staged-status');
const testStageHistory = process.argv.includes('--stage-history');
const testStagedGroupGuard = process.argv.includes('--staged-group-guard');
const testBackgroundPeers = process.argv.includes('--background-peer-collapse');
const testLookaheadNormal = process.argv.includes('--scm-lookahead-normal');
const testLookaheadTall = process.argv.includes('--scm-lookahead-tall');
const testLookahead = testLookaheadNormal || process.argv.includes('--scm-lookahead');
const testUsage = process.argv.includes('--usage-tracking');
const testSingleRepository = process.argv.includes('--single-repository');
const testPreorderedApi = process.argv.includes('--preordered-api');
async function until(read, accept, description, timeout = 15_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await read(); if (accept(last)) { return last; } } catch (error) { last = String(error); }
        await pause(50);
    }
    throw new Error(`${description}: ${JSON.stringify(last)}`);
}
const repositoryCount = Number(process.env.BGV_NATIVE_REPOSITORY_COUNT ?? (testPreorderedApi ? 32 : 9));
assert.ok(Number.isInteger(repositoryCount) && repositoryCount >= 9 && repositoryCount <= 32);
const roots = Array.from({ length: repositoryCount }, (_, i) => path.join(root,
    testLinkReceipt && i === 1 ? 'review target with spaces 🧪' : `repo-${i}`));
fs.mkdirSync(roots[0]);
git(roots[0], 'init', '-b', 'main');
for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@local.invalid'], ['commit.gpgsign', 'false']]) {
    git(roots[0], 'config', key, value);
}
for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.writeFileSync(path.join(roots[0], name), 'base\n'); }
git(roots[0], 'add', '.');
git(roots[0], 'commit', '-m', 'base');
for (const repo of roots.slice(1)) { git(roots[0], 'worktree', 'add', '--detach', repo); }
for (const repo of roots) {
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'existing staged\n');
    git(repo, 'add', 'staged.txt');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.writeFileSync(path.join(repo, name), 'modified\n'); }
}
// Match the reported busy worktree: 331 staged entries and 395 unstaged entries.
// Keep the first review file unchanged so the existing selection/advance guards still apply.
const largeRepo = roots.at(-1);
for (const [directory, count] of [['bulk-staged', 330], ['bulk-working', 391]]) {
    fs.mkdirSync(path.join(largeRepo, directory));
    for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(largeRepo, directory, `file-${String(i).padStart(3, '0')}.txt`), 'fixture change\n');
    }
}
git(largeRepo, 'add', 'bulk-staged');
fs.writeFileSync(path.join(root, 'roots.json'), JSON.stringify(roots));
const workspace = path.join(root, 'native-worktree.code-workspace');
fs.writeFileSync(workspace, JSON.stringify({ folders: (testSingleRepository ? [roots[1]] : roots.slice(0, -1)).map(p => ({ path: p })), settings: {
    'scm.alwaysShowRepositories': !testSingleRepository, 'scm.repositories.selectionMode': 'multiple',
    'git.openRepositoryInParentFolders': 'never', 'git.detectWorktrees': false,
    'git.autoRepositoryDetection': false, 'workbench.startupEditor': 'none',
    'better-git-vscode.experimentalScmTreeStateManagement': false,
    // The dedicated Mini uses Dvorak - QWERTY Cmd. Physical X is therefore the contributed Shift+Option+Q
    // binding while still reporting hardware key code 7 to the release monitor.
    'better-git-vscode.dvorakMode': testKeyboardRepeat,
    'better-git-vscode.debugLogging': testLookahead || testUsage || testKeyboardRepeat || process.env.BGV_NATIVE_DEBUG === '1',
} }));
const profile = path.join(root, 'profile');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User', 'keybindings.json'), JSON.stringify([
    { key: 'f18', command: 'better-git-vscode.stage-and-next-changed-file' },
    { key: 'f16', command: 'better-git-vscode.undo-last-stage-and-advance' },
    { key: 'cmd+shift+f20', command: 'better-git-vscode.stage-hold-ready', args: 'razer' },
    { key: 'cmd+shift+f15', command: 'better-git-vscode.stage-hold-clear', args: 'razer' },
]));
if (testLookahead) { for (let i = 0; i < (testLookaheadTall ? 120 : 70); i++) { fs.writeFileSync(path.join(roots[1], `review-${String(i).padStart(3, '0')}.txt`), 'review\n'); } fs.writeFileSync(path.join(roots[1], 'review-050 • test.txt'), 'review\n'); }
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const log = fs.openSync(path.join(evidence, 'native-worktree.log'), 'w');
const child = spawn(executable, [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionRoot}`, `--extensionTestsPath=${path.join(extensionRoot, 'scripts/worktree-native-test-driver.cjs')}`,
    `--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry'],
{ env: { ...process.env, BGV_SWITCH_ROOT: root, BGV_LINK_RECEIPT_TEST: testLinkReceipt ? '1' : '', BGV_WORKTREE_USAGE_TEST: testUsage ? '1' : '', BGV_SCM_FOCUS_TRACE_TEST: testBackgroundPeers ? '1' : '', BGV_NATIVE_SINGLE: testSingleRepository ? '1' : '', BGV_EARLY_HANDOFF_TEST: testEarlyHandoff ? '1' : '', BGV_PREORDERED_API_TEST: testPreorderedApi ? '1' : '' }, stdio: ['ignore', log, log] });
let socket;
let activationMonitor;
let nextRequest = 0;
async function request(action, extra = {}) {
    const id = ++nextRequest;
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ id, action, ...extra }));
    const result = await until(() => JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')),
        r => r.id === id, `extension request ${action}`);
    assert.equal(result.ok, true, result.error);
    return result;
}
let send;
let evaluate;
const rowsExpression = `[...document.querySelectorAll('[role="treeitem"]')].map(r=>({
    text:r.textContent, aria:r.getAttribute('aria-label'), expanded:r.getAttribute('aria-expanded'),
    level:r.getAttribute('aria-level'), selected:r.getAttribute('aria-selected')}))`;
async function capture(name) {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(result.data, 'base64'));
    fs.writeFileSync(path.join(evidence, `${name}.json`), JSON.stringify(await evaluate(rowsExpression), null, 2));
}
async function check(repo, name, file = 'a.txt') {
    // Native focus is delivered separately from the initial background load. Wait for that event and the
    // accepted presentation's own completion before checking its painted result; never repair the UI here.
    await until(() => request('state'), state => state.focused, name + ': receiving window focus');
    await request('settle-worktree');
    // A background link opens its file before the deferred native fold. File selection alone can
    // therefore precede that fold's intermediate collapsed-root state. Observe the complete visible
    // result once; never retry a collapse command or repair the state from the test.
    await until(() => evaluate(rowsExpression), rows =>
        rows.some(r => r.selected === 'true' && r.text.includes(`repo-${repo}`) && r.aria?.startsWith(file + ','))
        && rows.find(r => r.aria === 'Staged Changes')?.expanded === 'false'
        && rows.find(r => r.aria === 'Changes')?.expanded === 'true'
        && rows.some(r => r.level === '1' && r.aria === `repo-${repo} Git` && r.expanded === 'true'), name);
    await pause(350); // Observe late resource publication after the command has returned.
    let rows = await evaluate(rowsExpression);
    const selectedRows = rows;
    const scrollableExpression = `document.querySelector('[role="tree"][aria-label="Source Control Management"]')?.closest('.monaco-scrollable-element')`;
    const originalScrollTop = await evaluate(`${scrollableExpression}?.scrollTop ?? 0`);
    const headers = new Map();
    const collectHeaders = () => {
        for (const row of rows.filter(r => r.level === '1' && /^repo-\d+ Git$/.test(r.aria))) {
            headers.set(row.aria, row.expanded);
        }
    };
    collectHeaders();
    if (headers.size < roots.length) {
        // A large selected worktree scrolls its preceding repository headers out of the DOM.
        // Inspect the top of the same tree without changing selection or issuing another collapse.
        await capture(`${name}-selected`);
        const point = await evaluate(`(()=>{const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');const b=tree.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+Math.min(100,b.height/2)};})()`);
        // Scroll toward the unseen headers and inspect each resulting viewport.
        const direction = repo > roots.length / 2 ? -1 : 1;
        for (let i = 0; i < 16 && headers.size < roots.length; i++) {
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: direction * 1000 });
            await pause(100);
            rows = await evaluate(rowsExpression);
            collectHeaders();
        }
        for (let i = 0; i < 16 && headers.size < roots.length; i++) {
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -direction * 1000 });
            await pause(100);
            rows = await evaluate(rowsExpression);
            collectHeaders();
        }
    }
    await capture(name);
    await evaluate(`(()=>{const scroller=${scrollableExpression};if(scroller)scroller.scrollTop=${originalScrollTop};})()`);
    await pause(100);
    assert.equal(selectedRows.find(r => r.aria === 'Staged Changes')?.expanded, 'false', `${name}: Staged Changes remained expanded`);
    assert.equal(headers.size, roots.length, `${name}: missing repository headers`);
    assert.deepEqual([...headers].filter(([, expanded]) => expanded === 'true').map(([aria]) => aria), [`repo-${repo} Git`], `${name}: expanded repositories`);
    assert.equal(selectedRows.find(r => r.aria === 'Changes')?.expanded, 'true', `${name}: Changes must stay expanded`);
    assert.ok(selectedRows.some(r => r.selected === 'true' && r.text.includes(`repo-${repo}`) && r.aria?.startsWith(file + ',')), `${name}: wrong selected file`);
    const state = await request('state');
    assert.ok(!state.trace.includes('workbench.scm.action.focusNextInput'), `${name}: Worktree links must not cycle repository inputs`);
    console.log(`PASS ${name}`);
}
async function key(key, code, virtualKey, modifiers = 0) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
}
try {
    await until(() => fs.existsSync(path.join(root, 'ready.json')), Boolean, 'extension readiness', 45_000);
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t =>
        t.type === 'page' && t.title.includes('[Extension Development Host]') && t.title.includes('native-worktree (Workspace)') && t.url.startsWith('vscode-file:')),
    targets => targets.length === 1, 'owned native workbench');
    socket = new WebSocket(target[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(String(data));
        if (!pending.has(message.id)) { return; }
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    evaluate = async expression => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    if (testLinkStayBackground) {
        // Never activate the test host in this scenario. If launching Code did
        // focus it, foreground Finder once; leave an existing authentication UI
        // or any other already-frontmost application untouched.
        if ((await request('state')).focused && process.platform === 'darwin') {
            execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
                "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);"]);
        }
        await until(() => request('state'), state => !state.focused, 'native window stays background');
    } else {
        if (process.platform === 'darwin') {
            // Activate only the process launched above, never the user's normal Code.
            execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
                `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`]);
        }
        await send('Page.bringToFront');
        await until(() => request('state'), state => state.focused, 'native window focus');
    }
    if (testLinkReceipt) {
        const baseline = roots.map(repo => git(repo, 'status', '--porcelain=v1'));
        const receipts = () => JSON.parse(fs.readFileSync(path.join(root, 'link-receipts.json'), 'utf8'));
        const open = repo => request('uri', {uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}`});
        await request('config', {settings:{worktreeLinkReturnFocus:false,worktreeLinkNotifications:true}});
        await request('hold-status', {repo:1});
        const opening = open(1);
        try {
            await until(receipts, rows => rows.length === 1, 'receipt before blocked repository loading');
            await until(() => JSON.parse(fs.readFileSync(path.join(root, 'handoff-events.json'), 'utf8')),
                events => events.includes('status-start'), 'real Git status remains blocked');
            assert.ok(receipts()[0].startsWith(`Better Git: ${path.basename(roots[1])} — `), 'receipt puts the decoded target before the compact-toast cutoff');
            assert.ok(receipts()[0].includes(`\nPath: ${roots[1]}`), 'receipt includes its exact full path');
            await until(() => evaluate(`document.querySelector('.notifications-toasts')?.textContent ?? ''`),
                text => text.includes(path.basename(roots[1])) && text.includes(`Path: ${roots[1]}`),
                'actual target name and full path rendered');
            await capture('link-receipt-before-loading');
            // Exercise VS Code's own expander: compact toasts clip long messages, but the
            // target path must remain readable without dismissing or delaying the link.
            await evaluate(`(() => {
                const expand = document.querySelector('.notifications-toasts .codicon-notifications-expand, .notifications-toasts .codicon-notifications-expand-down');
                if (!expand) { throw new Error('Native notification expander missing'); }
                expand.click();
            })()`);
            await until(() => evaluate(`Boolean(document.querySelector('.notifications-toasts .codicon-notifications-collapse, .notifications-toasts .codicon-notifications-collapse-up'))`),
                expanded => expanded, 'native receipt expanded');
            await capture('link-receipt-expanded');
        } finally { fs.writeFileSync(path.join(root, 'release-status'), 'release'); }
        await opening; // A visible notification must not hold the URI handler until dismissal.
        await open(1);
        assert.equal(receipts().length, 2);
        assert.notEqual(receipts()[0], receipts()[1], 'repeat links have distinct visible receipt numbers');
        await request('config', {settings:{worktreeLinkNotifications:false}});
        await open(2);
        assert.equal(receipts().length, 2, 'disabled receipt notifications stay silent');
        await request('config', {settings:{worktreeLinkNotifications:true}});
        await request('open', {repo:3});
        assert.equal(receipts().length, 2, 'palette commands are not external link deliveries');
        await request('uri', {uri:'vscode://ethansk.better-git-vscode/open-worktree?path=%2Fdoes-not-exist-bgv'});
        assert.equal(receipts().length, 3, 'received link is acknowledged even when its filesystem path fails');
        assert.ok(receipts()[2].startsWith('Better Git: does-not-exist-bgv — ')
            && receipts()[2].includes('\nPath: /does-not-exist-bgv'), 'failed paths still identify their target');
        assert.deepEqual(roots.map(repo => git(repo, 'status', '--porcelain=v1')), baseline, 'diagnostics never change Git');
        fs.writeFileSync(path.join(evidence, 'link-receipts.json'), JSON.stringify(receipts(), null, 2));
        console.log('BETTER_GIT_LINK_RECEIPT_VERIFIED checks=10 early,target,path,rendered,expanded,nonblocking,repeat,disabled,palette,path-failure');
    } else if (testStagedGroupGuard) {
        // Keep the empty native group alive so a link can fold it before the first stage.
        // This tests the supported personal setting, not a production background recollapse.
        await request('git-config', {settings:{alwaysShowStagedChangesResourceGroup:true}});
        const stagedCollapsed = async () => (await evaluate(rowsExpression))
            .find(row => row.aria === 'Staged Changes')?.expanded === 'false';
        for (const [repo, mode] of [[1,'in-place'], [2,'advance'], [3,'batch']]) {
            git(roots[repo], 'reset', '--hard', 'HEAD');
            git(roots[repo], 'clean', '-fdq');
            fs.writeFileSync(path.join(roots[repo], 'a.txt'), 'only unstaged file\n');
            await request('refresh', {repo});
            await request('open', {repo});
            await until(stagedCollapsed, Boolean, mode + ': empty Staged group collapsed');
            const before = git(roots[repo], 'write-tree');
            if (mode === 'batch') {
                await request('command', {command:'better-git-vscode.begin-mouse-navigation-hold',args:[{source:'corsair',direction:'next',initialMode:'files',navigateOnButtonDown:false}]});
                await request('command', {command:'better-git-vscode.stage-hold-ready',args:['corsair']});
                await request('command', {command:'better-git-vscode.finish-mouse-navigation-hold',args:[{source:'corsair',direction:'next'}]});
            } else {
                await request('command', {command: mode === 'in-place' ? 'better-git-vscode.stage-current-file' : 'better-git-vscode.stage-and-next-changed-file'});
            }
            assert.equal(git(roots[repo], 'diff', '--cached', '--name-only').trim(), 'a.txt', mode + ': exact stage');
            // Revealing SCM again invokes its real Auto Reveal implementation. The old file: view
            // expands Staged here; the new Index view must keep the user's collapsed group intact.
            // Move tree focus off the old resource first, as happens when another repository is
            // selected. Otherwise native Auto Reveal's same-focus shortcut masks the reproduction.
            await request('command', {command:'workbench.scm.focus'});
            await request('command', {command:'list.focusFirst'});
            await request('command', {command:'workbench.action.closeSidebar'});
            await request('command', {command:'workbench.view.scm'});
            await pause(400);
            await capture('staged-group-' + mode);
            assert.equal(await stagedCollapsed(), true, mode + ': Staged reopened after sidebar reveal');
            await until(() => request('state'), state => state.badge === '🧯', mode + ': staged badge');
            const point = await evaluate(`(()=>{const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');const row=[...tree.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='Staged Changes');if(!row)return null;const r=row.getBoundingClientRect(),t=tree.getBoundingClientRect();if(r.top<t.top||r.bottom>t.bottom)return null;const b=row.querySelector('.monaco-tl-twistie').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
            assert.ok(point, mode + ': Staged header visible for manual expansion');
            for (const type of ['mousePressed','mouseReleased']) {
                await send('Input.dispatchMouseEvent', {type,...point,button:'left',clickCount:1});
            }
            await until(() => evaluate(rowsExpression), rows => rows.some(row => row.aria === 'Staged Changes' && row.expanded === 'true'), mode + ': manual Staged expansion');
            await capture('staged-group-' + mode + '-manual');
            // File decorations are CSS pseudo-elements, not textContent or the row's ARIA label.
            await until(() => evaluate(`(()=>{const row=[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')?.startsWith('a.txt,'));return row&&[row,...row.querySelectorAll('*')].some(n=>['::before','::after'].some(p=>getComputedStyle(n,p).content.includes('🧯')));})()`), Boolean, mode + ': staged row paints the extinguisher');
            await request('command', {command:'workbench.action.closeSidebar'});
            await request('command', {command:'workbench.view.scm'});
            await pause(200);
            assert.equal((await evaluate(rowsExpression)).find(row => row.aria === 'Staged Changes')?.expanded, 'true', mode + ': manual expansion must remain open');
            await request('command', {command:'better-git-vscode.undo-last-stage-and-advance'});
            assert.equal(git(roots[repo], 'write-tree'), before, mode + ': exact Undo');
            console.log('PASS staged-group-' + mode);
        }
    } else if (testStageHistory) {
        await request('config',{settings:{debugLogging:false}});
        await request('open',{repo:1});
        const before=await request('stage-history');
        assert.ok(before.value.records.some(row=>row.action==='session-start'),'history starts without verbose debug logging');
        const baseline=git(roots[1],'diff','--cached','--binary');
        await request('command',{command:'better-git-vscode.stage-and-next-changed-file'});
        const staged=await request('stage-history');
        assert.ok(staged.value.records.some(row=>row.action==='better-git-stage' && row.repoRoot===roots[1] && row.paths.includes('a.txt')),'successful stage attributed to Better Git');
        assert.ok(staged.active.includes('b.txt'),'log writes do not prevent the next-file jump');
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        const undone=await request('stage-history');
        assert.ok(undone.value.records.some(row=>row.action==='better-git-undo' && row.paths.includes('a.txt')),'exact Undo is logged');
        assert.equal(git(roots[1],'diff','--cached','--binary'),baseline,'Undo preserves exact original index');
        git(roots[1],'add','b.txt'); await request('refresh',{repo:1});
        const external=await request('stage-history');
        assert.ok(external.value.records.some(row=>row.action==='observed-index-change' && row.source==='unknown' && row.paths.includes('b.txt')),'external stage is observed without guessing author');
        git(roots[1],'reset','HEAD','--','b.txt'); await request('refresh',{repo:1});
        const unstage=await request('stage-history');
        assert.ok(unstage.value.records.filter(row=>row.action==='observed-index-change' && row.paths?.includes('b.txt')).length>=2,'external unstage persists too');
        assert.equal(unstage.value.records.filter(row=>row.action==='better-git-stage').length,1,'external action never attributed to Better Git');
        fs.writeFileSync(path.join(evidence,'stage-history.json'),JSON.stringify(unstage.value,null,2));
        console.log('BETTER_GIT_STAGE_HISTORY_VERIFIED checks=6 debug-off,stage,next,undo,external-stage,external-unstage');
    } else if (testBackgroundPeers) {
        // The OS URL receiver arrives in Code. Finish its tree first, then activate Finder (the Codex
        // stand-in) once. A second Code/origin bounce must not be hidden by eventual tree correctness.
        const observer = path.join(root,'app-activation');
        execFileSync('/usr/bin/swiftc',[path.join(extensionRoot,'scripts/test-app-activation.swift'),'-o',observer]);
        activationMonitor=spawn(observer,[],{stdio:['ignore','pipe','pipe']});
        let activationOutput=''; activationMonitor.stdout.on('data',data=>{activationOutput+=data.toString();});
        await until(()=>activationOutput,text=>text.includes('ready\n'),'native activation observer ready');
        const focusCode=()=>execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',`ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`]);
        const focusOrigin=()=>execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',"ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);"]);
        const receiveInCode=async()=>{
            if((await request('state')).focused)return;
            activationOutput='';focusCode();
            await until(()=>request('state'),state=>state.focused,'OS URL receiver is frontmost');
            await until(()=>activationOutput,text=>text.includes(`com.microsoft.VSCode ${child.pid}`),'receiver activation observed');
        };
        await request('plain', {repo:0});
        const graph = await evaluate(`(()=>{const row=[...document.querySelectorAll('[role="treeitem"]')].find(row=>row.getAttribute('aria-label')==='base, Test');if(!row)return null;const r=row.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        assert.ok(graph, 'Graph row exists');
        for (const type of ['mousePressed','mouseReleased']) { await send('Input.dispatchMouseEvent',{type,...graph,button:'left',clickCount:1}); }
        await until(()=>evaluate(rowsExpression), rows=>rows.some(row=>row.aria==='base, Test' && row.selected==='true'), 'Graph selected');
        await request('config', {settings:{worktreeLinkReturnFocus:true,worktreeLinkReturnApp:'com.apple.finder',worktreeLinkKeepEditorFront:false}});
        const baseline = roots.map(repo=>git(repo,'status','--porcelain=v1'));
        const headers = async count => {
            const found = new Map();
            const collect = async()=>{for(const row of await evaluate(rowsExpression)){
                if(row.aria==='Staged Changes')assert.equal(row.expanded,'false','every observed Staged group stays collapsed');
                if(row.level==='1' && /^repo-\d+ Git$/.test(row.aria))found.set(row.aria,row.expanded);
            }};
            await collect();
            const point = await evaluate(`(()=>{const r=document.querySelector('[role="tree"][aria-label="Source Control Management"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(100,r.height/2)}})()`);
            // Observation only, after the link finished: inspect virtualized peer headers without
            // repairing expansion, selecting a row, or issuing another collapse command.
            for(const direction of [-1,1,-1]) { for(let i=0;i<20 && found.size<count;i++) {
                await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:direction*900});
                await pause(50); await collect();
            } }
            assert.equal(found.size,count,'every repository header inspected');
            return [...found];
        };
        for(const [index,repo] of [1,1,3,roots.length-1].entries()) {
            await receiveInCode();
            const before = await request('state');
            activationOutput='';
            if(index===0)await request('hold-status',{repo});
            const opening=request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}`});
            if(index===0) {
                try {
                    await until(()=>JSON.parse(fs.readFileSync(path.join(root,'handoff-events.json'),'utf8')),events=>events.includes('status-start'),'repository loading is blocked');
                    assert.equal(activationOutput,'','origin must not activate before repository loading finishes');
                } finally {fs.writeFileSync(path.join(root,'release-status'),'release');}
            }
            await opening;
            const after = await until(()=>request('state'),state=>!state.focused,'origin restored after native presentation');
            await until(()=>activationOutput,text=>text.trim().split('\n').at(-1)?.startsWith('com.apple.finder '),'native origin activation');
            const activations=activationOutput.trim().split('\n');
            assert.deepEqual(activations,[activations.find(line=>line.startsWith('com.apple.finder '))],'one final origin activation, no editor bounce');
            fs.writeFileSync(path.join(evidence,`background-peers-${index}-activations.json`),JSON.stringify(activations));
            const trace = after.trace.slice(before.trace.length);
            assert.equal(trace.filter(command=>command==='workbench.scm.action.collapseAllRepositories').length,1,'one global collapse');
            const focusSamples=after.scmFocusTrace.slice(before.scmFocusTrace.length);
            assert.ok(focusSamples.some(sample=>sample.command==='list.expand'),'native target expanded');
            assert.ok(focusSamples.every(sample=>sample.focused),'native tree commands run only while receiving Code is focused');
            // Native Auto Reveal has its own UI queue after the extension command returns. Observe its
            // selected resource before inspecting expansion; an immediate all-collapsed snapshot is transient.
            await until(()=>evaluate(rowsExpression),rows=>rows.some(row=>row.selected==='true'
                && row.text.includes(`repo-${repo}`) && row.aria?.startsWith('a.txt,')),'background target Auto Reveal');
            const count = repo===roots.length-1 ? roots.length : roots.length-1;
            const result = await headers(count);
            assert.deepEqual(result.filter(([,expanded])=>expanded==='true').map(([name])=>name),[`repo-${repo} Git`],'only linked worktree expanded');
            assert.deepEqual(roots.map(root=>git(root,'status','--porcelain=v1')),baseline,'background presentation does not modify Git');
            await capture(`background-peers-${index}-${repo}`);
            console.log(`PASS origin-return peers ${index}: repo-${repo}`);
        }
        for(const [kind,repo] of [['staged',4],['clean',5],['deleted',6]]) {
            await receiveInCode();activationOutput='';
            git(roots[repo],'reset','--hard','HEAD'); git(roots[repo],'clean','-fd');
            if(kind==='staged') { fs.writeFileSync(path.join(roots[repo],'only-staged.txt'),'staged\n');git(roots[repo],'add','.'); }
            if(kind==='deleted') { fs.unlinkSync(path.join(roots[repo],'a.txt')); }
            const index=git(roots[repo],'status','--porcelain=v1');
            const before=await request('state'); await request('watch-tabs');
            await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}`});
            await until(()=>request('state'),state=>!state.focused,kind+': origin restored');
            assert.deepEqual((await headers(roots.length)).filter(([,expanded])=>expanded==='true').map(([name])=>name),[`repo-${repo} Git`],kind+': exact worktree expanded');
            const rows=await evaluate(rowsExpression);
            assert.ok(!rows.some(row=>row.aria==='Staged Changes' && row.expanded==='true'),kind+': Staged collapsed');
            if(kind!=='deleted') {
                assert.equal((await request('state')).active,before.active,kind+': editor preserved');
                assert.deepEqual((await request('watched-tabs')).value,[],kind+': no transient staged editor');
            } else { assert.ok((await request('state')).active.includes('/repo-6/a.txt'),'deleted first entry opens its Git content'); }
            assert.equal(git(roots[repo],'status','--porcelain=v1'),index,kind+': Git unchanged');
            await capture(`origin-return-${kind}`);
            console.log(`PASS origin-return ${kind}`);
        }
        await request('scm-config',{settings:{autoReveal:false}});
        await receiveInCode();
        await request('command',{command:'workbench.scm.action.expandAllRepositories'});
        const before = await request('state');
        await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[2])}`});
        assert.deepEqual((await request('state')).trace.slice(before.trace.length),['workbench.view.scm'],'Auto Reveal off preserves expansion');
        await request('scm-config',{settings:{autoReveal:true}});
        await receiveInCode();
        await request('command',{command:'workbench.view.explorer'});
        await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[2])}`});
        await until(()=>evaluate(rowsExpression),rows=>rows.some(row=>row.selected==='true'
            && row.text.includes('repo-2') && row.aria?.startsWith('a.txt,')),'hidden SCM target Auto Reveal');
        assert.deepEqual((await headers(roots.length)).filter(([,expanded])=>expanded==='true').map(([name])=>name),['repo-2 Git'],'hidden SCM is revealed before collapsing');
        // Leaving Code while real work is pending cancels the final origin return. A subsequent manual
        // return may complete the fold, but must leave Ethan in Code rather than bounce him out again.
        await receiveInCode();activationOutput='';
        await request('hold-status',{repo:3});
        const interrupted=request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[3])}`});
        try {
            await until(()=>JSON.parse(fs.readFileSync(path.join(root,'handoff-events.json'),'utf8')),events=>events.includes('status-start'),'status blocked before user app switch');
            focusOrigin();
            await until(()=>activationOutput,text=>text.includes('com.apple.finder '),'manual origin activation');
        } finally {fs.writeFileSync(path.join(root,'release-status'),'release');}
        await interrupted;
        focusCode(); await until(()=>request('state'),state=>state.focused,'manual Code return');
        await check(3,'origin-return-user-intervened');
        assert.equal((await request('state')).focused,true,'finishing deferred work never restores an origin after a user switch');
        // Delivery can itself happen behind another app, without a fresh Code focus-loss event.
        // Finishing that deferred link on a manual Code return must not activate the origin again.
        activationOutput='';focusOrigin();
        await until(()=>activationOutput,text=>text.includes('com.apple.finder '),'origin before background delivery');
        await until(()=>request('state'),state=>!state.focused,'Code is already in background');
        activationOutput='';
        await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[1])}`});
        assert.equal(activationOutput,'','background delivery never activates an app');
        await receiveInCode();await check(1,'origin-return-background-delivery');
        assert.equal((await request('state')).focused,true,'manual completion of background-delivered link stays in Code');
        await request('config',{settings:{worktreeLinkKeepEditorFront:true}});
        await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[2])}`});
        assert.equal((await request('state')).focused,true,'keep-editor-front remains in Code');
        await request('config',{settings:{worktreeLinkReturnFocus:false}});
        activationOutput='';
        await request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[2])}`});
        assert.equal((await request('state')).focused,true,'public opt-out never returns to origin');
        assert.equal(activationOutput,'','public opt-out never activates an app');
        focusCode();
        await check(2,'background-peers-returned');
        const stagedBefore = git(roots[2],'diff','--cached','--binary');
        await request('command',{command:'better-git-vscode.stage-and-next-changed-file'});
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[2],'diff','--cached','--binary'),stagedBefore,'one Undo restores exact prior index');
        console.log('BETTER_GIT_BACKGROUND_PEERS_VERIFIED checks=14 graph,repeat,switch,new-large,clean,staged-only,deleted,auto-reveal-off,hidden-scm,user-interruption,background-delivery,keep-editor-front,opt-out,stage-undo');
    } else if (testLastStaged) {
        await request('open',{repo:1});
        const baseline=git(roots[1],'diff','--cached','--name-only');
        const status=()=>evaluate(`([...document.querySelectorAll('.statusbar-item')].map(item=>item.textContent.trim()).find(text=>text.includes('Staged:')) ?? '')`);
        const statusPoint=()=>evaluate(`(()=>{const item=[...document.querySelectorAll('.statusbar-item')].find(item=>item.textContent.includes('Staged:'));const r=item.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        const assertLast=async file=>{
            await until(status,text=>text.includes('Staged: '+file),'batch status names '+file);
            const point=await statusPoint();
            await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
            await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
            await until(()=>request('state'),state=>{const uri=new URL(state.active);return uri.protocol==='git:' && uri.pathname.endsWith('/'+file) && JSON.parse(decodeURIComponent(uri.search.slice(1))).ref==='';},'click reopens the named staged diff');
        };
        // Forward eyes review stages b/c, never the unfinished d preview. The label and click
        // target must name c, rather than the first member or the file currently being previewed.
        await request('working',{repo:1,file:'b.txt'});
        await request('command',{command:'better-git-vscode.begin-keyboard-review',args:['next']});
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['next']});
        for(let i=0;i<2;i++) { await request('command',{command:'better-git-vscode.step-keyboard-review',args:['next']}); }
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['next']});
        await request('command',{command:'better-git-vscode.finish-keyboard-review'});
        assert.deepEqual(git(roots[1],'diff','--cached','--name-only').trim().split('\n').sort(),['b.txt','c.txt',...baseline.trim().split('\n')].sort());
        await until(status,text=>text.includes('Staged: c.txt'),'forward batch filename before hover');
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',...await statusPoint()});
        const tooltip=await until(()=>evaluate(`([...document.querySelectorAll('.monaco-hover')].map(item=>item.innerText).join(String.fromCharCode(10)))`),text=>text.includes('Last file staged via Better Git — click to reopen its diff') && text.includes('b.txt') && text.includes('c.txt'),'batch tooltip keeps last-file heading and member list');
        assert.ok(tooltip.startsWith('repo-1/c.txt') || tooltip.startsWith('c.txt'),'tooltip starts with the named last staged path');
        await capture('last-stage-forward-tooltip');
        await assertLast('c.txt');
        await capture('last-stage-forward');
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[1],'diff','--cached','--name-only'),baseline,'forward batch remains one exact Undo');
        // Reverse file mode reaches b from d. Keep the transaction's SCM order, but display b
        // as the reviewed endpoint; showing d would conceal an extra file at the other boundary.
        await request('working',{repo:1,file:'d.txt'});
        await request('command',{command:'better-git-vscode.begin-keyboard-review',args:['previous']});
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['previous']});
        for(let i=0;i<2;i++) { await request('command',{command:'better-git-vscode.step-keyboard-review',args:['previous']}); }
        await request('command',{command:'better-git-vscode.finish-keyboard-review'});
        assert.deepEqual(git(roots[1],'diff','--cached','--name-only').trim().split('\n').sort(),['b.txt','c.txt','d.txt',...baseline.trim().split('\n')].sort());
        await assertLast('b.txt');
        await capture('last-stage-reverse');
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[1],'diff','--cached','--name-only'),baseline,'reverse batch remains one exact Undo');
        await request('working',{repo:1,file:'d.txt'});
        await request('command',{command:'better-git-vscode.begin-keyboard-review',args:['next']});
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['next']});
        for(let i=0;i<2;i++) { await request('command',{command:'better-git-vscode.step-keyboard-review',args:['previous']}); }
        await request('command',{command:'better-git-vscode.finish-keyboard-review'});
        assert.deepEqual(git(roots[1],'diff','--cached','--name-only').trim().split('\n').sort(),['b.txt','c.txt','d.txt',...baseline.trim().split('\n')].sort());
        await assertLast('b.txt');
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[1],'diff','--cached','--name-only'),baseline,'rebased range keeps exact batch Undo');
        await request('working',{repo:1,file:'a.txt'});
        await request('command',{command:'better-git-vscode.stage-and-next-changed-file'});
        await assertLast('a.txt');
        await request('config',{settings:{showLastStagedInStatusBar:false}});
        await request('config',{settings:{showLastStagedInStatusBar:true}});
        await until(status,text=>text.includes('Staged: a.txt'),'re-enabled status remembers the same file');
        console.log('BETTER_GIT_LAST_STAGED_VERIFIED forward-eyes,excluded-preview,reverse-file-mode,rebased-direction,matching-click-target,exact-undo,single-file,setting-restore');
    } else if (testLookahead) {
        // Both compact and tall windows must restore the earlier top-aligned jump.
        await request('open', {repo:1});
        if (testLookaheadTall) {
            // Graph shares half the sidebar height in this fixture. Collapse that test
            // view to exercise the same jump in a taller pane, rather than resizing the app.
            const graph=await evaluate(`(()=>{const h=[...document.querySelectorAll('.pane-header')].find(h=>h.textContent.includes('Graph'));if(!h)return null;const r=h.getBoundingClientRect();return {x:r.x+10,y:r.y+r.height/2,expanded:h.getAttribute('aria-expanded')};})()`);
            assert.ok(graph && graph.expanded==='true','expanded Graph header in isolated fixture');
            for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:graph.x,y:graph.y,button:'left',clickCount:1});
            await until(()=>evaluate(`document.querySelector('[role="tree"][aria-label="Source Control Management"]').getBoundingClientRect().height`),height=>height>=22*21,'tall isolated review pane');
        }
        let file = testLookaheadNormal ? 'review-024.txt' : 'review-025.txt';
        await request('working', {repo:1,file});
        const geometry = () => evaluate(`(() => {
            const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');
            const row=[...tree.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')?.startsWith('${file},'));
            const box=tree.getBoundingClientRect(), current=row?.getBoundingClientRect();
            let top=box.top;
            const headers=[...tree.querySelectorAll('[role="treeitem"]')]
                .filter(r=>!r.getAttribute('aria-label')?.includes(','))
                .map(r=>r.getBoundingClientRect()).sort((a,b)=>a.top-b.top);
            for(const header of headers) { if(header.top<=top+1 && header.bottom<=current?.top) top=Math.max(top,header.bottom); }
            return {top,left:box.left,bottom:box.bottom,rowTop:current?.top,rowBottom:current?.bottom,rowHeight:current?.height,
                selected:[...tree.querySelectorAll('[aria-selected="true"]')].map(r=>r.getAttribute('aria-label'))};
        })()`);
        // Ethan reverted the destination to the top (2026-11-08). Observe actual painted
        // geometry independently of the planner; navigation, selection and Git stay untouched.
        const isTopAligned = g => {
            const capacity=Math.floor((g.bottom-g.top)/g.rowHeight);
            return Math.abs(g.rowTop-g.top)<2
                && g.bottom-g.rowBottom>=Math.min(10,capacity-1)*g.rowHeight-1;
        };
        const initialAccessibility = (await request('native-accessibility')).value;
        const before = await geometry();
        const indexBefore = git(roots[1], 'diff', '--cached', '--name-only');
        await capture('lookahead-before');
        if (testLookaheadNormal) {
            assert.ok(before.bottom-before.rowBottom<220,'fixture starts with fewer than ten file rows below');
            await request('command',{command:'better-git-vscode.next-scm-change'});
            file = path.basename(new URL((await request('state')).active).pathname);
            const after = await until(geometry,isTopAligned,'ordinary Next top-aligns the current file and leaves upcoming rows');
            const normal = await request('state');
            assert.deepEqual(after.selected,before.selected,'ordinary presentation cannot change SCM selection');
            assert.equal(normal.keyboardReviewActive,false,'ordinary Next must not enter a batch');
            assert.equal(normal.badge,'🔥🔥','ordinary Next retains its fire badge');
            assert.ok(normal.active.endsWith('/'+file),'presentation cannot change the navigation destination');
            assert.equal(git(roots[1],'diff','--cached','--name-only'),indexBefore,'ordinary navigation cannot stage');
            await capture('lookahead-normal-after');
            await until(async ()=>(await request('native-accessibility')).value,value=>value.manual===initialAccessibility.manual && value.enhanced===initialAccessibility.enhanced,'ordinary navigation restores borrowed accessibility without a release');
            const firstPointer=(await request('native-accessibility')).value;
            assert.equal(firstPointer.pointerX,initialAccessibility.pointerX,'first ordinary scroll preserves pointer X');
            assert.equal(firstPointer.pointerY,initialAccessibility.pointerY,'first ordinary scroll preserves pointer Y');
            for(let i=0;i<13;i++) { await request('command',{command:'better-git-vscode.next-scm-change'}); }
            file=path.basename(new URL((await request('state')).active).pathname);
            assert.notEqual(file,'review-024.txt','repeated Next reaches another file');
            await until(geometry,g=>g.rowTop>=g.top && g.bottom-g.rowBottom>=220,'ordinary repeated navigation retains ten rows');
            await request('command',{command:'better-git-vscode.previous-scm-change'});
            file=path.basename(new URL((await request('state')).active).pathname);
            const stagedFile=file;
            await request('command',{command:'better-git-vscode.stage-and-next-changed-file'});
            file=path.basename(new URL((await request('state')).active).pathname);
            assert.notEqual(file,stagedFile,'Stage + Next still advances');
            assert.deepEqual(git(roots[1],'diff','--cached','--name-only').trim().split('\n').sort(),[...indexBefore.trim().split('\n'),stagedFile].sort(),'Stage + Next stages only its explicit file');
            const pointer=await until(async ()=>(await request('native-accessibility')).value,value=>value.manual===initialAccessibility.manual && value.enhanced===initialAccessibility.enhanced,'repeated ordinary navigation restores borrowed accessibility');
            assert.equal(pointer.pointerX,initialAccessibility.pointerX); assert.equal(pointer.pointerY,initialAccessibility.pointerY);
            fs.writeFileSync(path.join(evidence,'lookahead-normal-result.json'),JSON.stringify({before,after},null,2));
            console.log('BETTER_GIT_SCM_NORMAL_LOOKAHEAD_VERIFIED ordinary-next,fire-badge,no-batch,no-stage,repeated-navigation,previous,stage-next,pointer,accessibility-restored');
        } else {
        await request('command', {command:'better-git-vscode.begin-keyboard-review',args:['next']});
        // A tall pane can already have enough room here: do not demand an unnecessary
        // jump. The following repeated explosion-mode steps must reach its real boundary.
        const after = await until(geometry, testLookaheadTall
            ? g=>g.rowTop>=g.top && g.bottom-g.rowBottom>=220 : isTopAligned,
            'eyes mode leaves ten rows below without an unnecessary jump');
        assert.deepEqual(after.selected,before.selected,'presentation cannot change SCM selection');
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'),indexBefore,'presentation cannot stage');
        assert.ok((await request('state')).active.endsWith('/'+file),'presentation cannot navigate');
        await capture('lookahead-after');
        const pointerAfter = (await request('native-accessibility')).value;
        assert.equal(pointerAfter.pointerX,initialAccessibility.pointerX,'physical pointer X unchanged');
        assert.equal(pointerAfter.pointerY,initialAccessibility.pointerY,'physical pointer Y unchanged');
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['next']});
        // Reach the actual near-bottom threshold in either pane height. A fixed twelve
        // steps can remain entirely above that threshold in a tall, top-aligned viewport.
        const stepCount=Math.max(12,Math.ceil((after.bottom-after.rowBottom)/after.rowHeight)-8);
        let previous=after, explosionJump;
        for (let i=0;i<stepCount;i++) {
            await request('command',{command:'better-git-vscode.step-keyboard-review',args:['next']});
            file = `review-${String(26+i).padStart(3,'0')}.txt`;
            const current=await until(geometry,g=>g.rowTop>=g.top && g.bottom-g.rowBottom>=220,'repeated explosion-mode lookahead');
            // In a short pane every new row can trigger a one-row scroll, keeping the
            // current row at the same Y. Compare with its unscrolled next-row position.
            if(current.rowTop<previous.rowTop+current.rowHeight-1) explosionJump=current;
            previous=current;
        }
        // A real jump while the explosion set grows must top-align the current file, without
        // committing the set. Eyes and explosion share one background presentation path.
        assert.ok(explosionJump && isTopAligned(explosionJump),'explosion-mode jump top-aligns the current file');
        if (testLookaheadTall) assert.ok(Math.abs(explosionJump.rowTop-explosionJump.top)<2,'tall pane top-aligns the current row');
        await capture('lookahead-explosion-after');
        assert.equal(git(roots[1],'diff','--cached','--name-only'),indexBefore,'explosion-mode presentation cannot stage before release');
        await request('command',{command:'better-git-vscode.toggle-keyboard-review',args:['next']});
        await request('command',{command:'better-git-vscode.finish-keyboard-review'});
        for (let i=25;i<25+stepCount;i++) { assert.ok(git(roots[1],'diff','--cached','--name-only').includes(`review-${String(i).padStart(3,'0')}.txt`)); }
        assert.ok(!git(roots[1],'diff','--cached','--name-only').includes(file),'current eyes preview excluded');
        await request('command',{command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[1],'diff','--cached','--name-only'),indexBefore,'one Undo restores the exact batch');
        file = 'review-050 • test.txt';
        await request('working',{repo:1,file});
        await request('command',{command:'better-git-vscode.begin-keyboard-review',args:['next']});
        await until(geometry,g=>g.rowTop>=g.top && g.bottom-g.rowBottom>=220,'decorated path containing separator');
        await request('command',{command:'better-git-vscode.cancel-keyboard-review'});
        await until(async ()=>(await request('native-accessibility')).value, value=>value.manual===initialAccessibility.manual && value.enhanced===initialAccessibility.enhanced, 'borrowed accessibility state restored');
        const finalPointer=(await request('native-accessibility')).value;
        assert.equal(finalPointer.pointerX,initialAccessibility.pointerX,'held review preserves pointer X after all events');
        assert.equal(finalPointer.pointerY,initialAccessibility.pointerY,'held review preserves pointer Y after all events');
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'),indexBefore,'cancel cannot stage');
        fs.writeFileSync(path.join(evidence,'lookahead-result.json'),JSON.stringify({before,after,explosionJump},null,2));
        console.log('BETTER_GIT_SCM_LOOKAHEAD_VERIFIED checks=9 geometry,selection,editor,index,pointer,repeated-navigation,staging,undo,accessibility-restored');
        }
    } else {
    await until(() => evaluate(rowsExpression), rows => rows.some(r => r.aria === 'Staged Changes'  && r.expanded === 'true'), 'initial staged group');
    await capture('before-first-open');
    if (testUsage) {
        const baseline = roots.map(repo => git(repo, 'status', '--porcelain=v1'));
        const events = async () => (await request('usage-log')).value;
        const open = repo => request('uri', {uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}`});
        await request('config', {settings:{worktreeLinkReturnFocus:false}});
        await open(1);
        assert.deepEqual((await events()).map(event=>event.event), ['click','observing'], 'automatic open is not review input');
        await request('command', {command:'better-git-vscode.next-scm-change'});
        assert.equal((await events()).at(-1).outcome, 'review-input-first', 'actual navigation hook');
        await open(2);
        execFileSync('/usr/bin/osascript', ['-l','JavaScript','-e',
            "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);"]);
        await until(events, events=>events.at(-1)?.reason==='other-app-frontmost', 'actual focus-loss app probe');
        assert.equal((await events()).at(-1).outcome, 'unknown', 'Finder is not a Codex return');
        execFileSync('/usr/bin/osascript', ['-l','JavaScript','-e',
            `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`]);
        await until(()=>request('state'), state=>state.focused, 'owned host focus restored');
        await request('settle-worktree');
        const count = (await events()).length;
        // This fixture enables debug logging in Workspace settings; a Global write cannot override it.
        const configured = await request('config', {settings:{debugLogging:false},scope:'workspace'});
        assert.equal(configured.value.debugLogging, false, 'effective debug setting is disabled');
        await open(3);
        assert.equal((await events()).length, count, 'logging disabled creates no observation');
        assert.deepEqual(roots.map(repo=>git(repo,'status','--porcelain=v1')), baseline, 'logging never changes Git');
        fs.writeFileSync(path.join(evidence,'worktree-usage-events.json'),JSON.stringify(await events(),null,2));
        await capture('usage-tracking-finished');
        console.log('BETTER_GIT_WORKTREE_USAGE_VERIFIED checks=5 review-input,focus-probe,automatic-open,disabled,git-unchanged');
        console.log(`BETTER_GIT_NATIVE_WORKTREE_VERIFIED evidence=${evidence}`);
    } else if (testEarlyHandoff) {
        await request('config', { settings: {worktreeLinkReturnFocus:true,worktreeLinkReturnApp:'com.openai.codex',worktreeLinkKeepEditorFront:true} });
        const baseline = roots.map(repo => git(repo, 'status', '--porcelain=v1'));
        const readEvents = () => JSON.parse(fs.readFileSync(path.join(root, 'handoff-events.json'), 'utf8'));
        for (const [repo, enabled, destination] of [[1,true,'codex'],[1,true,'codex'],[8,true,'codex'],[2,false,'codex'],[3,true,''],[4,true,undefined]]) {
            await request('config', { settings: {worktreeLinkReturnFocus:enabled} });
            const before = await request('state');
            await request('hold-status', {repo});
            const uri=`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}${destination===undefined?'':'&returnTo='+destination}`;
            const opening=request('uri', {uri});
            try {
                const events=await until(readEvents, events=>events.includes('status-start'), 'worktree reaches blocked status');
                assert.deepEqual(events, enabled && destination!=='' ? ['armed','handoff-start','handoff-end','status-start'] : ['armed','status-start']);
                // Status remains blocked: the whole app handoff has already finished.
                fs.writeFileSync(path.join(evidence, `early-handoff-${repo}-${enabled}-${destination??'fallback'}.json`), JSON.stringify({events,traceBefore:before.trace}));
            } finally { fs.writeFileSync(path.join(root,'release-status'),'release'); }
            await opening;
            const after=await request('state');
            assert.equal(after.focused,false,'loading must not activate the background window');
            assert.equal(after.active, new URL('file://' + roots[repo]+'/a.txt').href);
            assert.equal(readEvents().filter(event=>event==='handoff-start').length, enabled && destination!=='' ? 1 : 0, 'no second handoff after loading');
            assert.deepEqual(after.trace.slice(before.trace.length), [], 'native list focus stays deferred');
            assert.deepEqual(roots.map(repo=>git(repo,'status','--porcelain=v1')),baseline);
        }
        for (const [kind,repo] of [['staged',6],['clean',7]]) {
            git(roots[repo],'reset','--hard','HEAD'); git(roots[repo],'clean','-fd');
            if(kind==='staged') {fs.writeFileSync(path.join(roots[repo],'only-staged.txt'),'staged\n');git(roots[repo],'add','.');}
            const before=await request('state');
            const status=git(roots[repo],'status','--porcelain=v1');
            await request('hold-status',{repo});
            const opening=request('uri',{uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}&returnTo=codex`});
            try {assert.deepEqual(await until(readEvents,events=>events.includes('status-start'),kind+' blocked status'),['armed','handoff-start','handoff-end','status-start']);}
            finally {fs.writeFileSync(path.join(root,'release-status'),'release');}
            await opening;
            const after=await request('state');
            assert.equal(after.focused,false); assert.equal(after.active,before.active); assert.deepEqual(after.tabs,before.tabs);
            assert.ok(!after.trace.slice(before.trace.length).includes('workbench.scm.action.focusNextInput'));
            assert.equal(readEvents().filter(event=>event==='handoff-start').length,1);
            assert.equal(git(roots[repo],'status','--porcelain=v1'),status);
        }
        const beforeBurst=readEvents().filter(event=>event==='handoff-start').length;
        await request('uri-burst', {uris:[1,2,3].map(repo=>`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}&returnTo=codex`)});
        assert.equal(readEvents().filter(event=>event==='handoff-start').length,beforeBurst+1,'superseded links must not hand off');
        assert.equal((await request('state')).active,new URL('file://'+roots[3]+'/a.txt').href,'newest link wins');
        const count=readEvents().length;
        await request('uri', {uri:'vscode://ethansk.better-git-vscode/open-worktree?path=%2Fdoes-not-exist-bgv&returnTo=codex'});
        await request('open', {repo:0});
        assert.equal(readEvents().length,count,'invalid paths and ordinary commands must not hand off');
        await capture('early-handoff-background-loaded');
        console.log('BETTER_GIT_EARLY_HANDOFF_ORDER_VERIFIED native-app-activation=unverified-while-authentication-frontmost');
    } else if (testLinkStayBackground) {
        // Do not dispatch renderer mouse/key events: those can initialize
        // lastFocusedList even though VS Code's OS-window state stays unfocused.
        const baseline = roots.map(repo => git(repo, 'status', '--porcelain=v1'));
        for (const repo of [roots.length - 1, 2, 2, 3]) {
            await request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}` });
            const state = await request('state');
            assert.equal(state.focused, false, 'link must not activate VS Code');
            assert.ok(state.active.includes(roots[repo]) && state.active.includes('a.txt'), 'exact first unstaged file must load');
            assert.deepEqual(roots.map(r => git(r, 'status', '--porcelain=v1')), baseline);
            await capture(`background-loaded-${repo}`);
        }
        const original = await request('state');
        for (const [kind, repo] of [['staged', 4], ['clean', 5]]) {
            git(roots[repo], 'reset', '--hard', 'HEAD');
            git(roots[repo], 'clean', '-fd');
            if (kind === 'staged') { fs.writeFileSync(path.join(roots[repo], 'only-staged.txt'), 'staged\n'); git(roots[repo], 'add', '.'); }
            const before = git(roots[repo], 'status', '--porcelain=v1');
            await request('watch-tabs');
            const traceStart = (await request('state')).trace.length;
            await request('open', { repo });
            const state = await request('state');
            assert.equal(state.focused, false);
            assert.equal(state.active, original.active, kind + ': editor unchanged');
            assert.deepEqual(state.tabs, original.tabs, kind + ': tabs unchanged');
            assert.deepEqual((await request('watched-tabs')).value, [], kind + ': no transient editor');
            assert.ok(!state.trace.slice(traceStart).includes('workbench.scm.action.focusNextInput'), kind + ': native input focus deferred');
            assert.equal(git(roots[repo], 'status', '--porcelain=v1'), before);
            await capture(`background-loaded-${kind}`);
        }
        console.log('BETTER_GIT_BACKGROUND_LOAD_VERIFIED native-folding=deferred-until-window-focus');
        console.log(`BETTER_GIT_NATIVE_WORKTREE_VERIFIED evidence=${evidence}`);
        process.exitCode = 0;
    } else {
    if (!testSingleRepository) {
    await request('plain', { repo: 0 });
    const graph = await evaluate(`(()=>{const r=[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='base, Test'); if(!r)return null; const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    assert.ok(graph, 'visible Source Control Graph commit');
    for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...graph, button: 'left', clickCount: 1 }); }
    await until(() => evaluate(rowsExpression), rows => rows.some(r => r.aria === 'base, Test' && r.selected === 'true'), 'Graph has native selection');
    await capture('graph-focused');
    await request('open', { repo: roots.length - 1 }); await check(roots.length - 1, 'new-worktree-first-open');
    await request('open', { repo: 0 }); await check(0, 'first-open');
    await request('open', { repo: 0 }); await check(0, 'repeat-open');
    await request('open', { repo: 1 }); await check(1, 'switch-worktree');
    if (testLinkOnly) {
        // Cached child expansion survived recursive collapse of a closed root.
        // Repeat alternating roots to exercise that native tree state, not just
        // the first clean opening of a fixture.
        for (let repeat = 0; repeat < 3; repeat++) {
            for (const repo of [0, 1]) {
                await request('open', { repo }); await check(repo, `repeat-switch-${repeat}-${repo}`);
            }
        }
    }
    }
    async function expandStagedGroup() {
        const stagedVisible = () => evaluate(`(()=>{const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');const row=[...tree.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='Staged Changes');if(!row)return false;const r=row.getBoundingClientRect(),t=tree.getBoundingClientRect();return r.top>=t.top && r.bottom<=t.bottom;})()`);
        const treePoint = await evaluate(`(()=>{const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');const b=tree.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+Math.min(100,b.height/2)};})()`);
        for (const direction of [1, -1]) {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (await stagedVisible()) { break; }
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...treePoint, deltaX: 0, deltaY: direction * 700 });
                await pause(70);
            }
            if (await stagedVisible()) { break; }
        }
        assert.ok(await stagedVisible(),'Staged Changes must be inside the tree viewport before clicking');
        if ((await evaluate(rowsExpression)).some(row=>row.aria==='Staged Changes' && row.expanded==='true')) { return; }
        const point = await evaluate(`(()=>{const row=[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='Staged Changes');const r=row.querySelector('.monaco-tl-twistie').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await send('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); }
        await until(()=>evaluate(rowsExpression), rows=>rows.some(r=>r.aria==='Staged Changes' && r.expanded==='true'), 'manual Staged Changes expansion');
    }
    if (!testSingleRepository) {
    await expandStagedGroup();
    await request('command', { command: 'workbench.view.explorer' });
    await request('open', { repo: 1 }); await check(1, 'same-editor-hidden-scm');
    await expandStagedGroup();
    await request('plain', { repo: 0 });
    fs.writeFileSync(path.join(roots[1], 'staged-late.txt'), 'late staged change\n'); git(roots[1], 'add', 'staged-late.txt');
    await request('command', { command: 'workbench.view.explorer' });
    await request('open', { repo: 1 }); await check(1, 'switch-after-staged-refresh');
    }
    if (testDeletedLink) {
        fs.unlinkSync(path.join(roots[4], 'a.txt'));
        await request('refresh', { repo: 4 });
        const before = git(roots[4], 'status', '--porcelain=v1');
        for (const repeat of [false, true]) {
            if (!repeat) { await request('plain', { repo: 0 }); }
            await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
            await request('command', { command: 'workbench.scm.history.focus' });
            await request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[4])}` });
            await pause(350);
            const name = `deleted-link-${repeat ? 'repeat' : 'switch'}`;
            await capture(name);
            const rows = await evaluate(rowsExpression);
            assert.deepEqual(rows.filter(r => r.level === '1' && r.expanded === 'true' && / Git$/.test(r.aria)).map(r => r.aria), ['repo-4 Git'], name);
            assert.equal(rows.find(r => r.aria === 'Changes')?.expanded, 'true', name + ': Changes expanded');
            assert.equal(rows.find(r => r.aria === 'Staged Changes')?.expanded, 'false', name + ': Staged collapsed');
            assert.ok((await request('state')).active.includes('/repo-4/a.txt'), name + ': deleted content stays open');
            assert.equal(git(roots[4], 'status', '--porcelain=v1'), before, name + ': Git unchanged');
            console.log(`PASS ${name}`);
        }
    } else if (testMergeLink) {
        const repo = roots[1];
        git(repo, 'reset', '--hard', 'HEAD');
        git(repo, 'clean', '-fd');
        const base = git(repo, 'rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(repo, 'a.txt'), 'incoming conflict\n');
        git(repo, 'add', 'a.txt'); git(repo, 'commit', '-m', 'incoming');
        const incoming = git(repo, 'rev-parse', 'HEAD').trim();
        git(repo, 'reset', '--hard', base);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'local conflict\n');
        git(repo, 'add', 'a.txt'); git(repo, 'commit', '-m', 'local');
        try { git(repo, 'merge', incoming); } catch { /* expected unresolved conflict */ }
        assert.ok(git(repo, 'ls-files', '-u').includes('a.txt'));
        for (let i = 0; i < 319; i++) { fs.writeFileSync(path.join(repo, `staged-${i}.txt`), 'staged\n'); }
        git(repo, 'add', ...Array.from({length:319},(_,i)=>`staged-${i}.txt`));
        await request('refresh', {repo:1});
        const before = git(repo, 'status', '--porcelain=v1');
        for (const mode of [false, true]) {
            await request('git-config', {settings:{mergeEditor:mode}});
            for (const repeat of [false, true]) {
                if (!repeat) { await request('plain', {repo:0}); }
                await request('command', {command:'workbench.scm.action.expandAllRepositories'});
                await request('uri', {uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(repo)}`});
                const name=`merge-link-${mode?'three-way':'plain'}-${repeat?'repeat':'switch'}`;
                await pause(500);
                await capture(name);
                const rows=await evaluate(rowsExpression);
                assert.deepEqual(rows.filter(r=>r.level==='1' && r.expanded==='true' && / Git$/.test(r.aria)).map(r=>r.aria), ['repo-1 Git'], name);
                assert.equal(rows.find(r=>r.aria==='Merge Changes')?.expanded,'true',name+': merge group');
                assert.equal(rows.find(r=>r.aria==='Staged Changes')?.expanded,'false',name+': staged group');
                assert.ok(rows.some(r=>r.selected==='true' && r.aria?.startsWith('a.txt,')),name+': conflict selected');
                assert.equal((await request('state')).mergeEditor,mode,name+': native conflict editor preserved');
                assert.equal(git(repo,'status','--porcelain=v1'),before,name+': Git unchanged');
                console.log(`PASS ${name}`);
            }
        }
    } else if (testNoUnstaged) {
        const original = await request('state');
        for (const [repo, kind] of [[2, 'staged'], [2, 'repeat'], [3, 'clean'], [3, 'clean-repeat'], [4, 'deleted'], [8, 'large-staged']]) {
            if (kind === 'clean') { git(roots[repo], 'reset', '--hard', 'HEAD'); }
            else if (kind === 'deleted') {
                git(roots[repo], 'reset', '--hard', 'HEAD');
                for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.unlinkSync(path.join(roots[repo], file)); }
                git(roots[repo], 'add', '-u');
            } else if (!kind.includes('repeat')) { git(roots[repo], 'add', '.'); }
            await request('refresh', { repo });
            await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
            await request('command', { command: 'workbench.scm.history.focus' });
            const before = roots.map(r => git(r, 'status', '--porcelain=v1'));
            await request('watch-tabs');
            await request('open', { repo });
            await pause(500);
            await capture(`no-unstaged-${kind}`);
            const rows = await evaluate(rowsExpression);
            assert.deepEqual(rows.filter(r => r.level === '1' && /^repo-/.test(r.aria) && r.expanded === 'true').map(r => r.aria), [`repo-${repo} Git`], kind);
            assert.ok(rows.filter(r => r.aria === 'Staged Changes').every(r => r.expanded === 'false'), `${kind}: staged group`);
            assert.ok(!rows.some(r => r.level === '3' && r.selected === 'true'), `${kind}: selected a file`);
            const after = await request('state');
            assert.equal(after.active, original.active, `${kind}: changed editor`);
            assert.deepEqual(after.tabs, original.tabs, `${kind}: changed tabs`);
            assert.deepEqual((await request('watched-tabs')).value, [], `${kind}: transient editor change`);
            assert.deepEqual(roots.map(r => git(r, 'status', '--porcelain=v1')), before, `${kind}: modified Git`);
            console.log(`PASS no-unstaged-${kind}`);
        }
        for (const kind of ['staged', 'clean']) {
            const fresh = path.join(root, `fresh-${kind}`);
            git(roots[0], 'worktree', 'add', '--detach', fresh);
            if (kind === 'staged') {
                fs.writeFileSync(path.join(fresh, 'a.txt'), 'fresh staged\n');
                git(fresh, 'add', 'a.txt');
            }
            const before = git(fresh, 'status', '--porcelain=v1');
            await request('command', { command: 'workbench.scm.history.focus' });
            await request('watch-tabs');
            await request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(fresh)}` });
            await pause(500);
            await capture(`no-unstaged-fresh-${kind}`);
            const rows = await evaluate(rowsExpression);
            assert.ok(rows.some(r => r.aria === `fresh-${kind} Git` && r.expanded === 'true'));
            assert.ok(!rows.some(r => r.level === '1' && r.aria?.endsWith(' Git') && r.aria !== `fresh-${kind} Git` && r.expanded === 'true'));
            assert.ok(rows.filter(r => r.aria === 'Staged Changes').every(r => r.expanded === 'false'));
            assert.deepEqual((await request('watched-tabs')).value, []);
            assert.equal((await request('state')).active, original.active);
            assert.equal(git(fresh, 'status', '--porcelain=v1'), before);
            console.log(`PASS no-unstaged-fresh-${kind}`);
        }
        console.log('BETTER_GIT_NO_UNSTAGED_REVEAL_VERIFIED');
    } else if (testSingleRepository) {
        assert.equal((await request('state')).repositories.length,1);
        await request('plain',{repo:1});
        await expandStagedGroup();
        await request('open',{repo:1});
        assert.equal((await evaluate(rowsExpression)).find(r=>r.aria==='Staged Changes')?.expanded,'false','single unstaged: staged collapsed');
        const original=await request('state');
        for (const kind of ['staged','staged-no-input','staged-no-controls','clean','empty-staged-no-input']) {
            if(kind==='staged') git(roots[1],'add','.');
            else if(kind==='clean') git(roots[1],'reset','--hard','HEAD');
            if(kind==='staged-no-input') await request('git-config',{settings:{showCommitInput:false}});
            if(kind==='staged-no-controls') await request('scm-config',{settings:{showActionButton:false}});
            if(kind==='empty-staged-no-input') await request('git-config',{settings:{alwaysShowStagedChangesResourceGroup:true}});
            await request('refresh',{repo:1});
            if(kind!=='clean') await expandStagedGroup();
            const before=git(roots[1],'status','--porcelain=v1');
            await request('watch-tabs');
            await request('open',{repo:1});
            await pause(350);
            await capture(`single-${kind}`);
            assert.ok((await evaluate(rowsExpression)).filter(r=>r.aria==='Staged Changes').every(r=>r.expanded==='false'));
            assert.deepEqual((await request('watched-tabs')).value,[]);
            assert.equal((await request('state')).active,original.active);
            assert.equal(git(roots[1],'status','--porcelain=v1'),before);
            console.log(`PASS single-${kind}`);
        }
    } else if (testLinkBackground) {
        const jxa = code => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); ${code}`], { encoding: 'utf8' });
        const focusCode = () => jxa(`$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`);
        // A late foreground return starts native tree work before the 10 s admission deadline, then
        // completes after it. It must not stop between collapse-all and reopening the requested root.
        for (const [repo, delay] of [[2, 8500], [2, 2600], [3, 1200], [2, 50], [3, 0]]) {
            await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
            await request('plain', { repo: 0 });
            await request('command', { command: 'workbench.scm.history.focus' });
            jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);`);
            await until(() => request('state'), state => !state.focused, 'Code is background before URI');
            const opening = request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}` });
            await pause(delay);
            focusCode();
            await opening;
            await check(repo, `background-link-${repo}-${delay}`);
        }
        // Focus can leave again while a deferred pass awaits Git. It must not touch the tree behind
        // another app or discard the still-recent retry before a later foreground return.
        jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);`);
        await until(() => request('state'), state => !state.focused, 'background before loading-interrupted retry');
        await request('uri', {uri:`vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[2])}`});
        await request('hold-status', {repo:2});
        const traceBeforeLoading = (await request('state')).trace;
        focusCode();
        try {
            await until(() => JSON.parse(fs.readFileSync(path.join(root,'handoff-events.json'),'utf8')),
                events=>events.includes('status-start'), 'deferred retry awaits Git');
            jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);`);
            await until(() => request('state'), state=>!state.focused, 'focus leaves during Git loading');
        } finally { fs.writeFileSync(path.join(root,'release-status'),'release'); }
        await request('settle-worktree');
        assert.deepEqual((await request('state')).trace,traceBeforeLoading,'no native tree commands behind another app');
        focusCode(); await check(2,'focus-lost-during-retry-loading');
        await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
        await request('uri-burst', { uris: [2, 3, 2, 3, 2].map(repo =>
            `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}&returnTo=codex`) });
        await check(2, 'rapid-links-last-target');
        console.log('BETTER_GIT_BACKGROUND_LINK_VERIFIED');
    } else if (testHeldClick) {
        await request('command', { command: 'better-git-vscode.begin-mouse-navigation-hold', args: [{ source: 'corsair', direction: 'next' }] });
        await request('command', { command: 'better-git-vscode.stage-hold-ready', args: ['corsair'] });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        const point = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.part.editor .monaco-editor .view-line')].filter(n=>n.getBoundingClientRect().width>0 && n.textContent.includes('modified'));const r=nodes.at(-1).getBoundingClientRect();return {x:r.x+32,y:r.y+8};})()`);
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); }
        await pause(250);
        await capture('held-batch-after-editor-click');
        for (const file of ['a.txt', 'b.txt']) {
            assert.equal((await request('badge', { repo: 1, file })).value, '💥💥', 'left-click must retain the held batch');
        }
        const gutter = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.part.editor .line-numbers')].filter(n=>n.getBoundingClientRect().width>0);const r=nodes.at(-1).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...gutter, button: 'left', clickCount: 1 }); }
        await pause(250);
        for (const file of ['a.txt', 'b.txt']) {
            assert.equal((await request('badge', { repo: 1, file })).value, '💥💥', 'gutter click must retain the held batch');
        }
        await capture('held-batch-after-gutter-click');
        await request('plain', { repo: 0, file: 'd.txt', preview: false });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        fs.writeFileSync(path.join(roots[1], 'aa-unselected.txt'), 'background edit\n');
        await request('refresh', { repo: 1 });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'up'] });
        for (const file of ['a.txt', 'b.txt']) { assert.equal((await request('badge', { repo: 1, file })).value, '💥💥'); }
        assert.notEqual((await request('badge', { repo: 1, file: 'c.txt' })).value, '💥💥');
        await capture('held-click-shrunk-group');
        await request('command', { command: 'better-git-vscode.finish-mouse-navigation-hold', args: [{ source: 'corsair', direction: 'next' }] });
        await request('command', { command: 'better-git-vscode.stage-hold-clear', args: ['corsair'] });
        // A delayed mouse-wheel URL must not re-light or mutate the released group.
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt', 'b.txt', 'staged-late.txt', 'staged.txt']);
        await until(() => request('state'), state => state.active === 'file://' + roots[1] + '/c.txt', 'release advances in the captured repository');
        await capture('held-click-release');
        await key('F16', 'F16', 127);
        await until(() => git(roots[1], 'diff', '--cached', '--name-only').trim(), value => value === 'staged-late.txt\nstaged.txt', 'one Undo restores the held batch');
        await capture('held-click-batch-undo');
        console.log('BETTER_GIT_HELD_EDITOR_CLICK_VERIFIED');
    } else if (testStageReveal) {
        // Closing a pinned review tab must never activate a staged-only background editor.
        // Its file: URI causes SCM Auto Reveal to expand Staged Changes and scroll the tree.
        await request('plain', { repo: 1, file: 'staged.txt', preview: false });
        await request('open', { repo: 1 });
        await request('command', { command: 'workbench.action.keepEditor' });
        await check(1, 'pinned-review-before-stage');
        await request('watch-tabs');
        await key('F18', 'F18', 129);
        await check(1, 'pinned-review-after-stage', 'b.txt');
        const transitions = (await request('watched-tabs')).value;
        assert.ok(!transitions.some(uri => uri.includes('/staged.txt')), `staged editor flashed: ${JSON.stringify(transitions)}`);
        await request('command', { command: 'workbench.action.keepEditor' });
        await key('F18', 'F18', 129); await key('F18', 'F18', 129);
        await check(1, 'pinned-rapid-stage', 'd.txt');
        for (const file of ['c.txt', 'b.txt', 'a.txt']) {
            await key('F16', 'F16', 127); await check(1, `pinned-undo-${file}`, file);
        }
        await request('plain', { repo: 2, file: 'staged.txt', preview: false });
        await request('open', { repo: 2 });
        await request('working', { repo: 2, file: 'c.txt' });
        await request('command', { command: 'workbench.action.keepEditor' });
        await request('command', { command: 'better-git-vscode.stage-and-previous-changed-file' });
        await check(2, 'pinned-stage-previous', 'b.txt');
        await request('plain', { repo: 3, file: 'staged.txt', preview: false });
        await request('open', { repo: 3 });
        await request('command', { command: 'better-git-vscode.begin-mouse-navigation-hold', args: [{source:'corsair',direction:'next'}] });
        await request('command', { command: 'better-git-vscode.stage-hold-ready', args: ['corsair'] });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        await request('command', { command: 'workbench.action.keepEditor' });
        await request('command', { command: 'better-git-vscode.finish-mouse-navigation-hold', args: [{source:'corsair',direction:'next'}] });
        await check(3, 'pinned-batch-stage', 'c.txt');
        assert.deepEqual(git(roots[3], 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt','b.txt','staged.txt']);
        await key('F16', 'F16', 127); await check(3, 'pinned-batch-undo', 'a.txt');
        await expandStagedGroup();
        await request('command', { command: 'workbench.action.keepEditor' });
        await key('F18', 'F18', 129);
        await until(() => request('state'), state => state.active.endsWith('/b.txt'), 'stage after manual expansion');
        await pause(350);
        assert.equal((await evaluate(rowsExpression)).find(r => r.aria === 'Staged Changes')?.expanded, 'true', 'manually expanded Staged Changes must remain expanded');
        await capture('manually-expanded-stage-preserved');
        console.log('BETTER_GIT_STAGE_REVEAL_VERIFIED');
    } else if (testReturnApp) {
        // Dummy apps are launched by the test caller, never by production focus code.
        const appA = process.env.BGV_RETURN_APP_A;
        const appB = process.env.BGV_RETURN_APP_B;
        assert.ok(appA && appB, 'Set two running dummy origin app bundle identifiers');
        const jxa = code => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); ${code}`], { encoding: 'utf8' }).trim();
        const front = () => jxa('ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)');
        const focusCode = () => jxa(`$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`);
        const focusApp = app => jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(app)}).objectAtIndex(0).activateWithOptions(2);`);
        const uri = (repo, destination) => `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}${destination === undefined ? '' : '&returnTo=' + encodeURIComponent(destination)}`;
        const appOfCopy = async () => new URL(decodeURIComponent(new URL((await request('copy', { repo: 1 })).value).searchParams.get('url'))).searchParams.get('returnTo');
        async function verifyReturn(repo, destination, expected, name) {
            focusCode();
            await request('uri', { uri: uri(repo, destination) });
            await until(front, app => app === expected, name);
            if (expected !== 'com.microsoft.VSCode') {
                assert.ok((await request('state')).active.endsWith(`/repo-${repo}/a.txt`), `${name}: background file loaded`);
                await capture(name + '-background');
                // One-way return happens before native folding. Explicitly revisit
                // the receiving window to exercise its event-driven presentation.
                focusCode();
                await until(() => request('state'), state => state.focused, name + ': revisit Code');
                await check(repo, name + '-after-focus');
                focusApp(expected);
            } else { await check(repo, name); }
            assert.equal(front(), expected, `${name}: inspection restores expected native focus`);
            fs.writeFileSync(path.join(evidence, `${name}-focus.json`), JSON.stringify({ expected, observed: front(), worktree: roots[repo] }));
        }
        await request('config', { settings: { worktreeLinkReturnFocus: false, worktreeLinkReturnApp: appA } });
        assert.equal(await appOfCopy(), null, 'disabled copy must omit app metadata');
        await verifyReturn(0, appA, 'com.microsoft.VSCode', 'return-disabled');
        const settings = await request('config', { settings: { worktreeLinkReturnFocus: true, worktreeLinkReturnApp: appA } });
        assert.deepEqual(settings.value, { enabled: true, app: appA });
        assert.equal(await appOfCopy(), appA, 'enabled copy includes configured origin');
        await verifyReturn(1, appA, appA, 'return-explicit-first');
        await verifyReturn(1, appA, appA, 'return-explicit-repeat');
        await verifyReturn(8, appB, appB, 'return-switch-large-other-app');
        await verifyReturn(0, undefined, appA, 'return-legacy-link-fallback');
        await verifyReturn(1, 'com.bettergit.test.not-running', 'com.microsoft.VSCode', 'return-app-not-running');
        await verifyReturn(0, '', 'com.microsoft.VSCode', 'return-invalid-metadata');
        focusCode();
        const opening = request('uri', { uri: uri(1, appA) });
        await pause(250); focusApp(appB);
        await opening;
        assert.equal(front(), appB, 'user switching to another app must win over return');
        assert.ok((await request('state')).active.endsWith('/repo-1/a.txt'), 'user switch keeps exact background loading');
        focusCode();
        await until(() => request('state'), state => state.focused, 'return after user switch');
        await check(1, 'return-user-switched-app-after-focus');
        focusCode();
        await request('uri', { uri: 'vscode://ethansk.better-git-vscode/open-worktree?path=%2Fdoes-not-exist-bgv&returnTo=' + appA });
        assert.equal(front(), 'com.microsoft.VSCode', 'failed worktree must not return');
        await request('open', { repo: 0 });
        assert.equal(front(), 'com.microsoft.VSCode', 'palette command must not return');
        console.log('PASS return-failed-worktree-and-ordinary-command');
        await request('config', { settings: { worktreeLinkKeepEditorFront: true } });
        const observer = path.join(root, 'app-activation');
        execFileSync('/usr/bin/swiftc', [path.join(extensionRoot, 'scripts/test-app-activation.swift'), '-o', observer]);
        activationMonitor = spawn(observer, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let activationOutput = '';
        activationMonitor.stdout.on('data', data => { activationOutput += data.toString(); });
        await until(() => activationOutput, value => value.includes('ready\n'), 'native activation observer ready');
        for (const [repo, destination, name] of [[1, appA, 'editor-front-first'], [1, appA, 'editor-front-repeat'],
            [8, appB, 'editor-front-large-other-origin'], [0, undefined, 'editor-front-fallback']]) {
            activationOutput = '';
            // Seed an unrelated previous app so simply staying in Code cannot pass.
            focusApp(destination === appB ? appA : appB);
            await verifyReturn(repo, destination, 'com.microsoft.VSCode', name);
            const expectedOrigin = destination ?? appA;
            const activations = () => activationOutput.trim().split('\n').filter(Boolean);
            await until(activations, events => events.at(-1) === `com.microsoft.VSCode ${child.pid}`
                && events.at(-2)?.startsWith(expectedOrigin + ' '), `${name}: origin then exact editor process`);
            fs.writeFileSync(path.join(evidence, `${name}-app-order.json`), JSON.stringify({
                final: front(), expectedOrigin, activations: activations(),
            }));
        }
        await verifyReturn(1, 'com.bettergit.test.not-running', 'com.microsoft.VSCode', 'editor-front-missing-origin');
        focusCode();
        const openingWithEditorReturn = request('uri', { uri: uri(0, appA) });
        await pause(250); focusApp(appB);
        await openingWithEditorReturn;
        assert.equal(front(), appB, 'user switching to another app must win over the two-step handoff');
        await request('config', { settings: { worktreeLinkReturnFocus: false } });
        await verifyReturn(1, appA, 'com.microsoft.VSCode', 'editor-front-master-disabled');
        console.log('BETTER_GIT_ORIGIN_APP_ORDER_VERIFIED');
        await request('config', { settings: { worktreeLinkReturnFocus: false, worktreeLinkReturnApp: '' } });
    } else if (!testLinkOnly) {
    // Native keyboard input exercises the mouse protocol's readiness/clear/release
    // command path. Physical mouse hardware itself is outside this harness.
    await key('F20', 'F20', 131, 7);
    await until(() => request('state'), state => state.badge === '💥💥', 'hold readiness badge');
    await pause(150);
    await capture('hold-ready');
    await key('F15', 'F15', 126, 7);
    await until(() => request('state'), state => state.badge === '🔥🔥', 'hold release clears readiness');
    // Modifier-only review feeds the exact native state interpreter in this isolated host; renderer keys
    // exercise the real legacy keybindings/navigation. OS input-posting permission is not required or claimed.
    if (testKeyboardRepeat) {
        const sample = (option=false, shift=false, navigation=false, usedShift=false) =>
            request('review-keys', {keys:{option,shift,navigation,usedShift}});
        const tap = async () => {await sample(true,true); await sample(true);};
        const baselineIndex = git(roots[1], 'diff', '--cached', '--name-only');
        const withBatch = names => [...new Set([...baselineIndex.trim().split('\n'), ...names])].filter(Boolean).sort().join('\n')+'\n';
        await request('plain', {repo:1, file:'a.txt'});
        await sample(); await sample(true); await tap();
        await until(() => request('state'), state => state.keyboardReviewActive && state.badge === '👀', 'Shift release enters eyes');
        await capture('keyboard-eyes-entered');
        await key('v', 'KeyV', 86, 1);
        await until(() => request('state'), state => state.active.endsWith('/b.txt'), 'normal next reviews a');
        await tap(); // files, same pending set
        await key('v', 'KeyV', 86, 1);
        await until(() => request('state'), state => state.active.endsWith('/c.txt'), 'file mode selects c');
        await tap(); // eyes, no empty mode and no reset
        assert.equal((await request('badge',{repo:1,file:'a.txt'})).value,'💥💥');
        assert.equal((await request('badge',{repo:1,file:'b.txt'})).value,'💥💥');
        assert.equal((await request('badge',{repo:1,file:'c.txt'})).value,'👀');
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'), baselineIndex, 'mode taps never stage');
        await capture('keyboard-mode-switch-preserves-batch');
        if (process.env.BGV_KEYBOARD_MANUAL_GATE) {
            const gate = process.env.BGV_KEYBOARD_MANUAL_GATE;
            fs.writeFileSync(`${gate}.ready.json`, JSON.stringify({root, evidence}));
            await until(() => fs.existsSync(`${gate}.continue`), Boolean, 'manual mode/paint inspection', 10*60_000);
        }
        await sample(false,true,true); await sample(false,false,true);
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'), baselineIndex, 'wait for final held key');
        await sample();
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'), withBatch(['a.txt','b.txt']), JSON.stringify(await request('state')));
        assert.ok((await request('state')).active.endsWith('/c.txt'));
        await capture('keyboard-release-stages-reviewed-only');
        await request('command', {command:'better-git-vscode.undo-last-stage-and-advance'});
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'), baselineIndex);
        await sample(true); await tap(); await key('Escape', 'Escape', 27);
        await sample(); assert.equal(git(roots[1], 'diff', '--cached', '--name-only'),baselineIndex);
        await request('plain', {repo:1,file:'c.txt'});
        await key('q', 'KeyQ', 81, 9); // real shipped Dvorak Shift+Option+X mapping
        await until(() => request('state'), state=>state.active.endsWith('/d.txt'),'legacy shifted next still advances');
        assert.equal(git(roots[1], 'diff', '--cached', '--name-only'), withBatch(['c.txt']));
        assert.equal((await request('state')).keyboardReviewActive,false);
        console.log('BETTER_GIT_KEYBOARD_CYCLE_VERIFIED modifier-state=isolated-input legacy-shortcut=renderer modes=eyes-files-eyes batch=preserved release=one-stage current-eyes=excluded undo=exact');
    }
    if (!testKeyboardRepeat) {
        for (const file of ['c.txt', 'b.txt', 'a.txt']) { await key('F16', 'F16', 127); await check(1, `undo-to-${file}`, file); }
        assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged-late.txt', 'staged.txt']);
    }
    // Both source transports: navigation happens before release; release stages only the origin.
    if (!testKeyboardRepeat) for (const [source, modifiers] of [['corsair', 6], ['razer', 12]]) {
        await request('open', { repo: 2 });
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-button-down`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
        await key('F14', 'F14', 125, modifiers); // Short release cancels staging without another navigation.
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-hold-down`, 'c.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '💥💥', 'origin readiness badge');
        await check(2, `${source}-threshold-restores-origin`, 'b.txt');
        assert.equal((await request('state')).badge, '💥💥', 'the original view must be ready while held');
        await capture(`${source}-origin-ready`);
        await key('F16', 'F16', 127); // Agentic Mouse adjacent cell: cancel this hold, not the earlier stage receipt.
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '🔥🔥', 'cancel clears readiness badge');
        await check(2, `${source}-hold-cancel-restores-origin`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
        await key('F18', 'F18', 129, modifiers); // A stale release after cancellation must do nothing.
        await key('F15', 'F15', 126, source === 'corsair' ? 7 : 12);
        await pause(250);
        await check(2, `${source}-cancelled-release-noop`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);

        // Start a fresh hold to retain the established release-stage and ordinary-Undo coverage.
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-post-cancel-hold-down`, 'c.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '💥💥', 'post-cancel readiness badge');
        await check(2, `${source}-post-cancel-threshold-restores-origin`, 'b.txt');
        await pause(1100);
        await key('F18', 'F18', 129, modifiers);
        await key('F15', 'F15', 126, source === 'corsair' ? 7 : 12);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'long release stages original');
        await check(2, `${source}-hold-release`, 'c.txt');
        await key('F16', 'F16', 127);
        await check(2, `${source}-undo-origin`, 'b.txt');
        await key('F17', 'F17', 128, modifiers);
        await check(2, `${source}-previous-down`, 'a.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await check(2, `${source}-previous-threshold-restores-origin`, 'b.txt');
        await key('F19', 'F19', 130, modifiers);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'previous release stages original');
        await key('F16', 'F16', 127);
        await check(2, `${source}-previous-undo`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
    }
    if (testKeyboardRepeat) {
        console.log('BETTER_GIT_KEYBOARD_LEGACY_AND_RELEASE_VERIFIED');
    }
    }
    if (!testStagedGroupGuard && !testNoUnstaged && !testMergeLink && !testSingleRepository) for (const repo of roots) for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
        if (testDeletedLink && repo === roots[4] && file === 'a.txt') {
            assert.equal(fs.existsSync(path.join(repo, file)), false, 'deleted link must not recreate its working file');
            continue;
        }
        assert.equal(fs.readFileSync(path.join(repo, file), 'utf8'), 'modified\n');
    }
    console.log(`BETTER_GIT_NATIVE_WORKTREE_VERIFIED evidence=${evidence}`);
    }
    }
} finally {
    if (fs.existsSync(path.join(root, 'ready.json'))) { await request('stop').catch(() => {}); }
    activationMonitor?.kill('SIGTERM');
    socket?.close();
    child.kill('SIGTERM');
    fs.closeSync(log);
    console.log(`Native test fixture: ${root}`);
}
