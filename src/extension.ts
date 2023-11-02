import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand("go-to-next-change.go-to-next-scm-change", async () => {
        await goToNextDiff();
    });

    let disposable2 = vscode.commands.registerCommand("go-to-next-change.go-to-previous-scm-change", async () => {
        await goToPreviousDiff();
    });

    let disposable3 = vscode.commands.registerCommand("go-to-next-change.go-to-next-changed-file", async () => {
        await goToFirstOrNextFile();
    });

    let disposable4 = vscode.commands.registerCommand("go-to-next-change.go-to-previous-changed-file", async () => {
        await goToLastOrPreviousFile();
    });

    context.subscriptions.push(disposable, disposable2, disposable3, disposable4);
}

const getFileChanges = async () => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const repos = git.repositories;
    const changedFiles = await repos[0].state.workingTreeChanges
        .map((file: any) => file.uri.toString().substr(7))
        .sort();

    return changedFiles;
};

const getFirstFilename = async () => {
    const changes = await getFileChanges();
    return changes[0];
};

const getLastFilename = async () => {
    const changes = await getFileChanges();
    return changes[changes.length - 1];
};

const isInDiffEditor = () => {
    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return false;
    }
    const uri = activeEditor.document.uri.toString();

    return vscode.window.tabGroups.all.some((tabGroup) =>
        tabGroup.tabs
            .filter((tab) => tab.input)
            .some(
                (tab) =>
                    (tab.input as any).modified?.toString() === uri || (tab.input as any).original?.toString() === uri
            )
    );
};

const openFirstFile = async () => {
    await vscode.commands.executeCommand("workbench.view.scm");

    const fileChanges = await getFileChanges();
    const firstFile = fileChanges[0];

    const doc = await vscode.workspace.openTextDocument(firstFile);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("git.openChange");
};

const openLastFile = async () => {
    await vscode.commands.executeCommand("workbench.view.scm");

    const fileChanges = await getFileChanges();
    const lastFile = fileChanges[fileChanges.length - 1];

    const doc = await vscode.workspace.openTextDocument(lastFile);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("git.openChange");
};

const openNextFile = async () => {
    const fileChanges = await getFileChanges();
    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }
    const currentFilename = activeEditor.document.fileName;
    const currentIndex = fileChanges.indexOf(currentFilename);
    const nextFilename = fileChanges[currentIndex + 1];

    if (currentIndex === fileChanges.length - 1) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    const doc = await vscode.workspace.openTextDocument(nextFilename);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("git.openChange");
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }
    const currentFilename = activeEditor.document.fileName;
    const currentIndex = fileChanges.indexOf(currentFilename);
    const previousFilename = fileChanges[currentIndex - 1];

    if (currentIndex === 0) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    const doc = await vscode.workspace.openTextDocument(previousFilename);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("git.openChange");
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
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

    if (lineAfter <= lineBefore) {
        await openNextFile();
    }
};

const goToPreviousDiff = async () => {
    const isDiffEditor = isInDiffEditor();

    if (!isDiffEditor) {
        await openLastFile();
        return;
    }

    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    const lineBefore = activeEditor.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    const lineAfter = activeEditor.selection.active.line;

    if (lineAfter >= lineBefore) {
        await openPreviousFile();
    }
};

const goToFirstOrNextFile = async () => {
    const isDiffEditor = isInDiffEditor();

    if (!isDiffEditor) {
        await openFirstFile();
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    await openNextFile();
};

const goToLastOrPreviousFile = async () => {
    const isDiffEditor = isInDiffEditor();

    if (!isDiffEditor) {
        await openLastFile();
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    await openPreviousFile();
};

export function deactivate() {}
