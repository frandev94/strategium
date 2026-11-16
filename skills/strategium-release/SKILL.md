---
name: strategium-release
description: Use when the user asks to release, tag or version the strategium plugin ("release patch/minor/major", "nueva versión"); bumps package.json, writes CHANGELOG.md with git-cliff, commits and tags vX.Y.Z, and pushes only after the user's OK.
---

# Strategium release

Versions are SemVer tags `vX.Y.Z` (annotated) on the plugin repo, matching `version` in `package.json`.
While on 0.x: breaking changes (tool actions, commands, state format under `runs/`, `claims/`, the day `.jsonl`, agent names) bump the minor; anything else bumps the patch.

## Steps
1. Run in the plugin root `<R>` (the `path` of `strategium` in `omp plugin list --json`). The tree must be clean (`git status --short` empty) and `bun test` green; otherwise stop and report.
2. Next version: from the latest tag (`git describe --tags --abbrev=0`) and the level the user asked for. If they gave none, propose one from `git log <tag>..HEAD --oneline` (any `feat!`/`BREAKING` → minor on 0.x; `feat` → minor; only `fix`/other → patch) and ask.
3. Set `version` in `package.json` to `X.Y.Z` (edit tool).
4. `git-cliff --tag vX.Y.Z -o CHANGELOG.md` (no `cliff.toml`: the default config is enough; missing `git-cliff` → `scoop install git-cliff` or `cargo install git-cliff`, ask first).
5. Show the user the new CHANGELOG section and the version. Wait for the OK.
6. `git add package.json CHANGELOG.md`, commit `chore(release): vX.Y.Z`, then `git tag -a vX.Y.Z -m "strategium vX.Y.Z"`. Commit with the repo's local identity; never change `user.email`.
7. Push only on a second, explicit OK: `git push && git push origin vX.Y.Z`. Optional on request: `gh release create vX.Y.Z --notes-file <the new CHANGELOG section>`.

Never move or delete a pushed tag; a wrong release gets a new patch.
