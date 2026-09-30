# World GLB Forge — generated terrain levels

`runWorldForger` (the World-Forger) turns a text description into a complete voxelized terrain
level. It is an orchestrator-level delegation tool that runs a deterministic five-step pipeline
(design → forge+upload → create objects → bake → place & save) as its own parallel branch — each
step streams its own progress. An AI designer composes a scene (heightfield terrain, spline
paths, primitive props, scattered vegetation, markers), a deterministic builder produces a
multi-object GLB, the engine bakes it into the world's `.vwld` level, and the result is installed:
the asset record lands in `assets[]`, `voxelUrl` switches to the new level, and
`playerSpawnPosition` moves to the designed start point.

## Object model — terrain is baked, objects are library assets

Only terrain and movement surfaces are baked into the level (0.125 m voxels). Every prop and
vegetation archetype (cabin, pine tree, rock) becomes its OWN asset in the library, voxelized
at fine 0.0625 m detail, and is placed as environment-object instances at the designed spots.
The world GLB still contains the objects as tagged placeholder groups, which the bake skips.

This is what makes objects upgradeable after the fact: "create a high quality version of the
cabin" = generate a new model with `generate-glb-asset` under the cabin's existing asset
(same id), and every placed instance upgrades — no level re-bake. The tool reports each
created library asset (`library_assets`: name, asset id, instance count) for exactly this.

**Materials are automatic, in both halves of that split.** The designer authors a
`materialClass` next to the colours it already authors (terrain colour rules, structure
parts, paths, dungeon materials — 'stone' for rock slopes, 'wood' for hut walls; omitted =
matte), and the bake writes them into the level as a per-colour map (`materialByColor`,
the class sibling of `emissiveByColor`) so rocky cliffs shade on the stone tier and metal
accents reflect. At most 3 non-matte classes per level; overflow collapses (gold→metal).
The archetype library assets get the same map at their own bake: each authored colour
claims the baked colour group it lands in and the class is written as the asset's material
slot (plated bulkheads, doorway surrounds and stair treads shade as metal from the first
frame). Only an archetype the map could not class is handed to the automatic classifier
every generated asset uses — do not set materials by hand.

## When to use it

- The request is for the WHOLE ground the game is played on: "a ski slope", "a mountain race
  track", "an island with a winding coastal road", "a canyon with a river of ice".
- The terrain needs smooth physics: movement surfaces (runs, roads, tracks) are voxel-rendered
  but carry exact trimesh colliders and smooth-surface voxel displacement, so skiing, driving
  and walking are bump-free.

- The level is an ENCLOSED INTERIOR (see Dungeons below) — the forger is the only way to get
  roofed rooms with doors, locks and a navmesh.

Not for placing an object on the existing terrain (`generate-glb-asset` /
`create-voxel-asset`), not for using an already-uploaded asset as the map (`set-map-asset`),
and not for small terrain tweaks.

## Inputs

- `name` — level name (snake_case identifier).
- `prompt` — the world description. Include terrain character, the player's route (where they
  ski/drive/walk), landmarks, vegetation, and atmosphere. Richer prompts produce richer levels.
- `sizeX` / `sizeZ` — optional footprint in meters (32–1024; designer picks otherwise). A long run
  should be LONG on one axis (up to 1024 — e.g. a 1 km descent) and THIN on the other (~200–256);
  the terrain auto-coarsens far from the path so a big level still loads.
- `assetId` — the manifest id; always pass it when the manifest provides one.
- `referenceImageUrl` / `useReferenceImage` — the accepted concept image of the world (a URL, or
  the image the user attached to their prompt). The designer is shown it as authoritative for
  setting and look; the text still decides layout and gameplay. See "Reference match" below.
  In the Creator a game's ACCEPTED reference image (game.json `referenceImage`, set from the
  Reference button beside the prompt box) applies automatically when neither is passed;
  `ignoreGameReference: true` forges from text alone for that one call.
- `referenceMatchRounds` — 0-3, default 2: how many revision rounds the forger spends iterating
  the design toward the reference image. 0 designs once and skips the comparison.

## What you get back

- `player_start` — world coordinates of the designed spawn (already applied to
  `playerSpawnPosition`).
- `markers` — named world-space gameplay anchors the designer placed (e.g. FinishLine,
  Checkpoint1). Report these in your summary so the coding subagent can build game logic at
  those exact coordinates. They are also persisted on the asset record under
  `worldForgerMarkers`.

### Reading the handoff data back from game code

