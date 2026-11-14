# Better Git VS Code agent instructions

Read `LEARNINGS.md` before changing behavior, packaging, or release handling. Preserve new durable evidence there after a verified feature, fix, release, or investigation.

## Test location and responsiveness

- If you want to run Better Git VS Code E2Es, coordinate over Agent Bridge on the Mini and run them there. Do not run E2Es or Extension Development Hosts on Ethan's MacBook Pro; they make his working VS Code laggy.
- Keep the default test command short and non-GUI. Run focused E2Es on the Mini for the changed behavior; the exhaustive suite is opt-in, not something to rerun after every edit.
- Do not affect app responsiveness. Better Git must support rapid repeated mouse presses without an added debounce, arbitrary input delay, or dropping valid presses; preserve navigation order and exact staging/Undo safety.

## Mini readiness and setup stop rule

User-requested — 2026-10-30: prevent the Mini setup mistake and repeated setup detours from happening again.

- Check the access needed for the actual test before changing setup. SSH/CDP editor access, native desktop control and Code Accessibility are separate capabilities; a failure of one does not establish failure of the others. Keep using the working route for tests it supports.
- Before asking Ethan to sign in or unlock the Mini, verify its actual console-lock state. A Screen Sharing connection login is not evidence that the Mini desktop is locked. Identify the exact missing permission or authentication boundary from current evidence instead of asking for a generic sign-in.
- Qualify a new native controller in an isolated profile before changing the Mini's working shared OpenClaw runtime. Require a real screenshot or Accessibility result from the intended controller, then check Code permission in its responsible application context. Installed tools, an accepted setup command and a successful ordinary agent reply do not prove native control works.
- When native control refuses a caller or times out, stop speculative setup changes. Investigate the exact error and retry only when new evidence identifies a specific supported repair; do not cycle backends, app versions or shared feature flags merely to try another route. Preserve approval, caller-authentication and cache-ownership safeguards. If a shared setup attempt fails, restore its changed settings and verify ordinary agent operation before further work.
- Keep independent development moving and report native-dependent work as unfinished until that exact capability is verified. Do not substitute unrelated older checks or the user's own testing for the missing native test, and do not report a prototype as installed or complete.

## Marketplace release gate

- Unless Ethan explicitly opts out, finish every Marketplace-bound feature, fix, or maintenance change through publication and verification.
- `vsce publish` success means **uploaded**, not **released**. A direct version-specific package download, valid archive, or matching hash also does not prove VS Code can see the version.
- Never tell Ethan a version is publicly released, Marketplace-available, or fully complete until the command below exits zero and prints `BETTER_GIT_MARKETPLACE_RELEASE_VERIFIED` for the exact expected version:

  ```sh
  pat="$(security find-generic-password -w -s vsce-pat-ethansk -a EthanSK)"
  VSCE_PAT="$pat" node scripts/verify-marketplace-release.mjs \
    --vsix /absolute/path/to/better-git-vscode-X.Y.Z.vsix
  unset pat
  ```

- On Ethan's Mac, load the PAT from Keychain service `vsce-pat-ethansk`, account `EthanSK`, without printing it. Never commit, log, or echo the token.
- The verifier must check both authenticated publisher validation and the public validated-only Gallery result used by VS Code, then download and byte-compare the exact VSIX. Do not replace it with a weaker ad hoc check.
- While the verifier is waiting, report the state precisely as `uploaded; Marketplace validation pending` and keep waiting. Do not ask Ethan to refresh VS Code to obtain the public release before the verifier succeeds; an already installed local trial is a separate state.
- If the verifier times out or reports a validation message, the release is not complete. Retrieve the Marketplace verification log, repair the actual problem, publish a new version when necessary, and run the gate again.

## Local updates before public release

- After making and verifying Better Git changes, update Ethan's local Better Git VS Code without breaking its Marketplace connection. This is the standing default requested on 2026-09-15 and replaces the previous user-managed-install policy; do not ask again for routine installation permission.
- User-corrected — 2026-11-14: install a reviewed, viable local VSIX in Ethan's existing VS Code profile before full tests and Marketplace publication, following the shared `development-workflow/references/local-installation.md` rule. Verify its exact identity/version and packaged code; preserve settings, the existing extension and supported update association. Do not uninstall first or update unrelated extensions. This supersedes the earlier ban on local VSIX installation and the release-first requirement. Respect the current live-work/restart boundary; packaging alone is not activation.
- Complete full tests and the exact Marketplace release gate afterward. Then use `code --install-extension ethansk.better-git-vscode --force` without an `@version` suffix when needed to restore or verify Gallery association. Do not claim a local package is publicly released, rewrite private metadata, or leave an accidental version pin.
- Check the existing installed version first. If the exact intended build is already installed, do not reinstall it. Do not downgrade a newer installed release. Verify local package identity immediately and, after Gallery reconciliation, verify its release evidence, `metadata.source=gallery`, Marketplace UUID, no version pin, and effective per-extension automatic updates. Never repair association by manually editing VS Code's extension metadata.
- Ethan has given Codex permission to restart VS Code's Extension Host for him after every Better Git update. Do it as part of the normal update workflow instead of asking him to restart it. Preserve unsaved files, terminals, running jobs and current work; check live state, use the least disruptive supported extension restart, and follow the heads-up workflow before a disruptive restart. Verify fresh Better Git activation in the restarted host; installed files alone do not prove the new version is running. If live work makes activation unsafe, report that exact pending step instead of claiming the new behavior is running. This does not authorize MacBook E2Es or Extension Development Hosts.
- User permission — 2026-10-07: Ethan has given full permission to end any VS Code debug session from now on. End debug sessions when needed for a Better Git update without asking again, including accepting its supported **Restart Anyway** confirmation. Continue preserving unsaved files, terminals and unrelated jobs, and send the usual heads-up before restarting.
