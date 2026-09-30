# Source contracts and native runtime

Inventory reachable code and data from `Game.ts`, `game.json`, `world.json`, imported JSON,
asset registries, audio banks, procedural geometry and engine calls. Classify unused experiments
separately; a cinematic mesh is not automatically the ordinary crowd model. Do not execute
arbitrary source to discover assets. If runtime extraction is necessary, use an explicitly scoped
capture with controlled networking/side effects and retain the extraction recipe.

Each feature contract records:

- Stable ID; source files and enclosing symbols; source input hash.
- Enter/exit state transitions, input gates, pause/cleanup, camera and audio owners.
- Numeric rules: costs, unlocks, cooldowns, targeting, damage shapes, waves, rewards, loss conditions.
- Presentation: model variants, animation events, UI behavior, voice/subtitle cues, VFX.
- Native strategy and dependencies; fidelity category and intentional deviations.
- A test with explicit inputs and expected outputs/events; independent verification evidence.

Preserve all chapters and tutorial stages, not just an initial playable slice. A result flow that
returns to the map, selects the next chapter, and waits for the player differs from automatically
starting the next chapter. Session carry-over differs from account progress after rejoining.

## Translation

Extract tables mechanically. Native Luau is a semantic rewrite for browser/Bitmagic APIs, not
syntax substitution. Explicitly account for zero/one-based indexes, JavaScript truthiness,
`undefined`/`null`, Maps/Sets, class initialization, promises, timers and event lifetimes.
`roblox-ts` cannot provide Three.js, WebGL, DOM/CSS, browser audio or Bitmagic runtime bindings.
Unknown engine calls become conversion work, not empty stubs or swallowed exceptions.

Use modules with distinct rules, presentation and platform integrations. Stable local events
such as phase changes, volleys, splash/piercing hits, resource changes and tutorials can connect
them without becoming network remotes. Preserve event order and single consumption. Keep deliberate
Roblox extensions in `overrides/` or explicit hooks, with source mappings to the original contract.

## Authority

For a private single-player simulation, local input, placement preview, camera, rules and visuals
can remain local. Shared world state and consequential multiplayer outcomes need server authority.
Purchases, ownership and trusted currencies/rewards always need their appropriate server checks.
Do not grant trusted rewards from client-reported victories. Choose and document a persistence
trust policy; serializing a client payload does not establish integrity.

Existing target commerce stays intact. Do not add commerce, ads, ownership claims or receipts just
because a source game is being ported. Preserve coordinated receipt handling and deduplication.

## Coordinates, UI and performance

Use an asymmetric calibration object, floor, forward arrow and known footprint to establish a
source-to-target basis and scale. Transform normals, winding, negative scales, pivots, animation,
projectile sockets, ranges, movement and camera distances consistently. Test gameplay facing
separately from camera facing. One source unit is not automatically one stud.

Map UI intent into native GUI controls, including portraits/icons, safe areas, scrolling,
controller focus where needed, readable text and touch confirmation. Check the world space left
visible for placement. Combat should hide construction UI when the contract requires it.
Use one camera owner per phase and hand over from the rendered pose without snapping/resetting.

Pool transient visuals/audio, bound overlap and allocations, and separate simulation scheduling
from rendering. Avoid per-enemy scripts, physics bodies and pathfinding for crowds unless required.
Keep render-step work narrow. Measure before reducing visible density; sampling a small stable
subset is a disclosed fidelity compromise, not a proven platform limit. Record dropped simulation
time separately from rendering FPS. Never ship the case study's numeric budgets as universal rules.

Official references, consulted as needed:

- [Client/server runtime](https://create.roblox.com/docs/projects/client-server).
- [Task scheduler](https://create.roblox.com/docs/performance-optimization/microprofiler/task-scheduler).
- [Bitmagic coordinate conventions](../../../../engine/agent-docs/coordinate-system.md) when available in the source project; otherwise read its installed engine documentation directly.
