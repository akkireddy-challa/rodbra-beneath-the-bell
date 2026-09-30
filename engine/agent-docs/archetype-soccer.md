# Archetype: soccer

## When to use

Prompts mentioning: soccer, football (the round-ball kind), football pitch, FIFA, world cup, penalty shootout, free kick, kick a ball into a goal, soccer arena, futsal. For the ball + kick + scoring gameplay, ALSO load `@docs mechanic-soccer.md`. For the kick animation specifically, ALSO load `@docs animation-assets.md`.

This archetype defines the **pitch and player spawn positions only** — gameplay (ball physics, scoring) lives in `mechanic-soccer.md`. The default loadout is target-practice (one human player + ball + goals + score), but the spawn markers are laid out for a full 11-vs-11 match so opponents/multiplayer can be added later without rebuilding the level.

> **The kick is the engine's `BallSportsSystem` — do NOT hand-roll it.** It plays the built-in `mSoccerKick01` clip, applies the impulse on the contact frame, and only kicks when the foot actually reaches the ball (no force on a miss). Do NOT call `playCustomAnimation` for the kick yourself, do NOT generate a custom kick animation, and do NOT use the combat clips `mPunching01` / `mKicking01`. See `@docs mechanic-soccer.md`.

> **What you still write** — the goal/score rules: goal detection by ball coordinates (goals are visual-only, not physical bodies), the scoreboard HUD, and resetting the ball to centre after a goal or when it leaves the pitch. `BallSportsSystem` owns the ball, the kick (speed/lift/spin/range/cooldown are options), and the contact gating. Full split in `@docs mechanic-soccer.md`.

## Terrain config

```json
"terrain": { "shape": "flat", "groundBlockType": "grass" }
```

Always flat. Always grass. Set `cameraMode: "third-person"` (the natural soccer view; first-person breaks ball-tracking).

### Disable ALL foliage and decoration

A soccer pitch is a clean grass surface. **Every source of vegetation must be off** — biome scatter, foliage system, and environment-object procedural generation. Set ALL of these at the top level (`environmentObjectsGeneratedProcedurally` and `environmentObjects` both live at the top level, not inside `worldProfileData`):

```json
"environmentObjectsGeneratedProcedurally": false,
"environmentObjects": []
```

- `environmentObjectsGeneratedProcedurally: false` — stops the biome-scatter pass that would seed rocks, debris, scrub, trees, etc. on the surface. This is the single switch that disables every source of procedural vegetation.
- `environmentObjects: []` — start from an empty list. The pitch markings (white-line blocks) and goal posts are placed as voxel blocks via the world generator, not as environment objects. The only environment object on the pitch is the ball (next section).

Don't trust biome rules to "figure out it's a soccer pitch" — explicitly zero every knob. If the AI later wants to add stadium walls or stands as a hybrid (see `Hybrid combinations` below), those go in `environmentObjects` *after* the bare pitch is in place.

## Field dimensions

The default pitch is **50 m × 40 m** (a half-scale match field — a real one is 105×68, which is too sparse for the camera). The whole layout uses these constants — do not change them piecemeal:

```
length (z axis):  -25 ... +25  (own goal at -25, opponent goal at +25)
width  (x axis):  -20 ... +20
center spot:      (0, 0)
```

## Pitch markings

White lines are 1-voxel-thick rows of `marble` placed one block above the grass surface, painted at:

| Line | Coordinates |
|---|---|
| Touchlines (long sides) | x = ±20, z = -25..+25 |
| Goal lines (short sides) | z = ±25, x = -20..+20 |
| Halfway line | z = 0, x = -20..+20 |
| Center circle | radius 5 around (0, 0), painted as discrete blocks along the arc |
| Penalty area (each end) | 12 m × 6 m rectangle: x = -8..+8, z from goal-line inward 6 m |
| Goal area (6-yard box) | 6 m × 2 m rectangle: x = -4..+4, z from goal-line inward 2 m |
| Penalty spot (each end) | single block at (0, ±19) |
| Center spot | single block at (0, 0) |

Use `voxel-terrain-foliage.md`'s ground-painting approach (per-voxel block override on the top layer of the flat ground) — don't use `LineSegments` or other Three.js primitives; lines need to read as part of the pitch.

## The ball — a rolling env object (asset agent's job)

Create the ball with `voxelAssetCreationTool` and place it at the center spot. The sphere collider + dynamic placement is what makes it roll; the coding agent's `BallSportsSystem` only looks it up by name (`soccer_ball`).

```
create_voxel_asset(
  name="soccer_ball",
  parts=[{ position: { x: 0, y: 0, z: 0 }, size: { width: 0.8, height: 0.8, length: 0.8 }, color: "#FFFFFF", shape: "sphere" }],
  voxelSize=0.1,
  colliderShape="sphere"
)
node bin/voxel.mjs place --asset soccer_ball --x 0 --z 0 --y 1.5 --name soccer_ball --dynamic --force-position
```

The ball must keep the instance name `soccer_ball` — the gameplay code finds it by that name (`mechanic-soccer.md`).

## Goals

Two goal frames, one at each end. Use a generated voxel asset `soccer_goal` (white-painted posts + crossbar + nylon-net texture on the inside) **OR** build inline from white voxel blocks:

- Posts: 1×3×1 white blocks at `(±3, 0..2.5, ±25)` — 4 posts total per goal
- Crossbar: 1×1×7 white blocks at `(-3..+3, 2.75, ±25)`
- Net: a `MeshStandardMaterial` plane with low alpha (~0.3) behind the goal mouth from `(-3, 0, -27)` to `(+3, 2.75, -25)` — purely visual

