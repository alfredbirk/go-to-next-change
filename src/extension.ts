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

const orderFilesForListView = (a: any, b: any) => {
    // Order files same way as VSCode does it
    // 1) split by folders and compare pairwise
    // 2) if none have more folders: compare lexiographically
    // 3) if both have more folders, but folder are differing: compare lexiographically
    // 4) if only one have any more folders: order that last
    // 5) if both have more folders, and folders are same: compare next folder and go to step 2

    const filenameA = a.path.toLowerCase().split("/");
    const filenameB = b.path.toLowerCase().split("/");

    for (let i = 0; i < Math.max(filenameA.length, filenameB.length); i++) {
        const partA = filenameA[i];
        const partB = filenameB[i];

        if (partA === partB) {
            continue;
        }

        if (
            (i === filenameA.length - 1 && i === filenameB.length - 1) ||
            (i < filenameA.length - 1 && i < filenameB.length - 1 && partA !== partB)
        ) {
            if (partA < partB) {
                return -1;
            }
            if (partB < partA) {
                return 1;
            }

            return 0;
        }

        if (i === filenameA.length - 1) {
            return -1;
        }

        if (i === filenameB.length - 1) {
            return 1;
        }
    }
};

const orderFilesForTreeView = (a: any, b: any) => {
    // Order files same way as VSCode does it
    // 1) split by folders and compare pairwise
    // 2) if none have more folders: compare lexiographically
    // 3) if both have more folders, but folder are differing: compare lexiographically
    // 4) if only one have any more folders: order that first
    // 5) if both have more folders, and folders are same: compare next folder and go to step 2

    const filenameA = a.path.toLowerCase().split("/");
    const filenameB = b.path.toLowerCase().split("/");

    for (let i = 0; i < Math.max(filenameA.length, filenameB.length); i++) {
        const partA = filenameA[i];
        const partB = filenameB[i];

        if (partA === partB) {
            continue;
        }

        if (
            (i === filenameA.length - 1 && i === filenameB.length - 1) ||
            (i < filenameA.length - 1 && i < filenameB.length - 1 && partA !== partB)
        ) {
            if (partA < partB) {
                return -1;
            }
            if (partB < partA) {
                return 1;
            }

            return 0;
        }

        if (i === filenameA.length - 1) {
            return 1;
        }

        if (i === filenameB.length - 1) {
            return -1;
        }
    }
};

const getFileChanges = async () => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const repos = git.repositories;
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");

    const changedFiles = await repos[0].state.workingTreeChanges
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);

    return changedFiles;
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
    const currentFilename = activeEditor.document.uri.path;
    const currentIndex = fileChanges.findIndex((file: any) => file.path === currentFilename);
    const nextFile = fileChanges[currentIndex + 1];

    if (currentIndex === fileChanges.length - 1) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    const doc = await vscode.workspace.openTextDocument(nextFile);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("git.openChange");
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    var activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }
    const currentFilename = activeEditor.document.uri.path;
    const currentIndex = fileChanges.findIndex((file: any) => file.path === currentFilename);
    const previousFile = fileChanges[currentIndex - 1];

    if (currentIndex === 0) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    const doc = await vscode.workspace.openTextDocument(previousFile);
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
