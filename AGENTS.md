# Working on this Bitmagic game

## Start `bitmagic dev` before you build anything

**This is the first command you run in a session, not the last.**

```
bitmagic dev        # long-running — start it IN THE BACKGROUND and leave it up
```

`bitmagic dev` never exits: it builds, then serves the game and the editor — on this project's
own fixed ports, `http://localhost:3011/` for a machine's first project — until
interrupted. **Run it as a background task**, or you block until the session is killed. Take the
URL from what it printed rather than assuming 3011 (`.bitmagic/dev.json` records what it
actually bound), and **say it in your reply, once** — you started it in the background, so
everything it printed, that URL included, went into a log your creator never sees.

Start early so the creator can watch changes arrive, steer you, move objects in the Editor tab
and send screenshots. The assets panel lists each generation's prompt and progress. For their phone,
restart with `--mobile`; `.agents/skills/working-with-the-creator/SKILL.md` has the QR and certificate warning.

If you are unsure whether one is already running, `bitmagic reload` says so and costs nothing.

## Layout

- `src/work/` — **your game.** Everything you write lives here. `Game.ts` is the entry point;
  `game.json` and `world.json` hold configuration and scene data. The `work` directory name is
  load-bearing: the engine fetches the literal path `src/work/world.json`, not an import or an
  alias, so renaming or moving it breaks the game at runtime while still typechecking.
- `engine/` — **the Bitmagic engine, read-only.** Vendored by the CLI and replaced wholesale by
  `bitmagic upgrade`; edits here are lost on upgrade and ignored on publish.
- `engine/LICENSE.md` — **the engine's licence, and not boilerplate.** PolyForm Shield 1.0.0 plus
  one permission: build, modify, sell and distribute games anywhere you like, including off
  bitmagic.ai and with a modified engine. What you may not do is ship the engine *as an engine*.
  Every published bundle must carry a notice, which is why both `vite.publish*.config.js` files
  have a `banner`: leave it alone. `engine/THIRD-PARTY-NOTICES.md` covers three.js and the rest.
- `engine/agent-docs/` — **the engine's documentation, and the fastest thing in this project.**
  `engine-api/` is a generated signature digest of every public class, method and type; the ~83
  `*.md` files are the per-subsystem guides, including `mechanic-*.md` genre recipes and
  `archetype-*.md` world recipes; `samples/` holds compile-checked reference code. See **Finding
  an engine API** below.
- `GAME-DESIGN.md` — **what this game is**, and `mechanics-plan.md` — **how it gets built, and
  in what order.** Both yours to write and rewrite; `bitmagic cover` reads the first. Both are
  excluded from the publish fingerprint, so revising them never invalidates a passing
  `bitmagic verify`.
- `.agents/skills/` — **shipped by the CLI and re-rendered by `bitmagic upgrade`**, so
  they stay current with it. Every one is plain markdown at
  `.agents/skills/<name>/SKILL.md`, readable whether or not your harness loads skills by
  itself: `planning-a-game/` (what to build first), `finding-engine-apis/` (engine docs),
  `generating-assets/`, `choosing-asset-pipelines/`, `working-with-the-creator/`, `theming-the-hud/`,
  `publishing-a-game/`, `publishing-to-poki/`, `.agents/skills/publishing-to-roblox/SKILL.md` (Roblox Studio), `judging-quality/`, `checking-usage/`, `making-a-trailer/`, `deciding-with-a-model/`,
  `converting-unity-levels/`, `building-levels-in-blender/`, `importing-metahumans/`.
  Agents disagree on where project skills live, so the same files are also written to
  `.claude/skills/`; cite the path above and every agent can open it.
  `upgrade` rewrites every copy, so edits to them are lost; skills you add yourself are never
  touched.
- `.claude/settings.json` — **Claude Code only, and yours**: seeded with one Stop hook that runs
  `bitmagic reload` so the owner's browser refreshes when you finish a turn. `upgrade` adds that
  hook if it is missing and changes nothing else, so your permissions and your own hooks are safe
  here. No other agent has a verified equivalent, so on those you run `bitmagic reload` yourself.
