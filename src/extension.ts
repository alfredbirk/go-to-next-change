import * as vscode from "vscode";

let isNavigationPromptOpen = false;

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

    let disposable5 = vscode.commands.registerCommand("go-to-next-change.revert-and-save", async () => {
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
    });

    let disposable6 = vscode.commands.registerCommand("go-to-next-change.stage-and-go-to-next-changed-file", async () => {
        await stageCurrentFileAndGoToNextUnstaged();
    });

    context.subscriptions.push(disposable, disposable2, disposable3, disposable4, disposable5, disposable6);
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
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    const activeRepo = git.getRepository(workspaceUri?.path) || git.repositories[0];
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");

    const indexChanges = await activeRepo.state.indexChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);

    const workingTreeChanges = await activeRepo.state.workingTreeChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);

    // BUG FIX: a file that is partially staged (or staged and then edited again) appears in BOTH
    // indexChanges and workingTreeChanges with the SAME on-disk path, so it used to land in this list
    // twice. Navigation finds "where you are" with findIndex(path), which always returns the FIRST
    // (staged) occurrence — and VSCode's git.openChange always opens the working-tree diff for such a
    // file (its getSCMResource prefers the working tree group), so the staged duplicate is actually
    // unreachable. That mismatch made "go to next change" jump to the wrong file or get stuck looping
    // on the same one. Repro before fix: stage file A, edit A again, then from a staged file listed
    // above A press the next-change shortcut past A's last diff — it jumped to A's unstaged copy
    // instead of advancing down the list. Collapse to one entry per path; keeping the first occurrence
    // preserves the Source Control view's top-to-bottom reading order.
    const seenPaths = new Set<string>();
    return [...indexChanges, ...workingTreeChanges].filter((uri: any) => {
        const pathKey = uri.path.toLowerCase();
        if (seenPaths.has(pathKey)) {
            return false;
        }
        seenPaths.add(pathKey);
        return true;
    });
};

const openFirstFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("go-to-next-change").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    const firstFile = fileChanges[0];

    await vscode.commands.executeCommand("git.openChange", firstFile);
};

const openLastFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("go-to-next-change").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    const lastFile = fileChanges[fileChanges.length - 1];

    await vscode.commands.executeCommand("git.openChange", lastFile);
};

const openNextFile = async () => {
    const fileChanges = await getFileChanges();

    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        return;
    }

    const currentFilenameNormalized = currentFilename.slice(1).replace(/\\/g, "/").toLowerCase();
    const currentIndex = fileChanges.findIndex((file: any) => file.path.toLowerCase().endsWith(currentFilenameNormalized));
    const nextFile = fileChanges[currentIndex + 1];

    if (currentIndex === fileChanges.length - 1) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await vscode.commands.executeCommand("git.openChange", nextFile);
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        return;
    }

    const currentFilenameNormalized = currentFilename.slice(1).replace(/\\/g, "/").toLowerCase();
    const currentIndex = fileChanges.findIndex((file: any) => file.path.toLowerCase().endsWith(currentFilenameNormalized));
    const previousFile = fileChanges[currentIndex - 1];

    if (currentIndex === 0) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await vscode.commands.executeCommand("git.openChange", previousFile);
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
};

const getNextFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        return null;
    }

    const currentFilenameNormalized = currentFilename.slice(1).replace(/\\/g, "/").toLowerCase();
    const currentIndex = fileChanges.findIndex((file: any) => file.path.toLowerCase().endsWith(currentFilenameNormalized));
    
    if (currentIndex === fileChanges.length - 1) {
        return null;
    }
    
    const nextFile = fileChanges[currentIndex + 1] as any;
    return nextFile.path || nextFile;
};

const getPreviousFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        return null;
    }

    const currentFilenameNormalized = currentFilename.slice(1).replace(/\\/g, "/").toLowerCase();
    const currentIndex = fileChanges.findIndex((file: any) => file.path.toLowerCase().endsWith(currentFilenameNormalized));
    
    if (currentIndex === 0) {
        return null;
    }
    
    const previousFile = fileChanges[currentIndex - 1] as any;
    return previousFile.path || previousFile;
};

const goToNextDiff = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = await getActiveFilePath();
    if (!activeEditor && !currentFilename) {
        await openFirstFile();
        return;
    }

    const lineBefore = activeEditor?.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
    const lineAfter = activeEditor?.selection.active.line;

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter > lineBefore)) {
        // Check if prompt is enabled
        const promptEnabled = vscode.workspace.getConfiguration("go-to-next-change").get("promptBeforeNextFile");
        
        if (promptEnabled) {
            if (isNavigationPromptOpen) {
                return;
            }

            // Ask user for confirmation before jumping to next file
            const nextFile = await getNextFileName();

            isNavigationPromptOpen = true;
            try {
                const promptMessage = nextFile
                    ? `Jump to next file: ${nextFile}?`
                    : "No next changed file. Close current editor?";

                const confirmJump = await vscode.window.showWarningMessage(
                    promptMessage,
                    { modal: true },
                    "Yes",
                    "No"
                );

                if (confirmJump === "Yes") {
                    await openNextFile();
                }
            } finally {
                isNavigationPromptOpen = false;
            }
        } else {
            // Jump to next file without prompt
            await openNextFile();
        }
        return;
    }
};

