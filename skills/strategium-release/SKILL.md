---
name: strategium-release
description: Use when the user asks to release, tag or version the strategium plugin ("release patch/minor/major", "nueva versión"); releases are automatic on merge to main, so this checks the last one or cuts a manual one (forced level, docs-only changes) and pushes only after the user's OK.
---

# Strategium release

Versions are SemVer tags `vX.Y.Z` (annotated) on the plugin repo, matching `version` in `package.json` and in `.omp-plugin/marketplace.json` (the one omp reads).
While on 0.x: breaking changes (tool actions, commands, state format under `runs/`, `claims/`, the day `.jsonl`, agent names) bump the minor; anything else bumps the patch (`cliff.toml`). Mark them with `!` or a `BREAKING CHANGE:` footer, or the release under-bumps.

## Automatic (the default)
`.github/workflows/release.yml` cuts a release on every push to `main` that changes what omp installs (`extensions/`, `skills/`, `agents/`, `alarm/`, `.omp-plugin/`; test files alone do not count): a read-only `test` job (check and tests) that exposes the SHA it verified, then a `release` job with the write token that checks out exactly that SHA (if `main` moved meanwhile the push is rejected and nothing lands until the next run): `git cliff --bumped-version`, both versions, `CHANGELOG.md`, commit `chore(release): vX.Y.Z`, tag, one `--atomic` push, GitHub release. `cliff.toml` keeps the `chore(release)` commits out of every changelog section and out of the notes. A merge that changes only docs, tests or dev tooling cuts none; the next release includes its commits. Commits that bump nothing (non-conventional messages) cut none either and end the run with a `::warning::`. A failed run (a human push to `main` mid-run, a failed `gh release create`): re-run it from the Actions tab with **Re-run all jobs**, never **Re-run failed jobs** (that skips `test`, so `release` reuses the old tested SHA, hits `fatal: tag 'vX.Y.Z' already exists` and fails again); a re-run after the push only creates the missing GitHub release. If a later merge already released before that re-run, create the missing one by hand with `gh release create vX.Y.Z --title vX.Y.Z --notes-file <(git cliff --strip all vPREV..vX.Y.Z)` (vPREV = the tag before it). So a release request usually needs nothing: show the last runs (`gh run list -w release -L 3`) and the latest tag, and report.

## Manual (a forced level, or releasing docs-only changes)
1. Run in the plugin's git checkout on `main`, up to date with `origin/main`. The tree must be clean (`git status --short` empty) and `bun test` green; otherwise stop and report.
2. Next version: `git cliff --bumped-version`, or the level the user asked for from the latest tag (`git describe --tags --abbrev=0`); ask when they gave none.
3. Set `version` to `X.Y.Z` in `package.json` and `.omp-plugin/marketplace.json` (edit tool).
4. `git cliff --tag vX.Y.Z -o CHANGELOG.md` (missing `git-cliff` → `scoop install git-cliff` or `cargo install git-cliff`, ask first).
5. Show the user the new CHANGELOG section and the version. Wait for the OK.
6. `git add package.json .omp-plugin/marketplace.json CHANGELOG.md`, commit `chore(release): vX.Y.Z` (the workflow skips that message), then `git tag -a vX.Y.Z -m "strategium vX.Y.Z"`. Commit with the repo's local identity; never change `user.email`.
7. Push only on a second, explicit OK, commit and tag in one atomic push: `git push --atomic origin main vX.Y.Z`. Optional on request: `gh release create vX.Y.Z --notes-file <(git cliff --latest --strip all)`.

Never move or delete a pushed tag; a wrong release gets a new release, not always a patch (a breaking change released without `!` gets a manual forced minor).
