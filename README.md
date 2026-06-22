<p align="center">
  <img src="src/icon.png" width="120" alt="Better Git VS Code icon" />
</p>

<h1 align="center">Better Git VS Code</h1>

<p align="center">
  <b>Fast, keyboard-driven git diff review.</b> Jump between changes and changed files,
  stage-and-advance, and revert — all without touching the mouse.
</p>

---

Review your git changes at the speed of thought — one hand on the keyboard, no mouse, no Source Control panel hunting. Three features do the heavy lifting:

### 🔥 Jump between every git change, instantly

VS Code's built-in change navigation is a clunky, click-heavy chore. **This fixes it.** One key flies you to the next (or previous) change — and when you hit the end of a file, it rolls straight into the next changed file automatically. No scrolling, no clicking through the SCM tree, no losing your place. Fly through an entire AI-generated changeset like it's nothing.

`Option+.` next · `Option+,` previous — literally the `>` / `<` keys, pointing the way.

### Hold Shift to stage as you review

Approve as you go. Holding **Shift** on the nav key stages the file you're looking at and jumps you straight to the next *unstaged* change — so reviewing and staging become one continuous flow. No reaching for the mouse, no detour to the Source Control panel. Sweep through, approving each file with a flick of the same key.

`Shift+Option+.` stage & next · `Shift+Option+,` stage & previous.

### Jump from a staged diff straight to the real file — same line

When you open a *staged* file, what you see is a frozen, read-only snapshot of what's staged — you can't actually edit it there. Spot a bug mid-review and you'd normally have to go hunt down the real file. **One key does it for you:** it opens the actual, editable working file at the *exact* line and scroll position you were looking at. See it, fix it, on the spot.

`Option+R` — open & reveal the real file *(remap to anything you like; see overrides below)*.

## Keybindings

The headline navigation keys are `Alt+.` and `Alt+,`. On a standard **QWERTY** keyboard
those are the physical `>` and `<` keys — "next" and "previous" feel obvious because
the keycaps literally point forward and back.

All bindings ship as defaults and are fully overridable (see below).

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| **Next change** (smart forward) | `Alt+.` | `Alt+.` |
| **Previous change** (smart back) | `Alt+,` | `Alt+,` |
| Next git change (within file) | `Alt+Z` | `Alt+Z` |
| Previous git change (within file) | `Alt+A` | `Alt+A` |
| Next changed file | `Cmd+Alt+.` | `Ctrl+Alt+.` |
| Previous changed file | `Cmd+Alt+,` | `Ctrl+Alt+,` |
| Stage current file + go to next change | `Shift+Alt+.` | `Shift+Alt+.` |
| Stage current file + go to previous change | `Shift+Alt+,` | `Shift+Alt+,` |
| Revert selected change and save | `Alt+Q` | `Alt+Q` |
| Reveal current file in Explorer | `Alt+R` | `Alt+R` |

> **Smart forward / back** means: if you're in a diff, move to the next/previous change
> within it; otherwise navigate forward/back through changed files. It's the one binding
> you need for most reviews.

`Stage current file` is also available as a `+` button in the editor title bar (no key
needed).

## Dvorak (and other non-QWERTY layouts)

The `Alt+.` / `Alt+,` defaults are chosen for the **QWERTY** `>` / `<` keycaps. On a
**Dvorak** layout the `,` and `.` characters sit in completely different physical
positions (top row, where QWERTY has `w` and `e`), so the "points forward / points back"
intuition is lost and the keys may feel awkward.

If you're on Dvorak (or Colemak, AZERTY, etc.), remap the two headline commands to
whatever feels natural. Open your `keybindings.json`
(`Cmd/Ctrl+Shift+P` → *Preferences: Open Keyboard Shortcuts (JSON)*) and add:

```jsonc
[
  // Pick keys that are comfortable on YOUR layout.
  // Example: keep the same *physical* keys QWERTY uses (Dvorak 'w' / 'e' positions):
  { "key": "alt+w", "command": "go-to-next-change.smart-back" },
  { "key": "alt+e", "command": "go-to-next-change.smart-forward" }

  // ...or pick anything else you like:
  // { "key": "alt+j", "command": "go-to-next-change.smart-forward" },
  // { "key": "alt+k", "command": "go-to-next-change.smart-back" }
]
```

VS Code resolves keybindings by the character a key *produces* on your active layout, so
binding to `alt+w` / `alt+e` on Dvorak targets the same physical keys QWERTY users get
with `alt+,` / `alt+.`.

## Overriding any keybinding

Every default ships from the extension and can be overridden per command. To change one,
open *Preferences: Open Keyboard Shortcuts*, search for the command (they're all under the
`go-to-next-change.*` namespace — e.g. `go-to-next-change.smart-forward`), and assign your
own key. To disable a default instead, add a rule prefixed with `-` in `keybindings.json`:

```jsonc
{ "key": "alt+.", "command": "-go-to-next-change.smart-forward" }
```

> Tip: many people prefer to map **Open & reveal current file in Explorer**
> (`go-to-next-change.reveal-current-file-in-explorer`) to something like `Shift+Cmd+E`.
> We ship the default as `Option+R` rather than `Shift+Cmd+E` because the latter is already
> a built-in VS Code shortcut — but you're free to override it to `Shift+Cmd+E` (or anything
> else) in your own `keybindings.json` if you don't mind reclaiming that combo.

> Note: the command **IDs** are intentionally kept under the `go-to-next-change.*`
> namespace (the extension's original name) even though the extension is now published as
> *Better Git VS Code*. This keeps existing keybindings and external tools that reference
> these command IDs working. A display name that differs from the command namespace is
> common and expected for VS Code extensions.

## Settings

A few behaviours are configurable under **Settings → Better Git VS Code**:

- **List vs Tree view** in Source Control (`go-to-next-change.treeView`).
- Whether the Source Control panel opens on navigation (`shouldOpenScmView`).
- Confirmation prompt before rolling onto the next file (`promptBeforeNextFile`).
- The badge shown on the file you're currently reviewing (`currentFileBadge`, default 🔴).
- Experimental staged-file highlighting (`revealStagedInSourceControl`).

## Credits

Better Git VS Code is a fork of
[**alfredbirk/go-to-next-change**](https://github.com/alfredbirk/go-to-next-change),
extended with a stage-and-advance review flow, staged-diff navigation, smart
forward/back, and the QWERTY `<` / `>` default keys. Thanks to Alfred Birk for the
original extension.

## License

[MIT](LICENSE).