For features, use the engine's lookup rather than walking `gameData.assets` yourself — it is
typed against the real `Asset`, folds case (designer casing drifts between forges), and returns
`null` on a miss instead of throwing:

```typescript
import { findForgedFeature, forgedPathFeature, forgedFeatures } from 'engine/ForgedLevelData.js';

const gate = findForgedFeature(this.engine.getGameData?.(), { kind: 'checkpointGate' });
const route = gate?.points?.length ? gate.points : forgedPathFeature(this.engine.getGameData?.())?.points;
const autoBuilt = forgedFeatures(this.engine.getGameData?.()).filter(f => f.params?.engineAutoBuild === true);
```

A forged **city** also carries `worldForgerStreetGraph` — its street network in world space
(junction nodes + road segments with widths). Read it with `forgedStreetGraph(gameData)` from the
same module; it is what NPC traffic and street routing build lanes from.

`worldForgerMarkers`, `worldForgerFeatures` and `worldForgerStreetGraph` are typed on `Asset`
(`types/game.js` — `ForgedLevelMarkers`, `ForgedLevelFeature`, `ForgedStreetGraph`). **Use those types.** Re-declaring the shape
locally and casting `gameData.assets as MyForgedAsset[]` compiles against your guess, so a
wrong guess survives the type check and crashes at load with `x.find is not a function`.

Three things are routinely guessed wrong:

- `worldForgerMarkers` is an **object, not an array**, and named markers carry their
  coordinates **flat** — there is no `position` sub-object:
  ```ts
  { playerStart: { x, y, z },
    named: [ { name: 'FinishLine', x, y, z }, { name: 'Checkpoint_1', x, y, z } ] }
  ```
  `playerStart` is the spawn (already applied to `playerSpawnPosition`) and is NOT repeated
  in `named`.
- `worldForgerFeatures` **is** an array, but a feature that marks a *site* rather than a
  *route* (`skiLift`, `door`, `checkpointGate`, `timedRun`, `trickScoring`) has an **empty
  `points`** and locates itself through `anchors`/`params`. Only `path`/`spine` are reliably
  polylines — so `features.find(f => f.kind === 'path')?.points` can legitimately be `[]` on
  a level that does have gameplay features. Select by `kind`/`name`, never by index.
- Those `kind` and `name` strings are **written by the designer on every forge**, not drawn
  from a fixed vocabulary — the same snowboarding prompt produced a `timeTrial` named
  `SlalomTimeTrial` one night and a differently named gate feature the next. So selecting by
  name is right, but **treating the match as a precondition is not**: `findForgedFeature`
  returning `null` is a normal outcome to degrade through — skip the mechanic, or fall back to
  `forgedPathFeature`, which every designed path emits — never `throw`. A throw in a
  constructor or `load()` is the one failure mode nothing catches: it passes the type check,
  passes the wiring check, and the player gets a black screen. This is the same rule the forge
  holds itself to; see
  ["The forge degrades; it never discards"](#the-forge-degrades-it-never-discards) below.

Call `inspect_world_json(query: "forge")` to see the actual values for the current game
before writing the code — `query: "summary"` does not include markers or features.

The engine's declaration is a hand-written mirror of what the forger writes (the forger is a
published package and cannot import `game/src`). `shared/world-forger`'s
`forger-handoff-contract.test.ts` is what keeps them honest: it runs the one function that
produces the payload (`forgerHandoffFields`) against the JSON schema generated from
`types/game.ts`, failing on a changed shape AND on a field written but never declared. If you
add a field to the handoff, add it to `ForgedLevelFeature` / `ForgedLevelMarkers` too — the
test will tell you, and until you do, no game code can see it.
- `asset_url` (the baked `.vwld`) and `glb_url` (the source GLB; the creator's Re-voxelize
  button uses it).
- `library_assets` — the created object assets (name, asset id, instance count). Mention them
  in your summary so later prompts can upgrade them individually.

The asset record also stores `worldForgerSpec` — the full validated scene design — so a future
request can adjust the design instead of starting over.

The world GLB embeds its own voxelization parameters (level size, voxel sizes, per-object
options) in the scene extras — GLB carries no real-world scale, so the authoring tool defines
the size and it travels inside the file. Manual re-import through the creator's Assets tab
pre-fills from it automatically.

## Dungeons — enclosed interiors

