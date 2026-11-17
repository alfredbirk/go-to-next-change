# How Better Git VS Code navigation works

Better Git VS Code treats change review as one continuous, reversible sequence. The same Next and Previous commands must behave predictably in ordinary diffs, tall hunks, brand-new files, staged files, and cross-file transitions.

For the user-reported regressions and decisions that these rules protect, see [Regression guards](regression-contracts.md). Check the owning comments and neighboring tests before changing a shared navigation, hold or release path.

## The navigation contract

The visible viewport starts review when an editor opens on its own (for example from a Source Control click) or after the user scrolls it independently. Next begins just above the visible top; Previous begins just below the visible bottom, so the first on-screen change remains reachable even if the caret is elsewhere. Consecutive presses then use the exact caret reached by the previous review step until the viewport moves independently again. Better Git VS Code does not keep a separate forward/backward state machine that can drift away from what the user is reading.

A cross-file landing made by Better Git is itself a review step. After Next lands on a diff's first change, or Previous on its last change, tall-hunk bottom or conflict block, the following press continues from that landed caret, so it never re-selects the change already on screen; reversing direction leaves the file just like any other reversal at its edge. A later independent scroll still re-anchors to the viewport, and a caret left off-screen never owns the next press. Brand-new files keep viewport-first entry, so after Previous lands at a short file's EOF, Next still steps from its visible top. Returning to a visited unstaged file restores its cursor, scroll and whether its next press continues from the caret or the viewport. VS Code's native last-to-first wrap immediately before a file boundary is not recorded as where the file was left.

An unresolved file opened from Source Control as a plain editor follows that same sequence. Better Git VS Code parses complete standard conflict-marker groups and treats each `<<<<<<<` / `=======` / `>>>>>>>` group as one change. Next selects the following block; Previous selects the preceding block. The blocks do not wrap inside the file: exhausting an edge rolls into the adjacent changed file, with forward navigation landing on its first block and backward navigation landing on its last. Git's live `mergeChanges` state and the active tab's exact visible editor form the gate, so marker-like text in an ordinary file and a stale focused editor cannot enter this mode.

For a brand-new file, Next and Previous move by the configured logical-line step (five lines by default):

A cross-file Next explicitly starts the destination at line 1 for plain new text, or its first change for a diff, even if Better Git or VS Code remembers a later position. This is Ethan's November 3 exception to position memory: forward review starts the next file again. Source Control/manual switches and backward revisits still restore the remembered view; a first backward entry retains its EOF/last-change landing. Ordinary navigation, stage-and-advance and held preview boundaries share these landing helpers.

1. Compute `caret ± step`.
2. Clamp the target to line 1 or the final line.
3. Move the caret once and reveal that exact target in the same editor.
4. If the remaining distance is smaller than a full step, consume that partial step and visibly present the edge.
5. Only a later press, made while the caret is already at the presented edge, may move to another file.

Tall diff hunks follow the same rule at hunk boundaries, with an exact ten-line step by default. Any positive custom value is also exact; setting the step to zero selects viewport-minus-overlap auto mode. Engagement tests the exact first and final rendered positions rather than comparing logical line counts: a hunk stranded near the bottom is lifted into view even when its total line count is smaller than the viewport's, while a hunk whose complete rendered range is already visible remains normal hunk-to-hunk navigation. Its exact first or last line is presented before the following press can leave it.

Git's unified diff and VS Code's editor diff can divide one large replacement differently. Better Git retains both the inner added-line runs and the broader `@@` group. An inner stop no more than five lines away and within the configured step is tried as change-to-change navigation; otherwise the broader group owns the press. Before trying the native command, Better Git retains the original caret and proposed step. If that predicted stop is absent and native navigation stalls, wraps or overshoots, the retained step presents the unread content in this file. A fully presented outer edge has no pending step, so normal file rollover remains possible instead of looping from the wrapped caret.

When the next or previous added/replaced run is already fully visible, Better Git selects its start without scrolling. VS Code's native command always centres its range, which can scroll backwards after a tall-hunk page step and then forwards on the following press. The visible-run hand-off avoids that round trip before it occurs. Deleted-only stops in between remain native, trim-whitespace-only replacements are excluded when the editor hides them, and unsaved documents defer to native navigation because Git's on-disk geometry is stale. Turning off tall-hunk staging also disables this hand-off.

Within a file, reversing direction without a separate scroll continues from the current caret: Previous does not reset to the bottom, and Next does not restart from the top. On forward file rollover, Next starts at the destination's first reviewable position. Previous into another file restores a remembered position, or uses the last reviewable position on a first visit.

