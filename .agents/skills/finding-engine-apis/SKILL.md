---
name: finding-engine-apis
description: Use when you need a Bitmagic engine API and do not know its exact name or signature — does class X have method Y, what parameters does it take, which engine system handles NPCs, HUD, vehicles, doors, multiplayer, collectibles or shaders. Also use when `bitmagic check` reports "Cannot find name", "Property does not exist", "has no exported member" or "Cannot find module" for an engine symbol.
---

# Finding an engine API

`engine/` is ~240,000 lines across ~780 files. It is documented; read the documentation instead.

## Tier 1 — the signature digest, first, always

`engine/agent-docs/engine-api/` holds a generated digest of the engine's entire public surface —
every class, method, function, interface and type, with signatures, bodies omitted, in the form
`Class.method(params): ReturnType`. `engine-api.md` is the index: it lists the 45 group docs and
every symbol each one contains.

```
rg -n "spawnAsset" engine/agent-docs/engine-api/                 # find a method
rg -n "class VehicleSpawner" engine/agent-docs/engine-api/       # find a class
rg -n "unlockAchievement|getSpawnPoints" engine/agent-docs/engine-api/   # several at once
```

One grep here replaces a dozen searches in `engine/`, and it answers the question you usually
actually have: *does this exist, and what does it take?* Each group doc keeps its
`## engine/<path>.ts` headers, so a hit also tells you which source file to open if you need more.

The digest is generated from the engine, so it cannot be wrong about a signature — and it
deliberately contains no prose. When you need to know how something is *meant* to be used, go to
tier 2.

## Tier 2 — the subsystem guides

~83 prose docs in `engine/agent-docs/`. Find the row, read the doc.

| What you are doing | Read |
|---|---|
| Coordinates, forward direction, yaw, rotation, lookAt, spawn offsets | `coordinate-system.md` |
| NPCs, enemies, creatures, companions, pets, followers | `npc-system.md` (routes to the four `npc-*` docs) |
| NPC looks — block vs highres GLB, recolouring, animation packs | `npc-appearance.md` |
| Changing a character's clothes/outfit AT RUNTIME — armour, uniform, costume swap | `character-outfits.md` |
| NPC combat and death — HP, damage, ragdoll, exploding | `npc-combat-death.md` |
| Respawning or bulk NPC populations, `NpcManager` | `npc-managers.md` |
| NPC pathing, walkable targets, navmesh cell size | `npc-navigation.md` |
| Four-legged animals | `animal-instructions.md` |
| Snakes and other legless creatures | `snake-instructions.md` |
| Controls and input — mobile buttons, joystick, touch-to-move, fire buttons, key/button parity | `control-system.md` |
| Combat — weapons, damage, hit detection | `combat-system.md` |
| Any win / lose / you-died / victory / time-up / game-over screen | `end-game.md` |
| Achievements and XP — `engine.unlockAchievement('<id>')` | `achievements.md` |
| HUD elements — bars, scores, counters, timers | `HUD_ELEMENTS.md` |
| HUD visual style and themes | `HUD_STYLE_GUIDE.md`, `HUD_THEMES.md` |
| Start screen — cover image, title, Play-button label | `START_SCREEN.md` |
| An opening cutscene or any full-screen video — `engine.playVideo` | `video-cutscenes.md` |
| Collectibles and interactables | `collectible-objects.md` |
| Placed scenery / `environmentObjects` — gameplay near props, harvesting, occupancy | `environment-objects.md` |
| Doors, locked gates, keycards | `doors-and-locks.md` |
| Custom voxel block types, block palettes, resolving block names | `custom-block-types.md` |
| Moving platforms, elevators, crushers, conveyors | `moving-platforms.md` |
| Multiplayer and networking | `networking-system.md` (routes to the six `multiplayer-*` docs) |
| Characters and animation | `character-system.md` |
| Playing custom motion clips — flips, kicks, punches | `animation-assets.md` |
| Using an uploaded animation as the player's run/idle | `locomotion-assignment.md` |
| Vehicles and driving | `vehicle-system.md`, `vehicle-ai.md` |
| A non-humanoid player — spacecraft, vehicle-only, custom controller | `custom-player.md` |
| Hiding / showing the player — i-frames, ghost mode, flicker | `player-visibility.md` |
| Spawning entities | `spawning-system.md` |
| Markers | `markers-system.md` |
| A top-down camera fitting the whole map | `topdown-fit-camera.md` |
| Save / load / checkpoints | `persistence-system.md` |
| Leaderboards, submitted scores, shared non-realtime data | `game-data-service.md` |
| Persistent shared multiplayer state, mini-MMO | `world-persistence.md` |
| JSON config assets | `json-assets.md` |
| Custom images via CSS `background-image` or `<img>` — must go through `resolveAssetUrl` | `image-assets.md` |
| Writing text onto a model's texture — jersey numbers, decals | `texture-text.md` |
| Audio playback | `audio-system.md`, `audio-assets.md` |
| Runtime AI — text, vision, image generation inside the game | `ai-service.md` |
| NPCs that judge a situation — a decision model answering typed questions with probabilities, on a tick | `decision-ai.md` (and the `deciding-with-a-model` skill) |
| Voice input, speech-to-text, push-to-talk | `voice-input.md` |
| Physics and Three.js | `physics-best-practices.md` |
| Custom shaders and materials (WebGPU and WebGL paths both required) | `custom-shaders.md` |
| Lighting — many lamps, dynamic lights, WebGPU stutter | `lighting-best-practices.md` |
| Performance | `performance-best-practices.md` |
| Terrain foliage, ground cover, voxel terrain | `voxel-terrain-foliage.md` |
| Mining and block breaking | `voxel-mining.md` |
| Multiple levels, level select, switching worlds at runtime | `level-system.md` |
| Skyboxes | `skybox-system.md` |
| Visual effects — playback, explosions, lightning, beams, fire, shields, trails | `visual-effects.md` |
| Adapt effects, compose abilities, author a new procedural effect in game code | `visual-effect-authoring.md` (recipe overrides, `custom()`, compiled samples) |
| Weather and snow | `weather-snow.md` |
| 2D side-view games — the forged strip level, its `worldForgerSideon` contract, collect/respawn/goal wiring | `sideon-forged-levels.md` |

