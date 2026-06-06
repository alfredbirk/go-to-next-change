# Change Log

## [1.0]

- Initial release

## [1.4.5]

- Close file after last change

## [0.8.0] (ethansk fork)

- Fix: "go to next change" jumping to the wrong file (or getting stuck) when a file was partially staged / staged-then-edited — such a file appears twice (staged + unstaged) and the position lookup matched by path only, locking onto the wrong copy. Navigation entries are now tagged with their staged/unstaged side, the current side is detected from the active diff, and the matching side is opened.
- New: `shift+alt+z` stages the current file and jumps to the next unstaged file, so you can review-and-stage without clicking the + manually.
- Fix: navigation occasionally jumping to the wrong file (not the visually-next one in the Source Control list). The file-ordering compared names with a naive `a < b`, which diverges from VS Code's list view for numbered files (e.g. `item-2` vs `item-10`, `v2` vs `v10`) and some punctuation. Now uses the same numeric, case-insensitive collator VS Code uses (`compareFileNames`), so the order matches the panel exactly. Affected both staged and unstaged navigation.
- New (opt-in, `go-to-next-change.patchVSCodeForStagedReveal`, default off): patches VS Code's own workbench so the built-in Source Control view highlights the STAGED row (including partially-staged "dual-state" files) when navigating — the real Git rows, which no extension API can select. Works by fixing `onDidActiveEditorChange` to map a `git:` staged-diff URI back to its file and search the index group first. Self-heals after VS Code updates (re-applied on activate), rewrites product.json's checksum to avoid the corruption warning, keeps `.gtnc-bak` backups, and is reversible via "Go to next change: Restore VS Code (undo workbench patch)". Requires a window reload to apply (you're prompted).
- New (opt-in, `go-to-next-change.revealStagedInSourceControl`, default off): also highlight/select staged files in the Source Control view while navigating (flash-based fallback; superseded by the patch above). Works around a VS Code limitation where `scm.autoReveal` can't reveal staged (`git:`-scheme) diffs by briefly making the file the active editor first so auto-reveal selects its row, then opening the staged diff. Tradeoffs: a brief flash, and partially-staged files highlight the unstaged copy. Tracked upstream at microsoft/vscode#320087.