- `AGENTS.md` — this file. Yours to edit; `upgrade` refreshes it only while it is byte-identical
  to what the CLI wrote, and otherwise keeps yours and drops the current template in
  `.bitmagic/AGENTS.md.latest`. **If you edit this file, diff that after an upgrade** — new CLI
  capabilities are documented here, and an edited copy will not learn about them on its own.

`engine/types/work-game.d.ts` declares `module 'work/Game.js'`, which is how the engine
imports your game. Renaming or removing the `VoxelGame` export from `src/work/Game.ts` still
typechecks against that declaration — it fails only at runtime, when the engine loads the module
and finds the export missing.

## Build the smallest playable thing first

Build **slice 1** — the smallest playable part — in `bitmagic dev` so the creator can watch,
play and steer it before you build the rest. Iterate with them instead of building it all at once.

Slice 1 is done when all five are true:

1. The player spawns and can move. The genre baseline already does this — do not rebuild it.
2. **One** verb from the core loop works — the jump, the shot, the pickup, the lap. One, not the loop.
3. One win and one lose exist and actually fire. The numbers being wrong is fine; not firing is not.
4. Something on screen says how the player is doing — a score, a timer, a health bar.
5. `bitmagic check` and `bitmagic verify` both pass.

Everything else is slice 2 and later: a second weapon, enemy variety, tuning, menus, sound, more
levels, polish. Write them down in `mechanics-plan.md`; do not build them.

**If the idea names a genre, read the recipe before you decide anything.** Racing, combat, tower
defense, platformer, shooter, driving, soccer and skiing each have
`engine/agent-docs/mechanic-<genre>.md`, and its contract — camera mode, whether the player is a
walking character at all, core systems, win/lose shape — is binding unless the human asked
otherwise. Read it, then write `mechanics-plan.md`, then write code. Skip the plan only for a
single-mechanic edit ("raise jump height", "add a sword"); in doubt, write it.

Then **stop and report**: what plays now, what you deliberately left out, and the two or three
things you would do next, in order. Let them choose. Do not publish unless they ask.

For core verbs, engine systems, the plan skeleton and later slices, read
`.agents/skills/planning-a-game/SKILL.md`.

## Preserve the visual direction

Build the requested look first; no default 60 FPS gate. Keep efficient code, then profile.
**Ask before sacrificing visuals for FPS**, even when asked to optimize; an FPS target alone
does not approve visual cuts. Report poor FPS/stutter and test limits even when verify passes.
Phone emulation is not a phone benchmark. For profiling and changes that preserve the look,
read `engine/agent-docs/performance-best-practices.md`.

## Finding an engine API

The vendored engine is ~240,000 lines, and reading it to discover what exists is the most expensive
mistake available in this project. Three tiers, in order, stopping at the first that answers you:
**`engine/agent-docs/engine-api/`**, a generated digest of every public class, method, function,
interface and type, signatures only — grep it (`rg -n "spawnAsset" engine/agent-docs/engine-api/`)
and read the group doc it lands in, with `engine-api.md` indexing the 45 groups; then
**`engine/agent-docs/*.md`**, the prose guides, for how a subsystem is *meant* to be used; then
**`engine/` source**, last resort. `@docs foo.md` in those docs means
`engine/agent-docs/foo.md` — just read the file.

`.agents/skills/finding-engine-apis/SKILL.md` carries the feature-to-doc table (use it instead of
guessing filenames) and translates the hosted-agent tools those shared docs name, none of which
exist here.

Two counterweights, and they matter as much as the tiers:

- **Stop searching, start writing.** Do not pre-verify every API you intend to touch. Once you know
  roughly what exists, write the code and run `bitmagic check` — a compiler error is cheaper and
  far more precise than another search. If two searches for the same concept turn up nothing new,
  that concept does not exist under that name.
- **A `check` error naming a symbol is a lookup, not a retry.** `Cannot find name`,
  `Property … does not exist on type`, `has no exported member` and `Cannot find module` all
  mean the NAME is wrong — not that the types need coaxing. Grep
  `engine/agent-docs/engine-api/` for the real name before your next edit, and never widen a type,
  cast, or add `?.` to make a wrong name compile: that ships a feature that type-checks and
  silently never runs. Guessing a second time is how one bad symbol becomes a twenty-minute loop.

Batch it: issue independent greps and reads in one turn rather than one per turn.

