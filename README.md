<p align="center">
  <img src="src/icon.png" width="120" alt="Better Git VS Code icon" />
</p>

<h1 align="center">Better Git VS Code</h1>

AgentFlow can also use Better Git 1.2.99+ to capture a fresh mouse highlight from a local VS Code code or diff editor while dictating. This optional macOS bridge uses VS Code's selection API and a private per-user Unix socket; it does not use the clipboard, send text over the network, or store selected text. Better Git 1.2.160 with AgentFlow build 487 also supports integrated-terminal highlights when VS Code exposes its local terminal-selection tool. AgentFlow separately requests the Accessibility tree to identify the selected pane; this may enable Code’s automatic screen-reader behavior without changing saved settings. Better Git 1.2.162 with AgentFlow build 488 also includes the current editor or terminal highlight when recording starts, even if it was selected earlier. During recording, automatic Git hunk movements and stale gestures remain excluded. Background windows, webviews, remote hosts and multi-cursor selections are unsupported. Install AgentFlow separately from [its website](https://ethansk.github.io/AgentFlow/).

<p align="center">
  <b>Fast, keyboard-driven Git change review in VS Code.</b>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=EthanSK.better-git-vscode"><b>Install from the VS Code Marketplace</b></a>
  ·
  <a href="https://github.com/EthanSK/better-git-vscode">GitHub</a>
</p>

---

AI can write a changeset in seconds. You still need to review every line. Better Git VS Code turns that review into one continuous loop inside VS Code: move through each change, inspect it in context, stage the file when it is right, and keep going without reaching for the mouse or hunting through Source Control.

## The review loop

### 1. Jump between every Git change

One key flies to the next or previous change. At the end of a file, it continues into the next changed file automatically. No scrolling, clicking through the SCM tree, or losing your place in a large AI-generated changeset.

`Option+.` next · `Option+,` previous — literally the `>` / `<` keys, pointing the way.

Switch away from an unfinished text file and return through Source Control or Previous: Better Git restores your last cursor, selection and scroll position, including when a preview tab was replaced. Next crossing into another file starts that file from the beginning instead: line 1 for a new file, or the first change in a diff. This also applies to Stage + Next and forward batch review, even if you visited the destination before. Moving within the current file still continues from your current review position.

Successfully staging a file clears its saved review position; failed staging keeps it. Undo still restores its own exact pre-stage view. Position memory lasts for the current extension session and keeps only coordinates for up to 512 recently visited unstaged files, without retaining their contents.

### 2. Review a batch of files, then stage them together

On **macOS** you can collect several files as you review them, then stage them all at once:

1. **Hold Option** and keep holding it until you are done.
2. **Tap Shift** (press and release it). You are now in **👀 Review changes** mode.
3. **Move with Next / Previous as usual** (for example `.` and `,` while Option is held). You step through the changes one at a time. When you move on to another file, the file you just finished joins the batch. Go back the way you came and it leaves the batch again.
4. **Tap Shift again** to switch to **💥 Stage files** mode. Next / Previous now jumps a whole file at a time, and each file you land on joins the batch. Going back removes the file you leave. Tap Shift again to return to Review changes. Switching modes keeps the batch and never stages anything.
5. **Release Option, Shift and the navigation keys** to stage the batch.

In Source Control, files in the batch show 💥💥 and the file you are reviewing shows 👀. In Review changes mode, the file you are still looking at is left unstaged so you can carry on reviewing it. At the last file, go Next once more after its final change to include it too: its eyes become 💥💥. Previous works the same way at the first file. Everything stays pending until you let go. In Stage files mode, the file you are on is included. If the batch is empty when you let go, nothing is staged. Each new batch starts in Review changes mode.

To finish or cancel:

- Press **Escape** to cancel the batch and return to where you started.
- Switching away from VS Code stages the reviewed batch, leaving the file you are currently looking at unstaged. This also applies in Stage files mode. Returning or releasing the keys afterward does not stage it again.
- After staging, one Undo (`Cmd+Z` in the Source Control Changes list) undoes the whole batch.

**Staging one file at a time still works.** `Option+Shift+.` / `Option+Shift+,` stage the current file and jump to the next or previous one, as before. Holding them down stages only once, and releasing Shift after this shortcut does not switch modes.

The batch works with either navigation-key pair and in Dvorak mode, and needs no extra macOS permissions. On Windows and Linux, `Shift+Alt+.` / `Shift+Alt+,` still stage one file at a time; the batch is macOS only. Mouse and Magic Wand review are unchanged.

On macOS, holding a Next / Previous key leaves at least 50 ms to look at each change after it opens. Repeats do not build up while a change is loading. Releasing and pressing again moves straight away; mouse and wand steps keep their existing timing.

You can start a batch on deleted files, including deleted images with another version already staged. If VS Code hides which side an image comparison shows, Better Git first opens that same image's unstaged deletion preview, then starts review. This does not stage anything. A staged deletion with a recreated working file is never silently selected as that working file.

On macOS, Next Change, Previous Change and Stage + Next keep room below the file you are looking at in Source Control. When fewer than roughly ten following files fit, Better Git scrolls the current file to the top of the visible file area, leaving room for the following files. The same behavior works during held Review changes (eyes mode) and Stage files (explosion mode). This changes only the pane's scroll position: it does not change the selected file, add files to the batch, or wait before accepting another navigation or release.

