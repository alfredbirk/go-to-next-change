// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "go-to-next-change" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = vscode.commands.registerCommand("go-to-next-change.go-to-next-scm-change", async () => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
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
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand("workbench.view.scm");
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

// This method is called when your extension is deactivated
export function deactivate() {}
