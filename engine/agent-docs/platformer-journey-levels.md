# Consuming a forged PLATFORMER JOURNEY level

A platformer-journey level (Mario Odyssey–style) is forged by the world-forger from a
`platformerJourney` plan. It **desugars** into ordinary baked geometry (region terrain +
box-prop platforms placed reach-correctly along a golden-path spine) plus three handoff
artifacts on the level record / `gameData` that **you, the coding agent, must wire up**. The
geometry is already correct; your job is the gameplay the geometry alone cannot encode.

The forge guarantees: *if the character moves with the level's movement contract, the spine is
completable and every required collectible is reachable.* So applying the contract is mandatory.

## 1. The movement contract (engine-applied — do NOT override)

`worldForgerMovement.effective` (on the level asset record) is the kit the level was validated
for. **The ENGINE adopts it automatically** (PlayerController reads it at construction and
re-asserts it after your build, compensating jump-apex semantics) — do NOT construct a movement
system for it or call `setMoveSpeed` with other values; the level's platform spacing was solved
for exactly these numbers. Your job is only the listed `abilities` (wallJump, glide, pounce, …)
the base engine doesn't cover — implement those so the segments that expect them are clearable.

## 2. Follow the route (progression / camera / checkpoints)

`worldForgerFeatures` carries the route twice, at two resolutions:

- `{ kind: 'path', name: 'GoldenTrail', points[], widthM, lengthM, checkpoints }` — the DENSE
  walkable trail polyline (world-space, `points[].y` = the baked route floor). This is the path
  the player actually follows, including winding bends and spiral ascents. Use it whenever a
  position "on the route" matters (§5b).
- `{ kind: 'spine', points[], params }` — the COARSE region-to-region route.
  `params.segmentKinds[]` are the per-hop verbs (run/jump/climb/passGate/…) and
  `params.checkpoints[]` are segment indices flagged for a checkpoint. Use it for progress %,
  the "next objective" indicator, camera look-ahead, and ordering checkpoints forward.

Markers `PlayerStart`, `Goal`, and `Checkpoint_*` are in `worldForgerMarkers` — an **object**
`{ playerStart: {x,y,z}, named: [{ name, x, y, z }] }`, not an array, with flat coordinates on
each named marker. Read it through the `ForgedLevelMarkers` type on `Asset` rather than a local
re-declaration; see `@docs world-glb-forge.md` ("Reading the handoff data back from game code").

## 3. Place collectibles (oversupplied → select N)

Feature `{ kind: 'collectibleSpawns', points[], params: { budget, candidates[] } }`. `points[i]`
is the world position of `candidates[i]` (`{ id, type, intent, difficulty, group, optional }`).
Collectibles are **NOT baked into the level** — these are spawn-position placeholders (like trees),
so this step is what makes them exist at all. The pool is **oversupplied** — choose `budget` of them
with intent balance using the shared selector, then add them as collectible environment objects
(runtime-spawned, swappable mesh):

```ts
import { selectCollectibles } from 'world-forger/platformer/spawn-select.js';
const chosen = selectCollectibles(candidates, params.budget, gameData.seed ?? 1);
// for each chosen candidate, add an environmentObject at points[idx] with collectible:true
// (EnvironmentObjectSystem auto-wires CollectibleComponent). type = the GDD collectibleType id.
```

## 4. Spawn NPCs / enemies

The forge persists the designed encounters as typed entries in the unified
`worldProfileData.spawnPoints` array (`type: 'npc'`, `params` = archetype + plain-language
behavior + count). Read them at runtime — `engine.getSpawnPoints('npc')` — and for each,
`engine.registerNpc(id, behavior, opts)` then `handle.spawn(position.x, position.z)`. Reading the
DATA (not hardcoding positions) keeps later spawn-point edits working. Archetypes are defined once
in the GameDesignDoc roster — see §6. (The `npcSpawns` feature carries the same info as the
build-time brief; the spawnPoints array is the runtime source of truth.)

## 5. Traversal challenges (the REASON to play)

Each chokepoint ships as a DESIGNED CHALLENGE SITE: a baked static stage (`ChallengeStage_<i>` prop —
blocker wall + reach-correct platforms; already placed, do NOT add geometry) plus a
`traversalChallenge` feature `{ points: [site], params: { index, dir, ofTotal, challenge, difficulty, … } }`
whose `params.challenge` names the mechanism YOU must build. Mechanism coordinates in params are
LOCAL to the site: origin at `points[0]`, +Z along `params.dir`; heights are ground-relative — resolve
world Y with `engine.getWorldHeightAt`. **Where the description says the mechanism is the only way
through, it MUST exist and work, or the level cannot be finished.**

