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

    // OVERLAY (supported API, no patching): badge the file currently open as a diff with a "▶" marker via a
    // FileDecorationProvider. The badge renders on the row in the built-in Source Control panel (and the
    // Explorer/tabs), giving a "you are here" indicator on the real Git rows. Caveat: decorations key on the
    // file URI, so a partially-staged (dual-state) file gets the badge on BOTH its staged and unstaged rows.
    const reviewDecoEmitter = new vscode.EventEmitter<vscode.Uri[]>();
    let currentReviewUri: vscode.Uri | undefined; // file: URI of the file currently shown as a diff
    const reviewDecorationProvider: vscode.FileDecorationProvider = {
        onDidChangeFileDecorations: reviewDecoEmitter.event,
        provideFileDecoration(uri) {
            if (currentReviewUri && uri.path.toLowerCase() === currentReviewUri.path.toLowerCase()) {
                // Badge text is configurable (default a colorful emoji for maximum visibility). The Source
                // Control panel ignores decoration `color` (its renderer forces colors:false), so the emoji's
                // own color is what makes it pop there; the `color` still applies in the Explorer + editor tabs.
                const badgeSetting = vscode.workspace.getConfiguration("go-to-next-change").get<string>("currentFileBadge", "🔴");
                if (!badgeSetting) {
                    return undefined; // empty setting => badge disabled
                }
                // VS Code caps the badge at 2 GRAPHEMES and drops the whole decoration if it's longer, so take
                // the first two graphemes. Intl.Segmenter keeps multi-codepoint emoji intact — a naive
                // slice(0,2) would cut a two-emoji badge like "🔥🔥" down to one (each emoji is 2 UTF-16 units).
                let badge = badgeSetting;
                try {
                    // (Intl as any): Intl.Segmenter may not be in the project's TS lib types, but it exists at runtime.
                    const seg = new (Intl as any).Segmenter(undefined, { granularity: "grapheme" });
                    badge = [...seg.segment(badgeSetting)].slice(0, 2).map((s: any) => s.segment).join("");
                } catch {
                    badge = Array.from(badgeSetting).slice(0, 2).join(""); // fallback by code point if Segmenter is unavailable
                }
                return { badge, tooltip: "Go to next change: reviewing this file", color: new vscode.ThemeColor("charts.blue"), propagate: false };
            }
            return undefined;
        },
    };
    // Recompute the current review file whenever the active editor/tab changes, and refresh the decoration
    // for both the old and new file so the badge moves with you.
    const refreshReviewDecoration = () => {
        const prev = currentReviewUri;
        currentReviewUri = currentReviewFileUri();
        const changed: vscode.Uri[] = [];
        if (prev) {
            changed.push(prev);
        }
        if (currentReviewUri && (!prev || prev.path.toLowerCase() !== currentReviewUri.path.toLowerCase())) {
            changed.push(currentReviewUri);
        }
        if (changed.length > 0) {
            reviewDecoEmitter.fire(changed);
        }
    };

    context.subscriptions.push(
        disposable, disposable2, disposable3, disposable4, disposable5, disposable6,
        reviewDecoEmitter,
        vscode.window.registerFileDecorationProvider(reviewDecorationProvider),
        vscode.window.tabGroups.onDidChangeTabs(() => refreshReviewDecoration()),
        vscode.window.onDidChangeActiveTextEditor(() => refreshReviewDecoration())
    );
}

// Returns the on-disk file: URI of the diff currently open in the active tab (resolving a staged diff's
// `git:` modified side back to the file path), or undefined when the active tab isn't a diff.
// True if the uri is a current change (staged, unstaged, or untracked) in its repo. Used to decide whether to
// badge a PLAIN-file editor tab: untracked/new files open as a plain file (git.openChange resolves to
// vscode.open, NOT vscode.diff, because an untracked file has no original side to diff against), so the badge
// must recognize them — but ONLY when they're an actual change, so it doesn't follow every random file you open.
const isChangeFileUri = (uri: vscode.Uri): boolean => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        if (!repo) {
            return false;
        }
        const p = uri.path.toLowerCase();
        const inAny = (changes: any[]) => (changes ?? []).some((c: any) => c.uri.path.toLowerCase() === p);
        return inAny(repo.state.indexChanges) || inAny(repo.state.workingTreeChanges) || inAny(repo.state.untrackedChanges);
    } catch {
        return false; // git extension not ready / API shape changed — just don't badge
    }
};