This scrolling uses macOS Accessibility access for VS Code. Better Git requests native row information after navigation and during held review, then restores any accessibility switch it enabled. If access is unavailable, review and staging continue normally without the pane adjustment. Windows, Linux and remote extension hosts keep their existing scrolling behavior.

### 3. Fix something without losing your place

When you open a *staged* file, what you see is a frozen, read-only snapshot of what's staged — you can't actually edit it there. Spot a bug mid-review and you'd normally have to go hunt down the real file. **One key does it for you:** it opens the actual, editable working file at the *exact* line and scroll position you were looking at. See it, fix it, on the spot.

`Option+R` — open & reveal the real file *(remap to anything you like; see overrides below)*.

That is the core workflow. The same navigation keys also handle the awkward cases that ordinary hunk navigation skips: brand-new files and changes larger than the editor viewport.

## Stage and index history

Better Git keeps local metadata history even when verbose debug logging is off. It records successful Better Git stage commands (requested filenames), successful Better Git Undos, and index/HEAD changes seen through the existing Git observer. Observed changes have **unknown authorship**: they may come from VS Code Git, a terminal, another extension or another Git client. A known stage command succeeding can also be a no-op.

The history uses plain JSON Lines files in `stage-history` under Better Git's VS Code global storage. On macOS with the default profile, this is `~/Library/Application Support/Code/User/globalStorage/ethansk.better-git-vscode/stage-history/`. Each UTC day and extension host has its own file, so multiple windows do not contend for a new shared lock. Files older than 30 days are removed on a later write. Filenames, repository paths, timestamps and before/after Git tree/commit identifiers are local only; file contents are never copied into these logs.

This is separate from the **three-entry Undo stack**. Undo and HEAD changes can clear receipts without deleting the history log. File writing and immutable-tree path lookup run in a separate background queue; review and exact Undo never wait for that queue. Graceful extension shutdown flushes pending history. It is not a crash/power-loss-proof audit trail.

`recordedAt` is when Better Git records an action or observation, not a proven execution time for an external command. An initial observation may compare a persisted baseline from an earlier session. Observation can combine several external actions between Git status notifications. Rapid external stage-then-unstage actions may cancel before Better Git sees them. A rebase/commit/reset is recorded as an observed HEAD change, never labelled as a known unstage. Missing Git objects leave `pathsUnavailable: true` alongside the identifiers. Nothing reconstructs actions from before logging began.

## Generate commit messages with Codex or Claude — no Copilot subscription

Click **Generate Commit Message with AI** (`$(sparkle)`) in a Git repository's Source Control header, choose it from the **Commit** dropdown, or run it from the Command Palette. On first use, Better Git detects the Codex and Claude Code CLIs in your configured paths, VS Code's PATH, and a small set of standard macOS install locations. Choose **Codex, then Claude Code** to try Codex first and fall back to Claude if generation fails, or **Claude Code** to use only Claude. Better Git saves this choice globally. Existing Codex selections now include Claude fallback when its CLI is available. Run **Better Git: Change Commit Message AI Provider** whenever you want to switch.

Better Git uses the already-signed-in local CLI, so it does not need GitHub Copilot or a separate API key. Codex starts with GPT-6 Luna and discovers newer small models from the installed CLI catalogue. Claude selects the newest advertised generation, then the smallest family at that version (Haiku, Sonnet, Opus, Fable). For example, Opus 5.5 beats Sonnet 5, but Sonnet 5.5 beats Opus 5.5. Model selection is refreshed on each generation, so supported CLI/catalogue updates apply without changing Better Git settings. Reasoning uses the lowest advertised supported effort. If model discovery is unavailable, compatibility defaults are GPT-6 Luna with low reasoning and the latest `opus` alias with low effort; unfamiliar future model families require a Better Git update. The progress notification and **Better Git AI** output show the selected model and fallback. Cancel stops the whole request and never triggers fallback. Both receive schema-validated, bounded change context from an otherwise empty temporary workspace. Codex runs ephemerally in a read-only sandbox. Claude runs without tools, settings sources, or session persistence.

If the repository has staged changes, only the staged diff is used. With nothing staged, Better Git uses the working-tree diff and untracked files instead. The generated text fills the selected repository's commit-message box and never commits for you. If you type in the box while generation is running, Better Git will not overwrite your text without asking.

VS Code's literal sparkle inside the right edge of the commit-message box belongs to the proposed `scm/inputBox` API, which Marketplace extensions are not permitted to use. Better Git therefore puts its AI sparkle in the nearest supported Source Control surfaces instead of patching VS Code or hijacking Copilot's command. If VS Code cannot find a CLI, set **Codex Executable Path** (`better-git-vscode.codexExecutablePath`) or **Claude Executable Path** (`better-git-vscode.claudeExecutablePath`) to its absolute path.

## Review edge cases without leaving the keyboard

### Move through plain merge conflicts as normal changes

Click an unresolved file in Source Control with VS Code's detailed Merge Editor disabled and Better Git treats every complete `<<<<<<<` / `=======` / `>>>>>>>` block as one review change. Next and Previous move down and up between those blocks even while Source Control has focus. At either edge they continue into the adjacent changed file, landing on its first or last reviewable change just like an ordinary diff.

### Read every line of brand-new files

Reviewing an AI changeset that adds whole new files? A brand-new file is one big new-diff with no per-change hunks to jump between, so change-navigation used to fly straight past it — you never actually read it. Now, on a fully-added file (untracked / staged-new), the next/previous-change keys **step the cursor a few lines at a time** so you page through and review the entire file, then roll on to the next change as usual. Tune the step with `better-git-vscode.newFileNavLineJump` (default 5). Modified files are never affected — they always navigate change-to-change.

