# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-06-15T16:13:35Z
**Trigger:** staged-file editor-not-found 2026-06-15
**Symptom:** 'The editor could not be opened because the file was not found' when go-to-next/prev navigates onto a STAGED file (newly-added or staged-for-deletion)
**Root cause:** openChangeEntry always built the staged diff as left=toGitUri(HEAD) right=toGitUri('') regardless of git status. The git: content provider serves a side via 'git show <ref>:<path>'; for INDEX_ADDED there is no HEAD blob and for INDEX_DELETED there is no index blob, so git errors and VS Code throws FileSystemError.FileNotFound -> that editor error.
**Fix:** Carry git status on each staged FileChange and branch in openChangeEntry: INDEX_ADDED -> empty-tree as original; INDEX_DELETED -> empty-tree as modified; everything else HEAD<->index as before. empty-tree object id (4b825dc... sha1 / 6ef19b4... sha256) is the one ref the content provider maps to empty bytes instead of throwing, mirroring VS Code's own getLeftResource/getRightResource which omit the missing side.
**Commit:** c1cb4fb
**Guard:** openChangeEntry has explicit status branches + thorough comment; CHANGELOG 0.8.1 entry
---