// Resolves any diff-side / editor uri to the underlying on-disk file: uri. Handles git: uris (the real path
// is in the JSON query — staged/HEAD/index sides), plain file: uris, and any other scheme (fall back to the
// uri's own .path). Returns undefined only for a genuinely empty/absent side. This is the GENERAL resolver
// that lets the badge work for every change type without special-casing each git status.
const toFilePathUri = (uri: vscode.Uri | undefined): vscode.Uri | undefined => {
    if (!uri) {
        return undefined;
    }
    if (uri.scheme === "file") {
        return uri;
    }
    if (uri.scheme === "git") {
        try {
            const q = JSON.parse(uri.query); // git uri query carries {"path":"/abs/path","ref":...}
            if (q?.path) {
                return vscode.Uri.file(q.path);
            }
        } catch {
            // malformed/empty query — fall through to the uri's own path
        }
    }
    return uri.path ? vscode.Uri.file(uri.path) : undefined;
};

const currentReviewFileUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
        // Resolve the file path from EITHER side of the diff. A DELETED file has no working (modified) side so
        // its path is on the original (HEAD) side; an ADDED file has no original; a MODIFIED file has both.
        // Trying modified-then-original covers modify / add / delete / rename / staged variants generally,
        // instead of special-casing each git status. (Bug: the badge didn't follow deleted files.)
        return toFilePathUri(input.modified) ?? toFilePathUri(input.original);
    }
    // Untracked/new files open as a PLAIN file editor (vscode.open), not a diff. Badge them too — but only
    // when the file is actually a change, so the badge doesn't follow every ordinary file you open.
    if (input instanceof vscode.TabInputText && input.uri.scheme === "file" && isChangeFileUri(input.uri)) {
        return input.uri;
    }
    return undefined;
};

