// Better Git's activation and command wiring: keyboard/mouse review share exact staging, Undo and navigation.
// Preserve the owning decision comments; docs/regression-contracts.md maps Ethan's historical bug reports
// and later corrections to these code paths and their focused tests.
import { MacScmReviewLookahead } from "./macScmReviewLookahead";
import { ReviewDocumentWarmup } from "./gitReviewWarmup";
import { parseWandReviewUri } from "./wandReviewUri";
import * as vscode from "vscode";
// fs + path are only used by resolveWorktreeRootUri's FALLBACK path (the filesystem `.git` walk used when the
// git extension API can't tell us which worktree owns a file). Node built-ins are available in the extension
// host — safe to import at top level.
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { resolveWorkbenchFilePath } from "./workbenchFilePath";
import { reviewDiffIsStaged } from "./gitReviewDiff";
import { ReviewFilePosition, ReviewFilePositions } from "./reviewFilePositions";
import { createReviewHostCapability } from "./reviewHostCapability";
import { performance } from "perf_hooks";
import { createWorktreeLink, parseWorktreeLink, worktreeLinkReturnApp } from "./gitWorktreeLink";
import { returnToApp, frontmostAppBundleId } from "./gitWorktreeFocus";
import { WorktreeUsage } from "./gitWorktreeUsage";
import { DeferredWorktreePresentation, WORKTREE_PRESENTATION_MAX_AGE_MS, WORKTREE_TREE_SETTLE_MS } from "./gitWorktreePresentation";
import { repositoriesInScmRegistrationOrder } from "./gitScmDiscoveryOrder";
import { CommitMessageGenerator } from "./codexCommitMessage";
import { GitStatus } from "./gitStatus";
import { StageTransactionStore, StageUndoView, StoredStageTransaction } from "./stageTransactionStore";
import { StageTransactionObserver } from "./stageTransactionObserver";
import { stageWithDeferredReceipt } from "./stageTransactionExecution";
import { StageTransactionHistoryLog } from "./stageTransactionHistoryLog";
import { readIndexSnapshot, readStageTransactionPaths, restoreStageTransaction } from "./gitStageUndo";
import { extractFileDiffSection } from "./gitDiffSection";
import { isTransientGitIndexLockError, runWithTransientGitIndexRetry } from "./gitIndexRetry";
import {
    createMouseStageSelection,
    MouseStageSelection,
    mouseStagePreviewIndex,
    moveMouseStageSelection,
    planMouseStagePreviewBoundary,
    selectedMouseStageItems,
} from "./mouseStageSelection";
import { MouseHoldChordState, registerMouseShortRelease, resolveAdjacentMouseChord } from "./mouseHoldChord";
import { KeyboardStageRepeatGuard, parseKeyboardStageArgs } from "./keyboardStageRepeatGuard";
import { KeyboardReviewGesture, KeyboardReviewMode, ReviewKeyState } from "./keyboardReviewGesture";
import { KeyboardNavigationRepeat } from "./keyboardNavigationRepeat";
import { MacReviewKeyMonitor } from "./macReviewKeyMonitor";
import {
    decideKeyboardReviewBegin,
    decideKeyboardReviewStep,
    KEYBOARD_REVIEW_CONTEXT_KEY,
    KeyboardReviewContext,
    keyboardReviewEndsWithFeedbackClear,
    liveKeyboardReview,
    parseKeyboardReviewDirection,
    routeChangeNavigation,
} from "./keyboardReviewSession";
import { MacKeyReleaseMonitor } from "./macKeyReleaseMonitor";
import { registerAgentFlowSelectionBridge } from "./agentFlowSelectionBridge";
import { registerDiffViewDisplay } from "./diffViewDisplay";
import { registerStagedLfsImageProvider, resolveStagedLfsImage } from "./stagedLfsImage";

let confirmOpenedReview: (uri: vscode.Uri, staged: boolean) => void = () => undefined;
let requestNavigationScmLookahead: () => void = () => undefined;
let pendingWorktreePresentation: DeferredWorktreePresentation | undefined;
let worktreeUsage: WorktreeUsage | undefined;
const reviewFilePositions = new ReviewFilePositions();
let trackedPositionTab: vscode.Tab | undefined;
let trackedPositionInput: unknown;
let trackedPositionEditor: vscode.TextEditor | undefined;
let trackedPositionUri: string | undefined;
let restoredPositionTab: vscode.Tab | undefined;
let applyingReviewPosition = false;
let pendingReviewPosition: { tab: vscode.Tab; editor: vscode.TextEditor; view: ReviewFilePosition } | undefined;
// A forward file boundary starts a new review of its destination (Ethan, 2026-11-03).
// Suppress only that destination's restore while opening/landing; ordinary clicks, Previous and Undo
// still resume their own saved views. A timed suppression would race slow editors and later user input.
const startingReviewFiles = new Map<string, number>();
// VS Code's native next/previousChange wraps inside the file (last change -> first) before Better Git can see
// that the press is a file boundary. While that press leaves the file, remember where Ethan actually was.
let departingReviewPosition: ReviewFilePosition | undefined;

// NOTE: the old `isNavigationPromptOpen` guard + the getNextFileName/getPreviousFileName helpers were
// removed in v1.0.2 along with the cross-file confirmation prompt — the tool now ALWAYS jumps silently.

// ──────────────────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGING — "Better Git" OutputChannel (v1.2.10)
//
// WHY this exists: the tall-hunk stepping logic (stepTallHunk) makes a live caret/viewport decision on every
// next/previous-change press, and when it gets it wrong (e.g. the v1.2.9 stuck-near-the-bottom-of-a-tall-hunk
// bug) there was NO way to see WHY without re-deriving the geometry by hand from screenshots. This channel logs
// every step decision — direction, viewport height, hunk extent, top/bottom visible lines, caret, computed
// target, and the DECISION taken — so the NEXT stuck case is diagnosable instantly instead of
// guessed. Open it via View → Output → pick "Better Git" from the dropdown.
//
// Gated behind the `better-git-vscode.debugLogging` setting (default false) so it's silent for normal use and
// only writes when Ethan flips it on to diagnose something. The channel itself is created lazily on first log
// (so we don't allocate an Output channel for users who never enable logging) and reused thereafter.
let betterGitOutputChannel: vscode.LogOutputChannel | undefined;

// True only when the user has turned on verbose logging. Read live (not cached) so toggling the setting takes
// effect on the very next press without a reload.
const debugLoggingEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("debugLogging", false);

const debugNotificationsEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("debugNotifications", false);

const appendDebugLog = (tag: string, message: string): void => {
    if (!betterGitOutputChannel) {
        // A log output channel is persisted with the VS Code window logs, so a physical gesture can be
        // diagnosed after the toast has disappeared instead of relying on screenshots or memory.
        betterGitOutputChannel = vscode.window.createOutputChannel("Better Git", { log: true });
    }
    betterGitOutputChannel.info(`[${tag}] ${message}`);
};

// Append one timestamped line to the "Better Git" output channel, but ONLY when debug logging is enabled.
// Lazily creates the channel on first use. Never throws (logging must never break navigation) — a failure to
// log is swallowed. Pass a short tag (e.g. "tall-hunk") + the human-readable message.
const debugLog = (tag: string, message: string): void => {
    try {
        if (!debugLoggingEnabled()) {
            return;
        }
        appendDebugLog(tag, message);
    } catch {
        // logging is best-effort telemetry — never let it interfere with the actual command
    }
};

const mouseDebugTrace: string[] = [];
const mouseDebug = (message: string): void => {
    try {
        if (!debugLoggingEnabled() && !debugNotificationsEnabled()) { return; }
        mouseDebugTrace.push(message);
        if (mouseDebugTrace.length > 100) { mouseDebugTrace.splice(0, mouseDebugTrace.length - 100); }
        appendDebugLog("mouse-hold", message);
        if (debugNotificationsEnabled()) {
            // Never await a diagnostic toast: dismissing it must not gate navigation, staging or cancellation.
            void vscode.window.showInformationMessage(`Better Git debug: ${message}`);
        }
    } catch {
        // Debug presentation cannot participate in the input path.
    }
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// LAST NAVIGATION DIRECTION (v1.2.7 — mouse-only stage-and-advance)
//
// WHY this exists (Ethan's exact problem): he wants to run the WHOLE review-and-stage flow with just the
// mouse. He clicks the editor-title "+" button to stage the current file, but then has to grab the
// keyboard to jump to the next change. The fix: make the "+" button stage AND advance — calling the EXACT
// same logic as the keyboard Shift+Alt+. / Shift+Alt+, (stageCurrentFileAndAdvance) — in whatever direction
// he was last navigating. So we remember the direction of his most recent "jump".
//
// WHICH commands count as "the last jump": his primary change-navigation keys — next/previous-scm-change
// (Alt+. / Alt+, on QWERTY, the headline > / < review keys) — plus the changed-FILE nav
// (next/previous-changed-file) and the stage-and-next/previous commands themselves. Rationale: from Ethan's
// POV "the last jump" is any deliberate forward-vs-backward move through the changeset, whether it stepped
// by hunk or by whole file; folding all of them in means the "+" button always advances the way he's
// currently working (top-to-bottom vs bottom-to-top) regardless of which nav key he last pressed. We do NOT
// track the smart mouse buttons here — their in-diff direction is intentionally FLIPPED (see smartNavigate)
// so their raw "forward"/"back" label doesn't map cleanly to review direction, and mixing them in would
// make the "+" advance the wrong way.
//
// Module-level (not inside activate) so both the nav command handlers and the new
// stage-current-file-and-advance command can read/write it. Defaults to "next" — a fresh session with no
// nav yet advances forward (top-to-bottom), which is the overwhelmingly common review order.
let lastNavDirection: "next" | "previous" = "next";

// Installed by activate() and called after Better Git navigation settles. Keeping the hook module-level lets
// the navigation functions stay independent of VS Code decoration lifetime while the active extension instance
// owns the actual decoration type, refresh coalescing and disposal.
let requestCurrentHunkOverviewMarkerRefresh: () => void = () => undefined;

type PointerReviewSource = "corsair" | "razer" | "wand";
// "keyboard" is Ethan's keyboard eyes mode (keyboard review, see keyboardReviewSession.ts). It shares these
// review-hold maps, selection, release transaction and Undo, but public mouse commands and URIs never accept it.
type MouseReviewSource = PointerReviewSource | "keyboard";
// `stageReadyRequested` is set synchronously when F20 arrives, before its queued Git/editor work. The adjacent
// F16 chord uses this input-order fact to distinguish a quick Undo chord from a ready-hold cancel even if
// navigation is busy. See mouseHoldChord.ts for the shared decision rule.
type MouseHoldRequest = MouseHoldChordState & {
    releaseQueued?: boolean;
    excludePreviewOnRelease?: boolean;
    wandReviewMode?: "changes" | "files";
    // The direction a keyboard review began with; its finish uses the same exact release checks as a mouse.
    keyboardReviewDirection?: "next" | "previous";
    keyboardReviewMode?: KeyboardReviewMode;
    keyboardExcludePreview?: boolean;
};
type ActiveMouseStageSelection = MouseStageSelection<FileChange> & { request?: MouseHoldRequest };
type MouseReviewView = {
    input: unknown;
    preview: boolean;
    column: vscode.ViewColumn;
    editors: { uri: string; selections: readonly vscode.Selection[]; top?: vscode.Position }[];
};
const mouseHoldRequests = new Map<MouseReviewSource, MouseHoldRequest>();
let latestMouseHoldRequest: MouseHoldRequest | undefined;
let clearStageHoldFeedbackRequest: (source?: MouseReviewSource) => void = () => undefined;
let prepareStageHoldReleaseRequest: (source: MouseReviewSource, request: MouseHoldRequest) => void = () => undefined;
let setStagePreviewModeRequest: (source: MouseReviewSource, enabled: boolean) => void = () => undefined;
let adjustStageHoldSelectionRequest: (
    source: MouseReviewSource, direction: "up" | "down"
) => Promise<void> = async () => undefined;
let navigateStageHoldPreviewRequest: (
    source: MouseReviewSource, direction: "next" | "previous",
    // Keyboard review only: run in place of an ignored step so the press is kept as ordinary navigation.
    inactive?: (check: NavigationCheckpoint) => Promise<void>
) => Promise<void> = async () => undefined;
let takeStageHoldSelectionRequest: (
    source: MouseReviewSource, request: MouseHoldRequest
) => { readonly changes: readonly FileChange[]; readonly lastStaged: vscode.Uri | undefined } | undefined = () => undefined;
const mouseNavigationOrigins = new Map<MouseReviewSource, {
    change: FileChange;
    direction: "next" | "previous";
    requestedAt: number;
    held?: boolean;
    holdRequest?: MouseHoldRequest;
    view?: MouseReviewView;
    navigateOnButtonDown: boolean;
}>(); // A late stage press belongs to the file left by this mouse, never the newly displayed file. (Codex task: 01a039f7-873c-7c30-b3dc-af8a6724ace5)
// Public mouse/wand commands and URIs validate with this; it deliberately excludes the internal keyboard source.
const isMouseReviewSource = (source: unknown): source is PointerReviewSource => source === "corsair" || source === "razer" || source === "wand";
const isReviewHoldSource = (source: unknown): source is MouseReviewSource => isMouseReviewSource(source) || source === "keyboard";
const mouseSourceLabel = (source: MouseReviewSource): string => source === "keyboard" ? "Keyboard"
    : source === "wand" ? "Magic Wand" : source === "corsair" ? "Corsair" : "Razer";
const mouseDirectionLabel = (direction: "next" | "previous"): string => direction === "next" ? "Next" : "Previous";

// KEYBOARD REVIEW STATE (Ethan's keyboard eyes mode). The session itself is the "keyboard" entry in the hold
// maps above; these helpers read it, end it without staging and mirror it into a context key for keybindings.
let publishKeyboardReviewContext: (active: boolean) => void = () => undefined;
const keyboardReviewHolds = () => ({ keyboard: mouseHoldRequests.get("keyboard"), latest: latestMouseHoldRequest });
const syncKeyboardReviewContext = (): void => publishKeyboardReviewContext(liveKeyboardReview(keyboardReviewHolds()) !== undefined);
// Retire a still-active, unreleased keyboard request so later keyboard presses navigate normally. Nothing is
// staged and no view is restored; callers clear its feedback. An inactive request belongs to a queued finish or
// cancel, which keeps its origin. `expected` stops an old press from retiring a newer review.
const retireKeyboardReviewRequest = (reason: string, expected?: MouseHoldRequest): boolean => {
    const request = mouseHoldRequests.get("keyboard");
    if (!request?.active || request.releaseQueued || (expected && request !== expected)) { return false; }
    request.active = false;
    mouseHoldRequests.delete("keyboard");
    if (mouseNavigationOrigins.get("keyboard")?.holdRequest === request) { mouseNavigationOrigins.delete("keyboard"); }
    if (latestMouseHoldRequest === request) { latestMouseHoldRequest = undefined; }
    mouseDebug(`Keyboard review ended without staging: ${reason}.`);
    return true;
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// KEYBOARD HELD-KEY REPEAT GUARD (stage-and-next / stage-and-previous shortcuts)
//
// Holding Shift+Option+X/Z (or < / >, and the same physical keys under Dvorak) made VS Code re-dispatch the
// stage-and-advance keybinding on every OS auto-repeat, staging one file per repeat. The manifest tags only
// those keyboard bindings with `{ source: "keyboard", physicalKey }`; the guard admits the first press of a
// physical hold and suppresses every further tagged invocation until the key is released (exact macOS
// key-state monitor) or, if that signal is unavailable, until a bounded quiet period passes. Untagged calls —
// the F18/F19 mouse user bindings, the command palette, the status-bar and editor-title buttons — never reach
// the guard, so rapid separate mouse presses keep their existing no-debounce behaviour.
let keyboardStageRepeatGuard: KeyboardStageRepeatGuard | undefined;
const admitStageAndAdvancePress = (args: unknown): boolean => {
    const physicalKey = parseKeyboardStageArgs(args);
    if (!physicalKey) { return true; }
    return keyboardStageRepeatGuard?.admit(physicalKey) ?? true;
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// LAST-STAGED STATUS BAR (v1.1.0)
//
// WHY this exists (Ethan's exact problem): he reviews AI-generated changesets file-by-file from the
// keyboard. stage-and-next-changed-file (shift+alt+. on QWERTY, shift+alt+v in Dvorak mode) stages the current file and IMMEDIATELY jumps
// to the next one. He keeps "accidentally staging a file without noticing" — he wasn't looking, or it
// advanced instantly — and then has no record of what just got staged. This persistent bottom-bar
// indicator shows the LAST file staged via the extension so he can "go back and remember" what was
// staged and undo it if it was a mistake.
//
// These are MODULE-LEVEL (not inside activate) so the staging helpers below — which are module-scope
// arrow functions, not closures over activate — can update them, and so the click-command can read the
// stored URI. The StatusBarItem itself is created in activate() and pushed to context.subscriptions for
// clean disposal; we keep a module reference so recordLastStaged() can mutate it from anywhere.
let lastStagedStatusBarItem: vscode.StatusBarItem | undefined; // the bottom-bar item; undefined before activate()
let lastStagedUri: vscode.Uri | undefined; // file: URI of the most recent file staged THROUGH this extension
let stageTransactionStore: StageTransactionStore | undefined;
let stageTransactionObserver: StageTransactionObserver | undefined;
let stageHistoryLog: StageTransactionHistoryLog | undefined;
let stageUndoQueue: Promise<void> = Promise.resolve();
let stageAttemptSequence = 0;
// Git's getRepository(Uri) sorts its own repository array in place by path
// length. SCM's discovery order does not change: retain the open-event order.
const repositoryDiscoveryOrder = new Map<string, number>();
let nextRepositoryDiscoveryOrder = 0;
const startIndexTransitionObservation = async (context: vscode.ExtensionContext): Promise<void> => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git");
    if (!gitExtension || !stageTransactionObserver) {
        return;
    }
    await gitExtension.activate();
    const git = gitExtension.exports?.getAPI(1);
    if (!git) {
        return;
    }

    const attachedRoots = new Set<string>();
    const attach = (repo: any): void => {
        const uri = repo?.rootUri?.toString();
        if (uri && !repositoryDiscoveryOrder.has(uri)) {
            repositoryDiscoveryOrder.set(uri, nextRepositoryDiscoveryOrder++);
        }
        const repoRoot = String(repo?.rootUri?.fsPath ?? "");
        if (!repoRoot || attachedRoots.has(repoRoot)) {
            return;
        }
        attachedRoots.add(repoRoot);
        void stageTransactionObserver?.prepare(repoRoot).catch((error) => {
            debugLog("stage-undo", `Could not prepare ${repoRoot}: ${String(error)}`);
        });
        if (typeof repo?.state?.onDidChange === "function") {
            context.subscriptions.push(repo.state.onDidChange(() => {
                // Native Git staging keeps the reviewed editor visible while it
                // changes the index. Save that view with the observed receipt.
                const view = captureActiveStageUndoView();
                stageTransactionObserver?.notify(repoRoot, view ? { kind: "observedIndexChange", view } : undefined);
                // Built-in +/stage-all and terminal staging clear positions too, without new Git commands.
                const unstaged = new Set<string>([...(repo.state.workingTreeChanges ?? []),
                    ...(repo.state.untrackedChanges ?? []), ...(repo.state.mergeChanges ?? [])]
                    .filter(change => change.status !== GitStatus.IGNORED).map(change => change.uri.toString()));
                const prefix = repo.rootUri.toString().replace(/\/$/, "") + "/";
                reviewFilePositions.retain(file => !file.startsWith(prefix) || unstaged.has(file));
                if (trackedPositionUri?.startsWith(prefix) && !unstaged.has(trackedPositionUri)) {
                    trackedPositionUri = undefined; pendingReviewPosition = undefined; restoredPositionTab = undefined;
                }
                trackUnstagedReviewPosition(); // Also arm an already-open file that just became unstaged.
            }));
        }
    };

    // Other extensions can call getRepository before Better Git activates,
    // sorting this initial API snapshot in place. Seed from registration order
    // where available; later open/close events retain it without polling.
    const initialRepositories = git.repositories ?? [];
    const registrationOrder = repositoriesInScmRegistrationOrder<any>(initialRepositories, gitExtension.exports);
    if (registrationOrder.some((repo, index) => repo.rootUri.toString() !== initialRepositories[index].rootUri.toString())) {
        debugLog("worktree-link", `Recovered SCM registration order for ${registrationOrder.length} existing repositories; the initial Git API snapshot was already reordered.`);
    }
    for (const repo of registrationOrder) {
        attach(repo);
    }
    if (typeof git.onDidOpenRepository === "function") {
        context.subscriptions.push(git.onDidOpenRepository(attach));
    }
    if (typeof git.onDidCloseRepository === "function") {
        context.subscriptions.push(git.onDidCloseRepository((repo: any) => {
            repositoryDiscoveryOrder.delete(repo.rootUri.toString());
            const prefix = repo.rootUri.toString().replace(/\/$/, "") + "/";
            reviewFilePositions.retain(file => !file.startsWith(prefix));
            if (trackedPositionUri?.startsWith(prefix)) {
                trackedPositionUri = undefined; pendingReviewPosition = undefined; restoredPositionTab = undefined;
            }
        }));
    }
};

const runStageCommand = async (operation: () => Promise<void>): Promise<void> => {
    try {
        await operation();
    } catch (error) {
        if (error instanceof NavigationSuperseded) { throw error; }
        debugLog("stage-flow", `stage action failed: ${String(error)}`);
        const candidate = error as { message?: unknown; stderr?: unknown };
        const detail = [candidate?.stderr, candidate?.message]
            .find((value): value is string => typeof value === "string" && value.trim().length > 0)
            ?.trim();
        const message = isTransientGitIndexLockError(error)
            ? "Better Git: Git's index stayed busy, so nothing was staged. Try the action again after the other Git operation finishes."
            : `Better Git: Stage action failed${detail ? ` — ${detail}` : "."}`;
        void vscode.window.showErrorMessage(message);
    }
};

// Reads the live setting that gates the whole feature. Read at update time (not cached) so toggling it
// in Settings takes effect on the next stage without any restart; activate() ALSO wires an
// onDidChangeConfiguration listener so flipping it OFF hides the item immediately (and ON re-shows it).
const showLastStagedEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("showLastStagedInStatusBar", true);

// The editor-title action row is inherently dynamic: VS Code adds/removes diff, revision, whitespace and
// layout buttons for different file states, so no menu order can keep the + at one exact pixel. The status
// bar is independent of editor type. This live setting gates a second click target there while preserving the
// existing editor-title + for users who like both.
const showStageAndAdvanceStatusBarEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("showStageAndAdvanceInStatusBar", true);

// Records `uri` as the last-staged file and refreshes the status bar item. Called from the SINGLE stage
// chokepoint (stageThroughExtension) so EVERY stage path the extension performs updates the indicator —
// a future stage path physically cannot bypass it as long as it stages via that helper. We show the
// basename only (the bar must stay compact) and put the full workspace-relative path in the tooltip.
const recordLastStagedBatch = (uris: readonly vscode.Uri[], last = uris[uris.length - 1]): void => {
    const uri = last;
    if (!uri) { return; }
    lastStagedUri = uri; // always remember it, even if the bar is currently hidden by the setting
    if (!lastStagedStatusBarItem || !showLastStagedEnabled()) {
        return; // item not created yet (pre-activate) or feature disabled -> never show
    }
    // Ethan's "last file staged" (2026-11-03): a count hides an accidental extra file. Keep the
    // final reviewed member visible, and make the existing click action reopen that SAME file.
    // The batch list stays in the tooltip; it must not replace the filename with "15 files" again.
    const basename = uri.path.split("/").pop() ?? uri.fsPath;
    const relPath = vscode.workspace.asRelativePath(uri);
    const batchPaths = uris.length > 1 ? `\n\n${uris.map(candidate => vscode.workspace.asRelativePath(candidate)).join("\n")}` : "";
    lastStagedStatusBarItem.text = `$(check) Staged: ${basename}`;
    lastStagedStatusBarItem.tooltip = `${relPath}\nLast file staged via Better Git — click to reopen its diff${batchPaths}`;
    lastStagedStatusBarItem.show(); // persists for the rest of the session (the whole point: a lasting record)
};
const recordLastStaged = (uri: vscode.Uri): void => recordLastStagedBatch([uri]);

// THE SINGLE STAGE CHOKEPOINT. Every place the extension stages a file routes through here: it runs the
// actual `git add` (same as clicking the + in Source Control) and ONLY records the last-staged file if the
// add() resolved without throwing. Because the await rethrows on failure, a stage that errored (or had
// nothing to stage) never updates the indicator — so the bar never shows a file that wasn't actually
// staged. Capture the staged URI here, BEFORE callers advance the active editor, so we record the file we
// staged rather than whatever the editor switches to after the jump.
const stageUndoViewFromMouseReview = (fileUri: vscode.Uri, view?: MouseReviewView): StageUndoView | undefined => {
    const saved = view?.editors.find(editor => editor.uri === fileUri.toString());
    if (!saved || saved.selections.length === 0) { return undefined; }
    return {
        fileUri: fileUri.toString(), documentUri: saved.uri,
        selections: saved.selections.slice(0, 16).map(selection => ({
            anchor: { line: selection.anchor.line, character: selection.anchor.character },
            active: { line: selection.active.line, character: selection.active.character },
        })),
        topLine: saved.top?.line,
    };
};

const captureActiveStageUndoView = (includeDeletedReview = false): StageUndoView | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const documentUri = input instanceof vscode.TabInputTextDiff ? input.modified
        : input instanceof vscode.TabInputText ? input.uri : undefined;
    // Deleted text opens as one read-only git: document. Revisit memory may track it after verifying live
    // unstaged membership below; the default exact-Undo capture keeps its existing working-file-only rule.
    const fileUri = documentUri?.scheme === "file" ? documentUri
        : includeDeletedReview && input instanceof vscode.TabInputText && documentUri?.scheme === "git"
            ? toFilePathUri(documentUri) : undefined;
    if (!fileUri) { return undefined; }
    const editor = visibleEditorForActiveTab();
    if (!editor || editor.document.uri.toString() !== documentUri?.toString()) { return undefined; }
    return {
        fileUri: fileUri.toString(), documentUri: editor.document.uri.toString(),
        selections: editor.selections.slice(0, 16).map(selection => ({
            anchor: { line: selection.anchor.line, character: selection.anchor.character },
            active: { line: selection.active.line, character: selection.active.character },
        })),
        topLine: editor.visibleRanges[0]?.start.line,
    };
};

const stageBatchThroughExtension = async (
    repo: any, uris: readonly vscode.Uri[], priorView?: StageUndoView,
    preferPriorView = false, lastStaged = uris[uris.length - 1]
): Promise<void> => {
    if (uris.length === 0) { return; }
    const attempt = ++stageAttemptSequence;
    const started = performance.now();
    const trace = (phase: string): void => debugLog("stage-flow",
        `#${attempt} ${phase}; elapsed=${Math.round(performance.now() - started)}ms`);
    trace(`start files=${uris.length}, first=${uris[0].fsPath}, focused=${vscode.window.state.focused}`);
    const selectedUris = new Set(uris.map(uri => uri.toString()));
    const activeView = captureActiveStageUndoView();
    // A held batch may be previewing its latest endpoint at release. Prefer
    // that live view; the saved mouse origin covers button-down navigation
    // that already moved to an unrelated file before the stage begins.
    const view = (preferPriorView ? [priorView, activeView] : [activeView, priorView])
        .find(candidate => candidate && selectedUris.has(candidate.fileUri));
    const repoRoot = String(repo.rootUri?.fsPath ?? "");
    const reportUndoError = (receiptCaptureError: unknown): void => {
        trace(`Undo receipt unavailable: ${String(receiptCaptureError)}`);
        const candidate = receiptCaptureError as { message?: unknown; stderr?: unknown };
        const detail = [candidate?.stderr, candidate?.message]
            .find((value): value is string => typeof value === "string" && value.trim().length > 0)
            ?.trim();
        // This informational toast has no decision to wait for. Awaiting dismissal strands a successfully
        // staged file (and later queued releases) instead of advancing when an exact Undo snapshot is unavailable.
        void vscode.window.showWarningMessage(
            `Better Git: Staged ${uris.length === 1 ? path.basename(uris[0].fsPath) : `${uris.length} files`}, but couldn't save the Undo details${detail ? ` — ${detail}` : "."}`
        );
    };
    const stage = async (): Promise<void> => {
        trace("Git add starting");
        await runWithTransientGitIndexRetry(() => repo.add(uris.map(uri => uri.fsPath)));
        stageHistoryLog?.stage(repoRoot, uris.map(uri => path.relative(repoRoot, uri.fsPath)));
        // Ethan: remember unfinished reviews, then forget ONLY after a successful whole-file stage.
        // The exact Undo receipt above owns its own saved view; this cache must not replace Undo history.
        for (const uri of uris) { reviewFilePositions.forget(uri.toString()); }
        if (trackedPositionUri && selectedUris.has(trackedPositionUri)) {
            trackedPositionUri = undefined; pendingReviewPosition = undefined; restoredPositionTab = undefined;
        }
        trace("Git add finished");
    };
    const observer = stageTransactionObserver;
    let receiptState: "queued" | "unavailable" | undefined;
    if (repoRoot && observer) {
        receiptState = await stageWithDeferredReceipt({
            prepareUndo: async () => {
                trace("preparing Undo snapshot");
                await observer.prepare(repoRoot);
                trace("Undo snapshot ready");
            },
            stage,
            saveUndo: async () => {
                trace("saving Undo receipt");
                await observer.observe(repoRoot, {
                    kind: "betterGitStage",
                    uri: uris[0].toString(),
                    uris: uris.map(uri => uri.toString()),
                    view,
                });
                trace("Undo receipt saved");
            },
            onUndoError: reportUndoError,
        });
    } else { await stage(); }
    recordLastStagedBatch(uris, lastStaged); // success -> show the batch's final reviewed member
    trace(receiptState ? `stage complete; Undo receipt ${receiptState}` : "stage complete");
};
const stageThroughExtension = (repo: any, uri: vscode.Uri, priorView?: StageUndoView): Promise<void> =>
    stageBatchThroughExtension(repo, [uri], priorView);

// Undo the latest observed stage/index transaction from a bounded persistent
// LIFO history, and only while HEAD and the index are still byte-for-byte the
// state produced by that transaction. Restoring the captured pre-stage tree is
// an exact inverse even for a partially staged file; refusing after any
// intervening change prevents this command from silently removing newer staged
// work. A successful restore removes only that receipt, exposing the previous
// transaction for the next Cmd+Z / Ctrl+Z.
const undoLastStageTransaction = async (): Promise<void> => {
    const result = stageTransactionObserver
        ? await stageTransactionObserver.undoLatest(restoreStageTransaction)
        : await stageTransactionStore?.consumeLatest(restoreStageTransaction);
    const transaction = result?.transaction;
    if (!result || result.status === "empty" || !transaction) {
        vscode.window.showInformationMessage("Better Git: There is no recent stage/index change to undo.");
        return;
    }

    if (result.status === "head-changed") {
        vscode.window.showWarningMessage(
            "Better Git: HEAD changed after the saved stage, so that repository's undo history was discarded without changing your index."
        );
        return;
    }
    if (result.status === "index-changed") {
        vscode.window.showWarningMessage(
            "Better Git: The Git index changed again after the saved stage, so that repository's undo history was discarded without changing your index. Undo it manually to preserve newer staged work."
        );
        return;
    }

    stageHistoryLog?.undo(transaction); // A known successful index restore can unstage OR restage.

    // Refresh only after releasing the shared history lock. The resulting Git
    // event sees the persisted restored baseline in every observing window.
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.repositories?.find(
            (candidate: any) => String(candidate.rootUri?.fsPath ?? "") === transaction.repoRoot
        );
        if (typeof repo?.status === "function") {
            await repo.status();
        }
    } catch {
        // The exact Git index restore already succeeded. Refresh is best effort.
    }

    const remainingHistory = result.remaining;
    const previousTransaction = remainingHistory[remainingHistory.length - 1];
    lastStagedUri = undefined;
    lastStagedStatusBarItem?.hide();
    if (previousTransaction?.kind === "betterGitStage" && previousTransaction.uri) {
        try {
            recordLastStagedBatch((previousTransaction.uris ?? [previousTransaction.uri]).map(uri => vscode.Uri.parse(uri)));
        } catch {
            // The exact undo has succeeded; stale presentation data is optional.
        }
    }
    // Presentation happens after the restore and outside the shared history
    // lock. An editor failure must not turn a successful index Undo into a
    // reported restore failure, or prevent the next queued Undo.
    try {
        await revealUndoneStageTransaction(transaction);
    } catch (error) {
        console.warn("Better Git: Could not reveal the restored stage transaction", error);
    }
    const stagedUris = transaction.uris ?? (transaction.uri ? [transaction.uri] : []);
    const subject = stagedUris.length > 1
        ? ` for ${stagedUris.length} files`
        : transaction.uri ? ` for ${path.basename(vscode.Uri.parse(transaction.uri).fsPath)}` : "";
    const remaining = remainingHistory.length === 0
        ? ""
        : ` ${remainingHistory.length} earlier ${remainingHistory.length === 1 ? "undo remains" : "undos remain"}.`;
    vscode.window.showInformationMessage(`Better Git: Undid the latest stage${subject}.${remaining}`);
};

const executeUndoCommand = async (): Promise<void> => {
    try {
        await undoLastStageTransaction();
    } catch (error) {
        const candidate = error as { message?: unknown; stderr?: unknown };
        const detail = [candidate?.stderr, candidate?.message]
            .find((value): value is string => typeof value === "string" && value.trim().length > 0)
            ?.trim();
        const message = isTransientGitIndexLockError(error)
            ? "Better Git: Git's index stayed busy, so the saved stage was not undone. Try again after the other Git operation finishes."
            : `Better Git: The saved stage could not be undone${detail ? ` — ${detail}` : "."}`;
        void vscode.window.showErrorMessage(message);
    }
};

// VS Code may invoke an async command again before the prior promise settles
// (key repeat and rapid mouse double-presses both do this). Serialize consumers
// so each invocation restores and removes one entry before the next loads the
// new top of the LIFO history.
const runUndoCommand = (): Promise<void> => {
    const result = stageUndoQueue.then(executeUndoCommand, executeUndoCommand);
    stageUndoQueue = result.catch(() => undefined);
    return result;
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// EXPERIMENTAL SOURCE CONTROL TREE-STATE MANAGEMENT (v1.2.31, default OFF)
//
// WHY this exists historically: Ethan works with git WORKTREES (e.g.
// ~/Documents/claude-worktrees/<project>-<name>). When multiple worktrees / repositories are open in
// one window, VS Code's built-in Source Control view renders EACH repository as its own collapsible
// section header. Older Better Git releases deliberately collapsed all of them after every startup.
//
// v1.2.30 tried to reconstruct the exact saved tree by repeatedly driving generic `list.*` commands. With
// many worktrees that routine was quadratic: it repeatedly jumped to an edge and visibly walked the same
// rows again. v1.2.31 therefore puts EVERY automatic reveal/focus/expand/collapse path behind the single
// `experimentalScmTreeStateManagement` master switch, which defaults OFF. When it is off, activation does
// not read the SCM database, start discovery timers, reveal Source Control, focus/select a row, or execute
// any expand/collapse command. The rest of Better Git remains fully active.
//
// v1.2.33 keeps the explicit Command Palette collapse separate from that automation switch. A user-requested
// one-shot collapse is not startup automation: it remains available with the experiment off and dispatches only
// the same two safe built-in commands. The automatic path still re-checks its opt-in before each dispatch.
//
// HOW the opt-in collapse works — the ONLY reliable command exposed to extensions (verified against,
// src/vs/workbench/contrib/scm/):
//   `workbench.scm.action.collapseAllRepositories`
// Its handler literally iterates `scmViewService.visibleRepositories` and collapses every collapsible
// one. VS Code still exposes no public extension API to read or set one particular SCM node; its own
// internal workspace state holds it. The generic `workbench.scm.action.collapseAll` collapses
// resource folders inside a group, not repository headers, and `git.collapseAll` does not exist.
//
// CRITICAL CAVEAT #1 — the command is a VIEW ACTION: its handler resolves the target view via
// `getActiveViewWithId("workbench.scm")`, which only returns the view when the Source Control viewlet is
// the ACTIVE (currently-open) sidebar container. If SCM isn't the active view, the command silently
// no-ops. So we MUST reveal SCM first (`workbench.view.scm`) and only THEN collapse. This does bring the
// Source Control panel to the foreground. That is expected when the user explicitly invokes the manual
// command. The automatic experiment only runs when there are actually ≥2 repositories (the multi-worktree
// annoyance), so a single-repo window is left untouched and unfocused.
//
// CRITICAL CAVEAT #2 — TIMING / POPULATE: the git extension discovers repositories asynchronously after
// window load, and the SCM tree must have the repo nodes present before there's anything to collapse.
// The double-opt-in startup path waits for the repository count to settle and dispatches one collapse.
// It deliberately has no retry timer or repository-open listener: a late repository stays under vanilla
// VS Code control rather than restarting foreground UI automation.

// The built-in command id that collapses all SCM repository/worktree section headers. Kept as a const so
// there's a single source of truth and it's easy to find/grep.
const SCM_COLLAPSE_ALL_REPOS_COMMAND = "workbench.scm.action.collapseAllRepositories";

// This setting is deliberately read live rather than cached. Turning the experiment off while the optional
// one-shot startup collapse is waiting cancels it before its next tree command. A reload remains the cleanest
// way to let vanilla VS Code rebuild the tree, but no row walk or restoration task exists in this release.
const experimentalScmTreeStateManagementEnabled = (): boolean =>
    vscode.workspace
        .getConfiguration("better-git-vscode")
        .get<boolean>("experimentalScmTreeStateManagement", false);

class ScmTreeExperimentDisabledError extends Error {
    constructor() {
        super("experimental Source Control tree-state management is disabled");
        this.name = "ScmTreeExperimentDisabledError";
    }
}

// Exposed read-only through the extension's tiny test API. This records only Better Git's SCM tree commands
// (never unrelated navigation commands), allowing the isolated-host regression to prove that default/off
// activation is inert, a manual collapse remains available, and double-opt-in automation dispatches once.
const scmTreeCommandTrace: string[] = [];

const ensureScmTreeExperimentEnabled = (): void => {
    if (!experimentalScmTreeStateManagementEnabled()) {
        throw new ScmTreeExperimentDisabledError();
    }
};

type ScmTreeCommandOrigin = "automatic" | "manual";

const executeScmTreeCommand = async <T = unknown>(
    origin: ScmTreeCommandOrigin,
    command: string,
    ...args: unknown[]
): Promise<T> => {
    if (origin === "automatic") {
        ensureScmTreeExperimentEnabled();
    }
    scmTreeCommandTrace.push(command);
    debugLog("scm-tree", `${origin}: ${command}`); // Show the exact last presentation step if a live link aborts.
    return vscode.commands.executeCommand<T>(command, ...args);
};

// Reveal the Source Control view (required — see CAVEAT #1) then run the collapse-all-repositories
// command. Returns true if the collapse command was dispatched without throwing. Fully defensive: any
// failure (command missing on an old host, view not resolvable) is swallowed so it can never break
// startup or a manual invocation.
//
// This intentionally collapses EVERY repository/worktree header, including the primary. v1.2.13 established
// that as the side-effect-free manual UX; v1.2.26 uses the same primitive at startup instead of reopening a
// primary-repo change in a preview tab merely to trigger SCM auto-reveal.
const collapseScmRepositories = async (origin: ScmTreeCommandOrigin): Promise<boolean> => {
    try {
        // Must make SCM the active sidebar container first, otherwise the view action can't resolve its
        // target view and no-ops. This focuses the Source Control panel.
        await executeScmTreeCommand(origin, "workbench.view.scm");
        // Now the collapse command has a live view to act on — collapses every repo/worktree header.
        await executeScmTreeCommand(origin, SCM_COLLAPSE_ALL_REPOS_COMMAND);
        return true;
    } catch {
        // Old VS Code without this command id, a view-resolution failure, or an automatic opt-in toggled off
        // between the reveal and collapse commands — do nothing, safely.
        return false;
    }
};

// VS Code still exposes no command/API to persist individual repository expansion state or collapse one specific
// header. The supported workaround is therefore deliberately all-or-nothing. Reopening a changed file to re-expand
// one header caused preview-tab/focus side effects and also undermined the user's request that the sections remain
// collapsed after an extension-host restart, so no auto-reveal hack belongs in the startup path anymore.

// Case-insensitive (mac/win filesystems) comparison of two uris' on-disk roots, trailing separators
// stripped, so a repo's rootUri can be matched against a workspace folder uri regardless of a trailing slash.
const sameRootPath = (a: vscode.Uri, b: vscode.Uri): boolean =>
    a.fsPath.replace(/[\/\\]+$/, "").toLowerCase() === b.fsPath.replace(/[\/\\]+$/, "").toLowerCase();

// Identify the PRIMARY / main repository — the workspace's main working copy, the one that renders at the
// TOP of the Source Control view. Robust detection: it's the repo whose rootUri equals the FIRST workspace
// folder (vscode.workspace.workspaceFolders[0]). Linked worktrees live OUTSIDE the workspace folder (their
// rootUri points elsewhere, e.g. ~/Documents/claude-worktrees/…), so they won't match folder[0]. If that
// can't be resolved (no folders, or none matches — e.g. the main repo root isn't itself a workspace folder),
// fall back to git.repositories[0], the first repository the git extension discovered, which is the closest
// available "primary" proxy. Returns undefined only when there are no repositories at all.
const getPrimaryRepository = (): any | undefined => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repos: any[] = git?.repositories ?? [];
        if (repos.length === 0) {
            return undefined;
        }
        const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (firstFolder) {
            // The main working copy's root == the primary workspace folder. Match on that.
            const match = repos.find((r) => r?.rootUri && sameRootPath(r.rootUri as vscode.Uri, firstFolder));
            if (match) {
                return match;
            }
        }
        return repos[0]; // fallback: first-discovered repo is the closest proxy for "primary"
    } catch {
        return undefined; // git API not ready / shape changed — navigation treats this as no repository
    }
};

// Reads the git API and returns how many repositories/worktrees VS Code currently has open (0 if the git
// extension isn't ready yet). Used to (a) decide whether the multi-worktree annoyance even applies and
// (b) poll until repos have populated before collapsing.
const getOpenRepositoryCount = (): number => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        return git?.repositories?.length ?? 0;
    } catch {
        return 0; // git extension not present / API shape changed — treat as "no repos"
    }
};

// VS Code exposes one reliable all-repository operation but no public API for reading or setting an
// individual repository/group disclosure node. v1.2.31 intentionally does not inspect workbench SQLite,
// capture semantic copies, or drive generic `list.*` commands. Exact mixed-state restoration is withdrawn
// until VS Code offers a node-specific contract that can be tested without selecting or walking rows.
interface ScmTreeStartupOutcome {
    changed: boolean;
    reason: string;
}

interface BetterGitExtensionApi {
    whenScmTreeStateSettled: Promise<ScmTreeStartupOutcome>;
    whenStageTransactionsSettled(): Promise<void>;
    whenStageHistorySettled(): Promise<void>;
    getStageHistoryFile(): string | undefined;
    whenReviewDecorationSettled(): Promise<void>;
    getCurrentReviewUri(): string | undefined;
    getReviewDecorationBadge(uri: vscode.Uri): string | vscode.ThemeIcon | undefined;
    whenCurrentHunkOverviewMarkerSettled(): Promise<void>;
    getCurrentHunkOverviewMarker(): { uri: string; start: number; end: number } | undefined;
    getScmTreeCommandTrace(): readonly string[];
    getMouseDebugTrace(): readonly string[];
    clearMouseDebugTrace(): void;
    // The last value published to the `better-git-vscode.keyboardReviewActive` context key.
    isKeyboardReviewActive(): boolean;
    // Isolated Extension Development Hosts only: feed the same physical state interpreter without OS injection.
    sampleKeyboardReviewKeys?(state: ReviewKeyState): void;
    getRememberedReviewPosition?(uri: vscode.Uri): ReviewFilePosition | undefined;
    whenWorktreePresentationSettled?(): Promise<void>;
    whenKeyboardGestureSettled?(): Promise<void>;
}

// The only automatic behavior still available is a double opt-in, one-shot collapse-all. The master
// experiment and the legacy startup-collapse setting must both be true. Discovery is observed read-only;
// after the repository count is stable, Better Git reveals SCM and invokes the built-in collapse command
// exactly once. There are no retry timers, repository-open listeners, row selection, or traversal commands.
const runExperimentalScmStartup = (
    context: vscode.ExtensionContext
): Promise<ScmTreeStartupOutcome> => {
    const autoCollapseEnabled = (): boolean => experimentalScmTreeStateManagementEnabled() &&
        vscode.workspace
            .getConfiguration("better-git-vscode")
            .get<boolean>("collapseWorktreesOnStartup", false);

    if (!experimentalScmTreeStateManagementEnabled()) {
        return Promise.resolve({
            changed: false,
            reason: "experimental Source Control tree-state management disabled",
        });
    }
    if (!autoCollapseEnabled()) {
        return Promise.resolve({
            changed: false,
            reason: "automatic Source Control collapse disabled",
        });
    }

    let disposed = false;
    context.subscriptions.push(new vscode.Disposable(() => {
        disposed = true;
    }));

    return (async () => {
        const deadline = Date.now() + 12000;
        let lastRepositoryCount = -1;
        let stableSince = 0;

        while (!disposed && autoCollapseEnabled() && Date.now() < deadline) {
            const repositoryCount = getOpenRepositoryCount();
            if (repositoryCount !== lastRepositoryCount) {
                lastRepositoryCount = repositoryCount;
                stableSince = Date.now();
            }
            if (repositoryCount >= 2 && Date.now() - stableSince >= 1400) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (disposed || !autoCollapseEnabled() || lastRepositoryCount < 2) {
            return {
                changed: false,
                reason: "collapse cancelled or fewer than two repositories",
            };
        }

        // Git discovery can settle before the SCM tree completes its queued render. Wait once, re-check
        // both opt-ins, then issue the one supported mutation. Never retry: repeated foreground commands
        // are the exact v1.2.30 loop this release contains.
        await new Promise((resolve) => setTimeout(resolve, 2200));
        if (disposed || !autoCollapseEnabled()) {
            return { changed: false, reason: "collapse cancelled" };
        }

        const collapsed = await collapseScmRepositories("automatic");
        return collapsed
            ? { changed: true, reason: "collapsed once after discovery settled" }
            : { changed: false, reason: "collapse command unavailable or experiment disabled" };
    })().catch((error): ScmTreeStartupOutcome => {
        debugLog("scm-state", `startup collapse failed: ${String(error)}`);
        return { changed: false, reason: String(error) };
    });
};

// Resolve the selected file from Explorer's direct Uri and the argument shapes VS Code uses for Source Control
// resource context-menu commands. A single SCM resource can arrive as a Uri or as a
// SourceControlResourceState-like object; multi-select commands can wrap either shape in an array. Keep this
// tolerant so the browser action works from either menu and for staged, unstaged, and untracked index.html rows
// without depending on vscode.git's private resource-state class.
const findContextResourceUri = (targets: readonly unknown[]): vscode.Uri | undefined => {
    for (const target of targets) {
        if (target instanceof vscode.Uri) {
            return target;
        }
        if (Array.isArray(target)) {
            const nestedUri = findContextResourceUri(target);
            if (nestedUri) {
                return nestedUri;
            }
            continue;
        }
        if (typeof target === "object" && target !== null && "resourceUri" in target) {
            const resourceUri = (target as { resourceUri?: unknown }).resourceUri;
            if (resourceUri instanceof vscode.Uri) {
                return resourceUri;
            }
        }
    }
    return undefined;
};

// Repository/worktree header commands receive the clicked SourceControl object. VS Code's public SourceControl
// label is just "Git" for vscode.git, while the visible header identity comes from its root, so the useful
// worktree name is the root folder basename (the same text users recognize in the Source Control header).
const findWorktreeRootUri = (targets: readonly unknown[]): vscode.Uri | undefined => {
    for (const target of targets) {
        if (Array.isArray(target)) {
            const nestedUri = findWorktreeRootUri(target);
            if (nestedUri) {
                return nestedUri;
            }
            continue;
        }
        if (typeof target === "object" && target !== null && "rootUri" in target) {
            const rootUri = (target as { rootUri?: unknown }).rootUri;
            if (rootUri instanceof vscode.Uri) {
                return rootUri;
            }
        }
    }
    return undefined;
};

export function activate(context: vscode.ExtensionContext): BetterGitExtensionApi {
    // Startup regression (2026-11-03): a mouse command can activate Better Git before vscode.git.
    // Reading Extension.exports then throws even with optional chaining and aborts this activation.
    // package.json declares vscode.git as an extensionDependency so VS Code starts Git before any of
    // these synchronous editor observers. Keep that dependency; awaiting Git only in the background
    // index observer does not protect trackUnstagedReviewPosition or publish the ready-host receipt.
    debugLog("activation", `Better Git ${context.extension.packageJSON.version} activated.`);
    registerStagedLfsImageProvider(context);
    registerAgentFlowSelectionBridge(context);
    registerDiffViewDisplay(context, (message) => debugLog("diff-display", message));
    const commitMessageGenerator = new CommitMessageGenerator(context.globalState);
    stageHistoryLog = new StageTransactionHistoryLog(
        path.join(context.globalStorageUri.fsPath, "stage-history"), readStageTransactionPaths,
        error => appendDebugLog("stage-history", `Could not save local history: ${String(error)}`)
    );
    stageHistoryLog.start(String(context.extension.packageJSON.version));
    stageTransactionStore = new StageTransactionStore(
        path.join(context.globalStorageUri.fsPath, "last-stage-next-transaction.json"),
        change => stageHistoryLog?.observe(change)
    );
    stageTransactionObserver = new StageTransactionObserver(
        stageTransactionStore,
        readIndexSnapshot,
        (error) => debugLog("stage-undo", `Index observer failed: ${String(error)}`)
    );
    void startIndexTransitionObservation(context).catch((error) => {
        debugLog("stage-undo", `Could not start index observation: ${String(error)}`);
    });

    // Persistent fixed-location mouse target for stage-and-advance (v1.2.20). Priority 101 places it directly
    // beside, and just before, the existing last-staged indicator at priority 100. Unlike editor/title, this
    // row does not gain/lose controls when the active file switches between modified/new/staged diff shapes.
    // It deliberately remains visible on every editor: the shared command safely no-ops when no changed file
    // is active, and a never-moving target is the whole point of this alternative.
    const stageAndAdvanceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    stageAndAdvanceStatusBarItem.text = "$(add) Stage & Next";
    stageAndAdvanceStatusBarItem.tooltip = "Better Git: stage the current changed file and advance in the last navigation direction";
    stageAndAdvanceStatusBarItem.command = "better-git-vscode.stage-current-file-and-advance";
    if (showStageAndAdvanceStatusBarEnabled()) {
        stageAndAdvanceStatusBarItem.show();
    }

    // Create the last-staged status bar item. Left alignment + priority 100 puts it on the left cluster at a
    // reasonable position. Starts HIDDEN — there's nothing to show until the first stage of the session. Its
    // .command points at our reveal command (registered below) so a click reopens the staged file's diff.
    lastStagedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lastStagedStatusBarItem.command = "better-git-vscode.reveal-last-staged-file";
    lastStagedStatusBarItem.hide();
    // Every forward nav command records lastNavDirection = "next"; every backward one records "previous".
    // This is what the editor-title "+" button reads to decide which way to advance after staging (v1.2.7).
    // During Ethan's keyboard eyes mode, untagged Next/Previous review the pending selection instead of ending it.
    // The internal "keyboard" tag is never a public navigation source.
    const keyboardNavigationRepeats = new KeyboardNavigationRepeat();
    const withKeyboardRepeat = async (source: unknown, navigate: (source: unknown) => Promise<void>): Promise<void> => {
        // Reuse the established manifest physical-key tag/allowlist used by the stage repeat guard.
        // Only a held keyboard's OS repeats are paced. Mouse/wand calls and fresh released presses stay exact.
        const key = parseKeyboardStageArgs(source);
        const paced = key !== undefined && process.platform === "darwin";
        const permit = paced ? keyboardNavigationRepeats.admit(key) : undefined;
        if (paced && !permit) { return; }
        try {
            if (permit) { debugLog("keyboard-repeat", `Admitted ${key} navigation; hold=${permit.holdId ?? "unmonitored"}.`); }
            // Keyboard review historically routes untagged navigation into the pending set. Metadata
            // must not turn a keyboard step into mouse navigation and accidentally clear that set.
            await navigate(key === undefined ? source : undefined);
        } finally { if (permit) { keyboardNavigationRepeats.complete(permit); } }
    };
    let disposable = vscode.commands.registerCommand("better-git-vscode.next-scm-change", (source?: unknown) => withKeyboardRepeat(source, async source => {
        if (routeChangeNavigation(keyboardReviewHolds(), source) === "review") { return stepKeyboardReview("next"); }
        clearStageHoldFeedback();
        lastNavDirection = "next"; // he just jumped FORWARD through changes -> "+" should advance forward
        await navigateWithMouseOrigin("next", isMouseReviewSource(source) ? source : undefined);
    }));

    let disposable2 = vscode.commands.registerCommand("better-git-vscode.previous-scm-change", (source?: unknown) => withKeyboardRepeat(source, async source => {
        if (routeChangeNavigation(keyboardReviewHolds(), source) === "review") { return stepKeyboardReview("previous"); }
        clearStageHoldFeedback();
        lastNavDirection = "previous"; // he just jumped BACKWARD -> "+" should advance backward
        await navigateWithMouseOrigin("previous", isMouseReviewSource(source) ? source : undefined);
    }));

    const stageBeforeMouseNavigation = vscode.commands.registerCommand(
        "better-git-vscode.stage-before-mouse-navigation", stageMouseNavigationOrigin
    );

    // Physical holds always capture their exact origin. The default release-only path leaves the editor still
    // until button-up has already classified the duration. The former button-down navigation and exact readiness
    // restoration remain available behind an off-by-default feature flag.
    // Ethan replaced the temporary jump/back delay with this rule: short/long is known at button-up, so
    // navigate/stage then. Keep the experiment saved but disabled; never add its delay to normal input.
    const mouseHoldCommands = [
        vscode.commands.registerCommand("better-git-vscode.begin-mouse-navigation-hold", (args: unknown) => {
            if (!args || typeof args !== "object" || !("source" in args) || !("direction" in args)) {
                mouseDebug("Button down ignored, invalid hold arguments.");
                return;
            }
            const { source, direction } = args;
            if (!isMouseReviewSource(source) || (direction !== "next" && direction !== "previous")) {
                mouseDebug("Button down ignored, unknown mouse or direction.");
                return;
            }
            const initialMode = "initialMode" in args ? args.initialMode : undefined;
            if (initialMode !== undefined && initialMode !== "changes" && initialMode !== "files") {
                mouseDebug("Button down ignored, invalid initial review mode.");
                return;
            }
            mouseDebug(`${mouseSourceLabel(source)} ${mouseDirectionLabel(direction)} button down.`);
            clearStageHoldFeedback();
            lastNavDirection = direction;
            const navigateOnButtonDown = vscode.workspace.getConfiguration("better-git-vscode")
                .get<boolean>("experimentalMouseHoldNavigateOnButtonDown", false);
            const begun = navigateWithMouseOrigin(direction, source, true, navigateOnButtonDown);
            // Ethan: every fresh Agentic Mouse hold starts in eyes review, never the previous hold's
            // explosion mode. Carry that intent on the SAME button-down command: a separate mode URI
            // can overtake the synthetic key before a hold exists. Like keyboard review below, install
            // the mode on the synchronously-created request before queued Git/editor work settles.
            // Direct legacy callers without initialMode retain their existing whole-file staging.
            if (initialMode !== undefined) { setStagePreviewModeRequest(source, initialMode === "changes"); }
            return begun;
        }),
        vscode.commands.registerCommand("better-git-vscode.finish-mouse-navigation-hold", (args: unknown) => stageMouseNavigationOrigin(args, true)),
        vscode.commands.registerCommand("better-git-vscode.cancel-mouse-navigation-hold", (source: unknown) => {
            if (!isMouseReviewSource(source)) {
                mouseDebug("Short release ignored, unknown mouse source.");
                return;
            }
            const request = mouseHoldRequests.get(source);
            return serializeChangeNavigation(async check => {
                const origin = mouseNavigationOrigins.get(source);
                const reviewItemCaptured = request !== undefined && origin?.holdRequest === request;
                const outcome = registerMouseShortRelease(request, reviewItemCaptured);
                if (outcome === "pending" || outcome === "pending-without-review-item") {
                    // Without a review item the hold still stays alive for the adjacent F16 that Agentic Mouse
                    // sends right after this F14; the F15 boundary then finds no review item and stays inert.
                    mouseDebug(origin && outcome === "pending"
                        ? `${mouseSourceLabel(source)} ${mouseDirectionLabel(origin.direction)} short release registered.`
                        : `${mouseSourceLabel(source)} short release registered; no review item was captured, so the boundary will not navigate.`);
                    return;
                }
                if (origin?.holdRequest === request) { mouseNavigationOrigins.delete(source); }
                if (mouseHoldRequests.get(source) === request) { mouseHoldRequests.delete(source); }
                if (latestMouseHoldRequest === request) { latestMouseHoldRequest = undefined; }
                mouseDebug(request
                    ? `${mouseSourceLabel(source)} short release cleared the hold; button-down navigation kept.`
                    : `${mouseSourceLabel(source)} short release ignored, no hold in progress.`);
            });
        }),
    ];

    let disposable3 = vscode.commands.registerCommand("better-git-vscode.next-changed-file", async () => {
        lastNavDirection = "next";
        await goToFirstOrNextFile();
    });

    let disposable4 = vscode.commands.registerCommand("better-git-vscode.previous-changed-file", async () => {
        lastNavDirection = "previous";
        await goToLastOrPreviousFile();
    });

    let disposable5 = vscode.commands.registerCommand("better-git-vscode.revert-and-save", async () => {
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
    });

    // One physical keyboard hold must stage exactly once (see the module-level guard comment). The monitor is
    // lazy: no osascript child exists until the first tagged keyboard press, and it idles on stdin afterwards.
    const keyboardHoldLog = (message: string): void => debugLog("keyboard-hold", message);
    const keyReleaseMonitor = new MacKeyReleaseMonitor({
        log: keyboardHoldLog,
        warn: message => {
            // A macOS monitor failure silently changes the shortcut's feel, so record it once even without
            // debug logging enabled; the output channel is the only place this evidence can be recovered.
            try { appendDebugLog("keyboard-hold", message); } catch { /* best effort */ }
        },
    });
    keyboardStageRepeatGuard = new KeyboardStageRepeatGuard({ monitor: keyReleaseMonitor, log: keyboardHoldLog });
    const keyboardStageRepeatGuardDisposable = new vscode.Disposable(() => {
        keyboardStageRepeatGuard?.dispose();
        keyboardStageRepeatGuard = undefined;
        keyReleaseMonitor.dispose();
    });

    // Legacy shifted navigation always stages immediately. It consumes the modifier-only Shift tap so
    // releasing Shift cannot also cycle modes; the existing guard still admits one stage per physical hold.
    let disposable6 = vscode.commands.registerCommand("better-git-vscode.stage-and-next-changed-file", async (args?: unknown) => {
        if (parseKeyboardStageArgs(args)) { keyboardGesture.consumeStageShortcut(); }
        if (!admitStageAndAdvancePress(args)) { return; }
        clearStageHoldFeedback();
        lastNavDirection = "next";
        await serializeChangeNavigation(check => runStageCommand(() => stageCurrentFileAndAdvance("next", undefined, check)), false, "stage-next");
    });

    // Mirror of disposable6 for reverse-order (bottom-to-top) review: stage the current file, then jump to the
    // PREVIOUS unstaged file instead of the next. Bound to "shift + previous" so it parallels "shift + next".
    let disposable7 = vscode.commands.registerCommand("better-git-vscode.stage-and-previous-changed-file", async (args?: unknown) => {
        if (parseKeyboardStageArgs(args)) { keyboardGesture.consumeStageShortcut(); }
        if (!admitStageAndAdvancePress(args)) { return; }
        clearStageHoldFeedback();
        lastNavDirection = "previous";
        await serializeChangeNavigation(check => runStageCommand(() => stageCurrentFileAndAdvance("previous", undefined, check)), false, "stage-previous");
    });

    let undoLastStageDisposable = vscode.commands.registerCommand(
        "better-git-vscode.undo-last-stage-and-advance",
        (source?: unknown) => {
            if (source !== undefined && !isMouseReviewSource(source)) {
                mouseDebug("Cancel chord ignored, unknown mouse source.");
                return;
            }
            // The live Agentic Mouse chord delivers this Undo key BARE (through the user's plain `f16` binding),
            // while Better Git's contributed bindings tag it per mouse. Decide both from the same input-order
            // rule before cancelling, because cancellation clears the readiness flag's owner.
            const hold = source === undefined ? latestMouseHoldRequest : mouseHoldRequests.get(source);
            const outcome = resolveAdjacentMouseChord(hold);
            const cancelledHold = cancelMouseNavigationHold(source);
            if (cancelledHold) {
                // The adjacent mouse cell has two deliberate meanings. Before the 200 ms readiness event it is
                // the original quick Undo gesture: consume the unfinished hold, then restore the latest stage.
                // Once F20 has arrived, it cancels only the pending stage selection and preserves Undo history.
                if (outcome === "cancel-only") { return cancelledHold; }
                return cancelledHold.then(runUndoCommand, error => {
                    // The user asked for Undo; a failed view restoration must not swallow it.
                    mouseDebug(`Cancel chord restoration failed before Undo: ${String(error)}`);
                    return runUndoCommand();
                });
            }
            // A source-tagged F16 belongs only to an adjacent mouse chord. If its hold already ended,
            // consume the stale input instead of turning it into an unrelated staging Undo.
            if (source !== undefined) {
                mouseDebug(`${mouseSourceLabel(source)} cancel chord ignored, no hold in progress.`);
                return;
            }
            clearStageHoldFeedback();
            return runUndoCommand();
        }
    );

    // Legacy command: stage the current file WITHOUT navigating. Kept registered so anyone who bound it keeps
    // that behaviour, but as of v1.2.7 it is NO LONGER what the editor-title "+" button runs — the button now
    // runs stage-current-file-and-advance (disposable15 below) for the mouse-only review flow.
    let disposable8 = vscode.commands.registerCommand("better-git-vscode.stage-current-file", async () => {
        await runStageCommand(stageCurrentFile);
    });

    // Editor-title "+" button (v1.2.7): stage the current file AND advance to the next/previous change in
    // whatever direction Ethan last navigated (lastNavDirection). This lets him run the whole review-and-stage
    // flow with the mouse alone — click "+" to stage-and-jump instead of clicking "+" then reaching for the
    // keyboard. It calls the EXACT SAME stageCurrentFileAndAdvance() that Shift+Alt+. / Shift+Alt+, use, so
    // behaviour (staging, advance target, cross-file rollover, last-staged status bar) is byte-identical to the
    // keyboard shortcut. On a non-diff / non-change editor stageCurrentFileAndAdvance safely no-ops (its
    // isChangedFile guard), so the button never errors even when "advance" is meaningless.
    let disposable15 = vscode.commands.registerCommand("better-git-vscode.stage-current-file-and-advance", async () => {
        const direction = lastNavDirection;
        await serializeChangeNavigation(check => runStageCommand(() => stageCurrentFileAndAdvance(direction, undefined, check)), false, `stage-${direction}`);
    });

    // Manual trigger for collapsing the worktree/repository section headers (see the big comment block
    // above `activate`). Ethan can bind this to a key or run it from the palette any time the worktree
    // sections have crept back open. v1.2.13: this is now a PLAIN collapse-all — it folds EVERY repo section
    // (including the primary/main one) and does NOT re-expand the primary afterward. Ethan explicitly asked
    // for this ("just do the normal collapse"): the old keep-primary-expanded behaviour re-opened the
    // primary's first change in a PREVIEW TAB to re-reveal it, and that tab popping open was annoying. A
    // plain collapse has none of that. v1.2.26 makes the startup path use this exact same clean behavior. No
    // ≥2-repo gate — if you ask for it explicitly, we act on whatever's there.
    let disposable14 = vscode.commands.registerCommand(
        "better-git-vscode.collapse-worktrees",
        async () => collapseScmRepositories("manual")
    );

    // ADD-CURRENT-WORKTREE-TO-WORKSPACE (v1.2.14). Pull the git worktree that the currently-open/under-review
    // file lives in into the VS Code workspace as a workspace folder, so Ethan can bring a worktree into his
    // sidebar without leaving the editor. Handler flow is: resolve the file -> resolve its worktree root ->
    // dedupe against existing folders -> add. See the ext-host-restart caveat at the add call (it MUST be last).
    let disposable16 = vscode.commands.registerCommand("better-git-vscode.add-current-worktree-to-workspace", async () => {
        // 1. Which file are we acting on? Prefer the SHARED "file under review" predicate (currentReviewFileUri
        //    handles diff / merge / new-file / deleted / binary review tabs, and — crucially for Ethan's flow —
        //    still resolves when keyboard focus is in the SCM panel so activeTextEditor is stale/undefined). Fall
        //    back to the focused text editor for a plainly-opened file.
        const fileUri = await currentReviewFileUriAsync() ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showInformationMessage("Better Git: No active file to resolve a git worktree from.");
            return;
        }
        // Normalise any diff-side / git: uri to the on-disk file path before we look up its repo.
        const onDiskUri = toFilePathUri(fileUri);
        if (!onDiskUri) {
            vscode.window.showInformationMessage("Better Git: Couldn't resolve the current file to a path on disk.");
            return;
        }
        // 2. Resolve the worktree root the file belongs to (git API primary, .git-walk fallback). Not in any git
        //    repo -> info message + return (NOT an error — this is a valid, expected situation).
        const worktreeRoot = resolveWorktreeRootUri(onDiskUri);
        if (!worktreeRoot) {
            vscode.window.showInformationMessage("Better Git: The current file isn't inside a git repository / worktree.");
            return;
        }
        // 3. Add it as a workspace folder — THE LAST THING THIS HANDLER DOES (see caveat below). The shared
        //    helper also dedupes roots and owns every user-facing success/failure/restart message.
        //
        // ── EXTENSION-HOST-RESTART CAVEAT (VS Code docs for workspace.updateWorkspaceFolders) ────────────────
        // Adding the FIRST extra folder to a SINGLE-FOLDER window transitions it to a MULTI-ROOT workspace,
        // which RESTARTS the extension host. When that happens updateWorkspaceFolders() may return BEFORE any
        // code after it runs (the host is being torn down), so the add MUST be the LAST statement in this
        // handler and we must NOT depend on its return value in that transition. We DO still honour the return
        // value in the non-transition case (adding to an already-multi-root workspace does NOT restart the host,
        // so `false` there genuinely means the add failed). `willBecomeMultiRoot` distinguishes the two: exactly
        // one existing folder AND no .code-workspace file open == the single→multi transition that restarts.
        addWorktreeRootToWorkspace(worktreeRoot, true);
        // NOTHING AFTER THIS POINT — the ext-host restart (single→multi transition) can cut the handler off here.
    });

    // Fold the existing one-off "Open index.html in System Browser" extension into Better Git. Explorer exposes
    // filename/scheme context keys, so its menu contribution is precise. Source Control does not: VS Code's SCM
    // resource-menu overlay contains only provider/group/state keys, which means a filename-gated SCM item is
    // hidden for every row. Keep that contribution provider-scoped, and repeat exact URI validation here so a
    // non-index row or direct executeCommand call can never open an arbitrary URI by accident.
    const openIndexInSystemBrowserCommand = vscode.commands.registerCommand(
        "better-git-vscode.open-index-in-system-browser",
        async (...targets: unknown[]) => {
            const resourceUri = findContextResourceUri(targets);
            if (!resourceUri) {
                await vscode.window.showErrorMessage("Better Git: VS Code did not provide the selected file.");
                return;
            }
            if (resourceUri.scheme !== "file" || path.basename(resourceUri.fsPath) !== "index.html") {
                await vscode.window.showWarningMessage("Better Git: This command only opens local index.html files.");
                return;
            }
            const opened = await vscode.env.openExternal(resourceUri);
            if (!opened) {
                await vscode.window.showErrorMessage(`Better Git: Couldn't open ${resourceUri.fsPath} in the system browser.`);
            }
        }
    );

    // Source Control's repository header menu passes the clicked SourceControl object. Copy the root folder's
    // basename silently, matching VS Code's built-in clipboard commands and keeping this frequent action fast.
    const copyWorktreeNameCommand = vscode.commands.registerCommand(
        "better-git-vscode.copy-worktree-name",
        async (...targets: unknown[]) => {
            const rootUri = findWorktreeRootUri(targets);
            const worktreeName = rootUri?.scheme === "file" ? path.basename(rootUri.fsPath) : "";
            if (!worktreeName) {
                await vscode.window.showErrorMessage("Better Git: VS Code did not provide the selected worktree.");
                return;
            }
            await vscode.env.clipboard.writeText(worktreeName);
        }
    );

    // External links and the palette share one ordered, on-demand path. There
    // are no startup scans, expansion loops or configuration writes.
    let worktreeLinkQueue: Promise<void> = Promise.resolve();
    let worktreeLinkGeneration = 0;
    let worktreeFocusLossGeneration = 0;
    const worktreePresentation = new DeferredWorktreePresentation(
        listener => vscode.window.onDidChangeWindowState(listener),
        () => vscode.window.state.focused, undefined,
        reason => debugLog("worktree-link", `Deferred native presentation ended: ${reason}.`));
    context.subscriptions.push(worktreePresentation);
    pendingWorktreePresentation = worktreePresentation;
    context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
        if (!state.focused) { worktreeFocusLossGeneration++; }
        worktreeUsage?.focusChanged(state.focused);
    }),
        { dispose: () => { worktreeUsage?.dispose(); worktreeUsage = undefined; } });
    const openWorktree = (root?: vscode.Uri, sourceLink?: vscode.Uri): Promise<void> => {
        worktreeUsage?.finish("newer-link");
        // Env Worktree clicks only; palette opens and automatic diff reveals are not human review evidence.
        worktreeUsage = sourceLink && root?.scheme === "file" && debugLoggingEnabled()
            ? new WorktreeUsage(root.fsPath, event => debugLog("worktree-usage", JSON.stringify(event)),
                frontmostAppBundleId, () => vscode.window.state.focused) : undefined;
        const usage = worktreeUsage;
        worktreePresentation.dispose("newer-link");
        const initialPresentationIsCurrent = worktreePresentation.checkpoint();
        const generation = ++worktreeLinkGeneration;
        const receivedAt = Date.now();
        const presentationExpiresAt = performance.now() + WORKTREE_PRESENTATION_MAX_AGE_MS;
        debugLog("worktree-link", `Received #${generation} for ${root?.fsPath ?? "selected worktree"}; focused=${vscode.window.state.focused}, host=${process.pid}, Code=${process.env.VSCODE_PID ?? "unknown"}.`);
        // Ethan wants to distinguish a delivered link from interrupted SCM expansion. Report receipt
        // before queued loading/focus work, with a distinct number for repeat clicks. Never await the
        // toast's dismissal, and do not notify for palette opens or mouse/wand review commands.
        // Ethan (2026-11-15): include the target, not just an opaque request number. Use the
        // decoded request path directly, so names/paths are visible even before Git can load it.
        // Put the name first: VS Code clips compact toasts, with the full path in the expanded message.
        if (sourceLink && vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("worktreeLinkNotifications", false)) {
            const targetPath = root?.fsPath;
            const targetName = targetPath ? path.basename(targetPath) || targetPath : "selected worktree";
            const receipt = `Better Git: ${targetName} — Worktree link received (#${generation}).`
                + (targetPath ? `\nPath: ${targetPath}` : "");
            void vscode.window.showInformationMessage(receipt)
                .then(undefined, error => debugLog("worktree-link", `Receipt notification unavailable: ${String(error)}`));
        }
        const isCurrent = () => generation === worktreeLinkGeneration;
        const next = worktreeLinkQueue.then(async () => {
            if (!isCurrent()) {
                debugLog("worktree-link", `Skipped superseded #${generation}.`);
                return;
            }
            let originAfterPresentation: { destination: string; editorProcessId: number; focusLossGeneration: number } | undefined;
            const restoreOrigin = async (stillOwned: () => boolean) => {
                const pending = originAfterPresentation;
                originAfterPresentation = undefined;
                if (!pending || !stillOwned() || !vscode.window.state.focused
                    || pending.focusLossGeneration !== worktreeFocusLossGeneration) { return; }
                const config = vscode.workspace.getConfiguration("better-git-vscode");
                if (config.get<boolean>("worktreeLinkKeepEditorFront", false) || !sourceLink
                    || worktreeLinkReturnApp(sourceLink, config.get<boolean>("worktreeLinkReturnFocus", false),
                        config.get<string>("worktreeLinkReturnApp", "")) !== pending.destination) { return; }
                // Check the receiving Code process inside AppKit too: a browser switch during native
                // process startup must win, even when the host has not received its focus event yet.
                try { await returnToApp(pending.destination, process.platform, undefined, undefined, undefined, pending.editorProcessId); }
                catch (error) { debugLog("worktree-focus", String(error)); }
            };
            const handoff = async () => {
                // Ethan (2026-11-06): finish Source Control first, then return to Codex once. Activating
                // another app before native list work can leave Graph as lastFocusedList or defer the
                // fold until its recent-link deadline expires; that is a focus failure, not slow Git.
                // Keep Editor Front retains its separately requested origin -> Code Cmd-Tab ordering.
                // Return mode does no app activation here: the URL receiver already owns the window.
                if (!sourceLink || !isCurrent()) { return; }
                let automaticOriginReturn = false;
                try {
                    // Read after path validation so disabling the setting during a queued open wins.
                    // Application-scoped settings cannot be enabled by the opened repository.
                    const config = vscode.workspace.getConfiguration("better-git-vscode");
                    const destination = worktreeLinkReturnApp(sourceLink,
                        config.get<boolean>("worktreeLinkReturnFocus", false),
                        config.get<string>("worktreeLinkReturnApp", ""));
                    if (!destination) { return; }
                    const keepEditorFront = config.get<boolean>("worktreeLinkKeepEditorFront", false);
                    const editorBundleId = ({ vscode: "com.microsoft.VSCode", "vscode-insiders": "com.microsoft.VSCodeInsiders" } as Record<string, string>)[vscode.env.uriScheme];
                    automaticOriginReturn = destination === "com.openai.codex" && !keepEditorFront;
                    try {
                        const editorProcessId = Number(process.env.VSCODE_PID);
                        if (keepEditorFront) {
                            debugLog("worktree-focus", `Starting Keep Editor Front handoff for #${generation} before repository loading.`);
                            const acknowledged = await returnToApp(destination, process.platform, undefined, editorBundleId, editorProcessId);
                            // App activation and this particular window's focus are separate. A completed
                            // helper call alone must not be logged as proof that SCM can take list focus.
                            debugLog("worktree-focus", `Finished Keep Editor Front handoff for #${generation} before repository loading; editorActive=${acknowledged === "editor-active"}, windowFocused=${vscode.window.state.focused}.`);
                        } else if (Number.isSafeInteger(editorProcessId)
                            && editorProcessId > 0 && editorProcessId <= 0x7fffffff) {
                            originAfterPresentation = { destination, editorProcessId, focusLossGeneration: worktreeFocusLossGeneration };
                            debugLog("worktree-focus", `Origin return for #${generation} waits until native presentation completes.`);
                        }
                    }
                    catch (error) { debugLog("worktree-focus", String(error)); }
                } finally {
                    if (automaticOriginReturn) { usage?.automaticReturnConfigured(); }
                    else { usage?.arm(); }
                }
            };
            let deferredRoot: vscode.Uri | undefined;
            const revealed = await openWorktreeInSourceControl(root,
                () => isCurrent() && initialPresentationIsCurrent(), value => { deferredRoot = value; }, handoff);
            debugLog("worktree-link", `Finished #${generation}: loaded=${revealed}, nativePending=${!!deferredRoot}, current=${isCurrent()}, elapsed=${Date.now() - receivedAt}ms.`);
            // If Code did not keep focus, a later manual return may finish this one recent fold but
            // must not bounce Ethan out again. This also covers a link delivered while already behind
            // another app, where there is no new focus-loss event to invalidate the captured generation.
            if (deferredRoot) { originAfterPresentation = undefined; }
            if (!revealed) { usage?.finish("open-incomplete"); }
            if (revealed && !deferredRoot) { await restoreOrigin(() => isCurrent() && initialPresentationIsCurrent()); }
            if (revealed && deferredRoot && isCurrent()) {
                const presentationRoot = deferredRoot;
                const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab;
                const originalReviewUri = currentReviewFileUri()?.toString();
                let admitted = false;
                const stillOwned = () => isCurrent()
                    && (admitted && originalReviewUri !== undefined
                        || vscode.window.tabGroups.activeTabGroup.activeTab === originalTab)
                    && currentReviewFileUri()?.toString() === originalReviewUri;
                debugLog("worktree-link", `Deferred native presentation for #${generation} until window focus.`);
                worktreePresentation.schedule(stillOwned, (isScheduled, beginPresentation) => {
                    const presentation = worktreeLinkQueue.then(async () => {
                        if (!isScheduled() || !stillOwned()) { return true; }
                        if (!vscode.window.state.focused) { return false; }
                        admitted = true;
                        debugLog("worktree-link", `Completing native presentation for #${generation} after focus.`);
                        let deferredAgain = false;
                        const revealed = await openWorktreeInSourceControl(presentationRoot,
                            () => isScheduled() && isCurrent() && (originalReviewUri === undefined
                                || currentReviewFileUri()?.toString() === originalReviewUri), () => { deferredAgain = true; },
                            undefined, beginPresentation);
                        if (revealed && deferredAgain && isScheduled() && isCurrent()) {
                            debugLog("worktree-link", `Native presentation for #${generation} interrupted by focus loss; still pending.`);
                            return false;
                        }
                        debugLog("worktree-link", `Native presentation for #${generation}: loaded=${revealed}, current=${isCurrent()}.`);
                        if (revealed && !deferredAgain) { await restoreOrigin(() => isScheduled() && stillOwned()); }
                        return true;
                    });
                    worktreeLinkQueue = presentation.then(() => undefined, error => debugLog("worktree-link", String(error)));
                    return presentation;
                }, presentationExpiresAt);
            }
        });
        worktreeLinkQueue = next.catch(() => undefined);
        return next;
    };
    const worktreeLinkCommand = vscode.commands.registerCommand(
        "better-git-vscode.open-worktree-in-source-control",
        (...targets: unknown[]) => openWorktree(targets.find(target => target instanceof vscode.Uri) as vscode.Uri | undefined ?? findWorktreeRootUri(targets))
    );
    // Own-source ordered transport only; the existing review transaction owns
    // file membership, staging and Undo. A missing packet must never stage early.
    type WandPacket=NonNullable<ReturnType<typeof parseWandReviewUri>>;
    let wandReview:{id:string;seq:number;direction:"next"|"previous";mode:"changes"|"files";received:number}|undefined;
    const wandPending=new Map<string,Map<number,WandPacket>>(),wandClosed=new Set<string>();
    let wandReviewQueue:Promise<void>=Promise.resolve();
    const retireWand=(id:string)=>{wandPending.delete(id);wandClosed.add(id);if(wandClosed.size>64){wandClosed.delete(wandClosed.values().next().value!);}};
    const cancelWandReview=async()=>{if(wandReview){retireWand(wandReview.id);}wandReview=undefined;await cancelMouseNavigationHold("wand");};
    const wandWatchdog=setInterval(()=>{if(wandReview&&performance.now()-wandReview.received>3000){void cancelWandReview();}},500);
    context.subscriptions.push({dispose:()=>{clearInterval(wandWatchdog);void cancelWandReview();}});
    const handleWandReview=async(uri:vscode.Uri):Promise<void>=>{
        const parsed=parseWandReviewUri(uri);
        if(!parsed || !vscode.window.state.focused){await cancelWandReview();wandPending.clear();return;}
        if(wandClosed.has(parsed.id)){return;}
        if(!wandPending.has(parsed.id)){
            if(wandPending.size>=8){return;}
            wandPending.set(parsed.id,new Map());
        }
        const pending=wandPending.get(parsed.id)!;
        if(pending.size>=64){await cancelWandReview();wandPending.delete(parsed.id);return;}
        pending.set(parsed.seq,parsed);
        if(parsed.phase==="begin"){
            if(parsed.seq!==1){retireWand(parsed.id);return;}
            // A live physical mouse hold rejects the wand. Keyboard review instead yields: the wand's Begin clears it unstaged.
            if(latestMouseHoldRequest?.active && mouseHoldRequests.get("wand")!==latestMouseHoldRequest
                && mouseHoldRequests.get("keyboard")!==latestMouseHoldRequest){retireWand(parsed.id);return;}
            if(wandReview?.id!==parsed.id){
                if(wandReview){await cancelWandReview();}
                wandReview={...parsed,seq:0,received:performance.now()};
            }
        }
        if(!wandReview || wandReview.id!==parsed.id){return;}
        wandReview.received=performance.now();
        while(wandReview && pending.has(wandReview.seq+1)){
            const packet=pending.get(wandReview.seq+1)!;pending.delete(packet.seq);wandReview.seq=packet.seq;
            if(packet.phase==="begin"){
                await vscode.commands.executeCommand("better-git-vscode.begin-mouse-navigation-hold",{source:"wand",direction:packet.direction});
                const request=mouseHoldRequests.get("wand");if(request){request.wandReviewMode=packet.mode;}
                await vscode.commands.executeCommand("better-git-vscode.stage-hold-ready","wand");
                setStagePreviewModeRequest("wand",packet.mode === "changes");
            }else if(packet.phase==="cancel"){await cancelWandReview();return;}
            else if(packet.phase==="step"){
                if(wandReview.mode==="files"){await adjustStageHoldSelectionRequest("wand",packet.direction==="next"?"down":"up");}
                else {await navigateStageHoldPreviewRequest("wand",packet.direction);}
            }else if(packet.phase==="finish"){
                const direction=wandReview.direction;retireWand(wandReview.id);wandReview=undefined;
                await vscode.commands.executeCommand("better-git-vscode.finish-mouse-navigation-hold",{source:"wand",direction});
            }
        }
    };
    const worktreeLinkHandler = vscode.window.registerUriHandler({
        async handleUri(uri) {
            if(uri.path.startsWith("/wand-review/")){
                wandReviewQueue=wandReviewQueue.then(()=>handleWandReview(uri)).catch(error=>{mouseDebug(`Magic Wand review failed: ${String(error)}`);return cancelWandReview();});
                return wandReviewQueue;
            }
            const modeMatch = /^\/mouse-stage-preview-mode\/(on|off)$/.exec(uri.path);
            if (modeMatch) {
                const query = new URLSearchParams(uri.query);
                const source = query.get("source");
                if (isMouseReviewSource(source)) {
                    // Agentic Mouse marks its compatibility bootstrap separately from a real toggle.
                    // Eyes entry now belongs to button-down. A late bootstrap must never undo a later
                    // intentional explosion-mode toggle, or arm a different hold from the same mouse.
                    // Older Better Git versions ignore this extra query and retain their bootstrap path.
                    if (modeMatch[1] === "on" && query.get("initial") === "1") {
                        mouseDebug(`${mouseSourceLabel(source)} initial preview URI ignored; button down owns the initial mode.`);
                        return;
                    }
                    await vscode.commands.executeCommand("better-git-vscode.set-mouse-stage-preview-mode", source, modeMatch[1] === "on");
                } else {
                    mouseDebug("Stage preview mode ignored, unknown mouse source.");
                }
                return;
            }
            const selectionMatch = /^\/mouse-stage-selection\/(up|down)$/.exec(uri.path);
            if (selectionMatch) {
                const source = new URLSearchParams(uri.query).get("source");
                if (isMouseReviewSource(source)) {
                    await adjustStageHoldSelectionRequest(source, selectionMatch[1] as "up" | "down");
                } else {
                    mouseDebug("Stage selection wheel ignored, unknown mouse source.");
                }
                return;
            }
            const previewMatch = /^\/mouse-stage-preview\/(next|previous)$/.exec(uri.path);
            if (previewMatch) {
                const source = new URLSearchParams(uri.query).get("source");
                if (isMouseReviewSource(source)) {
                    await navigateStageHoldPreviewRequest(
                        source,
                        previewMatch[1] as "next" | "previous"
                    );
                } else {
                    mouseDebug("Stage preview navigation ignored, unknown mouse source.");
                }
                return;
            }
            const root = parseWorktreeLink(uri);
            if (!root) {
                void vscode.window.showErrorMessage("Better Git: This link does not contain a valid worktree path.");
                return;
            }
            await openWorktree(vscode.Uri.file(root), uri);
        }
    });
    const copyWorktreeLinkCommand = vscode.commands.registerCommand(
        "better-git-vscode.copy-worktree-link",
        async (...targets: unknown[]) => {
            const root = findWorktreeRootUri(targets);
            if (root?.scheme !== "file") {
                void vscode.window.showErrorMessage("Better Git: VS Code did not provide a local git worktree.");
                return;
            }
            const config = vscode.workspace.getConfiguration("better-git-vscode");
            const destination = config.get<boolean>("worktreeLinkReturnFocus", false)
                ? config.get<string>("worktreeLinkReturnApp", "") : undefined;
            await vscode.env.clipboard.writeText(createWorktreeLink(root.fsPath, vscode.env.uriScheme, destination));
        }
    );

    // VS Code's built-in "Open Worktree in Current Window" replaces the window's current folder/workspace.
    // This header action deliberately does the additive operation instead: keep every existing workspace folder
    // and append the clicked worktree root, using the same single-folder -> multi-root safety helper as reveal.
    const addWorktreeToWorkspaceCommand = vscode.commands.registerCommand(
        "better-git-vscode.add-worktree-to-workspace",
        async (...targets: unknown[]) => {
            const rootUri = findWorktreeRootUri(targets);
            if (rootUri?.scheme !== "file" || !fs.existsSync(path.join(rootUri.fsPath, ".git"))) {
                await vscode.window.showErrorMessage("Better Git: VS Code did not provide a local git worktree.");
                return;
            }
            addWorktreeRootToWorkspace(rootUri, true);
            // NOTHING AFTER THIS POINT — adding the first extra folder can restart this extension host.
        }
    );

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // SMART MOUSE-BUTTON COMMANDS (smart-forward / smart-back)
    //
    // These are bound to Ethan's mouse Forward/Back buttons (via Karabiner -> F13/F17 -> these
    // commands). Strictly MOUSE-ONLY since v1.2.50: they used to ALSO hold the default QWERTY keyboard keys
    // alt+. / alt+, (the physical >/< keys), which silently inherited the intentional mouse-direction
    // flip below (commit 6043d05) — so on QWERTY keyboards ">" went BACKWARD through diff changes and
    // "<" went FORWARD, while Dvorak keyboards were fine (their physical >/< type v/w, which hit
    // next/previous-scm-change directly). v1.2.5 gave the QWERTY >/< keys back to the canonical
    // next/previous-scm-change commands (see _comment_dvorakMode_keybindings in package.json); these
    // smart commands have no default keyboard binding in either layout. v1.2.50 also removed the old
    // Dvorak-only alt+./alt+, compatibility defaults: after switching macOS back to QWERTY/GB while the
    // static dvorakMode setting remained enabled, the visible >/< keys reached these intentionally flipped
    // mouse commands while the canonical GB bindings were gated off. They give ONE pair of mouse buttons a
    // dual meaning depending on what's on screen:
    //   - When a side-by-side DIFF editor is the active tab  -> next/previous SCM change (review flow)
    //   - Anywhere else                                      -> classic editor back/forward navigation
    //
    // WHY we detect the diff via the TAB INPUT TYPE here, NOT via the `isInDiffEditor` keybinding context:
    //   The previous approach gated the mouse keys in keybindings.json with `when: isInDiffEditor` /
    //   `when: !isInDiffEditor`. That CONTEXT key is only true when the diff editor is the *focused/active*
    //   editor. In Ethan's review flow, keyboard focus is frequently in the Source Control panel (he's
    //   clicking files there) while the diff is merely VISIBLE in the editor area — so `isInDiffEditor`
    //   reads FALSE and the mouse button wrongly fell back to plain back/forward navigation mid-review.
    //   `vscode.window.tabGroups.activeTabGroup.activeTab` is FOCUS-INDEPENDENT: it tells us what tab is
    //   open in the active group regardless of whether focus is in the editor, the SCM panel, the terminal,
    //   etc. `tab.input instanceof vscode.TabInputTextDiff` is the canonical, stable way to ask "is the
    //   active tab a side-by-side text diff?" — exactly the situation where the mouse buttons should mean
    //   "next/previous change". We bake the decision into the extension so the keybindings can be
    //   UNCONDITIONAL (no flaky `when` clause).
    //
    // We REUSE the existing scm-change commands via executeCommand so there's a single source of truth for
    // the navigation logic (no duplication of goToNextDiff/goToPreviousDiff).
    //
    // Robustness: everything is wrapped in try/catch. TabInputTextDiff has been a stable VS Code API for
    // years (since ~1.67), but if it's ever unavailable (very old host) the `instanceof` check simply
    // evaluates false and we fall back to plain navigation — a safe default. Any unexpected throw also
    // falls back to plain navigation so a mouse click never becomes a no-op.
    let disposable9 = vscode.commands.registerCommand("better-git-vscode.smart-forward", async () => {
        await smartNavigate("forward");
    });
    let disposable10 = vscode.commands.registerCommand("better-git-vscode.smart-back", async () => {
        await smartNavigate("back");
    });

    // Reveal the current file in the Explorer — works even from a STAGED diff, where VS Code's built-in
    // "Reveal in Explorer" silently does nothing. WHY it's broken natively: the staged side of a diff is a
    // read-only git:-scheme VIRTUAL document (the index blob) with no node in the file:-based Explorer tree,
    // so reveal has nothing to select (open upstream bug: microsoft/vscode#240657). getActiveFileUri already
    // resolves that git: uri back to the on-disk file: uri (via the git: query's {path}), and revealInExplorer
    // is a supported command that reveals any file: uri (microsoft/vscode#94720). So we resolve, then reveal
    // THAT. If its git worktree is not already an Explorer workspace folder, add that root first — Explorer
    // cannot reveal out-of-workspace files. A custom shortcut must invoke this command UNCONDITIONALLY: the
    // `isInDiffEditor` context key becomes false when Source Control owns keyboard focus even while the diff is
    // still the active visible tab. Works from SCM row menus, staged/unstaged diffs, and plain editors.
    let disposable11 = vscode.commands.registerCommand("better-git-vscode.reveal-current-file-in-explorer", async (...targets: unknown[]) => {
        // A Source Control resource-menu invocation must act on the clicked row, not whichever editor/tab was
        // previously active. Keyboard and Command Palette invocations have no target and retain the tab-aware
        // active-file resolver that works while Source Control owns focus.
        const contextUri = toFilePathUri(findContextResourceUri(targets));

        // Capture the cursor + scroll position of the diff you're viewing FIRST (synchronously, before any
        // await), so the working file can open at the SAME spot instead of jumping to the top.
        // vscode.window.activeTextEditor is the diff's focused side: selection.active is the cursor,
        // visibleRanges[0].start is the top visible line.
        const src = vscode.window.activeTextEditor;
        const activeUri = currentReviewFileUri() ?? toFilePathUri(src?.document.uri);
        const preserveActivePosition = !contextUri || (!!activeUri && sameRootPath(activeUri, contextUri));
        const cursor = preserveActivePosition ? src?.selection.active : undefined;
        const topLine = preserveActivePosition && src?.visibleRanges && src.visibleRanges.length > 0
            ? src.visibleRanges[0].start.line
            : undefined;

        const uri = contextUri ?? await getActiveFileUri();
        if (!uri) {
            return;
        }
        // OPEN FIRST. Usually the reveal follows immediately, but adding the first extra workspace folder can
        // restart the extension host. Opening first makes that transition safe: the real editable file survives
        // the quick reload and VS Code auto-reveals it once its newly-added worktree root appears in Explorer.
        const editor = await vscode.window.showTextDocument(uri, { preview: false });

        // Restore cursor + scroll. Clamp to the working file's length: a partially-staged file's index content
        // can differ from the working tree, so the diff's line/column might not exist on disk.
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        if (cursor) {
            const line = Math.min(cursor.line, lastLine);
            const ch = Math.min(cursor.character, editor.document.lineAt(line).text.length);
            const pos = new vscode.Position(line, ch);
            editor.selection = new vscode.Selection(pos, pos);
        }
        if (topLine !== undefined) {
            const top = Math.min(topLine, lastLine);
            editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop); // match scroll: same top line
        } else if (cursor) {
            editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }

        // Explorer has no node for a file outside all workspace roots. Resolve its owning git worktree and add
        // that root automatically, reusing the same implementation as the explicit Command Palette action.
        if (!vscode.workspace.getWorkspaceFolder(uri)) {
            const autoAddWorktree = vscode.workspace
                .getConfiguration("better-git-vscode")
                .get<boolean>("autoAddWorktreeOnReveal", true);
            if (!autoAddWorktree) {
                vscode.window.showInformationMessage(
                    "Better Git: Opened the file, but its worktree isn't in the workspace and auto-add on reveal is turned off."
                );
                return;
            }
            const worktreeRoot = resolveWorktreeRootUri(uri);
            if (!worktreeRoot) {
                vscode.window.showInformationMessage(
                    "Better Git: Opened the file, but it isn't inside a workspace folder or git worktree to reveal."
                );
                return;
            }
            // Subscribe BEFORE updateWorkspaceFolders: workspaceFolders can reflect the new root synchronously
            // while Explorer's change event is still queued, and subscribing afterward can miss that event.
            const workspaceFolderReady = waitForFileWorkspaceFolder(uri);
            const addResult = addWorktreeRootToWorkspace(worktreeRoot, false);
            if (addResult === "failed" || addResult === "restart-expected") {
                return; // restart path continues via VS Code's normal active-file auto-reveal after reload
            }
            if (addResult === "added") {
                await workspaceFolderReady;
            }
        }

        // The file now has an Explorer node, so select it. Opening happened above because reveal alone only
        // highlights the tree node; this command promises both a normal editable file and its Explorer location.
        await vscode.commands.executeCommand("revealInExplorer", uri);
    });

    // MIRROR IMAGE of disposable11: that command goes diff -> working file at the same spot; THIS one goes
    // working file -> diff at the same spot. You're editing a file in a normal editor, hit this, and the
    // side-by-side "changes" view opens scrolled to the EXACT cursor + top line you were just looking at
    // (instead of git.openChange's default of jumping to the first change in the file). Bind it yourself in
    // keybindings.json — we intentionally ship NO default key for this one.
    let disposable12 = vscode.commands.registerCommand("better-git-vscode.open-change-at-position", async () => {
        // CAPTURE BEFORE OPENING THE DIFF. This is critical: git.openChange swaps the active editor to the
        // diff and typically moves the cursor to the file's first change — so if we read selection/scroll
        // AFTER the call we'd get the diff's position, not the working-file position we actually want to mirror.
        const src = vscode.window.activeTextEditor;
        if (!src) {
            return; // no active editor -> nothing to mirror, bail
        }
        const cursor = src.selection.active; // the cursor we want to reapply on the diff's right side
        const topLine = src.visibleRanges?.length ? src.visibleRanges[0].start.line : undefined; // top visible line (scroll)

        // Open the built-in "Open Changes" side-by-side diff for the active file (same as the SCM gutter/title
        // "Open Changes" action). This is what changes the active editor out from under us — hence the capture above.
        await vscode.commands.executeCommand("git.openChange");

        // DETECT THE DIFF + TIMING. We CANNOT detect the switch by uri: after git.openChange the diff's
        // MODIFIED (right) side is the SAME working file, so vscode.window.activeTextEditor.document.uri is
        // unchanged from before — a uri compare would always say "no switch happened". Instead we detect the
        // diff by the active TAB's input type: vscode.TabInputTextDiff means a side-by-side text diff tab is
        // active (the same focus-independent check the smart-mouse + badge code uses elsewhere in this file).
        // The switch is NOT guaranteed synchronous (git.openChange resolves the diff content asynchronously),
        // so we POLL: up to ~600ms in ~50ms steps, waiting until BOTH the active tab is a TabInputTextDiff AND
        // there's an activeTextEditor to apply the position to. If it never becomes a diff within the timeout
        // (e.g. an untracked/new file opens as a plain editor via vscode.open, not vscode.diff), we just fall
        // through and apply to whatever the active editor is — best-effort, never a no-op.
        const deadline = Date.now() + 600; // ~600ms total budget
        while (Date.now() < deadline) {
            const isDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
            if (isDiff && vscode.window.activeTextEditor) {
                break; // diff is up and we have an editor to position — stop polling
            }
            await new Promise((r) => setTimeout(r, 50)); // wait one ~50ms tick before re-checking
        }

        // Apply the captured position to the diff's right side (the now-active editor). SAME clamping logic as
        // disposable11: a file's diff side can differ in length from what we captured, so clamp the line to the
        // document's last line and the character to that line's length to avoid an out-of-range Position throw.
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return; // diff never produced an editor (e.g. binary) -> nothing to position, bail
        }
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const line = Math.min(cursor.line, lastLine);
        const ch = Math.min(cursor.character, editor.document.lineAt(line).text.length);
        const pos = new vscode.Position(line, ch);
        editor.selection = new vscode.Selection(pos, pos);
        if (topLine !== undefined) {
            const top = Math.min(topLine, lastLine);
            editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop); // match scroll: same top line
        }
    });

    // OVERLAY (supported API, no patching): badge the file currently under review with the configurable
    // double-fire marker via a
    // FileDecorationProvider. The badge renders on the row in the built-in Source Control panel (and the
    // Explorer/tabs), giving a "you are here" indicator on the real Git rows. Caveat: decorations key on the
    // file URI, so a partially-staged (dual-state) file gets the badge on BOTH its staged and unstaged rows.
    const reviewDecoEmitter = new vscode.EventEmitter<vscode.Uri[]>();
    let currentReviewUri: vscode.Uri | undefined; // file: URI of the file currently shown in a review view
    let currentReviewTab: vscode.Tab | undefined;
    let currentReviewStaged = false;
    const stageHoldSelections = new Map<MouseReviewSource, ActiveMouseStageSelection>();
    const releasedStageSelections = new WeakMap<MouseHoldRequest, ActiveMouseStageSelection>();
    let stagePreviewMode: { source: MouseReviewSource; request: MouseHoldRequest } | undefined;
    const selectionUris = (selection: ActiveMouseStageSelection | undefined): vscode.Uri[] =>
        selection ? selectedMouseStageItems(selection).map(change => change.uri) : [];
    const activeStageSelection = (source: MouseReviewSource, request: MouseHoldRequest): ActiveMouseStageSelection | undefined =>
        request.releaseQueued ? releasedStageSelections.get(request) : stageHoldSelections.get(source);
    const setActiveStageSelection = (source: MouseReviewSource, request: MouseHoldRequest, selection: ActiveMouseStageSelection): void => {
        if (request.releaseQueued) { releasedStageSelections.set(request, selection); }
        else { stageHoldSelections.set(source, selection); }
        requestScmLookahead();
    };
    const scmLookahead = new MacScmReviewLookahead(context.asAbsolutePath("dist/scm-review-scroll"),
        Number(process.env.VSCODE_PID), message => debugLog("scm-lookahead", message));
    let lookaheadRequest: MouseHoldRequest | undefined;
    let lookaheadPath: string | undefined;
    let ordinaryLookaheadPath: string | undefined;
    const requestOrdinaryScmLookahead = (): void => {
        // Ethan's ten-row rule also applies to normal Next/Previous and Stage + Next, not only
        // eyes/explosion batches (1.2.154 missed that scope). Read the existing Git API snapshot
        // in the background; never add a Git status process or wait in the navigation queue.
        const target = currentReviewUri;
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const current = () => vscode.window.state.focused && !latestMouseHoldRequest?.active
            && currentReviewUri?.toString() === target?.toString()
            && vscode.window.tabGroups.activeTabGroup.activeTab === tab;
        if (vscode.env.remoteName || !target || target.scheme !== "file" || !current()
            || ordinaryLookaheadPath === target.toString()) { return; }
        ordinaryLookaheadPath = target.toString();
        void getFileChanges(target).then(changes => {
            if (!current()) { return; }
            const entries = distinctUnstagedChanges(changes);
            const index = entries.findIndex(entry => entry.uri.toString() === target.toString());
            if (index < 0) { return; }
            scmLookahead.request({ path: target.fsPath, remainingFiles: entries.length - index - 1,
                sensitivity: vscode.workspace.getConfiguration("workbench.list").get<number>("mouseWheelScrollSensitivity", 1),
                current, restoreAfter: true });
        }).catch(error => debugLog("scm-lookahead", `Navigation presentation skipped: ${String(error)}`));
    };
    requestNavigationScmLookahead = requestOrdinaryScmLookahead;
    const requestScmLookahead = (): void => {
        // Ethan's "ten or so underneath": scroll the real Changes pane, never walk its selection.
        // Both eyes review and explosion/file mode share this presentation-only path. It must not
        // join the navigation or staging queues, and a released/cancelled hold cannot scroll later.
        const request = latestMouseHoldRequest;
        if (vscode.env.remoteName || !vscode.window.state.focused || !request?.active || request.releaseQueued) { return; }
        const entry = [...stageHoldSelections.entries()].find(([, selection]) => selection.request === request);
        const selection = entry?.[1], target = selection?.items[selection.cursorIndex]?.uri;
        if (!entry || !selection || !target || target.scheme !== "file" || target.toString() !== currentReviewUri?.toString()
            || (lookaheadRequest === request && lookaheadPath === target.toString())) { return; }
        lookaheadRequest = request; lookaheadPath = target.toString();
        ordinaryLookaheadPath = undefined;
        scmLookahead.request({ path: target.fsPath, remainingFiles: selection.items.length - selection.cursorIndex - 1,
            sensitivity: vscode.workspace.getConfiguration("workbench.list").get<number>("mouseWheelScrollSensitivity", 1),
            current: () => {
                const live = stageHoldSelections.get(entry[0]);
                return vscode.window.state.focused && request === latestMouseHoldRequest && request.active
                    && !request.releaseQueued && currentReviewUri?.toString() === target.toString()
                    && live?.items[live.cursorIndex]?.uri.toString() === target.toString();
            } });
    };
    context.subscriptions.push(new vscode.Disposable(() => {
        if (requestNavigationScmLookahead === requestOrdinaryScmLookahead) { requestNavigationScmLookahead = () => undefined; }
        scmLookahead.dispose();
    }), vscode.window.onDidChangeWindowState(state => {
        if (!state.focused) { scmLookahead.cancel(); lookaheadRequest = undefined; ordinaryLookaheadPath = undefined; }
    }));
    const repaintStagePreviewMode = (selection?: ActiveMouseStageSelection): void => {
        const uri = selection?.items[selection.cursorIndex]?.uri;
        const affected = [uri, currentReviewUri].filter((candidate): candidate is vscode.Uri => candidate !== undefined);
        if (affected.length) { reviewDecoEmitter.fire(affected); }
    };
    const clearStageHoldFeedback = (source?: MouseReviewSource) => {
        // Ordinary navigation clears hold feedback too. Do not cancel its still-loading presentation
        // on each hunk press; only an actual held batch owns this cancellation.
        if (lookaheadRequest) { scmLookahead.cancel(); }
        lookaheadRequest = undefined; lookaheadPath = undefined;
        // Another gesture, immediate staging or ordinary navigation ends an unreleased keyboard review unstaged,
        // so a later keyboard finish can never fall back to staging its starting file.
        if (keyboardReviewEndsWithFeedbackClear(keyboardReviewHolds(), source)) {
            retireKeyboardReviewRequest("another review action replaced it");
        }
        const affected = source
            ? selectionUris(stageHoldSelections.get(source))
            : [...stageHoldSelections.values()].flatMap(selectionUris);
        if (stagePreviewMode && (!source || stagePreviewMode.source === source)) {
            repaintStagePreviewMode(stageHoldSelections.get(stagePreviewMode.source));
            stagePreviewMode = undefined;
        }
        if (source) { stageHoldSelections.delete(source); } else { stageHoldSelections.clear(); }
        if (affected.length) { reviewDecoEmitter.fire(affected); }
        syncKeyboardReviewContext();
    };
    clearStageHoldFeedbackRequest = clearStageHoldFeedback;
    const stageHeldSelectionOnFocusLoss = (): Promise<void> => {
        // Ethan's app-switch rule applies to every release-to-stage hold, including keyboard Option review:
        // stage earlier marked files, excluding the current preview even in file mode. The Oct 29 keyboard
        // integration explicitly excluded keyboard from the Oct 7 mouse fix. Editor/gutter clicks inside Code still
        // neither cancel nor commit a hold. Keep the wand's explicit confirmation separate. — Codex (model version unavailable)
        // Snapshot before invalidation retires the physical gesture. Queued/in-flight
        // wheel work must not add files after the user has left this window.
        const request = latestMouseHoldRequest;
        // Leaving Code is not the wand's explicit Middle double-click confirmation; it still cancels.
        const owner = [...stageHoldSelections.entries()].find(([source, selection]) =>
            source !== "wand"
            && request?.active && request.stageReadyRequested && selection.request === request
            && mouseHoldRequests.get(source) === request
            && mouseNavigationOrigins.get(source)?.holdRequest === request);
        const origin = owner ? mouseNavigationOrigins.get(owner[0]) : undefined;
        const shown = currentReviewFileUri()?.toString();
        const selected = owner ? selectedMouseStageItems(owner[1], true)
            // A preview open may still be settling, or the user may have clicked
            // another editor. Never stage the visible file on an interruption either.
            .filter(change => change.uri.toString() !== shown) : [];
        invalidateChangeNavigation();
        if (!owner || !origin || selected.length === 0) { return Promise.resolve(); }
        mouseDebug(`${mouseSourceLabel(owner[0])} app switch committing ${selected.length} marked files, excluding the current preview.`);
        return serializeChangeNavigation(() => runStageCommand(async () => {
            await stageSelectedFilesAndAdvance(origin.direction, selected, noNavigationCheckpoint, origin.view, false);
        }), true);
    };
    prepareStageHoldReleaseRequest = (source, request) => {
        // Regression reports 2026-09-19 and 2026-10-28: clicking the gutter, shrinking the range or a slow
        // preview must not leave explosion badges that silently do nothing on release. Navigation may be
        // superseded by editing, but this captured release transaction is not a navigation cancellation.
        // Ethan: if the explosion marks say a group will stage, its real release must commit that group.
        // Retain the selection for already-admitted wheel work; no elapsed-time/scroll-idle heuristic may
        // expire a genuine release or turn a busy queue into an implicit cancel.
        // Capture mode before feedback clears; queued ratchets still determine the final endpoint.
        // Keyboard mode captures its current eyes/file inclusion policy before the release clears feedback.
        request.excludePreviewOnRelease = request.wandReviewMode === "changes" || (source === "keyboard" && request.keyboardExcludePreview !== false)
            || (stagePreviewMode?.source === source && stagePreviewMode.request === request);
        const selection = stageHoldSelections.get(source);
        if (selection?.request === request) { releasedStageSelections.set(request, selection); }
        clearStageHoldFeedback(source);
    };
    setStagePreviewModeRequest = (source, enabled) => {
        const request = mouseHoldRequests.get(source);
        if (enabled) {
            // The readiness shortcut and mode URI use different OS transports. Retain the
            // mode intent for this exact hold if the URI arrives first; decorations and
            // wheel navigation still require readiness to create its stage selection.
            if (!request?.active || request.releaseQueued || request !== latestMouseHoldRequest) {
                mouseDebug(`${mouseSourceLabel(source)} stage preview mode ignored, no stage-ready hold is active.`);
                return;
            }
            const previous = stagePreviewMode;
            stagePreviewMode = { source, request };
            repaintStagePreviewMode(previous ? stageHoldSelections.get(previous.source) : undefined);
            repaintStagePreviewMode(stageHoldSelections.get(source));
        } else if (stagePreviewMode?.source === source && stagePreviewMode.request === request) {
            const selection = stageHoldSelections.get(source);
            stagePreviewMode = undefined;
            repaintStagePreviewMode(selection);
        }
        mouseDebug(`${mouseSourceLabel(source)} stage preview mode ${enabled ? "on" : "off"}.`);
    };
    takeStageHoldSelectionRequest = (source, request) => {
        const selection = releasedStageSelections.get(request) ?? stageHoldSelections.get(source);
        if (!selection || selection.request !== request) { return undefined; }
        const selected = selectedMouseStageItems(selection, request.excludePreviewOnRelease);
        releasedStageSelections.delete(request);
        if (stageHoldSelections.get(source) === selection) { stageHoldSelections.delete(source); }
        reviewDecoEmitter.fire(selected.map(change => change.uri));
        // Keyboard/wand ranges can rebase their direction at the starting endpoint. Capture the
        // final reviewed member with this immutable batch, not the original Next/Previous command.
        return { changes: selected, lastStaged: (selection.initialDirection === "previous"
            ? selected[0] : selected[selected.length - 1])?.uri };
    };
    adjustStageHoldSelectionRequest = (source, direction) => {
        // Like eyes ratchets, admit file ratchets before release and keep their exact request.
        const request = mouseHoldRequests.get(source);
        if (!request?.active || request.releaseQueued || request !== latestMouseHoldRequest || !request.stageReadyRequested) {
            mouseDebug(`${mouseSourceLabel(source)} stage selection wheel ignored, no stage-ready hold is active.`);
            return Promise.resolve();
        }
        return serializeChangeNavigation(async check => {
            const origin = mouseNavigationOrigins.get(source);
            const selection = activeStageSelection(source, request);
            if (!vscode.window.state.focused) {
                mouseDebug(`${mouseSourceLabel(source)} stage selection wheel ignored, VS Code is not focused.`);
                return;
            }
            if ((!request.active && !request.releaseQueued) || request !== latestMouseHoldRequest
                || origin?.holdRequest !== request || selection?.request !== request) {
                mouseDebug(`${mouseSourceLabel(source)} stage selection wheel ignored, no stage-ready hold is active.`);
                return;
            }
            const before = selectionUris(selection);
            const moved = { ...moveMouseStageSelection(selection, direction === "up" ? -1 : 1), request };
            setActiveStageSelection(source, request, moved);
            const after = selectionUris(moved);
            if (!request.releaseQueued) { reviewDecoEmitter.fire([...before, ...after]); }
            const preview = moved.items[moved.cursorIndex];
            if (preview && moved.cursorIndex !== selection.cursorIndex) {
                // Git can replace an initially-opened preview tab shortly after its command promise resolves.
                // Keep that delayed, same-target transition owned by this live hold so it cannot cancel the
                // range before the next wheel detent arrives. Other targets supersede only queued navigation.
                ownedMouseStagePreview = { request, uri: preview.uri.toString() };
                await openNavigationTarget(preview, check);
                if (direction === "down") { await landChangeForForwardReview(preview, check); }
                else { adoptLandedReviewPosition(preview, check); } // Preserve file-mode reverse preview behavior.
                requestCurrentHunkOverviewMarkerRefresh();
            }
            mouseDebug(`${mouseSourceLabel(source)} stage selection moved ${direction}; ${after.length} ${after.length === 1 ? "file" : "files"} selected${preview ? `, previewing ${path.basename(preview.uri.fsPath)}` : ""}.`);
        });
    };
    navigateStageHoldPreviewRequest = (source, direction, inactive) => {
        // Admit at input arrival. A normal release may arrive before these queued ratchets execute; they
        // still belong before that release and must finish before it snapshots the files to stage.
        const request = mouseHoldRequests.get(source);
        if (!request?.active || request.releaseQueued || request !== latestMouseHoldRequest || !request.stageReadyRequested) {
            mouseDebug(`${mouseSourceLabel(source)} stage preview navigation ignored, no stage-ready hold is active.`);
            return inactive ? serializeChangeNavigation(inactive) : Promise.resolve();
        }
        return serializeChangeNavigation(async check => {
            const origin = mouseNavigationOrigins.get(source);
            const selection = activeStageSelection(source, request);
            if (!vscode.window.state.focused) {
                mouseDebug(`${mouseSourceLabel(source)} stage preview navigation ignored, VS Code is not focused.`);
                return;
            }
            if ((!request.active && !request.releaseQueued) || request !== latestMouseHoldRequest
                || origin?.holdRequest !== request || selection?.request !== request) {
                mouseDebug(`${mouseSourceLabel(source)} stage preview navigation ignored, no stage-ready hold is active.`);
                if (inactive) { await inactive(check); }
                return;
            }
            // Wheel review only edits the pending set. The source-owned release is the
            // sole staging boundary, including ratchets already queued before it.
            const preWheelView = captureMouseReviewView();
            const previewAtFileBoundary = async (boundaryCheck: NavigationCheckpoint): Promise<void> => {
                const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
                if (activeTab?.input instanceof vscode.TabInputTextDiff && !visibleEditorForActiveTab()) {
                    mouseDebug(`${mouseSourceLabel(source)} stage preview boundary deferred, diff editor is not ready.`);
                    return;
                }
                const currentUri = await getActiveFileUri();
                boundaryCheck();
                const currentIndex = selection.items.findIndex(change => change.uri.toString() === currentUri?.toString());
                const plan = planMouseStagePreviewBoundary(selection, currentIndex, direction);
                if (!plan || (!request.active && !request.releaseQueued) || activeStageSelection(source, request) !== selection) {
                    mouseDebug(`${mouseSourceLabel(source)} stage preview boundary ignored, current file is outside the held worktree.`);
                    return;
                }
                const live = new Set(distinctUnstagedChanges(await getFileChanges(selection.items[currentIndex].uri))
                    .map(change => change.uri.toString()));
                boundaryCheck();
                if (!live.has(selection.items[currentIndex].uri.toString()) || (plan.target && !live.has(plan.target.uri.toString()))) {
                    mouseDebug(`${mouseSourceLabel(source)} stage preview boundary ignored, review file is no longer unstaged.`);
                    return;
                }
                const before = selectionUris(selection);
                const nextSelection = { ...plan.selection, request };
                setActiveStageSelection(source, request, nextSelection);
                if (!request.releaseQueued) { reviewDecoEmitter.fire([...before, ...selectionUris(nextSelection)]); }
                if (plan.target) {
                    ownedMouseStagePreview = { request, uri: plan.target.uri.toString() };
                    if (direction === "previous") {
                        await openNavigationTarget(plan.target, boundaryCheck);
                        await landChangeForBackwardReview(plan.target, boundaryCheck);
                    } else { await openForwardNavigationTarget(plan.target, boundaryCheck); }
                } else {
                    // Native diff commands wrap within the same file. At the outer
                    // worktree boundary retain the review position instead.
                    await restoreMouseReviewView({ ...origin, change: selection.items[currentIndex], view: preWheelView }, boundaryCheck);
                }
                const count = selectionUris(nextSelection).length;
                mouseDebug(`${mouseSourceLabel(source)} stage preview marked ${count} ${count === 1 ? "file" : "files"}; ${plan.target ? `previewing ${path.basename(plan.target.uri.fsPath)}` : "end of this worktree"}. Release will stage.`);
            };
            ownedMouseStagePreview = undefined;
            await (direction === "next"
                ? goToNextDiffOnce(check, previewAtFileBoundary)
                : goToPreviousDiffOnce(check, previewAtFileBoundary));
            requestCurrentHunkOverviewMarkerRefresh();
            if (activeStageSelection(source, request) === selection) {
                const count = selectionUris(selection).length;
                mouseDebug(`${mouseSourceLabel(source)} stage preview navigated ${direction} within the file; ${count} marked ${count === 1 ? "file remains" : "files remain"}.`);
            }
        });
    };
    context.subscriptions.push(new vscode.Disposable(() => {
        if (clearStageHoldFeedbackRequest === clearStageHoldFeedback) {
            clearStageHoldFeedbackRequest = () => undefined;
        }
        prepareStageHoldReleaseRequest = () => undefined;
        setStagePreviewModeRequest = () => undefined;
        adjustStageHoldSelectionRequest = async () => undefined;
        navigateStageHoldPreviewRequest = async () => undefined;
        takeStageHoldSelectionRequest = () => undefined;
        betterGitOutputChannel?.dispose();
        betterGitOutputChannel = undefined;
    }));
    const stageHoldReadyCommand = vscode.commands.registerCommand("better-git-vscode.stage-hold-ready", (source: unknown) => {
        if (!isMouseReviewSource(source)) {
            mouseDebug("Hold threshold ignored, unknown mouse source.");
            return;
        }
        return markStageHoldReady(source);
    });
    // Extraction of the existing stage-hold-ready command's selection setup. Mouse/wand still use the command;
    // keyboard review now shares the setup directly, with the wand's reversible endpoint behavior.
    const markStageHoldReady = (source: MouseReviewSource): Promise<void> => {
        // Capture input ownership now, even while button-down navigation is still queued.
        const request = mouseHoldRequests.get(source);
        if (request?.active && request === latestMouseHoldRequest) {
            request.stageReadyRequested = true;
        }
        return serializeChangeNavigation(async check => {
            if (!vscode.window.state.focused) {
                mouseDebug(`${mouseSourceLabel(source)} event ignored, VS Code is not focused.`);
                return;
            }
            const origin = mouseNavigationOrigins.get(source);
            if (request) {
                if (!request.active && !request.releaseQueued) {
                    mouseDebug(`${mouseSourceLabel(source)} event ignored, hold was cancelled.`);
                    return;
                }
                if (request !== latestMouseHoldRequest) {
                    mouseDebug(`${mouseSourceLabel(source)} event ignored, another hold is in progress.`);
                    return;
                }
                if (origin?.holdRequest !== request) {
                    // No stage-ready decoration can appear, so a later adjacent press still means Undo.
                    request.stageReadyRequested = false;
                    mouseDebug(`${mouseSourceLabel(source)} event ignored, no review item was captured.`);
                    return;
                }
                // Repeated threshold delivery belongs to this same hold, not a new selection.
                // Ethan's marked group and intentional eyes/explosion toggle must survive it, including
                // readiness already queued before release. Preserve the request-owned release snapshot too.
                if (activeStageSelection(source, request)?.request === request) {
                    mouseDebug(`${mouseSourceLabel(source)} duplicate hold threshold ignored; pending selection preserved.`);
                    return;
                }
                if (origin.navigateOnButtonDown) {
                    const restored = await restoreMouseReviewView(origin, check);
                    if (!restored) {
                        mouseDebug(`${mouseSourceLabel(source)} event ignored, pre-press view could not be restored.`);
                        return;
                    }
                    await refreshReviewDecoration();
                    requestCurrentHunkOverviewMarkerRefresh();
                    check();
                }
                // Release/cancel may arrive while the editor was opening. Never re-light a completed hold.
                if ((!request.active && !request.releaseQueued) || request !== latestMouseHoldRequest) {
                    mouseDebug(`${mouseSourceLabel(source)} event ignored, hold ended while restoring the view.`);
                    return;
                }
            } else if (!currentReviewUri || currentReviewTab !== vscode.window.tabGroups.activeTabGroup.activeTab) {
                mouseDebug(`${mouseSourceLabel(source)} event ignored, no hold in progress.`);
                return;
            }
            const target = origin?.held ? origin.change.uri : currentReviewUri;
            if (target) {
                const changes = distinctUnstagedChanges(await getFileChanges(target));
                check(); // Focus loss may retire this hold while Git's file list is loading.
                const anchorIndex = changes.findIndex(change => change.uri.toString() === target.toString());
                // Wand and keyboard have no physically held Next/Previous button fixing the selection direction.
                const selection = createMouseStageSelection(changes, anchorIndex, origin?.direction ?? "next",
                    source === "wand" || source === "keyboard");
                if (!selection) {
                    if (request?.active && request === latestMouseHoldRequest) { request.stageReadyRequested = false; }
                    mouseDebug(`${mouseSourceLabel(source)} hold threshold ignored, review item is no longer unstaged.`);
                    return;
                }
                const previous = selectionUris(request ? activeStageSelection(source, request) : stageHoldSelections.get(source));
                if (request) { setActiveStageSelection(source, request, { ...selection, request }); }
                else { stageHoldSelections.set(source, { ...selection }); }
                if (!request?.releaseQueued) { reviewDecoEmitter.fire([...previous, target]); }
                const direction = origin?.direction;
                mouseDebug(direction
                    ? origin?.navigateOnButtonDown
                        ? `${mouseSourceLabel(source)} ${mouseDirectionLabel(direction)} hold threshold reached; pre-press view restored. Release will stage.`
                        : `${mouseSourceLabel(source)} ${mouseDirectionLabel(direction)} hold threshold reached; review view stayed still. Release will stage.`
                    : `${mouseSourceLabel(source)} hold threshold reached; release will stage.`);
            }
        });
    };
    const stageHoldClearCommand = vscode.commands.registerCommand("better-git-vscode.stage-hold-clear", (source: unknown) => {
        if (!isMouseReviewSource(source)) {
            mouseDebug("Feedback clear ignored, unknown mouse source.");
            return;
        }
        clearStageHoldFeedback(source);
        const request = mouseHoldRequests.get(source);
        return serializeChangeNavigation(async check => {
            const origin = mouseNavigationOrigins.get(source);
            const shortDirection = request?.active && request.shortReleasePending && origin?.holdRequest === request
                && !origin.navigateOnButtonDown ? origin.direction : undefined;
            if (request) { request.active = false; }
            if (shortDirection) {
                if (origin?.holdRequest === request) { mouseNavigationOrigins.delete(source); }
                if (mouseHoldRequests.get(source) === request) { mouseHoldRequests.delete(source); }
                if (latestMouseHoldRequest === request) { latestMouseHoldRequest = undefined; }
                await (shortDirection === "next" ? goToNextDiffOnce(check) : goToPreviousDiffOnce(check));
                requestCurrentHunkOverviewMarkerRefresh();
                mouseDebug(`${mouseSourceLabel(source)} ${mouseDirectionLabel(shortDirection)} short release navigated.`);
            } else {
                mouseDebug(request
                    ? `${mouseSourceLabel(source)} hold feedback cleared.`
                    : `${mouseSourceLabel(source)} feedback clear ignored, no hold in progress.`);
            }
        });
    });
    const stageHoldAdjustCommand = vscode.commands.registerCommand(
        "better-git-vscode.adjust-mouse-stage-selection",
        (source: unknown, direction: unknown) => {
            if (!isMouseReviewSource(source) || (direction !== "up" && direction !== "down")) {
                mouseDebug("Stage selection wheel ignored, invalid arguments.");
                return;
            }
            return adjustStageHoldSelectionRequest(source, direction);
        }
    );
    const stageHoldPreviewNavigationCommand = vscode.commands.registerCommand(
        "better-git-vscode.navigate-mouse-stage-preview",
        (source: unknown, direction: unknown) => {
            if (!isMouseReviewSource(source) || (direction !== "next" && direction !== "previous")) {
                mouseDebug("Stage preview navigation ignored, invalid arguments.");
                return;
            }
            return navigateStageHoldPreviewRequest(source, direction);
        }
    );
    const stagePreviewModeCommand = vscode.commands.registerCommand(
        "better-git-vscode.set-mouse-stage-preview-mode",
        (source: unknown, enabled: unknown) => {
            if (!isMouseReviewSource(source) || typeof enabled !== "boolean") {
                mouseDebug("Stage preview mode ignored, invalid arguments.");
                return;
            }
            setStagePreviewModeRequest(source, enabled);
        }
    );

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // KEYBOARD REVIEW COMMANDS — Ethan's keyboard eyes mode (see keyboardReviewSession.ts).
    //
    // Begin captures the current review file in place and enters eyes mode. Step reviews changes like the eyes
    // wheel: within a file it only moves, and at a file boundary it adds the file being left to the pending
    // selection (moving back removes it). Finish stages that selection once through the same exact batch
    // transaction and Undo as a mouse release, excluding the current eyes preview. Cancel discards the
    // selection and restores the starting view. Nothing touches the index before finish.
    //
    // Ethan holds Option and taps/releases Shift to enter eyes (Review changes), then alternate eyes
    // and explosion (Stage files). Only releasing every gesture key finishes. Shift+Option+Next/Previous
    // remains immediate staging and consumes its Shift tap. Mouse and wand lifecycles are unchanged.
    const keyboardReviewContext = new KeyboardReviewContext(active => {
        void Promise.resolve(vscode.commands.executeCommand("setContext", KEYBOARD_REVIEW_CONTEXT_KEY, active))
            .catch(error => debugLog("keyboard-review", `Could not publish keyboard review state: ${String(error)}`));
    });
    publishKeyboardReviewContext = active => keyboardReviewContext.update(active);
    const beginKeyboardReview = (direction: "next" | "previous"): Promise<void> => {
        const decision = decideKeyboardReviewBegin(keyboardReviewHolds());
        if (decision !== "begin") {
            mouseDebug(decision === "already-active"
                ? "Keyboard review begin ignored, a keyboard review is already in progress."
                : "Keyboard review begin ignored, a mouse or wand hold is in progress.");
            return Promise.resolve();
        }
        clearStageHoldFeedback();
        lastNavDirection = direction;
        // Like a release-only mouse hold, Begin captures the exact review file and view without moving.
        const begun = navigateWithMouseOrigin(direction, "keyboard", true, false);
        const request = mouseHoldRequests.get("keyboard");
        if (request) {
            request.keyboardReviewDirection = direction;
            request.keyboardReviewMode = "changes";
            request.keyboardExcludePreview = true;
        }
        const ready = markStageHoldReady("keyboard");
        setStagePreviewModeRequest("keyboard", true);
        syncKeyboardReviewContext();
        mouseDebug(`Keyboard ${mouseDirectionLabel(direction)} review started.`);
        // A staged, clean or no-longer-unstaged starting file yields no pending selection. End that review
        // unstaged so later presses navigate normally rather than steering an empty selection.
        const settle = () => {
            if (request && !request.releaseQueued && stageHoldSelections.get("keyboard")?.request !== request
                && retireKeyboardReviewRequest("there was no unstaged change to review", request)) {
                clearStageHoldFeedback("keyboard");
            }
        };
        return Promise.all([begun, ready]).then(settle, error => { settle(); throw error; });
    };
    const stepKeyboardReview = (direction: "next" | "previous"): Promise<void> => {
        lastNavDirection = direction;
        const holds = keyboardReviewHolds();
        if (decideKeyboardReviewStep(holds) === "navigate") {
            // No live keyboard review: the same press is ordinary change navigation, never a lost keystroke.
            clearStageHoldFeedback();
            return navigateWithMouseOrigin(direction, undefined);
        }
        const request = holds.keyboard;
        if (request?.keyboardReviewMode === "files") {
            return adjustStageHoldSelectionRequest("keyboard", direction === "next" ? "down" : "up");
        }
        return navigateStageHoldPreviewRequest("keyboard", direction, async check => {
            // The review ended, or never established its selection, after this press was admitted.
            if (retireKeyboardReviewRequest("its pending selection was no longer available", request)) {
                clearStageHoldFeedback("keyboard");
            }
            await (direction === "next" ? goToNextDiffOnce(check) : goToPreviousDiffOnce(check));
            requestCurrentHunkOverviewMarkerRefresh();
        });
    };
    const finishKeyboardReview = (): Promise<void> => {
        const request = liveKeyboardReview(keyboardReviewHolds());
        if (!request) {
            mouseDebug("Keyboard review finish ignored, no keyboard review is in progress.");
            syncKeyboardReviewContext();
            return Promise.resolve();
        }
        return stageReviewHoldOrigin("keyboard", request.keyboardReviewDirection ?? lastNavDirection, true);
    };
    const cancelKeyboardReview = (): Promise<void> => {
        keyboardGesture.cancel();
        const cancelled = cancelMouseNavigationHold("keyboard");
        if (!cancelled) { mouseDebug("Keyboard review cancel ignored, no keyboard review is in progress."); }
        syncKeyboardReviewContext();
        return cancelled ?? Promise.resolve();
    };
    const setKeyboardReviewMode = (mode: KeyboardReviewMode, direction = lastNavDirection): Promise<void> => {
        let request = liveKeyboardReview(keyboardReviewHolds());
        let begun: Promise<void> = Promise.resolve();
        if (!request) {
            if (mode === "normal") { return Promise.resolve(); }
            begun = beginKeyboardReview(direction);
            request = liveKeyboardReview(keyboardReviewHolds());
            if (!request) { return begun; }
            // Begin admits synchronously; mode intent is set before queued selection/navigation can run.
        }
        request.keyboardReviewMode = mode;
        if (mode !== "normal") { request.keyboardExcludePreview = mode === "changes"; }
        setStagePreviewModeRequest("keyboard", mode === "changes");
        reviewDecoEmitter.fire(selectionUris(stageHoldSelections.get("keyboard")));
        mouseDebug(`Keyboard review mode: ${mode}.`);
        return begun;
    };
    const toggleKeyboardReview = (direction: "next" | "previous"): Promise<void> => {
        const request = liveKeyboardReview(keyboardReviewHolds());
        const mode = request?.keyboardReviewMode ?? "normal";
        return setKeyboardReviewMode(mode === "changes" ? "files" : "changes", direction);
    };
    let keyboardGestureWork: Promise<void> = Promise.resolve();
    const trackKeyboardGesture = (work: Promise<void>): void => {
        keyboardGestureWork = work;
        void work.catch(error => debugLog("keyboard-review", String(error)));
    };
    const keyboardGesture = new KeyboardReviewGesture(
        mode => trackKeyboardGesture(setKeyboardReviewMode(mode)),
        () => trackKeyboardGesture(finishKeyboardReview()),
        () => liveKeyboardReview(keyboardReviewHolds())?.keyboardReviewMode ?? "normal"
    );
    const observeKeyboardState = (state: ReviewKeyState): void => {
        if (state.navigationKeys === undefined) { keyboardNavigationRepeats.reset(); }
        else { keyboardNavigationRepeats.sample(state.navigationKeys); }
        keyboardGesture.sample(state);
    };
    const keyboardKeyMonitor = new MacReviewKeyMonitor(
        observeKeyboardState,
        () => {
            keyboardNavigationRepeats.reset();
            keyboardGesture.reset();
            if (liveKeyboardReview(keyboardReviewHolds())) { void cancelKeyboardReview(); }
        },
        message => debugLog("keyboard-review", message)
    );
    keyboardKeyMonitor.focus(vscode.window.state.focused);
    const keyboardReviewCommands = [
        vscode.commands.registerCommand("better-git-vscode.toggle-keyboard-review", (args?: unknown) => {
            const direction = args === undefined ? lastNavDirection : parseKeyboardReviewDirection(args);
            if (!direction) { return; }
            return toggleKeyboardReview(direction);
        }),
        vscode.commands.registerCommand("better-git-vscode.begin-keyboard-review", (args: unknown) => {
            const direction = parseKeyboardReviewDirection(args);
            if (!direction) { mouseDebug("Keyboard review begin ignored, invalid direction."); return; }
            return beginKeyboardReview(direction);
        }),
        vscode.commands.registerCommand("better-git-vscode.step-keyboard-review", (args: unknown) => {
            const direction = parseKeyboardReviewDirection(args);
            if (!direction) { mouseDebug("Keyboard review step ignored, invalid direction."); return; }
            return stepKeyboardReview(direction);
        }),
        vscode.commands.registerCommand("better-git-vscode.finish-keyboard-review", () => finishKeyboardReview()),
        vscode.commands.registerCommand("better-git-vscode.cancel-keyboard-review", () => cancelKeyboardReview()),
        new vscode.Disposable(() => { keyboardKeyMonitor.dispose(); publishKeyboardReviewContext = () => undefined; }),
    ];
    const reviewDecorationProvider: vscode.FileDecorationProvider = {
        onDidChangeFileDecorations: reviewDecoEmitter.event,
        provideFileDecoration(uri) {
            const previewSelection = stagePreviewMode && stageHoldSelections.get(stagePreviewMode.source);
            // The explicit ratchet past an outer boundary approves its final file (explosion). Keep eyes
            // decoration and release exclusion on the shared model's same endpoint decision.
            const previewIndex = previewSelection && mouseStagePreviewIndex(previewSelection);
            const previewCurrentUri = previewIndex !== undefined ? previewSelection?.items[previewIndex]?.uri : undefined;
            if (stagePreviewMode?.request.active && previewSelection?.request === stagePreviewMode.request
                && previewCurrentUri?.path.toLowerCase() === uri.path.toLowerCase()) {
                return {
                    badge: "👀",
                    tooltip: "Stage preview mode is on.",
                    color: new vscode.ThemeColor("descriptionForeground"),
                    propagate: false,
                };
            }
            const activeSelection = [...stageHoldSelections.values()].find(selection =>
                selectedMouseStageItems(selection).some(change => change.uri.path.toLowerCase() === uri.path.toLowerCase()));
            if (activeSelection && vscode.workspace.getConfiguration("better-git-vscode").get<string>("currentFileBadge", "🔥🔥")) {
                const count = selectedMouseStageItems(activeSelection, !!stagePreviewMode && stagePreviewMode.request === activeSelection.request).length;
                return {
                    badge: "💥💥",
                    // Mouse scroll instructions do not apply to the keyboard modifier gesture.
                    tooltip: activeSelection.request === mouseHoldRequests.get("keyboard") ? undefined : count === 1
                        ? "Release to stage. Scroll to select more files."
                        : `Release to stage ${count} files. Scroll to change the selection.`,
                    color: new vscode.ThemeColor("charts.orange"),
                    propagate: false,
                };
            }
            if (currentReviewUri && uri.path.toLowerCase() === currentReviewUri.path.toLowerCase()) {
                // Badge text is configurable (default a colorful emoji for maximum visibility). The Source
                // Control panel ignores decoration `color` (its renderer forces colors:false), so the emoji's
                // own color is what makes it pop there; the `color` still applies in the Explorer + editor tabs.
                // Default badge is double fire 🔥🔥 (Ethan's preferred default; still user-overridable via the
                // better-git-vscode.currentFileBadge setting). The package.json config default MUST match this literal.
                const badgeSetting = vscode.workspace.getConfiguration("better-git-vscode").get<string>("currentFileBadge", "🔥🔥");
                if (!badgeSetting) {
                    return undefined; // empty setting => badge disabled
                }

                // VS Code caps the badge at 2 GRAPHEMES and drops the whole decoration if it's longer, so take
                // the first two graphemes. Intl.Segmenter keeps multi-codepoint emoji intact — a naive
                // slice(0,2) would cut a two-emoji badge like "🔥🔥" down to one (each emoji is 2 UTF-16 units).
                // Ethan's "fire's being put out": an Index/staged review must be visibly different
                // from unstaged flames. Keep the badge-off setting and eyes/explosion priorities;
                // this is presentation only, never permission to stage an Index/history view.
                let badge = currentReviewStaged ? "🧯" : badgeSetting;
                try {
                    // (Intl as any): Intl.Segmenter may not be in the project's TS lib types, but it exists at runtime.
                    const seg = new (Intl as any).Segmenter(undefined, { granularity: "grapheme" });
                    badge = [...seg.segment(badge)].slice(0, 2).map((s: any) => s.segment).join("");
                } catch {
                    badge = Array.from(badge).slice(0, 2).join(""); // fallback by code point if Segmenter is unavailable
                }
                return { badge, tooltip: "Better Git VS Code: reviewing this file", color: new vscode.ThemeColor("charts.blue"), propagate: false };
            }
            return undefined;
        },
    };

    // The native diff overview ruler uses red/green for every changed range, but offers no public way to
    // recolour only its current change. Overlay the hunk Better Git most recently navigated to with VS Code's
    // theme-aware find-match accent. The Full lane deliberately paints over the native marker for this one
    // range, leaving every other hunk's red/green marker untouched.
    const currentHunkOverviewDecoration = vscode.window.createTextEditorDecorationType({
        // Ethan wants the CURRENT hunk visibly distinct, not a replacement color for every diff hunk.
        // Opaque high-contrast colours are much easier to find than the theme's often translucent find marker.
        overviewRulerColor: "#ffd400",
        overviewRulerLane: vscode.OverviewRulerLane.Full,
        light: { overviewRulerColor: "#7c3aed" },
        dark: { overviewRulerColor: "#ffd400" },
    });
    let currentHunkOverviewEditor: vscode.TextEditor | undefined;
    let currentHunkOverviewMarker: { uri: string; start: number; end: number } | undefined;
    const clearCurrentHunkOverviewMarker = (): void => {
        try {
            currentHunkOverviewEditor?.setDecorations(currentHunkOverviewDecoration, []);
        } catch {
            // A tab can dispose its TextEditor between the tab event and this queued refresh.
        }
        currentHunkOverviewEditor = undefined;
        currentHunkOverviewMarker = undefined;
    };
    const applyCurrentHunkOverviewMarker = (
        editor: vscode.TextEditor,
        fileUri: vscode.Uri,
        hunk: ModifiedHunk,
    ): void => {
        try {
            currentHunkOverviewEditor?.setDecorations(currentHunkOverviewDecoration, []);
        } catch {
            // The old editor may already be disposed; the new active editor still gets the marker below.
        }
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const start = Math.min(Math.max(0, hunk.start), lastLine);
        const end = Math.min(Math.max(start, hunk.end), lastLine);
        editor.setDecorations(currentHunkOverviewDecoration, [
            new vscode.Range(new vscode.Position(start, 0), editor.document.lineAt(end).range.end),
        ]);
        currentHunkOverviewEditor = editor;
        currentHunkOverviewMarker = { uri: fileUri.toString(), start, end };
    };

    // Recompute off the command's critical path. Rapid navigation coalesces to the latest request, so a slow
    // Git diff cannot repaint a hunk from a tab or cursor position the user has already left.
    let currentHunkMarkerRefreshRequest = 0;
    let currentHunkMarkerRefreshRunning = false;
    let currentHunkMarkerRefreshPromise: Promise<void> = Promise.resolve();
    const refreshCurrentHunkOverviewMarker = (): Promise<void> => {
        currentHunkMarkerRefreshRequest++;
        if (currentHunkMarkerRefreshRunning) {
            return currentHunkMarkerRefreshPromise;
        }
        currentHunkMarkerRefreshRunning = true;
        currentHunkMarkerRefreshPromise = (async () => {
            let handledRequest = -1;
            while (handledRequest !== currentHunkMarkerRefreshRequest) {
                handledRequest = currentHunkMarkerRefreshRequest;
                const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
                    if (handledRequest === currentHunkMarkerRefreshRequest) {
                        clearCurrentHunkOverviewMarker();
                    }
                    continue;
                }
                const editor = visibleEditorForActiveTab();
                const fileUri = currentReviewFileUri();
                if (!editor || !fileUri) {
                    if (handledRequest === currentHunkMarkerRefreshRequest) {
                        clearCurrentHunkOverviewMarker();
                    }
                    continue;
                }
                const active = await getActiveChange();
                const geometry = await getModifiedSideHunkGeometry(fileUri, active?.staged === true);
                if (
                    handledRequest !== currentHunkMarkerRefreshRequest ||
                    vscode.window.tabGroups.activeTabGroup.activeTab !== tab ||
                    visibleEditorForActiveTab() !== editor
                ) {
                    continue;
                }
                const line = editor.selection.active.line;
                const hunk =
                    hunkContainingLine(geometry.hunks, line, 0) ??
                    hunkContainingLine(geometry.hunks, line, 1) ??
                    geometry.deletionStops
                        .filter(stop => Math.abs(stop - line) <= 1)
                        .sort((left, right) => Math.abs(left - line) - Math.abs(right - line))
                        .map(stop => ({ start: stop, end: stop }))[0];
                if (hunk) {
                    applyCurrentHunkOverviewMarker(editor, fileUri, hunk);
                } else {
                    clearCurrentHunkOverviewMarker();
                }
            }
        })().finally(() => {
            currentHunkMarkerRefreshRunning = false;
        });
        return currentHunkMarkerRefreshPromise;
    };
    const installedCurrentHunkMarkerRefresh = () => {
        void refreshCurrentHunkOverviewMarker();
    };
    requestCurrentHunkOverviewMarkerRefresh = installedCurrentHunkMarkerRefresh;
    context.subscriptions.push(new vscode.Disposable(() => {
        if (requestCurrentHunkOverviewMarkerRefresh === installedCurrentHunkMarkerRefresh) {
            requestCurrentHunkOverviewMarkerRefresh = () => undefined;
        }
        clearCurrentHunkOverviewMarker();
    }));
    // Recompute the current review file whenever the active editor/tab changes, and refresh the decoration
    // for both the old and new file so the badge moves with you. Resolution is async because current VS Code
    // exposes some non-text diffs (notably modified images) as an active Tab with no public `input` resource.
    const documentWarmup = new ReviewDocumentWarmup();
    context.subscriptions.push(documentWarmup);
    let warmupTab: vscode.Tab | undefined;
    const warmAdjacentReviewDocuments = (uri: vscode.Uri | undefined): void => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab === warmupTab) { return; }
        warmupTab = tab;
        // Stage & Next / Previous already choose their target from fresh SCM state before
        // Git add. Warm only neighbouring small text documents after the current review
        // loads; this never opens an editor, predicts the fire badge or waits in an input path.
        const current = () => vscode.window.tabGroups.activeTabGroup.activeTab === tab;
        if (!uri || !tab) { documentWarmup.request([], current); return; }
        documentWarmup.request([async () => {
            const entries = distinctUnstagedChanges(await getFileChanges(uri));
            if (!current()) { return; }
            const index = entries.findIndex(entry => entry.uri.toString() === uri.toString());
            if (index < 0) { return; }
            const neighbours = [entries[index + 1], entries[index - 1]].filter((entry): entry is FileChange => !!entry);
            const tasks: (() => Promise<unknown>)[] = [];
            for (const entry of neighbours) {
                // Binary/media/merge/deleted views keep their established lazy open path.
                if (entry.status !== GitStatus.MODIFIED && entry.status !== GitStatus.UNTRACKED) { continue; }
                if (!/\.(?:[cm]?[jt]sx?|json|html?|css|scss|sass|less|md|txt|ya?ml|toml|xml|svg|py|sh|go|rs|java|swift|sql)$/i.test(entry.uri.path)) { continue; }
                tasks.push(async () => {
                    const stat = await vscode.workspace.fs.stat(entry.uri);
                    if (!current() || stat.type !== vscode.FileType.File || stat.size > 256 * 1024) { return; }
                    await vscode.workspace.openTextDocument(entry.uri);
                    if (current() && entry.status === GitStatus.MODIFIED) {
                        await vscode.workspace.openTextDocument(toGitUri(entry.uri, "~"));
                    }
                });
            }
            if (current()) { documentWarmup.request(tasks, current); }
        }], current);
    };
    const applyReviewDecorationUri = (next: vscode.Uri | undefined, staged = false) => {
        const prev = currentReviewUri;
        const nextTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        // A Git preview can transiently resolve to the old file or no file while its replacement tab renders.
        // Decoration refreshes and manual editor changes cannot cancel a live physical hold.
        // A keyboard review is protected from Begin, before its queued selection exists.
        const liveStageSelection = [...stageHoldSelections.values()].some(selection =>
            selection.request?.active && selection.request === latestMouseHoldRequest)
            || liveKeyboardReview(keyboardReviewHolds()) !== undefined;
        if ((currentReviewTab !== nextTab || prev?.toString() !== next?.toString()) && !liveStageSelection) {
            clearStageHoldFeedback();
        }
        currentReviewUri = next;
        currentReviewTab = nextTab;
        currentReviewStaged = staged;
        requestScmLookahead();
        warmAdjacentReviewDocuments(next);
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

    // Coalesce rapid tab/editor events without losing the last one. A second request received while an image
    // path lookup is using the clipboard is resolved in a fresh loop iteration after that lookup finishes; it
    // never reuses the previous tab's in-flight result. The tab identity check inside the async resolver is the
    // final stale-result guard.
    let reviewDecorationRefreshRequest = 0;
    let reviewDecorationRefreshRunning = false;
    let reviewDecorationRefreshPromise: Promise<void> = Promise.resolve();
    const refreshReviewDecoration = (): Promise<void> => {
        reviewDecorationRefreshRequest++;
        if (reviewDecorationRefreshRunning) {
            return reviewDecorationRefreshPromise;
        }
        reviewDecorationRefreshRunning = true;
        reviewDecorationRefreshPromise = (async () => {
            let handledRequest = -1;
            while (handledRequest !== reviewDecorationRefreshRequest) {
                handledRequest = reviewDecorationRefreshRequest;
                const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                const next = await currentReviewFileUriAsync();
                // Reuse this tab's already-resolved path for opaque media; do not perform a
                // second workbench/clipboard lookup just to choose its badge.
                const active = next ? await getActiveChange(next) : null;
                let staged = active?.staged === true;
                if (next && active?.staged === null) {
                    // Some native image comparisons omit their public input. Infer a badge only for
                    // an unambiguous staged-only path; never guess the side of a partially staged image.
                    const repo = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1).getRepository(next);
                    const contains = (changes: any[] = []) => changes.some(change =>
                        change.uri.path.toLowerCase() === next.path.toLowerCase());
                    staged = contains(repo?.state.indexChanges) && !contains(repo?.state.workingTreeChanges)
                        && !contains(repo?.state.untrackedChanges) && !contains(repo?.state.mergeChanges);
                }
                // Only the latest request may move/clear the badge. If another event arrived during the await,
                // loop once more and resolve that newer active tab instead.
                if (handledRequest === reviewDecorationRefreshRequest && tab === vscode.window.tabGroups.activeTabGroup.activeTab) {
                    applyReviewDecorationUri(next, staged);
                }
            }
        })().finally(() => {
            reviewDecorationRefreshRunning = false;
        });
        return reviewDecorationRefreshPromise;
    };

    const confirmedReview = (uri: vscode.Uri, staged: boolean): void => {
        // Use only a verified open. Invalidate an older async badge lookup so it cannot
        // move the fire marker back while an opaque editor's path lookup finishes.
        reviewDecorationRefreshRequest++;
        applyReviewDecorationUri(uri, staged);
    };
    confirmOpenedReview = confirmedReview;
    context.subscriptions.push(new vscode.Disposable(() => {
        if (confirmOpenedReview === confirmedReview) { confirmOpenedReview = () => undefined; }
    }));

    // CLICK TARGET for the status bar item: reopen the diff of the last file staged via the extension, so
    // Ethan can review it and unstage it if it was an accident. We REUSE the extension's existing diff
    // machinery rather than re-deriving diff sides: getFileChanges() builds the same staged/unstaged list the
    // navigation uses, and openChangeEntry() already knows how to open the correct HEAD↔index diff for any
    // staged status (incl. the INDEX_ADDED/INDEX_DELETED "file not found" cases — see openChangeEntry). So we
    // look up the STAGED entry for lastStagedUri in that list and hand it to openChangeEntry. There is NO
    // extension API to focus a Source Control row, hence opening the diff (which is what lets him unstage) is
    // the most useful click action. Internal command (registered, but contributed with no keybinding).
    let disposable13 = vscode.commands.registerCommand("better-git-vscode.reveal-last-staged-file", async () => {
        if (!lastStagedUri) {
            return; // nothing staged via the extension yet this session
        }
        const target = lastStagedUri.path.toLowerCase();
        // Resolve the list from the repository that OWNS the remembered file, not from whichever worktree
        // happens to be active when the status-bar item is clicked. In a multi-root/worktree workspace Ethan
        // can stage in repo A, continue reviewing in repo B, then click this persistent badge. The old
        // active-tab-derived lookup searched repo B, missed the staged entry, and fell back to opening the raw
        // working file. That was visibly a no-op when the working file no longer existed (for example a
        // staged-new file deleted after staging), even though its index blob was still available to diff.
        const fileChanges = await getFileChanges(lastStagedUri);
        // Prefer the STAGED (index) entry — that's the diff that shows what got staged and lets him unstage it.
        const stagedEntry = fileChanges.find((c) => c.staged && c.uri.path.toLowerCase() === target);
        if (stagedEntry) {
            await openChangeEntry(stagedEntry);
            return;
        }
        // Fallback: the file may no longer be staged (already committed, or unstaged again since), so it's not
        // in the staged group anymore. Just open the on-disk file so the click is never a dead no-op.
        try {
            await vscode.window.showTextDocument(lastStagedUri, { preview: true });
        } catch {
            // File gone (e.g. it was a staged deletion that got committed) — nothing sensible to open; ignore.
        }
    });

    // Live-react to the feature toggle: flipping better-git-vscode.showLastStagedInStatusBar OFF hides the
    // item immediately; flipping it back ON re-shows the current last-staged file (if any) without waiting for
    // the next stage. We react live (rather than only reading at update time) so the bar disappears the moment
    // Ethan unchecks the setting — less surprising than it lingering until the next stage.
    let configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("better-git-vscode.showStageAndAdvanceInStatusBar")) {
            if (showStageAndAdvanceStatusBarEnabled()) {
                stageAndAdvanceStatusBarItem.show();
            } else {
                stageAndAdvanceStatusBarItem.hide();
            }
        }
        if (e.affectsConfiguration("better-git-vscode.showLastStagedInStatusBar") && lastStagedStatusBarItem) {
            if (showLastStagedEnabled() && lastStagedUri) {
                recordLastStaged(lastStagedUri); // re-render + show with the file we last staged
            } else {
                lastStagedStatusBarItem.hide();
            }
        }
        if (e.affectsConfiguration("better-git-vscode.currentFileBadge") && currentReviewUri) {
            // The provider reads the setting lazily; firing the active URI makes a changed badge/empty toggle
            // repaint immediately rather than waiting for the next editor switch.
            reviewDecoEmitter.fire([currentReviewUri]);
        }
    });

    // Default/off activation resolves synchronously without touching Source Control. The only enabled startup
    // behavior is the double-opt-in, one-shot built-in collapse; there is no exact-state restoration path.
    const whenScmTreeStateSettled = runExperimentalScmStartup(context);

    context.subscriptions.push(
        disposable, disposable2, disposable3, disposable4, disposable5, disposable6, disposable7, disposable8,
        disposable9, disposable10, disposable11, disposable12, disposable13, disposable14, disposable15,
        disposable16, // add-current-worktree-to-workspace (v1.2.14)
        undoLastStageDisposable,
        keyboardStageRepeatGuardDisposable, // ends any keyboard hold and stops the osascript key-state monitor
        stageBeforeMouseNavigation,
        ...mouseHoldCommands,
        stageHoldReadyCommand, stageHoldClearCommand, stageHoldAdjustCommand,
        stageHoldPreviewNavigationCommand, stagePreviewModeCommand,
        ...keyboardReviewCommands,
        vscode.window.onDidChangeWindowState(state => {
            // Capture the interruption batch BEFORE stopping its modifier reader. That reader resets and
            // cancels any still-live keyboard hold; doing it first silently erased the set before capture.
            // Capture retires ownership synchronously, so late key-up/duplicate blur cannot stage it twice.
            if (!state.focused) { void stageHeldSelectionOnFocusLoss(); }
            keyboardKeyMonitor.focus(state.focused);
        }),
        openIndexInSystemBrowserCommand,
        copyWorktreeNameCommand,
        worktreeLinkCommand, worktreeLinkHandler, copyWorktreeLinkCommand,
        addWorktreeToWorkspaceCommand,
        commitMessageGenerator,
        stageAndAdvanceStatusBarItem, // fixed-location Stage & Next mouse target (v1.2.20)
        lastStagedStatusBarItem, // disposed cleanly on deactivate
        currentHunkOverviewDecoration,
        configListener,
        reviewDecoEmitter,
        vscode.window.registerFileDecorationProvider(reviewDecorationProvider),
        vscode.window.tabGroups.onDidChangeTabs(() => {
            observeNavigationTab();
            trackUnstagedReviewPosition();
            void refreshReviewDecoration();
            requestCurrentHunkOverviewMarkerRefresh();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => {
            observeNavigationTab();
            trackUnstagedReviewPosition();
            void refreshReviewDecoration();
            requestCurrentHunkOverviewMarkerRefresh();
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            const manual = event.kind === vscode.TextEditorSelectionChangeKind.Mouse
                || event.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
            if (manual && event.textEditor === trackedPositionEditor && !applyingReviewPosition) {
                // A real edit/cursor move after switching files wins over a queued position restore.
                pendingReviewPosition = undefined;
            }
            rememberUnstagedReviewPosition(event.textEditor);
            if (event.textEditor === visibleEditorForActiveTab() &&
                (event.kind === vscode.TextEditorSelectionChangeKind.Mouse || event.kind === vscode.TextEditorSelectionChangeKind.Keyboard)) {
                worktreeUsage?.reviewInput("cursor-move", currentReviewFileUri()?.fsPath);
                worktreePresentation.dispose("cursor-move");
                invalidateChangeNavigation(true, "manual editor selection");
                // A manual cursor move is no longer a Better Git-selected hunk. Clear immediately instead of
                // spawning a Git diff on every arrow-key repeat; the next Better Git navigation repaints it.
                clearCurrentHunkOverviewMarker();
            }
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges(event => {
            observeReviewViewport(event.textEditor);
            rememberUnstagedReviewPosition(event.textEditor);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length && event.document === visibleEditorForActiveTab()?.document) {
                worktreeUsage?.reviewInput("document-edit", currentReviewFileUri()?.fsPath);
                worktreePresentation.dispose("document-edit");
                invalidateChangeNavigation(true, "reviewed document changed"); // Git hunk coordinates no longer describe the displayed revision.
                clearCurrentHunkOverviewMarker();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            rememberReviewViewport(visibleEditorForActiveTab());
            trackUnstagedReviewPosition();
            // Moving the batch-selection endpoint intentionally opens a different preview editor. Keep the
            // orange range alive for both preview and manual transitions until the gesture ends.
            if (![...stageHoldSelections.values()].some(selection => selection.request?.active)
                && !liveKeyboardReview(keyboardReviewHolds())) {
                clearStageHoldFeedback();
            }
            void refreshReviewDecoration();
            requestCurrentHunkOverviewMarkerRefresh();
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => trackUnstagedReviewPosition()),
        new vscode.Disposable(() => {
            pendingReviewPosition = undefined; trackedPositionTab = undefined; trackedPositionInput = undefined; trackedPositionEditor = undefined;
            trackedPositionUri = undefined; restoredPositionTab = undefined; reviewFilePositions.clear();
        }),
        vscode.window.onDidChangeActiveNotebookEditor(() => {
            if (![...stageHoldSelections.values()].some(selection => selection.request?.active)
                && !liveKeyboardReview(keyboardReviewHolds())) {
                clearStageHoldFeedback();
            }
            void refreshReviewDecoration();
            requestCurrentHunkOverviewMarkerRefresh();
        })
    );

    // Activation can occur after a review tab is already open, in which case no subsequent editor event is
    // guaranteed. Seed the provider from the current active tab once instead of waiting for user movement.
    void refreshReviewDecoration();
    requestCurrentHunkOverviewMarkerRefresh();
    rememberReviewViewport(visibleEditorForActiveTab());
    trackUnstagedReviewPosition();

    // Ethan wants fresh Default mouse holds to stay in eyes after restarts, without manual re-enablement.
    // Publish only after this real host registered its commands. Agentic Mouse verifies EVERY live host
    // against these process-bound receipts; installed extension files alone cannot prove readiness.
    // Test/Development hosts never advertise into the normal profile. This background write never gates input.
    if (process.platform === "darwin" && context.extensionMode === vscode.ExtensionMode.Production) {
        const capability = createReviewHostCapability({
            directory: path.join(homedir(), "Library", "Application Support", "BetterGit", "active-hosts"),
            extensionVersion: context.extension.packageJSON.version, codePid: process.env.VSCODE_PID,
            log: message => debugLog("review-host", message),
        });
        context.subscriptions.push({ dispose: () => { void capability.dispose(); } });
    }

    return {
        whenScmTreeStateSettled,
        whenStageTransactionsSettled: () => stageTransactionObserver?.settled() ?? Promise.resolve(),
        whenStageHistorySettled: () => stageHistoryLog?.settled() ?? Promise.resolve(),
        getStageHistoryFile: () => stageHistoryLog?.filePath,
        whenReviewDecorationSettled: () => reviewDecorationRefreshPromise,
        getCurrentReviewUri: () => currentReviewUri?.toString(),
        getReviewDecorationBadge: (uri: vscode.Uri) => {
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                const decoration = reviewDecorationProvider.provideFileDecoration(
                    uri,
                    tokenSource.token
                ) as vscode.FileDecoration | undefined;
                return decoration?.badge;
            } finally {
                tokenSource.dispose();
            }
        },
        whenCurrentHunkOverviewMarkerSettled: () => currentHunkMarkerRefreshPromise,
        getCurrentHunkOverviewMarker: () => currentHunkOverviewMarker && { ...currentHunkOverviewMarker },
        getScmTreeCommandTrace: () => [...scmTreeCommandTrace],
        getMouseDebugTrace: () => [...mouseDebugTrace],
        clearMouseDebugTrace: () => { mouseDebugTrace.length = 0; },
        isKeyboardReviewActive: () => keyboardReviewContext.active,
        ...(context.extensionMode === vscode.ExtensionMode.Development || context.extensionMode === vscode.ExtensionMode.Test
            ? { sampleKeyboardReviewKeys: observeKeyboardState,
                getRememberedReviewPosition: (uri: vscode.Uri) => reviewFilePositions.get(uri.toString()),
                whenWorktreePresentationSettled: () => worktreeLinkQueue,
                whenKeyboardGestureSettled: () => keyboardGestureWork } : {}),
    };
}

// Returns the on-disk file: URI represented by every public active-tab review shape (resolving staged `git:`
// sides back to the file path), or undefined when the public tab input cannot identify a current change.
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
        // mergeChanges (unresolved conflicts) counts as a change too (Codex review 2026-07-04): with the
        // DEFAULT git.mergeEditor=false a conflict opens as the plain working file, and this shared "is this a
        // change?" predicate feeds currentReviewFileUri's plain/custom branches — so without mergeChanges a
        // plain merge-conflict tab was invisible to repo-selection, the late-collapse guard, and the badge.
        return (
            inAny(repo.state.indexChanges) ||
            inAny(repo.state.workingTreeChanges) ||
            inAny(repo.state.untrackedChanges) ||
            inAny(repo.state.mergeChanges)
        );
    } catch {
        return false; // git extension not ready / API shape changed — just don't badge
    }
};

// TRUE only when `uri` is specifically an UNRESOLVED MERGE CONFLICT (in repo.state.mergeChanges). Distinct
// from isChangeFileUri (which is true for any change) because the smart-mouse gate must treat a plain
// merge-conflict working-file editor as review WITHOUT also treating an ordinary modified file opened in a
// plain editor as review — the latter is deliberately excluded from mouse change-nav so thumb-Back keeps its
// normal browser-history meaning while you're editing. (Codex review 2026-07-04, plain-merge follow-up.)
const isMergeConflictFileUri = (uri: vscode.Uri): boolean => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        if (!repo) {
            return false;
        }
        const p = uri.path.toLowerCase();
        return (repo.state.mergeChanges ?? []).some((c: any) => c.uri.path.toLowerCase() === p);
    } catch {
        return false; // git extension not ready / API shape changed
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

// Resolve the git WORKTREE ROOT that a given on-disk file belongs to, returned as a folder file: uri (v1.2.14).
//
// PRIMARY path — the git extension's Repository model. `git.getRepository(uri)` returns the Repository whose
// working tree contains `uri`, and the git extension treats EACH linked worktree as its OWN Repository — so
// `repo.rootUri` IS that worktree's root directory (NOT the shared/main clone). That's exactly what "add the
// worktree this file lives in" means, so we prefer it. This is the SAME git API + getRepository lookup that
// isChangeFileUri/isMergeConflictFileUri already use, so we stay consistent with how the rest of the extension
// maps a file to its repo.
//
// FALLBACK — if the git extension isn't ready yet, or doesn't yet know about this file's repo, walk UP the
// directory tree from the file until we hit a `.git` marker. Note a linked worktree's marker is a `.git` FILE
// (containing `gitdir: …/.git/worktrees/<name>`), not a directory — `fs.existsSync` matches either, and we
// return the directory that CONTAINS the marker (that dir is the worktree root). Returns undefined only when
// the file is inside no git repository at all (caller then shows an info message, never an error).
const resolveWorktreeRootUri = (fileUri: vscode.Uri): vscode.Uri | undefined => {
    // PRIMARY — ask the git extension which repository/worktree owns this file.
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(fileUri);
        if (repo?.rootUri) {
            return repo.rootUri as vscode.Uri; // each worktree is its own Repository -> rootUri = worktree root
        }
    } catch {
        // git API not ready / shape changed — fall through to the filesystem walk below.
    }
    // FALLBACK — walk parent dirs looking for a `.git` marker (a dir for a normal clone, a FILE for a worktree).
    try {
        let dir = path.dirname(fileUri.fsPath);
        // Loop guard: stop when dirname stops changing (we've hit the filesystem root and can climb no further).
        for (let prev = ""; dir && dir !== prev; prev = dir, dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, ".git"))) {
                return vscode.Uri.file(dir); // this dir contains the .git marker -> it's the worktree root
            }
        }
    } catch {
        // fs error (permissions etc.) — give up; caller treats undefined as "not in a git repo".
    }
    return undefined;
};

// Add one resolved git worktree root to Explorer and report what happened. This is shared by the explicit
// "Add current worktree" command and reveal-current-file: revealing a file outside every workspace folder is
// impossible because Explorer has no tree node for it, so reveal now pulls that worktree into the workspace
// automatically instead of silently no-oping.
//
// IMPORTANT: a single-folder -> multi-root transition restarts the extension host. Callers must do anything
// that has to survive that transition BEFORE calling this helper. reveal-current-file therefore opens the real
// working file first; VS Code preserves that active editor across the quick restart and Explorer's normal
// auto-reveal selects it once the new worktree root exists.
const addWorktreeRootToWorkspace = (
    worktreeRoot: vscode.Uri,
    showAlreadyPresentMessage: boolean
): "already-present" | "added" | "restart-expected" | "failed" => {
    const name = path.basename(worktreeRoot.fsPath) || worktreeRoot.fsPath;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some((folder) => sameRootPath(folder.uri, worktreeRoot))) {
        if (showAlreadyPresentMessage) {
            vscode.window.showInformationMessage(`Better Git: "${name}" is already in the workspace.`);
        }
        return "already-present";
    }

    // VS Code restarts the extension host when an ordinary single-folder window becomes multi-root. A saved
    // .code-workspace already has stable workspace identity, so adding its second folder does not use this path.
    const willBecomeMultiRoot = folders.length === 1 && !vscode.workspace.workspaceFile;
    if (willBecomeMultiRoot) {
        vscode.window.showInformationMessage(
            `Better Git: Adding worktree "${name}" — this window becomes a multi-root workspace (quick reload).`
        );
    }
    try {
        const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: worktreeRoot, name });
        // During the single-folder -> multi-root transition the host can start restarting before the return
        // value is trustworthy. Preserve the explicit command's established behaviour: only treat false as a
        // real failure when no restart is expected.
        if (!ok && !willBecomeMultiRoot) {
            vscode.window.showErrorMessage(`Better Git: Failed to add worktree "${name}" to the workspace.`);
            return "failed";
        }
        return willBecomeMultiRoot ? "restart-expected" : "added";
    } catch (e) {
        vscode.window.showErrorMessage(`Better Git: Failed to add worktree to the workspace: ${e}`);
        return "failed";
    }
};

// updateWorkspaceFolders starts an asynchronous Explorer-model update. Wait for the target file to acquire a
// workspace folder before asking revealInExplorer to select it; otherwise a fast reveal can race the new root
// and reproduce the same silent no-op this feature fixes. The timeout is only a safety valve — after it we still
// attempt the reveal, because the folder update may have completed without delivering an event to this host.
const waitForFileWorkspaceFolder = async (fileUri: vscode.Uri, timeout = 2000): Promise<void> => {
    if (vscode.workspace.getWorkspaceFolder(fileUri)) {
        return;
    }
    await new Promise<void>((resolve) => {
        let listener: vscode.Disposable | undefined;
        const timer = setTimeout(() => {
            listener?.dispose();
            resolve();
        }, timeout);
        listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (!vscode.workspace.getWorkspaceFolder(fileUri)) {
                return;
            }
            clearTimeout(timer);
            listener?.dispose();
            resolve();
        });
    });
};

// SHARED merge-editor predicate (v1.2.9). A 3-way MERGE editor (git conflict) is a TabInputTextMerge tab.
// That type exists at runtime but isn't in this project's @types/vscode (1.83), so we duck-type it by shape:
// a merge input uniquely has `result` (the on-disk file being merged) + `input1` + `input2` (the two sides).
// This exact duck-type used to be copy-pasted in THREE places (currentReviewFileUri, getActiveChange, and it
// was MISSING from the smart-mouse gate — Bug 1, 2026-07-04: the mouse fell through to browser nav on a merge
// conflict while the keyboard navigated the changeset). Extracted to ONE predicate so every entry point that
// needs to recognise "is this the merge-conflict editor?" asks the SAME question — the mouse can't diverge
// from the keyboard on merge conflicts again. Returns true only for a genuine merge tab (all three fields).
const isMergeEditorInput = (input: unknown): boolean => {
    const m = input as any;
    return !!(m && m.result && m.input1 && m.input2);
};

// Native image comparisons can carry original/modified URIs without being a TabInputTextDiff instance.
// Fire, keyboard eyes, mouse/wand holds and navigation must recognize that same actual resource pair.
// Keep resource-less media on the exact-path fallback and preserve the separate three-way merge predicate.
const isResourceDiffInput = (input: unknown): input is { original: vscode.Uri; modified: vscode.Uri } => {
    const value = input as { original?: unknown; modified?: unknown } | undefined;
    return !!value && value.original instanceof vscode.Uri && value.modified instanceof vscode.Uri;
};

const currentReviewFileUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (isResourceDiffInput(input)) {
        // Resolve the file path from EITHER side of the diff. A DELETED file has no working (modified) side so
        // its path is on the original (HEAD) side; an ADDED file has no original; a MODIFIED file has both.
        // Trying modified-then-original covers modify / add / delete / rename / staged variants generally,
        // instead of special-casing each git status. (Bug: the badge didn't follow deleted files.)
        return toFilePathUri(input.modified) ?? toFilePathUri(input.original);
    }
    // Notebook diffs are a separate public tab shape. They still identify original/modified resources, so
    // resolve them through the same side-agnostic path helper as text diffs. This also covers future notebook
    // renderers without relying on an active TextEditor (notebook editors do not provide one).
    if (input instanceof vscode.TabInputNotebookDiff) {
        return toFilePathUri(input.modified) ?? toFilePathUri(input.original);
    }
    // A 3-way MERGE editor (git conflict) — recognised via the shared isMergeEditorInput predicate. `result`
    // is the on-disk file being merged. The TabInputTextDiff check above already ran, so this is unambiguous.
    if (isMergeEditorInput(input)) {
        return toFilePathUri((input as any).result);
    }
    // A single editor (not a diff) — git opens some changes this way via `vscode.open`:
    //   • untracked/new files  -> the plain file: uri (no original to diff against)
    //   • DELETED files        -> the HEAD content under a git: uri (no working file to diff against)
    // Resolve EITHER form to the on-disk path via toFilePathUri (which decodes a git: uri's path), and badge
    // it only when it's an actual change so the badge doesn't follow every ordinary file you open.
    // (THE deleted-file bug, confirmed in git's getResources: a deletion has modified===undefined and opens
    // as a git: single editor — the old file:-scheme-only check skipped it, so the badge never matched.)
    if (input instanceof vscode.TabInputText) {
        const resolved = toFilePathUri(input.uri);
        if (resolved && isChangeFileUri(resolved)) {
            return resolved;
        }
    }
    // A newly-added notebook (or a notebook opened without its diff renderer) is a single Notebook tab. Match
    // it only while its backing file is a real Git change, mirroring the plain-text/custom-editor safeguards.
    if (input instanceof vscode.TabInputNotebook) {
        const resolved = toFilePathUri(input.uri);
        if (resolved && isChangeFileUri(resolved)) {
            return resolved;
        }
    }
    // Some BINARY / IMAGE changes open as a custom editor (TabInputCustom). Current VS Code also has an opaque
    // image-comparison shape with no public input; currentReviewFileUriAsync handles that fallback below.
    // Without this branch the shared "which file is under review?" predicate missed binary/image review tabs,
    // so repo selection (getFileChanges) and the late-worktree-collapse protection could pick the wrong repo
    // or yank you off a binary/image diff. Resolve the custom tab's on-disk uri and accept it only when it's an
    // ACTUAL change, using the SAME toFilePathUri + isChangeFileUri predicates the smart-mouse gate uses.
    if (input instanceof vscode.TabInputCustom) {
        const resolved = toFilePathUri(input.uri);
        if (resolved && isChangeFileUri(resolved)) {
            return resolved;
        }
    }
    return undefined;
};

// Matches VS Code's compareFileNames (src/vs/base/common/comparers.ts): a numeric, case-insensitive
// collator, so the navigation order is IDENTICAL to what the Source Control view shows for file names.
// BUG FIX: the comparators below previously compared the final filename segment with a naive `a < b`,
// which diverges from VS Code for numbered files (e.g. item-2 vs item-10, v2 vs v10) and some
// punctuation. That made next-change navigation jump to a file that wasn't the visually-next row in the
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
// `status` is the raw git status (vscode.git Status enum value). It selects existing diff resources for
// staged entries and focus-preserving Undo opens, including additions/deletions with only one content side.
interface FileChange {
    uri: vscode.Uri;
    staged: boolean;
    status?: number;
    originalUri?: vscode.Uri; // staged RENAME/COPY: the HEAD-side blob lives at this old path, not `uri`
}

// Presentation is a fixed sequence, independent of the number of worktrees.
// Git's repository order supplies a position hint, never proof of identity: the
// native selection must report the requested root before we operate its groups.
const revealCollapsedWorktree = async (
    repository: any, repositories: any[], isCurrent: () => boolean, onDeferred: () => void
): Promise<boolean> => {
    // Ethan's 2026-11-06 "activate Codex ... do its own thing in the bg" trial was superseded by his
    // return-after-fold choice. Keep the focus guards below: in the isolated 1.144 workbench, background list.*
    // commands still used the previously focused Graph list and opened its historical file. A direct SCM
    // group-focus command did not fix that routing. A background replacement must prove target ownership
    // from Graph too; the successful global collapse alone does not prove the requested root was expanded.
    // Ethan's 2026-10-05 correction: use the same GLOBAL minimize command as the toolbar, settle it, then
    // expand only the requested repository. Do not restore the old expand-everything/repeated sweep path.
    // Merge Changes is an optional group BEFORE Staged; clean/staged-only roots still need expansion.
    const pause = async (ms = 100) => {
        await new Promise(resolve => setTimeout(resolve, ms));
        if (!isCurrent()) { return false; }
        if (!vscode.window.state.focused) { onDeferred(); return false; }
        return true;
    };
    await executeScmTreeCommand("manual", "workbench.view.scm");
    if (!isCurrent()) { return false; }
    if (!vscode.window.state.focused) { onDeferred(); return false; }
    const implicitRepository = repositories.length === 1
        && !vscode.workspace.getConfiguration("scm").get<boolean>("alwaysShowRepositories", false);
    // One short wait for Git's 100 ms resource publication, not a quiet-period
    // watcher across every unrelated worktree in the workspace.
    if (!await pause(200)) { return false; }
    if (!implicitRepository) {
        await executeScmTreeCommand("manual", SCM_COLLAPSE_ALL_REPOS_COMMAND);
        if (!await pause()) { return false; }
    }
    await executeScmTreeCommand("manual", "workbench.scm.focus");
    if (!await pause()) { return false; }
    const collapseStagedGroup = async (hasHeader: boolean, firstGroupFocused = false): Promise<boolean> => {
        // Native boundary (VS Code 1.144 SCMViewPane, verified 2026-11-05): collapseByDefault returns
        // false for every resource group, so a re-created Staged node starts EXPANDED. Git's empty Staged
        // group is only tree-filtered (hideWhenEmpty) and cannot receive focus, so this link cannot fold
        // it; the first later stage then reveals it expanded. With Git's own
        // `git.alwaysShowStagedChangesResourceGroup`, the empty group is visible, is folded here and keeps
        // that state by tree identity while this root stays open. There is no public per-group expansion
        // API or setting; never add a background recollapse, focus-stealing group walk or polling instead.
        if ((repository.state.indexChanges ?? []).length === 0
            && !vscode.workspace.getConfiguration("git", repository.rootUri)
                .get<boolean>("alwaysShowStagedChangesResourceGroup", false)) { return true; }
        // Git has a fixed group order: optional Merge, then Staged. Select the
        // group itself: recursive collapse of an already-closed root can retain
        // its cached child expansion state in the native AsyncDataTree.
        const groupIndex = Number((repository.state.mergeChanges ?? []).length > 0);
        for (let group = Number(firstGroupFocused); group <= groupIndex; group++) {
            await executeScmTreeCommand("manual", "workbench.scm.action.focusNextResourceGroup");
            // VS Code queues group focus without returning its promise. A 100 ms gap can collapse the
            // header instead, or let the late group operation steal the final file selection. This is a
            // bounded presentation settle only; it never debounces or delays mouse/keyboard review input.
            if (!await pause(WORKTREE_TREE_SETTLE_MS)) { return false; }
        }
        await executeScmTreeCommand("manual", "list.collapseAllToFocus");
        if (!await pause()) { return false; }
        if (hasHeader) {
            await executeScmTreeCommand("manual", "list.focusParent");
            if (!await pause(50)) { return false; }
        }
        return true;
    };
    if (implicitRepository) {
        // No repository node exists in this native tree. The global repository
        // collapse command throws there, and retained file focus could skip
        // Staged when advancing groups. Start at the commit controls instead.
        await executeScmTreeCommand("manual", "list.clear");
        await executeScmTreeCommand("manual", "list.focusFirst");
        if (!await pause(50)) { return false; }
        const firstGroupFocused = !vscode.workspace.getConfiguration("git", repository.rootUri)
            .get<boolean>("showCommitInput", true)
            && !vscode.workspace.getConfiguration("scm").get<boolean>("showActionButton", true);
        return collapseStagedGroup(false, firstGroupFocused);
    }
    await executeScmTreeCommand("manual", "list.clear");
    await executeScmTreeCommand("manual", "list.focusFirst");
    if (!await pause(50)) { return false; }
    const order = vscode.workspace.getConfiguration("scm").get<string>("repositories.sortOrder", "discovery time");
    const ordered = [...repositories];
    if (order === "name" || order === "path") {
        const label = (repo: any): string => {
            const folder = vscode.workspace.getWorkspaceFolder(repo.rootUri);
            return folder && folder.uri.toString() === repo.rootUri.toString() ? folder.name : path.basename(repo.rootUri.fsPath);
        };
        ordered.sort((a, b) => (order === "name" ? fileNameCollator.compare(label(a), label(b)) : 0)
            || fileNameCollator.compare(a.rootUri.fsPath, b.rootUri.fsPath));
    } else {
        ordered.sort((a, b) => (repositoryDiscoveryOrder.get(a.rootUri.toString()) ?? Number.MAX_SAFE_INTEGER)
            - (repositoryDiscoveryOrder.get(b.rootUri.toString()) ?? Number.MAX_SAFE_INTEGER));
    }
    const index = ordered.findIndex(candidate => candidate.rootUri.toString() === repository.rootUri.toString());
    if (index < 0) { return false; }
    if (index > 0) {
        await executeScmTreeCommand("manual", "list.focusDown", index);
        if (!await pause(50)) { return false; }
    }
    // Collapse the focused header before dispatching its selection. Selecting
    // first can let native reveal move focus to a child before we collapse it.
    // This native command collapses recursively, then selects that same header.
    await executeScmTreeCommand("manual", "list.collapseAllToFocus");
    if (!await pause(150)) { return false; }
    if (!repository.ui.selected) {
        // Hidden/reordered repository headers can invalidate the position hint.
        // Close the candidate again; never cycle inputs or operate the wrong repo.
        await executeScmTreeCommand("manual", SCM_COLLAPSE_ALL_REPOS_COMMAND);
        const selected = repositories.filter(candidate => candidate.ui.selected)
            .map(candidate => candidate.rootUri.fsPath).join(", ") || "none";
        debugLog("worktree-link", `Native repository position ${index + 1}/${ordered.length} (${order}) did not match ${repository.rootUri.fsPath}; selected=${selected}; stopped presentation.`);
        return false;
    }
    // Selection can move focus to the commit input. All headers are still
    // collapsed, so reacquire the target directly without selecting it again.
    await executeScmTreeCommand("manual", "list.focusFirst");
    if (index > 0) { await executeScmTreeCommand("manual", "list.focusDown", index); }
    if (!await pause(50)) { return false; }
    await executeScmTreeCommand("manual", "list.expand");
    // list.expand is fire-and-forget for AsyncDataTree too. Let refreshed group rows materialize before
    // asking SCM to focus Staged; collapsed-root refreshes can discard those children until this expansion.
    if (!await pause(WORKTREE_TREE_SETTLE_MS)) { return false; }
    return collapseStagedGroup(true);
};

const openWorktreeInSourceControl = async (requestedRoot?: vscode.Uri, isCurrent: () => boolean = () => true,
    onDeferred?: (root: vscode.Uri) => void, beforeLoad?: () => Promise<void>,
    beginPresentation?: () => boolean): Promise<boolean> => {
    let root = requestedRoot;
    try {
        if (!isCurrent()) { return false; }
        const extension = vscode.extensions.getExtension<any>("vscode.git");
        const git = (await extension?.activate())?.getAPI(1);
        if (!git) {
            void vscode.window.showErrorMessage("Better Git: VS Code could not use the built-in Git extension.");
            return false;
        }
        if (!root) {
            const items = git.repositories.map((repo: any) => ({
                label: path.basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, root: repo.rootUri as vscode.Uri
            }));
            if (items.length === 0) {
                void vscode.window.showInformationMessage("Better Git: No git worktrees found");
                return false;
            }
            const selected = await vscode.window.showQuickPick<{ label: string; description: string; root: vscode.Uri }>(
                items, { placeHolder: "Select a worktree to open in Source Control" }
            );
            if (!selected) { return false; }
            root = selected.root;
        }
        if (root.scheme !== "file" || !path.isAbsolute(root.fsPath)) {
            throw new Error("This link does not contain a valid worktree path.");
        }
        const canonicalRoot = await fs.promises.realpath(root.fsPath);
        await fs.promises.stat(path.join(canonicalRoot, ".git"));
        if (!isCurrent()) { return false; }
        // Complete optional origin/editor activation before repository discovery,
        // status and native SCM settling. Never refocus after this loading work.
        await beforeLoad?.();
        if (!isCurrent()) { return false; }
        let repository = git.getRepository(root);
        if (!repository || await fs.promises.realpath(repository.rootUri.fsPath) !== canonicalRoot) {
            // A canonical link can refer to an already-open alias (e.g. /tmp
            // versus /private/tmp). Only this lookup miss needs metadata reads
            // for other roots; never refresh their Git status or reopen them.
            const roots = await Promise.all(git.repositories.map(async (candidate: any) => {
                try { return await fs.promises.realpath(candidate.rootUri.fsPath) === canonicalRoot ? candidate : undefined; }
                catch { return undefined; } // A removed repository can remain in VS Code until its watcher catches up.
            }));
            repository = roots.find(candidate => candidate);
        }
        root = vscode.Uri.file(canonicalRoot);
        repository ??= await git.openRepository(root);
        // Never fall through to the active editor's or primary repository.
        if (!repository || await fs.promises.realpath(repository.rootUri.fsPath) !== canonicalRoot) {
            throw new Error("No git worktree found at this path.");
        }
        // openRepository returns before its first status scan settles. Await
        // that one repository, otherwise a new dirty worktree appears clean.
        await repository.status();
        if (!isCurrent()) { return false; }
        const name = path.basename(canonicalRoot);
        // Use the same sorted entries as Stage and Next/Previous. Git's raw state arrays can put a
        // nested path above root files and item-10 above item-2, unlike the visible SCM review order.
        // Keep this lookup tied to the validated repository, including an already-open path alias.
        const changes = await getFileChanges(repository.rootUri);
        if (!isCurrent()) { return false; }
        const target = changes.find(change => !change.staged);
        const autoReveal = vscode.workspace.getConfiguration("scm").get<boolean>("autoReveal", true);
        let nativeRevealed = false;
        let nativeDeferred = false;
        const deferPresentation = () => {
            nativeDeferred = true;
            onDeferred?.(vscode.Uri.file(canonicalRoot));
        };
        const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const stillOwned = () => {
            const current = isCurrent();
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (!current || tab !== originalTab) {
                debugLog("worktree-link", `Stopped native presentation for ${name}: current=${current}, sameTab=${tab === originalTab}, before=${originalTab?.label}, now=${tab?.label}, review=${currentReviewFileUri()?.toString() ?? "none"}.`);
                return false;
            }
            return true;
        };
        // Repository loading still counts toward the recent-link deadline. Admit only now, immediately
        // before native tree work; once admitted, deadline expiry cannot strand the target collapsed.
        if (beginPresentation && !beginPresentation()) {
            // Focus may have left while repository loading was awaited. Keep the same recent retry
            // pending, as the native pause guards do; expiry/new review input still stops it outright.
            if (stillOwned() && !vscode.window.state.focused) { deferPresentation(); return true; }
            return false;
        }
        if (autoReveal) {
            nativeRevealed = await revealCollapsedWorktree(repository, git.repositories, stillOwned, deferPresentation);
        } else {
            await executeScmTreeCommand("manual", "workbench.view.scm");
        }
        if (!stillOwned()) { return false; }
        // Ethan: a clean worktree must still expand normally, with Staged collapsed. Do not open a staged
        // file just to obtain Auto Reveal: that would expand Staged again and move his review unexpectedly.
        if (!target) { return !autoReveal || nativeRevealed || nativeDeferred; }
        if (target.status === GitStatus.DELETED && nativeRevealed) {
            // Deleted-file editors have a git: URI, so SCM Auto Reveal cannot
            // select them. The verified native repository owns these group commands.
            const groupIndex = Number((repository.state.mergeChanges ?? []).length > 0)
                + Number((repository.state.indexChanges ?? []).length > 0
                    || vscode.workspace.getConfiguration("git", repository.rootUri)
                        .get<boolean>("alwaysShowStagedChangesResourceGroup", false));
            for (let group = 0; group <= groupIndex; group++) {
                if (!isCurrent()) { return false; }
                if (!vscode.window.state.focused) { deferPresentation(); break; }
                await executeScmTreeCommand("manual", "workbench.scm.action.focusNextResourceGroup");
                // Deleted Git-side previews cannot use Auto Reveal. Their Changes-group focus has the
                // same queued native-command contract as Staged above; keep both paths on one timing rule.
                await new Promise(resolve => setTimeout(resolve, WORKTREE_TREE_SETTLE_MS));
            }
            if (!isCurrent()) { return false; }
            if (vscode.window.state.focused) { await executeScmTreeCommand("manual", "list.expand"); }
            else { deferPresentation(); }
        }
        if (!isCurrent()) { return false; }
        const shown = await currentReviewFileUriAsync();
        if (!target.staged && target.status !== GitStatus.DELETED && shown?.toString() === target.uri.toString()) {
            // Auto Reveal also needs a real editor-input change on repeat clicks. Use the shared
            // resolver so image/custom previews receive the same handling as ordinary text tabs.
            if (target.status === GitStatus.UNTRACKED || target.status === GitStatus.INTENT_TO_ADD
                || (target.status !== undefined && target.status >= GitStatus.ADDED_BY_US
                    && vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText)) {
                // Conflicts commonly open as the plain working file. Reopening that same input
                // after collapse emits no editor change, leaving Merge Changes hidden. Use a
                // temporary empty-side comparison, then let Git reopen its native conflict view.
                // Never read the unresolved stage-0 index: it has no blob for this path.
                const empty = await getEmptyTreeRef(target.uri);
                if (empty) {
                    await vscode.commands.executeCommand("vscode.diff", toGitUri(target.uri, empty), target.uri, undefined,
                        { preview: true, preserveFocus: true });
                }
            } else {
                await vscode.commands.executeCommand("vscode.open", target.uri, { preview: true, preserveFocus: true });
            }
        }
        await openChangeEntry(target, true);
        if (!isCurrent()) { return false; }
        if (!autoReveal) {
            void vscode.window.showInformationMessage(`Better Git: Opened Source Control for ${name}. Auto reveal is off, so expand its section manually.`);
        }
        return !autoReveal || nativeRevealed || nativeDeferred;
    } catch (error) {
        debugLog("worktree-link", `Native presentation failed for ${root?.fsPath ?? "worktree"}: ${String(error)}`);
        void vscode.window.showErrorMessage(`Better Git: Failed to open ${root?.fsPath ?? "worktree"}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
};

const revealUndoneStageTransaction = async (transaction: StoredStageTransaction): Promise<void> => {
    const changedPaths = new Set((await readStageTransactionPaths(transaction))
        .map(relativePath => vscode.Uri.file(path.join(transaction.repoRoot, relativePath)).toString()));
    if (vscode.workspace.getConfiguration("scm").get<boolean>("autoReveal", true)) {
        // repo.status() updates the Git API immediately, but VS Code batches
        // SCM resource splices with ExtHostSCM's 100 ms debounce. Opening the
        // editor before that batch makes autoReveal select the old staged row
        // (then lose it). Allow the batch to leave the host before opening.
        // This is presentation-only; the index/history restore already finished.
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    const entries = (await getFileChanges(vscode.Uri.file(transaction.repoRoot)))
        .filter(entry => changedPaths.has(entry.uri.toString()));
    // A partially staged file has two rows. Undoing a stage must select its
    // restored working-tree row; undoing an unstage can leave only a staged row.
    const unstaged = entries.filter(entry => !entry.staged);
    const candidates = unstaged.length > 0 ? unstaged : entries;
    const currentUri = candidates.length > 1 ? await currentReviewFileUriAsync() : undefined;
    const target = candidates.find(entry => entry.uri.toString() === transaction.view?.fileUri)
        ?? candidates.find(entry => entry.uri.toString() === transaction.uri)
        ?? candidates.find(entry => entry.uri.toString() === currentUri?.toString())
        ?? candidates[0]; // A multi-file external transaction follows the SCM sort order.
    if (target) {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!target.staged && input instanceof vscode.TabInputTextDiff && input.modified.toString() === target.uri.toString()) {
            // Native staging can leave this very working diff open. Reopening
            // the identical input emits no editor-change event for autoReveal;
            // change inputs without closing a tab or moving keyboard focus.
            await vscode.commands.executeCommand("vscode.open", target.uri, { preview: true, preserveFocus: true });
        }
        await openChangeEntry(target, true);
        if (transaction.view?.fileUri === target.uri.toString()) {
            await restoreStageUndoView(transaction.view);
        }
    }
};

// The remembered-review cache shares this exact coordinate/clamping rule with stage Undo. Only Undo waits
// for viewport settling; returning to a file issues a presentation update without holding up review input.
const restoreStageUndoView = async (view: StageUndoView, settleViewport = true): Promise<void> => {
    // Ethan wants stage Undo to feel as if he never left: restore this exact text side's saved cursor AND
    // scroll position. A media preview has no TextEditor; do not apply a stale text cursor to its next tab.
    const editor = visibleEditorForActiveTab();
    if (!editor || editor.document.uri.toString() !== view.documentUri) { return; }
    if (settleViewport) { pendingReviewPosition = undefined; } // Exact Undo takes precedence over revisit memory.
    editor.selections = view.selections.map(selection => new vscode.Selection(
        editor.document.validatePosition(new vscode.Position(selection.anchor.line, selection.anchor.character)),
        editor.document.validatePosition(new vscode.Position(selection.active.line, selection.active.character))));
    if (view.topLine === undefined) { return; }
    // The same AtTop padding used by held-mouse view restoration compensates
    // for VS Code's sticky-scroll/cursor context without a jump-away/jump-back.
    const config = vscode.workspace.getConfiguration("editor", editor.document);
    const padding = Math.max(config.get<number>("cursorSurroundingLines", 0),
        config.get<boolean>("stickyScroll.enabled", true) ? config.get<number>("stickyScroll.maxLineCount", 5) : 0);
    const top = editor.document.validatePosition(new vscode.Position(view.topLine + padding, 0));
    const range = new vscode.Range(top, top);
    if (settleViewport) { await revealRangeAndWaitForViewport(editor, range, vscode.TextEditorRevealType.AtTop); }
    else { editor.revealRange(range, vscode.TextEditorRevealType.AtTop); }
};

// Unstaged file uris for a repo = tracked working-tree changes PLUS untracked (new) files, deduped by path
// and sorted to match the Source Control "Changes" group (VS Code's default "mixed" mode shows untracked
// there). The git API keeps untracked files (Status.UNTRACKED = 7) in state.untrackedChanges; depending on
// the git.untrackedChanges setting they can also appear in workingTreeChanges — so we read BOTH and dedupe by
// path. IGNORED files (status 8) are dropped. git.openChange opens an untracked file as a diff against an
// empty original (same as clicking its row), so untracked files navigate like any other entry.
// BUG FIX: the old code filtered untracked out everywhere (status !== 7), so a brand-new file was never
// navigated to or advanced to by stage-and-next — it "wasn't even considered". New files are first-class now.
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

const getFileChanges = async (preferredUri?: vscode.Uri): Promise<FileChange[]> => {
    // BUG 10 FIX (v1.2.9 — getFileChanges threw instead of no-oping when git wasn't ready / no repos):
    // the old code did `getExtension("vscode.git")!.exports` (`.exports` is undefined until the git extension
    // ACTIVATES, so `.getAPI(1)` threw TypeError) and then `git.repositories[0]` + unguarded `activeRepo.state`
    // (undefined when repositories is [] — fresh window still scanning, or a non-git workspace). The command
    // promise rejected, so a nav/reveal keypress did nothing AND no fallback ran (openFirst/openLast threw
    // before reaching their length===0 guard). Now we use the SAME guarded `?.exports?.getAPI(1)` form as
    // every other git-touching helper in this file and return [] on any miss so every caller no-ops cleanly.
    const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    if (!git) {
        return []; // git extension not present / not activated yet -> no changes, callers no-op gracefully
    }
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    // An explicit preferredUri belongs to a command target that must remain stable even if focus is elsewhere
    // (currently the persistent last-staged badge). Otherwise prefer the repo that owns the file CURRENTLY
    // BEING REVIEWED (tab-derived, focus-independent) so normal navigation stays within the active repo.
    // Fall back to the first workspace folder's repo, then the shared getPrimaryRepository() (the same
    // "pick the primary repo" predicate the worktree-collapse uses) instead of a raw git.repositories[0].
    // Null-check the result so a still-scanning window returns [] rather than throws.
    const reviewUri = preferredUri ? undefined : await currentReviewFileUriAsync();
    const activeRepo =
        (preferredUri && git.getRepository(preferredUri)) ||
        (reviewUri && git.getRepository(reviewUri)) ||
        git.getRepository(workspaceUri?.path) ||
        getPrimaryRepository();
    if (!activeRepo) {
        return []; // no repositories populated yet / non-git workspace -> no changes, callers no-op gracefully
    }
    const isTreeView = vscode.workspace.getConfiguration("better-git-vscode").get("treeView");

    // Keep the git status alongside the uri for staged entries: openChangeEntry needs it to choose which
    // diff sides exist (a newly-staged INDEX_ADDED file has no HEAD blob; a staged INDEX_DELETED file has no
    // index blob). We sort on the URI just like before, but carry {uri,status} through the sort so the
    // status isn't lost. (Sorting plain uris and re-deriving status later would be fragile across dup paths.)
    const indexChanges: FileChange[] = activeRepo.state.indexChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => ({ uri: file.uri as vscode.Uri, status: file.status as number, originalUri: file.originalUri as vscode.Uri | undefined }))
        .sort((a: any, b: any) => (isTreeView ? orderFilesForTreeView : orderFilesForListView)(a.uri, b.uri))
        .map((entry: any) => ({ uri: entry.uri, staged: true, status: entry.status, originalUri: entry.originalUri }));

    // Unstaged group = tracked working-tree changes PLUS untracked (new) files (see getUnstagedUris), tagged
    // unstaged. Untracked files used to be filtered out here, so they were skipped by navigation entirely.
    const unstagedResources: any[] = [...(activeRepo.state.workingTreeChanges ?? []), ...(activeRepo.state.untrackedChanges ?? [])];
    const unstagedStatuses = new Map<string, number>(unstagedResources.map(resource => [resource.uri.toString(), resource.status]));
    const workingTreeChanges: FileChange[] = getUnstagedUris(activeRepo, !!isTreeView).map((uri) => ({
        uri, staged: false,
        status: unstagedStatuses.get(uri.toString()),
    }));

    // Merge-conflict files (state.mergeChanges) — "both modified", "added by us/them", etc. VS Code lists
    // these in a "Merge Changes" group ABOVE staged/unstaged. Included so conflicts are navigable too; they're
    // opened via git.openChange (the staged:false path), which brings up the conflict / 3-way merge editor.
    // Empty array when there's no merge in progress, so this is a no-op in the normal case.
    const mergeChanges: FileChange[] = (activeRepo.state.mergeChanges ?? [])
        .map((file: any) => ({ uri: file.uri as vscode.Uri, status: file.status as number }))
        .sort((a: { uri: vscode.Uri }, b: { uri: vscode.Uri }) => (isTreeView ? orderFilesForTreeView : orderFilesForListView)(a.uri, b.uri))
        .map((entry: { uri: vscode.Uri; status: number }) => ({ ...entry, staged: false }));

    // BUG FIX: a file that is partially staged (or staged and then edited again) appears in BOTH
    // indexChanges and workingTreeChanges with the SAME on-disk path — so it shows twice here, just as it
    // does in the Source Control view (once under Staged Changes, once under Changes). The previous code
    // matched the current position by PATH ONLY, which always resolved to the FIRST (staged) copy, while
    // VSCode's git.openChange always opens the WORKING-TREE diff for such a file (getSCMResource prefers
    // the working tree group). That mismatch made next-change navigation jump to the wrong file or loop.
    // The fix is NOT to de-duplicate (that reorders the list vs what the user sees); instead we TAG each
    // entry with its side here, then disambiguate by {path, staged} in findCurrentIndex and open the
    // matching side in openChangeEntry. Order mirrors the SCM view exactly: Staged group, then Changes
    // group. Repro before fix: stage file A, edit A again, then from a staged file above A press the
    // next-change shortcut past A's last diff — it jumped to A's unstaged copy instead of advancing.
    return [...mergeChanges, ...indexChanges, ...workingTreeChanges];
};

// Describes which diff is currently focused: the file path, and whether it is the staged (index) side.
// `staged` is null when we can't tell (a plain file editor, or a non-textual file), in which case callers
// fall back to a path-only match (legacy behavior).
interface ActiveChange {
    path: string;
    staged: boolean | null;
}

const getActiveChange = async (resolvedReviewUri?: vscode.Uri): Promise<ActiveChange | null> => {
    // Prefer the active tab's diff input: it exposes the modified (right) side regardless of which pane
    // has keyboard focus. VSCode's git extension builds the modified side as a `git`-scheme uri for the
    // index/staged diff and the plain `file` uri for the working-tree diff (see getRightResource in
    // vscode/extensions/git/src/repository.ts), so the scheme tells us the side unambiguously.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (isResourceDiffInput(input)) {
        const resolved = toFilePathUri(input.modified) ?? toFilePathUri(input.original);
        return { path: resolved?.path ?? input.modified.path,
            staged: reviewDiffIsStaged(input.original, input.modified, [EMPTY_TREE_SHA1, EMPTY_TREE_SHA256]) };
    }
    // 3-way merge editor (conflict) — recognised via the shared isMergeEditorInput predicate. `result` is the
    // working-tree file. Treat as the unstaged side for matching (a conflict is never a "staged" view here).
    if (isMergeEditorInput(input)) {
        return { path: (input as any).result.path as string, staged: false };
    }

    // PLAIN single-editor tab (v1.2.1 fix): resolve the path from the TAB itself, focus-independently.
    // Two change kinds open as plain tabs: untracked new files (file: uri) and DELETED files (their HEAD
    // content under a git: uri — toFilePathUri decodes the real path from the git: query). The old code
    // fell straight through to getActiveFilePath(), which reads vscode.window.activeTextEditor — the
    // FOCUSED editor, which can be a stale different-file editor when focus is in the SCM panel. That stale
    // path then missed in findCurrentIndex (-1 -> bail), making next-change a hard silent no-op on deleted
    // files. Tab-first resolution fixes it; side stays null (a plain tab doesn't tell staged vs unstaged).
    if (input instanceof vscode.TabInputText) {
        const resolved = toFilePathUri(input.uri);
        if (resolved) {
            // BUG 9 FIX (v1.2.9 — dual-state DELETED file dead-ended navigation): return staged=FALSE here, not
            // staged=null. Rationale: EVERY staged/index side in this extension opens as a side-by-side
            // TabInputTextDiff (openChangeEntry always uses vscode.diff for the staged branch), so a PLAIN
            // single-editor active view is ALWAYS the working-tree/unstaged representation — an untracked file
            // (file: editor) or a deleted file's HEAD-blob (git: editor). Labelling it staged=null forced
            // findCurrentIndex down its path-only branch, where the AMBIGUITY GUARD (path appears in BOTH the
            // staged + unstaged groups) permanently returned -1 for a dual-state deleted/untracked file — and a
            // deleted file NEVER opens as a readable diff, so the side stayed null forever and next/previous
            // nav was hard-stuck with no recovery. With staged=false, findCurrentIndex's exact {path, staged}
            // match resolves the file to its unstaged entry and the guard never fires. Safe for single-state
            // files too: a staged-only file shown as a plain editor fails the exact staged=false match but the
            // path appears once, so the guard doesn't fire and the path-only fallback still finds it.
            return { path: resolved.path, staged: false };
        }
    }

    // Single media/notebook previews also expose their resource. Git opens deleted images as single
    // HEAD/index previews, even when an earlier staged edit/new image shares the same path. Keeping their
    // side unknown rejects the hold as ambiguous. Use the resource's explicit side, as text tabs do;
    // opaque comparisons and historical Git refs still retain the path-only safety guard below.
    if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
        const resolved = toFilePathUri(input.uri);
        if (resolved) {
            if (input.uri.scheme === "file") { return { path: resolved.path, staged: false }; }
            if (input.uri.scheme === "better-git-staged-image") { return { path: resolved.path, staged: true }; }
            if (input.uri.scheme === "git") {
                try {
                    const ref = JSON.parse(input.uri.query)?.ref;
                    if (ref === "~") { return { path: resolved.path, staged: false }; }
                    if (ref === "") { return { path: resolved.path, staged: true }; }
                    if (ref === "HEAD") {
                        // Both staged and unstaged deletions show HEAD. A recreated working file must
                        // never be selected from the staged-deletion preview of the same path.
                        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
                        const repo = git?.getRepository(resolved);
                        const matches = (changes: any[], status: number) => (changes ?? []).some((change: any) =>
                            change.status === status && change.uri.path.toLowerCase() === resolved.path.toLowerCase());
                        if (matches(repo?.state.indexChanges, GitStatus.INDEX_DELETED)) {
                            return { path: resolved.path, staged: true };
                        }
                        if (matches(repo?.state.workingTreeChanges, GitStatus.DELETED)) {
                            return { path: resolved.path, staged: false };
                        }
                    }
                } catch { /* Unknown resource metadata must not guess a staged side. */ }
            }
        }
    }

    // Fallback for genuinely non-textual files (images/media/future custom diffs): path only, side unknown.
    // The async shared resolver owns the workbench path fallback and rejects stale/non-change tabs.
    const reviewUri = resolvedReviewUri ?? await currentReviewFileUriAsync();
    if (reviewUri) {
        return { path: reviewUri.path, staged: null };
    }
    const activePath = await getActiveFilePath();
    return activePath ? { path: activePath, staged: null } : null;
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

// The git "empty tree" object id — `git show <empty-tree>:<path>` resolves to an empty buffer instead of
// erroring, which is exactly how VS Code's git: content provider serves a "this side has no content" placeholder
// (its readFile special-cases `ref === getEmptyTree()` -> 0 bytes). We use it as the empty side when opening
// the staged diff of a newly-ADDED file (no HEAD blob) or a staged-DELETED file (no index blob), so vscode.diff
// gets a resolvable URI on both sides and doesn't throw "file not found".
// 4b825dc...4904 is the canonical SHA-1 empty-tree id; b2d... is the SHA-256 equivalent for sha256-object repos.
// We pick by inspecting an existing ref's length isn't reliable here, so we try to ask git via the extension's
// repository object first, and fall back to the SHA-1 constant (the overwhelmingly common case).
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
const getEmptyTreeRef = async (uri: vscode.Uri): Promise<string | undefined> => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        // The git extension API doesn't surface getEmptyTree(), but we can detect the object format from the
        // repo's commit hashes when available; default to SHA-1 (covers virtually all real-world repos).
        const head: string | undefined = repo?.state?.HEAD?.commit;
        if (head && head.length === 64) {
            return EMPTY_TREE_SHA256; // sha256 repo
        }
        return EMPTY_TREE_SHA1;
    } catch {
        return EMPTY_TREE_SHA1; // git extension not ready / API shape changed — SHA-1 empty tree is the safe default
    }
};

// Opens the diff for a single list entry on the correct (staged vs unstaged) side.
const openChangeEntry = async (entry: FileChange, preserveFocus = false, allowStagedReveal = true): Promise<void> => {
    rememberUnstagedReviewPosition(visibleEditorForActiveTab());
    // Capture BEFORE opening: the native first-hunk landing can create a fresh cache entry during open.
    // Treating that new entry as a prior visit would suppress first-visit backward EOF/last-hunk landing.
    const savedPosition = entry.staged || startingReviewFiles.has(entry.uri.toString())
        ? undefined : reviewFilePositions.get(entry.uri.toString());
    if (!entry.staged) {
        // git.openChange does not accept editor options and takes keyboard
        // focus. Undo must keep SCM focus so the next Cmd+Z remains a stage
        // Undo. Mirror Git's ordinary working-tree resources with explicit
        // open options. Deleted files use the restored index: a staged new
        // file can be deleted on disk without ever having existed in HEAD.
        if (preserveFocus && entry.status !== undefined && entry.status < GitStatus.ADDED_BY_US) {
            const options = { preview: true, preserveFocus: true };
            if (entry.status === GitStatus.MODIFIED || entry.status === GitStatus.TYPE_CHANGED) {
                const ref = entry.status === GitStatus.MODIFIED ? "~" : "HEAD";
                await vscode.commands.executeCommand("vscode.diff", toGitUri(entry.uri, ref), entry.uri, undefined, options);
            } else {
                const resource = entry.status === GitStatus.DELETED ? toGitUri(entry.uri, "~") : entry.uri;
                await vscode.commands.executeCommand("vscode.open", resource, options);
            }
            restoreRememberedReviewPosition(entry, savedPosition);
            return;
        }
        // Working-tree (unstaged) diff — git.openChange opens this side correctly, including untracked/new
        // files (it shows them as a plain editor, the same as clicking the row). Defensive fallback: if a
        // view genuinely can't be produced, open the file itself so the command never no-ops.
        try {
            await vscode.commands.executeCommand("git.openChange", entry.uri);
        } catch {
            await vscode.window.showTextDocument(entry.uri, { preview: true, preserveFocus });
        }
        // SILENT-NO-OP GUARD (Codex review, v1.2.1): with git.untrackedChanges="separate", untracked files
        // live in the separate untracked group and git.openChange(uri) resolves nothing for them — and it
        // does NOT throw, so the catch above never fires and navigation would just... stay put. Verify the
        // active tab actually shows the requested file now; if not, open it directly.
        // CODEX FIX 2026-07-04 (High): resolve the shown file via the shared review-file predicate,
        // NOT a local diff/plain-text-only copy. git.openChange legitimately opens a merge conflict as a 3-way
        // merge editor and a binary/image change as a custom editor — neither is a TabInputTextDiff/TabInputText,
        // so the old local check saw "no match" and fell back to showTextDocument(entry.uri), which REPLACED the
        // correct merge/binary view with the raw file (defeating the very merge/binary handling this batch added).
        // The async resolver recognises diff + plain + merge + custom + notebook tabs and opaque file-backed
        // non-text comparisons, so the fallback fires ONLY when the target genuinely didn't open. The common
        // modified-diff path is unchanged (its TabInputTextDiff branch returns the modified-side file path).
        const shownUri = await currentReviewFileUriAsync();
        if (!shownUri || shownUri.path.toLowerCase() !== entry.uri.path.toLowerCase()) {
            try {
                await vscode.window.showTextDocument(entry.uri, { preview: true, preserveFocus });
            } catch {
                // file unreadable (e.g. binary/permission edge) — nothing more we can do, but we tried both paths
            }
        }
        restoreRememberedReviewPosition(entry, savedPosition);
        return;
    }
    // OPT-IN WORKAROUND (better-git-vscode.revealStagedInSourceControl): highlight the staged file in the
    // Source Control view. VS Code's built-in `scm.autoReveal` can't do this for staged files because the
    // staged diff opens with a `git:` uri and autoReveal only matches sidebar rows by their `file:` path
    // (there is NO extension API to select an SCM row directly). Trick: briefly make the plain file the
    // active editor — autoReveal then finds it (a staged-only file's file: uri lives only in the index
    // group) and selects/reveals its row — then we open the staged diff over it. autoReveal never CLEARS a
    // selection on a no-match, so the staged row stays highlighted while the diff is shown. Caveats, which
    // is why this is off by default: a brief flash of the file before the diff, and for a partially-staged
    // (dual-state) file autoReveal picks the working-tree row instead (it scans groups back-to-front).
    const revealStaged = vscode.workspace.getConfiguration("better-git-vscode").get("revealStagedInSourceControl");
    if (revealStaged && allowStagedReveal) {
        try {
            await vscode.window.showTextDocument(entry.uri, { preview: true, preserveFocus }); // fires autoReveal -> selects the staged row
        } catch {
            // File can't be opened (e.g. a staged deletion) — skip the reveal, still show the diff below.
        }
    }

    // Staged (index) diff: open HEAD-vs-index explicitly so it works even for a partially-staged file
    // (where git.openChange would otherwise show the working-tree diff). preview:true mirrors single-click
    // SCM behavior so the existing preview-tab handling keeps working. The git-scheme modified side also
    // makes getActiveChange detect this as staged, so subsequent next/previous navigation stays anchored to
    // the correct list entry.
    //
    // BUG FIX ("The editor could not be opened because the file was not found" on staged files):
    // The git: scheme content provider serves a side by running `git show <ref>:<path>` (verified in VS
    // Code's GitFileSystemProvider.readFile -> Repository.buffer). If the requested ref has no blob for that
    // path, git errors and the provider throws FileSystemError.FileNotFound — which surfaces as that exact
    // editor error. The old code ALWAYS built left=toGitUri(HEAD) + right=toGitUri("") regardless of git
    // status, so the two staged statuses where one side legitimately has NO blob blew up:
    //   • INDEX_ADDED  (a brand-new file you just `git add`-ed): no HEAD blob -> `git show HEAD:path` fails.
    //   • INDEX_DELETED (a tracked file you staged for deletion):  no index blob -> `git show :path` fails.
    // VS Code itself never hits this: its getLeftResource has NO case for INDEX_ADDED (returns {} -> empty
    // left), and INDEX_DELETED opens with an empty right. We mirror that here by status:
    //   • INDEX_ADDED   -> left = empty-tree git: uri (provider returns 0 bytes), right = index  => shown as fully added.
    //   • INDEX_DELETED -> left = HEAD,                                            right = empty-tree    => shown as fully removed.
    //   • everything else (INDEX_MODIFIED / RENAMED / COPIED / unknown) -> HEAD ↔ index, as before.
    // The empty-tree object id is the one ref the content provider maps to an empty buffer instead of
    // throwing (see readFile's `if (r === await getEmptyTree()) return new Uint8Array(0)`), so it's the
    // correct, guaranteed-resolvable "this side has no content" placeholder — not a made-up ref.
    const emptyTreeRef = await getEmptyTreeRef(entry.uri);
    let left: vscode.Uri;
    let right: vscode.Uri;
    if (entry.status === GitStatus.INDEX_ADDED || entry.status === GitStatus.INTENT_TO_ADD) {
        // Newly-staged / intent-to-add file: nothing at HEAD. Use the empty tree as the (empty) original side.
        left = emptyTreeRef ? toGitUri(entry.uri, emptyTreeRef) : toGitUri(entry.uri, "HEAD");
        right = toGitUri(entry.uri, ""); // "" ref => the index/staged content (git show :path)
    } else if (entry.status === GitStatus.INDEX_DELETED) {
        // Staged deletion: nothing in the index. Diff HEAD content against the empty tree (fully removed).
        left = toGitUri(entry.uri, "HEAD");
        right = emptyTreeRef ? toGitUri(entry.uri, emptyTreeRef) : toGitUri(entry.uri, "");
    } else {
        // INDEX_MODIFIED / INDEX_RENAMED / INDEX_COPIED / TYPE_CHANGED (and any unknown staged status): both
        // sides exist. CRITICAL for RENAME/COPY (the "R doesn't work" bug): the HEAD blob lives at the
        // ORIGINAL path, NOT entry.uri (the new path) — so `git show HEAD:<newpath>` errors with "file not
        // found" and the diff never opens. entry.originalUri is the old path (and equals uri for non-renames),
        // so it's the correct HEAD side for every case.
        left = toGitUri(entry.originalUri ?? entry.uri, "HEAD");
        right = toGitUri(entry.uri, ""); // index content at the (new) path
    }
    // A staged LFS image is a pointer in Git. VS Code intentionally refuses to render that pointer in its
    // media preview, even when the exact image is already present in local LFS storage. Swap only locally
    // resolvable image sides for a read-only provider of the indexed bytes; leave all other diff shapes alone.
    const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    const repositoryRoot: string | undefined = git?.getRepository(entry.uri)?.rootUri?.fsPath;
    if (repositoryRoot) {
        [left, right] = await Promise.all([
            resolveStagedLfsImage(left, repositoryRoot),
            resolveStagedLfsImage(right, repositoryRoot),
        ]);
    }
    const title = `${entry.uri.path.split("/").pop()} (Index)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true, preserveFocus });
};

type PlainMergeConflictBlock = {
    startLine: number;
    endLine: number;
};

// Parse the same standard conflict-marker form recognised by VS Code's built-in merge-conflict extension.
// Deliberately require a complete start/separator/end sequence: marker-looking text or a partially edited group
// must not become a review target.
const plainMergeConflictBlocks = (document: vscode.TextDocument): PlainMergeConflictBlock[] => {
    const blocks: PlainMergeConflictBlock[] = [];
    let startLine: number | undefined;
    let sawSeparator = false;
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        if (startLine === undefined) {
            if (text.startsWith("<<<<<<<")) {
                startLine = line;
                sawSeparator = false;
            }
            continue;
        }
        if (text === "=======") {
            sawSeparator = true;
            continue;
        }
        if (sawSeparator && text.startsWith(">>>>>>>")) {
            blocks.push({ startLine, endLine: line });
            startLine = undefined;
            sawSeparator = false;
        }
    }
    return blocks;
};

// THE STRUCTURAL GATE for the ordinary Source Control merge-conflict view. With git.mergeEditor=false VS Code
// opens an unresolved file as a plain TabInputText, where compareEditor.nextChange cannot operate. Resolve the
// exact editor owned by the active tab — never activeTextEditor, which can still point at a stale file while SCM
// owns focus — and require Git's live mergeChanges state so ordinary files containing marker text are excluded.
const plainMergeConflictEditor = (): vscode.TextEditor | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== "file") {
        return undefined;
    }
    if (!isMergeConflictFileUri(tab.input.uri)) {
        return undefined;
    }
    return visibleEditorForActiveTab();
};

// Treat every complete marker group as one normal review change. There is intentionally no within-file wrap:
// false at the requested edge hands control to Better Git's existing cross-file sequence.
const stepPlainMergeConflict = (editor: vscode.TextEditor, direction: "down" | "up"): boolean => {
    const blocks = plainMergeConflictBlocks(editor.document);
    const cursorLine = editor.selection.active.line;
    const target = direction === "down"
        ? blocks.find((block) => block.startLine > cursorLine)
        : [...blocks].reverse().find((block) => block.endLine < cursorLine);
    if (!target) {
        return false;
    }
    const position = new vscode.Position(target.startLine, 0);
    editor.selection = new vscode.Selection(position, position);
    const end = new vscode.Position(target.endLine, editor.document.lineAt(target.endLine).text.length);
    editor.revealRange(new vscode.Range(position, end), vscode.TextEditorRevealType.Default);
    return true;
};

// Make cross-file conflict transitions match ordinary diff transitions: forward review lands on the first block
// and backward review lands on the last. The retry runs only for an entry Git already marks unresolved, so normal
// diff navigation never pays this rendering wait.
const landPlainMergeConflictTarget = async (
    entry: FileChange,
    direction: "down" | "up",
    check = noNavigationCheckpoint,
): Promise<boolean> => {
    if (hasRestoredReviewPosition(entry)) { return true; }
    if (!isMergeConflictFileUri(entry.uri)) {
        return false;
    }
    for (let i = 0; i < 8; i++) {
        check();
        const editor = plainMergeConflictEditor();
        if (editor && editor.document.uri.path.toLowerCase() === entry.uri.path.toLowerCase()) {
            const blocks = plainMergeConflictBlocks(editor.document);
            const target = direction === "down" ? blocks[0] : blocks[blocks.length - 1];
            if (target) {
                const position = new vscode.Position(target.startLine, 0);
                editor.selection = new vscode.Selection(position, position);
                const end = new vscode.Position(target.endLine, editor.document.lineAt(target.endLine).text.length);
                editor.revealRange(new vscode.Range(position, end), vscode.TextEditorRevealType.Default);
            }
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return false; // detailed merge editor or render failure: preserve the existing fallback behavior
};

const openFirstFile = async (check: NavigationCheckpoint = noNavigationCheckpoint) => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("better-git-vscode").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    check();
    if (fileChanges.length === 0) {
        // v1.2.17 no-context pick: a clean repo is a normal end state after stage-and-advance, not an error.
        // Keep the feedback quiet in the status bar (never a popup that interrupts the review flow), while
        // still making the otherwise-empty keypress explain itself to the user and the debug output channel.
        debugLog("nav", "next: no active file context -> no changes to navigate");
        vscode.window.setStatusBarMessage("Better Git: No changes to navigate", 4000);
        return;
    }

    // v1.2.17 no-context pick: start with WORKING-TREE work (merge conflicts + unstaged/untracked entries)
    // because that is the actionable review queue. Only after stage-and-advance has staged everything do we
    // continue through the index diff — picking staged work is the useful continuation instead of dead-ending.
    const unstagedChanges = fileChanges.filter((entry) => !entry.staged);
    const target = unstagedChanges[0] ?? fileChanges.find((entry) => entry.staged)!;
    debugLog(
        "nav",
        unstagedChanges.length > 0
            ? "next: no active file context -> picking first changed file (unstaged-first)"
            : "next: no active file context -> no unstaged changes; picking first staged file",
    );
    await openNavigationTarget(target, check);
    await landChangeForForwardReview(target, check);
};

const openLastFile = async (check: NavigationCheckpoint = noNavigationCheckpoint) => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("better-git-vscode").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    check();
    if (fileChanges.length === 0) {
        // Mirror openFirstFile: reaching a clean repo backward is expected after staging the final file, so use
        // the same quiet status-bar acknowledgement rather than an error/warning popup.
        debugLog("nav", "previous: no active file context -> no changes to navigate");
        vscode.window.setStatusBarMessage("Better Git: No changes to navigate", 4000);
        return;
    }

    // v1.2.17 no-context pick: backward entry uses the LAST actionable working-tree item, falling back to the
    // LAST staged/index item only when staging everything emptied that queue. Preserve getFileChanges order
    // within each side so this still follows the SCM view's merge/index/working-tree sorting conventions.
    const unstagedChanges = fileChanges.filter((entry) => !entry.staged);
    const stagedChanges = fileChanges.filter((entry) => entry.staged);
    const target = unstagedChanges[unstagedChanges.length - 1] ?? stagedChanges[stagedChanges.length - 1];
    debugLog(
        "nav",
        unstagedChanges.length > 0
            ? "previous: no active file context -> picking last changed file (unstaged-first)"
            : "previous: no active file context -> no unstaged changes; picking last staged file",
    );
    await openNavigationTarget(target, check);
    // Symmetric with openPreviousFile (v1.2.15): openLastFile is only ever reached via a BACKWARD entry
    // (pressing previous when nothing is under review wraps to the LAST file — see goToPreviousDiff /
    // goToLastOrPreviousFile). If that last file is a genuinely-new plain-editor file, land at its BOTTOM so the
    // NEXT 'previous' press steps UP through it instead of seeing top<=0 and skipping the whole file unseen (the
    // exact BUG 5 class of bug, previously only fixed for openPreviousFile — Codex xhigh flagged the asymmetry).
    await landChangeForBackwardReview(target, check);
};

// Refactor of the existing landNewFileTargetAtBottom gate/readiness checks, now shared by both directions.
// Ethan (2026-11-03): a first forward visit must start at line 1, even if VS Code remembers a caret from before
// Better Git reviewed this file. Ordinary revisits restore memory; an explicit forward boundary bypasses it.
// Backward entry retains its existing EOF landing so the following Previous pages upward.
//
// WHY the bottom landing (BUG 5, v1.2.9): a MODIFIED file lands at its LAST hunk on backward rollover (via
// compareEditor.previousChange), so subsequent 'previous' presses step UP through it. But that command is a
// NO-OP on a genuinely-new file's PLAIN editor (no diff hunks), leaving the view at the TOP — and since
// stepThroughNewFile treats a caret at line 1 as the backward completion signal, so leaving a new target's caret
// at the top makes the next 'previous' press advance to the file BEFORE it, skipping the new file's content unseen.
// Landing at the bottom
// makes the next 'previous' start stepping up from the end.
//
// WHY the !staged gate (Codex fix 2026-07-04): isFullyAddedFile is also true for a STAGED-new file
// (INDEX_ADDED), but openChangeEntry opens a staged entry as a side-by-side DIFF, not a plain new-file editor —
// so newFileScrollEditor() would never resolve; we'd burn the retry loop for nothing then swallow the
// compareEditor.previousChange landing. Gating on !staged keeps this to the plain-editor (untracked/unstaged-new)
// case; a staged-new target returns false so the caller falls through to its diff landing.
//
// Returns true if the target was recognised as a new-file (plain-editor) target — the backward caller must NOT run
// compareEditor.previousChange. Returns false for a non-new / staged target so the caller handles it normally.
const landNewFileTargetAtEdge = async (
    entry: FileChange, direction: "down" | "up", check = noNavigationCheckpoint,
): Promise<boolean> => {
    if (entry.staged || !isFullyAddedFile(entry.uri)) {
        return false; // modified / deleted / staged-new target -> caller takes the normal diff path
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== "file"
        || input.uri.toString() !== entry.uri.toString()) {
        // Reuse the newFileScrollEditor plain-text gate before waiting for layout. New images/notebooks
        // and empty-original diff views have no plain text caret to normalize and must not pay this wait.
        return false;
    }
    // The plain editor may not register in visibleTextEditors synchronously after openChangeEntry, so retry the
    // gate for a few short ticks. Reuses newFileScrollEditor() (plain file: tab + genuinely-new status + visible
    // editor) — the exact gate the in-file new-file stepping uses.
    let newFileEditor: vscode.TextEditor | undefined;
    for (let i = 0; i < 8 && !newFileEditor; i++) {
        check();
        newFileEditor = newFileScrollEditor();
        if (newFileEditor?.document.uri.toString() !== entry.uri.toString()) { newFileEditor = undefined; }
        if (!newFileEditor) {
            await new Promise((r) => setTimeout(r, 30)); // wait one short tick for the editor to become visible
        }
    }
    if (newFileEditor) {
        if (direction === "down") {
            await revealTopAndPinCursor(newFileEditor, 0, { forceWhenVisible: false });
        } else {
            // Default brings the final line into view at the BOTTOM without an impossible EOF AtTop target.
            await revealBottomAndPinCursor(newFileEditor, Math.max(0, newFileEditor.document.lineCount - 1), check);
        }
        debugLog("new-file", `${direction}: first review entry pinned to ${direction === "down" ? "L1" : "EOF"}`);
    }
    // If the editor never resolved, retain the native view. Do not substitute another editor or another file.
    return true;
};

// First-entry callers retain position memory; an explicit forward file boundary deliberately starts again.
// Native editor history alone must not put a new review halfway through a previously visited file.
const landChangeForForwardReview = async (
    entry: FileChange, check = noNavigationCheckpoint, fromStart = false,
): Promise<void> => {
    check();
    if (!hasRestoredReviewPosition(entry) && !(await landPlainMergeConflictTarget(entry, "down", check))) {
        const newFile = await landNewFileTargetAtEdge(entry, "down", check);
        if (fromStart && !newFile) {
            const editor = visibleEditorForActiveTab();
            if (editor && currentReviewFileUri()?.toString() === entry.uri.toString()) {
                // Begin a text diff at its first change, and a plain/deleted text view at line 1.
                // Use the existing parsed geometry, including deletion-only stops, rather than issuing
                // native Next from line 1 (which can skip a first change that itself starts on line 1).
                const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
                let firstLine = 0;
                if (input instanceof vscode.TabInputTextDiff) {
                    const geometry = await getModifiedSideHunkGeometry(entry.uri, entry.staged);
                    check();
                    const ignoreWhitespace = vscode.workspace.getConfiguration("diffEditor", entry.uri).get<boolean>("ignoreTrimWhitespace", true);
                    const starts = geometry.hunks.filter(hunk => !ignoreWhitespace || !hunk.whitespaceOnly).map(hunk => hunk.start);
                    firstLine = Math.min(...starts, ...geometry.deletionStops);
                    if (!Number.isFinite(firstLine)) { firstLine = 0; }
                }
                await revealTopAndPinCursor(editor, firstLine, { forceWhenVisible: false });
            }
        }
    }
    adoptLandedReviewPosition(entry, check);
};

// Own suppression through the complete open + landing, not just git.openChange's promise: its editor
// events can otherwise restore the old midpoint between those phases. No timer or input queue is added.
const openForwardNavigationTarget = async (
    entry: FileChange, check: NavigationCheckpoint, closeCurrent = false,
): Promise<void> => {
    const key = entry.uri.toString();
    // An explicit command can supersede an older queued open. Count scopes by exact file so either
    // completion order releases only its own suppression, never another open's or a stale global flag.
    startingReviewFiles.set(key, (startingReviewFiles.get(key) ?? 0) + 1);
    if (pendingReviewPosition?.view.fileUri === key) { pendingReviewPosition = undefined; }
    try {
        await openNavigationTarget(entry, check, closeCurrent);
        trackUnstagedReviewPosition();
        await landChangeForForwardReview(entry, check, true);
        check();
        if (currentReviewFileUri()?.toString() === key) {
            // A late TextEditor registration must not resurrect the old midpoint after suppression ends.
            // Successful restart replaces that remembered view; a failed/cancelled open keeps it intact.
            reviewFilePositions.forget(key);
            if (trackedPositionUri === key) { restoredPositionTab = undefined; }
        }
    } finally {
        const remaining = (startingReviewFiles.get(key) ?? 1) - 1;
        if (remaining) { startingReviewFiles.set(key, remaining); } else { startingReviewFiles.delete(key); }
    }
    // The successfully presented start is now the last known view; later manual switching still resumes it.
    rememberUnstagedReviewPosition(visibleEditorForActiveTab());
};

// One shared landing contract for EVERY cross-file backward transition. A plain unstaged new file has no diff
// navigator, so it starts at EOF; every other target asks the compare editor for its last change. Keeping this in
// one helper prevents openPreviousFile, openLastFile, and stage-and-previous from drifting into three subtly
// different behaviours again.
const landChangeForBackwardReview = async (entry: FileChange, check = noNavigationCheckpoint): Promise<void> => {
    check();
    // Revisit resumes Ethan's last position; only a FIRST visit uses the old EOF/last-hunk landing.
    if (!hasRestoredReviewPosition(entry)
        && !(await landPlainMergeConflictTarget(entry, "up", check))
        && !(await landNewFileTargetAtEdge(entry, "up", check))) {
        check();
        await landPreviousDiffAtLastChange(check);
    }
    // The landed last change is the review position: the following Previous must not re-select it.
    adoptLandedReviewPosition(entry, check);
};

const openNextFile = async (check: NavigationCheckpoint = noNavigationCheckpoint, fromStart = false) => {
    const fileChanges = await getFileChanges();

    const active = await getActiveChange();
    check();
    if (!active) {
        // v1.2.17 no-context pick: with no active file there is nothing to advance FROM, so choose the first
        // changed file instead. Crucially this returns before the normal isPreview/closeActiveEditor block:
        // starting a review must never close whatever non-review tab/editor the user currently has open.
        await openFirstFile(check);
        return;
    }

    if (fileChanges.length === 0) {
        // A clean/settings tab can still produce an ActiveChange-shaped path even though the repo has no
        // entries. Reuse the v1.2.17 first-entry path so this clean-repo case gets the same quiet status-bar
        // feedback and debug log instead of preserving the old silent return.
        await openFirstFile(check);
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
        const activePathExists = fileChanges.some((entry) => entry.uri.path.toLowerCase().endsWith(normalized));
        if (!activePathExists) {
            // v1.2.17 no-context pick: a clean/settings/other non-change tab is context for VS Code, but not
            // for change navigation. Pick the first change without closing that active editor (openFirstFile
            // intentionally only opens the target). This is the common post-stage-everything focus state.
            await openFirstFile(check);
            return;
        }
        // AMBIGUITY GUARD MUST KEEP BAILING: findCurrentIndex also returns -1 when a side-unknown file exists
        // in BOTH staged and unstaged groups. activePathExists distinguishes that uncertainty from a genuine
        // no-match; guessing here previously flung navigation to the wrong end of the list. A re-press works
        // once VS Code exposes the diff side, so preserve the safe no-op for this distinct -1 meaning.
        return;
    }

    // LOOP: wrap to the first file when at the end (one press loops back to the start), instead of closing
    // the editor. At the last index, (len-1 + 1) % len = 0 -> first file.
    const nextIndex = (currentIndex + 1) % fileChanges.length;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    const target = fileChanges[nextIndex];
    if (fromStart) { await openForwardNavigationTarget(target, check, !isPreview); }
    else {
        // Explicit file browsing is still a revisit. Only change-navigation rollover starts again.
        await openNavigationTarget(target, check, !isPreview);
        await landChangeForForwardReview(target, check);
    }
};

const openPreviousFile = async (check: NavigationCheckpoint = noNavigationCheckpoint) => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    check();
    if (!active) {
        // v1.2.17 no-context pick: mirror forward entry by selecting the last change, and return before the
        // normal closeActiveEditor path so starting backward review never destroys the user's current tab.
        await openLastFile(check);
        return;
    }

    if (fileChanges.length === 0) {
        // Mirror forward navigation: an active non-change tab in a clean repo is still "no review context".
        // Route through openLastFile for the shared status-bar acknowledgement rather than silently no-oping.
        await openLastFile(check);
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
        const activePathExists = fileChanges.some((entry) => entry.uri.path.toLowerCase().endsWith(normalized));
        if (!activePathExists) {
            // A non-change active tab supplies no review position. Pick the last unstaged-first target via the
            // shared backward entry path, which also handles bottom/last-hunk landing and never closes this tab.
            await openLastFile(check);
            return;
        }
        // BUG FIX (intermittent "previous jumps to the last staged change"): the old code did
        // `currentIndex <= 0 ? last : currentIndex - 1`, which treated "not found" (-1) the SAME as "at the
        // first file" (0) and wrapped to the LAST file. When the diff side wasn't readable for a dual-state
        // file, findCurrentIndex returned -1 and "previous" lurched to the last change. Now we bail on -1;
        // the next press (once the diff tab is readable) navigates correctly. Genuine index 0 still loops.
        // v1.2.17: activePathExists above preserves this ambiguity guard while routing ONLY true path misses
        // (clean/settings/non-change tabs) to the friendly no-context picker.
        return;
    }

    // LOOP: wrap to the last file only when genuinely at the first file (index 0).
    const prevIndex = currentIndex === 0 ? fileChanges.length - 1 : currentIndex - 1;

    // A diff boundary in the only changed file already wrapped natively to its last change. Reopening it
    // would treat that wrap as a revisit and restore the hunk START, skipping its unread tail on Previous.
    // Present that existing landing once; explicit Previous File commands still use the ordinary open path.
    if (prevIndex === currentIndex && departingReviewPosition?.fileUri === fileChanges[prevIndex].uri.toString()) {
        departingReviewPosition = undefined; // This is a loop into the same view, not a departing-file receipt.
        const ctx = await getHunkStageContext(check);
        check();
        if (ctx) { await revealHunkOnLanding(ctx, ctx.editor.selection.active.line, "up"); }
        adoptLandedReviewPosition(fileChanges[prevIndex], check);
        return;
    }

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    await openNavigationTarget(fileChanges[prevIndex], check, !isPreview);

    // BUG 5 FIX (v1.2.9 — backward rollover into a NEW file landed at its TOP and then skipped the whole file):
    // when navigating BACKWARD, a MODIFIED file lands at its LAST hunk (bottom) via compareEditor.previousChange,
    // so subsequent 'previous' presses step UP through it. But that command is a NO-OP on a genuinely-NEW file's
    // PLAIN editor (no diff hunks to step to), leaving the caret at line 0 (top). The next 'previous' press then
    // sees stepThroughNewFile('up') with cur<=0 (top edge), returns false, and jumps to the file BEFORE it — so
    // the entire new file's content is skipped unseen (only its first screenful was ever visible via backward
    // nav). Fix: for a genuinely-new target (isFullyAddedFile — the SAME shared predicate newFileScrollEditor
    // uses), pin the caret at the file's LAST line (bottom) — mirroring how a modified file lands at its last
    // hunk — so the following 'previous' press's stepThroughNewFile('up') is NOT at the top edge and steps up
    // through the whole file. IMPORTANT: only do the (retried) new-file landing when the TARGET is actually a
    // new file; a modified/deleted target takes the immediate compareEditor.previousChange path with NO delay
    // (the retry loop must never add latency to the common backward-diff rollover).
    // v1.2.15: the retry + bottom-landing logic (and the !staged gate rationale) now lives in the shared
    // landNewFileTargetAtEdge helper so openLastFile can reuse it. If the target was a genuinely-new
    // plain-editor file, the helper landed it at the bottom and we're done — do NOT run compareEditor.previousChange.
    await landChangeForBackwardReview(fileChanges[prevIndex], check);
};

// NEW-FILE detection (Ethan 2026-07-03, HARDENED in v1.2.1): a file is "fully added" when its entire
// content is one big new-diff — i.e. its git status is a whole-new-file state with NO original content:
// untracked (Status.UNTRACKED), staged-new (INDEX_ADDED), or intent-to-add (INTENT_TO_ADD).
//
// v1.2.1 ROOT-CAUSE FIXES baked in here (the v1.2.0 version of this check caused the "next-change stopped
// advancing / 5-line jump fired on modified files" regression):
//   • DUAL-STATE GUARD: a file staged as new (INDEX_ADDED) and then edited again is ALSO a working-tree
//     MODIFIED change — its working-tree diff has real hunks, so it must use normal hunk navigation. The
//     old check returned true purely because an INDEX_ADDED entry existed, hijacking hunk nav into 5-line
//     crawling. Now ANY non-new working-tree status (MODIFIED / DELETED / renamed / type-changed / conflict)
//     vetoes new-file mode outright.
//   • NO REPO GUESSING: the old `getRepository(uri) ?? repositories[0]` fell back to the FIRST repo when the
//     lookup missed, so a multi-repo workspace could consult the wrong repo's change lists. Now: no owning
//     repo (or git API not ready) -> false -> normal navigation. Never a silent no-op.
//   • file:-scheme only: a DELETED file's "editor" is HEAD content under a git: uri — resolving it to the
//     on-disk path and then status-matching could never be a whole-new-file state, but we guard the scheme
//     explicitly anyway so deleted/virtual views can't even reach the status lookup.
const isFullyAddedFile = (uri: vscode.Uri | undefined): boolean => {
    const fileUri = toFilePathUri(uri);
    if (!fileUri || fileUri.scheme !== "file") {
        return false;
    }
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        // Only trust the repo that actually CONTAINS this file — see NO REPO GUESSING note above.
        const repo = git?.getRepository(fileUri);
        if (!repo) {
            return false;
        }
        const p = fileUri.path.toLowerCase();
        const find = (changes: any[]) => (changes ?? []).find((c: any) => c.uri.path.toLowerCase() === p);
        // Working-tree entry first, because it can VETO. With the default git.untrackedChanges="mixed",
        // untracked files land here with status UNTRACKED; `git add -N` files land here as INTENT_TO_ADD.
        const wt = find(repo.state.workingTreeChanges);
        const wtIsNew = wt && (wt.status === GitStatus.UNTRACKED || wt.status === GitStatus.INTENT_TO_ADD);
        if (wt && !wtIsNew) {
            // Tracked working-tree change (MODIFIED / DELETED / INTENT_TO_RENAME / TYPE_CHANGED / ...):
            // there IS original content to diff against -> normal hunk navigation. This is the dual-state
            // guard: it fires even if the file is simultaneously INDEX_ADDED in the index.
            return false;
        }
        if (wtIsNew) {
            return true;
        }
        // git.untrackedChanges="separate" keeps untracked files in their own list — everything in it is
        // by definition a whole-new file.
        if (find(repo.state.untrackedChanges)) {
            return true;
        }
        // Staged brand-new file with NO working-tree entry at all (clean since staging): the index entry
        // must be a whole-new-file status. INDEX_DELETED / INDEX_RENAMED / INDEX_MODIFIED etc. all fail
        // this check — renames are git's classic "delete+add" trap and must navigate normally.
        const idx = find(repo.state.indexChanges);
        return !!idx && (idx.status === GitStatus.INDEX_ADDED || idx.status === GitStatus.INTENT_TO_ADD);
    } catch {
        return false; // git API not ready / shape changed — fall back to normal change navigation
    }
};

// Resolves the TextEditor OBJECT that is actually rendering the active TAB's document (for a side-by-side
// diff: its MODIFIED/right side; for a plain tab: that document's editor). This is NOT the same thing as
// vscode.window.activeTextEditor — that is the *focused* editor (or the most recently focused one), and in
// Ethan's review flow keyboard focus frequently sits in the Source Control panel: SCM single-clicks open
// files with preserveFocus:true, so activeTextEditor can keep pointing at a completely DIFFERENT file.
// THE v1.2.0 BUG: goToNextDiff decided "new file? -> step" from the active tab but then stepped
// vscode.window.activeTextEditor — when the two disagreed, the cursor moved invisibly in a stale/hidden
// editor (perceived hard no-op, "not going to next change") or 5-line-stepped a MODIFIED file's editor.
// Navigation must decide AND act on the same tab-derived editor; this helper is that single source of truth.
const visibleEditorForActiveTab = (): vscode.TextEditor | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    let target: vscode.Uri | undefined;
    if (input instanceof vscode.TabInputTextDiff) {
        target = input.modified; // change-navigation moves the cursor on the right/modified side
    } else if (input instanceof vscode.TabInputText) {
        target = input.uri;
    }
    if (!target) {
        return undefined; // webview / binary / merge tab — no plain text editor to resolve
    }
    const key = target.toString();
    // uri.toString() compares scheme + path + query, so the two git:-scheme sides of a staged diff (same
    // path, different ref in the query) cannot be confused with each other or with the on-disk file.
    // The same document can be visible in multiple groups, each with its own caret and viewport.
    // URI equality alone can move the background copy and feed its stale caret into diff rollover.
    const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const candidates = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
    return candidates.find((e) => e.viewColumn === column)
        ?? (candidates.length === 1 && candidates[0].viewColumn === undefined ? candidates[0] : undefined);
};

// Ethan: switching away and back must resume an unfinished text review, including preview tabs that VS Code
// replaces. This observes the same tab-owned editor as navigation; staged sides, images and clean ordinary
// editors never enter the cache. Deleted text is allowed; image zoom/pan keeps its separate existing behavior.
const trackUnstagedReviewPosition = (): void => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const editor = visibleEditorForActiveTab();
    if (trackedPositionTab === tab && trackedPositionInput === tab?.input && trackedPositionEditor === editor && trackedPositionUri) { return; }
    trackedPositionTab = tab; trackedPositionInput = tab?.input; trackedPositionEditor = undefined; trackedPositionUri = undefined;
    restoredPositionTab = undefined; pendingReviewPosition = undefined;
    if (!tab || !editor) { return; }
    const view = captureActiveStageUndoView(true);
    if (!view) { return; }
    const uri = vscode.Uri.parse(view.fileUri);
    const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    const repo = git?.getRepository(uri);
    const matches = (changes: readonly { uri: vscode.Uri; status: number }[] = []): boolean =>
        changes.some(change => change.status !== GitStatus.IGNORED && change.uri.toString() === view.fileUri
            && (editor.document.uri.scheme === "file" || change.status === GitStatus.DELETED));
    if (!repo || !(matches(repo.state.workingTreeChanges) || matches(repo.state.untrackedChanges) || matches(repo.state.mergeChanges))) {
        return;
    }
    trackedPositionEditor = editor; trackedPositionUri = view.fileUri;
    const saved = startingReviewFiles.has(view.fileUri) ? undefined : reviewFilePositions.get(view.fileUri);
    if (!saved) { return; }
    const pending = { tab, editor, view: saved };
    pendingReviewPosition = pending;
    // Let the current editor-open event batch finish applying native defaults. This is one event-loop
    // callback, not a timer, input delay, polling loop or Git operation. A newer tab/user cursor move wins.
    setImmediate(() => {
        if (pendingReviewPosition !== pending) { return; }
        pendingReviewPosition = undefined;
        applyRememberedReviewPosition(pending.tab, pending.editor, pending.view);
    });
};

// Capture the live next-press owner with the coordinates, exactly as anchorNavigationAtViewport would decide it.
const capturedReviewPosition = (editor: vscode.TextEditor): ReviewFilePosition | undefined => {
    const view = captureActiveStageUndoView(true);
    return view && { ...view, resumeFromViewport: reviewResumesFromViewport(editor) };
};

const rememberUnstagedReviewPosition = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || editor !== trackedPositionEditor || pendingReviewPosition || applyingReviewPosition
        || trackedPositionTab !== vscode.window.tabGroups.activeTabGroup.activeTab || !trackedPositionUri
        || startingReviewFiles.has(trackedPositionUri)) { return; }
    // The native wrap that precedes a file boundary is not where Ethan left this file; keep the pre-wrap view.
    const departing = departingReviewPosition?.documentUri === editor.document.uri.toString() ? departingReviewPosition : undefined;
    const view = departing ?? capturedReviewPosition(editor);
    if (view?.fileUri === trackedPositionUri) { reviewFilePositions.remember(view); }
};

const applyRememberedReviewPosition = (tab: vscode.Tab, editor: vscode.TextEditor, view: ReviewFilePosition): boolean => {
    if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab || visibleEditorForActiveTab() !== editor
        || trackedPositionUri !== view.fileUri || editor.document.uri.toString() !== view.documentUri) { return false; }
    applyingReviewPosition = true;
    try {
        // The no-settle branch applies its setters synchronously before returning its fulfilled promise.
        void restoreStageUndoView(view, false).catch(error => debugLog("nav", `saved review position unavailable: ${String(error)}`));
        restoredPositionTab = tab;
        // Resume the next press the way Ethan left it. A caret placed by review navigation continues from that
        // caret; otherwise (he scrolled independently, or an older entry lacks the flag) the restored viewport
        // wins. restoredTop marks this restore's own asynchronous reveal so it is not mistaken for a manual scroll.
        const resumeFromViewport = view.resumeFromViewport !== false;
        const viewport = readViewport(editor);
        if (viewport) {
            reviewViewportState.set(editor, {
                top: viewport.top, bottom: viewport.bottom, manuallyScrolled: resumeFromViewport,
                // If native view memory already put us here, no later scroll belongs to this restore.
                restoredTop: view.topLine !== undefined && Math.abs(viewport.top - view.topLine) > 1
                    ? view.topLine : undefined,
            });
        }
        if (!resumeFromViewport) { navigatedReviewEditors.add(editor); }
        debugLog("nav", `restored unstaged review position ${view.fileUri}, top=${view.topLine ?? 0}, next press from ${resumeFromViewport ? "viewport" : "caret"}`);
        return true;
    } finally { applyingReviewPosition = false; }
};

const restoreRememberedReviewPosition = (entry: FileChange, saved: ReviewFilePosition | undefined): boolean => {
    if (!saved || entry.staged || startingReviewFiles.has(entry.uri.toString())
        || currentReviewFileUri()?.toString() !== entry.uri.toString()) { return false; }
    trackUnstagedReviewPosition();
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const editor = visibleEditorForActiveTab();
    if (!tab || !editor || trackedPositionUri !== entry.uri.toString()) { return false; }
    pendingReviewPosition = undefined;
    return applyRememberedReviewPosition(tab, editor, saved);
};

const hasRestoredReviewPosition = (entry: FileChange): boolean => !entry.staged
    && !startingReviewFiles.has(entry.uri.toString())
    && restoredPositionTab === vscode.window.tabGroups.activeTabGroup.activeTab
    && trackedPositionUri === entry.uri.toString();

// THE STRUCTURAL GATE for new-file scroll mode (v1.2.1). Returns the editor to 5-line-step through, or
// undefined meaning "use normal navigation". ALL FOUR conditions must hold:
//   (a) the active tab is a PLAIN single editor (TabInputText) — NOT a side-by-side diff. A diff tab means
//       an original side exists, so hunk navigation applies. This alone makes it structurally IMPOSSIBLE
//       for a MODIFIED file (which always opens as a diff) to get the 5-line step — the exact v1.2.0
//       regression Ethan reproduced. Trade-off accepted: a staged-new file opened as its empty-original
//       DIFF now falls through to normal nav (advances to the next file) instead of stepping; opening the
//       plain file still steps. Never compromise modified-file navigation for that case.
//   (b) the tab shows the ON-DISK file (file: scheme). A DELETED file also opens as a plain editor, but of
//       the HEAD blob under a git: uri — its content is REMOVED, not added, so it must never scroll-step.
//   (c) git confirms the whole file is genuinely new (isFullyAddedFile above, with its dual-state guard).
//   (d) a visible TextEditor for that exact document exists — we only ever step the editor the user is
//       LOOKING at. No match (races, weird layouts) -> undefined -> normal navigation, never a silent no-op.
const newFileScrollEditor = (): vscode.TextEditor | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputText)) {
        return undefined; // (a) not a plain single-editor tab
    }
    const uri = tab.input.uri;
    if (uri.scheme !== "file") {
        return undefined; // (b) deleted-file / virtual-document guard
    }
    if (!isFullyAddedFile(uri)) {
        return undefined; // (c) not a genuinely brand-new file
    }
    return visibleEditorForActiveTab(); // (d), including the active editor group
};

// Shared step logic for new-file scroll mode: scroll `editor` `direction` by newFileNavLineJump lines within
// a fully-added file so you can page through it. Returns true if it scrolled a step (caller stops), or false
// only when the caret is already parked at the requested far edge (caller then falls through to the adjacent
// FILE). Reaching the edge and leaving the file are intentionally separate presses: the user must always see a
// final partial step land at line 1 / the last line before navigation changes files.
//
// v1.2.25 EDGE CONTRACT (supersedes the v1.2.15 "edge visible means advance" rule):
//   • Progress is caret-derived: target = clamp(caret ± configuredStep). This is exact under word wrap/sticky
//     context and also respects a caret the user moved manually.
//   • DOWN's final partial step uses revealBottomAndPinCursor(last), so EOF is visibly presented at the bottom
//     despite AtTop's unavoidable near-EOF clamp. UP's final partial step mirrors it at line 1 via AtTop.
//   • Rollover happens only on a later press when the caret is already at that edge. If caret and viewport ever
//     decouple, the edge is revealed once before rollover, preventing an invisible cross-file jump.
// This fixes both asymmetric failures caused by the old viewport edge gate: NEXT skipped the remaining <step
// lines whenever EOF merely entered the viewport, and PREVIOUS jumped to the prior file's bottom whenever line 1
// was visible even though the caret was still several steps below it.
//
// v1.2.1 legacy note (superseded in v1.2.22): this used to call showTextDocument to focus the file before
// stepping because an unfocused editor did not draw its caret. That call can return/activate a replacement
// TextEditor object for the same document, however, which defeats the exact-editor identity required by the
// focus-independent reveal waiter below. The active-tab gate already hands us the TextEditor that is actually
// rendering the tab, and editor-scoped revealRange works without keyboard/OS focus, so keep and operate on that
// object. Selection still updates; VS Code draws the caret whenever the editor next receives focus.
const stepThroughNewFile = async (editor: vscode.TextEditor, direction: "down" | "up", check = noNavigationCheckpoint): Promise<boolean> => {
    const configured = vscode.workspace.getConfiguration("better-git-vscode").get<number>("newFileNavLineJump", 5);
    // Guard bad user values: 0 / negative / NaN would "step" in place forever — a permanent no-op. Floor
    // fractional values; anything non-usable falls back to the default 5.
    const step = Number.isFinite(configured) && (configured as number) >= 1 ? Math.floor(configured as number) : 5;

    const stepEditor = editor;
    const last = Math.max(0, stepEditor.document.lineCount - 1);
    const vp = readViewport(stepEditor);
    if (!vp) {
        // Editor not laid out yet (visibleRanges empty) — fall back to the pre-v1.2.15 caret-based step so a
        // press is never silently swallowed. Best-effort; the viewport path takes over on the next press once
        // the editor is laid out.
        const cur = stepEditor.selection.active.line;
        const atEdge = direction === "down" ? cur >= last : cur <= 0;
        if (atEdge) {
            debugLog("new-file", `${direction}: no viewport + caret at edge (L${cur + 1}/L${last + 1}) -> advance to ${direction === "down" ? "next" : "previous"} file`);
            return false;
        }
        const target = direction === "down" ? Math.min(cur + step, last) : Math.max(cur - step, 0);
        await revealTopAndPinCursor(stepEditor, target, { forceWhenVisible: direction === "down" });
        debugLog("new-file", `${direction}: no viewport, caret-fallback step L${cur + 1}->L${target + 1} (step=${step})`);
        return true;
    }

    const { top, bottom, visLines } = vp;
    const caret = stepEditor.selection.active.line;
    if (direction === "down") {
        if (caret >= last) {
            // A stale/decoupled caret at EOF must not change files invisibly. Present EOF once, then let the next
            // press roll over. For a wrapped final line, its END—not merely its first visual segment—must be shown.
            if (!positionIsVisible(stepEditor, bottomPresentationPosition(stepEditor, last))) {
                await revealBottomAndPinCursor(stepEditor, last, check);
                debugLog("new-file", `down: caret already at L${last + 1} but EOF off-screen (viewport L${top + 1}-L${bottom + 1}) -> reveal EOF before rollover`);
                return true;
            }
            debugLog("new-file", `down: caret and viewport already at EOF L${last + 1} -> advance to next file`);
            return false;
        }

        const target = Math.min(caret + step, last);
        if (target === last) {
            // Always consume a final partial step at EOF, even when EOF was already visible. Default reveal puts
            // the last line at the bottom without the near-EOF AtTop clamp, and parks the caret for next-press rollover.
            await revealBottomAndPinCursor(stepEditor, last, check);
        } else {
            await revealTopAndPinCursor(stepEditor, target);
        }
        debugLog("new-file", `down: step caret L${caret + 1}->L${target + 1}${target === last ? " (final partial step at EOF)" : ""} (viewport L${top + 1}-L${bottom + 1}, last L${last + 1}, vis=${visLines}, step=${step})`);
        return true;
    }

    if (caret <= 0) {
        // Mirror the decoupling guard above: line 1 must actually be presented once before changing files.
        if (!positionIsVisible(stepEditor, new vscode.Position(0, 0))) {
            await revealTopAndPinCursor(stepEditor, 0, { forceWhenVisible: false });
            debugLog("new-file", `up: caret already at L1 but file start off-screen (viewport L${top + 1}-L${bottom + 1}) -> reveal start before rollover`);
            return true;
        }
        debugLog("new-file", "up: caret and viewport already at L1 -> advance to previous file");
        return false;
    }

    const target = Math.max(caret - step, 0);
    await revealTopAndPinCursor(stepEditor, target, { forceWhenVisible: false });
    debugLog("new-file", `up: step caret L${caret + 1}->L${target + 1}${target === 0 ? " (final partial step at file start)" : ""} (viewport L${top + 1}-L${bottom + 1}, last L${last + 1}, vis=${visLines}, step=${step})`);
    return true;
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// TALL-HUNK STAGING (v1.2.6)
//
// WHY this exists (Ethan's exact problem): when reviewing with next/previous-change, a hunk that is
// TALLER than the visible editor is a pain. One press of next-change lands you at the START (top) of the
// hunk, but the rest of it runs off the bottom of the screen. To read the rest he has to take his hands
// off the keyboard, scroll manually, then press next again. He wants to STEP THROUGH a tall hunk in
// stages using the SAME next/previous-change keys: next lands at the top; pressing next AGAIN scrolls
// DOWN by ~a screenful within that same hunk; repeat until the BOTTOM is on screen; the NEXT press then
// advances to the next hunk. previous-change mirrors it (step UP in stages, then advance to the prev hunk).
//
// ── DESIGN CHOICE: STATELESS / LIVE EDITOR-DERIVED, NOT AN EXPLICIT STATE MACHINE ──
// The spec framed this as a state machine ("track that you're mid-scrolling hunk X in direction D, reset
// when you switch files / reverse / move the cursor"). We deliberately implement it WITHOUT a persisted
// state object. Every press RECOMPUTES from three live facts: (1) the cursor line, which exclusively owns
// logical ±step progression and edge completion, (2) the current viewport, which supplies real height for auto
// step/threshold values and proves the requested edge was presented, and (3) the current file's hunk geometry
// (parsed fresh from git). This is the
// same "recompute-live, tab-derived, focus-independent" philosophy the rest of this file already uses
// (see visibleEditorForActiveTab / getActiveChange) and it makes ALL the required reset rules fall out
// for free, with NO stale-state bugs to chase:
//   • switch files / editors      -> a different tab means different hunks + a cursor at the new file; the
//                                     old file's viewport is gone, so there's nothing stale to reset.
//   • reverse direction mid-scroll -> "previous while scrolling down" computes caret-step from the current
//                                     caret. No teleport, because we never stored a
//                                     "we were going down" flag to contradict.
//   • cursor / selection moves elsewhere -> the cursor is no longer inside any tall hunk, so
//                                     hunkContainingLine() returns undefined and we fall straight through
//                                     to today's plain hunk-to-hunk navigation.
//   • reached the end of the hunk  -> a final partial press lands at the exact edge; only a later press advances.
//
// ── CURSOR vs SCROLL ──
// While stepping we move BOTH the viewport (revealRange) AND pin the cursor to the exact requested logical line.
// Keeping the caret inside the hunk (rather than leaving it at the file top) means: (a) other
// commands stay sensible — revert-and-save (git.revertSelectedRanges) reverts the hunk the caret sits in,
// which is exactly the hunk being read; and (b) when we DO advance, VS Code's built-in
// compareEditor.next/previousChange navigates relative to the caret, so from inside the current (single,
// contiguous) hunk it correctly lands on the following / preceding hunk.
//
// ── HOW WE KNOW A HUNK'S EXTENT ──
// VS Code's built-in change navigation only exposes hunk STARTS (it moves the caret to each change), never
// a hunk's END — and there's no stable public API on a diff editor to read its change regions on engine
// ^1.83 (TextEditor.diffInformation is proposed API). So we compute the modified-side hunk ranges ourselves
// by asking the git extension for the file's unified diff and parsing the `@@ ... +newStart,newCount @@`
// headers (see getModifiedSideHunkGeometry). An INNER hunk = a maximal run of ADDED ('+') lines on the
// modified side; those preserve the ordinary change stops VS Code normally exposes. We also retain one OUTER
// range per `@@` header, spanning its first through last '+' line. Git and VS Code do not always group a large
// replacement identically: VS Code can render/navigate it as one change while Git's unified body contains several
// short '+' runs. The outer range therefore guards against an oversized built-in jump as well as a no-movement
// cross-file rollover, while nearby inner stops remain change-to-change. Deleted-only regions produce no modified-side lines
// and remain ordinary built-in navigation.
//
// ── COMPOSITION (must not break anything) ──
// This layer is an INTERPOSER: it runs only for side-by-side text diffs (TabInputTextDiff). It pages a tall hunk
// until its edge is consumed, or selects a wholly visible nearby run without native recentering. In other cases
// it returns "not consumed" and the existing native navigation runs — so the new-file
// line-scroll (plain-editor added files), modified-file hunk nav, deleted files, cross-file rollover, the
// smart mouse commands (which just executeCommand these same scm-change commands), and the dvorak/qwerty
// key gating are all untouched. Everything is defensive (try/catch, empty-diff -> defer) so a parse failure
// can never turn a keypress into a dead no-op — worst case it degrades to today's plain hunk navigation.

// One contiguous changed region on the modified (new/right) side of a diff, as 0-based inclusive line
// numbers matching the editor's modified-side document. Produced by getModifiedSideHunkGeometry.
interface ModifiedHunk {
    start: number; // first changed line (0-based)
    end: number; // last changed line (0-based, inclusive)
    whitespaceOnly?: boolean; // native navigation may hide a trim-whitespace-only replacement
}

// Reads the live config for the whole feature in one place so every helper agrees on the numbers. All the
// "auto" defaults resolve against the passed-in visible line count so they adapt to Ethan's actual window
// height (a blind fixed page-jump loses your place; viewport-relative feels right). Bad/absent values fall
// back to sane defaults — never NaN/0 that could freeze stepping in place.
const hunkStagingConfig = (visLines: number) => {
    const cfg = vscode.workspace.getConfiguration("better-git-vscode");
    const enabled = cfg.get<boolean>("hunkStagingEnabled", true);
    // Overlap: lines kept on screen between consecutive steps so reading context carries across (default 4).
    const rawOverlap = cfg.get<number>("hunkStagingOverlap", 4);
    const overlap = Number.isFinite(rawOverlap) && (rawOverlap as number) >= 0 ? Math.floor(rawOverlap as number) : 4;
    // Threshold: minimum hunk height (lines) to ENGAGE staging. 0 (default) = presentation-aware AUTO:
    // callers inspect the hunk's actual first/last rendered positions instead of treating the viewport's logical
    // line span as usable space. That distinction matters when a newly reached hunk starts near the bottom, when
    // lines wrap, or when diff alignment consumes vertical space. A positive value retains the fixed override.
    const rawThreshold = cfg.get<number>("hunkStagingThreshold", 0);
    const thresholdOverride =
        Number.isFinite(rawThreshold) && (rawThreshold as number) > 0
            ? Math.floor(rawThreshold as number)
            : undefined;
    const threshold = thresholdOverride ?? visLines;
    // Step: lines to scroll per press. The user-facing default is an exact ten logical lines. Explicit 0 keeps
    // the viewport-minus-overlap AUTO mode available; any positive custom value remains an exact fixed step.
    const rawStep = cfg.get<number>("hunkStagingLineStep", 10);
    const step =
        Number.isFinite(rawStep) && (rawStep as number) > 0
            ? Math.max(1, Math.floor(rawStep as number))
            : Math.max(1, visLines - overlap);
    return { enabled, overlap, threshold, thresholdOverride, step };
};

// Parse the modified-side (new/right) changed geometry of the file currently being reviewed. We get the unified
// diff straight from the git
// extension and read the `@@ -old +newStart,newCount @@` headers, then within each header's body count the
// modified-side line number as we walk it: ' ' context and '+' added lines each occupy a modified line
// (advance the counter); '-' removed lines exist only on the OLD side (don't advance, don't break a run —
// in a replacement all '-' come before the '+' block, so the '+' lines stay contiguous). Each maximal run
// of '+' lines becomes one inner ModifiedHunk. Each `@@` body also contributes one outer ModifiedHunk from its
// first through last '+' line, even when context divides those additions into several inner runs. Line numbers
// therefore match the editor's modified document:
//   • unstaged side  -> modified doc is the on-disk working file; the working-vs-INDEX diff's +lines are
//                       working lines. This is the SAME diff git.openChange DISPLAYS for the unstaged side.
//   • staged  side   -> modified doc is the git: index blob; diffIndexWithHEAD's +lines are index lines.
//
// Partially staged files must use working tree vs index. A HEAD comparison would create phantom hunks over
// already staged lines and can skip real changes. Despite its name, VS Code Git's diffWithHEAD(path) uses
// `git diff -- <path>` with no HEAD argument (verified in VS Code 1.83 and the current built-in extension).
// Read that one file per request so navigation and overview markers never diff unrelated files in the worktree.
// Keep the read fresh because a partial stage can change the comparison without changing the editor text.


interface ModifiedHunkGeometry {
    hunks: ModifiedHunk[]; // maximal '+' runs: preserve VS Code's ordinary inner navigation stops
    outerHunks: ModifiedHunk[]; // first..last '+' line per @@ header: guard oversized jumps/rollover
    deletionStops: number[]; // preserve native deleted-only stops between visible added-line runs
}

const emptyModifiedHunkGeometry = (): ModifiedHunkGeometry => ({ hunks: [], outerHunks: [], deletionStops: [] });

const getModifiedSideHunkGeometry = async (
    fileUri: vscode.Uri,
    staged: boolean,
): Promise<ModifiedHunkGeometry> => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(fileUri);
        if (!repo) {
            return emptyModifiedHunkGeometry(); // no owning repo (or git not ready) -> defer to built-in navigation
        }
        let diffText: string;
        if (staged) {
            diffText = await repo.diffIndexWithHEAD(fileUri.fsPath); // staged diff (index vs HEAD)
        } else {
            const relativePath = path.relative(repo.rootUri.fsPath, fileUri.fsPath);
            const gitPath = relativePath.split(path.sep).join("/");
            // The Git API normalizes backslashes to slashes even on POSIX. Keep exact section extraction
            // for those filenames and for paths whose spelling is not relative to the API's repo root.
            const canScopeDiff = !!gitPath && gitPath !== ".." && !gitPath.startsWith("../")
                && !path.isAbsolute(relativePath) && !gitPath.includes("\\");
            const scopedDiff: string | undefined = canScopeDiff
                ? await repo.diffWithHEAD(`:(literal)${gitPath}`) : undefined;
            // A one-sided add or delete can be half of an unstaged rename. The whole diff is needed
            // only then, so Git can pair it with the other path before we extract this file's hunks.
            const needsRenameContext = scopedDiff !== undefined && /^(?:new|deleted) file mode /m.test(scopedDiff);
            diffText = extractFileDiffSection(
                scopedDiff !== undefined && !needsRenameContext ? scopedDiff : await repo.diff(false), gitPath,
            );
        }
        if (!diffText) {
            return emptyModifiedHunkGeometry();
        }
        const hunks: ModifiedHunk[] = [];
        const outerHunks: ModifiedHunk[] = [];
        const deletionStops: number[] = [];
        const lines = diffText.split("\n");
        // Matches a unified-diff hunk header and captures the modified-side (+) start line and count.
        const headerRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
        let modLine = 0; // 1-based modified-side line number as we walk the current hunk body
        let inHunk = false;
        let runStart = -1; // start of the current '+' run (1-based), or -1 when not in a run
        let runEnd = -1; // last line of the current '+' run (1-based)
        let outerStart = -1; // first '+' line in the current @@ body (1-based)
        let outerEnd = -1; // last '+' line in the current @@ body (1-based)
        let removedLines: string[] = [];
        let addedLines: string[] = [];
        const closeRun = () => {
            if (runStart !== -1) {
                hunks.push({
                    start: runStart - 1,
                    end: runEnd - 1,
                    whitespaceOnly: removedLines.length === addedLines.length &&
                        addedLines.every((line, index) => line.trim() === removedLines[index].trim()),
                }); // convert to 0-based inclusive
                runStart = -1;
                runEnd = -1;
            } else if (removedLines.length > 0) {
                deletionStops.push(Math.max(0, modLine - 1));
            }
            removedLines = [];
            addedLines = [];
        };
        const closeOuterHunk = () => {
            if (outerStart !== -1) {
                outerHunks.push({ start: outerStart - 1, end: outerEnd - 1 });
                outerStart = -1;
                outerEnd = -1;
            }
        };
        for (const line of lines) {
            const header = headerRe.exec(line);
            if (header) {
                closeRun(); // a new header ends any run from the previous hunk
                closeOuterHunk(); // and closes the broader replacement group from that @@ body
                modLine = parseInt(header[1], 10); // +newStart
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                continue; // skip the file header lines (diff --git, index, ---, +++) before the first @@
            }
            const c = line[0];
            if (c === "+") {
                addedLines.push(line.slice(1));
                if (runStart === -1) {
                    runStart = modLine; // begin a new run of added lines
                }
                runEnd = modLine;
                if (outerStart === -1) {
                    outerStart = modLine;
                }
                outerEnd = modLine;
                modLine++;
            } else if (c === " ") {
                closeRun(); // context line ends a run and occupies a modified-side line
                modLine++;
            } else if (c === "-") {
                removedLines.push(line.slice(1));
                // Removed line: exists only on the OLD side. Don't advance the modified counter, and don't
                // break the run — the following '+' lines (if any) remain contiguous in modified numbering.
            } else {
                // "\ No newline at end of file" markers, blank trailing token from the final split, etc.
                closeRun();
            }
        }
        closeRun(); // flush the last run at end of diff
        closeOuterHunk(); // flush the broader range from the final @@ body
        return { hunks, outerHunks, deletionStops };
    } catch {
        return emptyModifiedHunkGeometry(); // git API shape changed / diff failed -> defer to plain navigation
    }
};

// Find the hunk the caret is currently sitting in (our "logical current change"). Uses CONTAINMENT with a
// tiny tolerance: the built-in change navigation can land the caret a line off from our parsed hunk start,
// so we treat [start-tol, end+tol] as "inside". Returns undefined when the caret isn't inside any hunk
// (e.g. resting in unchanged code between hunks) -> caller defers to plain hunk-to-hunk navigation.
const hunkContainingLine = (hunks: ModifiedHunk[], line: number, tol = 1): ModifiedHunk | undefined => {
    return hunks.find((h) => line >= h.start - tol && line <= h.end + tol);
};

// Bundle of everything the stepping logic needs for the file currently under review, or undefined when
// tall-hunk staging doesn't apply (feature off, not a side-by-side diff tab, no resolvable editor/file, or
// no parsed hunks). Computing this once per press means we parse the diff a single time and reuse it for
// both the step decision and the on-landing reveal.
interface HunkStageContext {
    check: NavigationCheckpoint;
    editor: vscode.TextEditor; // the visible editor rendering the modified side (the thing we scroll)
    hunks: ModifiedHunk[]; // inner '+' runs used before built-in navigation
    outerHunks: ModifiedHunk[]; // broader @@ groups guarding oversized built-in jumps and rollover
    deletionStops: number[];
}

const getHunkStageContext = async (check = noNavigationCheckpoint): Promise<HunkStageContext | undefined> => {
    // A quick viewport-independent gate read first (visLines only affects the numeric knobs, not enablement).
    if (!vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("hunkStagingEnabled", true)) {
        return undefined;
    }
    // ONLY side-by-side text diffs have hunk geometry to step through. Plain-editor tabs (new files,
    // deleted-file HEAD views) are handled by other code paths and must never reach here.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
        return undefined;
    }
    const editor = visibleEditorForActiveTab(); // the modified/right side's actual TextEditor (focus-independent)
    if (!editor) {
        return undefined;
    }
    const fileUri = currentReviewFileUri(); // on-disk file: uri (resolves a staged git: side back to the path)
    if (!fileUri) {
        return undefined;
    }
    // Which side is showing? getActiveChange reports staged===true when the modified side is the git: index
    // blob. That selects diffIndexWithHEAD vs diffWithHEAD so the parsed line numbers match the shown doc.
    const active = await getActiveChange();
    const staged = active?.staged === true;
    const { hunks, outerHunks, deletionStops } = await getModifiedSideHunkGeometry(fileUri, staged);
    check();
    if (hunks.length === 0) {
        return undefined; // nothing parseable -> defer to plain navigation
    }
    return { editor, hunks, outerHunks, deletionStops, check };
};

// Reads the current viewport of an editor as {top, bottom, visLines}. Uses the FIRST visible range's start
// and the LAST visible range's end so folded regions in between don't confuse the height. Returns undefined
// if the editor isn't laid out yet (no visible ranges) -> caller defers.
const readViewport = (editor: vscode.TextEditor): { top: number; bottom: number; visLines: number } | undefined => {
    const ranges = editor.visibleRanges;
    if (!ranges || ranges.length === 0) {
        return undefined;
    }
    const top = ranges[0].start.line;
    const bottom = ranges[ranges.length - 1].end.line;
    return { top, bottom, visLines: Math.max(1, bottom - top + 1) };
};

const positionIsVisible = (editor: vscode.TextEditor, position: vscode.Position): boolean =>
    editor.visibleRanges.some((range) => range.contains(position));

// A logical line can occupy many visual rows under word wrap. For a bottom/EOF presentation, line:0 only proves
// that the FIRST wrapped segment is visible; the user still has unread content below it. Reveal the line's end in
// wrapped editors, but keep column 0 for unwrapped editors so a long line never causes a horizontal jump.
const editorUsesWordWrap = (editor: vscode.TextEditor): boolean => {
    const editorWrap = vscode.workspace
        .getConfiguration("editor", editor.document.uri)
        .get<string>("wordWrap", "off");
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff) {
        const diffWrap = vscode.workspace
            .getConfiguration("diffEditor", editor.document.uri)
            .get<string>("wordWrap", "inherit");
        if (diffWrap === "on") {
            return true;
        }
        if (diffWrap === "off") {
            return false;
        }
    }
    return editorWrap !== "off";
};

const bottomPresentationPosition = (editor: vscode.TextEditor, line: number): vscode.Position => {
    const clamped = Math.max(0, Math.min(line, Math.max(0, editor.document.lineCount - 1)));
    return editorUsesWordWrap(editor)
        ? editor.document.lineAt(clamped).range.end
        : new vscode.Position(clamped, 0);
};

// AUTO tall-hunk detection must answer the user-visible question: "is every changed line presented right now?"
// Comparing hunk span with `visibleRanges` height is only an approximation. A 31-line hunk can numerically fit a
// 33-line viewport while only its first seven lines are visible because the previous hunk occupies the rest of the
// screen. Wrapped rows and diff alignment create the same mismatch. Checking the exact start plus the final visual
// segment makes zoom, wrapping, sticky context, and the hunk's current landing position part of the real decision.
const hunkIsFullyPresented = (editor: vscode.TextEditor, hunk: ModifiedHunk): boolean =>
    positionIsVisible(editor, new vscode.Position(hunk.start, 0)) &&
    positionIsVisible(editor, bottomPresentationPosition(editor, hunk.end));

// Native next/previousChange always CENTRES its target range, even when that range is already visible.
// After an AtTop page step this can scroll backwards, followed by a forward scroll on the next press.
// Keep an entirely visible added/replaced run in place and advance only the caret. Do this BEFORE the
// native command: restoring the viewport afterwards would retain the visible out-and-back flash.
// Off-screen changes, deleted-only stops and file boundaries still use native navigation. Git and the
// editor may group replacements differently; the outer-hunk interposer runs first to retain unread content.
const selectVisibleHunkWithoutScrolling = (ctx: HunkStageContext, direction: "down" | "up"): boolean => {
    if (ctx.editor.document.isDirty) {
        return false; // Git geometry is on-disk; native navigation owns unsaved editor changes.
    }
    const caret = ctx.editor.selection.active.line;
    const ignoreWhitespace = vscode.workspace.getConfiguration("diffEditor", ctx.editor.document.uri)
        .get<boolean>("ignoreTrimWhitespace", true);
    const candidates = ctx.hunks.filter(hunk => !(ignoreWhitespace && hunk.whitespaceOnly));
    const target = direction === "down"
        ? candidates.find(hunk => hunk.start > caret)
        : [...candidates].reverse().find(hunk => hunk.start < caret);
    if (!target || !hunkIsFullyPresented(ctx.editor, target)) {
        return false;
    }
    const low = Math.min(caret, target.start);
    const high = Math.max(caret, target.start);
    if (ctx.deletionStops.some(line => line >= low && line <= high)) {
        return false; // never jump over a deleted-only native change to reach an added-line run
    }
    const position = new vscode.Position(target.start, 0);
    ctx.editor.selection = new vscode.Selection(position, position);
    debugLog("nav", `${direction}: select already-visible hunk L${target.start + 1} without recentering`);
    return true;
};

// TextEditor.revealRange is editor-scoped (so it works while Source Control owns focus) but applies a SMOOTH
// renderer scroll asynchronously. Resolve only after the exact editor's visible range has stopped changing for a
// short quiet period. Resolving on the FIRST range event is too early: a rapid queued keypress can then plan from a
// mid-animation viewport and lose distance. A bounded timeout keeps every reveal best-effort if a host stops
// publishing events. Callers avoid invoking this helper for known no-scroll cases, so the timeout is not normal flow.
const revealRangeAndWaitForViewport = async (
    editor: vscode.TextEditor,
    range: vscode.Range,
    revealType: vscode.TextEditorRevealType,
): Promise<void> => {
    const QUIET_MS = 32;
    const MAX_WAIT_MS = 320;
    const NO_EVENT_WAIT_MS = 64;

    const settling = new Promise<void>((resolve) => {
        let finished = false;
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        let maxTimer: ReturnType<typeof setTimeout> | undefined;
        let noEventTimer: ReturnType<typeof setTimeout> | undefined;
        let subscription: vscode.Disposable | undefined;
        let lastViewport = readViewport(editor);

        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            subscription?.dispose();
            if (quietTimer) {
                clearTimeout(quietTimer);
            }
            if (maxTimer) {
                clearTimeout(maxTimer);
            }
            if (noEventTimer) {
                clearTimeout(noEventTimer);
            }
            resolve();
        };
        const scheduleQuietFinish = () => {
            if (quietTimer) {
                clearTimeout(quietTimer);
            }
            quietTimer = setTimeout(finish, QUIET_MS);
        };

        subscription = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor !== editor) {
                return;
            }
            const viewport = readViewport(event.textEditor);
            if (!viewport) {
                return;
            }
            if (
                !lastViewport ||
                viewport.top !== lastViewport.top ||
                viewport.bottom !== lastViewport.bottom
            ) {
                lastViewport = viewport;
                if (noEventTimer) {
                    clearTimeout(noEventTimer);
                    noEventTimer = undefined;
                }
                scheduleQuietFinish();
            }
        });
        // A reveal can truthfully no-op at a physical document edge. Do not hold the navigation queue forever.
        noEventTimer = setTimeout(finish, NO_EVENT_WAIT_MS);
        maxTimer = setTimeout(finish, MAX_WAIT_MS);
    });

    editor.revealRange(range, revealType);
    await settling;
};

// Scroll `editor` so `topLine` is the top visible line, and pin the caret there (kept inside the hunk so
// revert-and-save + the built-in advance both target the right change — see the CURSOR vs SCROLL note).
//
// v1.2.18 ROOT CAUSE — `revealRange(topLine, AtTop)` alone can be ignored by the workbench when `topLine`
// is ALREADY visible. Every downward step deliberately targets `viewport.top + step`, which is normally still
// inside the current viewport. The first press moved the caret from L1 to L6 but left the viewport at L1; every
// later press recomputed the same L6 target and became a permanent no-op. Up appeared healthy because its target
// is ABOVE the viewport and therefore necessarily forces a reveal.
//
// v1.2.22 replaces the attempted workaround (`commands.executeCommand("editorScroll", ...)`) entirely. That
// command scrolls whichever editor widget currently owns keyboard focus; its object argument cannot target the
// TextEditor received here. It therefore silently no-ops when review runs from Source Control, another split, or
// an unfocused/background VS Code window. Its `{to, by, value, revealCursor}` argument is also an untyped internal
// command contract, while TextEditor.revealRange is the public editor-scoped API supported by our VS Code engine.
//
// v1.2.26 removes v1.2.22's visible OFF-SCREEN-ANCHOR ROUND TRIP. That workaround first moved far beyond the
// requested position and then moved back, producing the reported "jumpy jumpy" tall-hunk review. Source inspection
// of VS Code's ViewLines._computeScrollTopToRevealRange explains why the original one-line AtTop reveal could stay
// put: API reveals reserve max(editor.cursorSurroundingLines, editor.stickyScroll.maxLineCount) above the target.
// With the normal sticky maximum of five, asking for oldTop+5 truthfully computes the same scrollTop. It is not a
// dropped reveal and must not be "fixed" with an off-screen detour.
//
// Progress is now caret-owned in BOTH new files and tall hunks, so one direct editor-scoped AtTop reveal is enough:
// even if sticky context keeps the viewport still on this press, the caret advances to the exact logical target and
// the next press advances from that new caret rather than recomputing the same target from a stale viewport. Upward
// callers skip the reveal when their target is already visible, preventing Previous from scrolling DOWN merely to
// reposition an on-screen caret (the L12->L7 reversal observed in v1.2.25). Wrapped rendering can publish a nearby
// logical top, but it no longer changes the ±N progression and there is never a corrective second movement.
interface RevealTopOptions {
    forceWhenVisible?: boolean;
}

const revealTopAndPinCursor = async (
    editor: vscode.TextEditor,
    topLine: number,
    options: RevealTopOptions = {},
): Promise<void> => {
    const last = Math.max(0, editor.document.lineCount - 1);
    const clampedTop = Math.max(0, Math.min(topLine, last));
    const viewportBefore = readViewport(editor);
    if (!viewportBefore || clampedTop === viewportBefore.top) {
        // No layout yet: retain the direct API fallback. Equal-top needs only the caret pin (no scroll wait).
        const pos = new vscode.Position(clampedTop, 0);
        editor.selection = new vscode.Selection(pos, pos);
        if (!viewportBefore) {
            editor.revealRange(new vscode.Range(clampedTop, 0, clampedTop, 0), vscode.TextEditorRevealType.AtTop);
        }
        return;
    }

    const targetIsVisible = editor.visibleRanges.some(
        (range) => clampedTop >= range.start.line && clampedTop <= range.end.line,
    );
    const forceWhenVisible = options.forceWhenVisible ?? true;
    if (targetIsVisible && !forceWhenVisible) {
        const pos = new vscode.Position(clampedTop, 0);
        editor.selection = new vscode.Selection(pos, pos);
        return;
    }

    // Pin first: selection is the logical state consumed by the next queued press and assigning it does not scroll.
    // If this reveal legitimately no-ops because sticky context already presents the line, progress still occurred.
    const pos = new vscode.Position(clampedTop, 0);
    editor.selection = new vscode.Selection(pos, pos);
    await revealRangeAndWaitForViewport(
        editor,
        new vscode.Range(clampedTop, 0, clampedTop, 0),
        vscode.TextEditorRevealType.AtTop,
    );
};

// Scroll `editor` so `bottomLine` is brought into view at the BOTTOM of the viewport, and pin the caret THERE.
//
// WHY this is the key to the v1.2.10 stuck-near-the-bottom fix: `revealRange(..., AtTop)` CANNOT place a line
// near end-of-file at the TOP of the viewport — VS Code clamps the scroll (there aren't a viewport's worth of
// lines below it to fill the screen). So the final down-step of a tall hunk that ENDS near EOF asked to put an
// unreachable line at the top, the viewport silently didn't move, yet `remainingBelow` (computed from the
// caret/geometry) still said "not at the bottom" → the press became a no-op and repeated forever, never
// revealing the last few changed lines and never advancing (the exact Ln-202 stuck report on the 240-line
// hunk). Revealing a line at the BOTTOM (RevealType.Default scrolls DOWN to bring an off-screen-below line
// into view) is NEVER EOF-clamped — the line exists, so it always becomes visible. That guarantees the hunk's
// tail lines are shown. We pin the caret to `bottomLine` (the hunk's last line): on the NEXT press stepTallHunk
// sees caret >= hunk.end and definitively advances — no dependence on exact viewport-bottom render slack.
const revealBottomAndPinCursor = async (editor: vscode.TextEditor, bottomLine: number, check = noNavigationCheckpoint): Promise<void> => {
    const clamped = Math.max(0, Math.min(bottomLine, Math.max(0, editor.document.lineCount - 1)));
    const caretPosition = new vscode.Position(clamped, 0);
    const presentationPosition = bottomPresentationPosition(editor, clamped);
    const alreadyVisible = positionIsVisible(editor, presentationPosition);
    if (!alreadyVisible) {
        // Default reveal brings an off-screen-below line (or the final visual segment of a wrapped line) into view
        // with minimal movement. Wait for the whole smooth movement so a rapid queued rollover cannot replace the
        // file mid-render.
        await revealRangeAndWaitForViewport(
            editor,
            new vscode.Range(presentationPosition, presentationPosition),
            vscode.TextEditorRevealType.Default,
        );
    }
    check();
    editor.selection = new vscode.Selection(caretPosition, caretPosition); // pin only after the tail visibly settles
};

// THE INTERPOSER. Given the per-press context and which key was pressed, decide whether this press should
// be consumed as an IN-HUNK SCROLL STEP (return true) or fall through to plain hunk-to-hunk navigation
// (return false). Fully live: reads the viewport + caret fresh, so reversing direction / moving the caret /
// switching files all "just work" (see the big design note above).
const stepTallHunk = async (ctx: HunkStageContext, direction: "down" | "up"): Promise<boolean> => {
    const vp = readViewport(ctx.editor);
    if (!vp) {
        debugLog("tall-hunk", `${direction}: no viewport (editor not laid out) -> defer to plain nav`);
        return false; // editor not laid out -> let built-in handle it
    }
    const { top, bottom, visLines } = vp;
    const caret = ctx.editor.selection.active.line;
    const hunk = hunkContainingLine(ctx.hunks, caret);
    if (!hunk) {
        debugLog(
            "tall-hunk",
            `${direction}: caret L${caret + 1} not inside any hunk (top=L${top + 1} bottom=L${bottom + 1} vis=${visLines}) -> defer to plain nav (advance)`,
        );
        return false; // caret isn't inside a hunk (between changes / moved away) -> plain navigation
    }
    const { threshold, thresholdOverride, step } = hunkStagingConfig(visLines); // overlap only feeds `step` now (BUG 8 removed TINY_TAIL)
    const span = hunk.end - hunk.start + 1;
    const fullyPresented = hunkIsFullyPresented(ctx.editor, hunk);
    // Shared context line for EVERY decision below — 1-based line numbers so it matches the editor's gutter,
    // which is what Ethan reads off the screenshots. hunk shown as its 1-based start..end.
    const base =
        `${direction}: hunk L${hunk.start + 1}-L${hunk.end + 1} (span=${span}) | ` +
        `viewport top=L${top + 1} bottom=L${bottom + 1} vis=${visLines} | caret=L${caret + 1} | ` +
        `step=${step} threshold=${thresholdOverride ?? "auto-rendered"} fullyPresented=${fullyPresented}`;
    const shouldStage = thresholdOverride === undefined ? !fullyPresented : span > threshold;
    if (!shouldStage) {
        debugLog(
            "tall-hunk",
            `${base} | DECISION: ${thresholdOverride === undefined ? "whole hunk is rendered" : "span<=fixed threshold"} -> defer to plain nav`,
        );
        return false; // hunk fits on one screen (or under the override threshold) -> behave EXACTLY as today
    }

    // v1.2.26 SHARED EDGE CONTRACT. Tall hunks now use the same caret-owned state machine as new files:
    //   1. Each press targets clamp(caret ± step, hunk edge).
    //   2. A partial final step is always consumed at the hunk start/end, even if that edge was already visible.
    //   3. Only a LATER press, with the caret already at the requested edge, advances to another hunk/file.
    //   4. Direction reversal starts from the current caret; no stored direction or viewport-derived reset exists.
    // This removes the split ownership that accumulated the bottom-stuck and up-loop fixes: visibleRanges still
    // decides whether a hunk is tall and how large an automatic page step should be, but it never decides logical
    // completion. Word wrap, sticky context, smooth-scroll intermediates and EOF clamping cannot repeat/skip a step.
    const edge = direction === "down" ? hunk.end : hunk.start;
    const caretAtEdge = direction === "down" ? caret >= edge : caret <= edge;
    if (caretAtEdge) {
        const presentationPosition = direction === "down"
            ? bottomPresentationPosition(ctx.editor, edge)
            : new vscode.Position(edge, 0);
        const edgeIsVisible = positionIsVisible(ctx.editor, presentationPosition);
        if (!edgeIsVisible) {
            // Defensive decoupling guard: never change hunks/files while the authoritative edge caret is hidden.
            if (direction === "down") {
                await revealBottomAndPinCursor(ctx.editor, edge, ctx.check);
            } else {
                await revealTopAndPinCursor(ctx.editor, edge, { forceWhenVisible: false });
            }
            debugLog("tall-hunk", `${base} | DECISION: caret at edge but edge off-screen -> present edge before advance`);
            return true;
        }
        debugLog("tall-hunk", `${base} | DECISION: caret and viewport at hunk edge -> advance to ${direction === "down" ? "next" : "previous"} change/file`);
        return false;
    }

    const target = direction === "down"
        ? Math.min(caret + step, hunk.end)
        : Math.max(caret - step, hunk.start);
    if (direction === "down" && target === hunk.end) {
        // Default reveal presents the final tail at the bottom without AtTop's unavoidable EOF clamp.
        await revealBottomAndPinCursor(ctx.editor, target, ctx.check);
    } else {
        await revealTopAndPinCursor(ctx.editor, target, { forceWhenVisible: direction === "down" });
    }
    debugLog(
        "tall-hunk",
        `${base} | DECISION: step ${direction.toUpperCase()} caret L${caret + 1}->L${target + 1}${target === edge ? " (final partial step at hunk edge; next press advances)" : ""}`,
    );
    return true;
};

// Git's unified diff and VS Code's editor diff do not always expose the same inner stops for a large replacement.
// The broad first..last-added-line range from the surrounding `@@` body prevents either an enormous built-in jump
// (the copied profile-pic fixture moves L53->L149) or a premature cross-file rollover from skipping unread content.
// A very nearby next/previous inner '+' run still belongs to VS Code: if the caret is exactly at an inner-run start
// and the next run begins no more than five lines away (and within this press's configured step), defer once and let
// the built-in land there. Otherwise the
// outer group owns the press and uses the same exact caret-owned step contract. If native navigation misses that
// predicted stop (no-op, wrap or overshoot), use the retained pre-press target instead of skipping unread content.
interface OuterHunkStep {
    readonly hunk: ModifiedHunk;
    readonly caret: number;
    readonly target: number;
    readonly preferNative: boolean;
}

// Refactor of stepOuterHunk's existing geometry checks. Keep the proposed step BEFORE native navigation:
// Ethan's 2026-11-03 report showed a predicted nearby Git stop that Monaco had merged into the current change.
// Native Next wrapped L374 -> L12 despite an unread outer tail. A fallback computed AFTER that wrap uses the
// wrong caret and can loop forever; retain the original caret/target, including the mirrored Previous case.
const planOuterHunkStep = (
    ctx: HunkStageContext,
    direction: "down" | "up",
): OuterHunkStep | undefined => {
    const vp = readViewport(ctx.editor);
    if (!vp) { return undefined; }
    const caret = ctx.editor.selection.active.line;
    const outerHunk = hunkContainingLine(ctx.outerHunks, caret);
    if (!outerHunk) {
        return undefined;
    }
    const innerHunks = ctx.hunks.filter(
        (hunk) => hunk.start >= outerHunk.start && hunk.end <= outerHunk.end,
    );
    const isBroaderThanInnerGeometry =
        innerHunks.length > 1 ||
        (innerHunks.length === 1 &&
            (innerHunks[0].start !== outerHunk.start || innerHunks[0].end !== outerHunk.end));
    if (!isBroaderThanInnerGeometry) {
        return undefined;
    }
    const farEdgePosition = direction === "down"
        ? bottomPresentationPosition(ctx.editor, outerHunk.end)
        : new vscode.Position(outerHunk.start, 0);
    if (positionIsVisible(ctx.editor, farEdgePosition)) {
        return undefined;
    }
    const { threshold, thresholdOverride, step } = hunkStagingConfig(vp.visLines);
    if (thresholdOverride !== undefined && outerHunk.end - outerHunk.start + 1 <= threshold) {
        return undefined;
    }
    let preferNative = false;
    const currentInnerHunk = ctx.hunks.find(hunk => caret >= hunk.start && caret <= hunk.end);
    if (currentInnerHunk && caret === currentInnerHunk.start) {
        const nearbyLimit = Math.min(step, 5);
        const nearbyInnerHunk = direction === "down"
            ? innerHunks.find(hunk => hunk.start > caret && hunk.start - caret <= nearbyLimit)
            : [...innerHunks].reverse().find(hunk => hunk.start < caret && caret - hunk.start <= nearbyLimit);
        if (nearbyInnerHunk) {
            preferNative = true;
            debugLog("tall-hunk", `${direction}: outer @@ group has a nearby inner stop at L${nearbyInnerHunk.start + 1} within nearbyLimit=${nearbyLimit} step=${step} -> try native, retain pre-press step`);
        }
    }
    return { hunk: outerHunk, caret, preferNative, target: direction === "down"
        ? Math.min(caret + step, outerHunk.end) : Math.max(caret - step, outerHunk.start) };
};

// Existing tall-hunk reveal operations, applied to the original planned target even if Monaco has since wrapped.
const applyOuterHunkStep = async (
    ctx: HunkStageContext, direction: "down" | "up", plan: OuterHunkStep,
): Promise<void> => {
    ctx.check();
    if (direction === "down" && plan.target === plan.hunk.end) {
        await revealBottomAndPinCursor(ctx.editor, plan.target, ctx.check);
    } else {
        await revealTopAndPinCursor(ctx.editor, plan.target, { forceWhenVisible: direction === "down" });
    }
    debugLog("tall-hunk", `${direction}: outer @@ group L${plan.hunk.start + 1}-L${plan.hunk.end + 1}, captured caret L${plan.caret + 1}->L${plan.target + 1}`);
};

// After the built-in navigation ADVANCES to a new hunk within the same file, reposition the viewport so a
// tall hunk is presented for stage-stepping: going DOWN we land/pin at its TOP; going UP we land/pin at its
// BOTTOM. The subsequent press then advances from that exact caret edge by one configured page step. Short hunks
// are left exactly where the built-in put them (don't disturb today's
// feel). Best-effort: no context / no matching hunk -> leave the built-in's own reveal untouched.
const revealHunkOnLanding = async (
    ctx: HunkStageContext,
    caretLine: number,
    direction: "down" | "up",
    avoidHunk?: ModifiedHunk, // the hunk we were stepping in BEFORE the built-in advance (loop guard)
): Promise<void> => {
    const vp = readViewport(ctx.editor);
    if (!vp) {
        return;
    }
    const { visLines } = vp;
    const hunk = hunkContainingLine(ctx.hunks, caretLine);
    if (!hunk) {
        return;
    }
    // ANTI-LOOP GUARD (BUG 15, v1.2.12): if the built-in advance re-landed the caret inside the SAME hunk we
    // were just stepping through (can happen when our merged "+ run" hunk spans multiple VS Code change stops),
    // re-revealing it would bounce the viewport back to that hunk's far edge — the exact "loops back to the
    // bottom" symptom, and its downward twin. Leave the viewport where the built-in put it instead of looping.
    // Identity compare is valid: both come from the same once-parsed ctx.hunks array.
    if (avoidHunk && hunk === avoidHunk) {
        debugLog(
            "tall-hunk",
            `landing(${direction}): built-in advance re-landed inside the SAME hunk L${hunk.start + 1}-L${hunk.end + 1} -> loop guard, leaving viewport as-is`,
        );
        return;
    }
    const { threshold, thresholdOverride } = hunkStagingConfig(visLines);
    const span = hunk.end - hunk.start + 1;
    const fullyPresented = hunkIsFullyPresented(ctx.editor, hunk);
    const shouldStage = thresholdOverride === undefined ? !fullyPresented : span > threshold;
    if (!shouldStage) {
        return; // short hunk -> the built-in's reveal is fine, don't reposition
    }
    if (direction === "down") {
        await revealTopAndPinCursor(ctx.editor, hunk.start); // land at the top of the tall hunk
        debugLog("tall-hunk", `landing(down): advanced to new tall hunk L${hunk.start + 1}-L${hunk.end + 1}, landed at its top`);
    } else {
        // Present/pin the exact far edge so caret-owned reverse stepping mirrors forward landing precisely.
        await revealBottomAndPinCursor(ctx.editor, hunk.end, ctx.check);
        debugLog("tall-hunk", `landing(up): advanced to new tall hunk L${hunk.start + 1}-L${hunk.end + 1}, landed at its bottom`);
    }
};

// Backward cross-file entry first lets VS Code select the target diff's last change, then applies the same
// tall-hunk landing rule used for an in-file Previous transition. Without this second phase, VS Code leaves the
// caret at the last hunk's START: the very next Previous press can treat that hunk as already exhausted and skip
// it instead of reviewing it bottom-up.
async function landPreviousDiffAtLastChange(check = noNavigationCheckpoint): Promise<void> {
    check();
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    check();
    let ctx = await getHunkStageContext(check);
    // openChangeEntry normally awaits a fully-created diff editor. Retry only for the narrow renderer race where
    // the active tab is already a diff but its modified TextEditor object is not visible yet. Do not delay plain
    // deleted files or ordinary short/no-added-line diffs, for which an absent staging context is expected.
    if (
        !ctx &&
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
        !visibleEditorForActiveTab()
    ) {
        for (let attempt = 0; attempt < 4 && !ctx; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            check();
            ctx = await getHunkStageContext(check);
        }
    }
    if (!ctx) {
        return;
    }
    await revealHunkOnLanding(ctx, ctx.editor.selection.active.line, "up");
}

// Serialize every change-navigation press across keyboard and smart-mouse entry points. The scroll renderer and
// git.openChange both settle asynchronously; without one shared queue, key-repeat can start a second navigation
// against the first press's old viewport/editor and either lose a step or touch a just-disposed TextEditor.
type NavigationCheckpoint = () => void;
const noNavigationCheckpoint: NavigationCheckpoint = () => undefined;
class NavigationSuperseded extends Error {}
let changeNavigationTail: Promise<void> = Promise.resolve();
let changeNavigationGeneration = 0;
let lastNavigationInvalidation = "none";
let navigationTab: vscode.Tab | undefined;
let navigationGroup: vscode.TabGroup | undefined;
let navigationOwnTabChange = false;
let ownedMouseStagePreview: { request: MouseHoldRequest; uri: string } | undefined;
let queuedNavigationOperations = 0;
const navigatedReviewEditors = new WeakSet<vscode.TextEditor>();
const reviewViewportState = new WeakMap<vscode.TextEditor, {
    top: number;
    bottom: number;
    manuallyScrolled: boolean;
    // Top requested by a remembered-position restore. Its reveal is not awaited (no input latency), so the
    // resulting visible-range event can arrive after the navigation queue has drained.
    restoredTop?: number;
}>();

// Mirrors anchorNavigationAtViewport: a never-navigated editor or an independent scroll resumes from the viewport.
const reviewResumesFromViewport = (editor: vscode.TextEditor): boolean =>
    !navigatedReviewEditors.has(editor) || reviewViewportState.get(editor)?.manuallyScrolled !== false;

const caretLineIsVisible = (editor: vscode.TextEditor): boolean => {
    const line = editor.selection.active.line;
    return editor.visibleRanges.some(range => line >= range.start.line && line <= range.end.line);
};

// Ethan reported (2026-11-02): when Next jumps to a new file, the following Next stays on the same change before
// progress resumes. Under the 2026-10-01 viewport-first rule the landed editor counted as never navigated, so its
// first press re-anchored just above the viewport and native Next re-selected the change already shown (Previous likewise re-selected the landed
// last change, or a reversal moved into a visible neighbour). A Better Git cross-file landing is a review step
// (native first change, last change/tall-hunk bottom, conflict block): the next press continues from that caret
// like any consecutive press, and only a later independent scroll re-anchors to the viewport. Still viewport-first:
// brand-new files (Ethan 2026-07-10: after a backward landing pins a short file's EOF, Next steps from the visible
// top instead of leaving), remembered revisits (they restore their own owner) and a caret VS Code left off-screen.
const adoptLandedReviewPosition = (entry: FileChange, check: NavigationCheckpoint = noNavigationCheckpoint): void => {
    check();
    const editor = visibleEditorForActiveTab();
    if (!editor || hasRestoredReviewPosition(entry) || currentReviewFileUri()?.toString() !== entry.uri.toString()
        || newFileScrollEditor() === editor || !caretLineIsVisible(editor)) { return; }
    const viewport = readViewport(editor);
    if (!viewport) { return; }
    navigatedReviewEditors.add(editor);
    reviewViewportState.set(editor, { top: viewport.top, bottom: viewport.bottom, manuallyScrolled: false });
    debugLog("nav", `landed review continues from caret L${editor.selection.active.line + 1} (viewport L${viewport.top + 1}-L${viewport.bottom + 1})`);
};

const rememberReviewViewport = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || reviewViewportState.has(editor)) { return; }
    const viewport = readViewport(editor);
    if (viewport) {
        reviewViewportState.set(editor, { top: viewport.top, bottom: viewport.bottom, manuallyScrolled: false });
    }
};

// VS Code does not move selection when the user scrolls. Keep only the viewport's two line numbers; Git
// navigation can then re-anchor its next press without polling, reading a diff, or adding input latency.
const observeReviewViewport = (editor: vscode.TextEditor): void => {
    if (editor !== visibleEditorForActiveTab()) { return; }
    const viewport = readViewport(editor);
    if (!viewport) { return; }
    const prior = reviewViewportState.get(editor);
    const changed = !!prior && (prior.top !== viewport.top || prior.bottom !== viewport.bottom);
    // Exempt only the pending restore arrival (±1 for sticky/surrounding context), then consume it.
    // Ethan's later one-line scroll must resume from the viewport, even while the old caret remains visible.
    const restoreArrival = prior?.restoredTop !== undefined && Math.abs(viewport.top - prior.restoredTop) <= 1;
    reviewViewportState.set(editor, {
        top: viewport.top,
        bottom: viewport.bottom,
        manuallyScrolled: !!prior?.manuallyScrolled || (changed && !restoreArrival && queuedNavigationOperations === 0),
        restoredTop: changed || restoreArrival ? undefined : prior?.restoredTop,
    });
};

const anchorNavigationAtViewport = (editor: vscode.TextEditor | undefined, direction: "down" | "up"): void => {
    // Ethan: after manually scrolling, resume from what he can see, not the old off-screen cursor.
    // Subsequent uninterrupted presses still follow ordered hunk navigation; do not re-anchor each time.
    if (!editor) { return; }
    const viewport = readViewport(editor);
    if (!viewport) { return; }
    const prior = reviewViewportState.get(editor);
    // On the first press in an editor Better Git did not land (SCM click, manual open), the already-rendered
    // viewport is the only trustworthy starting point: opening a diff can scroll to its first change while leaving
    // the editor selection at an unrelated old line. Better Git's own cross-file landings and caret-owned revisits
    // are registered as navigated (adoptLandedReviewPosition / applyRememberedReviewPosition). Later presses keep
    // exact caret-owned progression until a separate viewport change resumes review.
    const firstPressInEditor = !navigatedReviewEditors.has(editor);
    navigatedReviewEditors.add(editor);
    if (!firstPressInEditor && !prior?.manuallyScrolled) { return; }
    // Start just outside the visible interval so native next/previous-change includes the first change
    // on screen. For a tall hunk or a new file, this is also the logical line from which to resume steps.
    const last = Math.max(0, editor.document.lineCount - 1);
    const line = direction === "down"
        ? Math.max(0, viewport.top - 1)
        : Math.min(last, viewport.bottom + 1);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    reviewViewportState.set(editor, { top: viewport.top, bottom: viewport.bottom, manuallyScrolled: false });
    debugLog("nav", `${direction}: resume from viewport L${viewport.top + 1}-L${viewport.bottom + 1}, anchor L${line + 1}`);
};

const invalidateChangeNavigation = (preserveHeldSelection = false, reason = "navigation context reset"): void => {
    // Ethan's 2026-09-19 rule: editor/gutter clicks while physically holding may retire stale cursor work,
    // never the pending file set. App switching is a different event with its own captured-minus-preview
    // finish policy in stageHeldSelectionOnFocusLoss; do not make these two cancellation paths equivalent.
    changeNavigationGeneration++;
    lastNavigationInvalidation = reason;
    if (preserveHeldSelection) {
        // Cursor/tab/document changes supersede old navigation work, not a physical hold.
        // Its captured files belong to that gesture until release or explicit cancellation.
        for (const [source, origin] of mouseNavigationOrigins) {
            if (!origin.holdRequest?.active && !origin.holdRequest?.releaseQueued) { mouseNavigationOrigins.delete(source); }
        }
        ownedMouseStagePreview = undefined;
        return;
    }
    mouseNavigationOrigins.clear();
    mouseHoldRequests.forEach(request => { request.active = false; request.releaseQueued = false; });
    mouseHoldRequests.clear();
    latestMouseHoldRequest = undefined;
    ownedMouseStagePreview = undefined;
    clearStageHoldFeedbackRequest();
};

// Observe transitions, not just the final URI: switching away and back also abandons the old burst.
// A move into SCM focus does not change the selected review tab and must not cancel navigation.
const observeNavigationTab = (): void => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    if (tab !== navigationTab || group !== navigationGroup) {
        navigationTab = tab;
        navigationGroup = group;
        const previewOwner = ownedMouseStagePreview;
        const delayedOwnedPreview = previewOwner?.request === latestMouseHoldRequest
            && currentReviewFileUri()?.toString() === previewOwner?.uri;
        if (!navigationOwnTabChange && !delayedOwnedPreview) {
            invalidateChangeNavigation(true, `active tab/group changed: ${tab?.label ?? "no tab"}`);
        }
    }
};

// Only the actual close/open commands own a tab transition. Git reads and subsequent landing/scroll
// waits remain cancellable; otherwise a slow diff could consume a manually chosen file as its target.
const openNavigationTarget = async (entry: FileChange, check: NavigationCheckpoint, closeCurrent = false,
    presentation?: { preserveFocus: boolean; allowStagedReveal: boolean }): Promise<void> => {
    check();
    // Explicit file commands are a new user intention, not part of a queued change burst.
    if (check === noNavigationCheckpoint) {
        invalidateChangeNavigation(true);
    }
    // Looping back into the same file (its only changed file) keeps the native wrap to its first change; the
    // pre-wrap view would otherwise be restored as a "revisit" and pin every later press at the old last change.
    if (departingReviewPosition?.fileUri === entry.uri.toString()) { departingReviewPosition = undefined; }
    const previousTab = closeCurrent ? vscode.window.tabGroups.activeTabGroup.activeTab : undefined;
    navigationOwnTabChange = true;
    try {
        await openChangeEntry(entry, presentation?.preserveFocus, presentation?.allowStagedReveal);
        if (currentReviewFileUri()?.toString() === entry.uri.toString()) {
            confirmOpenedReview(entry.uri, entry.staged);
        }
        // Closing first activates an unrelated background tab. A staged-only file: tab then
        // makes SCM Auto Reveal expand Staged Changes, even after the next review file opens.
        // Open the destination first and close only the captured, now-inactive clean tab.
        // Failed opens and unsaved edits must retain the original editor.
        if (previousTab && !previousTab.isActive && !previousTab.isDirty
            && vscode.window.tabGroups.all.some(group => group.tabs.includes(previousTab))
            && (await currentReviewFileUriAsync())?.toString() === entry.uri.toString()) {
            await vscode.window.tabGroups.close(previousTab, true);
        }
    } finally {
        observeNavigationTab();
        navigationOwnTabChange = false;
    }
    if (currentReviewFileUri()?.toString() !== entry.uri.toString()) {
        // Opaque image tabs need the existing async path resolver.
        const shown = await currentReviewFileUriAsync();
        if (shown?.toString() !== entry.uri.toString()) { invalidateChangeNavigation(); }
        else { confirmOpenedReview(entry.uri, entry.staged); }
    }
    check();
};

// The native change command has already wrapped (and recentered) the departing diff when Better Git learns that a
// press is a file boundary. Hold the pre-press view (captured before viewport anchoring) only while that boundary
// runs, so the revisit memory written by openChangeEntry (and any late wrap events) records where Ethan left the
// file and who owned its next press: e.g. its last change after Next. Without this, returning with Previous to a
// file left by Next restored its FIRST change, which also suppressed the last-change landing.
const captureDepartingReviewPosition = (editor: vscode.TextEditor | undefined): ReviewFilePosition | undefined =>
    editor && editor === trackedPositionEditor && trackedPositionUri ? capturedReviewPosition(editor) : undefined;

const leaveReviewFile = async (
    departing: ReviewFilePosition | undefined,
    check: NavigationCheckpoint,
    onFileBoundary: (check: NavigationCheckpoint) => Promise<void>,
): Promise<void> => {
    departingReviewPosition = departing?.fileUri === trackedPositionUri ? departing : undefined;
    try {
        await onFileBoundary(check);
    } finally {
        departingReviewPosition = undefined;
    }
};

const serializeChangeNavigation = (
    operation: (check: NavigationCheckpoint) => Promise<void>,
    commitCapturedStage = false,
    traceLabel?: string
): Promise<void> => {
    const label = traceLabel ?? (commitCapturedStage ? "captured-stage" : undefined);
    const queuedAt = label ? performance.now() : 0;
    pendingWorktreePresentation?.dispose("review-navigation");
    worktreeUsage?.reviewInput("review-navigation", currentReviewFileUri()?.fsPath);
    observeNavigationTab();
    queuedNavigationOperations++;
    const generation = changeNavigationGeneration;
    const check = () => {
        observeNavigationTab();
        if (generation !== changeNavigationGeneration) {
            throw new NavigationSuperseded(`generation ${generation}->${changeNavigationGeneration}: ${lastNavigationInvalidation}`);
        }
    };
    const execute = async () => {
        if (label) { debugLog("stage-flow", `${label} dequeued; wait=${Math.round(performance.now() - queuedAt)}ms, focused=${vscode.window.state.focused}`); }
        try {
            // An already-released, captured stage is a Git transaction. UI movement may
            // cancel its later navigation, but must not silently discard the transaction.
            if (!commitCapturedStage) { check(); }
            await operation(check);
            requestNavigationScmLookahead();
        } catch (error) {
            if (!(error instanceof NavigationSuperseded)) { throw error; }
            debugLog("stage-flow", `${label ?? "navigation"} cancelled: ${error.message}`);
        } finally {
            if (label) { debugLog("stage-flow", `${label} settled; elapsed=${Math.round(performance.now() - queuedAt)}ms`); }
            queuedNavigationOperations--;
        }
    };
    const run = changeNavigationTail.then(execute, execute);
    // Keep the tail fulfilled even if one best-effort navigation call fails, so later keypresses are never
    // permanently blocked behind a rejected promise. The caller still receives `run` and can observe its error.
    changeNavigationTail = run.catch(() => undefined);
    return run;
};

// Keep view restoration tied to the captured editor, never an opposite navigation guess.
const captureMouseReviewView = (): MouseReviewView | undefined => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    if (!tab) { return undefined; }
    const input = tab.input;
    const uris = input instanceof vscode.TabInputTextDiff ? [input.original.toString(), input.modified.toString()]
        : input instanceof vscode.TabInputText ? [input.uri.toString()] : [];
    return { input, preview: tab.isPreview, column: group.viewColumn,
        editors: vscode.window.visibleTextEditors.filter(editor =>
            (editor.viewColumn === undefined || editor.viewColumn === group.viewColumn) && uris.includes(editor.document.uri.toString())
        ).map(editor => ({ uri: editor.document.uri.toString(), selections: [...editor.selections], top: editor.visibleRanges[0]?.start })) };
};

const restoreMouseReviewView = async (origin: NonNullable<ReturnType<typeof mouseNavigationOrigins.get>>, check: NavigationCheckpoint): Promise<boolean> => {
    const view = origin.view;
    if (!view) { return false; }
    check();
    const sameInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input === view.input;
    if (!sameInput) {
        navigationOwnTabChange = true;
        try {
            const options = { viewColumn: view.column, preview: view.preview };
            if (view.input instanceof vscode.TabInputTextDiff) {
                await vscode.commands.executeCommand("vscode.diff", view.input.original, view.input.modified, undefined, options);
            } else if (view.input instanceof vscode.TabInputText) {
                await vscode.window.showTextDocument(view.input.uri, options);
            } else {
                await openChangeEntry(origin.change);
            }
        } finally { observeNavigationTab(); navigationOwnTabChange = false; }
    }
    check();
    const shown = await currentReviewFileUriAsync();
    check();
    if (shown?.toString() !== origin.change.uri.toString()) { invalidateChangeNavigation(); return false; }
    pendingReviewPosition = undefined; // Explicit gesture cancellation restores its captured origin, not a later cached visit.
    for (const saved of view.editors) {
        const editor = vscode.window.visibleTextEditors.find(candidate =>
            (candidate.viewColumn === undefined || candidate.viewColumn === view.column) && candidate.document.uri.toString() === saved.uri);
        if (!editor) { continue; }
        editor.selections = saved.selections.map(selection => new vscode.Selection(
            editor.document.validatePosition(selection.anchor), editor.document.validatePosition(selection.active)));
        if (saved.top) {
            // AtTop reserves surrounding/sticky lines above its target. Offset that context so
            // restoring a saved viewport does not drift upward by five lines on every hold.
            const config = vscode.workspace.getConfiguration("editor", editor.document);
            const padding = Math.max(config.get<number>("cursorSurroundingLines", 0),
                config.get<boolean>("stickyScroll.enabled", true) ? config.get<number>("stickyScroll.maxLineCount", 5) : 0);
            const top = editor.document.validatePosition(new vscode.Position(saved.top.line + padding, saved.top.character));
            await revealRangeAndWaitForViewport(editor, new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
            check();
        }
    }
    return true;
};

// Agentic Mouse sends the existing exact-Undo action when the adjacent cancel cell is pressed during a hold.
// While a hold is active, consume that action as a gesture cancel: restore the captured view, retain the Git
// index and delete the release receipt. The caller decides separately (from input order) whether the exact
// staging Undo follows; with no active hold, the same command keeps its normal exact Undo role.
const cancelMouseNavigationHold = (source?: MouseReviewSource): Promise<void> | undefined => {
    const request = source ? mouseHoldRequests.get(source) : latestMouseHoldRequest;
    if (!request?.active) { return undefined; }
    const owner = source
        ? ([source, request] as const)
        : [...mouseHoldRequests.entries()].find(([, candidate]) => candidate === request);
    if (!owner) { return undefined; }
    const [ownerSource] = owner;
    request.active = false; // Readiness arriving behind this input must not relight or stage the hold.
    clearStageHoldFeedbackRequest(ownerSource);
    return serializeChangeNavigation(async check => {
        const origin = mouseNavigationOrigins.get(ownerSource);
        let restored = false;
        let stayedStill = false;
        if (origin?.holdRequest === request) {
            if (origin.view) {
                restored = await restoreMouseReviewView(origin, check);
            } else {
                stayedStill = true;
            }
            requestCurrentHunkOverviewMarkerRefresh();
        }
        if (mouseNavigationOrigins.get(ownerSource)?.holdRequest === request) { mouseNavigationOrigins.delete(ownerSource); }
        if (mouseHoldRequests.get(ownerSource) === request) { mouseHoldRequests.delete(ownerSource); }
        if (latestMouseHoldRequest === request) { latestMouseHoldRequest = undefined; }
        // A newer hold of this source (for example a keyboard review begun right after this cancel) owns its feedback.
        if (!mouseHoldRequests.has(ownerSource)) { clearStageHoldFeedbackRequest(ownerSource); }
        const direction = origin?.direction;
        mouseDebug(direction && restored
            ? `${mouseSourceLabel(ownerSource)} ${mouseDirectionLabel(direction)} cancel chord received; pre-press view restored. Release will do nothing.`
            : direction && stayedStill
                ? `${mouseSourceLabel(ownerSource)} ${mouseDirectionLabel(direction)} cancel chord received; review view stayed still. Release will do nothing.`
                : `${mouseSourceLabel(ownerSource)} cancel chord received; no review view was restored. Release will do nothing.`);
    });
};

// Capture inside the existing navigation queue. A physical hold can either move now (the preserved experimental
// path) or remain still until release; its deadline always uses input arrival, not renderer/Git latency.
const navigateWithMouseOrigin = (
    direction: typeof lastNavDirection,
    source: unknown,
    held = false,
    navigateOnButtonDown = true,
): Promise<void> => {
    const requestedAt = performance.now();
    observeNavigationTab();
    // Mouse/wand navigation or a newer gesture ends an unreleased keyboard review unstaged (callers outside
    // keyboard review only ever pass mouse sources or undefined here).
    if (source !== "keyboard" && retireKeyboardReviewRequest("other navigation began")) { clearStageHoldFeedbackRequest("keyboard"); }
    const holdRequest: MouseHoldRequest | undefined = held && isReviewHoldSource(source)
        ? { active: true, navigateOnButtonDown }
        : undefined;
    latestMouseHoldRequest = holdRequest;
    if (isReviewHoldSource(source)) {
        const previous = mouseHoldRequests.get(source);
        if (previous) { previous.active = false; }
        if (holdRequest) { mouseHoldRequests.set(source, holdRequest); } else { mouseHoldRequests.delete(source); }
    }
    syncKeyboardReviewContext();
    return serializeChangeNavigation(async (check) => {
        if (isReviewHoldSource(source)) {
            mouseNavigationOrigins.delete(source);
            let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            // Holds need this for cancellation; the separate tagged Next/Stage
            // route also needs it when navigation crosses files before Stage.
            let view = captureMouseReviewView();
            let active = await getActiveChange();
            const uri = await getActiveFileUri();
            check();
            if (uri && active && active.staged !== true) {
                const matches = (await getFileChanges(uri)).filter(change => change.uri.toString() === uri.toString());
                check();
                const change = matches.find(candidate => !candidate.staged);
                if (held && change?.status === GitStatus.DELETED && active.staged === null
                    && matches.length > 1 && tab === vscode.window.tabGroups.activeTabGroup.activeTab) {
                    // Ethan: Option+Shift eyes, mouse and wand entry must work on deleted images too.
                    // VS Code can hide BOTH resources of a valid image comparison (input === undefined).
                    // With another staged version at the same path, never guess which side was shown.
                    // The explicit held-review intent opens the canonical UNSTAGED index (~) preview
                    // of that exact deletion before arming it. Known staged/history inputs are excluded;
                    // this only changes the preview, never the index or another file. Capture cancellation
                    // from the now-unambiguous preview so every review input shares the same safety rule.
                    navigationOwnTabChange = true;
                    try { await openChangeEntry(change, true); }
                    finally { observeNavigationTab(); navigationOwnTabChange = false; }
                    check();
                    tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                    active = await getActiveChange();
                    check();
                    if (active?.path !== uri.path) { return; }
                    if (tab && tab === vscode.window.tabGroups.activeTabGroup.activeTab
                        && tab.input === undefined && active.staged === null) {
                        // Current VS Code can hide the input even for the single ~ image preview we just
                        // explicitly opened. Its unstaged side comes from OUR canonical open, not a guess
                        // about the previous opaque comparison. Keep this proof local to this hold capture;
                        // ordinary/staged/history views still require their normal side checks.
                        active = { path: active.path, staged: false };
                    }
                    view = captureMouseReviewView();
                }
                if (change && active && (active.staged === false || matches.length === 1) && tab === vscode.window.tabGroups.activeTabGroup.activeTab) {
                    mouseNavigationOrigins.set(source, {
                        change, direction, requestedAt, held, holdRequest, view, navigateOnButtonDown,
                    });
                }
            }
        } else {
            mouseNavigationOrigins.clear();
        }
        if (!held || navigateOnButtonDown) {
            await (direction === "next" ? goToNextDiffOnce(check) : goToPreviousDiffOnce(check));
            requestCurrentHunkOverviewMarkerRefresh();
        }
    });
};

// Do not navigate back to discover the old file: that changes review state and stages the wrong file when
// navigation settles before a slow press. Consume the exact source receipt once, or do nothing. (Codex task: 01a039f7-873c-7c30-b3dc-af8a6724ace5)
const stageMouseNavigationOrigin = (args: unknown, held = false): Promise<void> => {
    const requestedAt = performance.now();
    if (!args || typeof args !== "object" || !("source" in args) || !("direction" in args)) {
        mouseDebug("Release ignored, invalid hold arguments.");
        return Promise.resolve();
    }
    const { source, direction } = args;
    if (!isMouseReviewSource(source) || (direction !== "next" && direction !== "previous")) {
        mouseDebug("Release ignored, unknown mouse or direction.");
        return Promise.resolve();
    }
    return stageReviewHoldOrigin(source, direction, held, requestedAt);
};

// Extraction of stageMouseNavigationOrigin's existing release transaction. Keyboard review now also finishes
// through this exact batch staging/Eyes exclusion/Undo path, and never uses the immediate-origin fallback.
const stageReviewHoldOrigin = (
    source: MouseReviewSource, direction: "next" | "previous", held: boolean, requestedAt = performance.now()
): Promise<void> => {
    mouseDebug(`${mouseSourceLabel(source)} ${mouseDirectionLabel(direction)} release received.`);
    const request = held ? mouseHoldRequests.get(source) : undefined;
    const releasedOrigin = request?.active ? mouseNavigationOrigins.get(source) : undefined;
    if (request?.active) {
        request.releaseQueued = true;
        request.active = false;
        prepareStageHoldReleaseRequest(source, request);
    }
    return serializeChangeNavigation(check => runStageCommand(async () => {
        const heldSelection = request ? takeStageHoldSelectionRequest(source, request) : undefined;
        const origin = releasedOrigin ?? mouseNavigationOrigins.get(source);
        if (mouseNavigationOrigins.get(source)?.holdRequest === request) { mouseNavigationOrigins.delete(source); }
        if (held && mouseHoldRequests.get(source) === request) { mouseHoldRequests.delete(source); }
        if (latestMouseHoldRequest === request) { latestMouseHoldRequest = undefined; }
        const label = `${mouseSourceLabel(source)} ${mouseDirectionLabel(direction)}`;
        if (!origin) { mouseDebug(`${label} release ignored, no press in progress.`); return; }
        if (origin.direction !== direction) { mouseDebug(`${label} release ignored, direction changed.`); return; }
        if (requestedAt < origin.requestedAt) { mouseDebug(`${label} release ignored, event order was invalid.`); return; }
        if (origin.held !== held || origin.holdRequest !== request) { mouseDebug(`${label} release ignored, hold ownership changed.`); return; }
        if (!held && requestedAt - origin.requestedAt >= 1000) { mouseDebug(`${label} release ignored, hold receipt expired.`); return; }
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(origin.change.uri);
        if (!repo) { mouseDebug(`${label} release ignored, repository is no longer open.`); return; } // A closed repository must not redirect the captured file to the first workspace repo.
        if (heldSelection !== undefined) {
            mouseDebug(`${label} release committing ${heldSelection.changes.length} marked files.`);
            if (heldSelection.changes.length) {
                await stageSelectedFilesAndAdvance(direction, heldSelection.changes, check, origin.view,
                    !request?.excludePreviewOnRelease, heldSelection.lastStaged);
            }
            return; // An eyes-only selection is an empty batch, never a fallback stage of the origin.
        }
        if (source === "keyboard") {
            // Keyboard review has no immediate whole-file meaning. Without its pending selection it stages nothing.
            mouseDebug(`${label} release ignored, the keyboard review selection was not available.`);
            return;
        }
        const selected = [origin.change];
        const liveUnstaged = new Set(distinctUnstagedChanges(await getFileChanges(origin.change.uri))
            .map(change => change.uri.toString()));
        if (selected.some(change => !liveUnstaged.has(change.uri.toString()))) {
            mouseDebug(`${label} release ignored, selected items are no longer unstaged.`);
            return;
        }
        const shown = await getActiveFileUri();
        check();
        if (selected.length > 1) {
            await stageSelectedFilesAndAdvance(direction, selected, check);
        } else if (shown?.toString() === origin.change.uri.toString()) {
            await stageCurrentFileAndAdvance(direction, origin.change, check, origin.view);
        } else {
            await stageThroughExtension(repo, origin.change.uri,
                stageUndoViewFromMouseReview(origin.change.uri, origin.view)); // Stage the saved origin without a second jump.
        }
        mouseDebug(selected.length > 1
            ? `${label} release staged ${selected.length} files.`
            : `${label} release staged ${path.basename(origin.change.uri.fsPath)}.`);
    }), held && !!request);
};

const goToNextDiffOnce = async (
    check: NavigationCheckpoint,
    onFileBoundary: (check: NavigationCheckpoint) => Promise<void> = check => openNextFile(check, true)
) => {
    var activeEditor = vscode.window.activeTextEditor;
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath — avoids the clipboard
    // save/blank/restore hack in the hot path when focus is in the SCM panel. activeEditor is still kept for
    // the navEditor fallback below.
    const activePath = await activeNavFilePath();
    check();
    if (!activePath) {
        await openFirstFile(check);
        return;
    }

    // Captured before anchoring: if this press leaves a diff, revisit memory keeps Ethan's real view and owner.
    const departing = captureDepartingReviewPosition(visibleEditorForActiveTab());
    anchorNavigationAtViewport(visibleEditorForActiveTab() ?? activeEditor, "down");

    // PLAIN MERGE-CONFLICT MODE: the ordinary Source Control view is a single working-file editor, not a
    // compare editor. Step complete marker blocks directly; after the final block, continue to the next file.
    const mergeConflictEditor = plainMergeConflictEditor();
    if (mergeConflictEditor) {
        if (stepPlainMergeConflict(mergeConflictEditor, "down")) {
            return;
        }
        await onFileBoundary(check);
        return;
    }

    // NEW-FILE SCROLL MODE: for a brand-new file shown as a PLAIN editor (whole file is one new-diff with
    // no original side), step DOWN newFileNavLineJump lines to page through it; at the bottom fall through
    // to the next changed file. newFileScrollEditor() is the strict v1.2.1 gate — it both DECIDES (plain
    // tab + file: scheme + genuinely-new git status) and RESOLVES the editor to act on (the tab's own
    // visible editor, never a possibly-stale vscode.window.activeTextEditor). The v1.2.0 code split those
    // two concerns across different editors, which is what made modified files 5-line-step and new files
    // silently no-op — see the comments on isFullyAddedFile / newFileScrollEditor for the full post-mortem.
    const newFileEditor = newFileScrollEditor();
    if (newFileEditor) {
        if (await stepThroughNewFile(newFileEditor, "down", check)) {
            return;
        }
        await onFileBoundary(check);
        return;
    }

    // TALL-HUNK STAGING (v1.2.6): if the caret is inside a hunk taller than the viewport and has not consumed
    // its exact BOTTOM edge yet, use this press as a downward step (read the next screenful of the same hunk)
    // instead of jumping to the next hunk. When it returns false (short hunk, caret already at the presented
    // bottom, caret not in a hunk, or feature off) we fall through to the unchanged navigation below, so
    // nothing else is disturbed. See the big design note above getModifiedSideHunkGeometry.
    const stageCtx = await getHunkStageContext(check);
    check();
    if (stageCtx && (await stepTallHunk(stageCtx, "down"))) {
        return; // press was a within-hunk scroll step
    }
    const outerStep = stageCtx ? planOuterHunkStep(stageCtx, "down") : undefined;
    if (stageCtx && outerStep && !outerStep.preferNative) {
        await applyOuterHunkStep(stageCtx, "down", outerStep);
        return; // press was a broader within-@@ step; avoid an oversized built-in jump
    }
    if (stageCtx && selectVisibleHunkWithoutScrolling(stageCtx, "down")) {
        return;
    }

    // Hunk navigation. Read the cursor from the TAB's own editor (falling back to the focused editor) so
    // the moved/didn't-move detection below works even when keyboard focus is in the SCM panel —
    // activeTextEditor alone could be a stale different-file editor there, which made the before/after
    // compare meaningless (always "didn't move" -> premature file jumps, or missed jumps).
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    // Loop guard input: which hunk (if any) the caret sat in BEFORE the advance, so revealHunkOnLanding can
    // detect a built-in advance that re-landed inside the same hunk and refuse to re-reveal it (see BUG 15).
    const hunkBefore =
        stageCtx && lineBefore !== undefined ? hunkContainingLine(stageCtx.hunks, lineBefore) : undefined;
    await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
    check();
    const lineAfter = navEditor?.selection.active.line; // TextEditor.selection is live — same object, post-command state

    // A nearby Git '+' run is only a prediction of Monaco's next stop. Rescue a no-op, wrap OR oversized
    // jump while the pre-press outer tail was unread. A genuinely completed edge has no plan and still exits.
    if (stageCtx && outerStep && lineAfter !== undefined &&
        (lineAfter <= outerStep.caret || lineAfter > outerStep.target)) {
        debugLog("tall-hunk", `down: native L${outerStep.caret + 1}->L${lineAfter + 1} missed the pending outer step; retain this file`);
        await applyOuterHunkStep(stageCtx, "down", outerStep);
        return;
    }
    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter > lineBefore)) {
        // We've run out of changes in the current file. Jump straight to the next changed file —
        // NO confirmation prompt, ever. The whole point of this tool is keyboard-fast review; a
        // "Jump to next file: ...?" modal would defeat that. (The old promptBeforeNextFile setting +
        // its modal confirmation path were removed entirely — see CHANGELOG v1.0.2.)
        debugLog("nav", `next: no forward change in file (before=L${(lineBefore ?? -1) + 1} after=L${(lineAfter ?? -1) + 1}) -> openNextFile()`);
        await leaveReviewFile(departing, check, onFileBoundary);
        return;
    }

    // We advanced to a new hunk WITHIN this file. If it's a tall hunk, land at its TOP so the first
    // screenful shows it from the start and the next press steps down through it (staging). Short hunks are
    // left exactly where the built-in reveal put them. stageCtx.hunks is still valid (same file).
    if (stageCtx && lineAfter !== undefined) {
        await revealHunkOnLanding(stageCtx, lineAfter, "down", hunkBefore);
    }
};

const goToPreviousDiffOnce = async (
    check: NavigationCheckpoint,
    onFileBoundary: (check: NavigationCheckpoint) => Promise<void> = openPreviousFile
) => {
    var activeEditor = vscode.window.activeTextEditor;
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    const activePath = await activeNavFilePath();
    check();
    if (!activePath) {
        await openLastFile(check);
        return;
    }

    const departing = captureDepartingReviewPosition(visibleEditorForActiveTab()); // See goToNextDiffOnce.
    anchorNavigationAtViewport(visibleEditorForActiveTab() ?? activeEditor, "up");

    // PLAIN MERGE-CONFLICT MODE, mirrored for upward review. A block is one change; exhausting the first block
    // enters the previous file at its final reviewable position.
    const mergeConflictEditor = plainMergeConflictEditor();
    if (mergeConflictEditor) {
        if (stepPlainMergeConflict(mergeConflictEditor, "up")) {
            return;
        }
        await onFileBoundary(check);
        return;
    }

    // NEW-FILE SCROLL MODE (mirror of goToNextDiff — same strict v1.2.1 gate, see comments there): step UP
    // newFileNavLineJump lines through a brand-new plain-editor file; at the top, fall through to the
    // previous changed file.
    const newFileEditor = newFileScrollEditor();
    if (newFileEditor) {
        if (await stepThroughNewFile(newFileEditor, "up", check)) {
            return;
        }
        await onFileBoundary(check);
        return;
    }

    // TALL-HUNK STAGING (v1.2.6), mirror of goToNextDiff: if the caret is inside a hunk taller than the
    // viewport and has not consumed its exact TOP edge yet, use this press as an UPWARD step (read the
    // previous screenful of the same hunk) instead of jumping to the previous hunk. Returns false -> fall
    // through to the unchanged navigation below.
    const stageCtx = await getHunkStageContext(check);
    check();
    if (stageCtx && (await stepTallHunk(stageCtx, "up"))) {
        return; // press was a within-hunk upward scroll step
    }
    const outerStep = stageCtx ? planOuterHunkStep(stageCtx, "up") : undefined;
    if (stageCtx && outerStep && !outerStep.preferNative) {
        await applyOuterHunkStep(stageCtx, "up", outerStep);
        return; // press was a broader within-@@ upward step
    }
    if (stageCtx && selectVisibleHunkWithoutScrolling(stageCtx, "up")) {
        return;
    }

    // Hunk navigation — tab-derived editor for the before/after compare, same rationale as goToNextDiff.
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    // Loop guard input (mirror of goToNextDiff): the hunk the caret sat in before the built-in advance, so we
    // never re-reveal the same hunk's bottom after advancing up — the exact BUG 15 "loops back to bottom" fix.
    const hunkBefore =
        stageCtx && lineBefore !== undefined ? hunkContainingLine(stageCtx.hunks, lineBefore) : undefined;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    check();
    const lineAfter = navEditor?.selection.active.line; // live selection — post-command state

    if (stageCtx && outerStep && lineAfter !== undefined &&
        (lineAfter >= outerStep.caret || lineAfter < outerStep.target)) {
        debugLog("tall-hunk", `up: native L${outerStep.caret + 1}->L${lineAfter + 1} missed the pending outer step; retain this file`);
        await applyOuterHunkStep(stageCtx, "up", outerStep);
        return;
    }
    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter < lineBefore)) {
        // Out of changes in the current file -> jump straight to the previous changed file, NO prompt.
        // Same rationale as goToNextDiff: the confirmation modal was removed entirely (see CHANGELOG v1.0.2).
        await leaveReviewFile(departing, check, onFileBoundary);
        return;
    }

    // Advanced to a previous hunk within this file. If it's tall, land showing its BOTTOM portion so
    // subsequent 'previous' presses step UP through it toward the top (the mirror of the next-change flow).
    if (stageCtx && lineAfter !== undefined) {
        await revealHunkOnLanding(stageCtx, lineAfter, "up", hunkBefore);
    }
};

// Thin queued wrappers are the single public/shared path used by direct keyboard commands and smart mouse
// navigation alike. Keeping the queue here (rather than in keybindings) covers every entry point identically.
const ordinaryChangeNavigation = (step: typeof goToNextDiffOnce): Promise<void> => {
    mouseHoldRequests.forEach(request => { request.active = false; request.releaseQueued = false; });
    latestMouseHoldRequest = undefined;
    mouseHoldRequests.clear();
    clearStageHoldFeedbackRequest();
    return serializeChangeNavigation(async check => {
        mouseNavigationOrigins.clear();
        await step(check);
        // Paint after the navigation promise settles, but do not make the next keypress wait for Git geometry.
        requestCurrentHunkOverviewMarkerRefresh();
    });
};
const goToNextDiff = (): Promise<void> => ordinaryChangeNavigation(goToNextDiffOnce);
const goToPreviousDiff = (): Promise<void> => ordinaryChangeNavigation(goToPreviousDiffOnce);

const goToFirstOrNextFile = async () => {
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    if (!(await activeNavFilePath())) {
        await openFirstFile();
        return;
    }

    await openNextFile();
};

const goToLastOrPreviousFile = async () => {
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    if (!(await activeNavFilePath())) {
        await openLastFile();
        return;
    }

    await openPreviousFile();
};

// FEATURE (stage-and-next-changed-file — shift+alt+. QWERTY / shift+alt+v Dvorak): stage the whole current file, then jump straight to the next UNSTAGED file so
// you can review-and-stage without reaching for the mouse to click the + each time.
// Stages the current file and stays put (no navigation) — backs the editor-title "Stage current file" button.
// Reuses getActiveFileUri (tab-aware, so it works from a diff or a plain editor) and isChangeFileUri as the
// safety guard, so it only ever runs `git add` on an actual change — never on a clean/unrelated file.
const stageCurrentFile = async () => {
    const currentUri = await getActiveFileUri();
    if (!currentUri || !isChangeFileUri(currentUri)) {
        return; // no active file, or it's not a change -> nothing to stage
    }
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const activeRepo = git.getRepository(currentUri) || git.repositories[0];
    if (activeRepo) {
        const stagedFromTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        // Route through the single stage chokepoint: stages (same as clicking the + in Source Control) AND
        // records it in the last-staged status bar. No advance here — this command stays on the file.
        await stageThroughExtension(activeRepo, currentUri);
        await presentStagedOnlyReview([currentUri], noNavigationCheckpoint, stagedFromTab);
    }
};

const distinctUnstagedChanges = (changes: readonly FileChange[]): FileChange[] => {
    const seen = new Set<string>();
    return changes.filter(change => {
        const key = change.uri.toString();
        if (change.staged || seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
};

// Ethan (2026-11-05): Staged Changes must never open unless he opens it. Native SCM Auto Reveal
// (`scm.autoReveal`) calls expandTo on the group holding the active editor's file: URI. It reruns on
// later editor changes, when Source Control becomes visible and when any repository opens or closes.
// After Better Git stages a worktree's final unstaged file, its retained working view is staged-only,
// so an unrelated later event (for example a new Codex worktree) expanded Staged Changes and selected
// that row. Present the same file's staged (Index) review instead: its git: side never matches an SCM
// row, the review stays in this worktree, and the staged badge shows nothing unstaged remains.
// Only a clean, still-active view of a file this command staged changes; a partially staged file keeps
// its view because Auto Reveal already prefers its Changes row. The stage and Undo receipt are already
// complete: presentation failure or newer input must not alter that transaction's result.
const presentStagedOnlyReview = async (stagedUris: readonly vscode.Uri[], check: NavigationCheckpoint,
    expectedTab?: vscode.Tab): Promise<void> => {
    try {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input = tab?.input;
        const primary = input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff
            ? input.modified
            : input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
                || input instanceof vscode.TabInputNotebook ? input.uri : undefined;
        if (!tab || (expectedTab && tab !== expectedTab) || tab.isDirty || primary?.scheme !== "file") { return; }
        const samePath = (candidate: vscode.Uri) => candidate.path.toLowerCase() === primary.path.toLowerCase();
        if (!stagedUris.some(samePath)) { return; } // Never replace an unrelated manually chosen editor.
        const rows = (await getFileChanges(primary)).filter(change => samePath(change.uri));
        check();
        const staged = rows.length === 1 && rows[0].staged ? rows[0] : undefined;
        if (!staged || vscode.window.tabGroups.activeTabGroup.activeTab !== tab || tab.isDirty) { return; }
        const view = captureActiveStageUndoView();
        // This automatic side conversion is not a request to reveal Staged, even when a user opted
        // into row reveal for deliberate staged navigation. Keep SCM/editor focus where it was.
        await openNavigationTarget(staged, check, !tab.isPreview, { preserveFocus: true, allowStagedReveal: false });
        const editor = visibleEditorForActiveTab();
        if (view && editor && currentReviewFileUri()?.toString() === staged.uri.toString()) {
            check();
            // Staging the full file keeps these bytes identical; carry its cursor and viewport onto
            // the Index side instead of jumping to the first hunk merely to prevent Auto Reveal.
            await restoreStageUndoView({ ...view, documentUri: editor.document.uri.toString() });
        }
        // Staging completed this file's unstaged review; do not let the replaced working view become memory.
        reviewFilePositions.forget(staged.uri.toString());
    } catch (error) {
        debugLog("stage-flow", `staged-only final review kept its working view: ${String(error)}`);
    }
};

const stageSelectedFilesAndAdvance = async (
    direction: "next" | "previous",
    selected: readonly FileChange[],
    check: NavigationCheckpoint = noNavigationCheckpoint,
    priorView?: MouseReviewView,
    advance = true,
    lastStaged?: vscode.Uri
): Promise<boolean> => {
    if (selected.length === 0) { return false; }
    const selectedKeys = selected.map(change => change.uri.toString());
    const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    const repo = git?.getRepository(selected[0].uri);
    const repoRoot = String(repo?.rootUri?.fsPath ?? "");
    if (!repoRoot || selected.some(change => {
        const relative = path.relative(repoRoot, change.uri.fsPath);
        return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    })) { return false; }

    const current = advance ? distinctUnstagedChanges(await getFileChanges(selected[0].uri)) : [];
    const indexByUri = new Map(current.map((change, index) => [change.uri.toString(), index]));
    // The marked URI snapshot owns the transaction. Background edits, new files,
    // sorting changes or staging elsewhere must not redefine or veto that group.
    // Use the current list only to choose where review continues after staging.
    const indices = selectedKeys.map(key => indexByUri.get(key))
        .filter((index): index is number => index !== undefined);
    const first = indices.length ? Math.min(...indices) : 0;
    const last = indices.length ? Math.max(...indices) : current.length - 1;
    const selectedSet = new Set(selectedKeys);
    const before = current.slice(0, first).reverse().find(change => !selectedSet.has(change.uri.toString()));
    const after = current.slice(last + 1).find(change => !selectedSet.has(change.uri.toString()));
    const remaining = current.filter(change => !selectedSet.has(change.uri.toString()));
    const target = direction === "next"
        ? after ?? before ?? remaining[0]
        : before ?? after ?? remaining[remaining.length - 1];
    const activeWasSelected = advance && selectedKeys.includes((await getActiveFileUri())?.toString() ?? "");
    await stageBatchThroughExtension(repo, selected.map(change => change.uri),
        selected.map(change => stageUndoViewFromMouseReview(change.uri, priorView)).find(view => view), false,
        // Selection membership is stored in SCM order for exact staging/Undo. Display its END in
        // the review direction, without reordering the transaction or using the excluded eyes preview.
        lastStaged ?? (direction === "previous" ? selected[0].uri : selected[selected.length - 1].uri));
    check();
    if (!advance) { return true; } // Leave the excluded eyes editor/cursor/viewport untouched.

    if (!target) {
        // Keep reviewing this file when this worktree is exhausted. Closing it would
        // activate an arbitrary background tab, potentially in another worktree.
        // A staged-only working view switches to its Index side in place (above).
        // Invalidate already-queued navigation without touching the staged receipt.
        await presentStagedOnlyReview(selected.map(change => change.uri), check);
        invalidateChangeNavigation();
        return true;
    }
    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (direction === "previous") {
        await openNavigationTarget(target, check, activeWasSelected && !isPreview);
        await landChangeForBackwardReview(target, check);
    } else { await openForwardNavigationTarget(target, check, activeWasSelected && !isPreview); }
    return true;
};

// Stages the current file, then opens the adjacent unstaged file in `direction`. Shared by both
// stage-and-advance commands: "next" advances down the list (top-to-bottom review, shift + next), "previous"
// moves up (bottom-to-top review, shift + previous). Only the landing-target differs; everything else (the
// staged-side no-op, the safety guard, the untracked-aware list, the editor handling) is identical.
const stageCurrentFileAndAdvance = async (
    direction: "next" | "previous", capturedChange?: FileChange,
    check: NavigationCheckpoint = noNavigationCheckpoint,
    priorView?: MouseReviewView
) => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);

    const currentUri = capturedChange?.uri ?? await getActiveFileUri();
    check();
    if (!currentUri) {
        debugLog("stage-flow", `${direction}: skipped, no active review file`);
        return;
    }

    // If the active diff is the STAGED side of a file, there's nothing to stage — do nothing (don't jump
    // to an unstaged file). This command is for working through UNSTAGED files; on a staged file it no-ops.
    const activeSide = capturedChange ?? await getActiveChange();
    check();
    if (activeSide?.staged === true) {
        debugLog("stage-flow", `${direction}: skipped staged review ${currentUri.fsPath}`);
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

    // BUG 4 FIX (v1.2.9 — stage-and-advance was a silent no-op on a merge-conflict file, and skipped conflicts
    // as advance targets). Route BOTH the safety guard AND the advance-target list through the ONE shared list
    // builder getFileChanges() — the SAME list next/previous-scm-change navigation uses — so the stage-and-
    // advance family can reach + progress through EXACTLY the entries the nav family can. Previously the guard
    // checked only index/working/untracked (NEVER state.mergeChanges), so a pure merge-conflict file failed the
    // guard and this function returned as a silent no-op (no stage, no advance, no message), stranding the user
    // on the conflict; and the advance list (getUnstagedUris) also omitted merges, so advancing from a normal
    // file skipped over conflicts — an asymmetry with keyboard nav, which walks through them. getFileChanges
    // includes merge conflicts (as staged:false entries) in the correct SCM order, so deriving both from it
    // fixes both parts with no divergent merge-only branch. Read it BEFORE staging: getFileChanges snapshots
    // activeRepo.state at call time, so the target is computed against the pre-stage state (deterministic).
    const allChanges = await getFileChanges(currentUri);
    check();

    // SAFETY GUARD: only act if the active file is actually a change (staged, unstaged, untracked, OR a merge
    // conflict). Without this, an accidental stage-and-advance while editing a clean/unrelated file would run
    // git add as a no-op then close that editor — a nasty surprise. Testing membership against getFileChanges()
    // keeps this guard and the advance list below reading from the SAME set, so they can never diverge again.
    if (!allChanges.some((c) => pathMatches(c.uri))) {
        debugLog("stage-flow", `${direction}: skipped, review file is not a Git change: ${currentUri.fsPath}`);
        return;
    }

    // The advance targets are the NON-STAGED entries (tracked unstaged + untracked/new + merge conflicts) in
    // SCM nav order. Staged entries are excluded because there's nothing to stage-and-advance FROM on them (the
    // staged-side early-return above already handled that case). Untracked/new files ARE included (git.openChange
    // opens them as a diff vs an empty original), so stage-and-advance lands on a brand-new file too.
    const advanceTargets = allChanges.filter((c) => !c.staged);

    const currentIndex = advanceTargets.findIndex((change) => pathMatches(change.uri));
    // Where to land after staging, by direction:
    //   "next"     -> the file AFTER the current one (top-to-bottom review); if it was the LAST, fall back to
    //                 the PREVIOUS one so we don't strand you. Not in the list -> the FIRST unstaged file.
    //   "previous" -> the file BEFORE the current one (bottom-to-top review); if it was the FIRST, fall back
    //                 to the NEXT one. Not in the list -> the LAST unstaged file.
    // The ?? handles the boundary; for the only-file case the fallback index is out of range and returns
    // undefined (-> keep the editor below, nothing left to review). NOTE: this end-of-list guard is exactly
    // what the mouse (F18/F19) + the "+" button inherit for free — they call this SAME function, so the
    // at-the-end/at-the-bottom behavior is identical no matter how stage-and-advance is triggered.
    let targetUnstagedChange: FileChange | undefined;
    if (currentIndex === -1) {
        targetUnstagedChange = direction === "next" ? advanceTargets[0] : advanceTargets[advanceTargets.length - 1];
    } else if (direction === "next") {
        targetUnstagedChange = advanceTargets[currentIndex + 1] ?? advanceTargets[currentIndex - 1];
    } else {
        targetUnstagedChange = advanceTargets[currentIndex - 1] ?? advanceTargets[currentIndex + 1];
    }

    // Stage the whole current file — equivalent to clicking the + next to it in the Source Control view.
    // CRITICAL ORDERING: we stage (and record last-staged) via the chokepoint HERE, BEFORE advancing the
    // active editor below. We must capture the STAGED file's identity (currentUri, resolved at the top of
    // this function) now — the advance switches the editor to the NEXT file, so reading the active file
    // afterwards would record the wrong file. stageThroughExtension only updates the status bar if add()
    // succeeds, so a no-op/failed stage won't show a file in the bar.
    debugLog("stage-flow", `${direction}: ${currentUri.fsPath} -> ${targetUnstagedChange?.uri.fsPath ?? "no remaining file"}`);
    await stageThroughExtension(activeRepo, currentUri, stageUndoViewFromMouseReview(currentUri, priorView));
    check(); // Finish the exact stage, but never pull the user back after a manual tab/worktree switch.

    if (!targetUnstagedChange) {
        // Nothing remains in this worktree: keep reviewing the final file. Closing
        // it can reveal another worktree and make the next stage press act there.
        // Its staged-only working view becomes the Index view so SCM Auto Reveal
        // cannot later expand Staged Changes (see presentStagedOnlyReview).
        // Still discard already-queued navigation; the successful stage stays undoable.
        await presentStagedOnlyReview([currentUri], check);
        invalidateChangeNavigation();
        return;
    }

    // Mirror openNextFile's editor handling: replace a pinned (non-preview) editor, keep a preview tab.
    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    // BUG 11 FIX (v1.2.9 — stage-and-advance landed nowhere on an untracked target with
    // git.untrackedChanges="separate"): route the final open through the SHARED openChangeEntry (the same
    // function nav's openNextFile/openPreviousFile use) instead of a raw git.openChange. In "separate" mode
    // git.openChange(untrackedUri) resolves nothing AND does NOT throw, so after closing the current editor
    // the target never opened and the user was stranded on a blank/closed editor. openChangeEntry's unstaged
    // path has a shown-tab verification + showTextDocument fallback that handles exactly this silent-no-op —
    // so the mouse/keyboard/"+" stage-and-advance now inherits it for free, matching plain navigation.
    debugLog("stage-flow", `${direction}: opening next review file`);
    if (direction === "previous") {
        await openNavigationTarget(targetUnstagedChange, check, !isPreview);
        // Stage-and-Previous is a cross-file backward transition too: land new files at EOF and tall diff hunks
        // at their last line, exactly like openPreviousFile/openLastFile.
        await landChangeForBackwardReview(targetUnstagedChange, check);
    } else {
        await openForwardNavigationTarget(targetUnstagedChange, check, !isPreview);
    }
    debugLog("stage-flow", `${direction}: next review opened; shown=${currentReviewFileUri()?.fsPath ?? "opaque image/non-text editor"}`);
};

// BUG 13 FIX (v1.2.9): serialize getActiveFilePath so its clipboard save/blank/restore dance can't interleave.
// The clipboard hack (below) is inherently racy: two concurrent calls (Ethan mashing alt+.) could have call B
// read the ALREADY-BLANKED clipboard as its "original" and later restore "" — permanently losing his real
// VS Code's Tab API exposes no resource at all for some non-text diff editors. In VS Code 1.135, for example,
// a modified PNG opens as an image comparison whose active Tab has `input === undefined`: it is neither the
// documented TabInputCustom nor any of the text/notebook inputs. The workbench's Copy Path command still knows
// the active resource, so this is the last-resort bridge used by image/media/future custom review views.
//
// The command writes through the clipboard. Keep that disturbance bounded and serialized, restore the prior
// value even if the command throws, and never overwrite a clipboard value that changed after the command wrote
// its result. (The old helper unconditionally restored and could clobber a simultaneous user copy.)
let copyActiveFilePathInFlight: Promise<string> | undefined;
const copyActiveFilePathFromWorkbench = async (): Promise<string> => {
    if (copyActiveFilePathInFlight) {
        return copyActiveFilePathInFlight;
    }
    copyActiveFilePathInFlight = (async (): Promise<string> => {
        const originalClipboardData = await vscode.env.clipboard.readText();
        const marker = `__BETTER_GIT_COPY_PATH_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        let commandClipboardData = marker;
        await vscode.env.clipboard.writeText(marker);
        try {
            await vscode.commands.executeCommand("workbench.action.files.copyPathOfActiveFile");
            commandClipboardData = await vscode.env.clipboard.readText();
            return commandClipboardData === marker ? "" : resolveWorkbenchFilePath(commandClipboardData, homedir());
        } finally {
            // Restore only while the clipboard still contains our marker/the command's result. If Ethan copied
            // something during this tiny window, that newer value owns the clipboard and must survive.
            const currentClipboardData = await vscode.env.clipboard.readText();
            if (currentClipboardData === marker || currentClipboardData === commandClipboardData) {
                await vscode.env.clipboard.writeText(originalClipboardData);
            }
        }
    })();
    try {
        return await copyActiveFilePathInFlight;
    } finally {
        copyActiveFilePathInFlight = undefined;
    }
};

const getActiveFilePath = async (): Promise<string> => {
    const currentFilename = vscode.window.activeTextEditor?.document.uri.path;
    return currentFilename ?? copyActiveFilePathFromWorkbench();
};

// Async superset of currentReviewFileUri(). Known text/custom/notebook shapes resolve synchronously. When a
// host exposes an active file-backed review tab as `unknown`/undefined (the modified-image regression), ask the
// workbench for its path and accept it only when vscode.git says that exact file is currently changed. The tab
// identity check prevents a slow clipboard lookup from applying the previous tab's path after a rapid switch.
const currentReviewFileUriAsync = async (): Promise<vscode.Uri | undefined> => {
    const direct = currentReviewFileUri();
    if (direct) {
        return direct;
    }
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab) {
        return undefined;
    }
    try {
        const activePath = await copyActiveFilePathFromWorkbench();
        if (!activePath || vscode.window.tabGroups.activeTabGroup.activeTab !== activeTab) {
            return undefined;
        }
        const resolved = vscode.Uri.file(activePath);
        return isChangeFileUri(resolved) ? resolved : undefined;
    } catch {
        return undefined;
    }
};

// BUG 13 FIX (v1.2.9): the four navigation entry-guards used to call getActiveFilePath() just to ask "is there
// a file under review?" — but when focus was in the SCM panel (activeTextEditor undefined, common in Ethan's
// flow) that fired the clipboard save/blank/restore hack on EVERY press, transiently blanking his clipboard.
// This resolves the active file focus-INDEPENDENTLY from the active TAB first (currentReviewFileUriAsync — the
// same shared "which file is under review" predicate the nav + badge use), then the focused editor's uri, and
// only falls back to getActiveFilePath when no current Git review shape matched. Public text/custom/notebook
// inputs never touch the clipboard; opaque image/media comparisons use the bounded workbench-path fallback.
// Returns undefined only when there is truly nothing open to act on.
const activeNavFilePath = async (): Promise<string | undefined> => {
    const fromTab = await currentReviewFileUriAsync() ?? vscode.window.activeTextEditor?.document.uri;
    if (fromTab) {
        return fromTab.path;
    }
    const fallback = await getActiveFilePath(); // last-ditch, non-textual (image) case only
    return fallback || undefined;
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
    // then press stage-and-next and it jumped to the FIRST unstaged file instead of the one after the click —
    // because getActiveFileUri read activeTextEditor, so the clicked file wasn't found in the list (-1 ->
    // workingTreeChanges[0] top fallback). currentReviewFileUri already resolves a staged git: side to its
    // on-disk file: path, so this also handles a clicked staged row.
    const fromTab = await currentReviewFileUriAsync();
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

// Shared implementation for the smart mouse buttons. See the big comment at the smart-forward /
// smart-back command registrations for the full rationale on why we detect the review view via the active
// tab's input type rather than the `isInDiffEditor` keybinding context.
//
// A review view is ANY of the shapes the keyboard next/previous-scm-change handle — a side-by-side diff
// (modified/renamed), a new/untracked file's plain editor, or a deleted file's HEAD-blob plain editor —
// each detected by REUSING the extension's existing predicates so the mouse is a thin wrapper over the
// same nav functions. All route to the scm-change commands; everything else -> browser nav. See the body.
//
// direction === "forward":  review -> PREVIOUS SCM change (intentionally flipped) | otherwise -> navigateForward
// direction === "back":     review -> NEXT SCM change (intentionally flipped)     | otherwise -> navigateBack
async function smartNavigate(direction: "forward" | "back") {
    // "In review" = the active tab is a change-review view that next/previous-scm-change know how to drive.
    // GENERAL PRINCIPLE (Ethan 2026-07-04): the mouse buttons must be THIN WRAPPERS over the SAME nav
    // functions the keyboard uses, so EVERY edge case the keyboard's next/previous-scm-change handle works via
    // the mouse automatically — not by patching one file-state at a time. So this gate must recognise ALL the
    // review views the keyboard handles, and route them to next/previous-scm-change. There are THREE shapes VS
    // Code opens a reviewed git change in — we recognise each by REUSING the extension's existing predicates
    // (no divergent per-case checks), and everything else falls through to plain browser back/forward:
    //
    //   1. MODIFIED / RENAMED file  -> a side-by-side text DIFF tab (TabInputTextDiff). This is what
    //      git.openChange opens when an original side exists. Routing here gives hunk navigation, cross-file
    //      rollover, AND the v1.2.6 tall-hunk staging (all live inside next/previous-scm-change) for free.
    //
    //   2. NEW / UNTRACKED ("U") / staged-new file  -> a PLAIN file: editor (TabInputText). A whole-new file
    //      has NO original side, so VS Code opens an ordinary editor, not a diff. Detected by REUSING
    //      newFileScrollEditor() — the SAME single-source-of-truth gate next/previous-scm-change use for the
    //      5-line new-file scroll (plain TabInputText + file: scheme + isFullyAddedFile git-status + visible
    //      editor). CRUCIAL: because that gate requires isFullyAddedFile, a MODIFIED file that the user opened
    //      as a plain editor to EDIT (not review — its review view is the DIFF, case 1) is NOT matched here, so
    //      we never hijack browser back/forward while they're just editing a changed file.
    //
    //   3. DELETED file  -> a PLAIN editor of the HEAD blob under a git: uri (TabInputText, git: scheme). It has
    //      no on-disk file: side, so newFileScrollEditor() (file:-only) correctly skips it. On the keyboard,
    //      next-scm-change on a deleted file falls straight through to the next changed file (openNextFile); the
    //      mouse must do the same. Detected by resolving the git: uri back to its on-disk path (toFilePathUri)
    //      and confirming it is an ACTUAL current change (isChangeFileUri) — the SAME shared predicate the tab
    //      badge + stageCurrentFile use — so a random HEAD/history view of a clean file is NOT treated as review.
    //
    // Before v1.2.8 the gate was case 1 ONLY (`instanceof TabInputTextDiff`), so on every non-diff review view
    // (new/untracked/deleted files) the mouse fell through to browser history and did nothing useful — while the
    // keyboard alt+,/alt+. worked, because they call next/previous-scm-change directly. This is that fix, made
    // general so future review shapes are covered by the shared predicates rather than another one-off patch.
    let inReview = false;
    try {
        // FOCUS-INDEPENDENT detection: read the active tab of the active group, not the focused editor. This is
        // what makes the mouse buttons "just work" even when focus is in the SCM panel during review.
        const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        const input = tab?.input;
        // Case 1 — modified/renamed diff. instanceof is safe even if `input` is undefined or some other type.
        const isDiff = input instanceof vscode.TabInputTextDiff;
        // Case 2 — new/untracked/staged-new plain file: editor. newFileScrollEditor() returns a TextEditor only
        // for a genuine whole-new-file review view (else undefined); its own body is fully guarded.
        const isNewFileView = !isDiff && newFileScrollEditor() !== undefined;
        // Case 3 — deleted file's HEAD-blob plain editor (git: scheme). Only a plain TabInputText tab can be one;
        // resolve to the on-disk path and require it to be an actual change so we don't match arbitrary git:
        // history views. (file:-scheme plain editors are handled by case 2, which correctly excludes modified
        // files being edited — so we deliberately restrict case 3 to the git: scheme.)
        let isDeletedFileView = false;
        if (!isDiff && !isNewFileView && input instanceof vscode.TabInputText && input.uri.scheme === "git") {
            const resolved = toFilePathUri(input.uri); // git: uri -> on-disk file: path (path lives in the query)
            isDeletedFileView = resolved ? isChangeFileUri(resolved) : false;
        }
        //   4. MERGE-CONFLICT file  -> a 3-way TabInputTextMerge editor (BUG 1, 2026-07-04). The keyboard
        //      next/previous-scm-change handle conflicts (getFileChanges includes state.mergeChanges,
        //      getActiveChange + currentReviewFileUri duck-type the merge editor), so the mouse must too — else
        //      it silently does browser back/forward on a conflict while the keyboard navigates the changeset.
        //      Detected via the SAME shared isMergeEditorInput predicate currentReviewFileUri/getActiveChange use.
        const isMergeView = !isDiff && !isNewFileView && !isDeletedFileView && isMergeEditorInput(input);
        //   5. NON-TEXT change (image/media/notebook/future custom diff). Older hosts exposed images as
        //      TabInputCustom, but VS Code 1.135 exposes a modified-image comparison with `tab.input` undefined.
        //      The async shared resolver handles both public inputs and that workbench-path fallback, then
        //      requires the exact file to be a live Git change. Deliberately exclude TabInputText here: a normal
        //      modified file opened for editing is not a review view and must keep browser-history mouse behavior.
        let isNonTextChangeView = false;
        if (
            !isDiff && !isNewFileView && !isDeletedFileView && !isMergeView &&
            !(input instanceof vscode.TabInputText)
        ) {
            isNonTextChangeView = (await currentReviewFileUriAsync()) !== undefined;
        }
        //   6. PLAIN MERGE-CONFLICT file (Codex review 2026-07-04, plain-merge follow-up). Case 4 only catches the
        //      3-way TabInputTextMerge editor, which VS Code opens only when git.mergeEditor=true. With the DEFAULT
        //      git.mergeEditor=false a conflict opens as the PLAIN working file (file: scheme TabInputText) with
        //      conflict markers — so the mouse fell through to browser nav while the keyboard navigated it
        //      (getFileChanges includes mergeChanges). Match a plain file: editor whose path is SPECIFICALLY in
        //      mergeChanges (isMergeConflictFileUri, NOT the general isChangeFileUri) so an ordinary modified file
        //      opened in a plain editor is still deliberately excluded from mouse change-nav (same intent as case 3).
        const isPlainMergeFileView =
            !isDiff && !isNewFileView && !isDeletedFileView && !isMergeView && !isNonTextChangeView &&
            plainMergeConflictEditor() !== undefined;
        inReview = isDiff || isNewFileView || isDeletedFileView || isMergeView || isNonTextChangeView || isPlainMergeFileView;
    } catch {
        // Defensive fallback: on a very old host where TabInputTextDiff doesn't exist (or newFileScrollEditor
        // throws) the lines above could throw. Fall back to the legacy heuristic — treat it as review only if
        // there's no plain active text editor (a side-by-side diff has no single activeTextEditor in the classic
        // sense). Worst case we mis-route to plain navigation, which is the harmless default. Never a dead click.
        inReview = !vscode.window.activeTextEditor;
    }

    // NOTE: the REVIEW branch is INTENTIONALLY flipped relative to the navigation branch (Ethan's preference,
    // 2026-06-20: "the diff one should be flipped, I know it's weird"). So the FORWARD button goes to the
    // PREVIOUS change while reviewing, and the BACK button goes to the NEXT change. This flip now covers ALL
    // review views (diff + new-file + deleted + merge + binary) identically — Ethan confirmed 2026-07-04 the
    // mouse direction "feels perfect", so we only fix WHICH views engage change-nav; the direction is unchanged.
    // Outside a review view the buttons keep their normal meaning (forward = navigateForward, back = navigateBack).
    // The flip is a MOUSE-BUTTON preference only. It must never leak onto keyboard keys again: that's the
    // v1.2.5 QWERTY bug — these commands held the default alt+./alt+, (physical >/<) keyboard keys, so QWERTY
    // users got reversed >/< navigation while Dvorak (whose >/< keys type v/w -> next/previous-scm-change)
    // stayed correct. Keyboard >/< now binds the canonical scm-change commands directly in package.json.
    //
    // BUG 3 FIX (v1.2.9 — smart mouse corrupted lastNavDirection, making the "+" button advance the WRONG way):
    // the review branch used to delegate via executeCommand("better-git-vscode.next-scm-change"/"previous-...").
    // Those two COMMAND HANDLERS write the module-level lastNavDirection (next-scm-change sets "next",
    // previous-scm-change sets "previous"). Because of the flip above, the smart-FORWARD button routed to
    // previous-scm-change and set lastNavDirection="previous"; so after reviewing FORWARD with the mouse, the
    // "+" button (which reads lastNavDirection) then advanced BACKWARD — the exact wrong-way bug the design
    // comment at the top of this file (lines ~20-23) says the smart buttons must NEVER cause. Fix: call the
    // underlying goToNextDiff()/goToPreviousDiff() DIRECTLY. They are the single-source-of-truth navigation
    // functions; the command handlers are thin wrappers whose ONLY extra behaviour is the lastNavDirection
    // write. Calling the functions gives byte-identical navigation while restoring the invariant that the
    // flipped smart mouse buttons never touch lastNavDirection, so the "+" keeps advancing in Ethan's actual
    // review direction. (F18/F19 were already immune — they pass an explicit direction.)
    // v1.2.17 narrow no-tab entry: keep normal browser history for EVERY active tab, including non-file
    // webviews such as Settings, Welcome, and extension pages. Do NOT use activeNavFilePath() as this gate:
    // webviews intentionally have no file path and would be mistaken for "nothing open", hijacking their
    // useful navigateBack/navigateForward history; its last-ditch path lookup can also invoke the BUG 13
    // clipboard save/blank/restore workaround on every mouse press. The tab model answers the real question
    // synchronously and without side effects: is there an active tab in the group the user is currently using?
    //
    // Check ONLY activeTabGroup, not every group. A tab open in a different split is not the current browser-
    // navigation context and should not prevent review entry when the active group itself is genuinely empty.
    // Conversely, any active tab in the active group — file, diff, Settings, Welcome, custom editor, webview —
    // must preserve normal browser navigation. In the one truly-empty-active-group state, let the mouse start
    // review with Ethan's existing intentional direction flip. This may give up VS Code's "reopen last
    // navigation position" opportunity when that group has no tab, but the explicit review command is more
    // useful after stage-and-advance closed the final reviewed file.
    const hasActiveTab = vscode.window.tabGroups.activeTabGroup.activeTab !== undefined;
    if (!inReview && !hasActiveTab) {
        if (direction === "forward") {
            await goToPreviousDiff(); // flipped: forward button -> previous/last review entry
        } else {
            await goToNextDiff(); // flipped: back button -> next/first review entry
        }
        return;
    }

    if (direction === "forward") {
        if (inReview) {
            await goToPreviousDiff(); // flipped: forward button -> PREVIOUS change (does NOT write lastNavDirection)
        } else {
            await vscode.commands.executeCommand("workbench.action.navigateForward");
        }
    } else {
        if (inReview) {
            await goToNextDiff(); // flipped: back button -> NEXT change (does NOT write lastNavDirection)
        } else {
            await vscode.commands.executeCommand("workbench.action.navigateBack");
        }
    }
}

export function deactivate(): Promise<void> | undefined { return stageHistoryLog?.settled(); }
