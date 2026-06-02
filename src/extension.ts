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

// One navigable entry in the changes list. `staged` distinguishes the index (Staged Changes) copy from
// the working-tree (Changes) copy of the same file. They are SEPARATE diffs, and a partially-staged file
// legitimately appears as BOTH — exactly like the Source Control view shows it.
interface FileChange {
    uri: vscode.Uri;
    staged: boolean;
}

const getFileChanges = async (): Promise<FileChange[]> => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    const activeRepo = git.getRepository(workspaceUri?.path) || git.repositories[0];
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");

    const indexChanges: FileChange[] = activeRepo.state.indexChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView)
        .map((uri: vscode.Uri) => ({ uri, staged: true }));

    const workingTreeChanges: FileChange[] = activeRepo.state.workingTreeChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView)
        .map((uri: vscode.Uri) => ({ uri, staged: false }));

    // BUG FIX: a file that is partially staged (or staged and then edited again) appears in BOTH
    // indexChanges and workingTreeChanges with the SAME on-disk path — so it shows twice here, just as it
    // does in the Source Control view (once under Staged Changes, once under Changes). The previous code
    // matched the current position by PATH ONLY, which always resolved to the FIRST (staged) copy, while
    // VSCode's git.openChange always opens the WORKING-TREE diff for such a file (getSCMResource prefers
    // the working tree group). That mismatch made "go to next change" jump to the wrong file or loop.
    // The fix is NOT to de-duplicate (that reorders the list vs what the user sees); instead we TAG each
    // entry with its side here, then disambiguate by {path, staged} in findCurrentIndex and open the
    // matching side in openChangeEntry. Order mirrors the SCM view exactly: Staged group, then Changes
    // group. Repro before fix: stage file A, edit A again, then from a staged file above A press the
    // next-change shortcut past A's last diff — it jumped to A's unstaged copy instead of advancing.
    return [...indexChanges, ...workingTreeChanges];
};

// Describes which diff is currently focused: the file path, and whether it is the staged (index) side.
// `staged` is null when we can't tell (a plain file editor, or a non-textual file), in which case callers
// fall back to a path-only match (legacy behavior).
interface ActiveChange {
    path: string;
    staged: boolean | null;
}

const getActiveChange = async (): Promise<ActiveChange | null> => {
    // Prefer the active tab's diff input: it exposes the modified (right) side regardless of which pane
    // has keyboard focus. VSCode's git extension builds the modified side as a `git`-scheme uri for the
    // index/staged diff and the plain `file` uri for the working-tree diff (see getRightResource in
    // vscode/extensions/git/src/repository.ts), so the scheme tells us the side unambiguously.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
        return { path: input.modified.path, staged: input.modified.scheme === "git" };
    }

    // Fallback for plain editors / non-textual files: path only, side unknown.
    const path = await getActiveFilePath();
    return path ? { path, staged: null } : null;
};

// Index of the active change within the list. Matches by normalized path AND staged side when the side is
// known, so the staged and unstaged copies of a partially-staged file are told apart (the core bug fix).
const findCurrentIndex = (fileChanges: FileChange[], active: ActiveChange): number => {
    const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
    const pathMatches = (entry: FileChange) => entry.uri.path.toLowerCase().endsWith(normalized);

    if (active.staged !== null) {
        const exact = fileChanges.findIndex((entry) => entry.staged === active.staged && pathMatches(entry));
        if (exact !== -1) {
            return exact;
        }
    }
    // Side unknown, or no exact match — fall back to the first path match (legacy behavior).
    return fileChanges.findIndex(pathMatches);
};

// Replicates vscode/extensions/git/src/uri.ts toGitUri: a `git`-scheme uri whose JSON query carries the
// real fs path + a git ref. Needed to open the STAGED (index) diff of a file directly, because
// git.openChange(fileUri) resolves a plain file uri to the WORKING-TREE resource whenever one exists
// (getSCMResource prefers workingTreeGroup) — so it can't reach the staged side of a partially-staged file.
const toGitUri = (uri: vscode.Uri, ref: string): vscode.Uri => {
    return uri.with({ scheme: "git", path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });
};