// Matches VS Code's compareFileNames (src/vs/base/common/comparers.ts): a numeric, case-insensitive
// collator, so the navigation order is IDENTICAL to what the Source Control view shows for file names.
// BUG FIX: the comparators below previously compared the final filename segment with a naive `a < b`,
// which diverges from VS Code for numbered files (e.g. item-2 vs item-10, v2 vs v10) and some
// punctuation. That made "go to next change" jump to a file that wasn't the visually-next row in the
// panel (only "sometimes" — exactly when the naive order disagreed with the collator order).
const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compareFileNames = (a: string, b: string): number => {
    const result = fileNameCollator.compare(a, b);
    if (result === 0 && a !== b) {
        return a < b ? -1 : 1; // numeric collator treats "foo1"/"foo01" as equal — disambiguate for a stable order
    }
    return result;
};

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

        // Both paths are at their FINAL segment -> compare file names with the numeric collator (matches
        // VS Code's comparePaths, which uses compareFileNames here). This is the fix for the wrong-jump bug.
        if (i === filenameA.length - 1 && i === filenameB.length - 1) {
            return compareFileNames(partA, partB);
        }

        // Both paths are still inside differing DIRECTORY segments -> VS Code compares these naively
        // (comparePathComponents), so a plain lexicographic compare is correct here.
        if (i < filenameA.length - 1 && i < filenameB.length - 1) {
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

    return 0;
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

        // Both paths at their FINAL segment -> compare file names with the numeric collator (matches VS
        // Code's tree-view sort, which uses compareFileNames on the node name). Fixes the wrong-jump bug.
        if (i === filenameA.length - 1 && i === filenameB.length - 1) {
            return compareFileNames(partA, partB);
        }

        // Differing DIRECTORY segments -> naive lexicographic compare (matches VS Code).
        if (i < filenameA.length - 1 && i < filenameB.length - 1) {
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

    return 0;
};

// One navigable entry in the changes list. `staged` distinguishes the index (Staged Changes) copy from
// the working-tree (Changes) copy of the same file. They are SEPARATE diffs, and a partially-staged file
// legitimately appears as BOTH — exactly like the Source Control view shows it.
interface FileChange {
    uri: vscode.Uri;
    staged: boolean;
}

// Unstaged file uris for a repo = tracked working-tree changes PLUS untracked (new) files, deduped by path
// and sorted to match the Source Control "Changes" group (VS Code's default "mixed" mode shows untracked
// there). The git API keeps untracked files (Status.UNTRACKED = 7) in state.untrackedChanges; depending on
// the git.untrackedChanges setting they can also appear in workingTreeChanges — so we read BOTH and dedupe by
// path. IGNORED files (status 8) are dropped. git.openChange opens an untracked file as a diff against an
// empty original (same as clicking its row), so untracked files navigate like any other entry.
// BUG FIX: the old code filtered untracked out everywhere (status !== 7), so a brand-new file was never
// navigated to or advanced to by shift+alt+z — it "wasn't even considered". New files are first-class now.
const getUnstagedUris = (repo: any, isTreeView: boolean): vscode.Uri[] => {
    const working: any[] = repo.state.workingTreeChanges ?? [];
    const untracked: any[] = repo.state.untrackedChanges ?? [];
    const byPath = new Map<string, vscode.Uri>();
    for (const change of [...working, ...untracked]) {
        if (change.status === 8) {
            continue; // skip IGNORED files (Status.IGNORED) — they're not real changes to review
        }
        byPath.set(change.uri.path.toLowerCase(), change.uri); // dedupe: a file can appear in both groups
    }
    return [...byPath.values()].sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);
};

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

    // Unstaged group = tracked working-tree changes PLUS untracked (new) files (see getUnstagedUris), tagged
    // unstaged. Untracked files used to be filtered out here, so they were skipped by navigation entirely.
    const workingTreeChanges: FileChange[] = getUnstagedUris(activeRepo, !!isTreeView).map((uri) => ({ uri, staged: false }));

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

    const firstPath = fileChanges.findIndex(pathMatches);
    if (firstPath === -1) {
        return -1; // active file isn't a known change at all
    }

    // AMBIGUITY GUARD (fixes an intermittent "previous jumps to the last change" bug): when the side is
    // UNKNOWN (the active tab wasn't a readable diff so getActiveChange fell back to staged=null) AND the
    // file appears in BOTH the staged and unstaged groups (a dual-state file), a path-only match would just
    // guess the first (staged) copy. Returning that uncertain index let the new looping fling navigation to
    // the wrong end of the list. Return -1 instead so callers bail and do nothing; the next press (once the
    // diff tab is readable and the side is known) navigates correctly.
    if (active.staged === null && fileChanges.filter(pathMatches).length > 1) {
        return -1;
    }
    return firstPath;
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
        // Working-tree (unstaged) diff — git.openChange opens this side correctly, including untracked/new
        // files (it shows them as a diff against an empty original, the same as clicking the row). Defensive
        // fallback: if a diff genuinely can't be produced, open the file itself so the command never no-ops.
        try {
            await vscode.commands.executeCommand("git.openChange", entry.uri);
        } catch {
            await vscode.window.showTextDocument(entry.uri, { preview: true });
        }
        return;
    }
    // OPT-IN WORKAROUND (go-to-next-change.revealStagedInSourceControl): highlight the staged file in the
    // Source Control view. VS Code's built-in `scm.autoReveal` can't do this for staged files because the
    // staged diff opens with a `git:` uri and autoReveal only matches sidebar rows by their `file:` path
    // (there is NO extension API to select an SCM row directly). Trick: briefly make the plain file the
    // active editor — autoReveal then finds it (a staged-only file's file: uri lives only in the index
    // group) and selects/reveals its row — then we open the staged diff over it. autoReveal never CLEARS a
    // selection on a no-match, so the staged row stays highlighted while the diff is shown. Caveats, which
    // is why this is off by default: a brief flash of the file before the diff, and for a partially-staged
    // (dual-state) file autoReveal picks the working-tree row instead (it scans groups back-to-front).
    const revealStaged = vscode.workspace.getConfiguration("go-to-next-change").get("revealStagedInSourceControl");
    if (revealStaged) {
        try {
            await vscode.window.showTextDocument(entry.uri, { preview: true }); // fires autoReveal -> selects the staged row
        } catch {
            // File can't be opened (e.g. a staged deletion) — skip the reveal, still show the diff below.
        }
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

    if (fileChanges.length === 0) {
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        // Couldn't reliably locate the active file (e.g. its diff side wasn't readable for a dual-state
        // file). Bail rather than guess — guessing turned into a jump to the wrong file. A re-press works.
        return;
    }

    // LOOP: wrap to the first file when at the end (one press loops back to the start), instead of closing
    // the editor. At the last index, (len-1 + 1) % len = 0 -> first file.
    const nextIndex = (currentIndex + 1) % fileChanges.length;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[nextIndex]);
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return;
    }

    if (fileChanges.length === 0) {
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        // BUG FIX (intermittent "previous jumps to the last staged change"): the old code did
        // `currentIndex <= 0 ? last : currentIndex - 1`, which treated "not found" (-1) the SAME as "at the
        // first file" (0) and wrapped to the LAST file. When the diff side wasn't readable for a dual-state
        // file, findCurrentIndex returned -1 and "previous" lurched to the last change. Now we bail on -1;
        // the next press (once the diff tab is readable) navigates correctly. Genuine index 0 still loops.
        return;
    }

    // LOOP: wrap to the last file only when genuinely at the first file (index 0).
    const prevIndex = currentIndex === 0 ? fileChanges.length - 1 : currentIndex - 1;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[prevIndex]);
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
};

const getNextFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return null;
    }

    if (fileChanges.length === 0) {
        return null;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        return null; // can't locate current file -> no reliable "next" to show in the confirm prompt
    }
    const nextFile = fileChanges[(currentIndex + 1) % fileChanges.length]; // loops to the first at the end
    return nextFile ? nextFile.uri.path : null;
};

const getPreviousFileName = async (): Promise<string | null> => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return null;
    }

    if (fileChanges.length === 0) {
        return null;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        return null; // can't locate current file -> no reliable "previous" to show in the confirm prompt
    }
    const previousFile = fileChanges[currentIndex === 0 ? fileChanges.length - 1 : currentIndex - 1]; // loops to the last at the start
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

    // If the active diff is the STAGED side of a file, there's nothing to stage — do nothing (don't jump
    // to an unstaged file). This command is for working through UNSTAGED files; on a staged file it no-ops.
    const activeSide = await getActiveChange();
    if (activeSide?.staged === true) {
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
    // shifted indices. Capturing the target up-front makes where-we-land deterministic. The unstaged list
    // now INCLUDES untracked/new files (see getUnstagedUris) so stage-and-advance lands on a brand-new file
    // too — git.openChange opens them as a diff vs an empty original, so they're navigable like any other.
    const isTreeView = vscode.workspace.getConfiguration("go-to-next-change").get("treeView");
    const workingTreeChanges = getUnstagedUris(activeRepo, !!isTreeView);

    const currentIndex = workingTreeChanges.findIndex(pathMatches);
    // Where to land after staging. Current file is in the unstaged list -> the one AFTER it; but if it's the
    // LAST unstaged file (no "next"), fall back to the PREVIOUS unstaged file so we don't leave you on
    // nothing. The ?? handles the last-file case; for the only-file case currentIndex-1 is -1 which returns
    // undefined (-> close below). Not in the list (e.g. we were on an already-staged file) -> first unstaged.
    const targetUnstagedFile = currentIndex === -1
        ? workingTreeChanges[0]
        : (workingTreeChanges[currentIndex + 1] ?? workingTreeChanges[currentIndex - 1]);

    // Stage the whole current file — equivalent to clicking the + next to it in the Source Control view.
    await activeRepo.add([currentUri.fsPath]);

    if (!targetUnstagedFile) {
        // Current was the ONLY unstaged file (no next and no previous) — nothing left to review, so close.
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    // Mirror openNextFile's editor handling: replace a pinned (non-preview) editor, keep a preview tab.
    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await vscode.commands.executeCommand("git.openChange", targetUnstagedFile);
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
    // PREFER the active TAB's diff (the same source getActiveChange + the badge use) over
    // vscode.window.activeTextEditor. Clicking a row in the Source Control panel makes its diff the active
    // TAB but leaves keyboard focus on the panel — so activeTextEditor stays undefined or stale (the
    // previously focused editor) and never registers the click. The tab-based lookup reflects the file you
    // actually clicked, keeping stage-and-advance in sync with it. BUG this fixes: click an unstaged file
    // then press shift+alt+z and it jumped to the FIRST unstaged file instead of the one after the click —
    // because getActiveFileUri read activeTextEditor, so the clicked file wasn't found in the list (-1 ->
    // workingTreeChanges[0] top fallback). currentReviewFileUri already resolves a staged git: side to its
    // on-disk file: path, so this also handles a clicked staged row.
    const fromTab = currentReviewFileUri();
    if (fromTab) {
        return fromTab;
    }

    // Fallback: a plain (non-diff) text editor that genuinely has focus.
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