Goals are **not** physical — they're visual. The scoring trigger is a coordinate check inside the `BallSportsSystem` (see `mechanic-soccer.md`); a Rapier body would push the ball out instead of catching it.

## Player spawn positions — full 11-vs-11 layout

Each position is a named marker registered via `markers-system.md` — entries in `worldProfileData.markers` with `name` set to the role id below (e.g. `team_a_st`) and `color` chosen per team (e.g. `red` for A, `blue` for B). **For target-practice, only spawn the human player at one of them** (default: `team_a_st` — center forward — so they're near the center spot pointed at the opponent goal). Leave the rest as named markers so NPC / multiplayer code can later look them up by name prefix (`team_b_*`) and populate teams without rebuilding the pitch.

Coordinates are `(x, z)`; y comes from the ground.

**Team A — defending z = -25, attacking z = +25 (4-4-2)**

| Marker | Role | Position |
|---|---|---|
| `team_a_gk` | Goalkeeper | `(0, -23)` |
| `team_a_lb` | Left back | `(-12, -15)` |
| `team_a_lcb` | Left center back | `(-4, -15)` |
| `team_a_rcb` | Right center back | `(+4, -15)` |
| `team_a_rb` | Right back | `(+12, -15)` |
| `team_a_lm` | Left midfielder | `(-12, -5)` |
| `team_a_lcm` | Left center midfielder | `(-4, -5)` |
| `team_a_rcm` | Right center midfielder | `(+4, -5)` |
| `team_a_rm` | Right midfielder | `(+12, -5)` |
| `team_a_lst` | Left striker | `(-4, -2)` |
| `team_a_st` | Striker (player default spawn) | `(0, -1)` |

**Team B — mirror of Team A across z = 0**: `team_b_gk` at `(0, +23)`, `team_b_rb` at `(-12, +15)` (signs mirrored on x too so "left" stays sensible from each team's POV), etc.

## Common gotchas

- **Don't make goals physical.** They need to let the ball through, not deflect it. Goals are visual; scoring is a coordinate check (in `mechanic-soccer.md`).
- **Don't add ANY foliage.** Trees, bushes, and grass tufts on a soccer pitch is the #1 wrong-looking failure mode. Set `environmentObjectsGeneratedProcedurally: false` so biome scatter doesn't seed trees, rocks, or scrub on the field, and keep `environmentObjects: []`. The pitch must be visually empty except for the lines and goals.
- **Don't generate buildings.** Soccer pitches are open. No stadium walls in this archetype unless the user explicitly asks for "stadium with stands" (see hybrids below).
- **Camera at top-down or first-person looks wrong.** Always third-person.
- **Player positions are markers, not NPCs.** Spawning the human at `team_a_st` is enough. The other 21 are reservation points for later expansion — NEVER spawn 22 controllable bodies for target-practice mode.

## Hybrid combinations

- **Penalty shootout** → use this archetype but reposition the ball spawn to a penalty spot `(0, ±19)`. See `mechanic-soccer.md` for the gameplay tweak.
- **Soccer with NPC opponents** → load also `@docs npc-system.md` and `@docs mechanic-soccer.md`. Spawn NPCs at the `team_b_*` markers.
- **Stadium with stands** → after this archetype, add walls at `x = ±22, z = -25..+25` and `z = ±27, x = -22..+22` (just outside touchlines). Place 4-8 `grandstand` assets behind those walls. The pitch interior stays unchanged.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
50 × 40 m grass soccer pitch, half-scale FIFA layout. Two white-post goals at z = ±25 with translucent nets. White-painted touchlines, halfway line, center circle (r = 5), penalty boxes, goal areas, penalty + center spots. Ball spawns at center. No foliage, no buildings, no other props.

## Regions
- **pitch_floor** — flat grass over the whole world; world bounds (-25..+25, -20..+20). Foliage disabled.
- **lines** — `marble` blocks painted on top of grass at all marked positions (touchlines, goal lines, halfway, center circle, penalty + goal areas, center + penalty spots).
- **goal_north** — visual goal at z = -25 (4 posts + crossbar + translucent net). NOT a physics body.
- **goal_south** — mirror at z = +25.
- **spawns** — 22 markers covering both teams' 4-4-2 formation. Player spawns at `team_a_st` (0, -1). Other 21 are reservation points.

## Asset palette per region
- pitch_floor: nothing (flat ground)
- lines: `marble` voxel blocks
- goals: `marble` posts + crossbar; translucent plane mesh for net
- ball: `soccer_ball` (sphere-part voxel asset, colliderShape sphere) placed dynamic at (0, 1.5, 0), instance name `soccer_ball`
- spawns: invisible markers (no asset)

## Gameplay
See `@docs mechanic-soccer.md` for the ball, kick, and scoring system.

## Layout sketch
```
       z = +25  ════════[ goal south (team b) ]════════
                ║                                     ║
                ║   ┌───────────────────┐             ║
                ║   │  team_b spawn(11) │  ← reserved ║
                ║   │     formation     │             ║
                ║   └───────────────────┘             ║
       z = 0    ║─────────  HALFWAY  ────────────────║
                ║   ┌───────────────────┐             ║
                ║   │  team_a spawn(11) │  ← player @ ║
                ║   │     formation     │   team_a_st ║
                ║   └───────────────────┘             ║
                ║                                     ║
       z = -25  ════════[ goal north (team a) ]════════
              x = -20            x = 0           x = +20
```
```
