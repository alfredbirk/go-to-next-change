import * as vscode from "vscode";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { randomUUID } from "crypto";
import { agentFlowEditorIdentity, AgentFlowEditorLocation, AgentFlowSelectionEventKind, AgentFlowSelectionDirection, agentFlowSelectionEventKind, agentFlowSelectionIsFresh,
    agentFlowTerminalSelection, parseAgentFlowSelectionRequest } from "./agentFlowSelectionProtocol";

// Keep the extension's older VS Code minimum: the stable local tool API is
// optional on old hosts. Only this bounded read is used, never model selection.
interface LocalTerminalTools {
    readonly tools: readonly { name: string }[];
    invokeTool(name: string, options: { input: Record<string, never> }): Thenable<{
        content: readonly unknown[];
    }>;
}
const localToolHost = vscode as typeof vscode & { lm?: LocalTerminalTools };

/**
 * Monaco deliberately hides its text from macOS AX when screen-reader mode is off.
 * AgentFlow therefore pulls one fresh, user-made editor selection through VS Code's
 * public API. A startup pull also reads the currently highlighted range without
 * requiring a new gesture. Never copy, execute an editor command, poll,
 * cache selected text, or change focus. Ordinary Git/navigation latency is untouched.
 *
 * A private per-user Unix socket has no TCP/network endpoint. Only a request tied to
 * recording startup or the current mouse/keyboard gesture and focused VS Code PID can read text. Other windows,
 * programmatic hunk movements during recording and webviews return null. Terminal
 * pulls require Agent Flow to prove terminal focus; they never borrow editor text.
 * See https://code.visualstudio.com/api/references/vscode-api#TextEditorSelectionChangeEvent
 */
