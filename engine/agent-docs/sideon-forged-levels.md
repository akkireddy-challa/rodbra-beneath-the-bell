# Consuming a forged SIDE-ON level (2D side-view games)

A side-on level is forged by the World-Forger's 2D path for side-view voxel games (the
sidescroller template and any other voxel-genre 2D game, on any template). It produces **no vwld
level asset**: the level IS flat baseline terrain (`worldProfileData.terrain.shape = 'flat'`,
sized by `groundWorldSizeX`/`groundWorldSizeZ`) plus placed environment-object instances —
buildings/rooftops/platforms as the walkable route along X on the locked gameplay plane (Z ≈ 0),
with collectibles, checkpoints and a goal ALREADY PLACED. Never treat the missing level asset as
a failure, and never re-place the pickups.

The forge guarantees: *every consecutive hop along the route clears the movement envelope the
level was designed for.* Your job is the gameplay the geometry alone cannot encode.

## The handoff record: `worldProfileData.worldForgerSideon`

```
{ jobId, name, prompt, spec,            // the designed plan, verbatim (for re-forges)
  layout: {                             // the AS-BUILT level
    surfaces[{ archetype, x0, x1, topY }],      // the walkable route, left→right
    hazardSpans[{ kind: 'street'|'pit', x0, x1 }],
    checkpoints[{ id, x, y }], goal { id, x, y } | null,
    collectibleCandidates[...],         // placed = optional:false; the rest are spares
    movement { runSpeed, gravity, jumpHeight, airJumpFactor, maxJumps, stepHeight,
               coyoteTime, designTolerance, maxRiseM, flatReachM },
  },
  features[], markers[],                // same content the tool result returned
  replacedLevels? {                     // when the forge replaced ANY 3D world (a bare voxelUrl
    levels[...], startLevelId, voxelUrl }        // counts too, with levels: []); see below
}
```

## What the forge replaced

A side-on level is a single flat strip and cannot be an entry in the multi-level registry, so
forging one over a game that had `levels[]` DISCARDS that registry — and, following
`bitmagic levels remove`, takes each discarded level's content with it: every `levelId`-tagged
environment object, door and key pickup — including ones tagged with a level id that no longer
exists, which is the ordinary residue of an earlier level deletion. Untagged objects are
global-by-intent and survive.

The registry itself is preserved at `worldForgerSideon.replacedLevels` (its entries carry the
`spawnPoints` and atmosphere `overrides` that live nowhere else), merged field by field across
re-forges so a later forge cannot blank it, and the `.vwld` assets stay in `assets[]` — but the
PLACED OBJECTS, DOORS and KEY ITEMS of those levels are gone, and those are NOT stashed anywhere. If the user asks to go back to their
3D levels, say that up front: the terrain and the level list can be rebuilt from the stash, the
hand-placed contents of those levels cannot.

## 1. Movement alignment (the completability contract)

`layout.movement` is the envelope every hop was verified against. The sidescroller template's
defaults already match it; if this game's `PhysicsConfig`/movement was tuned differently, either
align it back to the envelope or expect unclearable gaps — and say so to the user instead of
shipping them. If the user asks for a different feel afterwards, re-verify the route or re-forge.

## 2. Collectible scoring (pickups are already placed)

Every placed collectible is an environment object with `collectible: true` and a stable `name`
(`coin_N`). The engine auto-wires the trigger sensor, hide-on-collect and physics removal — game
code only listens (see `@docs collectible-objects.md`, Pattern A):

```ts
getInteractionManager().onCollected((objectId, objectName) => {
    if (objectName?.startsWith('coin_')) this.addCoin();
});
```

Wire the counter into the HUD and (if the design wants it) a win-at-N condition. Do NOT spawn
additional coins for the forged route — `collectibleCandidates` with `optional: true` are the
spare positions if the user later asks for more.

## 3. Hazard falls → last-checkpoint respawn (game code — no engine kill volume exists)

The `hazard` feature carries `params.spans` (the same `hazardSpans` X ranges), `params.belowY`
and `params.respawnRule` — `'lastCheckpoint'` when the level has checkpoints, `'playerStart'`
when its plan declared none. Each frame in play: if the player's X is inside a span and their
**feet** are below `belowY`, reset them per that rule — INSTANTLY, no death animation (see
`@docs mechanic-platformer.md`). Rooftop levels ('street' spans) reset on touching the street;
ground levels ('pit' spans) on falling into the pit.

