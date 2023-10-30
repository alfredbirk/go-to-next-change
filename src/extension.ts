import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand("go-to-next-change.go-to-next-scm-change", async () => {
        await goToNextDiff();
    });

    context.subscriptions.push(disposable);
}

const isInDiffEditor = () => {
    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return false;
    }
    const uri = activeEditor.document.uri.toString();

    return vscode.window.tabGroups.all.some((tabGroup) =>
        tabGroup.tabs.some(
            (tab) => (tab.input as any).modified?.toString() === uri || (tab.input as any).original?.toString() === uri
        )
    );
};

const openFirstFile = async () => {
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand("list.focusFirst");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.select");
};

const openNextFile = async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.select");
};

const goToNextDiff = async () => {
    const isDiffEditor = isInDiffEditor();

    if (!isDiffEditor) {
        await openFirstFile();
        return;
    }

    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    const lineBefore = activeEditor.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");

    const lineAfter = activeEditor.selection.active.line;

    if (lineAfter < lineBefore) {
        await openNextFile();
    }

    return;
};

export function deactivate() {}