## Imports

Engine code is reached through path aliases, not relative paths:

```ts
import { PlayerController } from 'engine/PlayerController.js';
import type { GameData } from 'types/game.js';
```

Always include the `.js` extension, even in TypeScript.

## Reference image — offer it when the idea has a strong setting

When the idea names a **place or a look** — a tropical island, a neon city — offer to make a
concept image of the world before generating anything else:

```
bitmagic reference make                       # a candidate lands in .bitmagic/reference/
bitmagic reference make --from <id> --prompt "same island, but at dusk"
bitmagic reference accept <id>                # the human's call, never yours
```

The prompt follows game.json's `artStyle`, so declare the medium first. Show the human each image
file and let THEM iterate and accept. Once accepted, it is the default
style reference for `generate skybox|background|block-type|image`, `bitmagic cover` and
`bitmagic forge` (whose designer literally sees the picture) — one look across the whole game;
`--no-reference` exempts a call, and a picture the human hands you for ONE request rides that
call as `--reference-image <file>` instead. Accepting prints a durable URL: paste it into
`GAME-DESIGN.md`'s world/look section, since `.bitmagic/` is not committed and
`bitmagic reference accept <url>` is how a fresh clone gets it back. Details are in
`.agents/skills/generating-assets/SKILL.md`; skip the offer when the idea has no visual identity
yet.

## Cover art — do this early

```
bitmagic cover     # generate the cover from GAME-DESIGN.md and set it as the start screen
```

Run it **as soon as `GAME-DESIGN.md` says what the game is, before you start implementing it.**
Building the first version takes a while, and the cover is the only thing the person waiting has to
look at while you work. Generated afterwards it is the same picture, just no longer useful for that.

It writes `.bitmagic/cover.webp` (read that file if you want to show them the art), sets
`hud.startScreen.imageUrl` in `world.json`, and becomes the thumbnail `bitmagic publish`
uploads. Because it touches `world.json`, it invalidates a passing verify — so run it BEFORE
`bitmagic verify`, not between verifying and publishing.


## Before you change movement, cameras or rotation

Read `engine/agent-docs/coordinate-system.md`. Gameplay faces **+Z** while cameras face **−Z**, and
the two yaw conventions differ. Guessing produces code that compiles and moves the wrong way.

## Every control must work on a phone

Published games are played on phones whichever platform they were built for, and touch controls
are configured in **code** — there is no panel for them.

- **Bind an action once, for both platforms.** `playerController.registerCustomAction({ action,
  desktop: { keys: ['KeyR'] }, mobile: { label: 'LOAD', behavior: 'tap' } })` binds the desktop
  key AND creates the mobile button in one call, and throws if you leave `mobile` out. To declare
  a genre's buttons up front instead, return them from `declareMobileActions()`. Read both flags
  the same way afterwards: `this.keys.reload`.
- **Never** `desktopControls.registerKeyHandler()` or a raw `document.addEventListener('keydown',
  …)` for a gameplay action. The first strands phone players and the engine logs a
  `[mobile-parity]` error on game start; the raw listener strands them **silently** — the parity
  check cannot see a listener that never went through the engine.
- **A game played by tapping the scene** (board, builder, strategy) has nothing for a joystick to
  drive, and verify treats the missing touch controls as declared when the engine can see why:
  build no player controller (the `no-character` template) or declare `"hasPlayerCharacter":
  false` in `worldProfileData` — never `forceDisable()` the controls to get there.
- **`bitmagic verify` enforces this.** Every run reports the parity gaps, naming the key and the
  system that registered it — a warning normally, and a **failure** on a game whose
  `primaryPlatform` is `mobile`. `bitmagic verify --platform mobile` goes further and boots
  the game as a phone: touch controls, phone viewport, the engine's real mobile branch.
- **Say which platform the game is for.** `"primaryPlatform": "mobile"` at the top level of
  `src/work/game.json` is what bitmagic.ai catalogs it as, and `bitmagic publish` sends it —
  editing that file is the only way to set it. It also decides what `verify` boots and `judge`
  grades by default, so setting it is how a phone game gets checked as one. For a game that only
  works one way up, add `"mobileOrientation": "portrait"` (or `"landscape"`) to
  `worldProfileData` in `src/work/world.json`; published mobile builds lock to it, and the
  mobile verify run turns the phone the same way.