**Read FEET, not the capsule centre.** `getGroundPosition()` returns the feet position, derived
from the physics capsule, and is the only Y this check works with. `playerBody.translation().y`
is the capsule CENTRE — about 0.75 m higher for the default 1.5 m capsule, which is more than
the margin `belowY` is built from, so a centre-based check never fires and the level ships with
no failure state at all. `SidescrollerMovement` works in centre coordinates internally, so this
is an easy mistake to make. (`getPosition()` is not the one either: it returns the visual mesh,
and the vehicle's position while the player is riding one.)

```ts
const feet = this.engine.getPlayerController().getGroundPosition();
const inSpan = spans.some((s) => feet.x >= s.x0 && feet.x <= s.x1);
if (inSpan && feet.y < belowY) this.respawn();   // NOT playerBody.translation().y
```

`belowY` is **not** a fixed number and must be read from the feature, never hard-coded. It sits
just above the level's ground, which is itself a voxel above y=0 (`voxelBlockSize`, so 1.5 for
the default 1 m blocks). The flat terrain is a SOLID plane — a player who falls off a roof does
not keep falling, they land on the street and stand there — so the condition this expresses is
"standing at street level", not "below the world".

Every Y in the carrier — `layout.surfaces[].topY`, `checkpoints[].y`, `goal.y`,
`collectibleCandidates[].y`, `markers[]` — is likewise **world** Y on that same datum, not
height above a ground plane at zero.

## 4. Checkpoints and the goal

Checkpoints exist only when the plan declared a checkpoint archetype — then every entry of
`layout.checkpoints[i]` has a placed instance named `checkpoint_N` (the two never diverge; a
level without the archetype has an empty `checkpoints` list, no checkpoint feature, and the
`'playerStart'` respawn rule above). Activate the nearest one passed (X ≥ checkpoint.x, on a
surface) and remember it as the respawn point. The `goal` instance (named `goal`) exists exactly
when `layout.goal` is non-null and ends the level: detect proximity (a few units), then show the
win state the game's design wants. Both are placed with `collision: false` — detection is by
position, not by physics contact.

## 5. Enemies and NPCs (the engine locks them to the plane — do not hand-roll it)

Every NPC registered with `engine.registerNpc(...)` is automatically kept on the gameplay
plane (z = 0) in a side-on game. The engine's NPC behaviors, pathfinding and crowd avoidance
are 3D — without the lock a chasing enemy strafes off the plane, the crowd solver separates
neighbours in Z, and enemies end up beside the level, unreachable by a player who cannot leave
the plane. The engine snaps position (never velocity) once per frame and projects navigation
targets onto the plane, so behaviors always reason from on-plane positions.

- Do NOT write your own constraint (per-frame `teleportTo` sweeps, dead-banded Z checks) — the
  engine's lock is exact and already running; a hand-rolled one on top just fights it.
- Spawn with `handle.spawn(x, 0, y)` as usual; a spawn nudged off-plane is corrected on its
  first frame.
- A deliberate BACKDROP actor (a crowd behind the plane, distant walkers at z < 0) opts out at
  registration: `engine.registerNpc(name, behavior, { planeLock: false })`. Everything that
  fights, chases or blocks the player stays locked.
- Death effects: block-explosion debris tumbles on the plane (the sidescroller runs Rapier 2D —
  every body, ray and trigger lives on the plane, so nothing can drift off it); ragdolls and
  bone-voxel shatter are 3D-only and fall back to the plain removal. Do not use 3D projectiles
  (`Projectile`) or `RAPIER.*` descriptors in game code on this lane — they throw in the
  published bundle (see `game/docs/physics-2d-lane.md`).

## 6. Asset quality (placeholders → generated models)

Every asset the forge places is a coarse voxel placeholder (`placeholder: true`) whose
`description` is a ready-to-use regeneration brief. The final look comes from regenerating the
few archetypes the player actually looks at — typically the route buildings/platforms and the
goal, 3-5 assets — with the asset generation tool, passing each asset's EXISTING id. The new
model is voxelized to fit the placeholder's `fitBox`, so the laid-out level does not move and
the route stays verified. Do not regenerate every archetype unprompted (cost); pick the visible
few or ask the creator which matter.

## 7. What NOT to do

- Do NOT stamp procedural strip terrain over the level (`SidescrollerWorldGenerator`'s seeded
  strip is bypassed automatically: the forge writes `terrain.shape = 'flat'`, which that
  generator honors by delegating to the flat baseline plane).
- Do NOT hand-place more buildings along the route without re-checking hop reach against
  `layout.movement` (use `clearsGap`-style math or keep gaps ≤ `flatReachM`).
- Do NOT mint or expect a `kind: 'level'` asset, `voxelUrl`, or a `levels[]` entry — a side-on
  game uses none of them. Note they may be PRESENT-BUT-EMPTY (`voxelUrl: ""`, `levels: []`,
  `startLevelId: ""`) on a game that was 3D-forged before: that is the cleared state, not a level
  to load. The old URL inside `replacedLevels` is history, not something to render.
