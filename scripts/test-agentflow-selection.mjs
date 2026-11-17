// Isolated workbench integration, never Ethan's normal VS Code. Run only on Mini.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertE2EHost } from './e2e-host-guard.mjs';
assertE2EHost();
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync('/tmp/bgv-selection-'));
const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH;
assert.ok(executable && fs.existsSync(executable));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try { last = await read(); if (accept(last)) { return last; } } catch (error) { last = String(error); }
        await pause(75);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
}
fs.writeFileSync(path.join(root, 'selection.txt'), 'AgentFlow selected code\nSecond line for the diff\n');
fs.writeFileSync(path.join(root, 'original.txt'), 'Original code\nSecond line for the diff\n');
const profile = path.join(root, 'profile');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
    'editor.accessibilitySupport': 'off', 'workbench.startupEditor': 'none',
    'editor.minimap.enabled': false, 'diffEditor.renderSideBySide': true,
    'update.mode': 'none', 'extensions.autoUpdate': false
}));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const log = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(executable, [root, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionRoot}`, `--extensionTestsPath=${path.join(extensionRoot, 'scripts/agentflow-selection-test-driver.cjs')}`,
    `--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry'],
    { env: { ...process.env, BGV_SELECTION_TEST_ROOT: root }, stdio: ['ignore', log, log] });
