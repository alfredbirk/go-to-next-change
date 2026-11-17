// Disposable Mini-only host: the real production extension sees real mouse events.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
    const root = process.env.BGV_SELECTION_TEST_ROOT;
    await vscode.extensions.getExtension('EthanSK.better-git-vscode').activate();
    const file = vscode.Uri.file(path.join(root, 'selection.txt'));
    await vscode.window.showTextDocument(file, { preview: false });
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ pid: Number(process.env.VSCODE_PID),
        version: vscode.version, focused: vscode.window.state.focused }));
    let previous = 0;
    let terminal;
    await new Promise(resolve => {
        const timer = setInterval(async () => {
            let request;
            try { request = JSON.parse(fs.readFileSync(path.join(root, 'request.json'), 'utf8')); } catch { return; }
            if (request.id === previous) { return; }
            previous = request.id;
            if (request.action === 'programmatic') {
                vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 5);
            } else if (request.action === 'multiple') {
                vscode.window.activeTextEditor.selections = [new vscode.Selection(0, 0, 0, 5), new vscode.Selection(1, 0, 1, 5)];
            } else if (request.action === 'empty') {
                vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
            } else if (request.action === 'diff') {
                await vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(path.join(root, 'original.txt')), file, 'Selection bridge diff');
            } else if (request.action === 'terminal') {
                const output = new vscode.EventEmitter();
                terminal = vscode.window.createTerminal({ name: 'AgentFlow terminal fixture', pty: {
                    onDidWrite: output.event,
                    open() { output.fire('TERMINAL_ONLY_SENTINEL\r\n'); },
                    close() { output.dispose(); }
                }});
                terminal.show();
            } else if (request.action === 'state') {
                const editor = vscode.window.activeTextEditor;
                request.text = editor?.document.getText(editor.selection);
                if (editor) {
                    const { start, end } = editor.selection;
                    request.editorLocation = { documentKind: 'file', filePath: editor.document.uri.fsPath,
                        documentVersion: editor.document.version, unsaved: editor.document.isDirty,
                        startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1,
                        endColumn: end.character + 1, capturedEndLine: end.line + 1, capturedEndColumn: end.character + 1 };
                    if (vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Selection bridge diff') {
                        request.editorLocation.diffSide = editor.document.uri.fsPath === file.fsPath ? 'modified' : 'original';
                    }
                }
                request.focused = vscode.window.state.focused;
                request.version = vscode.extensions.getExtension('EthanSK.better-git-vscode').packageJSON.version;
                request.terminalText = terminal?.selection;
            } else if (request.action === 'stop') { terminal?.dispose(); clearInterval(timer); resolve(); }
            fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(request));
        }, 25);
    });
};
