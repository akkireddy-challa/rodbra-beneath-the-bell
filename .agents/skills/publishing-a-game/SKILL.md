---
name: publishing-a-game
description: Use when publishing this Bitmagic game to bitmagic.ai, making it public or private, building the bundle, choosing category tags or a thumbnail, sharing the game's link or QR code, or when `bitmagic publish` refuses or exits non-zero (verify stale, not logged in, exit 7 and the rest).
---

# Publishing this game

For Poki export or SDK integration, read the sibling `publishing-to-poki/SKILL.md` first.
The workflow below publishes to Bitmagic hosting.

```
bitmagic build      # bundle into .bitmagic/build/index.html + .bitmagic/build/manifest.json
bitmagic publish    # verify-gate, build if needed, and ship to bitmagic.ai
```

Publish enforces this order and refuses otherwise:

1. **`bitmagic verify`, passing.** It writes `.bitmagic/verify/result.json`,
   `.bitmagic/verify/screenshot.png` and `.bitmagic/verify/console.log` — or the
   `.mobile`-suffixed names when the run was a phone one.
2. **No edit to a tracked file between verifying and publishing.** See the fingerprint rules below.
3. **`bitmagic publish`.** It rebuilds automatically if the project changed since the last build,
   so a manual `bitmagic build` first is optional.

## Public is a flag, not a default

Every publish uploads and registers the game, but `visibility` defaults to `private` — reachable
by URL, not listed on bitmagic.ai. Pass `--visibility public` explicitly, **on that call**, to
list it. Omit it on a later publish to preserve the stored visibility.

## The URL publish prints is the one to pass on

Publish prints the link worth sharing, and it is deliberately not the file it just uploaded:

- a **public** game gets `bitmagic.ai/play/<ID>/` — the game's page, with its name, cover art
  and comments on it, and the address every other part of bitmagic.ai links to;
- a **private** game gets `bitmagic.ai/games/<ID>/` — the build on its own, reachable by anyone
  with the link but listed nowhere.

Both always serve the newest publish, so a link the creator hands out today keeps working after
tomorrow's `bitmagic publish`. Pass on the line publish printed; do not build a URL yourself.

`--version-url` additionally prints `.../indexN.html`, the one build this call uploaded. That
one is frozen: useful for pinning a bug report to a specific publish, wrong for sharing. Under
`--json` you get all of them — `playUrl` and `latestUrl` are the shareable pair (prefer
`playUrl` when it is there), and `url` is the versioned one.

## Show the creator the QR code

Publish turns the shareable URL into a scannable image. Your output is a pipe, so it cannot be drawn
in the terminal: publish writes `.bitmagic/publish-qr.png` and names it (`qrPath` under
`--json`). Surface that image like any artifact you made — scanning it opens the game on a phone,
and a bare URL leaves your creator retyping a game id into a browser.

## The thumbnail

`.bitmagic/cover.webp` when `bitmagic cover` has produced one, and the verify screenshot
otherwise. The output names which one it used. `bitmagic cover` writes `world.json`, so it
invalidates a passing verify — run it BEFORE `bitmagic verify`, never between verifying and
publishing.

## What invalidates a verify, and what does not

Staleness is a **content fingerprint of every tracked file**, not a clock. One edit after verifying
invalidates it immediately; an untouched project stays fresh no matter how long it has been. There
is no way to check freshness except running `bitmagic verify` again.

| Safe between verify and publish | Invalidates the verify |
|---|---|
| Git operations — `.git/` is excluded, so commit, branch or stash freely | Any edit to a tracked file under `src/`, `index.html`, `game.json`, `world.json`, … |
| `node_modules/`, `dist/`, `.bitmagic/`, `.vite-cache/` | `bitmagic cover` (it writes `world.json`) |
| `GAME-DESIGN.md` and `mechanics-plan.md` — no build step reads them, so refining the design or the backlog is free | declaring `categories` or `primaryPlatform` (tracked-file edits — do them first) |

## Category tags

bitmagic.ai files the game under content categories ("Racing", "Puzzle", …), and publish
auto-classifies an untagged game from its name and description. To choose them yourself, declare
`"categories": ["Racing", "Arcade"]` in `worldProfileData` — a declared set wins on every
publish, and an explicit `[]` means "no tags" and suppresses the auto-classify. It is a
tracked-file edit: declare them BEFORE `bitmagic verify`.

## One-shot overrides

`--name` / `--description` apply to that one publish call only. They are never written back to
`src/work/game.json` — doing so by hand would change the fingerprint and invalidate the verify you
just checked.

`--force` overrides a **stale or failed** verify verdict, never a **missing** one. A project with
no cover art has only the verify screenshot to publish a thumbnail from, so `bitmagic verify` must
have produced one at least once before `--force` has anything to work with.

## The render smoke test

After a successful publish the CLI loads the published game the way the portal does — in an iframe
that starts at a zero-size viewport — and fails with **exit 7** if it does not render. This catches
failures that leave no other trace: a wrong Content-Type that makes the browser download the page, a
bundle that cannot find its own world.json, a canvas nothing ever draws into. Artifacts land in
`.bitmagic/smoke/`.

`--skip-smoke` skips it. The publish still happens; it is simply not confirmed to render, and the
output says so.

## When it exits non-zero

Branch on the exit code rather than parsing the message.

| Code | Meaning | Fix |
|---|---|---|
| 1 | Build failed, or what was uploaded was not an engine build | Run `bitmagic check` to see the error, fix it. If the message names a missing `vite.publish*.config.js`, this project predates it — run `bitmagic upgrade`. Do NOT retry an unchanged bundle; the refusal is deterministic |
| 2 | Not logged in | `bitmagic login` |
| 3 | Verify missing, stale, or failed | `bitmagic verify` (then publish again, or add `--force` for a stale/failed record) |
| 5 | Not this game's owner, or the account/game is banned | Not self-serve — stop and report it |
| 6 | Upload or finalize failed | Usually transient (network/storage). Retry once; if it fails identically, stop and report it — this code also covers permanent failures such as an unknown game or a rejected request |
| 7 | Published, but the game did not render | The game IS live. Do NOT retry the publish — fix the game and publish again. Artifacts in `.bitmagic/smoke/` |

## Every publish uploads your source

A **source archive** of this project goes to a publicly readable (though unguessable) URL, which
Bitmagic checks against the bundle and against an unmodified `engine/`; findings print as
`warning:` lines and never block a publish. Credential-shaped files (`.env*`, `*.pem`,
`*.key`, `.npmrc`, service-account JSON) are excluded and named in the output — but that list
cannot be exhaustive, so **never keep a secret in this directory**.

It carries source, not assets. Models, textures, audio and video are CDN URLs in `world.json`, so
a `.glb` or `.png` in `build/` or `assets/` is a build input rather than part of the game: the
archive records it by path and hash and leaves the bytes out, as it already does for `engine/`.
Publish prints how many it left out, their total size, and the archive's own size.

## An old engine never blocks a publish

When a newer engine exists, `bitmagic dev` and `bitmagic publish` say so and suggest
`bitmagic upgrade`. Upgrade while you are developing, when rebuilding is cheap, rather than being
blocked at the moment you ship.