An interior request (dungeon, crypt, catacombs, cave system, mine, sewer, tomb, temple interior,
bunker, spaceship interior) routes to the forger's DUNGEON approach — the only one that builds
roofed rooms. The designer emits a MISSION GRAPH (rooms with roles and elevation bands, typed
edges: open / door / locked+key / stairs / shaft / secret) validated for key-before-lock
reachability; a deterministic expander turns it into rooms, corridors, stair flights and shafts
hanging below a flat terrain plate. Schema: `dungeon/dungeon-spec.ts`.

What lands beyond the usual level + library assets:

- `worldProfileData.doors[]` and `keyItems[]`, scoped to the forged level's `levelId`. Door
  behavior is ENGINE-NATIVE (`DoorSystem`: proximity auto-open, locks that block pathing, the
  shared Keyring) — do NOT write door code. Each door references a baked leaf asset and each key
  its own pickup asset; game code only reacts to them (a boss gate, a cutscene, a score).
  A re-forge REPLACES that level's doors/keyItems — hand-authored entries on the forged level are
  wiped, exactly as its placed instances are. Other levels' entries are untouched.
- A navmesh sidecar on the level asset (`navUrl`), installed at level load, so NPC pathing works
  inside the dungeon from the first frame.
- Emissive materials: colors the plan marked emissive glow in the baked level and in the fixture /
  key / door assets at zero light-budget cost. Light fixtures carry an `assets[].light` payload,
  so every placed torch/brazier/crystal emits.
- Door style follows the theme. A plan may name ONE leaf for every door (`doorStyle`: `plank`
  hinged planks, `portcullis` sliding bars, `crystal` a dissolving slab, `bulkhead` a riveted
  metal panel sliding into the wall, with key cards for its locks); without one, the masonry rule
  picks per door (planks; a portcullis at a grand room; crystal at a cave), and metal walls imply
  bulkhead. A ship in space always gets bulkhead doors and an electric `lamp` fixture — the
  builder replaces plank doors and burning fixtures there with a note.
- Level `overrides` with a dark `lightingConfig` + close `fogConfig`, so the level reads as an
  interior instead of a daylit box.
- A `dungeonProgression` gameplay feature: the mission's rooms, locks and keys as a manifest for
  the coding subagent to build encounters and objectives against.
- Carved masonry on every built room and corridor: walls, floors and ceilings are clad in a
  procedurally generated stone kit cut from the plan's own materials and pattern, so a crypt reads
  as mortared granite courses and an alien hive as faceted crystal, from the same generator. The
  kit is built ONCE per forge and instanced everywhere, so it costs a handful of library assets
  rather than one per room. Cave rooms keep their free-form rock. Nothing to ask for and nothing
  to configure — it follows the materials the design already chose.
- Accent walls: a room may have ONE wall clad in a material of its own, either as a solid sheet or
  as panels inlaid into the shared stone. Ask in plain language ("its reliquary's far wall is a
  sheet of beaten gold") and the designer picks the rooms and the style while the generator picks
  the wall. Rare by design — it reads as a feature only while most walls share one material.

A material the plan declares but no surface ever uses is reported as a forge note naming it, so a
colour that went nowhere says so instead of vanishing.

## Vessels — a ship as the level

A request where the whole playable ground is one ship — "on a longship crossing a grey sea",
"the deck of a pirate galleon", "a cargo barge drifting through space" — routes to the forger's
VESSEL approach (override: `vesselMode`, CLI `--vessel`). The designer emits the NUMBERS a hull
is described by (length, beam, depth, freeboard, sheer, bow/stern rake and shape, fullness,
plank style) plus a deck, masts and sails, rowing thwarts and named fixtures; a deterministic
builder LOFTS a real curved hull from them (not primitive boxes), lays the deck, and measures
the level around the ship: the sea plane at the waterline, a seabed under the keel, a footprint
with open water round the hull, and a spawn ON THE DECK facing the bow. Schema:
`vessel/vessel-spec.ts`; builder `vessel/hull-loft.ts` + `vessel/vessel-expand.ts`.

What is different from a landscape level:

- The terrain is the SEABED (or, in space / in the sky, an invisible collision-only catch plate
  far below the hull). `terrainHeightGrid` therefore describes the sea floor — anything placed on
  the ship after the forge belongs at the deck's height, which the `vesselDeck` gameplay feature
  carries: the walkable outline in world space with its Y, plus `floorY`, `bow`, `stern`, length,
  beam and heading. Named markers `Bow`, `Stern`, `DeckCentre` and `Mast1`… are minted too.
- To make the ship SAIL — a moving sea, a helm that swings the horizon — keep the hull where it
  is and read `@docs mechanic-sailing.md`: `forgedVesselFrame` reads exactly this feature.
- The hull bakes as level geometry (`Hull`, voxel collider) and the deck as a smooth, LOD-pinned
  trimesh (`Deck`). Masts, thwarts and fixtures are library assets with an art brief, so they can be
  regenerated in HQ like any prop. The hull itself is not replaceable — it is the level.
- Two builds. `build: "openHull"` is the deck: hold, gunwales, open sky. `build: "roomsInHull"`
  is the INSIDE of a ship — a spaceship's decks, a submarine — where the hull is a closed double
  skin and the level is the spec's `dungeon` block (the same mission graph, doors, locks, keys,
  kit and navmesh as the dungeon approach) laid out inside the hull's cavity. The hull is the
  dungeon embedder's envelope (`vessel/hull-envelope.ts`), so rooms never pierce the skin; rooms in
  a ship stand in a LINE along the hull, and the builder repairs a hull too small for its rooms
  (deeper, wider, longer, with a note) and shrinks rooms the beam cannot hold. The spawn is the
  dungeon's entrance-room spawn; the handoff is a `vesselHull` feature (the interior outline at the
  entrance storey's floor) plus the dungeon's own features. No sea: rooms would sit under it, so a
  sea environment is rebuilt as sky. `vessel.viewports` cuts REAL windows: through the room wall
  (a `layout.windows` opening the shell cuts and the cladding avoids) and through the hull skin
  (a stitched loft cutout), on every room wall that faces the outside; the collider is built
  without the wall hole, so the pane is invisible and solid.