const goToPreviousDiff = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = await getActiveFilePath();
    if (!activeEditor && !currentFilename) {
        await openLastFile();
        return;
    }

    const lineBefore = activeEditor?.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    const lineAfter = activeEditor?.selection.active.line;

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter < lineBefore)) {
        // Check if prompt is enabled
        const promptEnabled = vscode.workspace.getConfiguration("go-to-next-change").get("promptBeforeNextFile");
        
        if (promptEnabled) {
            if (isNavigationPromptOpen) {
                return;
            }

            // Ask user for confirmation before jumping to previous file
            const previousFile = await getPreviousFileName();

            isNavigationPromptOpen = true;
            try {
                const promptMessage = previousFile
                    ? `Jump to previous file: ${previousFile}?`
                    : "No previous changed file. Close current editor?";

                const confirmJump = await vscode.window.showWarningMessage(
                    promptMessage,
                    { modal: true },
                    "Yes",
                    "No"
                );

                if (confirmJump === "Yes") {
                    await openPreviousFile();
                }
            } finally {
                isNavigationPromptOpen = false;
            }
        } else {
            // Jump to previous file without prompt
            await openPreviousFile();
        }
    }
};

const goToFirstOrNextFile = async () => {
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        await openFirstFile();
        return;
    }

    await openNextFile();
};

const goToLastOrPreviousFile = async () => {
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        await openLastFile();
        return;
    }

    await openPreviousFile();
};

// FEATURE (shift+alt+z): stage the whole current file, then jump straight to the next UNSTAGED file so
// you can review-and-stage without reaching for the mouse to click the + each time.
const stageCurrentFileAndGoToNextUnstaged = async () => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    const activeRepo = git.getRepository(workspaceUri?.path) || git.repositories[0];

    const currentUri = await getActiveFileUri();
    if (!currentUri) {
        return;
    }

    // Work out the next unstaged file BEFORE staging. activeRepo.state updates asynchronously after a
    // stage, so reading the list afterwards would see a stale snapshot (current file still present) or
    // shifted indices. Capturing the target up-front makes where-we-land deterministic. We only look at
    // workingTreeChanges (the unstaged group) because the goal is to advance to the next unstaged file.
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");
    const workingTreeChanges = activeRepo.state.workingTreeChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);

    const currentNormalized = currentUri.path.slice(1).replace(/\\/g, "/").toLowerCase();
    const currentIndex = workingTreeChanges.findIndex((uri: any) => uri.path.toLowerCase().endsWith(currentNormalized));
    // Current file is in the unstaged list -> land on the one after it. Not in it (e.g. we were viewing
    // an already-staged file) -> fall back to the first unstaged file.
    const nextUnstagedFile = currentIndex === -1 ? workingTreeChanges[0] : workingTreeChanges[currentIndex + 1];

    // Stage the whole current file — equivalent to clicking the + next to it in the Source Control view.
    await activeRepo.add([currentUri.fsPath]);

    if (!nextUnstagedFile) {
        // Current was the last (or only) unstaged file — nothing left to review, so close the diff editor.
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    // Mirror openNextFile's editor handling: replace a pinned (non-preview) editor, keep a preview tab.
    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await vscode.commands.executeCommand("git.openChange", nextUnstagedFile);
};

const getActiveFilePath = async (): Promise<string> => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = activeEditor?.document.uri.path;
    if (currentFilename) {
        return currentFilename;
    }

    // Since there is no API to get details of non-textual files, the following workaround is performed:
    // 1. Saving the original clipboard data to a local variable.
    const originalClipboardData = await vscode.env.clipboard.readText();

    // 2. Populating the clipboard with an empty string
    await vscode.env.clipboard.writeText("");

    // 3. Calling the copyPathOfActiveFile that populates the clipboard with the source path of the active file.
    // If there is no active file - the clipboard will not be populated and it will stay with the empty string.
    await vscode.commands.executeCommand("workbench.action.files.copyPathOfActiveFile");

    // 4. Get the clipboard data after the API call
    const postAPICallClipboardData = await vscode.env.clipboard.readText();

    // 5. Return the saved original clipboard data to the clipboard so this method
    // will not interfere with the clipboard's content.
    await vscode.env.clipboard.writeText(originalClipboardData);

    // 6. Return the clipboard data from the API call (which could be an empty string if it failed).
    return postAPICallClipboardData;
};

// Returns the on-disk file:// Uri of the active editor. A staged diff's modified side uses the `git`
// scheme and encodes the real path in its JSON query (e.g. {"path":"/abs/path","ref":""}), so we
// normalize that back to a plain file Uri. Needed by the stage-and-advance command, which requires a
// filesystem path to stage and to match against the unstaged list.
const getActiveFileUri = async (): Promise<vscode.Uri | null> => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
        if (uri.scheme === "git") {
            try {
                const params = JSON.parse(uri.query); // git uris carry {"path":"/abs/path","ref":...}
                if (params?.path) {
                    return vscode.Uri.file(params.path);
                }
            } catch {
                // Malformed/empty query — fall through and return the uri unchanged.
            }
        }
        return uri;
    }

    // Non-textual files (e.g. images) have no activeTextEditor; reuse the clipboard-based path lookup.
    const path = await getActiveFilePath();
    return path ? vscode.Uri.file(path) : null;
};

export function deactivate() {}
