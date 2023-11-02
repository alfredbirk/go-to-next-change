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
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand("list.focusFirst");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.select");
};

const openLastFile = async () => {
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand("list.focusLast");
    await vscode.commands.executeCommand("list.select");
};

const openNextFile = async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("list.focusDown");
    await vscode.commands.executeCommand("list.select");
};

const openPreviousFile = async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("list.focusUp");
    await vscode.commands.executeCommand("list.select");
    setTimeout(() => {
        vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    }, 50);
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
        const currentFilename = activeEditor.document.fileName;
        const lastFilename = await getLastFilename();

        if (currentFilename === lastFilename) {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            return;
        }

        await openNextFile();
    }

    return;
};

const goToPreviousDiff = async () => {
    const isDiffEditor = isInDiffEditor();

    if (!isDiffEditor) {
        await openLastFile();
        setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
        }, 50);

        return;
    }

    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    const lineBefore = activeEditor.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");

    const lineAfter = activeEditor.selection.active.line;
    const currentFilename = activeEditor.document.fileName;
    const firstFilename = await getFirstFilename();

    if (lineAfter >= lineBefore) {
        if (currentFilename === firstFilename) {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            return;
        }

        await openPreviousFile();
    }

    return;
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

    const currentFilename = activeEditor.document.fileName;
    const lastFilename = await getLastFilename();

    if (currentFilename === lastFilename) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
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

    const currentFilename = activeEditor.document.fileName;
    const firstFilename = await getFirstFilename();

    if (currentFilename === firstFilename) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    await openPreviousFile();
};

export function deactivate() {}
