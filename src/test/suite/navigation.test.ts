// Real isolated VS Code/Git review journeys. Run focused cases on the Mini through test/runTest.ts.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync, execSync } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { resolveStagedLfsImage } from '../../stagedLfsImage';
import type { ReviewFilePosition } from '../../reviewFilePositions';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// E2E suite for next/previous-scm-change navigation (v1.2.1).
//
// WHY THIS EXISTS: v1.2.0 shipped a "scroll through newly-added files" feature that regressed
// navigation hard — the 5-line step wrongly fired on MODIFIED files (hijacking hunk navigation)
// and stepped stale hidden editors (perceived total no-op). These tests run against a REAL git
// repo fixture (created by runTest.ts before the host launched) and pin down the intended
// behaviour for every git file-state so the regression can't come back:
//   • MODIFIED file          -> hunk-to-hunk navigation, NEVER the 5-line step  (THE regression)
//   • untracked new file     -> ±5-line stepping in the plain editor; file fall-through at edges
//   • staged-new (INDEX_ADDED) plain editor -> steps; as empty-original DIFF -> normal nav (advances)
//   • DELETED (unstaged + INDEX_DELETED)    -> never steps, advances to the next file
//   • RENAMED (INDEX_RENAMED)               -> never steps, advances normally
//   • short/empty new files, custom newFileNavLineJump
//
// All git state changes go through real `git` subprocesses + the vscode.git API's status(), with
// polling helpers (no fixed sleeps on the happy path) so the suite is deterministic-but-fast.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ── generic polling helper: resolve as soon as fn() returns a truthy value, else fail loudly ──
const poll = async <T>(fn: () => T | undefined | null | false, what: string, timeoutMs = 15000, intervalMs = 100): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	// keep the last error so a throwing probe still surfaces useful info on timeout
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const v = fn();
			if (v) {
				return v;
			}
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`Timed out waiting for: ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The git "empty tree" id — used to build the empty side of a staged-new / staged-deleted diff exactly
// like the extension's openChangeEntry does. Computed from the fixture repo in suiteSetup (NOT hardcoded
// to the SHA-1 constant) so the suite also works if the repo was initialised with the SHA-256 object
// format (Codex review finding).
let EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // SHA-1 default, overwritten in suiteSetup

// Replicates the extension's toGitUri so tests can open the exact staged diffs openChangeEntry builds.
const toGitUri = (uri: vscode.Uri, ref: string): vscode.Uri =>
	uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });

// Resolve any uri (file: or git:) back to its on-disk path — git: uris carry the real path in the query.
const uriFilePath = (u: vscode.Uri): string => {
	if (u.scheme === 'git') {
		try {
			const q = JSON.parse(u.query);
			if (q?.path) {
				return vscode.Uri.file(q.path).path;
			}
		} catch {
			// fall through to u.path
		}
	}
	return u.path;
};

// On-disk path of whatever the active tab is showing (diff -> its modified/right side).
const activeTabPath = (): string | undefined => {
	const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputTextDiff) {
		return uriFilePath(input.modified);
	}
	if (input instanceof vscode.TabInputText) {
		return uriFilePath(input.uri);
	}
	return undefined;
};

// The visible TextEditor rendering `fileUri`'s document (matches by exact uri string).
const visibleEditorFor = (fileUri: vscode.Uri): vscode.TextEditor | undefined =>
	vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === fileUri.toString());

const readFakeAiCapture = (capturePath: string): { args: string[]; cwd: string; prompt: string } => {
	const parsed: unknown = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('args' in parsed) ||
		!('cwd' in parsed) ||
		!('prompt' in parsed) ||
		!Array.isArray(parsed.args) ||
		typeof parsed.cwd !== 'string' ||
		typeof parsed.prompt !== 'string'
	) {
		throw new Error('Fake AI capture has an invalid shape');
	}
	const args: string[] = [];
	for (const arg of parsed.args) {
		if (typeof arg !== 'string') {
				throw new Error('Fake AI capture contains a non-string argument');
		}
		args.push(arg);
	}
	return { args, cwd: parsed.cwd, prompt: parsed.prompt };
};

suite('SCM change navigation E2E', () => {
	let ws: string; // fixture workspace root (a real git repo, see runTest.ts)
	let repo: any; // vscode.git API Repository for the fixture
	let extensionApi: {
		whenStageTransactionsSettled(): Promise<void>;
		whenReviewDecorationSettled(): Promise<void>;
		getCurrentReviewUri(): string | undefined;
		getReviewDecorationBadge(uri: vscode.Uri): string | vscode.ThemeIcon | undefined;
		whenCurrentHunkOverviewMarkerSettled(): Promise<void>;
		getCurrentHunkOverviewMarker(): { uri: string; start: number; end: number } | undefined;
		getMouseDebugTrace(): string[];
		clearMouseDebugTrace(): void;
		isKeyboardReviewActive(): boolean;
        getRememberedReviewPosition?(uri: vscode.Uri): ReviewFilePosition | undefined;
        sampleKeyboardReviewKeys?(state: {option:boolean;shift:boolean;navigation:boolean;usedShift:boolean;navigationKeys?:number}): void;
        whenKeyboardGestureSettled?(): Promise<void>;
	};
	let baseSha: string; // the base commit every test resets to
	let previousMouseHoldNavigateOnButtonDown: boolean | undefined;

	// Run a git command inside the fixture. All command strings are hardcoded test constants.
	const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ws, stdio: 'pipe' }).toString().trim();

	// Write a file (creating parent dirs) relative to the workspace root.
	const write = (rel: string, content: string) => {
		const abs = path.join(ws, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		return vscode.Uri.file(abs);
	};

	const wsUri = (rel: string) => vscode.Uri.file(path.join(ws, rel));
	const deliverMouseUri = async (route: string, source: string, query?: string) => {
		const profile = process.env.BGV_TEST_USER_DATA_PATH;
		const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH ?? (process.platform === 'darwin'
			? path.resolve(vscode.env.appRoot, '../../MacOS/Code') : process.execPath);
		assert.ok(profile, 'native URI transport must target only the disposable profile');
		const cli = process.platform === 'darwin'
			? path.resolve(path.dirname(executable), '../Resources/app/out/cli.js')
			: path.join(vscode.env.appRoot, 'out/cli.js');
		await promisify(execFile)(executable!, [
			cli,
			`--user-data-dir=${profile}`, '--open-url',
			`vscode://ethansk.better-git-vscode/${route}?${query ?? `source=${source}`}`
		], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
	};
	const focusIsolatedTestWindow = async () => {
		const profile = process.env.BGV_TEST_USER_DATA_PATH;
		assert.ok(profile, 'the disposable VS Code profile must be identifiable before activating its window');
		const matches = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
			.split('\n').filter(line => line.includes(`--user-data-dir=${profile}`)
				&& line.includes('/Visual Studio Code.app/Contents/MacOS/Code ')
                && !line.includes('--open-url') && !line.includes('/Resources/app/out/cli.js'));
		assert.strictEqual(matches.length, 1, `activate only this test host, never another VS Code window: ${JSON.stringify(matches)}`);
		const pid = Number.parseInt(matches[0].trim(), 10);
		assert.ok(Number.isInteger(pid) && pid > 0);
		execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
			`ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(2);`]);
		await poll(() => vscode.window.state.focused, 'disposable VS Code window to gain focus');
	};
	const switchAwayFromIsolatedTestWindow = async () => {
		assert.ok(vscode.window.state.focused, 'start from the real focused test window');
		execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
			"ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);"]);
		await poll(() => !vscode.window.state.focused, 'actual app switch away from the test window');
	};

	// n lines joined WITHOUT a trailing newline, so document.lineCount === n exactly — keeps the
	// step-target arithmetic in assertions deterministic (a trailing \n adds a phantom empty last line).
	const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n');
	const wrappedTypeScriptFixture = () => {
		const result = ['export class WrappedNavigationFixture {'];
		for (let i = 0; i < 70; i++) {
			result.push(`  method${i + 1}(): string {`);
			result.push(`    const value = '${'wrapped-content-'.repeat(8 + (i % 9))}';`);
			result.push(`    return value + '${i % 3 === 0 ? 'short' : 'another-variable-length-fragment-'.repeat(5)}';`);
			result.push('  }');
		}
		result.push('}');
		return result.join('\n');
	};

	// Ask the git extension to re-scan, then wait until `pred` sees the expected state. Every test calls
	// this after mutating the working tree so assertions never race the extension's async refresh.
	const refreshUntil = async (pred: () => boolean, what: string) => {
		await repo.status();
		await poll(pred, what);
	};

	// Change-list probes against the live vscode.git state.
	const inWorkingTree = (rel: string, status?: number) =>
		(repo.state.workingTreeChanges ?? []).some(
			(c: any) => c.uri.path === wsUri(rel).path && (status === undefined || c.status === status)
		);
	const inIndex = (rel: string, status?: number) =>
		(repo.state.indexChanges ?? []).some(
			(c: any) => c.uri.path === wsUri(rel).path && (status === undefined || c.status === status)
		);
	// Untracked can live in workingTreeChanges (git.untrackedChanges="mixed", the default) OR in the
	// dedicated untrackedChanges list ("separate") — accept either so the suite passes on any user setting.
	const isUntracked = (rel: string) =>
		inWorkingTree(rel, 7 /* UNTRACKED */) ||
		(repo.state.untrackedChanges ?? []).some((c: any) => c.uri.path === wsUri(rel).path);
	const isMergeConflict = (rel: string) =>
		(repo.state.mergeChanges ?? []).some((c: any) => c.uri.path === wsUri(rel).path);

	// Create a real unresolved three-stage index entry without starting a repository-wide merge. The built-in
	// Git extension sees exactly the same mergeChanges state as a normal content conflict, while each test remains
	// self-contained and setup can restore the fixture with reset --hard.
	const createMergeConflict = (rel: string, ours: string, theirs: string, working: string) => {
		const baseBlob = git(`rev-parse ${baseSha}:${rel}`);
		const hashBlob = (content: string) =>
			execFileSync('git', ['hash-object', '-w', '--stdin'], {
				cwd: ws,
				input: content,
				encoding: 'utf8'
			}).trim();
		execFileSync('git', ['update-index', '--force-remove', '--', rel], { cwd: ws, stdio: 'pipe' });
		execFileSync('git', ['update-index', '--index-info'], {
			cwd: ws,
			input: [
				`100644 ${baseBlob} 1\t${rel}`,
				`100644 ${hashBlob(ours)} 2\t${rel}`,
				`100644 ${hashBlob(theirs)} 3\t${rel}`,
				''
			].join('\n'),
			encoding: 'utf8'
		});
		write(rel, working);
	};

	// Open a file as a PLAIN pinned editor with the cursor at `line` (how an untracked file shows up).
	const openPlainAt = async (rel: string, line: number): Promise<vscode.TextEditor> => {
		const editor = await vscode.window.showTextDocument(wsUri(rel), { preview: false });
		const pos = new vscode.Position(line, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
		// VS Code remembers scroll state by URI even after close/recreate. Several tests deliberately reuse
		// zz_new.txt, so resetting only the caret can leave the next test's viewport at the prior test's L16.
		await poll(() => editor.visibleRanges[0]?.start.line === line, `${rel} viewport to reset to line ${line}`);
		return editor;
	};

	// Open the live working-tree side of a real git diff and reset its logical caret/viewport. Keeping this in one
	// helper makes the tall-hunk regressions exercise the same git.openChange path while avoiding duplicated races.
	const openWorkingDiffAt = async (rel: string, line: number): Promise<vscode.TextEditor> => {
		await vscode.commands.executeCommand('git.openChange', wsUri(rel));
		const editor = await poll(() => {
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			const visible = visibleEditorFor(wsUri(rel));
			return activeTab?.input instanceof vscode.TabInputTextDiff && visible ? visible : undefined;
		}, `${rel} working-tree diff to render`);
		await sleep(300); // built-in diff computation finishes after the editor object first becomes visible
		const pos = new vscode.Position(line, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
		await poll(() => lineIsVisible(editor, line), `${rel} line ${line} to become visible`);
		return editor;
	};

	const nextChange = () => vscode.commands.executeCommand('better-git-vscode.next-scm-change');
	const previousChange = () => vscode.commands.executeCommand('better-git-vscode.previous-scm-change');
	const chooseCommitMessageProvider = async (provider: 'codex' | 'claude') => {
		let settled = false;
		const providerCommand = Promise
			.resolve(vscode.commands.executeCommand('better-git-vscode.change-commit-message-ai-provider'))
			.finally(() => {
				settled = true;
			});
		const deadline = Date.now() + 15_000;
		while (!settled && Date.now() < deadline) {
			await sleep(100);
			if (provider === 'claude') {
				await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			}
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		}
		if (!settled) {
			await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
			throw new Error(`Timed out choosing the ${provider} commit-message provider`);
		}
		await providerCommand;
	};

	// Wait until the active tab shows `rel` — the standard "navigation advanced to file X" assertion.
	const expectActiveTab = (rel: string) =>
		poll(() => activeTabPath() === wsUri(rel).path, `active tab to become ${rel} (was ${activeTabPath()})`);

	// Wait until the cursor in `rel`'s visible editor sits on `line` — the standard stepping assertion.
	const expectCursorAt = (rel: string, line: number) =>
		poll(() => {
			const e = visibleEditorFor(wsUri(rel));
			return e && e.selection.active.line === line ? e : undefined;
		}, `cursor in ${rel} to reach line ${line} (at ${visibleEditorFor(wsUri(rel))?.selection.active.line})`);

	// A cursor move alone is NOT proof that new-file review scrolled: the v1.2.15 regression moved the caret
	// from L1 to L6 while leaving the viewport at L1, then every later NEXT recomputed L6 and stuck forever.
	const expectViewportTop = (rel: string, pred: (line: number) => boolean, description: string) =>
		poll(() => {
			const e = visibleEditorFor(wsUri(rel));
			const top = e?.visibleRanges[0]?.start.line;
			return top !== undefined && pred(top) ? e : undefined;
		}, `viewport in ${rel} ${description} (at ${visibleEditorFor(wsUri(rel))?.visibleRanges[0]?.start.line})`);
	const lineIsVisible = (editor: vscode.TextEditor, line: number) =>
		editor.visibleRanges.some(range => line >= range.start.line && line <= range.end.line);
	const positionIsVisible = (editor: vscode.TextEditor, position: vscode.Position) =>
		editor.visibleRanges.some(range => range.contains(position));
	const expectCursorVisibleAt = async (rel: string, line: number) => {
		const editor = await expectCursorAt(rel, line);
		await poll(() => lineIsVisible(editor, line), `cursor line ${line} in ${rel} to be visible`);
		return editor;
	};

	// Capture the real renderer event sequence for one navigation operation. The v1.2.22 forcing-anchor workaround
	// would produce e.g. [10, 80, 15]: it moved far past the target and then back. Final-state-only assertions could
	// never catch that visible "jumpy jumpy" regression, so all scrolling primitives now get monotonicity coverage.
	const viewportTopsDuring = async (editor: vscode.TextEditor, operation: () => PromiseLike<unknown>) => {
		const tops: number[] = [];
		const record = () => {
			const top = editor.visibleRanges[0]?.start.line;
			if (top !== undefined && tops[tops.length - 1] !== top) {
				tops.push(top);
			}
		};
		record();
		const sub = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
			if (event.textEditor === editor) {
				record();
			}
		});
		try {
			await operation();
			await sleep(40); // operation waits for renderer quiet; this catches one final queued visible-range event
			record();
			return tops;
		} finally {
			sub.dispose();
		}
	};
	const assertViewportMonotonic = (tops: number[], direction: 'down' | 'up', context: string) => {
		for (let i = 1; i < tops.length; i++) {
			const monotonic = direction === 'down' ? tops[i] >= tops[i - 1] : tops[i] <= tops[i - 1];
			assert.ok(monotonic, `${context}: viewport reversed ${direction} during one press: ${tops.join(' -> ')}`);
		}
	};

	suiteSetup(async function () {
		// One-time host warm-up can be slow (git ext activation + repo discovery).
		this.timeout(120_000);
		ws = vscode.workspace.workspaceFolders![0].uri.fsPath;

		// Activate the built-in git extension and wait for it to discover the fixture repo.
		const gitExt = vscode.extensions.getExtension<any>('vscode.git')!;
		await gitExt.activate();
		const api = gitExt.exports.getAPI(1);
		repo = await poll(() => api.getRepository(vscode.Uri.file(ws)), 'vscode.git to discover the fixture repository', 60_000);
		baseSha = git('rev-parse HEAD');
		// Ask git itself for the empty-tree id of THIS repo's object format (SHA-1 vs SHA-256).
		EMPTY_TREE = git('hash-object -t tree /dev/null');

		// Make sure OUR extension is active before the first executeCommand (onStartupFinished usually
		// beats us here, but don't rely on the race).
		extensionApi = await vscode.extensions.getExtension<any>('EthanSK.better-git-vscode')!.activate();
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		previousMouseHoldNavigateOnButtonDown = config.inspect<boolean>(
			'experimentalMouseHoldNavigateOnButtonDown'
		)?.globalValue;
		// Existing button-down coverage remains a regression suite for the preserved experimental path.
		await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('better-git-vscode').update(
			'experimentalMouseHoldNavigateOnButtonDown',
			previousMouseHoldNavigateOnButtonDown,
			vscode.ConfigurationTarget.Global
		);
	});

	// Every test starts from a pristine base commit + empty editor area, so tests are order-independent
	// and self-cleaning (rename/delete/stage state from a previous test can't leak in).
	setup(async () => {
		git(`reset --hard ${baseSha}`);
		git('clean -fdq');
		await refreshUntil(
			() =>
				(repo.state.workingTreeChanges ?? []).length === 0 &&
				(repo.state.indexChanges ?? []).length === 0 &&
				(repo.state.mergeChanges ?? []).length === 0 &&
				// git.untrackedChanges="separate" keeps untracked files in their own list — it must drain
				// too, or an untracked file from the previous test could leak into this one's change list.
				(repo.state.untrackedChanges ?? []).length === 0,
			'clean git state after reset'
		);
		await extensionApi.whenStageTransactionsSettled();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('contributes the Source Control file and worktree context actions', async () => {
		const extension = vscode.extensions.getExtension<any>('EthanSK.better-git-vscode')!;
		const contributedCommands = extension.packageJSON.contributes.commands as Array<{ command: string }>;
		const menus = extension.packageJSON.contributes.menus as Record<string, Array<Record<string, string>>>;
		const keybindings = extension.packageJSON.contributes.keybindings as Array<Record<string, string>>;

		const openIndexCommand = 'better-git-vscode.open-index-in-system-browser';
		const copyWorktreeNameCommand = 'better-git-vscode.copy-worktree-name';
		const revealFileCommand = 'better-git-vscode.reveal-current-file-in-explorer';
		const addWorktreeCommand = 'better-git-vscode.add-worktree-to-workspace';
		const generateCommitMessageCommand = 'better-git-vscode.generate-commit-message-with-ai';
		const changeProviderCommand = 'better-git-vscode.change-commit-message-ai-provider';
		assert.ok(contributedCommands.some(({ command }) => command === openIndexCommand));
		assert.ok(contributedCommands.some(({ command }) => command === copyWorktreeNameCommand));
		assert.ok(contributedCommands.some(({ command }) => command === addWorktreeCommand));
		assert.ok(contributedCommands.some(({ command }) => command === generateCommitMessageCommand));
		assert.ok(contributedCommands.some(({ command }) => command === changeProviderCommand));

		assert.deepStrictEqual(
			menus['scm/resourceState/context'].find(({ command }) => command === openIndexCommand),
			{
				command: openIndexCommand,
				group: 'navigation@-1000',
				// SCM resource menus do not expose resourceFilename/resourceScheme. Runtime URI validation
				// keeps this provider-wide contribution safe; a native-menu regression covers visibility.
				when: 'scmProvider == git'
			}
		);
		assert.deepStrictEqual(
			menus['scm/resourceState/context'].find(({ command }) => command === revealFileCommand),
			{
				command: revealFileCommand,
				group: 'navigation@-999',
				when: 'scmProvider == git'
			}
		);
		assert.deepStrictEqual(
			menus['explorer/context'].find(({ command }) => command === openIndexCommand),
			{
				command: openIndexCommand,
				group: 'navigation@-1000',
				when: "resourceScheme == file && resourceFilename == 'index.html'"
			}
		);
		assert.deepStrictEqual(
			menus['scm/sourceControl'].find(({ command }) => command === addWorktreeCommand),
			{
				command: addWorktreeCommand,
				group: 'navigation@-999',
				when: 'scmProvider == git && scmProviderContext == worktree'
			}
		);
		assert.deepStrictEqual(
			menus['scm/sourceControl'].find(({ command }) => command === copyWorktreeNameCommand),
			{
				command: copyWorktreeNameCommand,
				// The built-in Git extension puts its first header actions at navigation@1/@2.
				// A negative order keeps this frequent action at the very top of the menu.
				group: 'navigation@-1000',
				when: 'scmProvider == git && scmProviderContext == worktree'
			}
		);
		assert.deepStrictEqual(
			menus['scm/title'].find(({ command }) => command === generateCommitMessageCommand),
			{
				command: generateCommitMessageCommand,
				group: 'navigation@-4',
				when: 'scmProvider == git'
			}
		);
		assert.deepStrictEqual(
			menus['git.commit'].find(({ command }) => command === generateCommitMessageCommand),
			{
				command: generateCommitMessageCommand,
				group: '4_better_git@1'
			}
		);
		assert.strictEqual(
			menus['scm/inputBox'],
			undefined,
			"Marketplace extensions cannot use VS Code's proposed scm/inputBox contribution"
		);
		assert.deepStrictEqual(
			keybindings.find(
				({ command, mac }) =>
					command === 'better-git-vscode.undo-last-stage-and-advance' && mac === 'cmd+z'
			),
			{
				command: 'better-git-vscode.undo-last-stage-and-advance',
				key: 'ctrl+z',
				mac: 'cmd+z',
				when: 'focusedView == workbench.scm && !inputFocus'
			},
			'Cmd/Ctrl+Z must replace only the Source Control Changes list no-op, never editor or commit-input undo'
		);
		assert.strictEqual(
			extension.packageJSON.contributes.configuration.properties['better-git-vscode.commitMessageProvider'],
			undefined,
			'provider selection must use extension global state so a hot update cannot leave its setting unregistered'
		);
		assert.strictEqual(
			extension.packageJSON.contributes.configuration.properties['better-git-vscode.codexExecutablePath'].default,
			'codex'
		);
		assert.strictEqual(
			extension.packageJSON.contributes.configuration.properties['better-git-vscode.claudeExecutablePath'].default,
			'claude'
		);

		const registeredCommands = await vscode.commands.getCommands(true);
		assert.ok(registeredCommands.includes(openIndexCommand), 'browser command must be registered at runtime');
		assert.ok(registeredCommands.includes(copyWorktreeNameCommand), 'copy command must be registered at runtime');
		assert.ok(registeredCommands.includes(addWorktreeCommand), 'add-worktree command must be registered at runtime');
		assert.ok(registeredCommands.includes(generateCommitMessageCommand), 'AI commit-message command must be registered');
		assert.ok(registeredCommands.includes(changeProviderCommand), 'Change-provider command must be registered');

		const originalClipboard = await vscode.env.clipboard.readText();
		try {
			const worktreeRoot = vscode.Uri.file(path.join(path.dirname(ws), 'feature-copy-name'));
			await vscode.commands.executeCommand(copyWorktreeNameCommand, { rootUri: worktreeRoot });
			assert.strictEqual(await vscode.env.clipboard.readText(), 'feature-copy-name');
		} finally {
			await vscode.env.clipboard.writeText(originalClipboard);
		}
	});

	test('staging a staged notebook diff preserves its later unstaged edits', async () => {
		const rel = 'committed/notebook.ipynb';
		const uri = wsUri(rel);
		const notebook = (text: string) => JSON.stringify({
			cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [text] }],
			metadata: {}, nbformat: 4, nbformat_minor: 2,
		});
		write(rel, notebook("print('staged')\n"));
		git(`add ${rel}`);
		write(rel, notebook("print('later unstaged')\n"));
		await refreshUntil(() => inIndex(rel, 0) && inWorkingTree(rel, 5), 'dual-state notebook');
		const before = execFileSync('git', ['write-tree'], { cwd: ws, encoding: 'utf8' }).trim();
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, ''), 'notebook.ipynb (Index)');
		await poll(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputNotebookDiff,
			'staged notebook diff');
		await sleep(250); // allow the notebook renderer to finish before changing tabs
		await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
		assert.strictEqual(execFileSync('git', ['write-tree'], { cwd: ws, encoding: 'utf8' }).trim(), before,
			'The staged notebook view must not stage unseen working-file edits');
	});

	test('Codex commit message uses only staged changes when the repository has a staged diff', async () => {
		const fakeCodexPath = process.env.BGV_FAKE_CODEX_PATH;
		const capturePath = process.env.BGV_FAKE_CODEX_CAPTURE_PATH;
		assert.ok(fakeCodexPath, 'runTest.ts must provide the fake Codex executable');
		assert.ok(capturePath, 'runTest.ts must provide the fake Codex capture path');
		const fakeClaudePath = process.env.BGV_FAKE_CLAUDE_PATH;
		assert.ok(fakeClaudePath, 'runTest.ts must provide the fake Claude executable');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousCodexExecutable = config.inspect<string>('codexExecutablePath')?.globalValue;
		const previousClaudeExecutable = config.inspect<string>('claudeExecutablePath')?.globalValue;
		try {
			await config.update('codexExecutablePath', fakeCodexPath, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', fakeClaudePath, vscode.ConfigurationTarget.Global);
			await chooseCommitMessageProvider('codex');
			const staged = lines(40, 'mod_a').split('\n');
			staged[4] = 'STAGED_CODEX_MARKER';
			write('committed/mod_a.txt', staged.join('\n'));
			git('add committed/mod_a.txt');
			const unstaged = lines(10, 'mod_d').split('\n');
			unstaged[2] = 'UNSTAGED_CODEX_MARKER';
			write('committed/mod_d.txt', unstaged.join('\n'));
			await refreshUntil(
				() => inIndex('committed/mod_a.txt', 0) && inWorkingTree('committed/mod_d.txt', 5),
				'staged and unstaged Codex fixtures to appear'
			);
			repo.inputBox.value = '';
			fs.rmSync(capturePath, { force: true });

			await vscode.commands.executeCommand(
				'better-git-vscode.generate-commit-message-with-ai',
				vscode.Uri.file(ws)
			);

			assert.strictEqual(repo.inputBox.value, 'test: generated staged message');
			const capture = readFakeAiCapture(capturePath);
			assert.ok(path.basename(capture.cwd).startsWith('better-git-ai-'));
			assert.notStrictEqual(capture.cwd, ws);
			assert.strictEqual(capture.args[capture.args.indexOf('--model') + 1], 'gpt-6-luna');
			assert.ok(capture.args.includes('--ephemeral'));
			assert.ok(capture.args.includes('--ignore-user-config'));
			assert.ok(capture.args.includes('--ignore-rules'));
			assert.ok(capture.args.includes('--skip-git-repo-check'));
			assert.ok(capture.args.includes('--output-schema'));
			assert.ok(capture.args.includes('--output-last-message'));
			assert.strictEqual(
				capture.args[capture.args.indexOf('-c') + 1],
				'model_reasoning_effort="none"'
			);
			assert.strictEqual(
				path.basename(capture.args[capture.args.indexOf('-C') + 1]),
				path.basename(capture.cwd)
			);
			assert.ok(capture.prompt.includes('The scope is staged.'));
			assert.ok(capture.prompt.includes('STAGED_CODEX_MARKER'));
			assert.ok(!capture.prompt.includes('UNSTAGED_CODEX_MARKER'));
		} finally {
			repo.inputBox.value = '';
			await config.update('codexExecutablePath', previousCodexExecutable, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', previousClaudeExecutable, vscode.ConfigurationTarget.Global);
		}
	});

	test('Codex commit message includes tracked and untracked working-tree changes when nothing is staged', async () => {
		const fakeCodexPath = process.env.BGV_FAKE_CODEX_PATH;
		const capturePath = process.env.BGV_FAKE_CODEX_CAPTURE_PATH;
		assert.ok(fakeCodexPath, 'runTest.ts must provide the fake Codex executable');
		assert.ok(capturePath, 'runTest.ts must provide the fake Codex capture path');
		const fakeClaudePath = process.env.BGV_FAKE_CLAUDE_PATH;
		assert.ok(fakeClaudePath, 'runTest.ts must provide the fake Claude executable');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousCodexExecutable = config.inspect<string>('codexExecutablePath')?.globalValue;
		const previousClaudeExecutable = config.inspect<string>('claudeExecutablePath')?.globalValue;
		try {
			await config.update('codexExecutablePath', fakeCodexPath, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', fakeClaudePath, vscode.ConfigurationTarget.Global);
			await chooseCommitMessageProvider('codex');
			const working = lines(40, 'mod_a').split('\n');
			working[4] = 'WORKING_CODEX_MARKER';
			write('committed/mod_a.txt', working.join('\n'));
			write('codex-untracked.txt', 'UNTRACKED_CODEX_MARKER\n');
			const symlinkPath = path.join(ws, 'codex-untracked-link.txt');
			if (process.platform !== 'win32') {
				const symlinkTarget = path.join(vscode.workspace.workspaceFolders![1].uri.fsPath, 'codex-symlink-target.txt');
				fs.writeFileSync(symlinkTarget, 'UNTRACKED_SYMLINK_TARGET_MARKER\n');
				fs.symlinkSync(symlinkTarget, symlinkPath);
			}
			await refreshUntil(
				() =>
					inWorkingTree('committed/mod_a.txt', 5) &&
					isUntracked('codex-untracked.txt') &&
					(process.platform === 'win32' || isUntracked('codex-untracked-link.txt')),
				'working and untracked Codex fixtures to appear'
			);
			repo.inputBox.value = '';
			fs.rmSync(capturePath, { force: true });

			await vscode.commands.executeCommand(
				'better-git-vscode.generate-commit-message-with-ai',
				{ rootUri: vscode.Uri.file(ws) }
			);

			assert.strictEqual(repo.inputBox.value, 'test: generated working message');
			const capture = readFakeAiCapture(capturePath);
			assert.ok(capture.prompt.includes('The scope is working tree.'));
			assert.ok(capture.prompt.includes('WORKING_CODEX_MARKER'));
			assert.ok(capture.prompt.includes('UNTRACKED_CODEX_MARKER'));
			if (process.platform !== 'win32') {
				assert.ok(capture.prompt.includes('Untracked symbolic link: codex-untracked-link.txt'));
				assert.ok(!capture.prompt.includes('UNTRACKED_SYMLINK_TARGET_MARKER'));
			}
		} finally {
			repo.inputBox.value = '';
			await config.update('codexExecutablePath', previousCodexExecutable, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', previousClaudeExecutable, vscode.ConfigurationTarget.Global);
		}
	});

	test('Claude commit message uses low effort, no tools or settings, and fills the selected repository input', async () => {
		const fakeClaudePath = process.env.BGV_FAKE_CLAUDE_PATH;
		const capturePath = process.env.BGV_FAKE_CLAUDE_CAPTURE_PATH;
		assert.ok(fakeClaudePath, 'runTest.ts must provide the fake Claude executable');
		assert.ok(capturePath, 'runTest.ts must provide the fake Claude capture path');
		const fakeCodexPath = process.env.BGV_FAKE_CODEX_PATH;
		assert.ok(fakeCodexPath, 'runTest.ts must provide the fake Codex executable');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousCodexExecutable = config.inspect<string>('codexExecutablePath')?.globalValue;
		const previousClaudeExecutable = config.inspect<string>('claudeExecutablePath')?.globalValue;
		try {
			await config.update('codexExecutablePath', fakeCodexPath, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', fakeClaudePath, vscode.ConfigurationTarget.Global);
			await chooseCommitMessageProvider('claude');
			const working = lines(40, 'mod_a').split('\n');
			working[4] = 'CLAUDE_REPOSITORY_INPUT_MARKER';
			write('committed/mod_a.txt', working.join('\n'));
			await refreshUntil(
				() => inWorkingTree('committed/mod_a.txt', 5),
				'Claude working-tree fixture to appear'
			);
			repo.inputBox.value = '';
			fs.rmSync(capturePath, { force: true });

			await vscode.commands.executeCommand(
				'better-git-vscode.generate-commit-message-with-ai',
				{ rootUri: vscode.Uri.file(ws) }
			);

			assert.strictEqual(repo.inputBox.value, 'test: generated working message with Claude');
			const capture = readFakeAiCapture(capturePath);
			assert.ok(path.basename(capture.cwd).startsWith('better-git-ai-'));
			assert.notStrictEqual(capture.cwd, ws);
			assert.strictEqual(capture.args[capture.args.indexOf('--model') + 1], 'opus');
			assert.ok(capture.args.includes('-p'));
			assert.strictEqual(capture.args[capture.args.indexOf('--output-format') + 1], 'json');
			assert.strictEqual(capture.args[capture.args.indexOf('--effort') + 1], 'low');
			assert.strictEqual(capture.args[capture.args.indexOf('--tools') + 1], '');
			assert.strictEqual(capture.args[capture.args.indexOf('--setting-sources') + 1], '');
			assert.ok(capture.args.includes('--no-session-persistence'));
			const schema = JSON.parse(capture.args[capture.args.indexOf('--json-schema') + 1]);
			assert.deepStrictEqual(schema.required, ['commitMessage']);
			assert.strictEqual(schema.additionalProperties, false);
			assert.ok(capture.prompt.includes('The scope is working tree.'));
			assert.ok(capture.prompt.includes('CLAUDE_REPOSITORY_INPUT_MARKER'));
		} finally {
			repo.inputBox.value = '';
			await config.update('codexExecutablePath', previousCodexExecutable, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', previousClaudeExecutable, vscode.ConfigurationTarget.Global);
		}
	});

	test('Codex commit message falls back to Claude once with the same selected repository context', async () => {
		const fakeClaudePath = process.env.BGV_FAKE_CLAUDE_PATH;
		const capturePath = process.env.BGV_FAKE_CLAUDE_CAPTURE_PATH;
		assert.ok(fakeClaudePath, 'runTest.ts must provide the fake Claude executable');
		assert.ok(capturePath, 'runTest.ts must provide the fake Claude capture path');
		const fakeCodexPath = process.env.BGV_FAKE_CODEX_PATH;
		assert.ok(fakeCodexPath, 'runTest.ts must provide the fake Codex executable');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousCodexExecutable = config.inspect<string>('codexExecutablePath')?.globalValue;
		const previousClaudeExecutable = config.inspect<string>('claudeExecutablePath')?.globalValue;
		try {
			await config.update('codexExecutablePath', fakeCodexPath, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', fakeClaudePath, vscode.ConfigurationTarget.Global);
			await chooseCommitMessageProvider('codex');
			process.env.BGV_FAKE_CODEX_FAIL = '1';
			const working = lines(40, 'mod_a').split('\n');
			working[4] = 'CLAUDE_REPOSITORY_INPUT_MARKER';
			write('committed/mod_a.txt', working.join('\n'));
			await refreshUntil(
				() => inWorkingTree('committed/mod_a.txt', 5),
				'Claude working-tree fixture to appear'
			);
			repo.inputBox.value = '';
			fs.rmSync(capturePath, { force: true });

			await vscode.commands.executeCommand(
				'better-git-vscode.generate-commit-message-with-ai',
				{ rootUri: vscode.Uri.file(ws) }
			);

			assert.strictEqual(repo.inputBox.value, 'test: generated working message with Claude');
			const capture = readFakeAiCapture(capturePath);
			assert.ok(path.basename(capture.cwd).startsWith('better-git-ai-'));
			assert.notStrictEqual(capture.cwd, ws);
			assert.strictEqual(capture.args[capture.args.indexOf('--model') + 1], 'opus');
			assert.ok(capture.args.includes('-p'));
			assert.strictEqual(capture.args[capture.args.indexOf('--output-format') + 1], 'json');
			assert.strictEqual(capture.args[capture.args.indexOf('--effort') + 1], 'low');
			assert.strictEqual(capture.args[capture.args.indexOf('--tools') + 1], '');
			assert.strictEqual(capture.args[capture.args.indexOf('--setting-sources') + 1], '');
			assert.ok(capture.args.includes('--no-session-persistence'));
			const schema = JSON.parse(capture.args[capture.args.indexOf('--json-schema') + 1]);
			assert.deepStrictEqual(schema.required, ['commitMessage']);
			assert.strictEqual(schema.additionalProperties, false);
			assert.ok(capture.prompt.includes('The scope is working tree.'));
			assert.ok(capture.prompt.includes('CLAUDE_REPOSITORY_INPUT_MARKER'));
		} finally {
			delete process.env.BGV_FAKE_CODEX_FAIL;
			repo.inputBox.value = '';
			await config.update('codexExecutablePath', previousCodexExecutable, vscode.ConfigurationTarget.Global);
			await config.update('claudeExecutablePath', previousClaudeExecutable, vscode.ConfigurationTarget.Global);
		}
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// UNTRACKED NEW FILE — the feature itself
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('untracked new file: repeated next scrolls +5 each time; previous mirrors -5', async () => {
		// Deliberately much taller than any test-host viewport. A 30-line fixture could fit on a large runner
		// and accidentally exercise cross-file fall-through instead of the production 243-line-file path.
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		const editor = await openPlainAt('zz_new.txt', 0);
		const initialTop = editor.visibleRanges[0].start.line;

		const firstDown = await viewportTopsDuring(editor, nextChange);
		await expectCursorVisibleAt('zz_new.txt', 5);
		assertViewportMonotonic(firstDown, 'down', 'first untracked next');
		const secondDown = await viewportTopsDuring(editor, nextChange);
		await expectCursorVisibleAt('zz_new.txt', 10);
		assertViewportMonotonic(secondDown, 'down', 'second untracked next');
		assert.ok(editor.visibleRanges[0].start.line > initialTop, 'two next presses never advanced the viewport');

		const firstUp = await viewportTopsDuring(editor, previousChange);
		await expectCursorVisibleAt('zz_new.txt', 5);
		assertViewportMonotonic(firstUp, 'up', 'first untracked previous');
		const secondUp = await viewportTopsDuring(editor, previousChange);
		await expectCursorVisibleAt('zz_new.txt', 0);
		assertViewportMonotonic(secondUp, 'up', 'second untracked previous');
		// stepping never leaves the file
		assert.strictEqual(activeTabPath(), wsUri('zz_new.txt').path);
	});

	test('plain merge-conflict view: next/previous traverse blocks and roll across files', async () => {
		const config = vscode.workspace.getConfiguration('git');
		const previousMergeEditor = config.inspect<boolean>('mergeEditor')?.globalValue;
		const firstRel = 'committed/mod_a.txt';
		const secondRel = 'committed/mod_d.txt';
		const firstConflictStarts = [2, 10, 18];
		const firstWorking = [
			'context before',
			'more context',
			'<<<<<<< HEAD',
			'ours one',
			'=======',
			'theirs one',
			'>>>>>>> topic',
			'between one and two',
			'more between',
			'more between',
			'<<<<<<< HEAD',
			'ours two',
			'=======',
			'theirs two',
			'>>>>>>> topic',
			'between two and three',
			'more between',
			'more between',
			'<<<<<<< HEAD',
			'ours three',
			'=======',
			'theirs three',
			'>>>>>>> topic',
			'context after'
		].join('\n');
		const secondConflictStart = 3;
		const secondWorking = [
			'other context',
			'more other context',
			'even more context',
			'<<<<<<< HEAD',
			'ours four',
			'=======',
			'theirs four',
			'>>>>>>> topic',
			'other context after'
		].join('\n');

		try {
			await config.update('mergeEditor', false, vscode.ConfigurationTarget.Global);
			createMergeConflict(firstRel, lines(40, 'ours-a'), lines(40, 'theirs-a'), firstWorking);
			createMergeConflict(secondRel, lines(10, 'ours-d'), lines(10, 'theirs-d'), secondWorking);
			await refreshUntil(
				() => isMergeConflict(firstRel) && isMergeConflict(secondRel),
				'both unresolved files to appear in mergeChanges'
			);

			// git.openChange is the command behind clicking an unresolved row in Source Control. With the default
			// merge editor disabled, it must produce the ordinary working-file editor Ethan uses.
			await vscode.commands.executeCommand('git.openChange', wsUri(firstRel));
			const editor = await poll(() => {
				const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
				const visible = visibleEditorFor(wsUri(firstRel));
				return activeTab?.input instanceof vscode.TabInputText && visible ? visible : undefined;
			}, 'plain merge-conflict editor to open from Source Control');
			const beforeFirst = new vscode.Position(0, 0);
			editor.selection = new vscode.Selection(beforeFirst, beforeFirst);

			await nextChange();
			await expectCursorAt(firstRel, firstConflictStarts[0]);
			await vscode.commands.executeCommand('workbench.view.scm'); // navigation remains tab-owned with SCM focus
			await nextChange();
			await expectCursorAt(firstRel, firstConflictStarts[1]);
			await nextChange();
			await expectCursorAt(firstRel, firstConflictStarts[2]);

			await previousChange();
			await expectCursorAt(firstRel, firstConflictStarts[1]);
			await previousChange();
			await expectCursorAt(firstRel, firstConflictStarts[0]);

			await nextChange();
			await expectCursorAt(firstRel, firstConflictStarts[1]);
			await nextChange();
			await expectCursorAt(firstRel, firstConflictStarts[2]);
			await nextChange();
			await expectActiveTab(secondRel);
			await expectCursorAt(secondRel, secondConflictStart);

			await previousChange();
			await expectActiveTab(firstRel);
			await expectCursorAt(firstRel, firstConflictStarts[2]);
		} finally {
			await config.update('mergeEditor', previousMergeEditor, vscode.ConfigurationTarget.Global);
		}
	});

	test('reveal from an out-of-workspace worktree diff adds its root and opens the editable file', async () => {
		const worktreePath = process.env.BGV_REVEAL_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the linked worktree fixture path');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousSetting = config.inspect<boolean>('autoAddWorktreeOnReveal')?.globalValue;
		const changedRelativePath = path.join('committed', 'mod_a.txt');
		const changedPath = path.join(worktreePath, changedRelativePath);
		const changedUri = vscode.Uri.file(changedPath);
		const originalPath = path.join(path.dirname(worktreePath), 'mod_a-original.txt');
		const originalUri = vscode.Uri.file(originalPath);

		try {
			await config.update('autoAddWorktreeOnReveal', true, vscode.ConfigurationTarget.Global);
			fs.copyFileSync(changedPath, originalPath);
			fs.appendFileSync(changedPath, 'revealed from linked worktree\n');

			// Open a real side-by-side diff whose modified side is the worktree file. The built-in git provider
			// cannot serve a git: index URI until its repository is in the workspace — that discovery is exactly
			// what this command is adding — so this file:-backed diff isolates the same TabInputTextDiff resolver.
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				changedUri,
				'mod_a.txt (Linked Worktree)',
				{ preview: false }
			);
			await poll(
				() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'linked-worktree staged diff to become active'
			);
			assert.strictEqual(
				vscode.workspace.getWorkspaceFolder(changedUri),
				undefined,
				'test precondition: linked worktree must start outside Explorer'
			);

			await vscode.commands.executeCommand('better-git-vscode.reveal-current-file-in-explorer');

			await poll(
				() => vscode.workspace.getWorkspaceFolder(changedUri),
				'linked worktree root to be added to the workspace'
			);
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputText && input.uri.path === changedUri.path;
			}, 'reveal command to open the editable linked-worktree file');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
			fs.rmSync(originalPath, { force: true });
			await config.update('autoAddWorktreeOnReveal', previousSetting, vscode.ConfigurationTarget.Global);
		}
	});

	test('reveal leaves an out-of-workspace worktree alone when auto-add is disabled', async () => {
		const worktreePath = process.env.BGV_DISABLED_REVEAL_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the disabled linked-worktree fixture path');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousSetting = config.inspect<boolean>('autoAddWorktreeOnReveal')?.globalValue;
		const changedRelativePath = path.join('committed', 'mod_a.txt');
		const changedPath = path.join(worktreePath, changedRelativePath);
		const changedUri = vscode.Uri.file(changedPath);
		const originalPath = path.join(path.dirname(worktreePath), 'mod_a-disabled-original.txt');
		const originalUri = vscode.Uri.file(originalPath);

		try {
			await config.update('autoAddWorktreeOnReveal', false, vscode.ConfigurationTarget.Global);
			fs.copyFileSync(changedPath, originalPath);
			fs.appendFileSync(changedPath, 'opened without adding linked worktree\n');
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				changedUri,
				'mod_a.txt (Auto-add Disabled)',
				{ preview: false }
			);
			await poll(
				() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'disabled linked-worktree diff to become active'
			);

			await vscode.commands.executeCommand('better-git-vscode.reveal-current-file-in-explorer');

			assert.strictEqual(
				vscode.workspace.getWorkspaceFolder(changedUri),
				undefined,
				'auto-add disabled must leave the worktree outside the workspace'
			);
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputText && input.uri.path === changedUri.path;
			}, 'disabled reveal command to still open the editable linked-worktree file');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
			fs.rmSync(originalPath, { force: true });
			await config.update('autoAddWorktreeOnReveal', previousSetting, vscode.ConfigurationTarget.Global);
		}
	});

	test('SCM row reveal targets the clicked worktree file and adds its root', async () => {
		const worktreePath = process.env.BGV_SCM_REVEAL_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the SCM reveal worktree fixture path');
		const changedPath = path.join(worktreePath, 'committed', 'mod_a.txt');
		const changedUri = vscode.Uri.file(changedPath);
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousSetting = config.inspect<boolean>('autoAddWorktreeOnReveal')?.globalValue;

		try {
			await config.update('autoAddWorktreeOnReveal', true, vscode.ConfigurationTarget.Global);
			fs.appendFileSync(changedPath, 'revealed from the selected SCM row\n');
			const unrelatedEditor = await vscode.window.showTextDocument(wsUri('committed/tall_e.txt'), { preview: false });
			const unrelatedPosition = new vscode.Position(50, 0);
			unrelatedEditor.selection = new vscode.Selection(unrelatedPosition, unrelatedPosition);
			assert.strictEqual(unrelatedEditor.selection.active.line, 50);
			assert.strictEqual(vscode.workspace.getWorkspaceFolder(changedUri), undefined);

			await vscode.commands.executeCommand(
				'better-git-vscode.reveal-current-file-in-explorer',
				{ resourceUri: changedUri }
			);

			await poll(() => vscode.workspace.getWorkspaceFolder(changedUri), 'selected SCM worktree root to be added');
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputText && input.uri.path === changedUri.path;
			}, 'selected SCM file to become the active editable file');
			assert.strictEqual(
				vscode.window.activeTextEditor?.selection.active.line,
				0,
				'unrelated active-editor cursor position must not be copied onto the clicked SCM file'
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
			await config.update('autoAddWorktreeOnReveal', previousSetting, vscode.ConfigurationTarget.Global);
		}
	});

	test('worktree header add keeps every existing workspace folder', async () => {
		const worktreePath = process.env.BGV_HEADER_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the header worktree fixture path');
		const worktreeRoot = vscode.Uri.file(worktreePath);
		const foldersBefore = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
		assert.strictEqual(vscode.workspace.getWorkspaceFolder(worktreeRoot), undefined);

		await vscode.commands.executeCommand(
			'better-git-vscode.add-worktree-to-workspace',
			{ rootUri: worktreeRoot }
		);

		await poll(() => vscode.workspace.getWorkspaceFolder(worktreeRoot), 'clicked worktree root to be added');
		const foldersAfter = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
		for (const existingFolder of foldersBefore) {
			assert.ok(foldersAfter.includes(existingFolder), `existing workspace folder was replaced: ${existingFolder}`);
		}
	});

	test('last-staged badge reopens the staged diff after focus moves to another worktree', async () => {
		const worktreePath = process.env.BGV_LAST_STAGED_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the last-staged linked-worktree fixture path');
		const worktreeRoot = vscode.Uri.file(worktreePath);
		const stagedRelativePath = 'last-staged-new.ts';
		const stagedPath = path.join(worktreePath, stagedRelativePath);
		const stagedUri = vscode.Uri.file(stagedPath);
		const primaryChangeUri = wsUri('committed/mod_a.txt');
		const gitExt = vscode.extensions.getExtension<any>('vscode.git')!;
		const api = gitExt.exports.getAPI(1);

		try {
			await vscode.commands.executeCommand(
				'better-git-vscode.add-worktree-to-workspace',
				{ rootUri: worktreeRoot }
			);
			const worktreeRepo = await poll(
				() => api.getRepository(stagedUri),
				'vscode.git to discover the last-staged worktree'
			);

			fs.writeFileSync(stagedPath, 'export const stagedFromAnotherWorktree = true;\n');
			await worktreeRepo.status();
			await poll(
				() => [...(worktreeRepo.state.workingTreeChanges ?? []), ...(worktreeRepo.state.untrackedChanges ?? [])].some(
					(change: any) => change.uri.path === stagedUri.path
				),
				'linked-worktree file to appear as untracked'
			);
			await vscode.window.showTextDocument(stagedUri, { preview: false });
			await vscode.commands.executeCommand('better-git-vscode.stage-current-file-and-advance');
			await worktreeRepo.status();
			await poll(
				() => (worktreeRepo.state.indexChanges ?? []).some(
					(change: any) => change.uri.path === stagedUri.path
				),
				'linked-worktree file to become staged'
			);

			// Match the live failure: the badge remembers a newly staged file in worktree A, that file then
			// disappears from disk, and the active review context moves to a changed file in worktree B.
			// A raw-file fallback cannot help here; the click must resolve the repository that OWNS the
			// remembered URI and reopen its still-valid empty-tree ↔ index diff.
			fs.rmSync(stagedPath);
			await worktreeRepo.status();
			fs.appendFileSync(primaryChangeUri.fsPath, 'active in the primary worktree\n');
			await refreshUntil(
				() => inWorkingTree('committed/mod_a.txt', 5),
				'primary-worktree change to appear'
			);
			await vscode.commands.executeCommand('git.openChange', primaryChangeUri);
			await expectActiveTab('committed/mod_a.txt');

			await vscode.commands.executeCommand('better-git-vscode.reveal-last-staged-file');

			await poll(
				() => activeTabPath() === stagedUri.path,
				'last-staged badge to reopen the staged file from its owning worktree'
			);
			const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			assert.ok(input instanceof vscode.TabInputTextDiff, 'last-staged badge must open the staged diff');
			assert.strictEqual(
				(input as vscode.TabInputTextDiff).modified.scheme,
				'git',
				'last-staged badge must open the index side, not a raw working file'
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
		}
	});

	test('staged review badge distinguishes both sides of one file and honours badge-off', async () => {
		const rel = 'committed/mod_a.txt';
		const uri = write(rel, lines(40, 'staged badge'));
		git(`add ${rel}`);
		write(rel, lines(40, 'unstaged badge'));
		await refreshUntil(() => inIndex(rel) && inWorkingTree(rel), 'both review sides');
		const before = git('write-tree');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, ''), 'staged badge');
		await extensionApi.whenReviewDecorationSettled();
		assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '🧯');
		await vscode.commands.executeCommand('git.openChange', uri);
		await extensionApi.whenReviewDecorationSettled();
		assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '🔥🔥');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previous = config.inspect<string>('currentFileBadge')?.workspaceValue;
		try {
			await config.update('currentFileBadge', '', vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, ''), 'staged badge');
			await extensionApi.whenReviewDecorationSettled();
			assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), undefined);
		} finally {
			await config.update('currentFileBadge', previous, vscode.ConfigurationTarget.Workspace);
		}
		assert.strictEqual(git('write-tree'), before, 'the badge never changes the index');
	});

	test('stage without advance keeps the reviewed position on its Index side', async () => {
		const rel = 'committed/mod_a.txt';
		const uri = write(rel, lines(200, 'stage in place'));
		await refreshUntil(() => inWorkingTree(rel), 'stage-in-place change');
		const editor = await openWorkingDiffAt(rel, 75);
		editor.selection = new vscode.Selection(80, 2, 82, 5);
		const selections = editor.selections;
		const top = editor.visibleRanges[0].start.line;
		const before = git('write-tree');
		await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
		await extensionApi.whenReviewDecorationSettled();
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		assert.ok(input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'git');
		assert.strictEqual(activeTabPath(), uri.path);
		const stagedEditor = visibleEditorFor(input.modified)!;
		assert.deepStrictEqual(stagedEditor.selections, selections, 'staging in place keeps the selection');
		assert.strictEqual(stagedEditor.visibleRanges[0].start.line, top, 'staging in place keeps the viewport');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '🧯');
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('write-tree'), before, 'one Undo restores the exact prior index');
	});

	test('stage-hold readiness changes only the badge, clears by source and cancels on review switch', async () => {
		if (process.env.BGV_PLACE_ON_MACBOOK === '1') {
			const pid = process.env.VSCODE_PID!;
			const title = path.basename(vscode.workspace.workspaceFile!.fsPath, '.code-workspace');
			execFileSync('swift', [path.resolve(__dirname, '../../../scripts/place-vscode-window-on-macbook.swift'), pid, title, '--focus'], { timeout: 20000 });
		}
		await poll(() => vscode.window.state.focused, 'isolated window focus required for readiness');
		const a = write('committed/mod_a.txt', lines(40, 'ready A'));
		const b = write('committed/mod_d.txt', lines(10, 'ready B'));
		await refreshUntil(() => inWorkingTree('committed/mod_a.txt') && inWorkingTree('committed/mod_d.txt'), 'two ready-cue fixture changes');
		await vscode.commands.executeCommand('git.openChange', a);
		await poll(() => extensionApi.getCurrentReviewUri() === a.toString(), 'ready fixture decoration');
		await extensionApi.whenReviewDecorationSettled();
		const before = git('diff --cached --binary');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(a), '🔥🔥');
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'unknown');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(a), '🔥🔥');
		for (const source of ['corsair', 'razer']) {
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
			assert.strictEqual(extensionApi.getReviewDecorationBadge(a), '💥💥');
		}
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(a), '💥💥', 'the other held mouse still owns readiness');
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'razer');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(a), '🔥🔥');
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
		await vscode.commands.executeCommand('git.openChange', b);
		await poll(() => extensionApi.getCurrentReviewUri() === b.toString(), 'review switch cancels readiness');
		await extensionApi.whenReviewDecorationSettled();
		assert.strictEqual(extensionApi.getReviewDecorationBadge(b), '🔥🔥');
		assert.strictEqual(extensionApi.getReviewDecorationBadge(a), undefined);
		assert.strictEqual(git('diff --cached --binary'), before, 'readiness never stages or unstages');
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
		await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
		assert.ok(inIndex('committed/mod_d.txt'));
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await extensionApi.whenReviewDecorationSettled();
		assert.strictEqual(git('diff --cached --binary'), before);
		assert.notStrictEqual(extensionApi.getReviewDecorationBadge(b), '💥💥');
	});

	test('staged LFS image preview uses exact local index bytes without changing Git state', async () => {
		const rel = 'staged-lfs-preview.png';
		const stagedBytes = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'
		);
		const otherBytes = Buffer.from(stagedBytes);
		otherBytes[otherBytes.length - 1] ^= 1;
		const oid = createHash('sha256').update(stagedBytes).digest('hex');
		const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${stagedBytes.length}\n`;
		const mediaDir = /^LocalMediaDir=(.+)$/m.exec(git('lfs env'))?.[1];
		assert.ok(mediaDir, 'Git LFS must expose local media storage in the Mini fixture');
		const object = path.join(mediaDir!, oid.slice(0, 2), oid.slice(2, 4), oid);
		const uri = write(rel, pointer);
		fs.mkdirSync(path.dirname(object), { recursive: true });
		fs.writeFileSync(object, stagedBytes);
		try {
			git(`add -- ${rel}`);
			fs.writeFileSync(uri.fsPath, otherBytes); // working copy differs; preview must still use the index image
			await refreshUntil(() => inIndex(rel) && inWorkingTree(rel), 'staged and working image versions');
			const indexUri = toGitUri(uri, '');
			const resolved = await resolveStagedLfsImage(indexUri, ws);
			assert.strictEqual(resolved.scheme, 'better-git-staged-image');
			assert.deepStrictEqual(Buffer.from(await vscode.workspace.fs.readFile(resolved)), stagedBytes);
			const before = git('status --porcelain=v1');
			await vscode.commands.executeCommand('better-git-vscode.next-changed-file');
			await poll(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes(rel), 'staged image review tab');
			assert.strictEqual(git('status --porcelain=v1'), before, 'preview does not stage, unstage, or edit the image');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await vscode.commands.executeCommand('vscode.openWith', indexUri, 'imagePreview.previewEditor', { preview: true });
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputCustom && input.uri.scheme === 'better-git-staged-image';
			}, 'native staged-image click to show the local image');
			assert.strictEqual(git('status --porcelain=v1'), before, 'native preview does not alter Git state');
			await sleep(300); // let VS Code's image webview finish reading before deleting its fixture object
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(object);
			assert.strictEqual((await resolveStagedLfsImage(indexUri, ws)).scheme, 'git', 'missing local object retains native fallback');
		} finally {
			fs.rmSync(object, { force: true });
		}
	});

	for (const view of ['single preview', 'comparison']) {
		test(`home-labeled deleted image ${view} receives fire, stages and advances, and one Undo restores its index`, async () => {
			const rel = 'committed/image.png';
			const uri = wsUri(rel);
			const peer = 'committed/zz_deleted_image_peer.txt';
			fs.rmSync(uri.fsPath);
			write(peer, 'still needs review');
			await refreshUntil(() => inWorkingTree(rel, 6) && isUntracked(peer), 'home deleted-image fixture');
			const before = git('write-tree');
			if (view === 'comparison') {
				// Some media comparisons expose no public Tab input. Match that deleted-image view too;
				// a tiny valid PNG opened as a single preview already passed before the home-path fix.
				await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, '~'), toGitUri(uri, EMPTY_TREE), 'deleted image comparison');
			} else {
				await vscode.commands.executeCommand('git.openChange', uri);
			}
			await poll(() => extensionApi.getCurrentReviewUri() === uri.toString(), 'home deleted image fire target');
			await extensionApi.whenReviewDecorationSettled();
			assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '🔥🔥');
			await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
			await expectActiveTab(peer);
			assert.strictEqual(git(`ls-files -- ${rel}`), '', 'the deletion was staged');
			assert.strictEqual(badge(peer), '🔥🔥', 'fire advances to the next unstaged file');
			assert.ok(!fs.existsSync(uri.fsPath), 'staging never recreates the deleted working image');
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('write-tree'), before, 'one Undo restores the exact index');
			assert.ok(!fs.existsSync(uri.fsPath), 'Undo never recreates the deleted working image');
			await sleep(300); // The restored media preview loads asynchronously before fixture teardown.
		});
	}

	test('current-review badges distinguish image Git states and rapid tab switches', async () => {
		const imageB = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
			'base64'
		);
		const trackedRel = 'committed/image.png';
		const trackedUri = wsUri(trackedRel);
		const expectFireBadge = async (uri: vscode.Uri, label: string, staged = false) => {
			await poll(
				() => extensionApi.getCurrentReviewUri() === uri.toString(),
				`${label} to become the current review decoration URI (was ${extensionApi.getCurrentReviewUri()})`
			);
			await extensionApi.whenReviewDecorationSettled();
			assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), staged ? '🧯' : '🔥🔥', `${label} must render its review-side badge`);
			// The media-preview/notebook extensions finish rendering after their open command resolves. Let that
			// renderer settle before the next matrix case closes/replaces its editor; otherwise VS Code 1.135 can
			// emit an unrelated rejected "Webview is disposed" promise that contaminates later shared-host tests.
			if (['.png', '.ipynb'].includes(path.extname(uri.fsPath).toLowerCase())) {
				await sleep(300);
			}
		};
		const resetImageFixture = async () => {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			git(`reset --hard ${baseSha}`);
			git('clean -fdq');
			await refreshUntil(
				() =>
					(repo.state.workingTreeChanges ?? []).length === 0 &&
					(repo.state.indexChanges ?? []).length === 0 &&
					(repo.state.untrackedChanges ?? []).length === 0,
				'clean image fixture state'
			);
		};

		const clipboardBefore = await vscode.env.clipboard.readText();
		const clipboardGuard = 'BETTER_GIT_IMAGE_BADGE_CLIPBOARD_GUARD';
		try {
			// Modified tracked image: VS Code 1.135 exposes this comparison with no public Tab input/resource.
			// The workbench-path fallback must resolve it without changing Ethan's clipboard.
			await vscode.env.clipboard.writeText(clipboardGuard);
			fs.writeFileSync(trackedUri.fsPath, imageB);
			await refreshUntil(() => inWorkingTree(trackedRel, 5), 'modified image to appear in working tree');
			await vscode.commands.executeCommand('git.openChange', trackedUri);
			await expectFireBadge(trackedUri, 'modified image');
			assert.ok(await vscode.env.clipboard.readText() === clipboardGuard,
				'Clipboard changed during the image test; check for concurrent user input before attributing it to the extension');

			// Staged modification.
			git(`add ${trackedRel}`);
			await refreshUntil(() => inIndex(trackedRel, 0), 'staged modified image to appear in index');
			await vscode.commands.executeCommand(
				'vscode.diff',
				toGitUri(trackedUri, 'HEAD'),
				toGitUri(trackedUri, ''),
				'image.png (Index)'
			);
			await expectFireBadge(trackedUri, 'staged modified image', true);

			// Notebook diffs are another non-TextEditor review surface with their own public tab input type.
			await resetImageFixture();
			const notebookRel = 'committed/notebook.ipynb';
			const notebookUri = wsUri(notebookRel);
			fs.writeFileSync(
				notebookUri.fsPath,
				JSON.stringify({
					cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ["print('changed')\n"] }],
					metadata: {},
					nbformat: 4,
					nbformat_minor: 2,
				})
			);
			await refreshUntil(() => inWorkingTree(notebookRel, 5), 'modified notebook to appear in working tree');
			await vscode.commands.executeCommand('git.openChange', notebookUri);
			await expectFireBadge(notebookUri, 'modified notebook');
			git(`add ${notebookRel}`);
			await refreshUntil(() => inIndex(notebookRel, 0), 'staged notebook to appear in index');
			await vscode.commands.executeCommand('vscode.diff', toGitUri(notebookUri, 'HEAD'), toGitUri(notebookUri, ''), 'notebook.ipynb (Index)');
			await expectFireBadge(notebookUri, 'staged notebook', true);

			// Untracked and staged-new images.
			await resetImageFixture();
			const addedRel = 'committed/added-image.png';
			const addedUri = wsUri(addedRel);
			fs.writeFileSync(addedUri.fsPath, imageB);
			await refreshUntil(() => isUntracked(addedRel), 'untracked image to appear');
			await vscode.commands.executeCommand('git.openChange', addedUri);
			await expectFireBadge(addedUri, 'untracked image');
			git(`add ${addedRel}`);
			await refreshUntil(() => inIndex(addedRel, 1), 'staged-new image to appear in index');
			await vscode.commands.executeCommand(
				'vscode.diff',
				toGitUri(addedUri, EMPTY_TREE),
				toGitUri(addedUri, ''),
				'added-image.png (Index)'
			);
			await expectFireBadge(addedUri, 'staged-new image', true);

			// Unstaged and staged deletion images.
			await resetImageFixture();
			fs.rmSync(trackedUri.fsPath);
			await refreshUntil(() => inWorkingTree(trackedRel, 6), 'deleted image to appear in working tree');
			await vscode.commands.executeCommand('git.openChange', trackedUri);
			await expectFireBadge(trackedUri, 'deleted image');
			git(`add ${trackedRel}`);
			await refreshUntil(() => inIndex(trackedRel, 2), 'staged-deleted image to appear in index');
			await vscode.commands.executeCommand(
				'vscode.diff',
				toGitUri(trackedUri, 'HEAD'),
				toGitUri(trackedUri, EMPTY_TREE),
				'image.png (Index)'
			);
			await expectFireBadge(trackedUri, 'staged-deleted image', true);

			// Staged rename: decorate the new/current path, not the old HEAD path.
			await resetImageFixture();
			const renamedRel = 'committed/renamed-image.png';
			const renamedUri = wsUri(renamedRel);
			git(`mv ${trackedRel} ${renamedRel}`);
			await refreshUntil(() => inIndex(renamedRel, 3), 'renamed image to appear in index');
			await vscode.commands.executeCommand(
				'vscode.diff',
				toGitUri(trackedUri, 'HEAD'),
				toGitUri(renamedUri, ''),
				'renamed-image.png (Index)'
			);
			await expectFireBadge(renamedUri, 'renamed image', true);
			assert.strictEqual(extensionApi.getReviewDecorationBadge(trackedUri), undefined);

			// A rapid image -> text switch must leave the badge on the final active tab. This guards the async
			// clipboard fallback from applying a stale image result after a newer text-editor event.
			await resetImageFixture();
			fs.writeFileSync(trackedUri.fsPath, imageB);
			const textRel = 'committed/mod_a.txt';
			const textUri = wsUri(textRel);
			const textLines = lines(40, 'mod_a').split('\n');
			textLines[4] = 'modified text after image';
			write(textRel, textLines.join('\n'));
			await refreshUntil(
				() => inWorkingTree(trackedRel, 5) && inWorkingTree(textRel, 5),
				'image and text changes to appear'
			);
			// Pre-render and pin both editors so the race exercise switches active tabs without disposing an
			// in-flight media webview. The final pair remains intentionally back-to-back: the image's async path
			// lookup must not win after the text diff becomes active.
			await vscode.commands.executeCommand('git.openChange', trackedUri);
			await expectFireBadge(trackedUri, 'pre-rendered image before rapid switch');
			await vscode.commands.executeCommand('workbench.action.keepEditor');
			await vscode.commands.executeCommand('git.openChange', textUri);
			await expectFireBadge(textUri, 'pre-rendered text before rapid switch');
			await vscode.commands.executeCommand('workbench.action.keepEditor');
			await vscode.commands.executeCommand('git.openChange', trackedUri);
			await vscode.commands.executeCommand('git.openChange', textUri);
			await expectFireBadge(textUri, 'text diff after rapid image switch');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(trackedUri), undefined);
		} finally {
			// The host shares the system clipboard with Ethan. Never restore our
			// older saved value over something he copied during this test.
			if (await vscode.env.clipboard.readText() === clipboardGuard) {
				await vscode.env.clipboard.writeText(clipboardBefore);
			}
		}
	});

	test('untracked new file: rapid repeated next presses are serialized and none are lost', async () => {
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		await openPlainAt('zz_new.txt', 0);

		// Do not wait between presses: this is key-repeat / a quick double-tap. Before the shared navigation
		// queue both calls could read viewport top=0 and target L6, losing the second press.
		const editor = visibleEditorFor(wsUri('zz_new.txt'))!;
		const tops = await viewportTopsDuring(editor, () => Promise.all([nextChange(), nextChange(), nextChange()]));
		await expectCursorVisibleAt('zz_new.txt', 15);
		assertViewportMonotonic(tops, 'down', 'rapid untracked next');
		assert.ok(editor.visibleRanges[0].start.line > 0, 'rapid next presses never advanced the viewport');
	});

	test('untracked new file: manual scrolling makes the next step resume from the viewport', async () => {
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		const editor = await openPlainAt('zz_new.txt', 0);
		await nextChange();
		await expectCursorAt('zz_new.txt', 5);

		const far = new vscode.Position(100, 0);
		editor.revealRange(new vscode.Range(far, far), vscode.TextEditorRevealType.AtTop);
		await poll(() => editor.visibleRanges[0]?.start.line > 60 && !lineIsVisible(editor, 5),
			'manual scroll to move beyond the old caret');
		const forwardTop = editor.visibleRanges[0].start.line;
		await nextChange();
		await expectCursorAt('zz_new.txt', forwardTop + 4);

		const back = new vscode.Position(35, 0);
		editor.revealRange(new vscode.Range(back, back), vscode.TextEditorRevealType.AtTop);
		await poll(() => editor.visibleRanges[0]?.start.line < 60 && !lineIsVisible(editor, forwardTop + 4),
			'manual scroll to move above the new caret');
		const backwardBottom = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
		await previousChange();
		await expectCursorAt('zz_new.txt', backwardBottom - 4);
	});

	test('untracked new file: a small manual scroll wins even while the old caret stays visible', async () => {
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		const editor = await openPlainAt('zz_new.txt', 0);
		const visible = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
		assert.ok(visible >= 18, 'fixture needs room to scroll without hiding the caret');
		const oldCaret = Math.floor(visible / 2);
		const oldPosition = new vscode.Position(oldCaret, 0);
		editor.selection = new vscode.Selection(oldPosition, oldPosition);
		const scrollTo = new vscode.Position(Math.floor(visible / 3), 0);
		editor.revealRange(new vscode.Range(scrollTo, scrollTo), vscode.TextEditorRevealType.AtTop);
		await poll(() => editor.visibleRanges[0]?.start.line > 0 && lineIsVisible(editor, oldCaret),
			'viewport to move while its old caret stays visible');
		const top = editor.visibleRanges[0].start.line;
		assert.strictEqual(editor.selection.active.line, oldCaret, 'scrolling must not change selection by itself');
		assert.notStrictEqual(top + 4, oldCaret + 5, 'fixture must distinguish viewport from caret anchoring');
		await nextChange();
		await expectCursorAt('zz_new.txt', top + 4);
	});

	test('untracked wrapped file: SCM-focused next/previous remain exact five-line steps', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousStickyScroll = editorConfig.inspect<boolean>('stickyScroll.enabled')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', true, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_new.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_new.ts'), 'zz_wrapped_new.ts to appear as untracked');
			await openPlainAt('zz_wrapped_new.ts', 0);

			// This is Ethan's exact path: the SCM tree owns keyboard focus while the active plain editor is the
			// untracked file. v1.2.22 used visibleRanges.top as both success criterion and cursor fallback; wrapped
			// and sticky layouts can report that top a few logical lines away, producing +7/-3 drift or a repeat.
			await vscode.commands.executeCommand('workbench.view.scm');
			await nextChange();
			await expectCursorAt('zz_wrapped_new.ts', 5);
			await nextChange();
			await expectCursorAt('zz_wrapped_new.ts', 10);
			await previousChange();
			await expectCursorAt('zz_wrapped_new.ts', 5);
			await previousChange();
			await expectCursorAt('zz_wrapped_new.ts', 0);
			assert.strictEqual(activeTabPath(), wsUri('zz_wrapped_new.ts').path);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', previousStickyScroll, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: rapid queued next and direction reversals lose no steps', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousStickyScroll = editorConfig.inspect<boolean>('stickyScroll.enabled')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', true, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_rapid.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_rapid.ts'), 'zz_wrapped_rapid.ts to appear as untracked');
			await openPlainAt('zz_wrapped_rapid.ts', 0);
			await vscode.commands.executeCommand('workbench.view.scm');

			await Promise.all([nextChange(), nextChange(), nextChange(), nextChange()]);
			const afterRapidNext = await expectCursorAt('zz_wrapped_rapid.ts', 20);
			assert.ok(afterRapidNext.visibleRanges[0].start.line > 0, 'rapid wrapped stepping did not move the viewport');

			// Queue order: 20 -> 15 -> 20 -> 15 -> 10 -> 15. This catches stale viewport reads in either direction.
			await Promise.all([previousChange(), nextChange(), previousChange(), previousChange(), nextChange()]);
			await expectCursorAt('zz_wrapped_rapid.ts', 15);
			assert.strictEqual(activeTabPath(), wsUri('zz_wrapped_rapid.ts').path);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', previousStickyScroll, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: editor/SCM focus switches preserve one shared five-line sequence', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			write('zz_wrapped_focus.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_focus.ts'), 'zz_wrapped_focus.ts to appear as untracked');
			await openPlainAt('zz_wrapped_focus.ts', 0);

			await nextChange(); // editor focused
			await expectCursorAt('zz_wrapped_focus.ts', 5);
			await vscode.commands.executeCommand('workbench.view.scm');
			await nextChange(); // SCM focused
			await expectCursorAt('zz_wrapped_focus.ts', 10);
			await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			await previousChange(); // editor focused again
			await expectCursorAt('zz_wrapped_focus.ts', 5);
			await vscode.commands.executeCommand('workbench.view.scm');
			await previousChange(); // SCM focused again
			await expectCursorAt('zz_wrapped_focus.ts', 0);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: custom jump remains exact with SCM focus and rapid presses', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousJump = navConfig.inspect<number>('newFileNavLineJump')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await navConfig.update('newFileNavLineJump', 7, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_custom.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_custom.ts'), 'zz_wrapped_custom.ts to appear as untracked');
			await openPlainAt('zz_wrapped_custom.ts', 0);
			await vscode.commands.executeCommand('workbench.view.scm');

			await Promise.all([nextChange(), nextChange(), nextChange()]);
			await expectCursorAt('zz_wrapped_custom.ts', 21);
			await previousChange();
			await expectCursorAt('zz_wrapped_custom.ts', 14);
		} finally {
			await navConfig.update('newFileNavLineJump', previousJump, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('newFileNavLineJump custom value is respected', async () => {
		const cfg = () => vscode.workspace.getConfiguration('better-git-vscode');
		await cfg().update('newFileNavLineJump', 7, vscode.ConfigurationTarget.Global);
		try {
			await poll(() => cfg().get<number>('newFileNavLineJump') === 7, 'custom new-file jump setting to become visible');
			write('zz_new.txt', lines(240, 'new'));
			await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
			await openPlainAt('zz_new.txt', 0);
			await expectActiveTab('zz_new.txt');
			await expectCursorAt('zz_new.txt', 0);

			await nextChange();
			const editor = await expectCursorVisibleAt('zz_new.txt', 7);
			assert.ok(editor.visibleRanges[0].start.line >= 0, 'custom jump produced an invalid viewport');
		} finally {
			// always restore, even on assertion failure — a leaked setting would skew later tests
			await cfg().update('newFileNavLineJump', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked file at bottom edge: next falls through to the next FILE', async () => {
		write('aa_new.txt', lines(10, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		const editor = await openPlainAt('aa_new.txt', 0);
		// park the cursor on the LAST line -> next press is at the edge
		const last = editor.document.lineCount - 1;
		editor.selection = new vscode.Selection(new vscode.Position(last, 0), new vscode.Position(last, 0));

		await nextChange();
		await expectActiveTab('ab_next.txt'); // sorted after aa_new.txt, so it's the "next file"
	});

	test('untracked file at top edge: previous falls through to the previous FILE', async () => {
		write('aa_new.txt', lines(10, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		await openPlainAt('ab_next.txt', 0); // cursor at very top -> previous is at the edge

		await previousChange();
		await expectActiveTab('aa_new.txt');
	});

	test('very short new file already fully visible: final partial step lands at EOF before rollover', async () => {
		write('aa_short.txt', lines(3, 's')); // 3 lines, no trailing newline -> last line index 2
		write('ab_other.txt', lines(5, 'o'));
		await refreshUntil(() => isUntracked('aa_short.txt') && isUntracked('ab_other.txt'), 'both untracked files listed');
		await openPlainAt('aa_short.txt', 0);

		await nextChange();
		await expectCursorAt('aa_short.txt', 2); // consume the remaining two-line step and visibly park at EOF
		assert.strictEqual(activeTabPath(), wsUri('aa_short.txt').path, 'final partial step skipped straight to the next file');

		await nextChange(); // only the following press may roll over
		await expectActiveTab('ab_other.txt');
	});

	test('untracked file with EOF already visible: next still lands at EOF before rollover', async () => {
		write('aa_new.txt', lines(60, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		const editor = await openPlainAt('aa_new.txt', 0);
		const last = editor.document.lineCount - 1;
		const nearEnd = last - 3; // fewer than the configured five lines remain
		const pos = new vscode.Position(nearEnd, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
		await poll(
			() => editor.visibleRanges[editor.visibleRanges.length - 1]?.end.line === last,
			'EOF to be visible while caret remains above it'
		);

		await nextChange();
		await expectCursorAt('aa_new.txt', last);
		assert.strictEqual(activeTabPath(), wsUri('aa_new.txt').path, 'visible EOF caused premature file rollover');

		await nextChange();
		await expectActiveTab('ab_next.txt');
	});

	test('untracked file with start already visible: previous steps to line 1 before rollover', async () => {
		write('aa_previous.txt', lines(5, 'a'));
		write('ab_current.txt', lines(12, 'b'));
		await refreshUntil(
			() => isUntracked('aa_previous.txt') && isUntracked('ab_current.txt'),
			'both untracked files listed'
		);
		const editor = await openPlainAt('ab_current.txt', 0); // the whole file fits, so line 1 is already visible
		const last = editor.document.lineCount - 1;
		const pos = new vscode.Position(last, 0);
		editor.selection = new vscode.Selection(pos, pos);
		const topBefore = editor.visibleRanges[0].start.line;

		const firstUp = await viewportTopsDuring(editor, previousChange);
		await expectCursorAt('ab_current.txt', 6);
		assertViewportMonotonic(firstUp, 'up', 'visible-start previous L12->L7');
		const secondUp = await viewportTopsDuring(editor, previousChange);
		await expectCursorAt('ab_current.txt', 1);
		assertViewportMonotonic(secondUp, 'up', 'visible-start previous L7->L2');
		const finalUp = await viewportTopsDuring(editor, previousChange);
		await expectCursorAt('ab_current.txt', 0); // final one-line partial step
		assertViewportMonotonic(finalUp, 'up', 'visible-start final previous step');
		assert.ok(
			editor.visibleRanges[0].start.line <= topBefore,
			'Previous moved the viewport downward even though every target was already visible above the caret'
		);
		assert.strictEqual(activeTabPath(), wsUri('ab_current.txt').path, 'visible file start caused premature rollover');

		await previousChange();
		await expectActiveTab('aa_previous.txt');
	});

	test('untracked EOF direction reversal continues from the current caret', async () => {
		write('zz_reverse.txt', lines(13, 'r'));
		await refreshUntil(() => isUntracked('zz_reverse.txt'), 'zz_reverse.txt to appear as untracked');
		const editor = await openPlainAt('zz_reverse.txt', 0);
		const pos = new vscode.Position(10, 0);
		editor.selection = new vscode.Selection(pos, pos);

		await nextChange();
		await expectCursorAt('zz_reverse.txt', 12); // final +2 lands at EOF
		await previousChange();
		await expectCursorAt('zz_reverse.txt', 7); // reverse from EOF, never jump to another file/bottom
		await nextChange();
		await expectCursorAt('zz_reverse.txt', 12);
		assert.strictEqual(activeTabPath(), wsUri('zz_reverse.txt').path);
	});

	test('untracked wrapped EOF: rapid final-step plus rollover waits until EOF is presented', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			write(
				'aa_wrapped_boundary.ts',
				Array.from({ length: 40 }, (_, i) => `const wrappedBoundary${i} = '${'very-long-content-'.repeat(120)}';`).join('\n')
			);
			write('ab_next.txt', lines(5, 'b'));
			await refreshUntil(
				() => isUntracked('aa_wrapped_boundary.ts') && isUntracked('ab_next.txt'),
				'both untracked files listed'
			);
			const editor = await openPlainAt('aa_wrapped_boundary.ts', 0);
			const last = editor.document.lineCount - 1;
			const nearEnd = last - 3;
			const pos = new vscode.Position(nearEnd, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
			await poll(
				() =>
					editor.visibleRanges.some((range) => nearEnd >= range.start.line && nearEnd <= range.end.line) &&
					!editor.visibleRanges.some((range) => last >= range.start.line && last <= range.end.line),
				'near-EOF caret visible while the heavily wrapped EOF remains off-screen'
			);
			await vscode.commands.executeCommand('workbench.view.scm');
			const eofEnd = editor.document.lineAt(last).range.end;
			let wrappedEofEndBecameVisible = positionIsVisible(editor, eofEnd);
			const visibleSub = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
				if (event.textEditor === editor && positionIsVisible(editor, eofEnd)) {
					wrappedEofEndBecameVisible = true;
				}
			});

			// First queued press must render/pin EOF; only the second may roll over. Without awaiting the bottom
			// reveal, the second press can see stale visibleRanges and consume an unintended extra edge-reveal step.
			// Checking the end position (not only the logical line number) proves the final wrapped segment was shown.
			try {
				await Promise.all([nextChange(), nextChange()]);
			} finally {
				visibleSub.dispose();
			}
			await expectActiveTab('ab_next.txt');
			assert.ok(wrappedEofEndBecameVisible, 'rolled over before the final visual segment of wrapped EOF appeared');
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('empty new file: next advances to the next file immediately', async () => {
		write('aa_empty.txt', '');
		write('ab_other.txt', lines(5, 'o'));
		await refreshUntil(() => isUntracked('aa_empty.txt') && isUntracked('ab_other.txt'), 'both untracked files listed');
		await openPlainAt('aa_empty.txt', 0); // an empty doc has exactly 1 line -> cursor already at the edge

		await nextChange();
		await expectActiveTab('ab_other.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// MODIFIED FILE — THE v1.2.0 REGRESSION GUARD
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('MODIFIED file: manual scrolling re-anchors both hunk directions without changing files', async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		for (const line of [10, 100, 200]) {
			content[line] = `tall_e manually scrolled edit ${line}`;
		}
		write(rel, content.join('\n'));
		await refreshUntil(() => inWorkingTree(rel, 5), 'manual-scroll hunks to appear as modified');
		const editor = await openWorkingDiffAt(rel, 0);
		await nextChange();
		await expectCursorAt(rel, 10);

		const lower = new vscode.Position(90, 0);
		editor.revealRange(new vscode.Range(lower, lower), vscode.TextEditorRevealType.AtTop);
		await poll(() => editor.visibleRanges[0]?.start.line > 50 && !lineIsVisible(editor, 10),
			'modified diff to scroll well below its old caret');
		await nextChange();
		await expectCursorAt(rel, 100);

		const upper = new vscode.Position(0, 0);
		editor.revealRange(new vscode.Range(upper, upper), vscode.TextEditorRevealType.AtTop);
		await poll(() => editor.visibleRanges[0]?.start.line < 5 && !lineIsVisible(editor, 100),
			'modified diff to scroll well above its old caret');
		await previousChange();
		await expectCursorAt(rel, 10);
		assert.strictEqual(activeTabPath(), wsUri(rel).path);
	});

	test('MODIFIED file: next/previous do HUNK navigation, never the 5-line step', async () => {
		// Two well-separated edits -> hunks starting at 0-based lines 4 and 24. The first spans three lines so
		// the overview-ruler assertion proves the marker covers the hunk rather than only the caret line.
		const content = lines(40, 'mod_a').split('\n');
		content[4] = 'mod_a line 5 EDITED';
		content[5] = 'mod_a line 6 EDITED';
		content[6] = 'mod_a line 7 EDITED';
		content[24] = 'mod_a line 25 EDITED';
		write('committed/mod_a.txt', content.join('\n') + '\n');
		// A second modified file so the run-out-of-hunks fall-through has a deterministic landing target.
		const d = lines(10, 'mod_d').split('\n');
		d[3] = 'mod_d line 4 EDITED';
		write('committed/mod_d.txt', d.join('\n') + '\n');
		await refreshUntil(
			() => inWorkingTree('committed/mod_a.txt', 5 /* MODIFIED */) && inWorkingTree('committed/mod_d.txt', 5),
			'both files to appear as MODIFIED'
		);

		// Open the working-tree diff exactly like clicking the SCM row.
		await vscode.commands.executeCommand('git.openChange', wsUri('committed/mod_a.txt'));
		// Wait for the side-by-side diff to actually render: both sides visible (the original side is a
		// git:-scheme editor). Pressing next before the diff model is ready would race hunk detection.
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('committed/mod_a.txt')) !== undefined &&
				vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'git' && uriFilePath(e.document.uri) === wsUri('committed/mod_a.txt').path),
			'mod_a diff editor to render both sides'
		);
		await sleep(500); // small grace period for the diff computation itself
		const modifiedSide = visibleEditorFor(wsUri('committed/mod_a.txt'))!;
		modifiedSide.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		// From line 0 the next HUNK starts at line 4. If the v1.2.0 bug regressed, the cursor would land
		// on line 5 (0 + jump) instead — assert both the hunk line and explicitly not-the-step line.
		await nextChange();
		const afterFirst = await expectCursorAt('committed/mod_a.txt', 4);
		assert.notStrictEqual(afterFirst.selection.active.line, 5, 'cursor moved by the 5-line step on a MODIFIED file — v1.2.0 regression is back');
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri('committed/mod_a.txt').toString(), start: 4, end: 6 },
			'the overview ruler must identify the exact first hunk Better Git selected'
		);

		// Second hunk: line 24 (a 5-line step from 4 would be 9).
		await nextChange();
		await expectCursorAt('committed/mod_a.txt', 24);
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri('committed/mod_a.txt').toString(), start: 24, end: 24 },
			'the overview-ruler marker must move with the next selected hunk'
		);
		// Previous goes BACK to the first hunk (a 5-line step back from 24 would be 19).
		await previousChange();
		await expectCursorAt('committed/mod_a.txt', 4);
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri('committed/mod_a.txt').toString(), start: 4, end: 6 },
			'the overview-ruler marker must follow reverse navigation too'
		);

		// Run past the last hunk -> falls through to the next changed FILE (mod_d), as always.
		await nextChange(); // back to 24
		await expectCursorAt('committed/mod_a.txt', 24);
		await nextChange(); // out of hunks
		await expectActiveTab('committed/mod_d.txt');
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri('committed/mod_d.txt').toString(), start: 3, end: 3 },
			'the marker must follow cross-file navigation without repainting the old editor'
		);

		await vscode.window.showTextDocument(wsUri('committed/tall_e.txt'), { preview: true });
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.strictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			undefined,
			'leaving a diff review must clear the marker'
		);
	});

	// ── Cross-file landing hands the next press a real review position (Ethan 2026-11-02) ──────────────────────
	// Ethan: "when it jumps to a new file on the next change, and I do the next change again, it stays on the same
	// one". Each case commits fresh file names inside the test (setup's reset removes them), so VS Code has no
	// remembered diff view state and performs its native first-change landing exactly as on a first visit.
	const commitLandingFixtures = (files: Record<string, number>, prefix: string) => {
		for (const [rel, count] of Object.entries(files)) { write(rel, lines(count, rel) + '\n'); }
		git(`add ${Object.keys(files).join(' ')}`);
		git(`commit -m "${prefix} landing fixture"`);
	};
	const editLines = (rel: string, count: number, edited: number[]) => {
		const content = lines(count, rel).split('\n');
		for (const line of edited) { content[line] = `${rel} EDITED line ${line + 1}`; }
		write(rel, content.join('\n') + '\n');
	};

	test('cross-file Next landing: the following Next reaches the second change and a later scroll still wins', async () => {
		const from = 'landing_next_a.txt', to = 'landing_next_b.txt';
		commitLandingFixtures({ [from]: 40, [to]: 260 }, 'next');
		editLines(from, 40, [4]);
		// The native landing must scroll to line 120, so a landing event arriving after Better Git adopted the
		// position would surface here as a "manual" scroll. The second change is never on screen with the first.
		editLines(to, 260, [120, 220]);
		await refreshUntil(() => inWorkingTree(from, 5) && inWorkingTree(to, 5), 'Next landing files to appear as modified');

		await openWorkingDiffAt(from, 0);
		await nextChange();
		await expectCursorAt(from, 4);
		await vscode.commands.executeCommand('workbench.view.scm'); // Ethan's usual focus; navigation stays tab-owned
		await nextChange();
		await expectActiveTab(to);
		const landed = await expectCursorVisibleAt(to, 120); // native first-change landing itself is unchanged

		// The regression re-anchored above the viewport and native Next selected line 120 again.
		await nextChange();
		await expectCursorAt(to, 220);
		assert.strictEqual(activeTabPath(), wsUri(to).path, 'the press after landing must stay in the landed file');

		// An independent scroll after a landing still owns the next press: below every change, Next leaves the file.
		const below = new vscode.Position(245, 0);
		landed.revealRange(new vscode.Range(below, below), vscode.TextEditorRevealType.AtTop);
		await poll(() => landed.visibleRanges[0]?.start.line > 225 && !lineIsVisible(landed, 220),
			'manual scroll below the landed file\'s last change');
		await nextChange();
		await expectActiveTab(from);
	});

	test('cross-file Next landing: an immediate Previous returns to the previous file instead of moving down', async () => {
		const from = 'landing_reverse_a.txt', to = 'landing_reverse_b.txt';
		commitLandingFixtures({ [from]: 40, [to]: 40 }, 'reverse');
		editLines(from, 40, [4]);
		editLines(to, 40, [4, 12]); // both changes fit on screen after the native landing
		await refreshUntil(() => inWorkingTree(from, 5) && inWorkingTree(to, 5), 'reversal landing files to appear as modified');

		await openWorkingDiffAt(from, 0);
		await nextChange();
		await expectCursorAt(from, 4);
		await nextChange();
		await expectActiveTab(to);
		await expectCursorVisibleAt(to, 4);

		// Viewport anchoring after the landing selected the visible later change (line 12) on Previous.
		await previousChange();
		await expectActiveTab(from);
		await expectCursorVisibleAt(from, 4);
	});

	test('cross-file Previous landing and its revisit continue from the landed change instead of re-selecting it', async () => {
		const first = 'landing_prev_a.txt', second = 'landing_prev_b.txt';
		commitLandingFixtures({ [first]: 40, [second]: 260 }, 'previous');
		editLines(first, 40, [4, 24]);
		editLines(second, 260, [120, 220]);
		await refreshUntil(() => inWorkingTree(first, 5) && inWorkingTree(second, 5), 'Previous landing files to appear as modified');

		await openWorkingDiffAt(second, 0);
		await nextChange();
		await expectCursorAt(second, 120);
		await vscode.commands.executeCommand('workbench.view.scm');

		// Native Previous wraps 120 -> 220 inside the file before Better Git sees the boundary.
		await previousChange();
		await expectActiveTab(first);
		await expectCursorVisibleAt(first, 24); // unchanged backward landing at the last change
		await previousChange();
		await expectCursorAt(first, 4); // the regression re-selected line 24 here
		assert.strictEqual(activeTabPath(), wsUri(first).path);

		await nextChange();
		await expectCursorAt(first, 24);
		await nextChange();
		await expectActiveTab(second);
		// Revisit memory keeps where the file was left (120), not the native wrap target (220)...
		await expectCursorVisibleAt(second, 120);
		assert.strictEqual(extensionApi.getRememberedReviewPosition?.(wsUri(second))?.resumeFromViewport, false,
			'the remembered position must record that review navigation owned its caret');
		// ...and that navigation-owned caret continues instead of re-anchoring to the restored viewport.
		await nextChange();
		await expectCursorAt(second, 220);
	});

	test('restored review: a one-line manual scroll owns the next press after the restore settles', async () => {
        const a = 'landing_scroll_a.txt', b = 'landing_scroll_b.txt';
        commitLandingFixtures({ [a]: 260, [b]: 40 }, 'restored scroll');
        editLines(a, 260, [120, 220]); editLines(b, 40, [4]);
        await refreshUntil(() => inWorkingTree(a, 5) && inWorkingTree(b, 5), 'restored scroll fixtures');
        await openWorkingDiffAt(a, 0); await nextChange(); await expectCursorAt(a, 120);
        await vscode.commands.executeCommand('better-git-vscode.next-changed-file'); await expectActiveTab(b);
        await vscode.commands.executeCommand('better-git-vscode.previous-changed-file'); await expectActiveTab(a);
        const editor = await expectCursorVisibleAt(a, 120);
        await poll(() => extensionApi.getRememberedReviewPosition?.(wsUri(a))?.resumeFromViewport === false,
            'restored navigation-owned position');
        const oldTop = editor.visibleRanges[0].start.line;
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: 1, revealCursor: false });
        await poll(() => editor.visibleRanges[0].start.line > oldTop, 'one-line independent scroll to render');
        assert.strictEqual(editor.visibleRanges[0].start.line, oldTop + 1, 'fixture must move exactly one line');
        assert.ok(lineIsVisible(editor, 120), 'small scroll must retain the old caret on screen');
        // A restore exemption must end at arrival. It cannot swallow a later wheel-like one-line movement.
        await poll(() => extensionApi.getRememberedReviewPosition?.(wsUri(a))?.resumeFromViewport === true,
            'one-line scroll to replace the restored caret owner', 2000);
        await nextChange(); await expectCursorAt(a, 120);
    });

    test('single-file Previous wrap presents the last tall hunk from its bottom before stepping upward', async () => {
        const rel = 'landing_only_file.txt';
        const config = vscode.workspace.getConfiguration('better-git-vscode');
        const oldStep = config.inspect<number>('hunkStagingLineStep')?.globalValue;
        const oldThreshold = config.inspect<number>('hunkStagingThreshold')?.globalValue;
        try {
            await config.update('hunkStagingLineStep', 10, vscode.ConfigurationTarget.Global);
            await config.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);
            commitLandingFixtures({ [rel]: 400 }, 'single-file wrap');
            editLines(rel, 400, [30, ...Array.from({ length: 150 }, (_, n) => n + 150)]);
            await refreshUntil(() => inWorkingTree(rel, 5), 'single changed file with a short and tall hunk');
            await openWorkingDiffAt(rel, 0); await nextChange(); await expectCursorAt(rel, 30);
            await previousChange();
            // The native Previous has already wrapped to the final hunk. Do not move Previous a second time.
            await expectCursorVisibleAt(rel, 299);
            await previousChange(); await expectCursorVisibleAt(rel, 289);
        } finally {
            await config.update('hunkStagingLineStep', oldStep, vscode.ConfigurationTarget.Global);
            await config.update('hunkStagingThreshold', oldThreshold, vscode.ConfigurationTarget.Global);
        }
    });

    for (const direction of ['next', 'previous'] as const) {
        test(`one-hunk cross-file ${direction}: the next intentional press leaves the displayed change`, async () => {
            const a = `one_hunk_${direction}_a.txt`, b = `one_hunk_${direction}_b.txt`;
            commitLandingFixtures({ [a]: 40, [b]: 40 }, `one-hunk ${direction}`);
            editLines(a, 40, [4]); editLines(b, 40, [3]);
            await refreshUntil(() => inWorkingTree(a, 5) && inWorkingTree(b, 5), 'one-hunk modified files');
            const origin = direction === 'next' ? a : b, target = direction === 'next' ? b : a;
            await openWorkingDiffAt(origin, 0);
            const step = direction === 'next' ? nextChange : previousChange;
            // Establish the initial review, then require exact progress on the single press AFTER entry.
            for (let n = 0; n < 3 && activeTabPath() !== wsUri(target).path; n++) { await step(); }
            await expectActiveTab(target);
            await step();
            assert.strictEqual(activeTabPath(), wsUri(origin).path,
                'the displayed one-hunk target must be exhausted on the next intentional press');
        });
    }

	test('mouse spam: 120 Next presses and 80 Previous presses stay exact in one new file', async function () {
		this.timeout(120_000);
		write('spam_new.txt', lines(3000, 'spam'));
		await refreshUntil(() => isUntracked('spam_new.txt'), 'spam file');
		const editor = await openPlainAt('spam_new.txt', 0);
		const start = new vscode.Position(50, 0);
		editor.selection = new vscode.Selection(start, start);
		editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
		await poll(() => lineIsVisible(editor, 50), 'spam start presented');
		await vscode.commands.executeCommand('workbench.view.scm');
		const burst = (direction: string, count: number) => Promise.all(Array.from({ length: count }, () =>
			vscode.commands.executeCommand(`better-git-vscode.${direction}-scm-change`, 'corsair')));
		const down = await viewportTopsDuring(editor, () => burst('next', 120));
		await expectCursorAt('spam_new.txt', 650);
		assertViewportMonotonic(down, 'down', '120 mouse Next presses');
		const up = await viewportTopsDuring(editor, () => burst('previous', 80));
		await expectCursorAt('spam_new.txt', 250);
		assertViewportMonotonic(up, 'up', '80 mouse Previous presses');
	});

	test('mouse spam: a duplicated file only moves in the active editor group', async () => {
		write('spam_split.txt', lines(1000, 'split'));
		await refreshUntil(() => isUntracked('spam_split.txt'), 'split spam file');
		const left = await openPlainAt('spam_split.txt', 0);
		const right = await vscode.window.showTextDocument(left.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
		try {
			const start = new vscode.Position(200, 0);
			right.selection = new vscode.Selection(start, start);
			right.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
			await poll(() => lineIsVisible(right, 200), 'right editor start');
			await vscode.commands.executeCommand('workbench.view.scm');
			await Promise.all(Array.from({ length: 10 }, () => nextChange()));
			assert.strictEqual(right.selection.active.line, 250, 'Next must move the active group');
			assert.strictEqual(left.selection.active.line, 0, 'Next must not move the other group');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await vscode.commands.executeCommand('workbench.action.joinAllGroups');
		}
	});

	test('mouse spam: 30 Next and 20 Previous presses stay directional in a working diff', async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		content.splice(10, 240, ...Array.from({ length: 1000 }, (_, i) => `changed row ${i}`));
		write(rel, content.join('\n'));
		await refreshUntil(() => inWorkingTree(rel, 5), 'working diff spam fixture');
		const editor = await openWorkingDiffAt(rel, 0);
		await vscode.commands.executeCommand('workbench.view.scm');
		// The first Better Git press anchors to the visible viewport, so reach line 30 through real
		// navigation before counting the burst. Setting the caret to 30 leaves the viewport at another line.
		for (const line of [10, 20, 30]) {
			await nextChange();
			await expectCursorAt(rel, line);
		}
		const down = await viewportTopsDuring(editor, () => Promise.all(Array.from({ length: 30 }, () => nextChange())));
		await expectCursorAt(rel, 330);
		assertViewportMonotonic(down, 'down', '30 working-diff Next presses');
		const up = await viewportTopsDuring(editor, () => Promise.all(Array.from({ length: 20 }, () => previousChange())));
		await expectCursorAt(rel, 130);
		assertViewportMonotonic(up, 'up', '20 working-diff Previous presses');
	});

	for (const interruption of ['switching away and back', 'editing the displayed document']) {
	test(`mouse spam: queued diff navigation cannot resume after ${interruption}`, async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		for (let i = 10; i <= 229; i++) { content[i] = `changed row ${i}`; }
		write(rel, content.join('\n'));
		write('spam_other.txt', lines(300, 'other'));
		await refreshUntil(() => inWorkingTree(rel, 5) && isUntracked('spam_other.txt'), 'switch spam fixtures');
		let editor = await openWorkingDiffAt(rel, 50);
		const repositoryPrototype = Object.getPrototypeOf(repo);
		const originalDiff = repositoryPrototype.diffWithHEAD;
		let release!: () => void;
		let started = false;
		const gate = new Promise<void>(resolve => { release = resolve; });
		repositoryPrototype.diffWithHEAD = async function (...args: unknown[]) {
			started = true;
			await gate;
			return originalDiff.apply(this, args);
		};
		let burst: Promise<unknown> | undefined;
		try {
			burst = Promise.all(Array.from({ length: 20 }, () =>
				vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'razer')));
			await poll(() => started, 'in-flight diff read');
			if (interruption === 'switching away and back') {
				await openPlainAt('spam_other.txt', 0);
				editor = await openWorkingDiffAt(rel, 100);
			} else {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(wsUri(rel), new vscode.Position(0, 0), 'new document revision\n');
				assert.ok(await vscode.workspace.applyEdit(edit));
				const reset = new vscode.Position(100, 0);
				editor.selection = new vscode.Selection(reset, reset);
			}
			release();
			await burst;
			assert.strictEqual(activeTabPath(), wsUri(rel).path, 'old mouse burst changed the manually chosen file');
			assert.strictEqual(editor.selection.active.line, 100, 'old mouse burst moved the manually reset caret');
			if (interruption === 'switching away and back') {
				await nextChange();
				assert.ok(editor.selection.active.line > 100, 'fresh Next must work after cancelling stale presses');
			}
		} finally {
			release();
			await burst;
			repositoryPrototype.diffWithHEAD = originalDiff;
			if (editor.document.isDirty) { await editor.document.save(); }
		}
	});
	}

	test('MODIFIED mixed hunks: rapid Next never scrolls backward between a tall run and nearby native stops', async () => {
		const config = vscode.workspace.getConfiguration('editor');
		const oldWrap = config.inspect<string>('wordWrap')?.globalValue;
		try {
			await config.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			const content = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 219; i++) { content[i] = `changed row ${i} ${'wrapped text '.repeat(i % 4)}`; }
			for (const line of [225, 229, 233]) { content[line] = `nearby short change ${line}`; }
			write('committed/tall_e.txt', content.join('\n'));
			await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5), 'mixed hunks to appear');
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 219);
			await sleep(100);
			await vscode.commands.executeCommand('workbench.view.scm');
			// Prove the original native-centering reversal, then reset before exercising Better Git.
			const nativeTops = await viewportTopsDuring(editor, () => vscode.commands.executeCommand('workbench.action.compareEditor.nextChange'));
			assert.ok(nativeTops.some((top, index) => index > 0 && top < nativeTops[index - 1]),
				`fixture must reproduce native recentering backwards: ${nativeTops.join(' -> ')}`);
			await openWorkingDiffAt('committed/tall_e.txt', 0);
			await vscode.commands.executeCommand('workbench.view.scm');
			// Start the burst at a Better Git-owned hunk edge, not a manually positioned caret.
			for (let step = 0; step < 22; step++) { await nextChange(); }
			await expectCursorAt('committed/tall_e.txt', 219);
			const tops = await viewportTopsDuring(editor, () => Promise.all(Array.from({ length: 3 }, () => nextChange())));
			await expectCursorAt('committed/tall_e.txt', 233);
			assertViewportMonotonic(tops, 'down', 'rapid mixed-hunk Next');
			const reverseTops = await viewportTopsDuring(editor, () => Promise.all([previousChange(), previousChange()]));
			await expectCursorAt('committed/tall_e.txt', 225);
			assertViewportMonotonic(reverseTops, 'up', 'rapid nearby-hunk Previous');
		} finally {
			await config.update('wordWrap', oldWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('visible-hunk handoff never skips a deleted-only native stop', async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		content[119] = 'later replacement after the deletion';
		content.splice(110, 2);
		write(rel, content.join('\n'));
		await refreshUntil(() => inWorkingTree(rel), 'deleted-only and replacement changes');
		const editor = await openWorkingDiffAt(rel, 105);
		await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
		const nativeDeletionLine = editor.selection.active.line;
		assert.ok(nativeDeletionLine < 117, 'native first stop must be the deletion, not the later replacement');
		await openWorkingDiffAt(rel, 105);
		await nextChange();
		await expectCursorAt(rel, nativeDeletionLine);
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri(rel).toString(), start: nativeDeletionLine, end: nativeDeletionLine },
			'a deleted-only hunk must receive a one-line overview-ruler marker on the modified side'
		);
		await nextChange();
		await expectCursorAt(rel, 117);
		await extensionApi.whenCurrentHunkOverviewMarkerSettled();
		assert.deepStrictEqual(
			extensionApi.getCurrentHunkOverviewMarker(),
			{ uri: wsUri(rel).toString(), start: 117, end: 117 },
			'the marker must move from a deleted-only stop to the following replacement hunk'
		);
	});

	test('visible-hunk handoff preserves Ignore Trim Whitespace navigation', async () => {
		const config = vscode.workspace.getConfiguration('diffEditor');
		const previousWhitespace = config.inspect<boolean>('ignoreTrimWhitespace')?.globalValue;
		try {
			await config.update('ignoreTrimWhitespace', true, vscode.ConfigurationTarget.Global);
			const rel = 'committed/tall_e.txt';
			const content = lines(260, 'tall_e').split('\n');
			content[110] = `  ${content[110]}  `;
			content[119] = 'substantive replacement';
			write(rel, content.join('\n'));
			await refreshUntil(() => inWorkingTree(rel), 'whitespace and substantive changes');
			await openWorkingDiffAt(rel, 105);
			await nextChange();
			await expectCursorAt(rel, 119);
			await config.update('ignoreTrimWhitespace', false, vscode.ConfigurationTarget.Global);
			await openWorkingDiffAt(rel, 105);
			await nextChange();
			await expectCursorAt(rel, 110);
		} finally {
			await config.update('ignoreTrimWhitespace', previousWhitespace, vscode.ConfigurationTarget.Global);
		}
	});

	test('visible-hunk handoff defers to native navigation for unsaved changes', async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		content[119] = 'saved replacement';
		write(rel, content.join('\n'));
		await refreshUntil(() => inWorkingTree(rel), 'saved replacement');
		const editor = await openWorkingDiffAt(rel, 105);
		try {
			await editor.edit(edit => edit.insert(new vscode.Position(110, 0), 'unsaved change '));
			assert.ok(editor.document.isDirty);
			await sleep(300); // native diff must recompute the additional in-memory change
			const position = new vscode.Position(105, 0);
			editor.selection = new vscode.Selection(position, position);
			await nextChange();
			await expectCursorAt(rel, 110); // not Git's saved-only stop at 119
		} finally {
			await editor.document.save(); // only the disposable fixture; avoid a dirty-editor prompt in teardown
		}
	});

	test('MODIFIED tall hunk: literal filenames with spaces, non-ASCII and Git glob characters keep intermediate steps', async () => {
		const rel = 'committed/tall é [a] file.txt';
		const peer = 'committed/tall é a file.txt';
		write(rel, lines(260, 'quoted'));
		write(peer, lines(260, 'peer'));
		git('add .');
		git('commit -m "quoted filename fixture"');
		const content = lines(260, 'quoted').split('\n');
		for (let i = 10; i <= 229; i++) { content[i] = `quoted EDITED line ${i + 1}`; }
		write(rel, content.join('\n'));
		const peerContent = lines(260, 'peer').split('\n');
		peerContent[3] = 'unrelated change matched by a Git glob';
		write(peer, peerContent.join('\n'));
		await refreshUntil(() => inWorkingTree(rel, 5) && inWorkingTree(peer, 5), 'both quoted files to appear as MODIFIED');
		await openWorkingDiffAt(rel, 0);
		const repositoryPrototype = Object.getPrototypeOf(repo);
		const originalDiff = repositoryPrototype.diff;
		let fullDiffReads = 0;
		repositoryPrototype.diff = function (...args: unknown[]) {
			fullDiffReads++;
			return originalDiff.apply(this, args);
		};
		try {
			await nextChange();
			await expectCursorVisibleAt(rel, 10);
			await nextChange();
			await expectCursorVisibleAt(rel, 20);
			await previousChange();
			await expectCursorVisibleAt(rel, 10);
			await extensionApi.whenCurrentHunkOverviewMarkerSettled();
			assert.strictEqual(fullDiffReads, 0, 'ordinary unstaged hunk navigation must not diff the worktree');
		} finally {
			repositoryPrototype.diff = originalDiff;
		}
	});

	test('MODIFIED tall hunk: repeated/rapid next scrolls down and previous scrolls back up', async () => {
		const content = lines(260, 'tall_e').split('\n');
		for (let i = 10; i <= 229; i++) {
			content[i] = `tall_e EDITED line ${i + 1}`;
		}
		write('committed/tall_e.txt', content.join('\n'));
		await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5 /* MODIFIED */), 'tall_e to appear as MODIFIED');

		await vscode.commands.executeCommand('git.openChange', wsUri('committed/tall_e.txt'));
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('committed/tall_e.txt')) !== undefined,
			'tall_e diff editor to render'
		);
		await sleep(500);
		const modifiedSide = visibleEditorFor(wsUri('committed/tall_e.txt'))!;
		modifiedSide.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
		// Navigation now starts from the visible viewport. Explicitly put this regression at line 1;
		// setting only the caret no longer resets a diff that VS Code opened at its first hunk.
		modifiedSide.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
		await poll(() => modifiedSide.visibleRanges[0]?.start.line === 0, 'tall-hunk fixture viewport at line 1');

		// First NEXT lands/pins at the exact tall-hunk start. Sticky context may intentionally keep several source
		// lines above it, so the invariant is a visible exact caret—not caret===visibleRanges.top.
		const landingTops = await viewportTopsDuring(modifiedSide, nextChange);
		const landed = await expectCursorVisibleAt('committed/tall_e.txt', 10);
		assertViewportMonotonic(landingTops, 'down', 'tall-hunk forward landing');
		const startTop = landed.visibleRanges[0].start.line;

		// Two immediate NEXT presses must both survive the shared queue and move the viewport farther down.
		// Put keyboard focus in Source Control first: Ethan's real review flow clicks SCM rows with preserveFocus,
		// so the scroll command must still target the active diff editor while focus lives in the sidebar.
		await vscode.commands.executeCommand('workbench.view.scm');
		const rapidDownTops = await viewportTopsDuring(modifiedSide, () => Promise.all([nextChange(), nextChange()]));
		const down = await expectViewportTop('committed/tall_e.txt', top => top > startTop, 'to advance through the tall hunk');
		const downCaret = down.selection.active.line;
		assert.strictEqual(downCaret, 30, `two default ten-line tall-hunk steps must land at L31 (at L${downCaret + 1})`);
		assert.ok(lineIsVisible(down, downCaret), 'rapid tall-hunk next left its logical caret off-screen');
		assertViewportMonotonic(rapidDownTops, 'down', 'rapid tall-hunk next');

		const reverseTops = await viewportTopsDuring(modifiedSide, previousChange);
		const up = await poll(() => {
			const editor = visibleEditorFor(wsUri('committed/tall_e.txt'));
			return editor && editor.selection.active.line < downCaret ? editor : undefined;
		}, 'previous to step upward from the current tall-hunk caret');
		assert.ok(up.selection.active.line >= 10, 'reverse tall-hunk step jumped above the current hunk');
		assert.ok(lineIsVisible(up, up.selection.active.line), 'reverse tall-hunk step left its caret off-screen');
		assertViewportMonotonic(reverseTops, 'up', 'tall-hunk direction reversal');
	});

	test('MODIFIED viewport-fit hunk: a bottom-stranded landing is presented before advance', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousOverlap = navConfig.inspect<number>('hunkStagingOverlap')?.globalValue;
		const previousHideUnchanged = diffConfig.inspect<boolean>('hideUnchangedRegions.enabled')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 0, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 0, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingOverlap', 4, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', false, vscode.ConfigurationTarget.Global);

			// Seed any tall diff first so we can measure this host's real viewport, then size the regression hunk
			// just below that logical line count. This recreates the live failure at every test-window size/zoom:
			// the hunk numerically "fits" the whole viewport but starts halfway down it, so its tail is off-screen.
			const seed = lines(260, 'tall_e').split('\n');
			seed[10] = 'tall_e first EDITED line 11';
			write('committed/tall_e.txt', seed.join('\n'));
			await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5), 'viewport seed change to appear');
			const seedEditor = await openWorkingDiffAt('committed/tall_e.txt', 10);
			const seedRanges = seedEditor.visibleRanges;
			const viewportLines = seedRanges.reduce((total, range) => total + range.end.line - range.start.line + 1, 0);
			assert.ok(viewportLines >= 12, `test viewport unexpectedly short (${viewportLines} logical lines)`);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

			const firstStart = 10;
			const secondStart = firstStart + Math.floor(viewportLines / 4);
			const secondSpan = Math.floor(viewportLines / 2);
			const secondEnd = secondStart + secondSpan - 1;
			const content = lines(260, 'tall_e').split('\n');
			content[firstStart] = 'tall_e first EDITED line 11';
			for (let i = secondStart; i <= secondEnd; i++) {
				content[i] = `tall_e viewport-fit EDITED line ${i + 1}`;
			}
			write('committed/tall_e.txt', content.join('\n'));
			const nextFile = lines(10, 'mod_d').split('\n');
			nextFile[2] = 'mod_d next-file EDITED line 3';
			write('committed/mod_d.txt', nextFile.join('\n'));
			await refreshUntil(
				() => inWorkingTree('committed/tall_e.txt', 5) && inWorkingTree('committed/mod_d.txt', 5),
				'viewport-fit regression files to appear'
			);

			const editor = await openWorkingDiffAt('committed/tall_e.txt', firstStart);
			await poll(
				() => positionIsVisible(editor, new vscode.Position(secondStart, 0)),
				'viewport-fit hunk start to be visible before navigation'
			);
			assert.ok(
				!positionIsVisible(editor, new vscode.Position(secondEnd, 0)),
				'fixture must strand the viewport-fit hunk tail below the screen'
			);
			assert.ok(secondSpan < viewportLines, 'regression hunk must be shorter than the raw viewport line count');

			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', secondStart);
			assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);

			// If lifting the hunk start presents its tail too, the next press may advance normally. If renderer
			// padding/wrapping still leaves the tail off-screen, the next press must remain in this hunk and step.
			// The old span<=viewport shortcut did neither: it left the tail hidden and immediately changed files.
			if (!positionIsVisible(editor, new vscode.Position(secondEnd, 0))) {
				await nextChange();
				const stepped = await poll(() => {
					const current = visibleEditorFor(wsUri('committed/tall_e.txt'));
					return current && current.selection.active.line > secondStart ? current : undefined;
				}, 'viewport-fit hunk to step before changing files');
				assert.ok(stepped.selection.active.line <= secondEnd);
				assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);
			}
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingOverlap', previousOverlap, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', previousHideUnchanged, vscode.ConfigurationTarget.Global);
		}
	});

    test('outer replacement wrap: retain the pre-wrap step when a nearby Git stop is merged by Monaco', async () => {
        const rel = 'committed/outer-wrap.ts';
        const config = vscode.workspace.getConfiguration('better-git-vscode');
        const previousStep = config.inspect<number>('hunkStagingLineStep')?.globalValue;
        try {
            await config.update('hunkStagingLineStep', 10, vscode.ConfigurationTarget.Global);
            const fixture = process.env.BGV_OUTER_WRAP_AFTER_FIXTURE_PATH;
            assert.ok(fixture);
            write(rel, fs.readFileSync(fixture, 'utf8'));
            write('zz_after_outer_wrap.txt', 'a following file that must stay unopened');
            await refreshUntil(() => inWorkingTree(rel, 5) && isUntracked('zz_after_outer_wrap.txt'), 'outer-wrap fixture');
            const editor = await openWorkingDiffAt(rel, 373);
            await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
            await poll(() => editor.selection.active.line !== 373, 'native movement at merged stop');
            assert.ok(editor.selection.active.line < 373, 'fixture must reproduce native Next wrapping past unread content');
            const start = new vscode.Position(0, 0);
            editor.selection = new vscode.Selection(start, start);
            editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
            await poll(() => lineIsVisible(editor, 0), 'initial fixture position');
            // Reach this through real review commands: a manually opened viewport owns its first press.
            for (let i = 0; i < 25 && editor.selection.active.line !== 373; i++) {
                await nextChange();
                assert.strictEqual(activeTabPath(), wsUri(rel).path);
            }
            assert.strictEqual(editor.selection.active.line, 373);
            await nextChange();
            await expectCursorVisibleAt(rel, 383);
            assert.strictEqual(git('diff --cached --name-only'), '', 'a rescued review step must not stage');
            await config.update('hunkStagingLineStep', 7, vscode.ConfigurationTarget.Global);
            await nextChange();
            assert.strictEqual(activeTabPath(), wsUri(rel).path);
            assert.ok(editor.selection.active.line > 383, 'review must continue rather than loop at the rescued stop');
        } finally { await config.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global); }
    });

    for (const mode of ['next', 'stage-next', 'eyes'] as const) {
        test('fresh new-file landing: ' + mode + ' ignores native history, then pages from line1', async () => {
            const rel = 'zz_fresh_' + mode + '.ts';
            // SCM puts root files before nested files. Keep this tracked origin before the root-level
            // target: held eyes review deliberately does NOT wrap its captured set at the worktree edge.
            const current = 'aa_fresh_origin_' + mode + '.txt';
            write(current, lines(20, 'origin'));
            git('add -- "' + current + '"'); git('commit -m "fresh landing origin"');
            const exclude = path.join(ws, '.git/info/exclude');
            const previousExclude = fs.readFileSync(exclude);
            fs.appendFileSync(exclude, '\n' + rel + '\n');
            try {
                write(rel, lines(160, 'fresh'));
                await repo.status();
                // Cache a native caret, not an exact viewport top: EOF clamping varies with Mini window size.
                const editor = await vscode.window.showTextDocument(wsUri(rel), { preview: false });
                editor.selection = new vscode.Selection(98, 0, 98, 0);
                editor.revealRange(new vscode.Range(98, 0, 98, 0), vscode.TextEditorRevealType.AtTop);
                await poll(() => lineIsVisible(editor, 98), 'ignored file native cached caret');
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            } finally { fs.writeFileSync(exclude, previousExclude); }
            write(current, lines(20, 'origin').replace('origin line 5', 'edited origin five'));
            await refreshUntil(() => isUntracked(rel) && inWorkingTree(current, 5), 'fresh next target');
            await openWorkingDiffAt(current, 4);
            try {
                if (mode === 'stage-next') {
                    await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
                } else if (mode === 'eyes') {
                    await focusIsolatedTestWindow(); // Held review is admitted only while this isolated host is focused.
                    await vscode.commands.executeCommand('better-git-vscode.begin-keyboard-review', 'next');
                    await poll(() => extensionApi.getReviewDecorationBadge(wsUri(current)) === '👀', 'fresh landing eyes entry');
                    // This case asserts first arrival, not how many origin-hunk/viewport steps precede it.
                    // Stop at arrival so a third origin step cannot accidentally become a new-file page.
                    for (let n = 0; n < 6 && activeTabPath() !== wsUri(rel).path; n++) {
                        await vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', 'next');
                    }
                    assert.strictEqual(activeTabPath(), wsUri(rel).path, 'eyes must reach the following new file');
                } else { await nextChange(); await nextChange(); }
                await expectCursorVisibleAt(rel, 0);
                if (mode === 'eyes') { await vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', 'next'); }
                else { await nextChange(); }
                await expectCursorVisibleAt(rel, 5);
                assert.strictEqual(inIndex(rel), false, 'previewing the next file must not stage it');
            } finally {
                if (mode === 'eyes') { await vscode.commands.executeCommand('better-git-vscode.cancel-keyboard-review'); }
            }
        });
    }

	test('copied profile-pic replacement: oversized built-in navigation steps the outer hunk by default 10 and custom 7', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousHideUnchanged = diffConfig.inspect<boolean>('hideUnchangedRegions.enabled')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', undefined, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 0, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', false, vscode.ConfigurationTarget.Global);
			assert.strictEqual(
				navConfig.get<number>('hunkStagingLineStep'),
				10,
				'the real host must resolve the unset hunk step to the manifest default of ten'
			);

			const afterFixture = process.env.BGV_PROFILE_PIC_AFTER_FIXTURE_PATH;
			assert.ok(afterFixture, 'profile-pic after fixture path was not supplied by the test runner');
			const rel = 'committed/profile-pic.service.ts';
			write(rel, fs.readFileSync(afterFixture, 'utf8'));
			await refreshUntil(() => inWorkingTree(rel, 5 /* MODIFIED */), 'copied profile-pic service to appear as modified');

			// This is the exact live large replacement from the reported AIMVS worktree. Git's unified body contains
			// many short '+' runs, but VS Code groups the method body into one large visual change and jumps from its
			// first line to a much later stop. Better Git must page through that unread replacement instead.
			const methodSignatureStart = 48; // current-file L49: `async setProfilePicture(`
			const start = 52; // current-file L53: first line of the large replacement body shown in the report
			const editor = await openWorkingDiffAt(rel, methodSignatureStart);
			assert.ok(!positionIsVisible(editor, editor.document.lineAt(252).range.end), 'outer replacement tail must start off-screen');
			await vscode.commands.executeCommand('workbench.view.scm');
			await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
			await sleep(100);
			assert.strictEqual(
				editor.selection.active.line,
				start,
				'copied fixture must reproduce VS Code moving from the method signature to the large replacement body'
			);
			await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
			await sleep(100);
			assert.strictEqual(
				editor.selection.active.line,
				148,
				'test precondition failed: copied fixture must reproduce VS Code skipping from L53 to L149'
			);

			// Reach the reported stop through real review navigation. Since viewport-owned entry was added,
			// manually resetting a caret alone is not proof the next press starts from that caret.
			const resetPosition = new vscode.Position(0, 0);
			editor.selection = new vscode.Selection(resetPosition, resetPosition);
			editor.revealRange(new vscode.Range(resetPosition, resetPosition), vscode.TextEditorRevealType.AtTop);
			await poll(() => lineIsVisible(editor, 0), 'copied profile-pic review entry to be visible again');
			for (let i = 0; i < 8 && editor.selection.active.line !== start; i++) { await nextChange(); }
			assert.strictEqual(editor.selection.active.line, start, 'reach the copied stop through review navigation');
			assert.ok(!positionIsVisible(editor, editor.document.lineAt(252).range.end), 'outer replacement tail must be hidden again');
			await vscode.commands.executeCommand('workbench.view.scm');

			const defaultStepTops = await viewportTopsDuring(editor, nextChange);
			await expectCursorVisibleAt(rel, start + 10);
			assertViewportMonotonic(defaultStepTops, 'down', 'copied profile-pic default outer-hunk step');
			assert.strictEqual(activeTabPath(), wsUri(rel).path, 'default step prematurely changed files');

			await navConfig.update('hunkStagingLineStep', 7, vscode.ConfigurationTarget.Global);
			await nextChange();
			await expectCursorVisibleAt(rel, start + 17);
			assert.strictEqual(activeTabPath(), wsUri(rel).path, 'custom forward step prematurely changed files');

			await previousChange();
			await expectCursorVisibleAt(rel, start + 10);
			assert.strictEqual(activeTabPath(), wsUri(rel).path, 'custom previous step must mirror the exact seven-line move');
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', previousHideUnchanged, vscode.ConfigurationTarget.Global);
		}
	});

	test('copied profile-pic replacement: Previous at the first change leaves the file after the built-in wraps downward', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousHideUnchanged = diffConfig.inspect<boolean>('hideUnchangedRegions.enabled')?.globalValue;
		try {
			await navConfig.update('hunkStagingThreshold', 0, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', false, vscode.ConfigurationTarget.Global);

			const afterFixture = process.env.BGV_PROFILE_PIC_AFTER_FIXTURE_PATH;
			assert.ok(afterFixture, 'profile-pic after fixture path was not supplied by the test runner');
			const rel = 'committed/profile-pic.service.ts';
			write(rel, fs.readFileSync(afterFixture, 'utf8'));
			const previousFile = lines(40, 'mod_a').split('\n');
			previousFile[4] = 'mod_a previous-file EDITED line 5';
			write('committed/mod_a.txt', previousFile.join('\n'));
			await refreshUntil(
				() => inWorkingTree(rel, 5 /* MODIFIED */) && inWorkingTree('committed/mod_a.txt', 5),
				'profile-pic wrap regression files to appear'
			);

			const firstChange = 0;
			const editor = await openWorkingDiffAt(rel, firstChange);
			await vscode.commands.executeCommand('workbench.view.scm');

			// VS Code's compare editor wraps Previous from the first stop to a later stop in this same file.
			// Better Git must classify that downward move as exhaustion, not as the no-op that needs outer-@@
			// fallback stepping.
			await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
			await sleep(100);
			assert.ok(
				editor.selection.active.line > firstChange,
				'test precondition failed: built-in Previous must wrap downward within the copied replacement'
			);

			// Test an OWNED first-change landing, not a manually opened viewport whose first Previous
			// legitimately starts from its visible bottom. Use a fresh URI so the native proof above cannot
			// seed a remembered revisit and disguise which caret owns the following intentional press.
			const ownedRel = 'committed/profile-pic-owned-wrap.ts';
			write(ownedRel, fs.readFileSync(path.join(path.dirname(afterFixture), 'profile-pic.service.before.txt'), 'utf8'));
			git(`add -- "${ownedRel}"`); git('commit -m "owned wrap fixture"');
			write(ownedRel, fs.readFileSync(afterFixture, 'utf8'));
			git(`checkout -- "${rel}"`);
			await refreshUntil(() => inWorkingTree(ownedRel, 5) && inWorkingTree('committed/mod_a.txt', 5), 'owned wrap files');
			await openWorkingDiffAt('committed/mod_a.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.next-changed-file');
			await expectCursorAt(ownedRel, firstChange);
			await previousChange();
			await expectActiveTab('committed/mod_a.txt');
		} finally {
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await diffConfig.update('hideUnchangedRegions.enabled', previousHideUnchanged, vscode.ConfigurationTarget.Global);
		}
	});

	test('MODIFIED tall hunk: sticky-context rapid one-line steps are caret-owned and reversible', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousSticky = editorConfig.inspect<boolean>('stickyScroll.enabled')?.globalValue;
		const previousStickyMax = editorConfig.inspect<number>('stickyScroll.maxLineCount')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 1, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', true, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.maxLineCount', 5, vscode.ConfigurationTarget.Global);

			const content = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 60; i++) {
				content[i] = `tall_e sticky EDITED line ${i + 1}`;
			}
			write('committed/tall_e.txt', content.join('\n') + '\n');
			await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5), 'sticky tall_e change to appear');
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 0);

			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 10);
			await vscode.commands.executeCommand('workbench.view.scm');

			// A +1 target can remain inside sticky/cursor-surrounding padding and legitimately leave visibleRanges.top
			// unchanged. Logical progress must still be 10 -> 11 -> 12 -> 13, never one jump followed by a stall.
			const rapidTops = await viewportTopsDuring(editor, () =>
				Promise.all([nextChange(), nextChange(), nextChange()])
			);
			await expectCursorVisibleAt('committed/tall_e.txt', 13);
			assertViewportMonotonic(rapidTops, 'down', 'sticky one-line tall-hunk progression');

			const reverseTops = await viewportTopsDuring(editor, previousChange);
			await expectCursorVisibleAt('committed/tall_e.txt', 12);
			assertViewportMonotonic(reverseTops, 'up', 'sticky one-line tall-hunk reversal');
			assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', previousSticky, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.maxLineCount', previousStickyMax, vscode.ConfigurationTarget.Global);
		}
	});

	test('MODIFIED tall hunk: exact edges are consumed before forward/backward file rollover', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 10_000, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);

			const tall = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 229; i++) {
				tall[i] = `tall_e boundary EDITED line ${i + 1}`;
			}
			write('committed/tall_e.txt', tall.join('\n') + '\n');
			const previousFile = lines(40, 'mod_a').split('\n');
			previousFile[4] = 'mod_a boundary EDITED line 5';
			write('committed/mod_a.txt', previousFile.join('\n') + '\n');
			await refreshUntil(
				() => inWorkingTree('committed/tall_e.txt', 5) && inWorkingTree('committed/mod_a.txt', 5),
				'boundary files to appear as modified'
			);
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 0);

			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 10);
			const finalDown = await viewportTopsDuring(editor, nextChange);
			await expectCursorVisibleAt('committed/tall_e.txt', 229);
			assertViewportMonotonic(finalDown, 'down', 'final tall-hunk down step');
			assert.strictEqual(
				activeTabPath(),
				wsUri('committed/tall_e.txt').path,
				'landing at the hunk end prematurely changed files'
			);

			await nextChange(); // only a later press may wrap from the final file to the first one
			await expectActiveTab('committed/mod_a.txt');
			const modA = await poll(
				() => visibleEditorFor(wsUri('committed/mod_a.txt')),
				'mod_a modified editor after forward rollover'
			);
			const top = new vscode.Position(0, 0);
			modA.selection = new vscode.Selection(top, top);

			// Backward cross-file entry must present the last tall hunk from its bottom, not leave the caret at its
			// start and let the following Previous skip it.
			await previousChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 229);
			assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);

			const landedEditor = visibleEditorFor(wsUri('committed/tall_e.txt'))!;
			const finalUp = await viewportTopsDuring(landedEditor, previousChange);
			await expectCursorVisibleAt('committed/tall_e.txt', 10);
			assertViewportMonotonic(finalUp, 'up', 'final tall-hunk up step');
			assert.strictEqual(
				activeTabPath(),
				wsUri('committed/tall_e.txt').path,
				'landing at the hunk start prematurely changed files'
			);

			await previousChange();
			await expectActiveTab('committed/mod_a.txt');
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
		}
	});

	test('stage-and-Previous lands at the bottom of the previous tall diff', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		try {
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);
            // First-visit landing needs a fresh URI; reused tall_e may correctly restore an earlier test's view.
            const rel = 'stage_previous_first_visit.txt';
            commitLandingFixtures({ [rel]: 260 }, 'stage-previous');
            editLines(rel, 260, Array.from({ length: 220 }, (_, n) => n + 10));
			write('zz_current.txt', lines(20, 'current'));
			await refreshUntil(
				() => inWorkingTree(rel, 5) && isUntracked('zz_current.txt'),
				'stage-and-Previous files to appear'
			);
			await openPlainAt('zz_current.txt', 0);

			await vscode.commands.executeCommand('better-git-vscode.stage-and-previous-changed-file');
			await expectCursorVisibleAt(rel, 229);
			assert.ok(inIndex('zz_current.txt', 1), 'stage-and-Previous did not stage the current file');
		} finally {
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
		}
	});



	for (const source of ['corsair', 'razer']) {
		for (const surface of ['working image', 'working notebook', 'staged image', 'staged deletion', 'clean image']) {
			test(`non-text hold entry ${source} ${surface} preserves side and cancel safety`, async () => {
				await focusIsolatedTestWindow();
				await vscode.workspace.getConfiguration('better-git-vscode').update(
					'experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				const notebook = surface === 'working notebook';
				const rel = notebook ? 'committed/notebook.ipynb' : 'committed/image.png';
				const uri = wsUri(rel);
				const before = fs.readFileSync(uri.fsPath);
				if (surface === 'staged deletion') {
					git(`rm ${rel}`);
					fs.writeFileSync(uri.fsPath, before);
					await refreshUntil(() => inIndex(rel, 2) && isUntracked(rel), 'staged deletion with recreated image');
				} else if (surface !== 'clean image') {
					if (notebook) {
						const content = JSON.parse(before.toString());
						content.cells[0].source = ["print('staged')\n"];
						fs.writeFileSync(uri.fsPath, JSON.stringify(content));
					} else {
						fs.writeFileSync(uri.fsPath, Buffer.from(
							'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'));
					}
					git(`add ${rel}`);
					fs.writeFileSync(uri.fsPath, before);
					await refreshUntil(() => inIndex(rel) && inWorkingTree(rel), 'dual-state non-text fixture');
				}
				const indexBefore = git('write-tree');
				try {
					await vscode.commands.executeCommand('vscode.open', surface === 'staged image' ? toGitUri(uri, '')
						: surface === 'staged deletion' ? toGitUri(uri, 'HEAD') : uri);
					await sleep(300); // Native non-text renderers complete after their open promise.
					const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction: 'next' });
					await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, true);
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					if (surface.startsWith('working')) {
						assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '👀', 'explicit working preview must enter eyes with both Git sides present');
					} else {
						assert.notStrictEqual(extensionApi.getReviewDecorationBadge(uri), '👀', 'staged or clean previews must not arm unstaged selection');
					}
					assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'entry does not replace the preview');
					if (surface.startsWith('working')) {
						await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', source);
					}
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction: 'next' });
					await extensionApi.whenStageTransactionsSettled();
					assert.strictEqual(git('write-tree'), indexBefore, 'cancel and late release retain the exact index');
				} finally {
					await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
					await sleep(300);
					await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				}
			});
		}
	}

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			for (const imageState of ['deleted', 'staged-modified-deleted', 'staged-new-deleted', 'staged-new-deleted-native', 'staged-new-lfs-deleted-native']) {
				test(`image hold entry ${source} ${direction} ${imageState} enters eyes and preserves batch Undo`, async () => {
					await focusIsolatedTestWindow();
					await vscode.workspace.getConfiguration('better-git-vscode').update(
						'experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
					const rel = imageState.startsWith('staged-new') ? 'committed/added-image.png' : 'committed/image.png';
					const uri = wsUri(rel);
					if (imageState !== 'deleted') {
						const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
						// The October 31 report had no HEAD blob: the staged-new image was an LFS pointer, then
						// deleted on disk. A normal PNG-only fixture does not cover this native preview shape.
						fs.writeFileSync(uri.fsPath, imageState.includes('-lfs-')
							? `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`
							: bytes);
						git(`add ${rel}`);
					}
					fs.rmSync(uri.fsPath);
					const peer = direction === 'next' ? 'committed/zz_image_peer.txt' : 'committed/aaa_image_peer.txt';
					write(peer, 'peer review');
					await refreshUntil(() => inWorkingTree(rel, 6) && isUntracked(peer), 'deleted image hold fixture');
					const indexBefore = git('write-tree');
					const clipboardBefore = await vscode.env.clipboard.readText();
					try {
						await vscode.commands.executeCommand(imageState === 'staged-new-deleted' ? 'vscode.open' : 'git.openChange',
							imageState === 'staged-new-deleted' ? toGitUri(uri, '~') : uri);
						await poll(() => extensionApi.getCurrentReviewUri() === uri.toString(), 'image review URI');
						await sleep(300); // Allow the native media preview to finish rendering before closing it.
						const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
						await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
						await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, true);
						await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
						assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '👀',
							`deleted image must enter eyes: ${extensionApi.getMouseDebugTrace().join(' | ')}`);
						assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'hold must keep the image preview');
						assert.strictEqual(git('write-tree'), indexBefore, 'eyes readiness must not stage');
						await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', source, direction);
						await expectActiveTab(peer);
						assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '💥💥', 'reviewed image is marked');
						assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(peer)), '👀', 'peer remains under review');
						await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
						await extensionApi.whenStageTransactionsSettled();
						assert.strictEqual(git(`ls-files -- ${rel}`), '', 'release stages the deletion');
						assert.ok(isUntracked(peer), 'eyes endpoint stays unstaged');
						await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
						await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
						await extensionApi.whenStageTransactionsSettled();
						assert.strictEqual(git('write-tree'), indexBefore, 'one Undo restores the exact pre-hold index');
						assert.ok(!fs.existsSync(uri.fsPath), 'Undo never recreates the working image');
						assert.strictEqual(await vscode.env.clipboard.readText(), clipboardBefore, 'image resolution preserves clipboard');
					} finally {
						await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
						await sleep(300); // Undo reopens the asynchronous native media preview.
						await vscode.commands.executeCommand('workbench.action.closeAllEditors');
					}
				});
			}
		}
	}

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`release-only hold ${source} ${direction} stays still until release and stages its origin after a long hold`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'release-only hold pair');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					const destination = direction === 'next' ? 'hold_b.txt' : 'hold_a.txt';
					const editor = await openPlainAt(origin, 0);
					const selection = editor.selection;
					const top = editor.visibleRanges[0]?.start.line;

					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'button-down must leave the review file still');
					assert.deepStrictEqual(editor.selection, selection, 'button-down must leave the cursor still');
					assert.strictEqual(editor.visibleRanges[0]?.start.line, top, 'button-down must leave the viewport still');
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'hold readiness must leave the review file still');
					assert.strictEqual(git('diff --cached --name-only'), '', 'hold readiness must not stage');
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥');

					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), origin);
					assert.strictEqual(activeTabPath(), wsUri(destination).path, 'long release must perform one Stage + navigation');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), origin, 'duplicate release must not stage destination');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
				}
			});

			test(`release-only short ${source} ${direction} performs exactly one navigation on button-up`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'release-only short pair');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					const destination = direction === 'next' ? 'hold_b.txt' : 'hold_a.txt';
					await openPlainAt(origin, 0);

					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					assert.strictEqual(activeTabPath(), wsUri(origin).path);
					await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'short release registration must stay still until its boundary');
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
					assert.strictEqual(activeTabPath(), wsUri(destination).path, 'short button-up sequence must navigate immediately');
					assert.strictEqual(git('diff --cached --name-only'), '', 'short release must not stage');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(activeTabPath(), wsUri(destination).path, 'later long-release transport must be inert');
					assert.strictEqual(git('diff --cached --name-only'), '');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
				}
			});
		}
	}

	test('stage-ready wheel selects a contiguous range and one Undo restores the whole batch', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['batch_a.txt', 'batch_b.txt', 'batch_c.txt', 'batch_d.txt', 'batch_existing.txt']) {
				write(name, name);
			}
			write('batch_c.txt', lines(120, 'batch_c') + '\n');
			await refreshUntil(
				() => ['batch_a.txt', 'batch_b.txt', 'batch_c.txt', 'batch_d.txt', 'batch_existing.txt'].every(isUntracked),
				'batch selection files'
			);
			await repo.add([wsUri('batch_existing.txt').fsPath]);
			await refreshUntil(() => inIndex('batch_existing.txt'), 'pre-existing staged file');
			await openPlainAt('batch_b.txt', 0);

			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('batch_c.txt')), undefined, 'wheel must be inert before readiness');
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			assert.strictEqual(activeTabPath(), wsUri('batch_c.txt').path, 'first wheel step must preview its new endpoint');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			assert.strictEqual(activeTabPath(), wsUri('batch_d.txt').path, 'second wheel step must preview its new endpoint');
			for (const name of ['batch_b.txt', 'batch_c.txt', 'batch_d.txt']) {
				assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(name)), '💥💥', `${name} must be selected`);
			}
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'up');
			assert.strictEqual(activeTabPath(), wsUri('batch_c.txt').path, 'contracting the range must preview the current endpoint');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('batch_d.txt')), undefined, 'reverse wheel must contract the range');
			const endpointEditor = await poll(() => visibleEditorFor(wsUri('batch_c.txt')), 'batch endpoint editor');
			endpointEditor.selection = new vscode.Selection(20, 2, 20, 8);
			endpointEditor.revealRange(new vscode.Range(10, 0, 10, 0), vscode.TextEditorRevealType.AtTop);
			await sleep(100);
			const endpointView = { selection: endpointEditor.selection, top: endpointEditor.visibleRanges[0].start.line };

			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.deepStrictEqual(git('diff --cached --name-only').split('\n'), [
				'batch_b.txt', 'batch_c.txt', 'batch_existing.txt'
			]);
			assert.strictEqual(activeTabPath(), wsUri('batch_d.txt').path, 'release must land after the staged range');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), 'batch_existing.txt', 'one Undo must restore the full batch and keep older staged work');
			assert.strictEqual(activeTabPath(), wsUri('batch_c.txt').path, 'Undo must return to the last previewed batch file');
			const undoneEndpoint = await poll(() => visibleEditorFor(wsUri('batch_c.txt')), 'undone batch endpoint');
			assert.deepStrictEqual(undoneEndpoint.selection, endpointView.selection);
			await poll(() => undoneEndpoint.visibleRanges[0]?.start.line === endpointView.top,
				'batch endpoint viewport to return');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	for (const source of ['corsair', 'razer']) {
		test(`held batch survives manual editor changes for ${source}`, async function () {
			this.timeout(90_000);
			const config = vscode.workspace.getConfiguration('better-git-vscode');
			await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
			try {
				for (const name of ['click_a.txt', 'click_b.txt', 'click_c.txt', 'click_d.txt', 'click_other.txt']) { write(name, name); }
				await refreshUntil(() => isUntracked('click_other.txt'), 'held interaction files');
				await openPlainAt('click_a.txt', 0);
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction: 'next' });
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', source, 'down');
				const unrelated = await openPlainAt('click_other.txt', 0);
				const unrelatedTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
				await unrelated.edit(edit => edit.insert(new vscode.Position(0, 0), 'unsaved '));
				await sleep(100);
				for (const name of ['click_a.txt', 'click_b.txt']) {
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(name)), '💥💥', 'editor changes must not cancel the held selection');
				}
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', source, 'down');
				assert.strictEqual(activeTabPath(), wsUri('click_c.txt').path, 'wheel continues from the batch endpoint');
				if (source === 'corsair') { await sleep(60_100); } // Physical holds end on release, not a one-minute timeout.
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction: 'next' });
				assert.strictEqual(git('diff --cached --name-only'), 'click_a.txt\nclick_b.txt\nclick_c.txt');
				assert.strictEqual(activeTabPath(), wsUri('click_d.txt').path);
				assert.ok(unrelated.document.isDirty && unrelatedTab.isDirty, 'unrelated unsaved edits survive');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the captured batch');
				await vscode.window.showTextDocument(unrelated.document);
				await vscode.commands.executeCommand('workbench.action.files.revert');
			} finally {
				await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
			}
		});
	}

	for (const drift of [false, true]) {
		test(`shrunk marked batch stages after editor clicks with list drift=${drift}`, async () => {
			const config = vscode.workspace.getConfiguration('better-git-vscode');
			await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
			try {
				for (const name of ['shrink_a.txt', 'shrink_b.txt', 'shrink_c.txt', 'shrink_d.txt']) { write(name, name); }
				await refreshUntil(() => isUntracked('shrink_d.txt'), 'shrink files');
				await openPlainAt('shrink_a.txt', 0);
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
				await openPlainAt('shrink_d.txt', 0);
				if (drift) { write('shrink_aa.txt', 'created elsewhere'); await refreshUntil(() => isUntracked('shrink_aa.txt'), 'inserted unselected file'); }
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'up');
				for (const name of ['shrink_a.txt', 'shrink_b.txt']) { assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(name)), '💥💥'); }
				assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri('shrink_c.txt')), '💥💥');
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair');
				await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
				for (const name of ['shrink_a.txt', 'shrink_b.txt', 'shrink_c.txt']) { assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(name)), '💥💥'); }
				assert.strictEqual(git('diff --cached --name-only'), 'shrink_a.txt\nshrink_b.txt', 'release must stage exactly the marked files despite unrelated list changes');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '');
			} finally { await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global); }
		});
	}

	test('released batch commits despite a simultaneous editor switch and does not steal focus', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		const prototype = Object.getPrototypeOf(repo);
		const originalAdd = prototype.add;
		let unblock!: () => void;
		try {
			for (const name of ['race_a.txt', 'race_b.txt', 'race_c.txt', 'race_other.txt']) { write(name, name); }
			await refreshUntil(() => isUntracked('race_other.txt'), 'release race files');
			await openPlainAt('race_a.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			let entered!: () => void;
			const staging = new Promise<void>(resolve => { entered = resolve; });
			const gate = new Promise<void>(resolve => { unblock = resolve; });
			prototype.add = async function (...args: unknown[]) { entered(); await gate; return originalAdd.apply(this, args); };
			const release = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await staging;
			await openPlainAt('race_other.txt', 0);
			unblock();
			await release;
			assert.strictEqual(git('diff --cached --name-only'), 'race_a.txt\nrace_b.txt', 'editor interaction must not discard a released stage');
			assert.strictEqual(activeTabPath(), wsUri('race_other.txt').path, 'commit must not pull focus back after a later click');
		} finally {
			unblock?.();
			prototype.add = originalAdd;
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('held preview backtracking shrinks the marked batch and stages only on release', async () => {
        const config = vscode.workspace.getConfiguration('better-git-vscode');
        await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
        try {
            for (const name of ['inspect_a.txt', 'inspect_b.txt', 'inspect_c.txt', 'inspect_d.txt', 'inspect_e.txt']) { write(name, name); }
            await refreshUntil(() => ['inspect_a.txt', 'inspect_b.txt', 'inspect_c.txt', 'inspect_d.txt', 'inspect_e.txt'].every(isUntracked), 'inspect batch files');
            await openPlainAt('inspect_b.txt', 0);
            await focusIsolatedTestWindow();
            await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
            await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
            await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
            await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'corsair', true);
            assert.strictEqual(activeTabPath(), wsUri('inspect_c.txt').path);
            for (const [direction, target] of [['next', 'inspect_d.txt'], ['next', 'inspect_e.txt'], ['previous', 'inspect_d.txt'], ['next', 'inspect_e.txt'], ['previous', 'inspect_d.txt']]) {
                await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', direction);
                assert.strictEqual(activeTabPath(), wsUri(target).path);
                assert.strictEqual(git('diff --cached --name-only'), '', 'wheel preview must never change the index');
            }
            for (const name of ['inspect_b.txt', 'inspect_c.txt']) {
                assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(name)), '💥💥', 'remaining pending files must stay marked');
            }
            assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('inspect_d.txt')), '👀');
            assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri('inspect_e.txt')), '💥💥',
                'backtracking must clear the departed file from the pending stage set');
            // Clicking and editing the currently previewed editor must not cancel the set.
            const editor = vscode.window.activeTextEditor;
            assert.ok(editor);
            editor.selection = new vscode.Selection(0, 2, 0, 2);
            await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
            assert.strictEqual(git('diff --cached --name-only'), 'inspect_b.txt\ninspect_c.txt');
            assert.strictEqual(activeTabPath(), wsUri('inspect_d.txt').path, 'excluded eyes file stays open');
            assert.deepStrictEqual(editor.selection, new vscode.Selection(0, 2, 0, 2));
            await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
            assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo must reverse the whole released batch');
            assert.strictEqual(activeTabPath(), wsUri('inspect_b.txt').path, 'Undo returns to a file in the staged batch');
        } finally {
            await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
        }
    });

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`held mode toggles keep reverse removal consistent for ${source} ${direction}`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					const names = ['toggle_a.txt', 'toggle_b.txt', 'toggle_c.txt', 'toggle_d.txt', 'toggle_e.txt'];
					for (const name of names) { write(name, name); }
					await refreshUntil(() => names.every(isUntracked), 'toggle files');
					const step = direction === 'next' ? 1 : -1;
					const start = direction === 'next' ? 1 : 3;
					const reverse = direction === 'next' ? 'previous' : 'next';
					await openPlainAt(names[start], 0);
					await focusIsolatedTestWindow();
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					const mode = (on: boolean) => vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, on);
					const wheel = (eyes: boolean, forward: boolean) => vscode.commands.executeCommand(
						eyes ? 'better-git-vscode.navigate-mouse-stage-preview' : 'better-git-vscode.adjust-mouse-stage-selection',
						source, eyes ? (forward ? direction : reverse) : ((forward ? step : -step) > 0 ? 'down' : 'up'));
					const firstEyes = direction === 'next';
					await mode(firstEyes);
					await wheel(firstEyes, true);
					await mode(!firstEyes);
					await wheel(!firstEyes, true);
					for (const on of [true, false, true, false]) {
						await mode(on);
						assert.strictEqual(activeTabPath(), wsUri(names[start + 2 * step]).path, 'toggles cannot navigate');
						for (const i of [start, start + step]) {
							assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[i])), '💥💥', 'toggles cannot alter the pending set');
						}
					}
					await wheel(false, false);
					assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[start + 2 * step])), '💥💥', 'file reverse must remove the departed file');
					await mode(true);
					await wheel(true, false);
					assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[start + step])), '💥💥', 'eyes reverse must remove the departed file');
					await mode(false);
					await wheel(false, false);
					assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[start])), '💥💥', 'reverse must also remove the starting file when crossing it');
					assert.strictEqual(git('diff --cached --name-only'), '', 'all selection edits remain pending until release');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), names[start - step], 'release stages only the remaining destination');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the exact reduced batch');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
				}
			});
		}
	}

	test('queued file backtracking after eyes toggle finishes before release', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			const names = ['queue_a.txt', 'queue_b.txt', 'queue_c.txt'];
			for (const name of names) { write(name, name); }
			await refreshUntil(() => names.every(isUntracked), 'queued toggle files');
			await openPlainAt(names[0], 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'corsair', true);
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'corsair', false);
			const steps = [0, 1].map(() => vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'up'));
			const release = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await Promise.all([...steps, release]);
			assert.strictEqual(git('diff --cached --name-only'), names[0], 'pre-release file ratchets must edit the released selection rather than resurrect or drop it');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`eyes release excludes the current file for ${source} ${direction}`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					const names = ['exclude_a.txt', 'exclude_b.txt', 'exclude_c.txt'];
					for (const name of names) { write(name, name); }
					await refreshUntil(() => names.every(isUntracked), 'eyes exclude files');
					const start = direction === 'next' ? 0 : 2;
					const endpoint = 2 - start;
					await openPlainAt(names[start], 0);
					await focusIsolatedTestWindow();
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					for (let n = 0; n < 2; n++) {
						await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', source, direction === 'next' ? 'down' : 'up');
					}
					await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, true);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[endpoint])), '👀');
					const editor = visibleEditorFor(wsUri(names[endpoint]))!;
					editor.selection = new vscode.Selection(0, 2, 0, 4);
					const selection = editor.selection;
					const top = editor.visibleRanges[0].start.line;
					const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), names.filter((_, i) => i !== endpoint).join('\n'));
					assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'release must not reopen or advance the excluded preview');
					assert.deepStrictEqual(editor.selection, selection, 'excluded preview cursor remains exact');
					assert.strictEqual(editor.visibleRanges[0].start.line, top, 'excluded preview viewport remains exact');
					assert.ok(isUntracked(names[endpoint]), 'the eyes file remains unstaged');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores only the released batch');
					// The next ordinary hold must not inherit the prior eyes release policy.
					await openPlainAt(names[endpoint], 0);
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), names[endpoint], 'ordinary file mode still stages its current file');
				} finally { await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global); }
			});
		}
	}

	// App switching must finish a release-to-stage keyboard batch just like a physical mouse batch.
	// Keep this in the same real-focus matrix so a new input owner cannot silently lose the earlier fix.
	for (const source of ['corsair', 'razer', 'keyboard']) {
		for (const direction of ['next', 'previous']) {
			for (const eyes of [false, true]) {
				test(`app switch commits the reduced ${source} ${direction} ${eyes ? 'eyes' : 'file'} batch without its current preview`, async () => {
					const config = vscode.workspace.getConfiguration('better-git-vscode');
					const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
					await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
					try {
						write('switch_history.txt', 'earlier stage');
						const names = ['switch_a.txt', 'switch_b.txt', 'switch_c.txt', 'switch_d.txt'];
						for (const name of names) { write(name, name); }
						await refreshUntil(() => isUntracked('switch_history.txt') && names.every(isUntracked), 'app switch files');
						await openPlainAt('switch_history.txt', 0);
						await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
						const priorIndex = git('write-tree');
						const start = direction === 'next' ? 0 : 3;
						await openPlainAt(names[start], 0);
						await focusIsolatedTestWindow();
						if (source === 'keyboard') {
							await vscode.commands.executeCommand('better-git-vscode.begin-keyboard-review', direction);
							if (!eyes) { await vscode.commands.executeCommand('better-git-vscode.toggle-keyboard-review', direction); }
						} else {
							await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
							await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
							await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, eyes);
						}
						const move = (step: string) => source === 'keyboard'
							? vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', step === 'down' ? 'next' : 'previous')
							: vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', source, step);
						const finish = () => source === 'keyboard'
							? vscode.commands.executeCommand('better-git-vscode.finish-keyboard-review')
							: vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
						const forward = direction === 'next' ? 'down' : 'up';
						for (let n = 0; n < 3; n++) {
							await move(forward);
						}
						await move(direction === 'next' ? 'up' : 'down');
						const endpoint = direction === 'next' ? 2 : 1;
						assert.strictEqual(activeTabPath(), wsUri(names[endpoint]).path, 'backtracking must reduce the batch before the app switch');
						const editor = visibleEditorFor(wsUri(names[endpoint]))!;
						editor.selection = new vscode.Selection(0, 1, 0, 3);
						const cursor = editor.selection;
						const top = editor.visibleRanges[0].start.line;
						const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
						await switchAwayFromIsolatedTestWindow();
						const expected = [...(direction === 'next' ? names.slice(0, 2) : names.slice(2)), 'switch_history.txt'].sort().join('\n');
						await poll(() => git('diff --cached --name-only') === expected, 'interrupted batch to stage in the background');
						assert.strictEqual(vscode.window.state.focused, false, 'background stage must not reactivate VS Code');
						assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'interruption must not navigate');
						assert.deepStrictEqual(editor.selection, cursor);
						assert.strictEqual(editor.visibleRanges[0].start.line, top);
						await finish();
						await focusIsolatedTestWindow();
						await finish();
						assert.strictEqual(git('diff --cached --name-only'), expected, 'late and repeated physical releases must be inert');
						await extensionApi.whenStageTransactionsSettled();
						await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
						assert.strictEqual(git('write-tree'), priorIndex, 'one exact Undo restores the prior index including earlier stages');
						for (const name of names) { assert.strictEqual(fs.readFileSync(wsUri(name).fsPath, 'utf8'), name); }
					} finally {
						await focusIsolatedTestWindow();
						await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
					}
				});
			}
		}
	}

	for (const state of ['short', 'single', 'cancelled']) {
		test(`app switch keeps an empty ${state} hold inert`, async () => {
			const config = vscode.workspace.getConfiguration('better-git-vscode');
			const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
			await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
			try {
				write('switch_only.txt', 'still reviewing');
				await refreshUntil(() => isUntracked('switch_only.txt'), 'single app switch file');
				await openPlainAt('switch_only.txt', 0);
				await focusIsolatedTestWindow();
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
				if (state !== 'short') { await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair'); }
				if (state === 'cancelled') { await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', 'corsair'); }
				await switchAwayFromIsolatedTestWindow();
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
				await focusIsolatedTestWindow();
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
				assert.strictEqual(git('diff --cached --name-only'), '', 'short, excluded-only and explicitly cancelled holds cannot stage');
				assert.strictEqual(activeTabPath(), wsUri('switch_only.txt').path);
			} finally {
				await focusIsolatedTestWindow();
				await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
			}
		});
	}

	// Ethan: after reviewing the last file, an extra ratchet approves it too. All owners share that pending
	// decision; neither the final hunk itself nor a mode toggle may stage early or leave an endless eyes file.
	for (const source of ['corsair', 'razer', 'keyboard', 'wand'] as const) {
		for (const direction of ['next', 'previous'] as const) {
			test(`eyes terminal boundary marks the final file for ${source} ${direction}`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				const ext = vscode.workspace.getConfiguration('extensions');
				const handlers = ext.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				await ext.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
				const names = ['terminal_a.txt', 'terminal_b.txt'];
				const start = direction === 'next' ? 0 : 1, endpoint = 1 - start;
				const id = randomUUID(); let seq = 0;
				const wand = (phase: string) => deliverMouseUri(`wand-review/${phase}`, 'wand',
					new URLSearchParams({ version: '1', id, seq: String(++seq), direction, mode: 'changes' }).toString());
				const step = () => source === 'wand' ? wand('step') : source === 'keyboard'
					? vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', direction)
					: vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', source, direction);
				const finish = () => source === 'wand' ? wand('finish') : source === 'keyboard'
					? vscode.commands.executeCommand('better-git-vscode.finish-keyboard-review')
					: vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
				try {
					for (const name of names) { write(name, name); }
					await refreshUntil(() => names.every(isUntracked), 'terminal eyes files');
					await openPlainAt(names[start], 0); await focusIsolatedTestWindow();
					if (source === 'wand') { await wand('begin'); }
					else if (source === 'keyboard') { await vscode.commands.executeCommand('better-git-vscode.begin-keyboard-review', direction); }
					else {
						await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction, initialMode: 'changes' });
						await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					}
					await poll(() => extensionApi.getReviewDecorationBadge(wsUri(names[start])) === '👀', 'fresh terminal journey eyes entry');
					await step(); await expectActiveTab(names[endpoint]);
					await poll(() => extensionApi.getReviewDecorationBadge(wsUri(names[endpoint])) === '👀', 'last file remains preview until its boundary');
					await step();
					await poll(() => extensionApi.getReviewDecorationBadge(wsUri(names[endpoint])) === '💥💥', 'explicit final step approves terminal file');
					await step(); // Further outward input must neither wrap nor discard the terminal decision.
					assert.strictEqual(activeTabPath(), wsUri(names[endpoint]).path);
					assert.strictEqual(git('diff --cached --name-only'), '', 'even the terminal approval stays pending until release');
					await finish(); await poll(() => git('diff --cached --name-only') === names.join('\n'), 'terminal release stages the complete set');
					await finish();
					assert.strictEqual(git('diff --cached --name-only'), names.join('\n'), 'repeated release cannot add another transaction');
					await extensionApi.whenStageTransactionsSettled();
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'one exact Undo restores the complete terminal batch');
				} finally {
					if (source === 'wand') { await wand('cancel'); }
					else if (source === 'keyboard') { await vscode.commands.executeCommand('better-git-vscode.cancel-keyboard-review'); }
					else { await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source); }
					await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
					await ext.update('confirmedUriHandlerExtensionIds', handlers, vscode.ConfigurationTarget.Global);
				}
			});
		}
	}

	test('eyes terminal approval queued before mouse release is retained', async () => {
		write('terminal_only.txt', 'only file');
		await refreshUntil(() => isUntracked('terminal_only.txt'), 'single terminal file');
		await openPlainAt('terminal_only.txt', 0); await focusIsolatedTestWindow();
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next', initialMode: 'changes' });
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
		const step = vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
		const finish = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		await Promise.all([step, finish]);
		assert.strictEqual(git('diff --cached --name-only'), 'terminal_only.txt', 'release snapshots the admitted terminal decision, not the old eyes endpoint');
		await extensionApi.whenStageTransactionsSettled();
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('diff --cached --name-only'), '');
	});

	test('eyes terminal modified file stays preview until all its hunks are passed', async () => {
		const content = lines(40, 'mod_a').split('\n'); content[4] = 'first EDIT'; content[24] = 'last EDIT';
		write('committed/mod_a.txt', content.join('\n') + '\n');
		await refreshUntil(() => inWorkingTree('committed/mod_a.txt', 5), 'terminal modified file');
		await openWorkingDiffAt('committed/mod_a.txt', 0); await focusIsolatedTestWindow();
		await vscode.commands.executeCommand('better-git-vscode.begin-keyboard-review', 'next');
		for (let n = 0; n < 2; n++) {
			await vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', 'next');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('committed/mod_a.txt')), '👀', 'viewing a hunk alone is not approval');
		}
		for (let n = 0; n < 6 && extensionApi.getReviewDecorationBadge(wsUri('committed/mod_a.txt')) !== '💥💥'; n++) {
			await vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', 'next');
		}
		assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('committed/mod_a.txt')), '💥💥');
		assert.strictEqual(git('diff --cached --name-only'), '');
		await vscode.commands.executeCommand('better-git-vscode.finish-keyboard-review');
		assert.strictEqual(git('diff --cached --name-only'), 'committed/mod_a.txt');
		await extensionApi.whenStageTransactionsSettled();
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('diff --cached --name-only'), '');
	});

	test('eyes-only release is inert and preserves earlier Undo history', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			write('exclude_history.txt', 'history'); write('exclude_only.txt', 'still reviewing');
			await refreshUntil(() => isUntracked('exclude_history.txt') && isUntracked('exclude_only.txt'), 'eyes only files');
			await openPlainAt('exclude_history.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
			await openPlainAt('exclude_only.txt', 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'corsair', true);
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.strictEqual(git('diff --cached --name-only'), 'exclude_history.txt', 'empty and repeated releases cannot stage the origin');
			assert.strictEqual(activeTabPath(), wsUri('exclude_only.txt').path, 'empty batch cannot navigate');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '', 'empty release cannot add a phantom Undo receipt');
		} finally { await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global); }
	});

	test('eyes release excludes the final endpoint after queued readiness and ratchets', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			const names = ['late_a.txt', 'late_b.txt', 'late_c.txt'];
			for (const name of names) { write(name, name); }
			await refreshUntil(() => names.every(isUntracked), 'late eyes files');
			await openPlainAt(names[0], 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'razer', true);
			const ready = vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
			const steps = [0, 1].map(() => vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'razer', 'next'));
			const release = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'razer', false);
			await Promise.all([ready, ...steps, release]);
			assert.strictEqual(git('diff --cached --name-only'), names.slice(0, 2).join('\n'), 'exclude the settled endpoint, not the stale release-arrival endpoint');
			assert.strictEqual(activeTabPath(), wsUri(names[2]).path);
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally { await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global); }
	});


    for(const mode of ["changes","files"] as const){for(const direction of ["next","previous"] as const){
        test(`wand review native URI ${mode} ${direction} stages the existing selected range once`,async()=>{
            const config=vscode.workspace.getConfiguration('better-git-vscode');
            const ext=vscode.workspace.getConfiguration('extensions');
            const previous=ext.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
            await ext.update('confirmedUriHandlerExtensionIds',['ethansk.better-git-vscode'],vscode.ConfigurationTarget.Global);
            await config.update('experimentalMouseHoldNavigateOnButtonDown',false,vscode.ConfigurationTarget.Global);
            try{
                const names=['wand_a.txt','wand_b.txt','wand_c.txt'];for(const name of names){write(name,name);}
                await refreshUntil(()=>names.every(isUntracked),'wand review fixtures');
                const start=direction==='next'?0:2,endpoint=1;
                await openPlainAt(names[start],0);await focusIsolatedTestWindow();
                const id=randomUUID();
                const send=(phase:string,seq:number)=>deliverMouseUri('wand-review/'+phase,'wand',new URLSearchParams({version:'1',id,seq:String(seq),direction,mode}).toString());
                await send('begin',1);
                await poll(()=>extensionApi.getReviewDecorationBadge(wsUri(names[start]))===(mode==='changes'?'👀':'💥💥'),'wand mode matches Eyes or file review');
                assert.strictEqual(git('diff --cached --name-only'),'');
                await send('step',2);await poll(()=>activeTabPath()===wsUri(names[endpoint]).path,'wand detent');
                assert.strictEqual(git('diff --cached --name-only'),'','navigation only marks; release owns staging');
                // Deliberately deliver finish before an earlier heartbeat. It must
                // wait for the gap instead of staging an incomplete gesture.
                await send('finish',4);assert.strictEqual(git('diff --cached --name-only'),'');
                await send('heartbeat',3);
                const expected=(mode==='changes'?[names[start]]:[names[start],names[endpoint]]).sort().join('\n');
                await poll(()=>git('diff --cached --name-only')===expected,'wand release exact index');
                await send('finish',4);assert.strictEqual(git('diff --cached --name-only'),expected,'duplicate release inert');
                await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');assert.strictEqual(git('diff --cached --name-only'),'');
            }finally{await ext.update('confirmedUriHandlerExtensionIds',previous,vscode.ConfigurationTarget.Global);}
        });
    }}
    for (const mode of ['changes', 'files'] as const) {
        test(`wand review direction reversal ${mode} preserves the set beyond its starting file`, async () => {
            const ext = vscode.workspace.getConfiguration('extensions');
            const previous = ext.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
            await ext.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
            try {
                const names = ['reverse_a.txt', 'reverse_b.txt', 'reverse_c.txt', 'reverse_d.txt'];
                for (const name of names) { write(name, name); }
                await refreshUntil(() => names.every(isUntracked), 'wand reverse fixtures');
                await openPlainAt(names[1], 0); await focusIsolatedTestWindow();
                const id = randomUUID(); let seq = 0;
                const send = (phase: string, direction: string) => deliverMouseUri('wand-review/' + phase, 'wand',
                    new URLSearchParams({ version: '1', id, seq: String(++seq), direction, mode }).toString());
                await send('begin', 'previous');
                await send('step', 'previous');
                await poll(() => activeTabPath() === wsUri(names[0]).path, 'previous first');
                for (const index of [1, 2, 3]) {
                    await send('step', 'next');
                    await poll(() => activeTabPath() === wsUri(names[index]).path, 'forward beyond starting file');
                    assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[index])), mode === 'changes' ? '👀' : '💥💥');
                }
                assert.strictEqual(git('diff --cached --name-only'), '', 'circles never stage early');
                await send('finish', 'previous');
                const expected = names.slice(1, mode === 'changes' ? 3 : 4).join('\n');
                await poll(() => git('diff --cached --name-only') === expected, 'reversed full set staged');
                await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
                assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the full set');
            } finally { await ext.update('confirmedUriHandlerExtensionIds', previous, vscode.ConfigurationTarget.Global); }
        });
    }
    test('wand review app switch never stages an unconfirmed set', async () => {
        const ext = vscode.workspace.getConfiguration('extensions');
        const previous = ext.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
        await ext.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
        try {
            const names = ['unconfirmed_a.txt', 'unconfirmed_b.txt'];
            for (const name of names) { write(name, name); }
            await refreshUntil(() => names.every(isUntracked), 'unconfirmed wand files');
            await openPlainAt(names[0], 0); await focusIsolatedTestWindow();
            const id = randomUUID();
            const send = (phase: string, seq: number) => deliverMouseUri('wand-review/' + phase, 'wand',
                new URLSearchParams({ version: '1', id, seq: String(seq), direction: 'next', mode: 'changes' }).toString());
            await send('begin', 1); await send('step', 2);
            await poll(() => activeTabPath() === wsUri(names[1]).path, 'unconfirmed preview');
            await switchAwayFromIsolatedTestWindow();
            await extensionApi.whenStageTransactionsSettled();
            assert.strictEqual(git('diff --cached --name-only'), '', 'leaving the app is not confirmation');
            await focusIsolatedTestWindow(); await send('cancel', 3);
            assert.strictEqual(git('diff --cached --name-only'), '', 'cancellation leaves the index unchanged');
        } finally {
            await focusIsolatedTestWindow();
            await ext.update('confirmedUriHandlerExtensionIds', previous, vscode.ConfigurationTarget.Global);
        }
    });
	test('mouse preview mode URI reaches the real handler for both mouse sources', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousLogging = config.inspect<boolean>('debugLogging')?.globalValue;
		const extensionConfig = vscode.workspace.getConfiguration('extensions');
		const previousHandlers = extensionConfig.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
		const before = git('status --porcelain');
		try {
			// Consent belongs only to our disposable test profile, never Ethan's normal profile.
			await extensionConfig.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
			await config.update('debugLogging', true, vscode.ConfigurationTarget.Global);
			for (const source of ['corsair', 'razer']) {
				for (const mode of ['on', 'off']) {
					extensionApi.clearMouseDebugTrace();
					await deliverMouseUri(`mouse-stage-preview-mode/${mode}`, source);
					const expected = `${source === 'corsair' ? 'Corsair' : 'Razer'} stage preview mode ${mode === 'on' ? 'ignored, no stage-ready hold is active' : 'off'}.`;
					await poll(() => extensionApi.getMouseDebugTrace().includes(expected), `native ${source} mode-${mode} URI delivery`);
				}
			}
			assert.strictEqual(git('status --porcelain'), before, 'mode-only URI must never stage or open a worktree');
		} finally {
			await config.update('debugLogging', previousLogging, vscode.ConfigurationTarget.Global);
			await extensionConfig.update('confirmedUriHandlerExtensionIds', previousHandlers, vscode.ConfigurationTarget.Global);
		}
	});

	test('mouse stage-preview mode toggles without navigating and clears on owner release', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const extensionConfig = vscode.workspace.getConfiguration('extensions');
		const previousHandlers = extensionConfig.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			await extensionConfig.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
			for (const name of ['mode_a.txt', 'mode_b.txt', 'mode_c.txt']) { write(name, name); }
			await refreshUntil(() => ['mode_a.txt', 'mode_b.txt', 'mode_c.txt'].every(isUntracked), 'preview-mode files');
			await openPlainAt('mode_b.txt', 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_b.txt')), '💥💥');
			await deliverMouseUri('mouse-stage-preview-mode/on', 'corsair');
			await poll(() => extensionApi.getReviewDecorationBadge(wsUri('mode_b.txt')) === '👀', 'mode-on URI to mark the held file');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_b.txt')), '👀');
			assert.strictEqual(activeTabPath(), wsUri('mode_b.txt').path, 'mode entry must not advance the review');
			assert.strictEqual(git('diff --cached --name-only'), '', 'mode entry must not stage');
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'razer', false);
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_b.txt')), '👀', 'another mouse cannot clear the badge');
			await deliverMouseUri('mouse-stage-preview/next', 'corsair');
			await poll(() => activeTabPath() === wsUri('mode_c.txt').path, 'adjacent preview URI to preview the next file');
			assert.strictEqual(git('diff --cached --name-only'), '', 'preview must leave both files unstaged');
			assert.strictEqual(activeTabPath(), wsUri('mode_c.txt').path);
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')), '👀', 'badge follows the reviewed file');
			await deliverMouseUri('mouse-stage-preview-mode/off', 'corsair');
			await poll(() => extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')) === '💥💥', 'mode-off URI to clear eyes');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')), '💥💥', 'off restores the stage-ready badge');
			assert.strictEqual(activeTabPath(), wsUri('mode_c.txt').path, 'off must not navigate');
			await deliverMouseUri('mouse-stage-preview-mode/on', 'corsair');
			await poll(() => extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')) === '👀', 'second mode-on URI');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')), '👀');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri('mode_c.txt')), '👀');
			assert.strictEqual(git('diff --cached --name-only'), 'mode_b.txt');
			assert.strictEqual(activeTabPath(), wsUri('mode_c.txt').path);
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
			await extensionConfig.update('confirmedUriHandlerExtensionIds', previousHandlers, vscode.ConfigurationTarget.Global);
		}
	});

	test('Agentic Mouse button-down owns initial eyes mode even when the mode URI overtakes it', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousLogging = config.inspect<boolean>('debugLogging')?.globalValue;
		const extensionConfig = vscode.workspace.getConfiguration('extensions');
		const previousHandlers = extensionConfig.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			await extensionConfig.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
			await config.update('debugLogging', true, vscode.ConfigurationTarget.Global);
			write('atomic_eyes.txt', 'first line\nsecond line\nthird line');
			await refreshUntil(() => isUntracked('atomic_eyes.txt'), 'atomic eyes file');
			const manifest = vscode.extensions.getExtension('EthanSK.better-git-vscode')!.packageJSON;
			const bindings = manifest.contributes.keybindings as Array<{
				command: string; args?: { source?: string; direction?: string; initialMode?: string };
			}>;
			for (const source of ['corsair', 'razer']) {
				for (const direction of ['next', 'previous']) {
					await openPlainAt('atomic_eyes.txt', 0);
					vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 1, 0);
					await focusIsolatedTestWindow();
					const start = vscode.window.activeTextEditor!.selection;
					const binding = bindings.find(item => item.command === 'better-git-vscode.begin-mouse-navigation-hold'
						&& item.args?.source === source && item.args?.direction === direction && item.args?.initialMode === 'changes');
					assert.ok(binding, 'test the shipped physical binding, not a copied test-only mode');
					// Live failure: the URI arrived about 300 ms BEFORE button-down and was rejected.
					// Do not wait or replay it after Begin: the same input must own both hold and default.
					await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, true);
					await vscode.commands.executeCommand(binding!.command, binding!.args);
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('atomic_eyes.txt')), '👀', `${source} ${direction} must start eyes`);
					assert.deepStrictEqual(vscode.window.activeTextEditor!.selection, start, 'eyes entry stays still');
					assert.strictEqual(git('diff --cached --name-only'), '', 'entry never stages');
					await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, false);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('atomic_eyes.txt')), '💥💥', 'intentional toggle still selects the full file');
					extensionApi.clearMouseDebugTrace();
					await deliverMouseUri('mouse-stage-preview-mode/on', source, `source=${source}&initial=1`);
					await poll(() => extensionApi.getMouseDebugTrace().some(line => line.includes('initial preview URI ignored;')), 'late bootstrap URI delivery');
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('atomic_eyes.txt')), '💥💥', 'late bootstrap must not overwrite the explicit explosion toggle');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), 'atomic_eyes.txt', 'intentional file-mode release still stages the exact file');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'one exact Undo restores that release');
					// A new hold resets the prior explosion mode even if readiness queues before capture settles.
					const begin = vscode.commands.executeCommand(binding!.command, binding!.args);
					const ready = vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					await Promise.all([begin, ready]);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('atomic_eyes.txt')), '👀', 'fresh hold always resets to review');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), '', 'releasing a lone eyes preview never stages it');
				}
			}
		} finally {
			await config.update('debugLogging', previousLogging, vscode.ConfigurationTarget.Global);
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
			await extensionConfig.update('confirmedUriHandlerExtensionIds', previousHandlers, vscode.ConfigurationTarget.Global);
		}
	});

	test('duplicate hold readiness preserves the selected batch and intentional file mode', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['ready_a.txt', 'ready_b.txt', 'ready_c.txt']) { write(name, name); }
			await refreshUntil(() => isUntracked('ready_c.txt'), 'duplicate readiness files');
			for (const source of ['corsair', 'razer']) {
				for (const direction of ['next', 'previous']) {
					await openPlainAt('ready_b.txt', 0);
					await focusIsolatedTestWindow();
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction, initialMode: 'changes' });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', source, false);
					await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', source, direction === 'next' ? 'down' : 'up');
					const endpoint = direction === 'next' ? 'ready_c.txt' : 'ready_a.txt';
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(endpoint)), '💥💥');
					// Repeated delivery of the same threshold is not a new gesture and must not rebuild its set.
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(endpoint)), '💥💥', 'duplicate readiness must keep the marked endpoint');
					assert.strictEqual(activeTabPath(), wsUri(endpoint).path, 'duplicate readiness must not return to the origin');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), direction === 'next' ? 'ready_b.txt\nready_c.txt' : 'ready_a.txt\nready_b.txt');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'one exact Undo restores the preserved batch');
				}
			}
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('default eyes URI can arrive before readiness without moving or leaking to the next hold', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousLogging = config.inspect<boolean>('debugLogging')?.globalValue;
		const extensionConfig = vscode.workspace.getConfiguration('extensions');
		const previousHandlers = extensionConfig.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			await extensionConfig.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
			await config.update('debugLogging', true, vscode.ConfigurationTarget.Global);
			write('default_eyes.txt', 'first line\nsecond line\nthird line');
			await refreshUntil(() => isUntracked('default_eyes.txt'), 'default eyes file');
			for (const source of ['corsair', 'razer']) {
				await openPlainAt('default_eyes.txt', 0);
				vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 1, 0);
				await focusIsolatedTestWindow();
				const startSelection = vscode.window.activeTextEditor!.selection;
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction: 'next' });
				extensionApi.clearMouseDebugTrace();
				await deliverMouseUri('mouse-stage-preview-mode/on', source);
				const label = source === 'corsair' ? 'Corsair' : 'Razer';
				await poll(() => extensionApi.getMouseDebugTrace().some(line => line.startsWith(`${label} stage preview mode `)), 'mode URI to arrive before readiness');
				assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri('default_eyes.txt')), '👀', 'no ready selection means no eyes yet');
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
				assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('default_eyes.txt')), '👀', 'the early URI must latch for this owner');
				assert.strictEqual(activeTabPath(), wsUri('default_eyes.txt').path);
				assert.deepStrictEqual(vscode.window.activeTextEditor!.selection, startSelection, 'default eyes entry must preserve the cursor');
				assert.strictEqual(git('diff --cached --name-only'), '', 'readiness and eyes entry must not stage');
				await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
				assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri('default_eyes.txt')), '👀', 'cancel must clear the early URI');
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction: 'next' });
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
				assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('default_eyes.txt')), '💥💥', 'the next hold must not inherit eyes');
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction: 'next' });
				assert.strictEqual(git('diff --cached --name-only'), 'default_eyes.txt');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the exact staged set');
			}
		} finally {
			await config.update('debugLogging', previousLogging, vscode.ConfigurationTarget.Global);
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
			await extensionConfig.update('confirmedUriHandlerExtensionIds', previousHandlers, vscode.ConfigurationTarget.Global);
		}
	});

	test('rapid held preview ratchets finish before release stages their accumulated batch', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['burst_a.txt', 'burst_b.txt', 'burst_c.txt', 'burst_d.txt', 'burst_e.txt']) { write(name, name); }
			await refreshUntil(() => ['burst_a.txt', 'burst_b.txt', 'burst_c.txt', 'burst_d.txt', 'burst_e.txt'].every(isUntracked), 'burst files');
			await openPlainAt('burst_a.txt', 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			const ratchets = Array.from({ length: 3 }, () =>
				vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next'));
			const release = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await Promise.all([...ratchets, release]);
			assert.strictEqual(git('diff --cached --name-only'), 'burst_a.txt\nburst_b.txt\nburst_c.txt\nburst_d.txt',
				'every ratchet accepted before release must add its file before the single batch stage');
			assert.strictEqual(activeTabPath(), wsUri('burst_e.txt').path,
				'release stages the final reviewed file and advances to the next unstaged file');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			assert.strictEqual(git('diff --cached --name-only'), 'burst_a.txt\nburst_b.txt\nburst_c.txt\nburst_d.txt',
				'a ratchet arriving after release must be inert');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('rapid held preview backtracking finishes before release commits the reduced batch', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['retract_a.txt', 'retract_b.txt', 'retract_c.txt']) { write(name, name); }
			await refreshUntil(() => ['retract_a.txt', 'retract_b.txt', 'retract_c.txt'].every(isUntracked), 'retract files');
			await openPlainAt('retract_a.txt', 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
			await vscode.commands.executeCommand('better-git-vscode.set-mouse-stage-preview-mode', 'razer', true);
			const ratchets = ['next', 'next', 'previous', 'next', 'previous'].map(direction =>
				vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'razer', direction));
			const release = vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			await Promise.all([...ratchets, release]);
			assert.strictEqual(git('diff --cached --name-only'), 'retract_a.txt',
				'queued reverse ratchets must remove the departed file before the single release transaction');
			assert.strictEqual(activeTabPath(), wsUri('retract_b.txt').path);
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo reverses the reduced batch');
			assert.strictEqual(activeTabPath(), wsUri('retract_a.txt').path);
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('held Razer preview wheel reviews hunks and previous files without staging before release', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			const a = lines(40, 'mod_a').split('\n');
			a[4] = 'mod_a first hunk EDITED';
			a[24] = 'mod_a second hunk EDITED';
			write('committed/mod_a.txt', a.join('\n') + '\n');
			const d = lines(40, 'mod_d').split('\n');
			d[4] = 'mod_d first hunk EDITED';
			d[24] = 'mod_d second hunk EDITED';
			write('committed/mod_d.txt', d.join('\n') + '\n');
			await refreshUntil(
				() => inWorkingTree('committed/mod_a.txt', 5) && inWorkingTree('committed/mod_d.txt', 5),
				'two modified files for held reverse review'
			);
			await openWorkingDiffAt('committed/mod_d.txt', 24);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', {
				source: 'razer', direction: 'previous'
			});
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'razer', 'previous');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_d.txt').path,
				'first reverse ratchet must remain in the file');
			assert.strictEqual(git('diff --cached --name-only'), '',
				'within-file hunk navigation must not stage prematurely');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'razer', 'previous');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_d.txt').path,
				'selecting the first hunk must still keep the review in the same file');
            // Viewport anchoring may first select a visible hunk without scrolling;
            // require bounded progress rather than a host-layout-specific press count.
            for (let step = 0; step < 6 && activeTabPath() === wsUri('committed/mod_d.txt').path; step++) {
                await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'razer', 'previous');
                assert.strictEqual(git('diff --cached --name-only'), '', 'every reverse ratchet must remain a preview');
            }
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_a.txt').path,
				'crossing the first hunk after selecting it must open the previous unstaged file');
			assert.strictEqual(git('diff --cached --name-only'), '',
				'crossing the file boundary must leave the pending batch unstaged');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('committed/mod_d.txt')), '💥💥');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', {
				source: 'razer', direction: 'previous'
			});
			assert.strictEqual(git('diff --cached --name-only'), 'committed/mod_a.txt\ncommitted/mod_d.txt',
				'releasing the main hold must stage the final file once');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('held preview at the final file retains readiness and stages once on release', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			write('inspect_final.txt', 'last unstaged file');
			await refreshUntil(() => isUntracked('inspect_final.txt'), 'final untracked file');
			await openPlainAt('inspect_final.txt', 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', {
				source: 'corsair', direction: 'next'
			});
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			assert.strictEqual(git('diff --cached --name-only'), '',
				'the final file must remain unstaged while held');
			assert.strictEqual(activeTabPath(), wsUri('inspect_final.txt').path,
				'exhausting this worktree must not open another repository');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('inspect_final.txt')), '💥💥',
				'the final file must remain ready until release');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', {
				source: 'corsair', direction: 'next'
			});
			assert.strictEqual(git('diff --cached --name-only'), 'inspect_final.txt',
				'releasing must stage the pending file once');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '',
				'the released stage must have one Undo receipt');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('stage-ready wheel previews endpoint diffs and cancel restores the exact original diff view', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			const first = lines(40, 'preview_a').split('\n');
			first[25] = 'preview_a changed line';
			const second = lines(10, 'preview_d').split('\n');
			second[4] = 'preview_d changed line';
			const third = lines(260, 'preview_e').split('\n');
			third[110] = 'preview_e changed line';
			write('committed/mod_a.txt', first.join('\n'));
			write('committed/mod_d.txt', second.join('\n'));
			write('committed/tall_e.txt', third.join('\n'));
			await refreshUntil(
				() => ['committed/mod_a.txt', 'committed/mod_d.txt', 'committed/tall_e.txt'].every(rel => inWorkingTree(rel, 5)),
				'wheel preview diff files'
			);

			const originalEditor = await openWorkingDiffAt('committed/mod_a.txt', 25);
			originalEditor.selection = new vscode.Selection(25, 2, 25, 7);
			originalEditor.revealRange(new vscode.Range(18, 0, 18, 0), vscode.TextEditorRevealType.AtTop);
			await sleep(100);
			const originalSelection = originalEditor.selection;
			const originalTop = originalEditor.visibleRanges[0].start.line;

			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_d.txt').path);
			assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'wheel endpoint must open as a diff preview');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'down');
			assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);
			assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'each newly selected endpoint must replace the main diff preview');

			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', 'corsair');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_a.txt').path, 'cancel must restore the pre-selection file');
			assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'cancel must restore the original diff view');
			const restored = visibleEditorFor(wsUri('committed/mod_a.txt'))!;
			assert.deepStrictEqual(restored.selection, originalSelection, 'cancel must restore the original cursor selection');
			assert.strictEqual(restored.visibleRanges[0].start.line, originalTop, 'cancel must restore the original viewport');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.strictEqual(git('diff --cached --name-only'), '', 'release after cancel must remain inert');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_a.txt').path);
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('stage-ready wheel can grow above the anchor and ignores another mouse source', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['range_a.txt', 'range_b.txt', 'range_c.txt', 'range_d.txt']) { write(name, name); }
			await refreshUntil(() => ['range_a.txt', 'range_b.txt', 'range_c.txt', 'range_d.txt'].every(isUntracked), 'upward range files');
			await openPlainAt('range_c.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'previous' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', 'up');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_b.txt')), undefined, 'other source must not own the hold');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'razer', 'up');
			await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'razer', 'up');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_a.txt')), '💥💥');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_b.txt')), '💥💥');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_c.txt')), '💥💥');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'previous' });
			assert.deepStrictEqual(git('diff --cached --name-only').split('\n'), ['range_a.txt', 'range_b.txt', 'range_c.txt']);
			assert.strictEqual(activeTabPath(), wsUri('range_d.txt').path, 'previous direction must use the remaining boundary fallback');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('cancel clears an accumulated preview set and restores its origin before ignoring release', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			for (const name of ['range_cancel_a.txt', 'range_cancel_b.txt']) { write(name, name); }
			await refreshUntil(() => ['range_cancel_a.txt', 'range_cancel_b.txt'].every(isUntracked), 'cancelled range files');
			await openPlainAt('range_cancel_a.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			assert.strictEqual(activeTabPath(), wsUri('range_cancel_b.txt').path, 'wheel must preview the pending range endpoint');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', 'corsair');
			assert.strictEqual(activeTabPath(), wsUri('range_cancel_a.txt').path, 'cancel must restore the pre-selection view');
			await vscode.commands.executeCommand('better-git-vscode.navigate-mouse-stage-preview', 'corsair', 'next');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.strictEqual(git('diff --cached --name-only'), '');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_cancel_a.txt')), '🔥🔥');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('range_cancel_b.txt')), undefined);
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	test('release-only exact Undo cancels a ready hold without moving or consuming earlier stage history', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		try {
			write('cancel_history.txt', 'history'); write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
			await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt', 'hold_b.txt'].every(isUntracked), 'release-only cancel files');
			await openPlainAt('cancel_history.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
			assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
			await openPlainAt('hold_a.txt', 0);

			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(activeTabPath(), wsUri('hold_a.txt').path, 'cancel chord must leave the review file still');
			assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'cancel chord must preserve earlier stage history');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair');
			assert.strictEqual(activeTabPath(), wsUri('hold_a.txt').path, 'release after cancel must stay inert');
			assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '', 'ordinary Undo must still consume the earlier receipt');
		} finally {
			await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
		}
	});

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`source-tagged adjacent chord undoes the previous stage before ${source} ${direction} hold readiness`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('cancel_history.txt', 'history'); write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt', 'hold_b.txt'].every(isUntracked), 'pre-ready undo files');
					await openPlainAt('cancel_history.txt', 0);
					await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					await openPlainAt(origin, 0);

					// Real transaction order: tagged F14 registers the short release, F16 decides, tagged F15 is the boundary.
					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', source);
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
					assert.strictEqual(git('diff --cached --name-only'), '', 'pre-ready adjacent chord must perform exact Undo');
					assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'Undo must reveal the restored staged file');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), '', 'later release must stay inert after the chord');
					assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'later release must not navigate');
					assert.strictEqual(fs.readFileSync(wsUri(origin).fsPath, 'utf8'), direction === 'next' ? 'first' : 'second');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
				}
			});

			test(`source-tagged adjacent chord atomically cancels a release-only ${source} ${direction} hold`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('cancel_history.txt', 'history'); write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt', 'hold_b.txt'].every(isUntracked), 'source-tagged cancel files');
					await openPlainAt('cancel_history.txt', 0);
					await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					await openPlainAt(origin, 0);

					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥');
					await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source);
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', source);
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
					assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥', 'cancel chord must clear the stage-ready decoration');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'cancel chord and later release must leave the review file still');
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'cancel chord must preserve earlier stage history');

					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', source);
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'stale source-tagged F16 must not become an ordinary Undo');
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'bare F16 must retain exact Undo behavior');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
				}
			});
		}
	}

	// The live Agentic Mouse Karabiner rules emit the chord's Undo key BARE (it reaches Better Git through the
	// user's plain `f16` keybinding), between the source-tagged F14 and F15. Dispatch the chord without awaiting
	// each command so the extension sees the same synchronous input order as real keybinding delivery.
	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`live adjacent chord (tagged F14, bare F16, tagged F15) undoes the previous stage before ${source} ${direction} hold readiness`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('cancel_history.txt', 'history'); write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt', 'hold_b.txt'].every(isUntracked), 'live chord undo files');
					await openPlainAt('cancel_history.txt', 0);
					await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					await openPlainAt(origin, 0);

					await Promise.all([
						vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction }),
						vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source),
						vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance'),
						vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source),
					]);
					assert.strictEqual(git('diff --cached --name-only'), '', 'live pre-ready chord must perform exact Undo');
					assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'Undo must reveal the restored staged file');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), '', 'later release must stay inert after the chord');
					assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'later release must not navigate');
					assert.strictEqual(fs.readFileSync(wsUri(origin).fsPath, 'utf8'), direction === 'next' ? 'first' : 'second');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
				}
			});

			test(`live adjacent chord (tagged F14, bare F16, tagged F15) cancels only a stage-ready ${source} ${direction} hold`, async () => {
				const config = vscode.workspace.getConfiguration('better-git-vscode');
				const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
				await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
				try {
					write('cancel_history.txt', 'history'); write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
					await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt', 'hold_b.txt'].every(isUntracked), 'live chord cancel files');
					await openPlainAt('cancel_history.txt', 0);
					await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
					const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
					await openPlainAt(origin, 0);

					await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
					await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
					assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥');
					await Promise.all([
						vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source),
						vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance'),
						vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source),
					]);
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'stage-ready chord must preserve earlier stage history');
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'stage-ready chord must leave the review file still');
					assert.notStrictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥', 'chord must clear the stage-ready decoration');
					await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
					assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'later release must not stage after the chord');
					assert.strictEqual(activeTabPath(), wsUri(origin).path, 'later release must stay inert');

					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					assert.strictEqual(git('diff --cached --name-only'), '', 'ordinary bare Undo must still consume the earlier receipt afterwards');
				} finally {
					await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
				}
			});
		}
	}

	// After staging the last unstaged file the review stays on a staged file, so button-down captures no
	// unstaged review item. The chord must still Undo instead of treating its F16 as stale input.
	for (const [source, direction, tagged] of [['corsair', 'next', true], ['razer', 'previous', false]] as const) {
		test(`adjacent chord (${tagged ? 'tagged' : 'bare'} F16) undoes the previous stage when the ${source} ${direction} hold captured no review item`, async () => {
			const config = vscode.workspace.getConfiguration('better-git-vscode');
			const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
			await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
			try {
				write('cancel_history.txt', 'history'); write('hold_a.txt', 'first');
				await refreshUntil(() => ['cancel_history.txt', 'hold_a.txt'].every(isUntracked), 'no-review-item chord files');
				await openPlainAt('cancel_history.txt', 0);
				await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
				assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');

				const chord = [
					vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction }),
					vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', source),
					vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', tagged ? source : undefined),
					vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source),
				];
				if (tagged) {
					for (const step of chord) { await step; } // The awaited form lets F14's queued work run before F16 arrives.
				} else {
					await Promise.all(chord);
				}
				assert.strictEqual(git('diff --cached --name-only'), '', 'chord must Undo even when no review item was captured');
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
				assert.strictEqual(git('diff --cached --name-only'), '', 'later release must stay inert');
				assert.strictEqual(fs.readFileSync(wsUri('hold_a.txt').fsPath, 'utf8'), 'first');
			} finally {
				await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
			}
		});
	}

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`button-down hold ${source} ${direction} navigates before release and stages its origin after a long hold`, async () => {
				write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
				await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'hold pair');
				const origin = direction === 'next' ? 'hold_a.txt' : 'hold_b.txt';
				const destination = direction === 'next' ? 'hold_b.txt' : 'hold_a.txt';
				await openPlainAt(origin, 0);
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
				assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri(destination).fsPath);
				assert.strictEqual(git('diff --cached --name-only'), '', 'button-down must not stage');
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
                assert.strictEqual(activeTabPath(), wsUri(origin).path, 'hold threshold must return to original file');
                assert.strictEqual(git('diff --cached --name-only'), '', 'threshold must not stage');
                assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(origin)), '💥💥');
				await sleep(1100); // A real long hold must outlive the legacy one-second late-click window.
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
				assert.strictEqual(git('diff --cached --name-only'), origin);
				assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri(destination).fsPath);
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
				assert.strictEqual(git('diff --cached --name-only'), origin, 'duplicate release must not stage destination');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '');
			});
		}
	}

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`pre-ready exact Undo cancels an active ${source} ${direction} hold, restores the prior stage and consumes its later release`, async () => {
				write('cancel_history.txt', 'history'); write('hold_cancel_a.txt', 'first'); write('hold_cancel_b.txt', 'second');
				await refreshUntil(
					() => ['cancel_history.txt', 'hold_cancel_a.txt', 'hold_cancel_b.txt'].every(isUntracked),
					'hold cancel pair and history'
				);
				await openPlainAt('cancel_history.txt', 0);
				await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
				assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
				const origin = direction === 'next' ? 'hold_cancel_a.txt' : 'hold_cancel_b.txt';
				const destination = direction === 'next' ? 'hold_cancel_b.txt' : 'hold_cancel_a.txt';
				await openPlainAt(origin, 0);
				await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
				assert.strictEqual(activeTabPath(), wsUri(destination).path);
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'pre-ready chord must reveal the restored staged file');
				assert.strictEqual(git('diff --cached --name-only'), '', 'pre-ready chord must perform exact Undo');
				await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
				assert.strictEqual(activeTabPath(), wsUri('cancel_history.txt').path, 'stale readiness/release must not move after Undo');
				assert.strictEqual(git('diff --cached --name-only'), '', 'release after cancel must do nothing');
			});
		}
	}

	test('ready-hold cancel preserves an earlier Undo receipt and ordinary Undo still consumes it afterwards', async () => {
		write('cancel_history.txt', 'history'); write('hold_cancel_a.txt', 'first'); write('hold_cancel_b.txt', 'second');
		await refreshUntil(() => ['cancel_history.txt', 'hold_cancel_a.txt', 'hold_cancel_b.txt'].every(isUntracked), 'cancel history files');
		await openPlainAt('cancel_history.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
		assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt');
		await openPlainAt('hold_cancel_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'cancel_history.txt', 'ready-hold cancel must preserve the previous stage and receipt');
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('diff --cached --name-only'), '', 'the next ordinary Undo must still restore the earlier stage');
	});

	test('mouse debug trace records button-down, readiness, cancel and ignored release phases', async () => {
		write('hold_debug_a.txt', 'first'); write('hold_debug_b.txt', 'second');
		await refreshUntil(() => isUntracked('hold_debug_a.txt') && isUntracked('hold_debug_b.txt'), 'hold debug pair');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousLogging = config.inspect<boolean>('debugLogging')?.globalValue;
		try {
			await config.update('debugLogging', true, vscode.ConfigurationTarget.Global);
			extensionApi.clearMouseDebugTrace();
			await openPlainAt('hold_debug_a.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			const trace = extensionApi.getMouseDebugTrace();
			assert.ok(trace.includes('Corsair Next button down.'));
			assert.ok(trace.includes('Corsair Next hold threshold reached; pre-press view restored. Release will stage.'));
			assert.ok(trace.includes('Corsair Next cancel chord received; pre-press view restored. Release will do nothing.'));
			assert.ok(trace.includes('Corsair Next release ignored, no press in progress.'));
		} finally {
			await config.update('debugLogging', previousLogging, vscode.ConfigurationTarget.Global);
		}
	});


    for (const source of ['corsair', 'razer']) {
        for (const direction of ['next', 'previous']) {
            test(`hold threshold restores ${source} ${direction} cursor, selection and scroll within a file`, async () => {
                write('hold_view.txt', lines(160, 'view'));
                await refreshUntil(() => isUntracked('hold_view.txt'), 'hold view');
                await vscode.window.showTextDocument(wsUri('hold_view.txt'), { preview: false });
                const editor = vscode.window.activeTextEditor!;
                editor.selection = new vscode.Selection(60, 2, 61, 4);
                editor.revealRange(new vscode.Range(50, 0, 50, 0), vscode.TextEditorRevealType.AtTop);
                await sleep(100);
                const selection = editor.selection;
                const top = editor.visibleRanges[0].start.line;
                await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
                assert.notStrictEqual(editor.selection.active.line, selection.active.line);
                await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
                await sleep(100);
                assert.deepStrictEqual(editor.selection, selection);
                assert.strictEqual(editor.visibleRanges[0].start.line, top);
                await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
                assert.deepStrictEqual(editor.selection, selection, 'duplicate readiness must preserve the captured selection');
                assert.strictEqual(editor.visibleRanges[0].start.line, top, 'duplicate readiness must preserve the captured viewport');
                assert.strictEqual(git('diff --cached --name-only'), '');
                await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
                await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
                assert.strictEqual(git('diff --cached --name-only'), 'hold_view.txt');
            });
        }
    }

    for (const direction of ['next', 'previous']) {
        test(`hold threshold returns within an insertion-heavy diff ${direction}`, async () => {
            const content = lines(260, 'tall_e').split('\n');
            content.splice(180, 0, ...Array.from({ length: 60 }, (_, i) => `added later ${i}`));
            content.splice(90, 0, ...Array.from({ length: 60 }, (_, i) => `added earlier ${i}`));
            write('committed/tall_e.txt', content.join('\n'));
            await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5), 'insertion diff');
            const editor = await openWorkingDiffAt('committed/tall_e.txt', direction === 'next' ? 100 : 260);
            await sleep(150);
            const before = { selection: editor.selection, top: editor.visibleRanges[0].start.line };
            await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction });
            await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
            await sleep(150);
            assert.deepStrictEqual(editor.selection, before.selection);
            assert.strictEqual(editor.visibleRanges[0].start.line, before.top);
            await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair');
        });
    }

    test('hold threshold restores a diff editor after crossing files', async () => {
        const content = lines(260, 'tall_e').split('\n');
        content[110] = 'changed line';
        write('committed/tall_e.txt', content.join('\n'));
        write('zz_after.txt', 'next');
        await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5) && isUntracked('zz_after.txt'), 'diff hold files');
        const editor = await openWorkingDiffAt('committed/tall_e.txt', 240);
        editor.selection = new vscode.Selection(259, 2, 259, 4);
        await sleep(150);
        const selection = editor.selection;
        const top = editor.visibleRanges[0].start.line;
        const source = 'corsair'; const direction = 'next';
        await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction });
        assert.strictEqual(activeTabPath(), wsUri('zz_after.txt').path);
        await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
        await sleep(300);
        assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
        const restored = visibleEditorFor(wsUri('committed/tall_e.txt'))!;
        assert.deepStrictEqual(restored.selection, selection);
        assert.strictEqual(restored.visibleRanges[0].start.line, top);
        assert.strictEqual(git('diff --cached --name-only'), '');
        await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
        assert.strictEqual(git('diff --cached --name-only'), 'committed/tall_e.txt');
        assert.strictEqual(activeTabPath(), wsUri('zz_after.txt').path);
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        await refreshUntil(() => !inIndex('committed/tall_e.txt') && inWorkingTree('committed/tall_e.txt', 5),
            'mouse-held stage to be undone');
        await expectActiveTab('committed/tall_e.txt');
        const undone = await poll(() => visibleEditorFor(wsUri('committed/tall_e.txt')),
            'mouse-held staged diff to return');
        assert.deepStrictEqual(undone.selection, selection, 'Undo must restore the pre-hold cursor selection');
        await poll(() => undone.visibleRanges[0]?.start.line === top,
            'Undo to restore the pre-hold viewport');
    });

    test('hold readiness queued immediately after button-down restores the pre-press view', async () => {
        for (const name of ['hold_race_a.txt', 'hold_race_b.txt']) { write(name, lines(320, name)); }
        await refreshUntil(() => isUntracked('hold_race_a.txt') && isUntracked('hold_race_b.txt'), 'hold race pair');
        const editor = await vscode.window.showTextDocument(wsUri('hold_race_a.txt'), { preview: false });
        editor.selection = new vscode.Selection(70, 3, 72, 5);
        editor.revealRange(new vscode.Range(55, 0, 55, 0), vscode.TextEditorRevealType.AtTop);
        await sleep(100);
        const selection = editor.selection;
        const top = editor.visibleRanges[0].start.line;
        await Promise.all([
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair'),
        ]);
        const restored = visibleEditorFor(wsUri('hold_race_a.txt'))!;
        assert.strictEqual(activeTabPath(), wsUri('hold_race_a.txt').path);
        assert.deepStrictEqual(restored.selection, selection);
        assert.strictEqual(restored.visibleRanges[0].start.line, top);
        await vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair');
    });

    test('hold threshold queued behind quick taps cannot rewind or lose navigation', async () => {
        for (const name of ['hold_fast_a.txt', 'hold_fast_b.txt', 'hold_fast_c.txt']) { write(name, name); }
        await refreshUntil(() => ['hold_fast_a.txt', 'hold_fast_b.txt', 'hold_fast_c.txt'].every(isUntracked), 'fast hold files');
        await openPlainAt('hold_fast_a.txt', 0);
        await Promise.all([
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair'),
            vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair'),
            vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair'),
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair'),
        ]);
        assert.strictEqual(activeTabPath(), wsUri('hold_fast_c.txt').path);
        assert.strictEqual(git('diff --cached --name-only'), '');
    });

    test('hold threshold and two queued long releases stage each original once in order', async () => {
        for (const name of ['hold_burst_a.txt', 'hold_burst_b.txt', 'hold_burst_c.txt']) { write(name, name); }
        await refreshUntil(() => ['hold_burst_a.txt', 'hold_burst_b.txt', 'hold_burst_c.txt'].every(isUntracked), 'burst hold files');
        await openPlainAt('hold_burst_a.txt', 0);
        await Promise.all([
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair'),
            vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
            vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair'),
            vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
        ]);
        assert.strictEqual(activeTabPath(), wsUri('hold_burst_c.txt').path);
        assert.deepStrictEqual(git('diff --cached --name-only').split('\n'), ['hold_burst_a.txt', 'hold_burst_b.txt']);
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        assert.strictEqual(git('diff --cached --name-only'), 'hold_burst_a.txt');
    });

    test('hold threshold keeps a new mouse hold queued after keyboard navigation', async () => {
        for (const name of ['hold_keys_a.txt', 'hold_keys_b.txt', 'hold_keys_c.txt']) { write(name, name); }
        await refreshUntil(() => ['hold_keys_a.txt', 'hold_keys_b.txt', 'hold_keys_c.txt'].every(isUntracked), 'keyboard then hold files');
        await openPlainAt('hold_keys_a.txt', 0);
        const source = 'corsair'; const direction = 'next';
        await Promise.all([
            vscode.commands.executeCommand('better-git-vscode.next-scm-change'),
            vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source, direction }),
        ]);
        assert.strictEqual(activeTabPath(), wsUri('hold_keys_c.txt').path);
        await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
        assert.strictEqual(activeTabPath(), wsUri('hold_keys_b.txt').path);
        await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction });
        assert.strictEqual(git('diff --cached --name-only'), 'hold_keys_b.txt');
    });

    test('hold threshold cannot rewind a later other-mouse or keyboard navigation', async () => {
        for (const name of ['hold_other_a.txt', 'hold_other_b.txt', 'hold_other_c.txt']) { write(name, name); }
        await refreshUntil(() => ['hold_other_a.txt', 'hold_other_b.txt', 'hold_other_c.txt'].every(isUntracked), 'other hold files');
        await openPlainAt('hold_other_a.txt', 0);
        await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
        await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'next' });
        await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
        assert.strictEqual(activeTabPath(), wsUri('hold_other_c.txt').path);
        await vscode.commands.executeCommand('better-git-vscode.previous-scm-change');
        await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
        await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'next' });
        assert.strictEqual(activeTabPath(), wsUri('hold_other_b.txt').path);
        assert.strictEqual(git('diff --cached --name-only'), '');
    });

	test('button-down readiness respects a disabled badge on the captured original', async () => {
		write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
		await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'disabled badge pair');
		await openPlainAt('hold_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previous = config.inspect<string>('currentFileBadge')?.globalValue;
		try {
			await config.update('currentFileBadge', '', vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('hold_a.txt')), undefined);
		} finally {
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair');
			await config.update('currentFileBadge', previous, vscode.ConfigurationTarget.Global);
		}
	});

	test('button-down stage failure leaves subsequent navigation usable with the error notice open', async () => {
		write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
		await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'failure pair');
		await openPlainAt('hold_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		const repositoryPrototype = Object.getPrototypeOf(repo);
		const originalAdd = repositoryPrototype.add;
		repositoryPrototype.add = async () => { throw new Error('intentional isolated stage failure'); };
		try {
			await Promise.race([
				vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
				sleep(2000).then(() => { throw new Error('stage queue waited for notification dismissal'); }),
			]);
		} finally { repositoryPrototype.add = originalAdd; }
		assert.strictEqual(git('diff --cached --name-only'), '');
		await vscode.commands.executeCommand('better-git-vscode.previous-scm-change');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('hold_a.txt').fsPath);
	});

	for (const direction of ['next', 'previous'] as const) {
		for (const batch of [false, true]) {
			for (const preview of [false, true]) {
				test(`exhausted stage review stays in its worktree: ${direction} batch=${batch} preview=${preview}`, async () => {
					const sibling = process.env.BGV_LAST_STAGED_WORKTREE_PATH!;
					const siblingUri = vscode.Uri.file(path.join(sibling, 'boundary_a.txt'));
					const config = vscode.workspace.getConfiguration('better-git-vscode');
					await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
					const names = batch ? ['boundary_a.txt', 'boundary_b.txt'] : ['boundary_a.txt'];
					try {
						await vscode.commands.executeCommand('better-git-vscode.add-worktree-to-workspace', { rootUri: vscode.Uri.file(sibling) });
						fs.writeFileSync(siblingUri.fsPath, 'Unstaged sibling must never be selected or staged.\n');
						const api = vscode.extensions.getExtension<any>('vscode.git')!.exports.getAPI(1);
						const siblingRepo = await poll(() => api.getRepository(siblingUri), 'sibling repository');
						await siblingRepo.status();
						for (const name of names) { write(name, 'Only this worktree is being staged.\n'); }
						await refreshUntil(() => names.every(isUntracked), 'last unstaged files');
						await vscode.window.showTextDocument(siblingUri, { preview: false });
						const start = direction === 'next' ? names[0] : names[names.length - 1];
						await vscode.window.showTextDocument(wsUri(start), { preview });
						if (batch) {
							await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction });
							await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
							await vscode.commands.executeCommand('better-git-vscode.adjust-mouse-stage-selection', 'corsair', direction === 'next' ? 'down' : 'up');
						}
						const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
						const originalPath = activeTabPath();
						const activations: string[] = [];
						const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
							const current = activeTabPath(); if (current) { activations.push(current); }
						});
						try {
							if (batch) {
								await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction });
							} else {
								await vscode.commands.executeCommand(`better-git-vscode.stage-and-${direction}-changed-file`);
							}
							await extensionApi.whenStageTransactionsSettled();
							await sleep(150); // Catch delayed tab activation after the Git refresh.
							assert.strictEqual(git('diff --cached --name-only'), names.join('\n'));
							assert.strictEqual(activeTabPath(), originalPath, 'exhaustion must keep the final review file');
							// Ethan 2026-11-05: the staged-only working view would let SCM Auto Reveal expand
							// Staged Changes on a later unrelated event. The same file's Index side replaces it.
							const finalInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
							assert.ok(finalInput instanceof vscode.TabInputTextDiff && finalInput.modified.scheme === 'git',
								'the exhausted file is presented on its staged (Index) side, never as a file: view');
							assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, originalTab.group.viewColumn,
								'the final review stays in its original editor group');
							assert.ok(!activations.includes(siblingUri.path), 'never transiently activate another worktree');
							assert.strictEqual(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: sibling, encoding: 'utf8' }).trim(), '');
						} finally { listener.dispose(); }
						await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
						assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the final stage or whole batch');
					} finally {
						fs.rmSync(siblingUri.fsPath, { force: true });
						await config.update('experimentalMouseHoldNavigateOnButtonDown', true, vscode.ConfigurationTarget.Global);
					}
				});
			}
		}
	}

	test('button-down hold at the only file boundary stages once and keeps the exhausted review', async () => {
		write('hold_only.txt', 'only');
		await refreshUntil(() => isUntracked('hold_only.txt'), 'only hold file');
		await openPlainAt('hold_only.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'hold_only.txt');
	});

	test('button-down short release clears the origin and leaves navigation intact', async () => {
		write('hold_a.txt', 'first'); write('hold_b.txt', 'second');
		await refreshUntil(() => isUntracked('hold_a.txt') && isUntracked('hold_b.txt'), 'short hold pair');
		await openPlainAt('hold_a.txt', 0);
		await Promise.all([
			vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
			vscode.commands.executeCommand('better-git-vscode.cancel-mouse-navigation-hold', 'corsair'),
			vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' }),
		]);
		assert.strictEqual(git('diff --cached --name-only'), '');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('hold_b.txt').fsPath);
	});

	test('button-down hold retains its captured file across a manual editor switch', async () => {
		for (const name of ['hold_a.txt', 'hold_b.txt', 'hold_c.txt']) { write(name, name); }
		await refreshUntil(() => ['hold_a.txt', 'hold_b.txt', 'hold_c.txt'].every(isUntracked), 'hold cancellation files');
		await openPlainAt('hold_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'next' });
		await openPlainAt('hold_c.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'hold_a.txt', 'manual editor choice must preserve the held origin');
		assert.strictEqual(activeTabPath(), wsUri('hold_c.txt').path, 'release must not stage or replace the unrelated editor');
	});

	for (const source of ['corsair', 'razer']) {
		for (const direction of ['next', 'previous']) {
			test(`late mouse stage pins the origin after ${source} ${direction} has crossed files`, async () => {
				write('mouse_a.txt', 'first');
				write('mouse_b.txt', 'second');
				await refreshUntil(() => isUntracked('mouse_a.txt') && isUntracked('mouse_b.txt'), 'mouse review pair');
				const origin = direction === 'next' ? 'mouse_a.txt' : 'mouse_b.txt';
				const destination = direction === 'next' ? 'mouse_b.txt' : 'mouse_a.txt';
				await openPlainAt(origin, 0);
				const pressed = Date.now();
				await vscode.commands.executeCommand(`better-git-vscode.${direction}-scm-change`, source);
				await sleep(Math.max(0, 800 - (Date.now() - pressed))); // Exercise the slow end of the real one-second input window, after the editor changed.
				assert.ok(Date.now() - pressed < 1000, 'test host could not navigate within the real gesture window');
				assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri(destination).fsPath);
				await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source, direction });
				assert.strictEqual(git('diff --cached --name-only'), origin, 'late staging must never stage the destination');
				assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri(destination).fsPath, 'late staging must not jump a second time');
				await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source, direction });
				assert.strictEqual(git('diff --cached --name-only'), origin, 'the captured gesture is single-use');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '', 'origin staging must retain exact Better Git undo support');
			});
		}
	}

	test('immediate mouse stage waits for origin capture and navigation in the same queue', async () => {
		write('mouse_a.txt', 'first');
		write('mouse_b.txt', 'second');
		await refreshUntil(() => isUntracked('mouse_a.txt') && isUntracked('mouse_b.txt'), 'rapid mouse pair');
		await openPlainAt('mouse_a.txt', 0);
		await Promise.all([
			vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair'),
			vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'next' }),
		]);
		assert.strictEqual(git('diff --cached --name-only'), 'mouse_a.txt');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('mouse_b.txt').fsPath);
	});

	test('rapid repeated mouse navigation stages the file before the latest step, not the first step', async () => {
		for (const name of ['mouse_a.txt', 'mouse_b.txt', 'mouse_c.txt']) { write(name, name); }
		await refreshUntil(() => ['mouse_a.txt', 'mouse_b.txt', 'mouse_c.txt'].every(isUntracked), 'three mouse review files');
		await openPlainAt('mouse_a.txt', 0);
		await Promise.all([
			vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair'),
			vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair'),
			vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'next' }),
		]);
		assert.strictEqual(git('diff --cached --name-only'), 'mouse_b.txt');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('mouse_c.txt').fsPath);
	});

	test('each mouse retains its own origin when the other mouse navigates', async () => {
		for (const name of ['mouse_a.txt', 'mouse_b.txt', 'mouse_c.txt']) { write(name, name); }
		await refreshUntil(() => ['mouse_a.txt', 'mouse_b.txt', 'mouse_c.txt'].every(isUntracked), 'independent mouse review files');
		await openPlainAt('mouse_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair');
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'razer');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'mouse_a.txt');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'razer', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'mouse_a.txt\nmouse_b.txt');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('mouse_c.txt').fsPath);
	});

	test('late stage after a within-file step still advances from the captured original', async () => {
		write('mouse_a_tall.txt', lines(240, 'first'));
		write('mouse_b.txt', 'second');
		await refreshUntil(() => isUntracked('mouse_a_tall.txt') && isUntracked('mouse_b.txt'), 'within-file mouse pair');
		const editor = await openPlainAt('mouse_a_tall.txt', 0);
		await poll(() => (editor.visibleRanges[0]?.end.line ?? 240) < 239, 'tall file renderer to settle');
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'razer');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('mouse_a_tall.txt').fsPath);
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'razer', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), 'mouse_a_tall.txt');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, wsUri('mouse_b.txt').fsPath);
	});

	test('late mouse stage undo restores the view before navigation crossed files', async () => {
		const rel = 'committed/tall_e.txt';
		const content = lines(260, 'tall_e').split('\n');
		content[160] = 'tall_e LATE MOUSE STAGE';
		write(rel, content.join('\n') + '\n');
		write('zz_after.txt', 'next review file\n');
		await refreshUntil(() => inWorkingTree(rel, 5) && isUntracked('zz_after.txt'), 'late mouse view files');
		const editor = await openWorkingDiffAt(rel, 160);
		editor.selection = new vscode.Selection(160, 2, 160, 12);
		editor.revealRange(new vscode.Range(145, 0, 145, 0), vscode.TextEditorRevealType.AtTop);
		await sleep(150);
        // Review the visible hunk first. The Oct-1 manual-scroll contract makes that a real first step;
        // this test targets the later cross-file stage/Undo view, not viewport-first selection.
        await nextChange(); await expectCursorAt(rel, 160);
        editor.selection = new vscode.Selection(160, 2, 160, 12);
		const before = { selection: editor.selection, top: editor.visibleRanges[0].start.line };

		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair');
		await expectActiveTab('zz_after.txt');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation',
			{ source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), rel);
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await refreshUntil(() => !inIndex(rel) && inWorkingTree(rel, 5), 'late mouse stage to be undone');
		await expectActiveTab(rel);
		const restored = await poll(() => visibleEditorFor(wsUri(rel)), 'late mouse origin diff to return');
		assert.deepStrictEqual(restored.selection, before.selection);
		await poll(() => restored.visibleRanges[0]?.start.line === before.top,
			'late mouse origin viewport to return');
	});

	test('expired, opposite-source, and wrong-direction mouse receipts never stage the current file', async () => {
		write('mouse_a.txt', 'first');
		write('mouse_b.txt', 'second');
		await refreshUntil(() => isUntracked('mouse_a.txt') && isUntracked('mouse_b.txt'), 'guarded mouse pair');
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change'); // Start a new ordinary review sequence, invalidating receipts from previous test gestures.
		await openPlainAt('mouse_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'razer', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), '');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'previous' });
		assert.strictEqual(git('diff --cached --name-only'), '');
		await openPlainAt('mouse_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change', 'corsair');
		await sleep(1050);
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), '');
	});

	test('ordinary keyboard navigation does not arm mouse origin staging', async () => {
		write('mouse_a.txt', 'first');
		write('mouse_b.txt', 'second');
		await refreshUntil(() => isUntracked('mouse_a.txt') && isUntracked('mouse_b.txt'), 'ordinary navigation pair');
		await openPlainAt('mouse_a.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.next-scm-change');
		await vscode.commands.executeCommand('better-git-vscode.stage-before-mouse-navigation', { source: 'corsair', direction: 'next' });
		assert.strictEqual(git('diff --cached --name-only'), '');
	});

	for (const direction of ['next', 'previous'] as const) {
		test(`pinned stage ${direction} never activates a background staged file`, async () => {
			write('zz_background.txt', 'already staged');
			git('add zz_background.txt');
			write('review_a.txt', 'a');
			write('review_b.txt', 'b');
			await refreshUntil(() => inIndex('zz_background.txt') && isUntracked('review_b.txt'), 'pinned stage fixture');
			await openPlainAt('zz_background.txt', 0);
			const origin = direction === 'next' ? 'review_a.txt' : 'review_b.txt';
			const target = direction === 'next' ? 'review_b.txt' : 'review_a.txt';
			await openPlainAt(origin, 0);
			const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
			const seen: (string | undefined)[] = [];
			const listener = vscode.window.tabGroups.onDidChangeTabs(() => seen.push(activeTabPath()));
			try {
				await vscode.commands.executeCommand(`better-git-vscode.stage-and-${direction}-changed-file`);
				await expectActiveTab(target);
				assert.ok(!seen.includes(wsUri('zz_background.txt').path), `background staged file activated: ${seen}`);
				assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.includes(originalTab)), 'replaced clean pinned tab must close');
				assert.ok(inIndex(origin), 'the original file must be staged');
			} finally { listener.dispose(); }
		});
	}

    for (const direction of ['next', 'previous'] as const) {
        test(`background warmup prepares both neighbours without moving review, then stage ${direction} marks only the opened target`, async () => {
            const prefix = `warm-${direction}`;
            const before = `${prefix}-a.txt`, origin = `${prefix}-b.txt`, after = `${prefix}-c.txt`;
            for (const name of [before, origin, after]) { write(name, name); }
            await refreshUntil(() => [before, origin, after].every(isUntracked), 'warmup neighbours');
            await openPlainAt(origin, 0);
            const originTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const indexBefore = git('write-tree');
            await poll(() => [before, after].every(name => vscode.workspace.textDocuments.some(doc =>
                !doc.isClosed && doc.uri.toString() === wsUri(name).toString())), 'both neighbouring text models to warm');
            assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, originTab);
            assert.strictEqual(git('write-tree'), indexBefore, 'preparation never stages');
            const target = direction === 'next' ? after : before;
            write(target, 'latest content after background preparation');
            await refreshUntil(() => isUntracked(target), 'prepared target remains unstaged');
            await vscode.commands.executeCommand(`better-git-vscode.stage-and-${direction}-changed-file`);
            assert.strictEqual(activeTabPath(), wsUri(target).path);
            assert.strictEqual(extensionApi.getCurrentReviewUri(), wsUri(target).toString(), 'badge must match verified open when command finishes');
            assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(target)), '🔥🔥');
            assert.ok(inIndex(origin));
            assert.ok(!inIndex(target));
            const document = await vscode.workspace.openTextDocument(wsUri(target));
            await poll(() => document.getText() === 'latest content after background preparation', 'prepared document to reflect latest saved text');
        });
    }

    test('background warmup loads modified neighbours on both diff sides without moving the badge', async () => {
        const names = ['warm-modified-a.txt', 'warm-modified-b.txt', 'warm-modified-c.txt'];
        for (const name of names) { write(name, 'baseline text'); }
        git('add warm-modified-a.txt warm-modified-b.txt warm-modified-c.txt');
        git('commit -m "warmup fixture"');
        for (const name of names) { write(name, 'working text'); }
        await refreshUntil(() => names.every(name => inWorkingTree(name, 5)), 'modified warmup neighbours');
        await vscode.commands.executeCommand('git.openChange', wsUri(names[1]));
        const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        await poll(() => [names[0], names[2]].every(name =>
            [wsUri(name), toGitUri(wsUri(name), '~')].every(uri =>
                vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.toString() === uri.toString()))),
            'modified neighbours working and index documents');
        assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, originalTab);
        assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[1])), '🔥🔥');
        assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[0])), undefined);
        await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
        assert.strictEqual(activeTabPath(), wsUri(names[2]).path);
        assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri(names[2])), '🔥🔥');
    });

    test('background warmup skips large neighbours and recomputes a removed target at stage time', async () => {
        write('warm-removed-a.txt', 'origin');
        write('warm-removed-b.txt', 'x'.repeat(300 * 1024));
        write('warm-removed-c.txt', 'valid replacement');
        await refreshUntil(() => isUntracked('warm-removed-c.txt'), 'large neighbour fixture');
        await openPlainAt('warm-removed-a.txt', 0);
        await extensionApi.whenReviewDecorationSettled();
        await sleep(150);
        assert.ok(!vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.toString() === wsUri('warm-removed-b.txt').toString()));
        fs.unlinkSync(path.join(ws, 'warm-removed-b.txt'));
        await refreshUntil(() => !isUntracked('warm-removed-b.txt'), 'deleted candidate to disappear');
        await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
        await expectActiveTab('warm-removed-c.txt');
        assert.strictEqual(extensionApi.getReviewDecorationBadge(wsUri('warm-removed-c.txt')), '🔥🔥');
    });

	test('undo latest Stage + Next restores the exact pre-stage index', async () => {
		const partiallyStaged = lines(24, 'mod_a').split('\n');
		partiallyStaged[2] = 'mod_a PREVIOUSLY STAGED line 3';
		write('committed/mod_a.txt', partiallyStaged.join('\n') + '\n');
		git('add committed/mod_a.txt');

		const working = partiallyStaged.slice();
		working[17] = 'mod_a WORKING-ONLY line 18';
		write('committed/mod_a.txt', working.join('\n') + '\n');
		await refreshUntil(
			() => inIndex('committed/mod_a.txt', 0) && inWorkingTree('committed/mod_a.txt', 5),
			'partially staged undo fixture to appear'
		);
		await openWorkingDiffAt('committed/mod_a.txt', 17);

		await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
		await refreshUntil(
			() => inIndex('committed/mod_a.txt', 0) && !inWorkingTree('committed/mod_a.txt', 5),
			'Stage + Next to stage the working-only edit'
		);

		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await refreshUntil(
			() => inIndex('committed/mod_a.txt', 0) && inWorkingTree('committed/mod_a.txt', 5),
			'undo to restore the exact partially staged index'
		);
		await expectActiveTab('committed/mod_a.txt');
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		assert.ok(input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file',
			'Undo must select the restored working-tree diff, not the remaining staged copy');
	});

	for (const stageCommand of ['better-git-vscode.stage-and-next-changed-file', 'git.stage']) {
		test(`undo ${stageCommand} returns to the prior cursor and viewport`, async () => {
			const rel = 'committed/tall_e.txt';
			const content = lines(260, 'tall_e').split('\n');
			content[160] = 'tall_e RESTORE MY REVIEW POSITION';
			write(rel, content.join('\n') + '\n');
			write('zz_after.txt', 'next review file\n');
			await refreshUntil(() => inWorkingTree(rel, 5) && isUntracked('zz_after.txt'),
				'undo view fixture to appear');
			const editor = await openWorkingDiffAt(rel, 160);
			editor.selection = new vscode.Selection(160, 2, 160, 15);
			editor.revealRange(new vscode.Range(145, 0, 145, 0), vscode.TextEditorRevealType.AtTop);
			await sleep(150);
			const before = { selection: editor.selection, top: editor.visibleRanges[0].start.line };
			assert.ok(before.top > 0 && before.top < 160, 'fixture needs a meaningful saved viewport');

			await vscode.commands.executeCommand(stageCommand);
			await refreshUntil(() => inIndex(rel, 0), `${stageCommand} to stage the tall file`);
			if (stageCommand === 'git.stage') {
				await vscode.window.showTextDocument(wsUri('zz_after.txt'), { preview: true });
			}
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			await refreshUntil(() => !inIndex(rel) && inWorkingTree(rel, 5), 'undo to restore the tall file');
			await expectActiveTab(rel);
			const restored = await poll(() => visibleEditorFor(wsUri(rel)), `${rel} restored diff editor`);
			await poll(() => restored.visibleRanges[0]?.start.line === before.top,
				`${rel} viewport restored to line ${before.top}`);
			assert.deepStrictEqual(restored.selection, before.selection, 'Undo must restore the exact cursor selection');
		});
	}

	for (const kept of [false, true]) {
		test(`image Stage + Next and Undo reset a ${kept ? 'kept' : 'preview'} image view`, async () => {
			const imageBytes = Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
			const originalUri = wsUri('committed/image.png');
			const nextUri = wsUri('zz_image_after.png');
			fs.writeFileSync(originalUri.fsPath, imageBytes);
			fs.writeFileSync(nextUri.fsPath, imageBytes);
			await refreshUntil(() => inWorkingTree('committed/image.png', 5) && isUntracked('zz_image_after.png'),
				'image switch fixture to appear');
			await vscode.commands.executeCommand('git.openChange', originalUri);
			await poll(() => extensionApi.getCurrentReviewUri() === originalUri.toString(), 'original image review');
			await sleep(300);
			if (kept) { await vscode.commands.executeCommand('workbench.action.keepEditor'); }
			const before = vscode.window.tabGroups.activeTabGroup.activeTab;
			assert.ok(before, 'image review must have an active tab');
			await vscode.commands.executeCommand('imagePreview.zoomIn');

			await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
			await refreshUntil(() => inIndex('committed/image.png', 0), 'original image to stage');
			await poll(() => extensionApi.getCurrentReviewUri() === nextUri.toString(), 'next image review');
			const nextTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			assert.ok(nextTab && nextTab !== before, 'next image must open its own fresh preview');

			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			await refreshUntil(() => !inIndex('committed/image.png') && inWorkingTree('committed/image.png', 5),
				'original image stage to undo');
			await poll(() => extensionApi.getCurrentReviewUri() === originalUri.toString(), 'original image to return');
			assert.notStrictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, before,
				'Undo must open a fresh image webview rather than retain its old zoom and pan');
		});
	}

	test('undo waits for a stage performed by VS Code built-in Git rather than Better Git', async () => {
		const content = lines(24, 'mod_a').split('\n');
		content[8] = 'mod_a BUILT-IN GIT STAGE line 9';
		write('committed/mod_a.txt', content.join('\n') + '\n');
		await refreshUntil(() => inWorkingTree('committed/mod_a.txt', 5), 'built-in stage fixture to appear');
		await vscode.window.showTextDocument(wsUri('committed/mod_a.txt'), { preview: false });

		// No explicit resource argument is the real keyboard/Command Palette path:
		// vscode.git resolves the active file to its internal SCM resource and stages it.
		await vscode.commands.executeCommand('git.stage');
		assert.strictEqual(
			git('diff --cached --name-only'),
			'committed/mod_a.txt',
			'VS Code built-in stage did not reach Git before immediate Undo'
		);
		await vscode.window.showTextDocument(wsUri('committed/mod_d.txt'), { preview: true });

		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await refreshUntil(
			() => !inIndex('committed/mod_a.txt') && inWorkingTree('committed/mod_a.txt', 5),
			'undo to restore a VS Code built-in stage'
		);
		await expectActiveTab('committed/mod_a.txt');
	});

	test('repeated undo walks the stage history without removing earlier staged work prematurely', async () => {
		const first = lines(24, 'mod_a').split('\n');
		first[4] = 'mod_a STAGE-THEN-UNDO line 5';
		write('committed/mod_a.txt', first.join('\n') + '\n');
		const later = lines(10, 'mod_d').split('\n');
		later[6] = 'mod_d LATER INDEX CHANGE line 7';
		write('committed/mod_d.txt', later.join('\n') + '\n');
		await refreshUntil(
			() => inWorkingTree('committed/mod_a.txt', 5) && inWorkingTree('committed/mod_d.txt', 5),
			'fail-closed undo fixtures to appear'
		);
		await openWorkingDiffAt('committed/mod_a.txt', 4);

		await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
		await refreshUntil(() => inIndex('committed/mod_a.txt', 0), 'first file to stage');
		git('add committed/mod_d.txt');
		await refreshUntil(() => inIndex('committed/mod_d.txt', 0), 'later independent index change to appear');
		await extensionApi.whenStageTransactionsSettled();

		await vscode.window.showTextDocument(wsUri('committed/del_b.txt'), { preview: true });
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await refreshUntil(
			() => inIndex('committed/mod_a.txt', 0) && !inIndex('committed/mod_d.txt') && inWorkingTree('committed/mod_d.txt', 5),
			'first undo to remove only the latest external stage'
		);
		await expectActiveTab('committed/mod_d.txt');

		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await refreshUntil(
			() => !inIndex('committed/mod_a.txt') && inWorkingTree('committed/mod_a.txt', 5) &&
				!inIndex('committed/mod_d.txt') && inWorkingTree('committed/mod_d.txt', 5),
			'second undo to restore the earlier Better Git stage'
		);
		await expectActiveTab('committed/mod_a.txt');
	});

	test('undo retains only the latest three of four real index transitions', async () => {
		const rel = 'committed/mod_a.txt';
		const trees: string[] = [];
		for (let sequence = 0; sequence < 4; sequence += 1) {
			write(rel, `three-entry undo stage ${sequence}\n`);
			git(`add ${rel}`);
			await repo.status();
			await extensionApi.whenStageTransactionsSettled();
			trees.push(git('write-tree').trim());
		}
		for (let index = 2; index >= 0; index -= 1) {
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('write-tree').trim(), trees[index]);
		}
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('write-tree').trim(), trees[0], 'the fourth Undo must preserve the evicted stage');
		assert.strictEqual(fs.readFileSync(wsUri(rel).fsPath, 'utf8'), 'three-entry undo stage 3\n');
	});

	test('rapid repeated undo consumes one stage-history entry per invocation', async () => {
		const first = lines(24, 'mod_a').split('\n');
		first[5] = 'mod_a RAPID UNDO line 6';
		write('committed/mod_a.txt', first.join('\n') + '\n');
		const second = lines(10, 'mod_d').split('\n');
		second[7] = 'mod_d RAPID UNDO line 8';
		write('committed/mod_d.txt', second.join('\n') + '\n');
		await refreshUntil(
			() => inWorkingTree('committed/mod_a.txt', 5) && inWorkingTree('committed/mod_d.txt', 5),
			'rapid undo fixtures to appear'
		);

		git('add committed/mod_a.txt');
		await refreshUntil(() => inIndex('committed/mod_a.txt', 0), 'first rapid undo stage to appear');
		await extensionApi.whenStageTransactionsSettled();
		git('add committed/mod_d.txt');
		await refreshUntil(() => inIndex('committed/mod_d.txt', 0), 'second rapid undo stage to appear');
		await extensionApi.whenStageTransactionsSettled();

		await Promise.all([
			vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance'),
			vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance'),
		]);
		await refreshUntil(
			() => !inIndex('committed/mod_a.txt') && inWorkingTree('committed/mod_a.txt', 5) &&
				!inIndex('committed/mod_d.txt') && inWorkingTree('committed/mod_d.txt', 5),
			'rapid undos to restore both index transitions'
		);
		await expectActiveTab('committed/mod_a.txt');
	});

	test('undo selects a new file restored to the separate untracked group', async () => {
		const config = vscode.workspace.getConfiguration('git');
		const previous = config.inspect<string>('untrackedChanges')?.globalValue;
		try {
			await config.update('untrackedChanges', 'separate', vscode.ConfigurationTarget.Global);
			const rel = 'new file "quoted".txt';
			write(rel, 'preserve this new file\n');
			await refreshUntil(() => isUntracked(rel), 'new undo fixture');
			await repo.add([wsUri(rel).fsPath]);
			await repo.status();
			await extensionApi.whenStageTransactionsSettled();
			await openPlainAt('committed/mod_d.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			await expectActiveTab(rel);
			assert.ok(isUntracked(rel) && !inIndex(rel));
			assert.strictEqual(fs.readFileSync(wsUri(rel).fsPath, 'utf8'), 'preserve this new file\n');
		} finally {
			await config.update('untrackedChanges', previous, vscode.ConfigurationTarget.Global);
		}
	});

	test('undo selects a restored deletion without recreating the deleted working file', async () => {
		const rel = 'committed/del_b.txt';
		fs.unlinkSync(wsUri(rel).fsPath);
		await refreshUntil(() => inWorkingTree(rel, 6), 'deleted undo fixture');
		await repo.add([wsUri(rel).fsPath]);
		await repo.status();
		await extensionApi.whenStageTransactionsSettled();
		await openPlainAt('committed/mod_d.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await expectActiveTab(rel);
		assert.ok(inWorkingTree(rel, 6) && !inIndex(rel));
		assert.strictEqual(fs.existsSync(wsUri(rel).fsPath), false);
	});

	for (const keepCurrent of [true, false]) {
		test(`undo selects ${keepCurrent ? 'the current affected file' : 'the first SCM file'} after an external multi-file stage`, async () => {
			for (const rel of ['committed/mod_a.txt', 'committed/mod_d.txt']) {
				fs.appendFileSync(wsUri(rel).fsPath, 'multi-file undo change\n');
			}
			await repo.status();
			await repo.add([wsUri('committed/mod_a.txt').fsPath, wsUri('committed/mod_d.txt').fsPath]);
			await repo.status();
			await extensionApi.whenStageTransactionsSettled();
			await openPlainAt(keepCurrent ? 'committed/mod_d.txt' : 'committed/del_b.txt', 0);
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			await expectActiveTab(keepCurrent ? 'committed/mod_d.txt' : 'committed/mod_a.txt');
			assert.strictEqual(git('diff --cached --name-only'), '');
		});
	}

	test('undo opens restored index content for a deleted file that was never committed', async () => {
		const rel = 'new-then-deleted.txt';
		write(rel, 'exists only in the restored index\n');
		await repo.add([wsUri(rel).fsPath]);
		await repo.status();
		await extensionApi.whenStageTransactionsSettled();
		fs.unlinkSync(wsUri(rel).fsPath);
		await repo.add([wsUri(rel).fsPath]);
		await repo.status();
		await extensionApi.whenStageTransactionsSettled();
		await openPlainAt('committed/mod_d.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await expectActiveTab(rel);
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		assert.ok(input instanceof vscode.TabInputText);
		assert.strictEqual((await vscode.workspace.openTextDocument(input.uri)).getText(), 'exists only in the restored index\n');
		assert.ok(inIndex(rel, 1) && inWorkingTree(rel, 6));
		assert.strictEqual(fs.existsSync(wsUri(rel).fsPath), false);
	});

	test('undo refuses after HEAD changes even when the index tree still matches', async () => {
		const content = lines(24, 'mod_a').split('\n');
		content[10] = 'mod_a COMMIT AFTER STAGE line 11';
		write('committed/mod_a.txt', content.join('\n') + '\n');
		await refreshUntil(() => inWorkingTree('committed/mod_a.txt', 5), 'commit-after-stage fixture to appear');
		git('add committed/mod_a.txt');
		await refreshUntil(() => inIndex('committed/mod_a.txt', 0), 'external stage before commit');
		await extensionApi.whenStageTransactionsSettled();
		git('commit -m "test commit after observed stage"');
		await refreshUntil(
			() => !inIndex('committed/mod_a.txt') && !inWorkingTree('committed/mod_a.txt'),
			'commit to leave a clean matching index'
		);
		await extensionApi.whenStageTransactionsSettled();
		const committedHead = git('rev-parse HEAD');

		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('rev-parse HEAD'), committedHead, 'undo rewound HEAD after a commit');
		assert.strictEqual(git('diff --cached --name-only'), '', 'undo changed the index after a commit');
	});

	test('MODIFIED wrapped tall hunk: SCM-focused rapid steps and reversal stay exact and monotonic', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousDiffWordWrap = diffConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 5, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await diffConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);

			const content = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 229; i++) {
				content[i] =
					`const wrappedTall${i} = '${'variable-fragment-'.repeat(4 + (i % 18))}'` +
					`${i % 3 === 0 ? ' + short' : ' + another-variable-tail'.repeat(1 + (i % 5))};`;
			}
			write('committed/tall_e.txt', content.join('\n') + '\n');
			await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5), 'wrapped tall_e change to appear');
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 0);
			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 10);
			await vscode.commands.executeCommand('workbench.view.scm');

			const rapidDown = await viewportTopsDuring(editor, () =>
				Promise.all([nextChange(), nextChange(), nextChange(), nextChange()])
			);
			await expectCursorVisibleAt('committed/tall_e.txt', 30);
			assertViewportMonotonic(rapidDown, 'down', 'wrapped tall-hunk rapid next');

			const rapidUp = await viewportTopsDuring(editor, () =>
				Promise.all([previousChange(), previousChange()])
			);
			await expectCursorVisibleAt('committed/tall_e.txt', 20);
			assertViewportMonotonic(rapidUp, 'up', 'wrapped tall-hunk rapid previous');

			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 25);
			assert.strictEqual(activeTabPath(), wsUri('committed/tall_e.txt').path);
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await diffConfig.update('wordWrap', previousDiffWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('partially staged tall file: unstaged navigation ignores the staged phantom region', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 5, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);

			const staged = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 99; i++) {
				staged[i] = `tall_e STAGED-ONLY line ${i + 1}`;
			}
			write('committed/tall_e.txt', staged.join('\n') + '\n');
			git('add committed/tall_e.txt');

			const working = staged.slice();
			for (let i = 180; i <= 229; i++) {
				working[i] = `tall_e WORKING-ONLY line ${i + 1}`;
			}
			write('committed/tall_e.txt', working.join('\n') + '\n');
			await refreshUntil(
				() => inIndex('committed/tall_e.txt', 0 /* INDEX_MODIFIED */) && inWorkingTree('committed/tall_e.txt', 5),
				'tall_e to become partially staged'
			);

			// Line 20 changed relative to HEAD but is unchanged in the displayed index-vs-working diff. Parsing
			// HEAD-vs-working would invent a tall hunk here and consume Next as 20->25; correct geometry jumps to 180.
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 20);
			await vscode.commands.executeCommand('workbench.view.scm');
			const jumpTops = await viewportTopsDuring(editor, nextChange);
			const actualHunk = await expectCursorVisibleAt('committed/tall_e.txt', 180);
			assert.notStrictEqual(actualHunk.selection.active.line, 25, 'staged-only phantom hunk consumed Next');
			assertViewportMonotonic(jumpTops, 'down', 'partially-staged jump to working hunk');

			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 185);
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
		}
	});

	test('MODIFIED tall hunk: rapid final-step plus rollover presents the hunk end first', async () => {
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		const previousStep = navConfig.inspect<number>('hunkStagingLineStep')?.globalValue;
		const previousThreshold = navConfig.inspect<number>('hunkStagingThreshold')?.globalValue;
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousDiffWordWrap = diffConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await navConfig.update('hunkStagingLineStep', 10_000, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', 1, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await diffConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);

			const tall = lines(260, 'tall_e').split('\n');
			for (let i = 10; i <= 229; i++) {
				tall[i] = `tall_e queued-boundary EDITED line ${i + 1}`;
			}
			tall[229] = `tall_e wrapped final segment ${'must-be-presented-'.repeat(160)}`;
			write('committed/tall_e.txt', tall.join('\n') + '\n');
			const nextFile = lines(40, 'mod_a').split('\n');
			nextFile[4] = 'mod_a queued-boundary EDITED line 5';
			write('committed/mod_a.txt', nextFile.join('\n') + '\n');
			await refreshUntil(
				() => inWorkingTree('committed/tall_e.txt', 5) && inWorkingTree('committed/mod_a.txt', 5),
				'queued boundary files to appear'
			);
			const editor = await openWorkingDiffAt('committed/tall_e.txt', 0);
			await nextChange();
			await expectCursorVisibleAt('committed/tall_e.txt', 10);
			assert.ok(!lineIsVisible(editor, 229), 'test precondition: final hunk line should start off-screen');

			const hunkEndPosition = editor.document.lineAt(229).range.end;
			let endBecameVisible = positionIsVisible(editor, hunkEndPosition);
			const visibleSub = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
				if (event.textEditor === editor && positionIsVisible(editor, hunkEndPosition)) {
					endBecameVisible = true;
				}
			});
			try {
				// The shared queue may execute the second press only after the first reveal settles and presents L230.
				await Promise.all([nextChange(), nextChange()]);
			} finally {
				visibleSub.dispose();
			}
			await expectActiveTab('committed/mod_a.txt');
			assert.ok(endBecameVisible, 'queued rollover changed files before the final wrapped hunk segment was presented');
		} finally {
			await navConfig.update('hunkStagingLineStep', previousStep, vscode.ConfigurationTarget.Global);
			await navConfig.update('hunkStagingThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await diffConfig.update('wordWrap', previousDiffWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// STAGED-NEW (INDEX_ADDED)
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('staged-new tall file opened as a PLAIN editor: still scroll-steps ±5', async () => {
		write('aa_staged.txt', lines(240, 'staged'));
		git('add aa_staged.txt');
		await refreshUntil(
			() => inIndex('aa_staged.txt', 1 /* INDEX_ADDED */) && !inWorkingTree('aa_staged.txt'),
			'aa_staged.txt to be INDEX_ADDED with a clean working tree'
		);
		await openPlainAt('aa_staged.txt', 0);

		const editor = visibleEditorFor(wsUri('aa_staged.txt'))!;
		const downTops = await viewportTopsDuring(editor, nextChange);
		await expectCursorVisibleAt('aa_staged.txt', 5);
		assertViewportMonotonic(downTops, 'down', 'staged-new next');
		const upTops = await viewportTopsDuring(editor, previousChange);
		await expectCursorVisibleAt('aa_staged.txt', 0);
		assertViewportMonotonic(upTops, 'up', 'staged-new previous');
	});

	test('staged-new file opened as its empty-original DIFF: normal nav, advances to the next file (no crawl)', async () => {
		write('aa_staged.txt', lines(20, 'staged'));
		git('add aa_staged.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('aa_staged.txt', 1) && isUntracked('ab_helper.txt'),
			'staged + helper files listed'
		);

		// Open the exact staged diff openChangeEntry builds for INDEX_ADDED: empty-tree vs index.
		const uri = wsUri('aa_staged.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, EMPTY_TREE), toGitUri(uri, ''), 'aa_staged.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'staged diff tab to open'
		);
		await sleep(500);

		// v1.2.1 DESIGN DECISION under test: a diff tab (even the fully-added one) uses NORMAL navigation.
		// The whole file is one change, so next falls through to the next file — never a 5-line crawl and
		// NEVER a silent no-op. (Changes list: staged group first -> aa_staged is index 0, helper is next.)
		await nextChange();
		await expectActiveTab('ab_helper.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// DELETED FILES — must never step, must always advance (the "does nothing on deleted" bug)
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('DELETED file (unstaged): next does NOT 5-line step, advances to the next file', async () => {
		fs.rmSync(path.join(ws, 'committed/del_b.txt'));
		write('committed/zz_helper.txt', lines(5, 'h')); // deterministic landing target, sorted after del_b
		await refreshUntil(
			() => inWorkingTree('committed/del_b.txt', 6 /* DELETED */) && isUntracked('committed/zz_helper.txt'),
			'deletion + helper to be listed'
		);

		// Open the deleted file the way the SCM row does: shows HEAD content as a plain git:-scheme editor.
		await vscode.commands.executeCommand('git.openChange', wsUri('committed/del_b.txt'));
		await poll(() => activeTabPath() === wsUri('committed/del_b.txt').path, 'deleted-file view to open');
		await sleep(300);

		await nextChange();
		// The core assertion for Ethan's "on a deleted file it does nothing" report: the press must
		// ADVANCE (deleted content is removed, not added — nothing to scroll through).
		await expectActiveTab('committed/zz_helper.txt');
	});

	test('STAGED deletion (INDEX_DELETED): next does NOT step, advances to the next file', async () => {
		git('rm -q committed/del_b.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('committed/del_b.txt', 2 /* INDEX_DELETED */) && isUntracked('ab_helper.txt'),
			'staged deletion + helper to be listed'
		);

		// Open the exact staged diff openChangeEntry builds for INDEX_DELETED: HEAD vs empty-tree.
		const uri = wsUri('committed/del_b.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, EMPTY_TREE), 'del_b.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'staged-deletion diff tab to open'
		);
		await sleep(500);

		await nextChange();
		await expectActiveTab('ab_helper.txt'); // staged group (del_b) is index 0 -> next is the helper
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// RENAMED FILE — git's classic "delete+add" trap: must NOT be treated as added
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('RENAMED file (INDEX_RENAMED): next does NOT step, navigates normally to the next file', async () => {
		git('mv committed/ren_c.txt committed/ren_c_renamed.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('committed/ren_c_renamed.txt', 3 /* INDEX_RENAMED */) && isUntracked('ab_helper.txt'),
			'rename + helper to be listed'
		);

		// Open the staged rename diff the way openChangeEntry does: HEAD blob at the ORIGINAL path vs
		// index blob at the NEW path. Content is identical (pure rename) -> zero hunks.
		const oldUri = wsUri('committed/ren_c.txt');
		const newUri = wsUri('committed/ren_c_renamed.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(oldUri, 'HEAD'), toGitUri(newUri, ''), 'ren_c_renamed.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'rename diff tab to open'
		);
		await sleep(500);

		// A pure rename has no hunks -> next must fall straight through to the next file. If the rename
		// were mis-detected as "fully added" (the delete+add trap), we'd see a 5-line crawl instead.
		await nextChange();
		await expectActiveTab('ab_helper.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// DUAL-STATE (INDEX_ADDED + MODIFIED) — the stage-then-edit hijack guard
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('staged-new file edited again (dual-state): working-tree diff uses HUNK navigation, not stepping', async () => {
		// Stage a new 30-line file, then edit ONE line -> the file is INDEX_ADDED *and* MODIFIED.
		write('aa_dual.txt', lines(30, 'dual'));
		git('add aa_dual.txt');
		const edited = lines(30, 'dual').split('\n');
		edited[9] = 'dual line 10 EDITED';
		write('aa_dual.txt', edited.join('\n'));
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('aa_dual.txt', 1 /* INDEX_ADDED */) && inWorkingTree('aa_dual.txt', 5 /* MODIFIED */) && isUntracked('ab_helper.txt'),
			'dual-state (INDEX_ADDED + MODIFIED) to be listed'
		);

		// The working-tree diff (index vs working tree) has exactly one real hunk at line 9. v1.2.0 treated
		// this file as "fully added" purely because an INDEX_ADDED entry existed and crawled 5 lines instead.
		await vscode.commands.executeCommand('git.openChange', wsUri('aa_dual.txt'));
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('aa_dual.txt')) !== undefined,
			'dual-state working-tree diff to render'
		);
		await sleep(500);
		const editor = visibleEditorFor(wsUri('aa_dual.txt'))!;
		editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		await nextChange();
		// hunk starts at 0-based line 9 — a 5-line step would land on line 5
		const after = await expectCursorAt('aa_dual.txt', 9);
		assert.notStrictEqual(after.selection.active.line, 5, 'dual-state file got the 5-line step — the stage-then-edit hijack is back');
	});

	// Ethan (2026-11-03): Next at a file's end deliberately restarts the next file, even on a revisit.
	// Native/SCM switches and Previous retain resume behavior; a delayed restore must not undo this landing.
	for (const targetKind of ['plain', 'diff'] as const) {
		for (const entry of ['next', 'stage-next', 'eyes'] as const) {
			test(`forward boundary restarts remembered ${targetKind} through ${entry}`, async () => {
				const from = `forward_${targetKind}_${entry}_a.txt`, to = `forward_${targetKind}_${entry}_b.txt`;
				if (targetKind === 'diff') {
					commitLandingFixtures({ [from]: 1, [to]: 300 }, 'remembered forward');
					editLines(from, 1, [0]); editLines(to, 300, [8, 170]);
					await refreshUntil(() => inWorkingTree(from, 5) && inWorkingTree(to, 5), 'forward diff fixtures');
				} else {
					write(from, 'origin'); write(to, lines(300, 'remembered target'));
					await refreshUntil(() => isUntracked(from) && isUntracked(to), 'forward plain fixtures');
				}
				// openPlainAt requires an exact viewport top, which sticky context need not give at
				// arbitrary lines. Establish the real saved cursor/view directly, as the revisit tests do.
				const old = targetKind === 'diff' ? await openWorkingDiffAt(to, 170) : await openPlainAt(to, 0);
				old.selection = new vscode.Selection(170, 0, 170, 0);
				old.revealRange(new vscode.Range(155, 0, 155, 0), vscode.TextEditorRevealType.AtTop);
				await poll(() => {
					const saved = extensionApi.getRememberedReviewPosition?.(wsUri(to));
					return saved && saved.selections[0].active.line === 170 && (saved.topLine ?? 0) > 100;
				}, 'destination remembered below its first change');
				if (targetKind === 'diff') { await openWorkingDiffAt(from, 0); }
				else { await openPlainAt(from, 0); }
				if (entry === 'eyes') { await keyboardReview.begin('next'); }
				if (entry === 'stage-next') {
					await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
				} else { await nextChange(); }
				await expectActiveTab(to);
				await expectCursorVisibleAt(to, targetKind === 'diff' ? 8 : 0);
				// A following real press must continue from the new start, never the old cached midpoint.
				await nextChange();
				const continued = visibleEditorFor(wsUri(to))!;
				assert.strictEqual(activeTabPath(), wsUri(to).path);
				if (targetKind === 'diff') { assert.strictEqual(continued.selection.active.line, 170); }
				else { assert.ok(continued.selection.active.line > 0 && continued.selection.active.line < 30); }
				if (entry === 'eyes') { await keyboardReview.cancel(); }
				if (entry === 'stage-next') {
					assert.strictEqual(git('diff --cached --name-only'), from);
					await extensionApi.whenStageTransactionsSettled();
					await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
					await expectActiveTab(from);
					assert.strictEqual(git('diff --cached --name-only'), '');
				}
			});
		}
	}

	test('unstaged review positions survive switching plain preview files and backward navigation', async () => {
		const a = 'position_a.txt', b = 'position_b.txt';
		write(a, lines(400, 'remember a')); write(b, lines(400, 'remember b'));
		await refreshUntil(() => isUntracked(a) && isUntracked(b), 'position plain files');
		const editor = await openPlainAt(a, 0);
		editor.selection = new vscode.Selection(160, 3, 160, 7);
		editor.revealRange(new vscode.Range(145, 0, 145, 0), vscode.TextEditorRevealType.AtTop);
		const saved = await poll(() => {
			const v = extensionApi.getRememberedReviewPosition?.(wsUri(a));
			return v && (v.topLine ?? 0) > 100 && v.selections[0].active.line === 160 ? v : undefined;
		}, 'non-default plain review position to be captured');
		await vscode.commands.executeCommand('better-git-vscode.next-changed-file');
		await expectActiveTab(b);
		await vscode.commands.executeCommand('better-git-vscode.previous-changed-file');
		await expectActiveTab(a);
		await poll(() => {
			const e = visibleEditorFor(wsUri(a));
			return e && e.selection.anchor.line === 160 && e.selection.active.character === 7
				&& Math.abs(e.visibleRanges[0].start.line - (saved.topLine ?? 0)) <= 1;
		}, 'revisit to restore selection and scroll instead of landing at EOF');
	});

	test('explicit next-file browsing still restores a remembered position', async () => {
		const a = 'browse_position_a.txt', b = 'browse_position_b.txt';
		write(a, lines(300, 'browse a')); write(b, lines(300, 'browse b'));
		await refreshUntil(() => isUntracked(a) && isUntracked(b), 'explicit file browsing fixtures');
		const editor = await openPlainAt(b, 0);
		editor.selection = new vscode.Selection(170, 0, 170, 0);
		editor.revealRange(new vscode.Range(155, 0, 155, 0), vscode.TextEditorRevealType.AtTop);
		await poll(() => (extensionApi.getRememberedReviewPosition?.(wsUri(b))?.topLine ?? 0) > 100, 'remembered browse position');
		await openPlainAt(a, 0);
		await vscode.commands.executeCommand('better-git-vscode.next-changed-file');
		await expectCursorVisibleAt(b, 170);
	});

	test('unstaged review positions restore native working-diff switches and manual scrolling with an old cursor', async () => {
		const a = 'committed/mod_a.txt', b = 'committed/mod_d.txt';
		write(a, lines(400, 'changed a')); write(b, lines(400, 'changed b'));
		await refreshUntil(() => inWorkingTree(a, 5) && inWorkingTree(b, 5), 'position diff files');
		const editor = await openWorkingDiffAt(a, 3);
		editor.revealRange(new vscode.Range(150, 0, 150, 0), vscode.TextEditorRevealType.AtTop);
		const saved = await poll(() => {
			const v = extensionApi.getRememberedReviewPosition?.(wsUri(a));
			return v && (v.topLine ?? 0) > 100 ? v : undefined;
		}, 'scrolled diff to be remembered without moving its cursor');
		await vscode.commands.executeCommand('git.openChange', wsUri(b));
		await vscode.commands.executeCommand('git.openChange', wsUri(a));
		await poll(() => {
			const e = visibleEditorFor(wsUri(a));
			return e && e.selection.active.line === saved.selections[0].active.line
				&& Math.abs(e.visibleRanges[0].start.line - (saved.topLine ?? 0)) <= 1;
		}, 'native SCM-equivalent revisit restores cursor and viewport');
	});

	test('unstaged review positions survive failed staging and clear only after successful whole-file stage', async () => {
		const a = 'position_stage_a.txt', b = 'position_stage_b.txt';
		write(a, lines(300, 'stage a')); write(b, lines(10, 'stage b'));
		await refreshUntil(() => isUntracked(a) && isUntracked(b), 'position stage files');
		const editor = await openPlainAt(a, 0);
		editor.selection = new vscode.Selection(120, 0, 120, 0);
		editor.revealRange(new vscode.Range(110, 0, 110, 0), vscode.TextEditorRevealType.AtTop);
		await poll(() => (extensionApi.getRememberedReviewPosition?.(wsUri(a))?.topLine ?? 0) > 80, 'position before staging');
		// Use the suite's existing isolated API-failure pattern: native Git retries an actual index.lock
		// itself, so holding that lock while awaiting add would deadlock the fixture rather than test us.
		const prototype = Object.getPrototypeOf(repo), originalAdd = prototype.add;
		prototype.add = async () => { throw new Error('intentional isolated position-stage failure'); };
		try { await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file'); }
		finally { prototype.add = originalAdd; }
		assert.ok(extensionApi.getRememberedReviewPosition?.(wsUri(a)), 'a failed stage retains the saved review');
		await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
		await expectActiveTab(b);
		assert.strictEqual(extensionApi.getRememberedReviewPosition?.(wsUri(a)), undefined, 'successful stage forgets only that file');
		await extensionApi.whenStageTransactionsSettled();
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		await poll(() => visibleEditorFor(wsUri(a))?.selection.active.line === 120, 'exact Undo still restores its independent saved view');
	});

	test('unstaged review positions include deleted text and clear after native staging', async () => {
		const a = 'position_deleted.txt', b = 'position_next.txt';
		write(a, lines(300, 'deleted review')); git(`add ${a}`); git('commit -m "position deletion fixture"');
		fs.unlinkSync(wsUri(a).fsPath); write(b, 'next');
		await refreshUntil(() => inWorkingTree(a, 6) && isUntracked(b), 'deleted position file');
		await vscode.commands.executeCommand('git.openChange', wsUri(a));
		const editor = await poll(() => vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'git'
			&& uriFilePath(e.document.uri) === wsUri(a).path), 'read-only deleted text editor');
		editor.selection = new vscode.Selection(140, 2, 140, 2);
		editor.revealRange(new vscode.Range(130, 0, 130, 0), vscode.TextEditorRevealType.AtTop);
		const saved = await poll(() => {
			const v = extensionApi.getRememberedReviewPosition?.(wsUri(a));
			return v && (v.topLine ?? 0) > 100 ? v : undefined;
		}, 'deleted text position');
		await vscode.commands.executeCommand('git.openChange', wsUri(b));
		await vscode.commands.executeCommand('git.openChange', wsUri(a));
		await poll(() => vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === saved.documentUri
			&& e.selection.active.line === 140 && Math.abs(e.visibleRanges[0].start.line - (saved.topLine ?? 0)) <= 1), 'deleted text revisit');
		await repo.add([wsUri(a).fsPath]);
		await repo.status();
		await poll(() => !extensionApi.getRememberedReviewPosition?.(wsUri(a)), 'native stage clears saved position');
	});

	// ── Keyboard review: Ethan's keyboard eyes mode ──────────────────────────────────────────────
	// The binding-neutral commands build the same pending selection as the held mouse/wand eyes wheel. Run these
	// on the Mini with BGV_TEST_GREP='keyboard review'. They never use the old immediate Shift shortcuts' bindings.
	const keyboardReview = {
		begin: (direction: 'next' | 'previous') => vscode.commands.executeCommand('better-git-vscode.begin-keyboard-review', direction),
		step: (direction: 'next' | 'previous') => vscode.commands.executeCommand('better-git-vscode.step-keyboard-review', direction),
		finish: () => vscode.commands.executeCommand('better-git-vscode.finish-keyboard-review'),
		cancel: () => vscode.commands.executeCommand('better-git-vscode.cancel-keyboard-review'),
	};
	const badge = (rel: string) => extensionApi.getReviewDecorationBadge(wsUri(rel));

	for (const direction of ['next', 'previous'] as const) {
        test(`keyboard review legacy shifted ${direction} shortcut still stages immediately without toggling`, async () => {
            const names = ['kb_toggle_a.txt', 'kb_toggle_b.txt', 'kb_toggle_c.txt'];
            for (const name of names) { write(name, name); }
            await refreshUntil(() => names.every(isUntracked), 'keyboard legacy files');
            const start = direction === 'next' ? 0 : 2;
            await openPlainAt(names[start], 0); await focusIsolatedTestWindow();
            await vscode.commands.executeCommand(`better-git-vscode.stage-and-${direction}-changed-file`,
                { source: 'keyboard', physicalKey: direction === 'next' ? 'x' : 'z' });
            assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
            assert.strictEqual(git('diff --cached --name-only'), names[start]);
            await extensionApi.whenStageTransactionsSettled();
            await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
            assert.strictEqual(git('diff --cached --name-only'), '');
        });
    }

    test('held keyboard repeat paces completed steps, preserves fresh presses and keeps review release exact', async () => {
        const names = Array.from({length: 7}, (_, n) => `kb_repeat_${n}.txt`);
        for (const name of names) { write(name, name); }
        await refreshUntil(() => names.every(isUntracked), 'held keyboard repeat files');
        await openPlainAt(names[0], 0); await focusIsolatedTestWindow();
        const sample = (mask = 0, option = true, shift = false) => extensionApi.sampleKeyboardReviewKeys!({
            option, shift, navigation: mask !== 0, usedShift: false, navigationKeys: mask });
        const next = () => vscode.commands.executeCommand('better-git-vscode.next-scm-change', {source:'keyboard',physicalKey:'x'});
        sample(0, false); sample(2);
        await Promise.all([next(), ...Array.from({length: 30}, next)]);
        await expectActiveTab(names[1]);
        await Promise.all(Array.from({length: 30}, next));
        assert.strictEqual(activeTabPath(), wsUri(names[1]).path, 'repeats leave a glance interval after the opened change');
        await sleep(60); // Exercise the requested 50 ms hold interval; no production input timer is added.
        await next(); await expectActiveTab(names[2]);
        sample(0); sample(2); await next(); await expectActiveTab(names[3]);
        assert.strictEqual(git('diff --cached --name-only'), '', 'ordinary held navigation never stages');
        sample(0); sample(0, true, true); sample(0);
        await extensionApi.whenKeyboardGestureSettled!();
        assert.strictEqual(badge(names[3]), '👀');
        sample(2); await Promise.all([next(), ...Array.from({length: 20}, next)]);
        await expectActiveTab(names[4]);
        assert.strictEqual(badge(names[3]), '💥💥'); assert.strictEqual(badge(names[4]), '👀');
        sample(0, false); await extensionApi.whenKeyboardGestureSettled!();
        await extensionApi.whenStageTransactionsSettled();
        assert.strictEqual(git('diff --cached --name-only'), names[3], 'release stages the reviewed file once and excludes the eyes endpoint');
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        await extensionApi.whenStageTransactionsSettled();
        assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the batch');
    });

    test('keyboard review modifier cycle preserves a populated set across alternating eyes and files, then release commits once', async () => {
        const names = ['kb_cycle_a.txt', 'kb_cycle_b.txt', 'kb_cycle_c.txt', 'kb_cycle_d.txt'];
        for (const name of names) { write(name, name); }
        await refreshUntil(() => names.every(isUntracked), 'keyboard cycle files');
        await openPlainAt(names[0], 0); await focusIsolatedTestWindow();
        const sample = (option = false, shift = false, navigation = false) => extensionApi.sampleKeyboardReviewKeys!({ option, shift, navigation, usedShift: false });
        const tap = () => { sample(true, true); sample(true); };
        sample(); sample(true); tap();
        await keyboardReview.step('next'); // a reviewed, b still under eyes.
        assert.strictEqual(badge(names[0]), '💥💥'); assert.strictEqual(badge(names[1]), '👀');
        tap(); await keyboardReview.step('next'); // file mode expands same set to c.
        assert.strictEqual(badge(names[0]), '💥💥'); assert.strictEqual(badge(names[2]), '💥💥');
        tap(); // return directly to eyes without losing a or b.
        assert.strictEqual(git('diff --cached --name-only'), '');
        assert.strictEqual(badge(names[0]), '💥💥'); assert.strictEqual(badge(names[1]), '💥💥');
        assert.strictEqual(badge(names[2]), '👀');
        sample(false, true, true); sample(false, false, true);
        assert.strictEqual(git('diff --cached --name-only'), '', 'wait for final navigation key release');
        sample();
        await extensionApi.whenKeyboardGestureSettled!();
        await extensionApi.whenStageTransactionsSettled();
        assert.deepStrictEqual(git('diff --cached --name-only').split('\n'), names.slice(0, 2));
        assert.strictEqual(activeTabPath(), wsUri(names[2]).path, 'eyes preview remains open/unstaged');
        await extensionApi.whenStageTransactionsSettled();
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the whole set');
    });

    test('keyboard modifier retry after an empty begin enters eyes without releasing Option', async () => {
        await openPlainAt('committed/mod_d.txt', 0); await focusIsolatedTestWindow();
        const sample = (option = false, shift = false) => extensionApi.sampleKeyboardReviewKeys!({option,shift,navigation:false,usedShift:false});
        const tap = async () => { sample(true,true); sample(true); await extensionApi.whenKeyboardGestureSettled!(); };
        sample(); sample(true); await tap();
        assert.strictEqual(extensionApi.isKeyboardReviewActive(), false, 'a clean starting file retires the empty begin');
        write('kb_retry_a.txt', 'first'); write('kb_retry_b.txt', 'second');
        await refreshUntil(() => isUntracked('kb_retry_a.txt') && isUntracked('kb_retry_b.txt'), 'keyboard retry files');
        await openPlainAt('kb_retry_a.txt', 0); // Option stays held across the rejected entry and file switch.
        await tap();
        assert.strictEqual(badge('kb_retry_a.txt'), '👀', 'a rejected begin must not advance the next session to explosion');
        await tap();
        assert.strictEqual(badge('kb_retry_a.txt'), '💥💥', 'the next real toggle still enters file mode');
        await tap();
        await keyboardReview.step('next');
        sample(); await extensionApi.whenKeyboardGestureSettled!();
        await extensionApi.whenStageTransactionsSettled();
        assert.strictEqual(git('diff --cached --name-only'), 'kb_retry_a.txt', 'eyes release stages only the reviewed file');
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        await extensionApi.whenStageTransactionsSettled();
        assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the set');
    });

    test('keyboard review file mode release includes current file and the next gesture starts in eyes', async () => {
        const names = ['kb_files_a.txt', 'kb_files_b.txt', 'kb_files_c.txt'];
        for (const name of names) { write(name, name); }
        await refreshUntil(() => names.every(isUntracked), 'keyboard file mode files');
        await openPlainAt(names[0], 0); await focusIsolatedTestWindow();
        const sample = (option = false, shift = false) => extensionApi.sampleKeyboardReviewKeys!({option,shift,navigation:false,usedShift:false});
        const tap = async () => {sample(true,true); sample(true); await extensionApi.whenKeyboardGestureSettled!();};
        sample(); sample(true); await tap(); await tap();
        await keyboardReview.step('next');
        await keyboardReview.step('previous'); // reverse removes b even after changing modes.
        assert.strictEqual(badge(names[1]), undefined);
        sample(); await extensionApi.whenKeyboardGestureSettled!();
        assert.strictEqual(git('diff --cached --name-only'), names[0], 'file mode includes its endpoint');
        await extensionApi.whenStageTransactionsSettled();
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        sample(true); await tap();
        assert.strictEqual(badge(names[0]), '👀', 'fresh gesture starts in eyes, never inherited file mode');
        await keyboardReview.cancel(); sample();
        assert.strictEqual(git('diff --cached --name-only'), '');
    });

	for (const direction of ['next', 'previous'] as const) {
		test(`keyboard review ${direction} marks reviewed files, stages once on finish and one Undo restores them`, async () => {
			const names = ['kb_a.txt', 'kb_b.txt', 'kb_c.txt', 'kb_d.txt', 'kb_e.txt'];
			for (const name of names) { write(name, name); }
			await refreshUntil(() => names.every(isUntracked), 'keyboard review files');
			const step = direction === 'next' ? 1 : -1;
			const reverse = direction === 'next' ? 'previous' : 'next';
			const start = direction === 'next' ? 1 : 3;
			const editor = await openPlainAt(names[start], 0);
			await focusIsolatedTestWindow();
			const selection = editor.selection;
			try {
				await keyboardReview.begin(direction);
				assert.strictEqual(activeTabPath(), wsUri(names[start]).path, 'begin reviews the current file in place');
				assert.deepStrictEqual(editor.selection, selection, 'begin leaves the cursor still');
				assert.strictEqual(badge(names[start]), '👀');
				assert.strictEqual(extensionApi.isKeyboardReviewActive(), true);
				for (const offset of [1, 2]) {
					await keyboardReview.step(direction);
					await expectActiveTab(names[start + offset * step]);
					assert.strictEqual(git('diff --cached --name-only'), '', 'review steps never stage');
				}
				assert.strictEqual(badge(names[start]), '💥💥');
				assert.strictEqual(badge(names[start + step]), '💥💥');
				assert.strictEqual(badge(names[start + 2 * step]), '👀');
				await keyboardReview.step(reverse);
				await expectActiveTab(names[start + step]);
				assert.notStrictEqual(badge(names[start + 2 * step]), '💥💥', 'moving back removes the file being left');
				assert.strictEqual(badge(names[start + step]), '👀');
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
				await keyboardReview.finish();
				assert.strictEqual(git('diff --cached --name-only'), names[start], 'finish stages the reviewed file, not the viewed one');
				assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'finish keeps the viewed file open');
				assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
				await keyboardReview.finish();
				assert.strictEqual(git('diff --cached --name-only'), names[start], 'a repeated finish is inert');
				await extensionApi.whenStageTransactionsSettled();
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the batch');
				assert.strictEqual(activeTabPath(), wsUri(names[start]).path, 'Undo returns to the reviewed starting view');
			} finally {
				await keyboardReview.cancel();
			}
		});
	}

	test('keyboard review continues through ordinary Next/Previous instead of discarding the selection', async () => {
		const names = ['kb_plain_a.txt', 'kb_plain_b.txt', 'kb_plain_c.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard plain-navigation files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			await nextChange();
			await expectActiveTab(names[1]);
			await nextChange();
			await expectActiveTab(names[2]);
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), true, 'ordinary Next stays inside the review');
			assert.strictEqual(badge(names[0]), '💥💥');
			assert.strictEqual(badge(names[1]), '💥💥');
			assert.strictEqual(badge(names[2]), '👀');
			await previousChange();
			await expectActiveTab(names[1]);
			assert.notStrictEqual(badge(names[2]), '💥💥', 'ordinary Previous removes the file being left');
			assert.strictEqual(git('diff --cached --name-only'), '');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), names[0]);
		} finally {
			await keyboardReview.cancel();
		}
	});

	test('keyboard review hunk steps stay in the file and only crossing the boundary marks it', async () => {
		const a = lines(40, 'mod_a').split('\n');
		a[4] = 'mod_a first hunk EDITED';
		a[24] = 'mod_a second hunk EDITED';
		write('committed/mod_a.txt', a.join('\n') + '\n');
		// Keep both peers in the same SCM folder/status group: root untracked files sort before this folder.
		write('committed/mod_d.txt', lines(10, 'mod_d').replace('mod_d line 3', 'mod_d changed') + '\n');
		await refreshUntil(() => inWorkingTree('committed/mod_a.txt', 5) && inWorkingTree('committed/mod_d.txt', 5),
			'modified file and peer for keyboard hunk review');
		await openWorkingDiffAt('committed/mod_a.txt', 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			assert.strictEqual(badge('committed/mod_a.txt'), '👀');
			await keyboardReview.step('next');
			assert.strictEqual(activeTabPath(), wsUri('committed/mod_a.txt').path, 'the first step reviews a hunk in place');
			assert.strictEqual(badge('committed/mod_a.txt'), '👀', 'in-file movement does not change the selection');
			// Viewport anchoring may first select a visible hunk without scrolling; require bounded progress.
			for (let n = 0; n < 6 && activeTabPath() === wsUri('committed/mod_a.txt').path; n++) {
				await keyboardReview.step('next');
				assert.strictEqual(git('diff --cached --name-only'), '', 'hunk steps never stage');
			}
			await expectActiveTab('committed/mod_d.txt');
			assert.strictEqual(badge('committed/mod_a.txt'), '💥💥', 'crossing the boundary marks the reviewed file');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), 'committed/mod_a.txt');
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally {
			await keyboardReview.cancel();
		}
	});

	// Entry must work for the same deleted-image/Git-side shapes as fire and mouse entry, not just a tiny PNG.
	for (const direction of ['next', 'previous'] as const) for (const imageView of ['single preview', 'comparison'] as const)
	for (const imageState of ['deleted', 'staged-modified-deleted', 'staged-new-lfs-deleted'] as const) {
		test(`keyboard review ${direction} ${imageView} ${imageState} starts on a deleted image and stages it with one exact Undo`, async () => {
			const rel = imageState === 'staged-new-lfs-deleted' ? 'committed/added-image.png' : 'committed/image.png';
			const uri = wsUri(rel);
			if (imageState !== 'deleted') {
				const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
				fs.writeFileSync(uri.fsPath, imageState === 'staged-new-lfs-deleted'
					? `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n` : bytes);
				git(`add ${rel}`);
			}
			fs.rmSync(uri.fsPath);
			const peer = direction === 'next' ? 'committed/zz_image_peer.txt' : 'committed/aaa_image_peer.txt';
			write(peer, 'peer review');
			await refreshUntil(() => inWorkingTree(rel, 6) && isUntracked(peer), 'deleted image keyboard fixture');
			const indexBefore = git('write-tree');
			try {
				// A deleted image opens as a non-text review: the begin path resolves it from the tab, not an editor.
				if (imageView === 'comparison') {
					await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, '~'), toGitUri(uri, EMPTY_TREE), 'deleted image comparison');
				} else { await vscode.commands.executeCommand('git.openChange', uri); }
				await poll(() => extensionApi.getCurrentReviewUri() === uri.toString(), 'image review URI');
				await sleep(300); // Allow the native media preview to finish rendering.
				await focusIsolatedTestWindow();
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
				await keyboardReview.begin(direction);
				assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '👀',
					`deleted image must enter keyboard review (${JSON.stringify(vscode.window.tabGroups.activeTabGroup.activeTab?.input)}): ${extensionApi.getMouseDebugTrace().join(' | ')}`);
				if (imageState !== 'deleted' && tab?.input === undefined) {
					// Any opaque dual-state image can hide its side, including a single index preview. Held entry first shows the exact
					// unstaged index preview; it must never guess or stage the other version behind the view.
					assert.strictEqual(extensionApi.getCurrentReviewUri(), uri.toString(), 'normalization keeps the same deleted image');
				} else { assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'begin keeps the image preview'); }
				assert.strictEqual(git('write-tree'), indexBefore, 'begin must not stage');
				await keyboardReview.cancel();
				assert.strictEqual(git('write-tree'), indexBefore, 'cancel keeps both versions untouched');
				assert.strictEqual(extensionApi.getCurrentReviewUri(), uri.toString(), 'cancel stays on the deleted image');
				await keyboardReview.begin(direction);
				assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '👀', 'the same image can immediately re-enter review');
				await keyboardReview.step(direction);
				await expectActiveTab(peer);
				assert.strictEqual(extensionApi.getReviewDecorationBadge(uri), '💥💥', 'reviewed image is marked');
				assert.strictEqual(badge(peer), '👀', 'peer remains under review');
				await keyboardReview.finish();
				await extensionApi.whenStageTransactionsSettled();
				assert.strictEqual(git(`ls-files -- ${rel}`), '', 'finish stages the deletion');
				assert.ok(!git('diff --cached --name-only').split('\n').includes(peer), 'the viewed peer stays unstaged');
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
				await extensionApi.whenStageTransactionsSettled();
				assert.strictEqual(git('write-tree'), indexBefore, 'one Undo restores the exact pre-review index');
				assert.ok(!fs.existsSync(uri.fsPath), 'Undo never recreates the working image');
			} finally {
				await keyboardReview.cancel();
				await sleep(300); // Undo reopens the asynchronous native media preview.
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			}
		});
	}

	for (const imageView of ['single preview', 'comparison'] as const) {
		test(`keyboard review rejects staged deletion ${imageView} with a recreated working image`, async () => {
			const rel = 'committed/image.png'; const uri = wsUri(rel);
			fs.rmSync(uri.fsPath); git(`add ${rel}`);
			fs.writeFileSync(uri.fsPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'));
			await refreshUntil(() => inIndex(rel, 2) && isUntracked(rel), 'staged deletion with recreated image');
			const indexBefore = git('write-tree');
			try {
				if (imageView === 'comparison') {
					await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, EMPTY_TREE), 'staged deleted image');
				} else { await vscode.commands.executeCommand('vscode.open', toGitUri(uri, 'HEAD')); }
				await poll(() => extensionApi.getCurrentReviewUri() === uri.toString(), 'staged image review URI');
				await focusIsolatedTestWindow();
				await keyboardReview.begin('next');
				assert.strictEqual(extensionApi.isKeyboardReviewActive(), false, 'staged image cannot silently select the recreated working file');
				await keyboardReview.finish();
				assert.strictEqual(git('write-tree'), indexBefore, 'rejected staged view never stages its working copy');
			} finally {
				await keyboardReview.cancel();
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			}
		});
	}

	test('keyboard review never takes over a mouse hold, and a later mouse hold ends it unstaged', async () => {
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previous = config.inspect<boolean>('experimentalMouseHoldNavigateOnButtonDown')?.globalValue;
		await config.update('experimentalMouseHoldNavigateOnButtonDown', false, vscode.ConfigurationTarget.Global);
		const names = ['kb_iso_a.txt', 'kb_iso_b.txt', 'kb_iso_c.txt', 'kb_iso_d.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard isolation files');
		try {
			await openPlainAt(names[1], 0);
			await focusIsolatedTestWindow();
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
			await keyboardReview.begin('next');
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), false, 'a live mouse hold keeps review input');
			assert.strictEqual(badge(names[1]), '💥💥', 'the mouse selection is untouched');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), '', 'keyboard finish cannot release the mouse hold');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'corsair', direction: 'next' });
			assert.strictEqual(git('diff --cached --name-only'), names[1], 'the mouse release stages its own file');
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');

			await openPlainAt(names[0], 0);
			await keyboardReview.begin('next');
			await keyboardReview.step('next');
			await expectActiveTab(names[1]);
			await vscode.commands.executeCommand('better-git-vscode.begin-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), false, 'a new mouse hold ends the keyboard review');
			assert.notStrictEqual(badge(names[0]), '💥💥', 'the keyboard selection is discarded unstaged');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), '', 'a superseded keyboard review cannot finish');
			await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'razer');
			await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source: 'razer', direction: 'next' });
			assert.strictEqual(git('diff --cached --name-only'), names[1], 'only the mouse hold file is staged');
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally {
			await keyboardReview.cancel();
			await config.update('experimentalMouseHoldNavigateOnButtonDown', previous, vscode.ConfigurationTarget.Global);
		}
	});

	test('keyboard review ignores mouse-tagged release and cancel inputs', async () => {
		const names = ['kb_tag_a.txt', 'kb_tag_b.txt', 'kb_tag_c.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard tagged-input files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			await keyboardReview.step('next');
			await expectActiveTab(names[1]);
			for (const source of ['corsair', 'razer']) {
				await vscode.commands.executeCommand('better-git-vscode.finish-mouse-navigation-hold', { source, direction: 'next' });
				await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance', source);
			}
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), true, 'mouse release/cancel inputs belong to mouse holds');
			assert.strictEqual(badge(names[0]), '💥💥');
			assert.strictEqual(git('diff --cached --name-only'), '');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), names[0]);
		} finally {
			await keyboardReview.cancel();
		}
	});

	test('keyboard review cancel discards the selection, restores the starting view and keeps earlier Undo history', async () => {
		write('kb_history.txt', 'earlier stage');
		const names = ['kb_cancel_a.txt', 'kb_cancel_b.txt', 'kb_cancel_c.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => isUntracked('kb_history.txt') && names.every(isUntracked), 'keyboard cancel files');
		await openPlainAt('kb_history.txt', 0);
		await vscode.commands.executeCommand('better-git-vscode.stage-current-file');
		await extensionApi.whenStageTransactionsSettled();
		const editor = await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		const selection = editor.selection;
		await keyboardReview.begin('next');
		await keyboardReview.step('next');
		await keyboardReview.step('next');
		await expectActiveTab(names[2]);
		await keyboardReview.cancel();
		await expectActiveTab(names[0]);
		assert.deepStrictEqual(visibleEditorFor(wsUri(names[0]))?.selection, selection, 'cancel restores the starting cursor');
		assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
		for (const name of names) { assert.notStrictEqual(badge(name), '💥💥', 'cancel clears the pending selection'); }
		await keyboardReview.finish();
		assert.strictEqual(git('diff --cached --name-only'), 'kb_history.txt', 'nothing reviewed is staged');
		await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
		assert.strictEqual(git('diff --cached --name-only'), '', 'the earlier stage is still the latest Undo');
	});

	test('keyboard review ends unstaged when the immediate Stage + Next command runs', async () => {
		const names = ['kb_imm_a.txt', 'kb_imm_b.txt', 'kb_imm_c.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard immediate-stage files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			await keyboardReview.step('next');
			await expectActiveTab(names[1]);
			await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
			assert.strictEqual(git('diff --cached --name-only'), names[1], 'the untagged command keeps its immediate meaning');
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
			assert.notStrictEqual(badge(names[0]), '💥💥');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), names[1], 'the replaced review cannot stage later');
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally {
			await keyboardReview.cancel();
		}
	});

	test('keyboard review app switch stages reviewed files once without its preview', async () => {
		const names = ['kb_focus_a.txt', 'kb_focus_b.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard focus files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			await keyboardReview.step('next');
			await expectActiveTab(names[1]);
			await switchAwayFromIsolatedTestWindow();
			await poll(() => git('diff --cached --name-only') === names[0], 'keyboard app switch stages in the background');
			await extensionApi.whenStageTransactionsSettled();
			assert.strictEqual(vscode.window.state.focused, false, 'staging must not reactivate Code');
			assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
			await focusIsolatedTestWindow();
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), names[0], 'a later finish is inert');
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '', 'one Undo restores the interrupted batch');
		} finally {
			await focusIsolatedTestWindow();
			await keyboardReview.cancel();
		}
	});

	for (const cancelled of [false, true]) {
		test(`keyboard app switch keeps an ${cancelled ? 'explicitly cancelled' : 'empty eyes'} batch inert`, async () => {
			const names = ['kb_inert_a.txt', 'kb_inert_b.txt'];
			for (const name of names) { write(name, name); }
			await refreshUntil(() => names.every(isUntracked), 'keyboard inert files');
			await openPlainAt(names[0], 0);
			await focusIsolatedTestWindow();
			try {
				await keyboardReview.begin('next');
				if (cancelled) { await keyboardReview.step('next'); await keyboardReview.cancel(); }
				await switchAwayFromIsolatedTestWindow();
				await keyboardReview.finish();
				await extensionApi.whenStageTransactionsSettled();
				assert.strictEqual(git('diff --cached --name-only'), '', 'app switching cannot turn empty or cancelled review into a stage');
				assert.strictEqual(extensionApi.isKeyboardReviewActive(), false);
			} finally {
				await focusIsolatedTestWindow();
				await keyboardReview.cancel();
			}
		});
	}

	test('keyboard review without an unstaged file keeps every step as ordinary navigation', async () => {
		const names = ['kb_none_a.txt', 'kb_none_b.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard no-review files');
		await focusIsolatedTestWindow();
		await keyboardReview.begin('next'); // No review editor is open after setup.
		assert.strictEqual(extensionApi.isKeyboardReviewActive(), false, 'no review item means no review');
		await keyboardReview.step('next');
		await expectActiveTab(names[0]);
		await keyboardReview.step('next');
		await expectActiveTab(names[1]);
		await keyboardReview.finish();
		assert.strictEqual(git('diff --cached --name-only'), '', 'ordinary navigation never stages');
	});

	test('keyboard review applies rapid queued steps before a finish in input order', async () => {
		const names = ['kb_queue_a.txt', 'kb_queue_b.txt', 'kb_queue_c.txt', 'kb_queue_d.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard queued files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		try {
			await keyboardReview.begin('next');
			await Promise.all([nextChange(), keyboardReview.step('next'), keyboardReview.finish()]);
			assert.strictEqual(git('diff --cached --name-only'), names.slice(0, 2).join('\n'),
				'both admitted steps apply before the finish; the viewed file is excluded');
			assert.strictEqual(activeTabPath(), wsUri(names[2]).path);
			await extensionApi.whenStageTransactionsSettled();
			await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
			assert.strictEqual(git('diff --cached --name-only'), '');
		} finally {
			await keyboardReview.cancel();
		}
	});

	test('keyboard review yields to a Magic Wand begin without staging', async () => {
		const ext = vscode.workspace.getConfiguration('extensions');
		const previous = ext.inspect<string[]>('confirmedUriHandlerExtensionIds')?.globalValue;
		await ext.update('confirmedUriHandlerExtensionIds', ['ethansk.better-git-vscode'], vscode.ConfigurationTarget.Global);
		const names = ['kb_wand_a.txt', 'kb_wand_b.txt', 'kb_wand_c.txt'];
		for (const name of names) { write(name, name); }
		await refreshUntil(() => names.every(isUntracked), 'keyboard and wand files');
		await openPlainAt(names[0], 0);
		await focusIsolatedTestWindow();
		const id = randomUUID();
		const send = (phase: string, seq: number) => deliverMouseUri('wand-review/' + phase, 'wand',
			new URLSearchParams({ version: '1', id, seq: String(seq), direction: 'next', mode: 'changes' }).toString());
		try {
			await keyboardReview.begin('next');
			await keyboardReview.step('next');
			await expectActiveTab(names[1]);
			await send('begin', 1);
			await poll(() => !extensionApi.isKeyboardReviewActive() && badge(names[0]) !== '💥💥',
				'the wand begin to replace the keyboard review');
			await poll(() => badge(names[1]) === '👀', 'the wand to review the current file');
			assert.strictEqual(git('diff --cached --name-only'), '');
			await send('cancel', 2);
			// CLI exit only acknowledges dispatch. Let the native URI reach this host before the
			// final test shuts it down, otherwise its late launch can reopen the disposable profile.
			await poll(() => badge(names[1]) !== '👀', 'wand cancel handled before test-host shutdown');
			await keyboardReview.finish();
			assert.strictEqual(git('diff --cached --name-only'), '', 'neither the replaced review nor the cancelled wand stages');
		} finally {
			await keyboardReview.cancel();
			await ext.update('confirmedUriHandlerExtensionIds', previous, vscode.ConfigurationTarget.Global);
		}
	});
});