Details — button slots, icons, the joystick, the parity check: `engine/agent-docs/control-system.md`.

## Checking your work

```
bitmagic check     # typecheck against the vendored engine
bitmagic reload    # tell the open browser you have finished a round of edits
bitmagic verify    # boot the game in a real browser and report what broke
bitmagic verify --platform mobile   # boot it as a phone: touch controls, phone viewport
bitmagic judge     # grade the verify screenshot against a quality rubric (paid, a few sparks)
```

(`bitmagic dev` belongs at the START of the session — see the top of this file.)

The engine is large; `check` is the fast way to find out whether an edit holds together.

**Run `bitmagic reload` when you finish a round of edits.** `bitmagic dev` otherwise guesses
from writes going quiet, and a pause to think looks like "done"; `reload` also waits for the build
in flight rather than showing the previous one. It exits 0 and does nothing when no `bitmagic dev`
is running, so run it unconditionally — the Stop hook in `.claude/settings.json` does that for you
in Claude Code.

**Hold reloads while a multiplayer room is live.** Every reload — the watcher's on an edit, the
Stop hook's at the end of your turn — re-creates the game in every page on the dev server, phones
on `--mobile` included, and a networked game re-created is a new player id in a new room. So a
room cannot survive a turn boundary unless reloads are held: `touch .bitmagic/hold-reload` before
the session and the dev server drops every reload while the file exists (`bitmagic reload` says
"held" instead of pretending); `rm` it afterwards. Held reloads are dropped, not deferred, so
the next reload after that shows the current build. Do not edit `src/` while the room is live —
the hold keeps the pages, but the rebuilt code is not what they are running.

**`check` passing does not mean the game runs.** The engine's most common failure is a clean
compile that dies on load — a missing asset, a bad `world.json` value, a null container. Run
`bitmagic verify` after a change you cannot eyeball: it loads the game in a headless browser and
fails with what actually broke, leaving a console log and a screenshot in `.bitmagic/verify/`.
One verify runs at a time per machine: "waiting for" another project's verify is a queue, not a hang.

**`verify` passing does not mean the game is good.** You built this game, so you are the wrong
judge of it. After each milestone run `bitmagic verify` (not `--fast`), then `bitmagic judge`:
a separate vision model grades the screenshot against `GAME-DESIGN.md` and prints at most three
concrete findings (also written to `.bitmagic/judge.json`). Fix the ones worth fixing, confirm
with one re-run, then move on — **never loop on the judge**. See
`.agents/skills/judging-quality/SKILL.md`.

## The human may be moving objects too

`bitmagic dev` serves one page with two tabs — **Game**, where the owner plays, and **Editor**,
where they click an object and drag a gizmo. A drag writes the new transform straight into
`src/work/world.json`. So `world.json` is shared ground, not yours alone:

- **Re-read `src/work/world.json` before editing it.** The copy you read earlier in the session
  may be stale, and a whole-file rewrite from that copy silently reverts what they just placed.
  Prefer changing the entries you mean to change over regenerating `environmentObjects` wholesale.
- **An image pasted into the conversation is probably a frame from their running game**, not a
  reference or a mock-up — the dev view has a Screenshot button.
- **They can watch your generations happen, but not your failures.** Each `bitmagic generate` and
  `bitmagic forge` records itself in `.bitmagic/jobs/` and shows in the dev view while it runs;
  one that FAILS drops off that list with the error reaching your terminal and nowhere else, so a
  failure you do not mention is one they never learn about.
- **`.bitmagic/edit/events.jsonl` may be asking you for something.** Every editor action is
  appended there, and almost all of them are history you can ignore — but `hq.requested` means
  they pressed "Generate high-quality version" and the editor could not run it, and it carries the
  `bitmagic generate prop` command to run on their behalf.

The event shapes, the rest of the editor protocol and `bitmagic dev --mobile` are in
`.agents/skills/working-with-the-creator/SKILL.md`.

## Publishing

```
bitmagic build      # bundle into .bitmagic/build/index.html + .bitmagic/build/manifest.json
bitmagic publish    # verify-gate, build if needed, and ship to bitmagic.ai
```