- `environment: "space"` also sets dark fog + a hard sun on the level and emits a `skybox`
  gameplay feature asking for a starfield panorama: the forge cannot make images, so generate one
  with the skybox tool and set it as that level's `skyboxUrl` (`levels[].overrides.skyboxUrl`).
- The reference-match loop runs for vessels (unlike dungeons); open sea or space in the reference
  is judged as the setting, and the ship as the architecture.

## Gameplay features — the level declares, game code implements

A level can only bake static geometry. Anything that MOVES or reacts — a ski lift ride, an
elevator, a door, a teleporter — comes back as `gameplay_features`: each entry has a `kind`,
a plain-language `description`, and `anchors` resolved to world coordinates (the placed
towers, stations, markers). Cross-object static geometry (the lift CABLE hung through the
towers) is already baked by the tool; the feature entry is the contract for the runtime
behavior. Report features verbatim so the coding subagent implements each one with engine
systems (moving platforms, doors-and-locks). They are also persisted on the level asset as
`worldForgerFeatures` and embedded in the GLB extras (`bmGameplayFeatures`), so the intent
survives re-imports and later edit sessions.

### Path features — the level's intended flow

Every designed path also comes back as a `kind: "path"` feature: the course the designer
intends the player to travel, as ordered world-space control points (dense through sharp
turns, at most ~8 m apart on straights) plus `start`, `finish`, `checkpoints[]` (each with a
`t` arc-length fraction), `widthM`, `closed`, `lengthM`, and `surfaceObjectName` (the ribbon's
queryable trimesh name, when present). The points run in the intended direction of travel.
This is the authoritative source for the path — use it for race/run timers, resetting a fallen
player onto the track, AI opponents, progress %, minimaps. Do NOT re-derive a line from baked
geometry when a path feature exists. The full arrays live on the level asset record
(`worldForgerFeatures`); the tool's summary lists counts and endpoints only.

## The forge degrades; it never discards

A content problem — a room that will not fit, an edge that will not route, a prop standing on the
travel path, a cladding module that will not bake — drops, shrinks or relocates that PIECE and
reports it in the summary's Notes. It never fails the level: a forge costs real money and several
minutes, and a dungeon of 19 rooms beats no dungeon at all. The `throw`s that legitimately remain
are infrastructure (no bucket, no browser, corrupt bytes) or provably unreachable, and each one is
listed with its reason in `world-forger/__tests__/no-level-killing-throws.test.ts`, which fails
until a new one is classified.

## Reference match — the design iterates toward the picture

The reference is whichever applies first: the `referenceImageUrl` passed to the tool, the image
attached to the prompt when `useReferenceImage` is set, or the game's accepted reference image
(in the Creator, the one accepted from the Reference dialog; in the CLI, `bitmagic reference
accept`). `ignoreGameReference` drops the last of those.