**When `params.engineAutoBuild` is true (all new forges), the ENGINE builds and runs the ferry /
vertical lift / crumbling platforms / spinner bars / ascent lifts itself — do NOT build those
mechanisms (a duplicate ferry double-carries; a duplicate crumbler desyncs; a duplicate spinner
doubles the hazard). Your job on those sites is flavor: theming, hazards, enemies, collectibles,
sounds. Any moving/spinning hazard YOU add anywhere should be a world.json `mechanisms[]` entry
(data-driven, user-editable, persisted — `@docs moving-platforms.md`); never a visual-only mesh
with a distance check: those pass through the player, and `setLinvel` "knockback" is a silent
no-op (use `playerController.applyKnockback`).**

| `params.challenge` | You build | Engine system |
|---|---|---|
| `gapCrossing` | nothing structural — optional hazard/flavor (patrolling enemy, collectible on the top hop) | — |
| `movingPlatformFerry` | nothing (engine-built) — add hazard/flavor timed against the ride | engine `TraversalChallengeSystem` |
| `verticalLift` | nothing (engine-built) — theme the shaft, reward the top ledge | engine `TraversalChallengeSystem` |
| `crumblingCrossing` | nothing (engine-built) — add break feedback (dust/sound), risk-reward collectibles | engine `TraversalChallengeSystem` |
| `spinnerGauntlet` | nothing (engine-built spinning bars that push the player) — theme the corridor, warning marks, sweep sound; keep the corridor itself clear | engine `TraversalChallengeSystem` |
| `pusherAlley` | nothing (engine-built piston blocks that shove the player) — same flavor rules as the gauntlet | engine `TraversalChallengeSystem` |
| `pendulumBridge` | nothing (engine-built swinging blades that bat the player) — same flavor rules as the gauntlet | engine `TraversalChallengeSystem` |
| `crusherAlley` | nothing (engine-built stompers; anyone caught is squeezed out sideways) — same flavor rules as the gauntlet | engine `TraversalChallengeSystem` |
| `leverGate` | a locked gate filling the wall doorway + a lever at `params.lever` that opens it (degrades open if unbuilt, so it is yours) | doors-and-locks (`@docs doors-and-locks.md`) |
| `params.oneWay` | a one-way passage along `params.dir` (drop ledge / one-way door) — never passable backwards | doors-and-locks or geometry |

`ascentLift` features (open-kingdoms) are engine-built shortcut elevators up a mesa (`points[0]`
foot → `points[1]` summit); the spiral trail remains the walking route. Mechanism positions in
params are LOCAL to `params.dir` at `points[0]` and heights are terrain-relative — the same frame
the baked stage is rotated to. Explicit `gate` features `{ params: { lock, … } }` name the lock
(`key:<id>` | `ability:<verb>` | `stars:<n>` | `switch:<id>`) — doors-and-locks system. Other
open-vocabulary features are the forger COMMISSIONING something that doesn't exist yet (a flame
tunnel, a designer `hazard` zone, …): the `description` is the requirement, `points`/`params` the
placement — you MUST build each one. Anything moving or hazard-like should be a world.json
`mechanisms[]` entry (custom `type` + `registerCustom` when no engine type fits).
**Never bake a dynamic obstacle into the static scene.**

## 5b. Adding NEW hazards/mechanisms after the forge (user edit requests)

When the user asks for a new hazard, platform, or encounter on an already-forged level ("add a
pendulum somewhere on the path"), do NOT guess a position — read the level structure first:
`inspect-world-json` with query `"forge"` returns the trail polyline, existing challenge sites,
markers, and the movement contract.

- **Position**: pick a trail point (or interpolate between two) at the moment you want in the
  journey; the local travel direction is the delta to the next trail point.
- **Keep clear**: stay ≥ 12 m from existing challenge sites, and outside mechanism travel paths
  (ferry from→to segments, elevator shafts, gauntlet corridors).
- **Heights**: `trail.points[].y` is the baked route floor at that spot (e.g. a pendulum pivot
  hangs ~4.5 m above it, sweep bars ~0.9 m). In runtime code prefer `engine.getWorldHeightAt(x, z)`.
- **Add it as a world.json `mechanisms[]` entry** (data-driven, user-editable, persisted —
  `@docs moving-platforms.md`; the asset side upserts it via the world-edit CLI). Only fall back
  to a code mechanism for behavior the schema can't express — and even then keep the tunables in
  a `mechanisms[]` entry (`getSpec` + `registerCustom`). Respect the movement contract for
  anything the player must jump over or dodge.

## 6. The design docs (the "why")

A platformer game has a `GameDesignDoc` (verbs, signature mechanic, win/fail, collectible + enemy
rosters — authored once) and per-level `LevelDesignBrief` deltas (theme, per-beat intent, which
abilities are introduced, enemy placements drawn from the roster). Treat the GDD as authoritative
for shared mechanics; a brief specializes, never redefines. Implement shared systems once and let
each level configure them — do not reinvent collectibles/scoring/controls per level.

Full architecture: `platformer-journey-design.md` (repo root). General platformer mechanics
(jump pads, moving platforms): `@docs mechanic-platformer.md`.