// Opens the diff for a single list entry on the correct (staged vs unstaged) side.
const openChangeEntry = async (entry: FileChange): Promise<void> => {
    if (!entry.staged) {
        // Working-tree (unstaged) diff: git.openChange opens this side correctly.
        await vscode.commands.executeCommand("git.openChange", entry.uri);
        return;
    }
    // Staged (index) diff: open HEAD-vs-index explicitly so it works even for a partially-staged file
    // (where git.openChange would otherwise show the working-tree diff). preview:true mirrors single-click
    // SCM behavior so the existing preview-tab handling keeps working. A newly-added file has no HEAD blob;
    // the git content provider returns empty for that side, so the diff shows it as fully added — same as
    // the Source Control view. The git-scheme modified side also makes getActiveChange detect this as
    // staged, so subsequent next/previous navigation stays anchored to the correct list entry.
    const left = toGitUri(entry.uri, "HEAD");
    const right = toGitUri(entry.uri, "");
    const title = `${entry.uri.path.split("/").pop()} (Index)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
};

const openFirstFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("go-to-next-change").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    if (fileChanges.length === 0) {
        return;
    }

    await openChangeEntry(fileChanges[0]);
};

const openLastFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("go-to-next-change").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    if (fileChanges.length === 0) {
        return;
    }

    await openChangeEntry(fileChanges[fileChanges.length - 1]);
};

const openNextFile = async () => {
    const fileChanges = await getFileChanges();

    const active = await getActiveChange();
    if (!active) {
        return;
    }

    const currentIndex = findCurrentIndex(fileChanges, active);

    // At the end of the list (or list empty) -> nothing more to show, close the diff editor.
    // (currentIndex === -1, i.e. active file not in the list, falls through and opens the first entry,
    // matching the original behavior.)
    if (currentIndex === fileChanges.length - 1) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[currentIndex + 1]);
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return;
    }

    const currentIndex = findCurrentIndex(fileChanges, active);

    // At the start of the list (currentIndex === 0) or active file not found (-1) -> close the editor.
    if (currentIndex <= 0) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[currentIndex - 1]);
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
};

const getNextFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return null;
    }

    const currentIndex = findCurrentIndex(fileChanges, active);

    if (currentIndex === fileChanges.length - 1) {
        return null;
    }

    const nextFile = fileChanges[currentIndex + 1]; // currentIndex === -1 -> previews the first entry
    return nextFile ? nextFile.uri.path : null;
};

const getPreviousFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return null;
    }

    const currentIndex = findCurrentIndex(fileChanges, active);

    if (currentIndex <= 0) {
        return null;
    }

    const previousFile = fileChanges[currentIndex - 1];
    return previousFile ? previousFile.uri.path : null;
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

    const currentUri = await getActiveFileUri();
    if (!currentUri) {
        return;
    }

    // Resolve the repository from the CURRENT file (not just the first workspace folder) so a multi-root
    // workspace stages against the right repo and computes the next file from the right state.
    const activeRepo = git.getRepository(currentUri) || git.repositories[0];
    if (!activeRepo) {
        return;
    }

    const currentNormalized = currentUri.path.slice(1).replace(/\\/g, "/").toLowerCase();
    const pathMatches = (uri: vscode.Uri) => uri.path.toLowerCase().endsWith(currentNormalized);

    // SAFETY GUARD: only act if the active file is actually a change (staged, unstaged, or untracked).
    // Without this, an accidental shift+alt+z while editing a clean/unrelated file would run git add as a
    // no-op and then close that editor — a nasty surprise. Untracked is included so staging a brand-new
    // file still works; navigation below stays within tracked unstaged files (see note).
    const untrackedChanges = activeRepo.state.untrackedChanges ?? [];
    const isChangedFile =
        activeRepo.state.indexChanges.some((file: any) => pathMatches(file.uri)) ||
        activeRepo.state.workingTreeChanges.some((file: any) => pathMatches(file.uri)) ||
        untrackedChanges.some((file: any) => pathMatches(file.uri));
    if (!isChangedFile) {
        return;
    }

    // Work out the next unstaged file BEFORE staging. activeRepo.state updates asynchronously after a
    // stage, so reading the list afterwards would see a stale snapshot (current file still present) or
    // shifted indices. Capturing the target up-front makes where-we-land deterministic. We only look at
    // workingTreeChanges (the tracked unstaged group). NOTE: untracked/new files (status === 7) are
    // excluded from the "next" target on purpose — git.openChange can't open a diff for them, so they
    // aren't part of this extension's navigation model (consistent with alt+z). Staging the CURRENT file
    // still works even when it's untracked.
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");
    const workingTreeChanges = activeRepo.state.workingTreeChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => file.uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);

    const currentIndex = workingTreeChanges.findIndex(pathMatches);
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