## Late mouse staging

For Agentic Mouse's one-second follow-up gesture, capture the exact unstaged file inside the navigation queue before moving. Measure the deadline from command arrival, not from asynchronous Git or renderer completion. A rapid follow-up enters that same queue, so it cannot overtake capture. A new navigation replaces only the same mouse's origin; ordinary keyboard navigation and window focus loss clear it. Consume the origin once, and refuse expired, absent, ambiguous, staged-only, or no-longer-unstaged files without substituting the current selection.

When navigation already crossed files, stage the captured URI through the normal staging/Undo path and leave the destination open. When it stayed within the origin, use the normal Stage + Next/Previous operation with that captured file. Never navigate backwards to rediscover the origin.

## Why the old behavior became jumpy

Earlier implementations let viewport geometry and caret position compete on every press. Word wrap, sticky scroll, and `editor.cursorSurroundingLines` mean VS Code can legitimately keep a viewport top unchanged after a reveal request, or report a logical top that differs from the requested line. Treating that reported top as every next movement anchor caused repeated presses to drift, stop, overshoot and return, or roll into another file before the final lines had been read.

The stable implementation uses editor-scoped `TextEditor.revealRange` calls, keeps the requested caret target authoritative during consecutive steps, and waits for the exact editor's rendering to settle. Only an independent visible-range change reanchors the next press to the viewport; navigation's own reveal events do not. Input is serialized so rapid key repeats cannot race against a stale viewport or a file transition. Wrapped final lines are checked through their last visual segment before rollover; unwrapped long lines remain at column zero instead of being pulled sideways.

## Regression coverage

The isolated real VS Code Extension Development Host suite covers navigation scenarios including:

- repeated Next and Previous in wrapped untracked and staged-new files;
- a Source Control-opened plain merge-conflict file, including block traversal with SCM focus and cross-file landing in both directions;
- partial final steps at the top and bottom before cross-file rollover;
- direction reversal from the current caret;
- viewport-first review and resumption after scrolling, including a small scroll that leaves the old caret visible;
- the press after a forward or backward cross-file landing reaching the next change, a later scroll still winning, and a revisit restoring the pre-wrap position with its caret ownership;
- rapid queued input while Source Control retains focus;
- a viewport-fit hunk stranded below a preceding hunk;
- the exact copied `profile-pic.service.ts` replacement where native Next jumps from line 53 to line 149, proving default +10, custom +7, mirrored -7, and same-file retention;
- tall-hunk top, middle, and final-edge presentation in both directions;
- wrapped final-line visual segments;
- backward and stage-and-Previous cross-file landing;
- partially staged files whose working-tree and index diff geometry differs; and
- monotonic visible-range events that fail if overshoot-and-return is reintroduced.

The nearby-run regressions first prove native backward recentering, then require monotonic rapid Next and Previous. Separate cases preserve deleted-only stops, trim-whitespace settings, and unsaved changes. Run the optional real-keyboard acceptance harness with `BGV_UI_SMOKE=1 BGV_UI_SCROLL=1`: it waits for three Next and two Previous inputs and verifies both the exact caret sequence and viewport events without invoking the navigation commands itself.

The detailed incident evidence remains in [`LEARNINGS.md`](../LEARNINGS.md), and the user-facing release history is in [`CHANGELOG.md`](../CHANGELOG.md).

## Keyboard pending batch (macOS)

Hold Option and tap/release Shift to enter Review changes (eyes). Keep Option held and use normal Next/Previous to review hunks. Crossing a file boundary adds the file being left; the current preview stays unstaged. Further Shift taps alternate Review changes and Stage files (explosion), preserving the same populated set. File mode moves the endpoint by whole files. Reverse navigation removes departing files in either mode.

Releasing every relevant Option/Shift/navigation key commits the pending set once. Eyes excludes its current endpoint; Stage files includes it. Switching apps also commits the earlier reviewed files, excluding the current preview even in Stage files mode; later key releases cannot stage again. Capture this interrupted batch before stopping the keyboard modifier reader, whose reset cancels any still-live gesture. Escape still restores the starting view without staging. Each fresh gesture starts in eyes mode; mode changes never stage, reset the selection or cycle through an empty state.

Existing Option+Shift+Next/Previous bindings still stage the current whole file and advance immediately, once per physical key hold. A navigation key or another keydown during the Shift chord disqualifies the modifier tap, so its release does not also toggle. Mouse/wand lifecycles are independent. The modifier observer is macOS-only, read-only, focused-window scoped and disposed on blur; no additional permission prompt or command debounce is required.
