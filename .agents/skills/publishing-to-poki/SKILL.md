---
name: publishing-to-poki
description: Prepare a Bitmagic game for Poki, include the Poki SDK, create an upload ZIP, or diagnose a failed Poki export. Use for requests to install or integrate the Poki SDK in this game.
---

# Preparing this game for Poki

SDK setup is automatic in `bitmagic publish --target poki`. The engine owns SDK initialization,
gameplay events, and advertisement handling. Keep those calls centralized: do not install an npm
SDK wrapper, paste script tags into generated HTML, or add duplicate lifecycle calls to game code.

First read `bitmagic publish --help` and confirm its `--target` description explicitly includes
`poki`. An old CLI may accept an unknown flag and perform ordinary Bitmagic publishing, so a zero
exit status from help is insufficient. If support is absent, follow the project's `bitmagic
self-update` guidance and check help again. Never fall back to bare `bitmagic publish` for a Poki
request. If updating is unavailable, report the missing capability instead of editing an SDK in.

```sh
bitmagic verify
bitmagic publish --target poki --json
```

If export names a missing engine capability or standalone config, run `bitmagic upgrade`, then
verify again. Upgrade changes the engine; do not apply it silently when the creator has asked to
keep an exact engine version. Follow the project's original-prompt convention on CLI calls.

The result names `zipPath`, `payloadDir`, `manifestPath`, `checksDir`, and `handoffPath`. Read the
generated `EXPORT-HANDOFF.md` for coverage, service warnings, and remaining upload/QA work. The default ZIP is
`.bitmagic/poki/poki.zip`; `--output ./release/game.zip` selects another destination. Default output
is excluded from the source fingerprint. Put custom output outside the project if it should
not make the next source verification stale; adding a path to `.gitignore` alone does not exclude it.

## When export fails

- Exit 3: source verify is missing, stale, or failed. Fix the cause and verify again. `--force`
  permits a stale/failed record but never bypasses packaged validation.
- Exit 4: engine capability/config missing or incompatible. Update the CLI/engine as directed.
- Exit 7: packaged validation failed; no new successful export is reported. Read `checksDir` in
  the error, especially `result.json` and `console.log`. Fix missing assets, game startup, or
  game-specific flows that bypass engine state transitions. Do not retry unchanged failures.
- `requests.json` records missing/local and external requests with method, resource type, and
  matching game source files. Optional authoring fetches must be explicitly gated to local use;
  do not ignore every 404 or add an empty file merely to make validation pass.
- An external service cannot be bundled as an asset. Poki export rejects online-only engine
  APIs, live connection APIs, and known Bitmagic backend URLs in game sources before building.
  Neither `--force` nor a playtest bypasses this rule. Agree on an offline implementation with
  the creator; do not silently drop features or request a backend exception for this exporter.

This command creates local artifacts. It does not upload the game, change its Bitmagic listing,
or request Poki review. Local SDK checks use a test stub: open the payload folder in
[Poki Inspector](https://inspector.poki.dev) to test the real SDK, ads, and device behavior before
submission. Return the ZIP path and distinguish local validation from Inspector testing.

## Exercise the actual game

An engine PLAYING event can occur while a custom title screen, briefing, or chapter picker is
still open. A smoke pass does not prove that a session, score submission, or later level works.
Online service references are a hard preflight failure, including callbacks and computed method
names. The scan is conservative: even an online call behind a runtime condition must be absent
from the Poki game sources. Keep ordinary Bitmagic behavior in the appropriate source variant;
do not change that behavior merely to make a Poki export pass.

Other game-owned resource APIs (`fetch`, XHR, workers and beacons) require `--poki-playtest`.
Exercise every such flow, including score submission, score display, and later levels. The
remaining `serviceRisks` are review hints, not a complete network inventory. Browser-blocked
requests and caught request errors still fail validation. Preserve the normal SDK/page layout;
do not hide dependencies by blocking them, swallowing errors, or adding extra game iframes.

If help advertises `--poki-playtest`, use it to run a self-contained `.mjs` scenario exporting
`default async ({ frame, platform })`. `frame` is the game's Playwright iframe, already past the
engine start interaction. Use the game's actual controls to reach a representative session and
test late-loading features. Finish in active gameplay so pause/ad/resume can be checked. Each
scenario has a 30-second limit and runs on desktop/mobile during discovery and ZIP validation.
Store the script under `playtest/`, verify after adding it, then export with
`--poki-playtest playtest/poki.mjs`. Older CLIs need updating before using this flag.

For real SDK QA, prefer the uploaded version's Inspector link when that upload was requested.
Otherwise open the payload folder in Inspector. Check whether folder selection is supported by
the browser tool before attempting it; if unavailable, hand off that selection instead of
waiting on repeated attempts. A local server's HTTP 200 does not prove Inspector's iframe loaded:
confirm rendering and SDK events. Inspector Mobile mode hands off via QR to a physical phone;
automated mobile emulation is a separate result.

## When upload is requested

Upload is separate and requires the creator to request it. For an authorized upload, the
[official Poki CLI](https://github.com/poki/poki-cli) accepts the payload directory and a Poki game
ID. That ID is different from the Bitmagic game ID. A successful upload is not a public release.
Read `npx @poki/cli upload --help`; use `--build-dir` with `payloadDir`,
`--disable-image-compression` to preserve validated assets, and `--no-make-public` unless a
public release was requested. First-time authentication opens the system default browser;
arrange the browser handoff before invoking it if browser access is restricted. Do not invent
a browser-selection or no-open flag.

Capture the returned version ID and Inspector/preview links, and check processing status before
uploading again: a delayed dashboard entry is not proof of failure. Do not rely on exit status
alone; the upstream uploader can print an error and still exit successfully. Record upload,
Inspector smoke results, full QA, physical-phone testing, moderation, and release separately in
`UPLOAD-HANDOFF.md`. Re-export regenerates only `EXPORT-HANDOFF.md`, preserving those manual notes.