`engine/agent-docs/samples/` holds compile-checked reference implementations — a doc that cites
`samples/raycast-ground-check` means `engine/agent-docs/samples/raycast-ground-check.ts`, and it
compiles against this engine.

## Tier 3 — the source

Only for an implementation detail a signature and a guide cannot answer. Search, do not browse:
`rg -n "class VoxelObject" engine/`, narrowed with a path. Never read a large engine file end to
end.

## Two conventions in the docs

These docs are shared with Bitmagic's hosted agent, so two things read oddly here:

- **`@docs foo.md` means `engine/agent-docs/foo.md`.** Just read the file.
- **Tools that do not exist here.** Where a doc says to run `node bin/voxel.mjs` or
  `bin/world-edit.mjs`, or to call `configure_game`, `generate_character`,
  `manage-achievements` or `runWorldForger`, those belong to the hosted agent. Your equivalents:

  | The doc says | You do |
  |---|---|
  | `configure_game`, `manage-achievements`, `manage-levels`, `spawnpoint upsert` | edit `src/work/world.json` directly |
  | `node bin/voxel.mjs` / `bin/world-edit.mjs` | edit `src/work/world.json` directly |
  | `generate_character`, `design-vehicle`, `generateBlockTypeTool`, `backgroundImageGenerationTool`, skybox/sound/image/animation generation | `bitmagic generate <type>` |
  | `runWorldForger` / `run-world-forger` | `bitmagic forge` |

  Everything else in the doc — the engine APIs, the world.json shape, the gotchas — still applies.

## Controls: one API, both platforms

The one lookup worth doing before you write any input code, because getting it wrong compiles,
runs, and ships a control no phone can reach.

- `PlayerController.registerCustomAction({ action, desktop: { keys }, mobile: { label, behavior } })`
  — binds the desktop key and creates the mobile button atomically. **Throws** without `mobile`.
- `declareMobileActions(): MobileActionSpec[]` on the genre's Game class — the declarative form,
  run before game systems initialize. `MobileActionSpec` (`engine/MobileActionSpec.js`):
  `action`, `desktopKeys`, `iconKey`, `label`, `behavior: 'tap' | 'continuous'`, `preferredSlot`.
- Both write `playerController.keys.<action>`, so the gameplay code reads one flag either way.
- `playerController.verifyMobileParity()` runs at game start and reports gaps as a
  `[mobile-parity]` console error. It only sees keys registered through the engine — a raw
  `document.addEventListener('keydown', …)` is invisible to it, which is why that pattern and
  `desktopControls.registerKeyHandler()` are both banned for gameplay actions.

Full reference, including the nine button slots and the built-in icon keys:
`engine/agent-docs/control-system.md`.

## The two rules that keep this cheap

**Stop searching, start writing.** Do not pre-verify every API you plan to touch. Once you know
roughly what exists, write the implementation and run `bitmagic check` — compiler errors are
cheaper and more precise than more searching. If two searches for the same concept return nothing
new, the concept does not exist under that name: check the digest index or move on.

**A symbol error is a lookup, not a retry.** When `bitmagic check` says `Cannot find name X`,
`Property X does not exist on type Y`, `has no exported member X` or `Cannot find module`, the
name is wrong and your recall is wrong. That is not a type mismatch. Grep
`engine/agent-docs/engine-api/` for the real name — or confirm it is gone and delete the call —
**before** your next edit. Do not re-edit from memory, do not churn the import path, and above all
do not widen the type, cast, or add `?.` to make a wrong name compile: that ships a feature that
type-checks and silently never runs.

**Batch it.** Issue independent greps and reads in one turn, not one per turn.

## What the docs do not cover

Your own game, `src/work/`. And `world.json` — its shape is documented per-feature in the guides
above, but the file itself is shared with the human, who may be dragging objects in the editor while
you work. Re-read it before editing it.