### Step through tall hunks in stages — no more reaching for the scrollbar

Some hunks **run below the visible screen.** One press of next-change can land near the bottom — and the rest runs off-screen, so you'd have to take your hands off the keyboard, scroll, then press next again. Large replacements are especially awkward because Git and VS Code can divide the same visual change differently: native navigation may leap dozens of lines or move to the next file while the broader replacement still has unread content. Better Git retains that broader hunk boundary and steps through it before accepting an oversized jump or rollover.

Hunks whose complete rendered range is already visible are untouched — one press still jumps straight to the next/previous hunk. After you scroll, navigation resumes from the visible part of the file even if the caret stayed elsewhere. Anything unread moves by exactly ten logical lines per press by default; the final partial step lands on and presents the exact hunk edge, and only the following press may leave it. `previous-change` mirrors the same contract, including direction reversal from the current caret when you have not scrolled separately. Set `better-git-vscode.hunkStagingLineStep` to any positive custom step, or `0` for viewport-minus-overlap auto mode. Tune the engage threshold with `hunkStagingThreshold`, the auto-mode overlap with `hunkStagingOverlap`, or turn the feature off with `hunkStagingEnabled`.

For the exact boundary rules and the engineering behind the navigation fix, see [How Better Git VS Code navigation works](docs/navigation-behavior.md).

For contributors, [Regression guards](docs/regression-contracts.md) maps reported bugs and later decisions to their code owners and focused tests. Preserve those rules when changing shared review behavior.

## Source Control show/hide automation is experimental and off by default

VS Code saves Source Control tree data per workspace, but current releases can still rebuild repository and change-group sections expanded after a restart. VS Code exposes no reliable extension API for reading or setting one particular repository or group node. Better Git's earlier attempt to reconstruct that mixed state by walking generic list rows became visibly repetitive with many worktrees, so v1.2.31 withdraws that implementation.

- **Default:** pure VS Code behavior. Better Git does not read Source Control tree storage, start a discovery timer, reveal or focus Source Control, select or walk rows, or expand/collapse anything during startup.
- **Experimental automatic-behavior switch:** `better-git-vscode.experimentalScmTreeStateManagement` is off by default. Turning it on permits the optional startup behavior below, but does not itself perform any startup action.
- **Manual button and command:** click Better Git's **Collapse All** button (`$(collapse-all)`) beside the AI sparkle in a Git repository's Source Control header, or run `Better Git: Collapse all worktree / repository sections in Source Control` (`better-git-vscode.collapse-worktrees`) from the Command Palette. Both invoke VS Code's built-in all-repositories collapse once and do not require either automatic setting.
- **Optional startup collapse:** also turn on `better-git-vscode.collapseWorktreesOnStartup` to run that same built-in collapse once after 2+ repositories finish discovery. There are no retries and no row traversal.

Exact mixed-state restoration remains paused until VS Code provides a dependable per-node contract that can be tested without selecting rows or accidentally targeting another Source Control list such as Source Control Graph.

## Open a worktree from a link

A link such as `vscode://ethansk.better-git-vscode/open-worktree?path=%2Fabsolute%2Fworktree` opens Source Control in the VS Code window receiving the link and opens one change from that exact worktree. Percent-encode the entire absolute path so spaces, plus signs, percent signs and other URL characters survive. VS Code can ask permission before handing the link to Better Git.

If VS Code is behind another app, a recent link gets one focus retry. That retry must start its tree work within ten seconds of the click; once started, it can finish opening the target instead of timing out halfway through collapse. Switching review files, starting review navigation or opening a newer link still cancels the old request. Ordinary later app switches do not repeat it.

To confirm link delivery, enable `better-git-vscode.worktreeLinkNotifications` in User settings. Each received link puts the target worktree name first, with `#N` to distinguish repeat clicks. Expand the notification to see its full path. It appears before repository loading. This confirms receipt, not completed Source Control expansion, and never waits for you to dismiss the notification. Off by default; ordinary commands and mouse/wand review do not show it.

Worktree links can optionally return focus to another already-running app. Better Git finishes collapsing the other worktrees, opening the target and collapsing Staged Changes, then returns to the origin once. It does not activate the origin before this work or bounce back through VS Code. This feature is **macOS only and off by default**. In your VS Code User settings:

```json
"better-git-vscode.worktreeLinkReturnFocus": true,
"better-git-vscode.worktreeLinkReturnApp": "com.openai.codex"
```

Use another app's macOS bundle identifier to change the default. **Copy link to open worktree in Source Control** includes it as `returnTo` metadata in the inner URI, preserved through Microsoft's HTTPS redirect. A link can name a different app; links without metadata use your configured default. The original `returnTo=codex` spelling still works when the feature is enabled. These application settings cannot be enabled by a repository's workspace settings.

Returning focus never launches an app. Invalid or duplicate destinations, missing worktree paths, and an unrelated app becoming active during the handoff skip the return. Turning the feature off skips app activation even when a link contains return metadata. Ordinary Source Control commands do not return focus.

Switching apps or starting a review while the link is opening takes priority: Better Git does not switch you back to the origin after that intervention, even if you later return to VS Code to finish the tree expansion. Disabling the return setting or turning on Keep Editor Front during loading also cancels the final return.