With a reference image the design step does not stop at one design. The forger builds the
candidate's geometry, renders it (a flat-shaded software preview: an establishing shot and the
view from the player start), has a vision critic compare the renders with the reference across six
aspects (terrain shape, palette, water, vegetation, architecture, atmosphere), and asks the
designer for a revised design that closes the named gaps while keeping the layout. The best-scoring
design ships. It stops on a match of 7.5/10 or better, when a revision fails to improve on the best
by half a point, when the rounds are used up, or when the step's time budget would not fit another
design call. Dungeons skip it (an interior has no exterior to compare). Each round is a full design
call, so a forge with a reference takes a few minutes longer than one without.

The outcome is a note on the level ("Reference match: 6.8/10 after 1 revision (stopped: no further
improvement). Remaining gaps: …") with links to the preview renders the critic saw, and every round
is a progress line while it runs. Nothing in the loop can fail the forge: a render that cannot be
built, a critic that will not answer or a revision that will not parse all degrade to shipping the
best design so far, with a note saying so.

## Editing a forged level

A forged level keeps its validated design (`worldForgerSpec`) and the job that built it
(`worldForgerJobId`) on its level asset, so a detail can be changed without designing and baking
the world again. In the Creator the orchestrator calls `editForgedLevel` with the level's vwld asset
id and the change; on the CLI it is `bitmagic forge --edit "make the doors sliding bulkheads"
[--level <id|name>]`.

The change goes to the designer as one small call that returns a handful of JSON-pointer edits to
the stored design — a fraction of a design's cost — and the level is then re-expanded from the
edited design, deterministically, under a new job. What that run re-makes is decided by comparing
content signatures with the original, object by object; everything else is reused:

| The change touches | What is re-made |
|---|---|
| `dungeon.doorStyle` | the door leaves and the key pickups |
| `dungeon.lightFixture` (kind, colour, flicker) | the fixtures |
| a `prop` / `wallDecor` kit piece | that piece |
| a material colour, a `wall`/`floor`/`ceiling`/`doorway` kit piece, rooms, edges, `vessel.viewports`, terrain | the level bake and most objects |

The level is replaced in place: same level id, doors, key items, placed instances and
`worldForgerSpec` rewritten wholesale, other levels untouched. Objects the creator regenerated
in high quality since are kept (their asset records are never rewritten). The level's `seed`,
`size` and `name` are not editable — the seed is what keeps the untouched parts identical.

It needs the parent's bakes, which both lanes keep server-side (the CLI mirrors the records its
browser steps write, so an edit works from any machine). A level forged before the forger
recorded signatures reuses only its design; a level whose record names no job cannot be edited
and is re-forged once. Side-on (2D) levels cannot be edited yet.

## Constraints

- LEVEL-SCOPED writes (multi-level registry, `worldProfileData.levels`): a forge targets a
  LEVEL, and the `assetId` input decides which. A fresh manifest id ADDS a new level (on a
  game's FIRST forge the new level becomes the start level and the previous world converts
  to level 1 keeping its placed objects — see `@docs level-system.md`; later forges keep the
  current start unless the user asks — pass `makeStartLevel` to express that intent either
  way). Passing an EXISTING level's `vwldAssetId`
  (manage-levels action="list") RE-FORGES that level in place: only its terrain + instances
  are replaced. "Replace the city with X" = re-forge with that level's asset id; to instead
  retire a level after adding its successor, delete it via manage-levels. The designer receives the game's ASSET
  CATALOG and reuses matching library assets (HQ regenerations, user imports) via
  `reuseAssetId` instead of minting new placeholders, and orphaned placeholders from prior
  forges are purged (HQ/user assets never). Only a legacy game whose current world is not a
  registered vwld asset still gets the old whole-world replace — confirm intent there when
  the task is ambiguous about losing the existing world.
- Takes several minutes end to end (AI design, then a chunk-by-chunk bake in the editor's
  browser). The editor must be open; if no browser is connected the tool fails with a clear
  message and the uploaded GLB can be voxelized manually from the Assets tab.
- If a call fails partway it returns a `job_id`; call `runWorldForger` again with `resumeJobId`
  set to that id to resume from the failed step without re-running the steps that succeeded
  (e.g. skip a completed 20-minute bake).
- One call per request otherwise. If the result needs a DETAIL changed — a door style, the
  light fixtures, a prop, a material colour — edit the level (see "Editing a forged level")
  instead of forging again; a layout change is a focused follow-up forge with a refined prompt,
  never repeated attempts.
- Audio, water volumes and caves are not part of the generated scenes (water is always one
  horizontal plane — a vessel's sea included).