export function registerAgentFlowSelectionBridge(context: vscode.ExtensionContext): void {
    if (process.platform !== "darwin" || !process.getuid || vscode.env.remoteName) { return; }
    const mainPID = Number(process.env.VSCODE_PID);
    if (!Number.isSafeInteger(mainPID) || mainPID <= 0) { return; }
    const directory = `/tmp/agentflow-selection-${process.getuid()}`;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") { return; }
    }
    try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
            directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0) { return; }
    } catch { return; }

    let latest: { editor: vscode.TextEditor; selection: vscode.Selection; version: number; changedAt: number;
        inputKind: AgentFlowSelectionEventKind; fullDocument: boolean;
        direction?: AgentFlowSelectionDirection } | undefined;
    // Coordinates/version only, never text. The anchor is necessary, not proof
    // alone: an unclassified extension also needs fresh physical keyboard intent
    // and direction from Agent Flow. General command/hunk changes stay excluded.
    const snapshot = () => {
        const editor = vscode.window.activeTextEditor;
        return editor && editor.selections.length === 1 ?
            { editor, selection: editor.selection, version: editor.document.version } : undefined;
    };
    const readEditorSelection = (editor: vscode.TextEditor, selection: vscode.Selection):
        { text: string; location: AgentFlowEditorLocation } => {
        const document = editor.document;
        const start = document.offsetAt(selection.start);
        const end = Math.min(document.offsetAt(selection.end), start + 8192);
        const text = document.getText(new vscode.Range(selection.start, document.positionAt(end)))
            .replace(/[\uD800-\uDBFF]$/, "");
        // Derive the captured end from the text actually sent. A clipped surrogate
        // or CRLF boundary can leave it earlier than the transport's raw limit.
        const capturedEnd = document.positionAt(start + text.length);
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        let diffSide: AgentFlowEditorLocation["diffSide"];
        if (input instanceof vscode.TabInputTextDiff) {
            const uri = document.uri.toString();
            const original = uri === input.original.toString();
            const modified = uri === input.modified.toString();
            if (original !== modified) { diffSide = original ? "original" : "modified"; }
        }
        return { text, location: {
            ...agentFlowEditorIdentity(document.uri), ...(diffSide && { diffSide }),
            documentVersion: document.version, unsaved: document.isDirty,
            startLine: selection.start.line + 1, startColumn: selection.start.character + 1,
            endLine: selection.end.line + 1, endColumn: selection.end.character + 1,
            capturedEndLine: capturedEnd.line + 1, capturedEndColumn: capturedEnd.character + 1,
        } };
    };
    let previous = snapshot();
    let disposed = false;
    const socketPath = path.join(directory, `vscode-${mainPID}-${process.pid}-${randomUUID()}.sock`);
    const clients = new Set<net.Socket>();
    const clear = () => { latest = undefined; };
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            clear();
            // API/command-driven hunk movement is not a highlight gesture. Keep only
            // selection coordinates; read the bounded text lazily after a valid pull.
            const selection = event.selections[0];
            const document = event.textEditor.document;
            const before = previous;
            previous = event.selections.length === 1 ? { editor: event.textEditor,
                selection, version: document.version } : undefined;
            const fullDocument = event.selections.length === 1 && !!selection &&
                selection.start.isEqual(new vscode.Position(0, 0)) &&
                selection.end.isEqual(document.lineAt(document.lineCount - 1).range.end);
            const sameAnchor = !!selection && before?.editor === event.textEditor &&
                before.version === document.version && selection.anchor.isEqual(before.selection.anchor) &&
                !selection.active.isEqual(before.selection.active);
            let direction: AgentFlowSelectionDirection | undefined;
            if (sameAnchor && before) {
                const old = before.selection.active, next = selection.active;
                direction = next.line !== old.line ? (next.line > old.line ? "down" : "up") :
                    (next.character > old.character ? "right" : "left");
            }
            const inputKind = agentFlowSelectionEventKind(event.kind, fullDocument, sameAnchor);
            if (inputKind && vscode.window.state.focused &&
                event.textEditor === vscode.window.activeTextEditor && event.selections.length === 1 &&
                !event.selections[0].isEmpty) {
                latest = { editor: event.textEditor, selection: event.selections[0],
                    version: event.textEditor.document.version, changedAt: Date.now(), inputKind, fullDocument, direction };
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => { clear(); previous = snapshot(); }),
        vscode.window.onDidChangeWindowState(state => { clear(); previous = state.focused ? snapshot() : undefined; }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (previous?.editor.document === event.document) { clear(); previous = snapshot(); }
        })
    );

    const server = net.createServer(socket => {
        if (disposed || clients.size >= 8) { socket.destroy(); return; }
        clients.add(socket);
        socket.setTimeout(500, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("close", () => clients.delete(socket));
        let input = Buffer.alloc(0);
        let handled = false;
        socket.on("data", async chunk => {
            if (handled) { return; }
            input = Buffer.concat([input, chunk]);
            if (input.length > 1024) { socket.destroy(); return; }
            if (!input.includes(10)) { return; }
            handled = true;
            let result: object | null = null;
            try {
                const request = parseAgentFlowSelectionRequest(JSON.parse(input.toString("utf8").trim()));
                const current = latest;
                if (request && request.sourcePID === mainPID && request.surface === "terminal" && vscode.window.state.focused) {
                    const terminal = vscode.window.activeTerminal;
                    // This is VS Code's local, read-only tool, not a model call.
                    // No Copilot session, proposed API, Copy or clipboard access.
                    const tools = localToolHost.lm;
                    const reader = tools?.tools.find(tool => tool.name === "terminal_selection");
                    if (terminal && reader && tools) {
                        const response = await tools.invokeTool(reader.name, { input: {} });
                        const text = agentFlowTerminalSelection(response.content.map(part =>
                            part !== null && typeof part === "object" && "value" in part ? part.value : undefined));
                        if (text && !disposed && !socket.destroyed && vscode.window.state.focused &&
                            terminal === vscode.window.activeTerminal &&
                            parseAgentFlowSelectionRequest(request)) {
                            result = { version: 1, nonce: request.nonce, sourcePID: mainPID,
                                surface: "terminal", observedAt: Date.now(), text,
                                captureKind: request.captureKind,
                                inputKind: request.inputKind ?? "mouse" };
                        }
                    }
                } else if (request && request.captureKind === "startup" && request.surface === "editor" &&
                    request.sourcePID === mainPID && vscode.window.state.focused) {
                    // "Preselect" is an existing highlight at Agent Flow start,
                    // not a selection-change event. Read today's active range,
                    // never latest's old editor. Native code separately proves
                    // this pane owns focus before and after the socket read.
                    const initial = snapshot();
                    if (initial && !initial.selection.isEmpty &&
                        vscode.window.visibleTextEditors.includes(initial.editor)) {
                        const selection = readEditorSelection(initial.editor, initial.selection);
                        result = { version: 1, nonce: request.nonce, sourcePID: mainPID,
                            surface: "editor", captureKind: "startup", observedAt: Date.now(), ...selection,
                            inputKind: request.inputKind ?? "mouse" };
                    }
                } else if (request && request.surface !== "terminal" && request.sourcePID === mainPID && current && vscode.window.state.focused &&
                    current.editor === vscode.window.activeTextEditor &&
                    vscode.window.visibleTextEditors.includes(current.editor) &&
                    current.editor.document.version === current.version &&
                    current.editor.selection.isEqual(current.selection) &&
                    agentFlowSelectionIsFresh(request, current.changedAt, Date.now(), current.inputKind,
                        current.fullDocument, current.direction)) {
                    const selection = readEditorSelection(current.editor, current.selection);
                    result = { version: 1, nonce: request.nonce, sourcePID: mainPID,
                        surface: "editor", changedAt: current.changedAt, ...selection, inputKind: request.inputKind ?? "mouse" };
                }
            } catch { /* Malformed/disappearing editor: no content and no log. */ }
            socket.end(JSON.stringify(result) + "\n");
        });
    });
    server.on("error", () => { /* Optional bridge failure must never break Better Git activation. */ });
    server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { server.close(); }
        if (disposed) { server.close(); }
    });
    server.unref();
    context.subscriptions.push(new vscode.Disposable(() => {
        disposed = true;
        clear();
        for (const socket of clients) { socket.destroy(); }
        server.close(); // Node removes its own Unix socket; never delete another host's endpoint.
    }));
}