To finish in VS Code with the origin app next in macOS app switching, also enable `better-git-vscode.worktreeLinkKeepEditorFront`. Better Git waits for the origin's activation, then for the same VS Code app to acknowledge its return to front. This handoff finishes before repository loading, so you can switch back to the origin immediately while loading continues in the background. Native Source Control folding completes when the receiving window regains focus. This setting is off by default and requires Worktree Link Return Focus. It uses the same configurable origin and existing links.


For chat clients that require HTTPS, encode the complete URI twice as the `url` value of `https://vscode.dev/redirect?url=...`. Microsoft's redirect forwards it to VS Code; the copied link uses this form.

Right-click a Git repository header and choose **Copy link to open worktree in Source Control**, or use **Better Git: Open Worktree in Source Control** in the Command Palette to choose an open repository. The link can also open a Git worktree outside the current workspace without replacing or adding workspace folders. It does not modify Git contents.

Expansion and scrolling use VS Code's **SCM: Auto Reveal**. Better Git refreshes the requested repository and opens its first unstaged change. Native folding needs the receiving VS Code window in front; activating another app before it finishes can interrupt that work. The normal return mode leaves Code in front until folding is done, then activates the origin once. If you switch away while loading, the file still opens in the background and a recent link can finish its tree presentation when you return, without switching you out of Code again. Newer links and review navigation cancel the pending presentation. There is no background polling or app activation on ordinary later app switches.

In an active window the link settles Source Control updates, collapses other repositories and Staged Changes, then reveals the requested worktree. Native tree expansion and staged-group focus each receive a bounded 400 ms settling gap; ordinary review/staging input has no new delay and cancels a still-running link presentation. A background presentation belongs to one recent link and expires ten seconds after the click, including loading time. With debug logging enabled, the Better Git output records why that pending presentation ended. With no unstaged changes, it leaves the current editor unchanged; the commit-input reveal requires **Git: Show Commit Input**. Disabled Auto Reveal or changes without a working file can still require manual expansion. Better Git does not change either setting.

With `better-git-vscode.debugLogging` enabled, explicit worktree links also write local `[worktree-usage]` records to the existing Better Git log. Each click gets a unique ID and one result: review input in that worktree first, Codex becoming active first, an automatic Codex return being configured, or unknown. Review evidence means Better Git navigation, a manual cursor selection, or an edit; simply opening a diff or reading it does not prove review. The automatic app handoff is excluded from user-chosen returns. Other apps, fast focus races, incomplete opens and no observable action within 60 seconds remain unknown. The observation does not pause opening or review, activate apps, or poll. These records contain no worktree paths or document contents and follow VS Code's existing local log retention.

From a source checkout, run `node scripts/summarize-worktree-usage.mjs "/path/to/Better Git.log"` (multiple retained logs are accepted). It counts review input, user-chosen Codex returns, configured automatic returns, unknowns and missing outcomes separately, and deduplicates repeated log copies. Logging is off when debug logging is off. Older worktree/focus messages cannot provide this comparison: background completion alone identifies neither the active app nor whether someone started reading.

## Pull a worktree into your sidebar without leaving the editor

Reviewing a file that lives in another git **worktree** and want it in your workspace? Run **`Better Git: Add current file's git worktree to workspace`** (`better-git-vscode.add-current-worktree-to-workspace`) from the Command Palette. It finds the worktree the current (or under-review) file belongs to and adds that worktree's root as a workspace folder, so it shows up in your Explorer / Source Control sidebar.

The **`Open & Reveal File in Explorer`** command (`better-git-vscode.reveal-current-file-in-explorer`, `Option+R` by default) now does this automatically when needed. If the current diff/file belongs to a worktree that Source Control knows about but Explorer does not contain, one press opens the real editable file, adds that worktree root, waits for Explorer to register it, and reveals the file there. The explicit add-worktree command remains useful when you want to add the root without switching away from the diff. Turn off **Auto-add worktree on reveal** (`better-git-vscode.autoAddWorktreeOnReveal`) if you prefer reveal to open the file without changing workspace folders; it is on by default.

- Works from a diff, a plain editor, or while focus is in the Source Control panel — it uses the same "file under review" detection as the navigation commands.
- If the file isn't inside any git repository, it just tells you so (no error). If the worktree is already a workspace folder, it says so and does nothing.
- **Note:** if your window currently has a single folder open, adding the first extra folder turns it into a *multi-root* workspace, which triggers a quick window reload (VS Code restarts the extension host on that transition). Better Git VS Code warns you; the explicit add command performs the add as its very last step, while reveal opens the editable file first so it survives the restart and auto-reveals afterward.

## Useful right-click actions

- Right-click a local **`index.html`** in Explorer and choose **Open index.html in System Browser**, or use the same action on a changed `index.html` row in Source Control, to open that exact report/page in your default browser. VS Code does not expose filenames to SCM menu `when` clauses, so the Source Control action is visible on other Git rows too; its runtime guard refuses anything except a local `index.html`.
- Right-click any changed Source Control file and choose **Open & Reveal File in Explorer** to add its worktree when needed and reveal that exact row, even when another editor was active.
- Right-click a linked **worktree header** and choose **Add Worktree to Workspace** to append it to the current Explorer without replacing your existing workspace folders. **Copy Worktree Name** remains immediately above it.

## Keybindings

The headline navigation keys are `Alt+.` and `Alt+,`. On a standard **QWERTY** keyboard
those are the physical `>` and `<` keys — "next" and "previous" feel obvious because
the keycaps literally point forward and back.