let websocket;
let send;
let requestID = 0;
async function command(action) {
    const id = ++requestID;
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ id, action }));
    return until(() => JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')), r => r.id === id, action);
}
try {
    const ready = await until(() => JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')), Boolean, 'host ready', 60_000);
    const targets = await until(async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), a => a.some(t => t.type === 'page'), 'CDP');
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    assert.ok(target);
    websocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve); websocket.addEventListener('error', reject); });
    const pending = new Map(); let sequence = 0;
    websocket.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id) { const pair = pending.get(response.id); pending.delete(response.id);
            if (response.error) { pair?.reject(response.error); } else { pair?.resolve(response.result); } }
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject });
        websocket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    await send('Page.bringToFront');
    const directory = `/tmp/agentflow-selection-${process.getuid()}`;
    const endpoint = await until(() => fs.readdirSync(directory).find(n => n.startsWith(`vscode-${ready.pid}-`)), Boolean, 'private socket');
    const socketPath = path.join(directory, endpoint);
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
    const query = (gestureStartedAt, overrides = {}) => new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath);
        let result = '';
        client.setTimeout(1500, () => client.destroy(new Error('bridge timeout')));
        client.on('error', reject);
        client.on('connect', () => client.write(JSON.stringify({ version: 1, nonce: randomUUID(), sourcePID: ready.pid,
            requestedAt: Date.now(), gestureStartedAt, ...overrides }) + '\n'));
        client.on('data', part => { result += part; });
        client.on('end', () => resolve(JSON.parse(result)));
    });
    assert.equal(await query(Date.now()), null, 'No highlight must return null');
    async function highlight(label, selectedPrefix = 'AgentFlow selected code') {
        const prefix = JSON.stringify(selectedPrefix);
        const box = await until(() => evaluate(`(()=>{const lines=[...document.querySelectorAll('.monaco-editor .view-line')].filter(e=>e.textContent.replaceAll('\\u00a0',' ').includes(${prefix}));const e=lines.at(-1);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`), b => b?.width > 0, label);
        const since = Date.now();
        const y = box.y + box.height / 2;
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 1, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 180, y, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 180, y, button: 'left', clickCount: 1 });
        const captured = await until(() => query(since), r => r?.text?.startsWith(selectedPrefix), label + ' bridge');
        const state = await command('state');
        assert.equal(captured.text, state.text, 'Bridge must match the actual selected range');
        assert.deepEqual(captured.location, state.editorLocation, 'Live selection includes the exact editor location');
        // Exercise the production Swift socket client too, not just a JS stand-in.
        if (process.env.AGENTFLOW_SELECTION_PROBE) {
            const actual = JSON.parse(execFileSync(process.env.AGENTFLOW_SELECTION_PROBE,
                [String(ready.pid), String(since)], { encoding: 'utf8', timeout: 3000 }));
            assert.equal(actual.text, captured.text);
            assert.deepEqual(actual.location, captured.location);
        }
        assert.equal(await query(since, { sourcePID: ready.pid + 1 }), null, 'Wrong process');
        assert.equal(await query(Date.now() + 200), null, 'Later unrelated gesture');
        assert.equal(await query(since, { nonce: 'bad' }), null, 'Malformed request');
        console.log(`PASS ${label}: real mouse selection -> Better Git -> Unix socket -> native client`);
    }
    async function preselected(surface, expectedText) {
        // Fixture-only aging: the next request deliberately starts after the
        // selection event, as when Ethan highlights first and then summons HUD.
        await pause(100);
        const startedAt = Date.now();
        const reply = await query(startedAt, { surface, captureKind: 'startup' });
        assert.equal(reply?.text, expectedText, `${surface} preselection must not require a new selection event`);
        assert.equal(reply.captureKind, 'startup');
        assert.equal(reply.surface, surface);
        assert.deepEqual(reply.location, surface === 'editor' ? (await command('state')).editorLocation : undefined);
        assert.ok(reply.observedAt >= startedAt);
        if (process.env.AGENTFLOW_SELECTION_PROBE) {
            const native = JSON.parse(execFileSync(process.env.AGENTFLOW_SELECTION_PROBE,
                [String(ready.pid), String(startedAt), surface, 'startup'], { encoding: 'utf8', timeout: 5000 }));
            assert.equal(native.surface, surface);
            assert.equal(native.text, expectedText, 'Production Swift startup pull must preserve preselected text');
            assert.deepEqual(native.location, reply.location ?? null);
        }
        assert.equal(await query(Date.now()), null, 'Startup snapshot must not weaken a later live gesture');
        console.log(`PASS ${surface} preselected before startup -> companion -> production native client`);
    }
    await highlight('plain editor, screen-reader mode off');
    await preselected('editor', (await command('state')).text);
    await command('multiple');
    assert.equal(await query(Date.now(), { surface: 'editor', captureKind: 'startup' }), null,
        'Multiple editor selections stay ambiguous at startup');
    await command('empty');
    assert.equal(await query(Date.now(), { surface: 'editor', captureKind: 'startup' }), null,
        'An empty startup selection must not reuse the previous range');
    await command('programmatic');
    await pause(100);
    assert.equal(await query(Date.now() - 500), null, 'Programmatic selection must not become context');
    await command('diff');
    await highlight('original diff side', 'Original code');
    await preselected('editor', (await command('state')).text);
    await highlight('modified diff side');
    await preselected('editor', (await command('state')).text);
    await command('terminal');
    const terminalBox = await until(() => evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.xterm-screen')];
        const node = nodes.find(e => { const r=e.getBoundingClientRect(); return r.width>10 && r.height>10; });
        if (!node) return null; const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`), box => box?.width > 0, 'terminal screen');
    const terminalSince = Date.now();
    // Real pointer input, not a programmatic terminal selection. The old editor
    // range remains visible above, so this also catches cross-pane substitution.
    const terminalPoint = { x: terminalBox.x + 45, y: terminalBox.y + 9, button: 'left', clickCount: 2 };
    const terminalState = await until(async () => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...terminalPoint });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...terminalPoint });
        return command('state');
    }, state => state.terminalText?.includes('TERMINAL'), 'terminal highlight');
    const terminalReply = await until(() => query(terminalSince, { surface: 'terminal' }),
        reply => reply?.text === terminalState.terminalText, 'local terminal tool registration');
    assert.equal(terminalReply?.text, terminalState.terminalText);
    assert.equal(terminalReply.surface, 'terminal');
    assert.equal(await query(terminalSince), null, 'Terminal click must not refresh the old editor selection');
    if (process.env.AGENTFLOW_SELECTION_PROBE) {
        const native = JSON.parse(execFileSync(process.env.AGENTFLOW_SELECTION_PROBE,
            [String(ready.pid), String(terminalSince), 'terminal'], { encoding: 'utf8', timeout: 5000 }));
        fs.writeFileSync(path.join(root, 'native-result.json'), JSON.stringify(native));
        if (process.env.AGENTFLOW_AX_PROBE) {
            const origin = await evaluate('({x:window.screenX,y:window.screenY})');
            fs.writeFileSync(path.join(root, 'native-ax.txt'), execFileSync(process.env.AGENTFLOW_AX_PROBE,
                [String(ready.pid), String(origin.x + terminalPoint.x), String(origin.y + terminalPoint.y)],
                { encoding: 'utf8', timeout: 5000 }));
        }
        assert.equal(native.surface, 'terminal');
        assert.equal(native.text, terminalState.terminalText);
        const origin = await evaluate('({x:window.screenX,y:window.screenY})');
        assert.ok(native.bounds && native.bounds.width > 100 && native.bounds.height > 30,
            'Use the terminal pane, not its hidden one-character input');
        assert.ok(origin.x + terminalPoint.x >= native.bounds.x &&
            origin.x + terminalPoint.x <= native.bounds.x + native.bounds.width &&
            origin.y + terminalPoint.y >= native.bounds.y &&
            origin.y + terminalPoint.y <= native.bounds.y + native.bounds.height,
            'Native bounds must contain the actual highlight gesture');
    }
    console.log('PASS terminal highlight: exact terminal text, stale editor rejected, native focus verified');
    await preselected('terminal', terminalState.terminalText);
    assert.equal(fs.readFileSync(path.join(root, 'selection.txt'), 'utf8'), 'AgentFlow selected code\nSecond line for the diff\n');
    console.log(`AGENTFLOW_SELECTION_E2E_PASSED VSCode=${ready.version} evidence=${root}`);
    await command('stop');
} catch (error) {
    if (send) {
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(root, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
        const dom = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
        fs.writeFileSync(path.join(root, 'failure.txt'), dom.result.value);
    }
    console.error(`Evidence: ${root}`);
    throw error;
} finally {
    websocket?.close();
    child.kill('SIGTERM');
    fs.closeSync(log);
}
