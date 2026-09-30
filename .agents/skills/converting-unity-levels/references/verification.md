# Verifying a conversion: what counts as evidence

The order of trust, highest first: a gameplay frame you took yourself → a top-down render next to
the Unity editor → counts and extents from the data → `bitmagic verify` → a typecheck. During the
port this skill comes from, three "fixes" were presented on the strength of the bottom three and
none had reached the creator's screen.

## Data checks

- **Census** (see `unity-scene-traps.md`): per-prefab instance counts, group transforms, inactive
  and overridden instances, renderer families with extents.
- **Collider map**: draw every solid 2D collider (oriented boxes, circles, sliced walls) and the
  spawns as a PNG; a ring with a missing side or a strip in the middle is obvious at a glance.
- **Reachability flood**: rasterise the wall bounds (plus the arena boundary) at 0.25 units,
  inflate by the ship radius, flood-fill from every spawn, and report the reachable fraction per
  spawn. Every spawn must reach the same region; a spawn "IN WALL" or a 31 % / 69 % split means a
  sealed arena. A level that only becomes coherent after adding or removing a wall is telling you
  the scene differs from your reading — go back to the census.
- **GLB inventory**: Blender lists objects by name family with extents (`Tunnel 52 where Unity has
  56`, `Staircase 0`) — the fastest way to see what the visual walker dropped.

## Renders

```
blender -b --python tools/render_topdown.py -- build/glb/<scene>.glb .bitmagic/topdown.png
```

Orthographic, whole arena; crop a corner or the centre when the question is local. Put it beside
the creator's Unity screenshot; that comparison found the missing left bar, the empty corners and
the tiny statue. Billboard textures may read mirrored in the render — cosmetic.

## In the running game (the browser pane)

Open `http://localhost:<gamePort>/` (from `.bitmagic/dev.json`). Then:

- The pre-match menus must be clicked through: game mode, opponents, Launch. At 800×450 the
  buttons sat at (400, 264), (352, 302), (400, 325); take a screenshot first — coordinate clicks
  need one — and re-check positions if the HUD changes.
- Shader warm-up after a cold reload takes 2–3 minutes in the pane. `computer.wait` caps at
  10 s; chain several.
- The engine is reachable as `window.gameTemplate.getGameEngine()`: `.scene` (traverse for lights
  and meshes), `.renderer` (shadow map state), `.directionalLight`, `.currentLightingConfig`,
  `.genreModule` (this game's module: `.player.body.setTranslation({x, y}, true)` teleports the
  ship next to whatever needs looking at; `.started` / `.phase` say whether the match runs).
- A/B toggles beat reasoning: switch `castShadow` off on the ship lights and screenshot; set an
  intensity to 100 and screenshot. Two frames settled in minutes what probes could not.

## Two ways a change fails to reach the screen

1. **The dev server serves a stale module.** `bitmagic dev` serves `/dist/src/work/*.js` (tsc
   watch output). It kept serving a 4,579-byte copy of `VisibilityLight.js` after the file on disk
   was 5,132 bytes with new constants — even to `fetch(..., {cache: 'reload'})`, so forced page
   reloads and `bitmagic reload` still ran old code. Check with
   `curl localhost:<port>/dist/src/work/<File>.js | grep <constant>`; if stale, restart the dev
   server (`kill $(jq .pid .bitmagic/dev.json)`, then `bitmagic dev --port … --editor-port …` in
   the background) and force-navigate. Never touch a port another project's dev server owns.
2. **Verify passed on fallback geometry.** During a network drop the arena GLB failed to fetch and
   the game kept procedural stand-ins; verify still passed. Grep the verify console for
   `arena model failed to load` and for your own `[Game] loaded` line
   (`grep -q "\[YourGame\] loaded" .bitmagic/verify/console.log`) before trusting a screenshot.

## Presenting

Say what was measured, with the number, and what was only inferred. If the creator is the judge
of a look (brightness, size, "large"), give them the single knob and its range rather than a
value dressed up as a restoration.