All bindings ship as defaults and are fully overridable (see below).

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| **Next change** | `Alt+.` | `Alt+.` |
| **Previous change** | `Alt+,` | `Alt+,` |
| Next changed file | `Cmd+Alt+.` | `Ctrl+Alt+.` |
| Previous changed file | `Cmd+Alt+,` | `Ctrl+Alt+,` |
| Stage current file + next | `Shift+Alt+.` | `Shift+Alt+.` |
| Stage current file + previous | `Shift+Alt+,` | `Shift+Alt+,` |
| Start a keyboard batch, or switch its mode | Hold `Option`, tap `Shift` | — |
| Stage the keyboard batch | Release Option, Shift and navigation keys | — |
| Cancel the keyboard batch | `Escape` | — |
| Undo latest stage while Source Control Changes has focus | `Cmd+Z` | `Ctrl+Z` |
| Revert selected change and save | `Alt+Q`* | `Alt+Q`* |
| Reveal current file in Explorer | `Alt+R` | `Alt+R` |
| Open changes at cursor/scroll + Source Control | `Ctrl+Shift+G` | `Ctrl+Shift+G` |

> **Next / previous change** walks hunk-to-hunk through the current diff, block-to-block through
> plain merge conflicts, pages through brand-new files, and rolls over to the next/previous changed file
> at either end. It's the one pair of keys you need for most reviews. (Before v1.2.5 these
> keys pointed at the *smart forward/back* mouse commands, whose in-diff direction is
> deliberately reversed for mouse thumb-buttons — which made keyboard `>` / `<` navigate
> backwards on QWERTY. Fixed: they now run the real change-navigation commands.)

> **Smart forward / back** (`better-git-vscode.smart-forward` / `.smart-back`) are
> **mouse-button commands** with no default keyboard key: in a diff they go to the
> previous/next change (direction intentionally reversed for thumb-buttons), elsewhere
> they do normal editor back/forward. Bind them to your mouse's Forward/Back buttons
> (e.g. via Karabiner → F13/F17 → `keybindings.json`).

> **`Ctrl+Shift+G`** is remapped from VS Code's stock "show Source Control" chord (which only
> opened the panel) to *also* open the current file's changes (diff) at the exact cursor and
> scroll position you were viewing first, then show Source Control. Override it like any other
> binding if you want the original behaviour back.

> **`Cmd+Z` / `Ctrl+Z` in the Source Control Changes list** exactly undoes the latest observed
> stage/index transition. Repeated presses walk a persistent last-in, first-out history of up to
> 3 exact transitions, including stages made through Better Git, VS Code's Git actions, or the
> terminal. The binding applies only while that list owns focus and no text input is active.
> Editors and the Source Control commit-message box keep their normal text Undo behavior.

The **`+` button in the editor title bar** now **stages the current file _and_ advances** to the
next change — in whatever direction you last navigated. Jump forward through changes (`>` / `Alt+.`)
and the `+` advances forward; jump backward (`<` / `Alt+,`) and it advances backward. So you can run
the whole review-and-stage flow with the mouse alone — click `+` to stage-and-jump instead of
clicking `+` then reaching for the keyboard. Like `Shift+Alt+.` / `Shift+Alt+,`, it stages one file
straight away; use the Option + Shift batch above to collect several files first. A
fresh session with no navigation yet defaults to advancing *forward*. The plain, no-advance
`Stage current file` command is still registered if you'd rather bind that to a key.

## Mouse-driven review (recommended setup)

### Agentic Mouse late-stage gestures

Agentic Mouse can tag Next/Previous with the mouse that sent it. Better Git captures the file before navigating, so pressing that mouse's stage button within one second stages the original file even after the next file has appeared. If navigation already crossed files, staging leaves the destination open; it does not jump a second time. Within-file navigation still uses the normal Stage + Next/Previous behavior.

In Agentic Mouse's Default page, a held Next/Previous gesture starts in eyes preview when it becomes stage-ready. With Better Git 1.2.146 and the matching Agentic Mouse update, the starting mode travels with button-down, so a separate mode message arriving early cannot start the hold in explosion mode. Every fresh hold starts in eyes, even if the previous hold ended in file mode. Legacy bindings and the entered VS Code page keep their existing behavior. Entry keeps the current file and cursor still; wheel detents review hunks and then neighboring unstaged files inside that worktree. The current preview file shows 👀; other files in the pending stage set retain 💥💥. Both eyes and file mode share one pending set: moving in the original hold direction adds files, and moving in the opposite direction removes the file just left. This rule survives every mode toggle and continues past the starting file. Moving between hunks within the same file keeps the set unchanged.

Better Git 1.2.147 and the matching Agentic Mouse update check the running extension automatically after restarts. You do not need to enable the fixed mouse path again. The check follows app/runtime changes; mouse presses do not wait for it. See the [running-host contract](docs/agentic-mouse-host-proof.md) for the small private receipt and compatibility checks.

Keep Stage held and tap the adjacent preview button to toggle between eyes review and ordinary file selection. Corsair uses 8 then 9 for Next, or 5 then 6 for Previous; releasing only the adjacent button does not change the mode. In file mode, each wheel detent moves one file and previews it while editing that same pending set. Releasing Stage in eyes mode stages the pending set except the current 👀 file, leaving that file, cursor and scroll position open for further review. If it is the only selected file, release does nothing and adds no Undo receipt. Releasing in ordinary file mode still stages the full pending set and advances. Each nonempty release is one exact Undo transaction. Wheel steps received before Stage release finish in order before that transaction in both modes. Preview stops at either end of the current worktree. The adjacent cancel cell restores the original file, diff, cursor and viewport; its later release does nothing.

