# Fork maintenance

This fork supports [Paseo 0.17.3](https://github.com/getpaseo/paseo/releases/tag/v0.17.3) and later 0.17.x releases, including the current stable release 0.17.4. Both `@getpaseo/client` and `@getpaseo/plugin` are pinned to the minimum supported baseline, 0.17.3; the manifest admits `>=0.17.3 <0.18.0`. Client and server typechecks validate SDK usage; real channel delivery on these releases still needs live verification.

## Branches

- `main`: keep aligned with `ClarePhang/paseo-im`'s `main`, without fork-specific commits.
- `stable`: the default branch, containing compatibility fixes and tested upstream merges.
- Short-lived branches from `stable`: prepare fixes, Paseo upgrades, and upstream merges for review.

Publication status (2026-11-24): compatibility commit `12ec017` is pushed to `origin/stable`, and GitHub confirms `stable` as the default branch. `main` remains the upstream tracking branch. No scheduled sync or automatic merge has been enabled.

Paseo's [Git update rules](https://paseo.sh/docs/plugins#install-a-published-plugin) resolve the repository's default HEAD on update. `--ref stable` selects the initial installation only. Changing the default branch is therefore part of making future updates use this fork's compatibility fixes.

## Import upstream changes

Start with a clean working tree. `origin` is this fork; `upstream` is `https://github.com/ClarePhang/paseo-im.git`.

```sh
git fetch upstream main
git switch main
git merge --ff-only upstream/main
git switch stable
git switch -c chore/sync-upstream
npm ci --ignore-scripts
npm run typecheck && npm test
git merge upstream/main
# Resolve conflicts, preserving the fork's compatibility changes.
npm ci --ignore-scripts
npm run typecheck && npm test
npm run check:package && npm run check:runtime
```

If `main` cannot fast-forward, inspect its local commits before proceeding. Do not reset it or force-push to make the sync succeed. If another worktree holds `main`, update it from that worktree, or prepare the sync branch by merging `upstream/main` directly.

Review the merge into `stable`, including the SDK pins, lockfile, manifest requirement and daemon `appVersion`. Update `docs/status.md` with evidence, then commit. Publish and open a PR only when authorized. This process is documented; no scheduled sync or automatic merge has been enabled.

## Follow a new Paseo release

Check [GitHub's latest stable release](https://github.com/getpaseo/paseo/releases/latest), rather than an unreleased `main` commit. On a branch from `stable`:

1. Run the existing typecheck and tests before editing.
2. Keep both SDKs pinned to the oldest supported baseline. If adopting an API that requires a newer minimum, update both pins in `package.json` together, then run `npm install --ignore-scripts` to update `npm-shrinkwrap.json`. A new patch release alone does not require raising the minimum.
3. Align `server/daemon.ts` and `scripts/verify-pairing.mjs` `appVersion` with the client SDK. Update the manifest range and the version in the status handbook's self-test example.
4. Adapt any changed APIs using the released SDK and current plugin docs. Never set an unbounded compatibility range just to bypass rejection.
5. Run both typechecks, the full tests, package and runtime guards. `tests/compatibility.test.ts` catches version drift between the SDKs, lockfile, client declarations and manifest.
6. Verify loading on the target daemon and app, and exercise the channels in use. Record the evidence in `docs/status.md`; record new pitfalls in `docs/gotchas.md`.
7. Review and merge into `stable` after the checks pass. Import upstream fixes through separate PRs so their effects remain reviewable.

Patch releases within the declared range can be accepted, but a future minor release requires a fresh compatibility review. This branch policy preserves fork fixes while retaining upstream Git history.
