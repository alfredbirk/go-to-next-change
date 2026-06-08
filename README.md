<h1 align="center">
  <br>
  <a href="https://marketplace.visualstudio.com/items?itemName=alfredbirk.go-to-next-change">
    <img src="https://github.com/alfredbirk/go-to-next-change/raw/main/src/logo.png" alt="logo" width="120" />
  </a>
  <br>
  <br>
  Go to next change
  <br>
</h1>

<h3 align="center" style="font-size: 14px">Review an entire changeset file by file — from the keyboard. Cycle through every diff with <code>alt+z</code>, and the moment you're happy with a file, press <code>shift+alt+z</code> to stage it and jump straight to the next unstaged one.</h3>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=alfredbirk.go-to-next-change">
      <img src="https://img.shields.io/visual-studio-marketplace/v/alfredbirk.go-to-next-change?color=brightgreen&label=VS%20Marketplace" />
  </a>
</p>
<br>

![Final4](https://github.com/alfredbirk/go-to-next-change/assets/11172530/456b380f-e555-404c-9e7d-39b9f3b127ff)

## Why this fork — built for reviewing AI-generated changes

AI / agentic coding produces **large diffs across many files**, and the bottleneck shifts from *writing* code to **reviewing** it. This fork turns that review into a fast keyboard loop:

-   **`alt+z`** cycles through every change, auto-jumping from file to file as you reach the end of each one.
-   **`shift+alt+z`** — the headline of this fork — **stages the current file and advances to the next unstaged file** the moment you're happy with it.

So you blaze through an AI-generated changeset one file at a time, approving as you go — **entirely from the keyboard, no mouse**. `shift+alt+z` solves the whole bottleneck of agentic-engineering code review: read a file, hit `shift+alt+z`, you're staging it *and* on the next file in one keystroke. When the last unstaged file is staged, there's nothing left to review and the diff closes.

It's an honest navigation-and-staging workflow — not a code analyzer. It doesn't judge the code; it makes *you* the fast reviewer by removing every mouse trip between "this file looks good" and "show me the next one".

### How `shift+alt+z` works (the details)

Stages the whole current file — exactly like clicking the `+` next to it in the Source Control view — then opens the next **unstaged** file's diff:

-   It only acts on **actual changes** (a safety guard stops an accidental `git add` + editor-close while you're editing an unrelated clean file).
-   It **does nothing when you're viewing an already-staged file's diff** — this command is for working through *unstaged* files, so it won't yank you off to an unrelated one.
-   If you stage the **last** unstaged file, it lands on the **previous** unstaged file instead of closing. It only closes the editor when that was the *only* unstaged file left — i.e. nothing more to review.

> ### 🍴 This is a fork
>
> This is a personal fork of [**alfredbirk/go-to-next-change**](https://github.com/alfredbirk/go-to-next-change) (published under the `ethansk` publisher, installed locally rather than from the Marketplace). It keeps everything the original does and adds the stage-and-advance workflow above, several navigation fixes, and a "currently reviewing" marker. See [**What this fork changes (and why)**](#what-this-fork-changes-and-why) for the full rundown. All credit for the original extension goes to [Alfred Birk](https://github.com/alfredbirk).

## Features

-   **(fork)** Stage current file & go to next unstaged file: `shift+alt+z` — the review-and-stage loop above
-   Go to next git change: `alt+z` / `opt+z`
-   Go to previous git change: `alt+a` / `opt+a`

## Other features

-   Revert selected changes and save file: `alt+q` / `opt+q`
-   Go to next changed file: `ctrl+alt+z` / `cmd+alt+z`
-   Go to previous changed file: `ctrl+alt+a` / `cmd+alt+a`

## If you use Tree view

-   If you use "Tree view" in the source control (as opposed to the default List view), go to settings and check off the setting `Go to next change: Tree view`. That will make the changes cycle in correct order.

---

## What this fork changes (and why)

Everything below is **additive** — the original keybindings and behaviour are unchanged. Each item explains the problem it solves so you know why it's here.

### 1. Correct "next file" order for numbered files

**What:** Navigation now follows the *exact same order* you see in the Source Control panel.

**Why:** The original sorted filenames with a plain `a < b` string comparison, which disagrees with VS Code's own list ordering for numbered names (e.g. it would put `item-10` before `item-2`, or `v10` before `v2`) and for some punctuation. That meant "next" could jump to a file that wasn't the one visually below the current one. This fork uses the same numeric, case-insensitive collator VS Code uses internally (`compareFileNames`), so the cycle order matches the panel exactly — for both staged and unstaged groups.

### 2. Correct navigation for partially-staged files

**What:** "Go to next/previous change" now lands on the right copy of a file that is both staged *and* unstaged.

**Why:** A file with both staged changes and further unstaged edits appears **twice** in the panel — once under "Staged Changes" and once under "Changes". The original matched files by path only, so it could lock onto the wrong copy and jump to the wrong file (or appear to get stuck). This fork tags each navigation entry with its **staged/unstaged side**, detects which side you're currently viewing from the active diff, and opens the matching side.

### 3. Looping at the ends

**What:** Pressing **next** on the last file now wraps straight to the first file, and **previous** on the first wraps to the last — in a single press.

**Why:** Originally, hitting "next" on the last file just closed the diff editor, so wrapping around took an extra keypress. Now it loops in one press.

### 4. Stage-and-advance: `shift+alt+z`

**What:** Stages the whole current file (same as clicking the `+` in Source Control) and moves you to the next **unstaged** file, so you can review-and-stage in one flow without the mouse. This is the fork's headline feature — see [**Why this fork**](#why-this-fork--built-for-reviewing-ai-generated-changes) at the top for the full review-loop story and the safety details.

### 5. A "currently reviewing" badge

**What:** As you navigate, the file you're currently viewing gets a badge (a colourful emoji, default `🔴`) on its row in the built-in Source Control panel — and in the Explorer / editor tabs. It follows you from file to file.

**Why:** When jumping through diffs it wasn't obvious which file in the panel you were actually on. The badge is drawn with VS Code's supported `FileDecorationProvider` API — **no patching of VS Code, no debug port, no "installation corrupt" warning.** The extension activates on startup so the badge is available immediately.

Configure it with **`go-to-next-change.currentFileBadge`**: any emoji or character (up to 2 — e.g. `🔥`, `⭐`, `👉`, or two like `🔥🔥` for a slightly wider mark), or set it empty to turn the badge off.

> **Known limitation — partially-staged files show the badge on _both_ rows.** A dual-state file's "Staged Changes" row and "Changes" row are the **same file path**, and VS Code's decoration API is keyed *only* on that path — it is never told which side/group a row belongs to, so one badge result necessarily applies to both rows. Marking only one side isn't possible through any supported extension API (the group identity stays inside VS Code's SCM tree); it would require DOM manipulation via the remote-debugging port or a separate, non-git panel section — both deliberately avoided here. This was confirmed against the VS Code source and an independent review. The editor tab title (`(Index)` vs `(Working Tree)`) still tells you which side you're viewing.

### 6. Optional: reveal/select staged files in Source Control (`revealStagedInSourceControl`)

**What:** An **opt-in** setting (default **off**) that also selects/highlights the row in the Source Control view as you navigate, including for staged files.

**Why:** VS Code's built-in `scm.autoReveal` highlights the row for *unstaged* diffs but can't reveal **staged** (`git:`-scheme) diffs. This setting works around it by briefly making the file the active editor (so auto-reveal selects its row) and then opening the staged diff. It's off by default because of the trade-offs: a brief flash of the file, and for partially-staged files it highlights the unstaged copy. Tracked upstream at [microsoft/vscode#320087](https://github.com/microsoft/vscode/issues/320087).

---

## Settings (this fork)

-   **`go-to-next-change.currentFileBadge`** (string, default `🔴`) — badge shown on the file you're currently reviewing. Up to 2 characters; empty disables it.
-   **`go-to-next-change.revealStagedInSourceControl`** (boolean, default `false`) — also select/highlight files (incl. staged) in the Source Control view while navigating. See section 6 for trade-offs.
-   **`go-to-next-change.promptBeforeNextFile`** (boolean) — confirm before jumping to the next/previous file at the end of the current one.
-   **`go-to-next-change.treeView`** / **`go-to-next-change.shouldOpenScmView`** — as in the original.

## Install (this fork)

Not on the Marketplace — build and install the `.vsix` locally:

```bash
git clone https://github.com/EthanSK/go-to-next-change.git
cd go-to-next-change
npm install
npx @vscode/vsce package --no-dependencies
code --install-extension go-to-next-change-*.vsix --force
```

Then reload the window.

## Suggestions & Issues

Suggestions and issues related to the **original** extension can be submitted [on Github](https://github.com/alfredbirk/go-to-next-change/issues). For anything specific to this fork, use [this fork's issues](https://github.com/EthanSK/go-to-next-change/issues).