At the end of the current worktree, an extra eyes-mode Next after the last change approves the final file too. It becomes 💥💥 and joins the batch on release; no file or worktree opens beyond it. Previous mirrors this at the first file. Repeated outward ratchets keep that decision, and moving back to another file clears it and keeps the usual reverse-removal rule. This applies to Agentic Mouse, wand and keyboard review. Merely reaching the last file still leaves it as an unstaged 👀 preview.

Better Git accepts `vscode://ethansk.better-git-vscode/mouse-stage-preview-mode/on?source=corsair` and the matching `/off` route (`source=razer` for Razer). Those routes change preview mode without navigating. If mode-on arrives before the readiness shortcut, Better Git retains it only for that active hold and paints eyes when its pending selection becomes ready. A later hold never inherits that mode. The companion's compatibility startup hint adds `initial=1`; Better Git 1.2.146 ignores that hint because button-down already chose the mode, so a delayed hint cannot overwrite an intentional file-mode toggle. Explicit toggles omit that parameter.

During a held Next/Previous gesture, the adjacent Agentic Mouse Undo cell has two meanings decided by input order. Before the 200 ms stage-ready threshold it cancels the unfinished hold and then performs the previous exact staging Undo. Once the hold is stage-ready (`💥💥` visible) it cancels only that pending stage and preserves Undo history. The later button release does nothing in either case. The same F16 action keeps its normal exact Undo behavior whenever no hold is active, whether Agentic Mouse delivers it bare or tagged with the mouse source.

For a physical-input diagnosis, enable `better-git-vscode.debugLogging` to retain mouse phases in the persistent **Better Git** log output channel. Enable `better-git-vscode.debugNotifications` to also show each registered hold phase as a temporary VS Code notification. Both settings are off by default.

The paired transport uses Control-Option-Command with F13/F17 for navigation and F18/F19 for late staging; Razer adds Shift. These defaults carry source/direction arguments. Held staging chords keep the ordinary F18/F19 commands below. Install the matching Better Git release before enabling these Agentic Mouse mappings; old versions do not receive the tagged shortcuts. Missing, expired, staged-only, or ambiguous origins never fall back to staging the current file.

### Other mouse mappings

You can drive the **entire** review-and-stage flow from your mouse — no keyboard at all. The trick
is a two-hop mapping: **Karabiner-Elements** remaps your mouse's extra buttons to spare F-keys, and
then VS Code's `keybindings.json` maps those F-keys to this extension's commands. This is the exact
setup the author uses.

**The five commands you bind:**

| Mouse button | → F-key | → Command | What it does |
| --- | --- | --- | --- |
| **Back** (thumb rear) | `F13` | `better-git-vscode.smart-back` | In a review view: **next** change. Elsewhere: browser Back. |
| **Forward** (thumb front) | `F17` | `better-git-vscode.smart-forward` | In a review view: **previous** change. Elsewhere: browser Forward. |
| (extra button) | `F18` | `better-git-vscode.stage-and-next-changed-file` | Stage current file **+ next** change. |
| (extra button) | `F19` | `better-git-vscode.stage-and-previous-changed-file` | Stage current file **+ previous** change. |
| (rapid double press) | `F16` | `better-git-vscode.undo-last-stage-and-advance` | Exactly undo one stage/index transition from the persistent 3-entry history. |