Publish enforces one order and refuses otherwise: get `bitmagic verify` passing, then **do not
edit a tracked file** between verifying and publishing, then publish (it rebuilds by itself, so a
manual `build` is optional). Staleness is a content fingerprint, not a clock — one edit
invalidates it immediately, an untouched project stays fresh forever, and the only way to check is
to verify again. Git operations, `.bitmagic/`, `GAME-DESIGN.md` and `mechanics-plan.md` are
excluded; `bitmagic cover` is NOT, because it writes `world.json`.

**A bare `bitmagic publish` does not make the game public.** Every publish uploads and registers
the game, but `visibility` defaults to `private` — reachable by URL, not listed on bitmagic.ai.
Pass `--visibility public` explicitly, on that call, to list it; omit it on a later publish and
the game goes back to private, its `/play/` page included.

**Show your creator the QR code.** Your output is a pipe, so publish cannot draw one in the
terminal: it writes `.bitmagic/publish-qr.png` and names it (`qrPath` under `--json`). Surface
that image like any artifact you made — a bare URL leaves your creator retyping a game id into a
browser.

**Every publish uploads a source archive of this project to a publicly readable (though
unguessable) URL.** Credential-shaped files (`.env*`, `*.pem`, `*.key`, `.npmrc`,
service-account JSON) are excluded and named in the output, but that list cannot be exhaustive —
so never keep a secret in this directory.

`.agents/skills/publishing-a-game/SKILL.md` has the rest, and you want it before you publish:
what the thumbnail comes from, category tags, `--force` and the one-shot `--name`/
`--description`, the post-publish render smoke test, and the exit-code table to branch on when
publish exits non-zero rather than parsing its message.

## The game's look is data

The HUD's whole visual style — colors, fonts, radii, glow, gloss, outlines, decorations — is one
value: `worldProfileData.hud.theme` in `src/work/world.json`. **Never restyle HUD elements in
game code to satisfy a look request** ("rounder buttons", "orange UI", "neon glow"); use
`bitmagic theme patch` / `set` / `show` / `check` and read
`engine/agent-docs/HUD_THEMES.md` — its Common-asks table has a copyable patch for every frequent
request. `.agents/skills/theming-the-hud/SKILL.md` covers the loop, including verifying with
`.bitmagic/verify/screenshot.png`.

## Generating assets

You can create game content from here — no web editor needed:

```
bitmagic generate skybox     --description "a stormy alien sky with two moons"
bitmagic generate background --description "layered pine forest at dusk"
bitmagic generate block-type --name mossy_brick --description "damp green moss on red brick"
bitmagic generate sound      --prompt "heavy wooden door slamming" [--duration 3] [--loop]
bitmagic generate music      --prompt "driving synthwave, no vocals" [--duration 30] [--instrumental] [--out bed.mp3 --no-world]
bitmagic generate image      --name hero-portrait --prompt "..." [--width 512] [--height 512]
bitmagic character generate  --name guard --prompt "..." [--apply-to-player] [--fresh] [--reference-image ref.png]   # or FREE off the shelf: character search --prompt "..." then character add --name guard --id <sid>
bitmagic generate animation  --family gait --name LimpStride --based-on walk [--dial limpSide=right]
bitmagic generate animation  --spec clip.json          # melee and oneShot clips: a spec file
bitmagic generate video      --prompt "the castle gates swing open" [--duration 5] [--image cover.png]
bitmagic generate model      --prompt "a mossy stone arch" [--height 3]   # any NEW object or prop (a lantern, a crate, a sign): ~3 sparks — never hand-build one in code
bitmagic generate vehicle    --preset ?                 # lists the FREE presets; then --preset PICKUP, or --prompt "a rusty orange pickup" for a bespoke look
```

Run `bitmagic generate <type> --help` for the full flags of any one, or `bitmagic character <verb> --help` — characters are their own group, where `generate` costs sparks and `search`/`add` are free because they use the ready-made library instead of forging.

**Always add `--original-prompt "<creator's request, verbatim>"`** — to EVERY `bitmagic` command, `build`/`verify`/`dev`/`reload`/`publish` included. Never affects output; it is what counts the prompts shown on the game's public page.

Two things before you use them:

1. **Use them.** Generation is what the creator's Bitmagic Pro subscription is for, and these
   produce real, good-looking assets — a game that ships with placeholders because you were being
   careful is the worse outcome. The one rule: do not call them **in a loop** to explore options.
   Decide the prompt, ask for what you actually need, once.
2. **Each generation writes to `src/work/world.json`.** If you are also editing that file, re-read
   it afterwards — your in-memory copy is stale. The command prints exactly which paths it changed.

Three lanes make a 3D object, and the wrong one wastes a generation: `generate model` mints a NEW
asset, `generate prop --asset <id>` UPGRADES a placeholder, `assets add <file>` uploads your own.
Splats, video and `.vox`/`.fbx` still need the web editor; never reference an asset you did not
make. Which lane fits which NEED — rough sparks and minutes, and when to ask first — is
`.agents/skills/choosing-asset-pipelines/SKILL.md`; flags, reference-image rules and refusals, `.agents/skills/generating-assets/SKILL.md`. For local Blender rigging and repairs, read `.agents/skills/rigging-characters/SKILL.md`. For vision-led exposed-skin maps and material review, read `.agents/skills/character-skin-authoring/SKILL.md`.

## Forging a whole level

```
bitmagic forge --prompt "a ruined desert temple with a central courtyard"   # the level's SHAPE — a circuit, a dungeon, a slope — is forged, never painted onto the baseline in code
```

This designs a scene, builds its geometry, bakes it to voxels and writes the finished level —
terrain, props, spawn points — into `src/work/world.json`. `bitmagic levels list | add | rename
| set-start | remove` manages them afterwards (free, local; `set-start` picks the boot level). Add
`--city`, `--dungeon`, `--platformer`, `--freeform` or `--vessel` (a ship as the level) — at most
one — for a different kind of place; omit them all for natural terrain. A place designed part by
part — an interior, a station, a stylised set — can instead be scripted in Blender: `.agents/skills/building-levels-in-blender/SKILL.md`,
whose first section says when that path is yours (a frontier model — Claude Opus/Fable, GPT-6 class — with Blender 4.2+; any other model, or one not sure it is one, forges instead). All the level lanes side by side, with costs: `.agents/skills/choosing-asset-pipelines/SKILL.md`.

**Art style is a declared switch.** `"artStyle": "low-poly"` in `src/work/game.json` (or
`bitmagic init --art-style low-poly`) makes a Blender level a low-poly GAME: `cover`/`reference`
prompt for low-poly, `assets add` and `generate model|prop|character` keep meshes instead of
voxelizing, the engine drops its voxel lighting/bloom, `judge` knows the medium. Set it before the first cover.

Four things worth knowing:

1. **It is slow.** A forge runs for many minutes — the level bake alone can take twenty. Plan the
   run, start it, and do something else while it works; progress is printed throughout.
2. **It needs Google Chrome installed.** The bake runs in a real headless browser (voxelizing is
   engine code). It serves the project itself — no `bitmagic dev` needed, no collision with one.
3. **It rewrites large parts of `world.json`** (assets, objects, levels, spawns) — re-read it after.
4. **Resume rather than re-run.** It prints a job id, `world.json` only changes on the final step,
   and every failure says whether `bitmagic forge --resume <jobId>` is worth it — twenty minutes saved.

Afterwards actually walk the level in the dev view (already running, with the forge's progress in
it) — one that loads is not necessarily one you can move through.

## Updating the bitmagic CLI

```
bitmagic self-update
```

This project is on the **prod** environment (`environment` in `bitmagic.json`), and the command reads that pin itself.

**Never ask which line to install, never offer the choice, and never update with `npm i -g @bitmagic/cli`** —
`self-update` reinstalls into the exact place this CLI lives, using the node running it, which the `npm` on
your PATH may not be; under nvm it usually is not, and the install lands in another prefix while
`bitmagic --version` never moves. The lines are not interchangeable (`dev` and `local` take the prerelease
built against the dev api-server, `prod` the release), and the wrong one fails as opaque command errors
rather than version warnings — so run `self-update` before debugging a command that started failing
strangely. If `bitmagic.json` ever disagrees with this paragraph, the file is right. The engine is a
separate command: `bitmagic upgrade`.