**Why the "smart" commands are dual-mode.** `smart-back` / `smart-forward` detect whether you're in a
diff/review view (a diff, a brand-new/untracked file, a deleted file, a merge-conflict editor, or a
binary/image change). **In a review view they navigate changes; anywhere else they behave as ordinary
editor Back/Forward** — so the same physical thumb buttons keep their normal browsing meaning when
you're not reviewing, and become change-navigation the moment you're looking at a diff. (The in-diff
direction is intentionally *flipped* for thumb buttons — Back goes to the **next** change, Forward to
the **previous** — because that's what feels natural pressing them; see the note below.)

**Everything behaves identically to the keyboard**, because the mouse buttons call the *exact same
functions* the keyboard shortcuts do — no separate mouse code path. That means you get, for free:
the end-of-list guards (roll over to the next/previous changed file at either end, and don't strand
you on the last file), the few-lines-at-a-time scroll through brand-new files, and the tall-hunk
staged stepping. The editor-title-bar **`+` button** also stages-and-advances in your last-navigated
direction, so a click there is the mouse equivalent of `F18`/`F19`.

### 1. Karabiner: map the mouse buttons to F-keys

In **Karabiner-Elements → Devices** (or a `Complex Modification`), send `F13`, `F17`, `F18`, `F19`
from your mouse's buttons. F13 and F16–F19 have no default macOS action, so they pass straight through
to VS Code.

> **Avoid `F14` / `F15`.** On macOS those are the **brightness down / up** keys — the OS swallows them
> before VS Code ever sees them, so a binding on `F14` silently does nothing. Stick to `F13` and
> `F16`–`F19`.

### 2. VS Code: map the F-keys to the commands

Add these to your `keybindings.json` (**Preferences: Open Keyboard Shortcuts (JSON)**). They're
unconditional — the diff-vs-not decision is baked *into* the smart commands, so there's no `when`
clause to get wrong:

```jsonc
[
  // Mouse BACK button  (Karabiner sends F13) -> smart-back:    next change while reviewing, else browser Back
  { "key": "f13", "command": "better-git-vscode.smart-back" },
  // Mouse FORWARD button (Karabiner sends F17) -> smart-forward: previous change while reviewing, else Forward
  { "key": "f17", "command": "better-git-vscode.smart-forward" },
  // Rapid double press (Karabiner sends F16) -> exact fail-closed undo of the latest stage
  { "key": "f16", "command": "better-git-vscode.undo-last-stage-and-advance" },
  // Extra mouse buttons (Karabiner sends F18 / F19) -> stage-and-advance in each direction
  { "key": "f18", "command": "better-git-vscode.stage-and-next-changed-file" },
  { "key": "f19", "command": "better-git-vscode.stage-and-previous-changed-file" }
]
```

That's it — thumb-Back/Forward to fly through changes, the two extra buttons (or the title-bar `+`)
to stage-and-advance, and rapid double press to reverse the exact latest stage without touching the
keyboard. Better Git observes the repository's exact index tree, so a stage made through VS Code's
keyboard/UI, another mouse control, or `git add` gets the same undo receipt. A brief `index.lock`
from another Git operation is retried for a bounded
window; Better Git never deletes the lock and reports if staging still cannot proceed. The exact
undo history persists across VS Code window/extension-host restarts. Every later index transition
becomes the new exact undo target without replacing the earlier entries; the command still requires
both `HEAD` and the current index to match its receipt before restoring the prior index tree. It never
changes working files.

## Left/right-hand navigation and Dvorak mode

By default, change navigation is available from both the right-hand **physical `>` and `<` keys**
and the left-hand **physical `Z` and `X` keys**. Set
**`better-git-vscode.navigationHands`** to `left` or `right` to keep only one pair active:

| Action | Right-hand pair | Left-hand pair |
| --- | --- | --- |
| Next change | `Alt+.` (physical `>`) | `Alt+X` (physical `X`) |
| Previous change | `Alt+,` (physical `<`) | `Alt+Z` (physical `Z`) |
| Stage + next | `Shift+Alt+.` | `Shift+Alt+X` |
| Stage + previous | `Shift+Alt+,` | `Shift+Alt+Z` |

`both` is the default, so either hand works immediately. On QWERTY this intentionally
claims VS Code's built-in `Alt+Z` **Toggle Word Wrap** binding. Choose `right` if you want
only the established `>` / `<` pair and want VS Code's `Alt+Z` word-wrap shortcut back.

On **Dvorak**, also enable **`better-git-vscode.dvorakMode`** (Settings → Better Git
VS Code, or add it to `settings.json`) so both pairs stay on the same physical keys. VS Code
deliberately dispatches the macOS **Dvorak – QWERTY Cmd** layout by character key code, so
the extension contributes the characters that those physical keys actually produce:

This is a static VS Code setting, not automatic input-source detection. Turn it back off when
switching macOS to QWERTY or British so those layouts' `Option+Z` / `Option+X` and
`Option+<` / `Option+>` bindings become active.

| Physical pair | QWERTY Next / Previous | Dvorak Next / Previous |
| --- | --- | --- |
| Right (`>` / `<`) | `Alt+.` / `Alt+,` | `Alt+V` / `Alt+W` |
| Left (`Z` / `X`) | `Alt+X` / `Alt+Z` | `Alt+Q` / `Alt+;` |

Shift adds Stage-and-Advance to the same pair in either layout. These settings use VS
Code's native configuration when-clauses, so changing either one swaps the active bindings
without an extension restart. Neither setting changes what the commands do.

The physical tilde/backtick key cannot be a reliable macOS Option shortcut inside text editors:
Option+backtick starts the system grave-accent dead-key composition, and VS Code receives
`KeyInComposition` instead of the physical key. Physical X is an ordinary non-composing key and
keeps the pair together under one hand.

Changed-file nav (`Cmd/Ctrl+Alt+.` / `,`) and reveal (`Alt+R`) stay on their defaults.
On Dvorak, physical X produces `Q`, so enabling the left pair makes `Alt+Q` Next Change
and disables the conflicting Revert-and-Save default; choose `navigationHands: "right"` to
keep Revert on `Alt+Q`, or assign Revert another shortcut. This is the `*` exception in the
main shortcut table above. In Dvorak mode the freed-up `Alt+.` / `Alt+,`
characters additionally map to the smart forward/back mouse commands (they sit on
different physical keys there, so nothing collides).

> Your own `keybindings.json` entries always win, so you can still hand-tune any of these
> on top of the toggle (see *Overriding any keybinding* below).

## Overriding any keybinding

Every default ships from the extension and can be overridden per command. To change one,
open *Preferences: Open Keyboard Shortcuts*, search for the command (they're all under the
`better-git-vscode.*` namespace — e.g. `better-git-vscode.smart-forward`), and assign your
own key. To disable a default instead, add a rule prefixed with `-` in `keybindings.json`:

```jsonc
{ "key": "alt+.", "command": "-better-git-vscode.next-scm-change" }
```

> Tip: many people prefer to map **Open & Reveal File in Explorer**
> (`better-git-vscode.reveal-current-file-in-explorer`) to something like `Shift+Cmd+E`.
> We ship the default as `Option+R` rather than `Shift+Cmd+E` because the latter is already
> a built-in VS Code shortcut — but you're free to override it to `Shift+Cmd+E` (or anything
> else) in your own `keybindings.json` if you don't mind reclaiming that combo. Bind the Better Git
> command unconditionally; `isInDiffEditor` becomes false while Source Control owns keyboard focus even if a
> diff remains visibly active, which would otherwise send the key to VS Code's built-in non-worktree-aware reveal.

## Settings

A few behaviours are configurable under **Settings → Better Git VS Code**:

- **Navigation hands** — choose the right-hand physical `>` / `<` pair, the left-hand physical `Z` / `X` pair, or both (`better-git-vscode.navigationHands`, default `both`). On QWERTY, choose `right` to preserve VS Code's built-in `Alt+Z` Toggle Word Wrap shortcut. On Dvorak, choose `right` to preserve Better Git's `Alt+Q` Revert-and-Save shortcut.
- **Dvorak mode** — remap both navigation pairs to the characters produced by the same physical keys under Dvorak (`better-git-vscode.dvorakMode`, see the section above).
- **Display-aware diff view (macOS)** — set `better-git-vscode.inlineDiffOnDisplay` to an external display's `{ "uuid": "...", "width": 3440, "height": 1440 }` to use Inline while it is connected and Automatic when it is absent. An empty object disables this feature (the default). It changes VS Code's diff view across all windows, not only Better Git's Source Control review.
- **Display-aware zoom (macOS)** — with `inlineDiffOnDisplay` set, use `better-git-vscode.zoomLevelOnDisplay`, such as `{ "connected": -2, "disconnected": -1 }`, to set VS Code's `window.zoomLevel` when that display connects or disconnects. An empty object disables zoom switching. Manual zoom changes are kept until the next display change.
- **Last-staged status bar** — a bottom-left `✓ Staged: <filename>` indicator showing the last file you staged through the extension. After a batch, it names the final staged file in your review direction, so you can spot one file too many. The tooltip lists the full batch. Click it to reopen the named file's staged diff and unstage it if it was a mistake. Toggle with `better-git-vscode.showLastStagedInStatusBar` (default on).
- **Experimental Source Control automation** — automatic tree manipulation is off by default behind `better-git-vscode.experimentalScmTreeStateManagement`. The manual Command Palette collapse remains available; the separate `collapseWorktreesOnStartup` double opt-in runs one built-in collapse with no retries. Exact mixed-state restoration is paused. See *Source Control show/hide automation is experimental and off by default* above.
- **Auto-add worktree on reveal** — when reveal targets a worktree outside Explorer, add that worktree root as a workspace folder and reveal the file (`better-git-vscode.autoAddWorktreeOnReveal`, on by default; see *Pull a worktree into your sidebar* above).
- **Commit-message AI provider** — the first use detects Codex and Claude Code, asks which signed-in account to use, and remembers that choice inside Better Git. Use **Better Git: Change Commit Message AI Provider** to switch later.
- **AI executable paths** — configure the signed-in Codex CLI (`better-git-vscode.codexExecutablePath`, default `codex`) or Claude Code CLI (`better-git-vscode.claudeExecutablePath`, default `claude`) if VS Code cannot resolve it.
- **New-file line step** — how many lines the change keys step through a brand-new file (`better-git-vscode.newFileNavLineJump`, default 5).
- **Tall-hunk staging** — present or step through any hunk whose complete rendered range is not on-screen, instead of letting unread lines run off the bottom (`better-git-vscode.hunkStagingEnabled`, default on — see *Step through tall hunks in stages* above). Tune the engage threshold (`hunkStagingThreshold`, 0 = auto/rendered visibility), the exact per-step move (`hunkStagingLineStep`, default 10; any positive custom value; 0 = viewport-minus-overlap auto mode), and the overlap used by auto mode (`hunkStagingOverlap`, default 4).
- **List vs Tree view** in Source Control (`better-git-vscode.treeView`).
- Whether the Source Control panel opens on navigation (`shouldOpenScmView`).
- The badge shown on the file you're currently reviewing (`currentFileBadge`, default 🔥🔥). Staged/index reviews show 🧯 instead, so they cannot be mistaken for unstaged changes. This includes text, image, binary and notebook reviews. Setting the badge to empty hides both; eyes and explosion mode retain their existing markers.
- Experimental staged-file highlighting (`revealStagedInSourceControl`, off by default). Selecting a staged row this way deliberately expands **Staged Changes**.

**Keep Staged Changes closed.** After staging in place, or staging the final file with Stage + Next or a held batch, Better Git keeps the same file and review position on its staged (Index) side. This prevents Source Control's Auto Reveal from expanding Staged Changes later for the leftover working-file view. Manual staged review still works.

Worktree links fold Staged Changes when its header exists. Git's `git.alwaysShowStagedChangesResourceGroup` setting keeps that header visible while empty, so the link can fold it before your first stage. The header stays closed through the tested staging and sidebar-reveal paths, and deliberately opening it is respected.

VS Code can still create new groups expanded when it rebuilds the tree, and opening a fully staged file as a normal working-file editor can trigger Auto Reveal. There is no public per-group expansion API, so Better Git cannot guarantee that every native VS Code path keeps Staged Changes closed.

## Credits

Better Git VS Code is a fork of the original git-diff-navigation extension by
[**Alfred Birk**](https://github.com/alfredbirk), extended with a stage-and-advance
review flow, staged-diff navigation, smart forward/back, and the QWERTY `<` / `>`
default keys. Thanks to Alfred Birk for the original extension.

## License

[MIT](LICENSE).
