# Mechanic: boat racing (watercraft / jet-ski / powerboat)

> **Coordinate convention:** boats use **+Z gameplay forward**, same as cars — see `@docs coordinate-system.md` §2. Heading yaw θ means forward is `(sin θ, 0, cos θ)`, and positive steering turns LEFT.

## When to use

Prompts mentioning: boat race, jet ski, wave race, speedboat, powerboat, watercraft, regatta, offshore racing, "racing on water". The loop is "drive a boat around a course on open water faster than the rivals."

This is **not** the car recipe with a blue floor. A boat game's whole identity is the water: the sea moves, the hull rides it, and crests launch you. If the water is flat, build a car race on a causeway instead — it will play better.

For a game where boats are transport rather than the sport (a fishing game, a skiff to row), you still want the ocean and `BoatMovement`; skip the course and gates. If the player instead WALKS the deck of a big ship that is the level — a pirate galleon under sail — that is `@docs mechanic-sailing.md`.

## Camera / perspective

`cameraMode: 'third-person'` — the chase camera behind the boat. Never top-down: swell height and the launch off a crest are the gameplay, and both are invisible from above.

## Set up the world FIRST — one flag does almost all of it

    worldProfileData.openWater = { "preset": "ocean" }

That single flag is the difference between a boat game and a broken one. It:

- builds the animated stylized ocean and the painted sky, engine-owned;
- drives them every frame;
- hands the sea to the player's `BoatMovement` automatically;
- and **turns terrain generation off**.

That last point is the one that bites. Without it the voxel WorldGenerator still
builds a procedural grass/dirt island under your ocean, complete with the voxel
fluid system's own water sitting in a low channel. Players report this as *"the
water level is too low"* — but the water level is fine; there is a whole world
there that should not exist.

Set it with edit-world-config. Fields (all optional): `seaLevelY`, `preset`
(`calm` | `ocean` | `storm`), `amplitudeScale`, `windDirectionDeg`, `sky`,
`skyHorizon`, `skyZenith`, `palette`.

**Clear `worldProfileData.skyboxUrl` for an open-water game.** The painted sky
is what makes the cel-shaded sea read as one picture; a photographic skybox over
it looks like two different games. The engine will not draw both — a level that
still has a `skyboxUrl` keeps it and the painted dome is skipped — so leaving
the template's default skybox in place silently costs you the look.

**You do not have to set `openWater` and `playerMovement.mode = "boat"` in
lockstep** — a boat level with no `openWater` is assumed to be open water and
warns. Set it anyway: the default sea state is only a guess at what the game
wants.

**Never set `waterLevelY` as well** — that is the see-through COASTAL plane for
voxel levels with a seafloor. Two water features at two heights. The engine
ignores `waterLevelY` on an open-water level and warns.

## The one rule that matters

**There is exactly one ocean, and everything reads its height from that one.**

Get it with `engine.getOceanSurface()`. The wave field
(`engine/water/OceanWaveField.ts`) generates the shader's vertex displacement,
the CPU's `heightAt()`, and the surface normal from one set of bands — that is
what lets a hull ride the crest you can see. A game that builds a second
`OceanSurface`, or hand-rolls a sine sum for buoyancy, gets boats hovering above
the water and sinking through it, and no amount of tuning fixes it.

**The ocean exists before your game code is constructed.** The engine applies
it ahead of `genreModule.load()`, and `getOceanSurface()` builds on demand if
anything still manages to ask early, so it is safe to read in a constructor.

Per frame the engine advances the ocean before game code runs, so anything you
update in your own loop (course, rivals, floating props) already reads a
current surface. Order inside your update:

1. `course.update()` — re-seats the ribbon and buoys on the new surface.
2. `aiBoat.update(dt)` for each rival.
3. Gate/lap scoring.

## Core systems

| System | Where | What it does |
|---|---|---|
| Wave field | `engine/water/OceanWaveField.ts` | The single wave definition. Presets `calm` / `ocean` / `storm`; `oceanWaveFieldForPreset(name, amplitudeScale, windDirectionDeg)`. |
| Ocean surface | `engine.getOceanSurface()` | Built and driven by the engine from `openWater`. Camera-following cel-shaded mesh, plus `heightAt` / `normalAt` for gameplay. Do NOT construct your own. |
| Sky | (engine, from `openWater`) | Flat painted gradient + cloud band, matched to the sea. Turn it off with `openWater.sky = false` only if you are supplying something better. |
| Player boat | `engine/boat/BoatMovement.ts` | `IPlayerMovement`. Throttle/steer/boost/hop, wave riding, procedural hull, wake + spray. Finds the engine's ocean by itself. |
| Handling | `engine/boat/BoatMotor.ts` | The shared motor. Player and AI both run it — do not write a second one for rivals. |
| AI rivals | `engine/boat/AiBoat.ts` | Look-ahead pursuit of the racing line on the same motor. |
| Course + gates | `engine/boat/BoatRaceCourse.ts` | The glowing racing-line ribbon, buoy gates, and `gateCrossed()` for lap scoring. |
| Wake / spray | `engine/boat/BoatWakeVFX.ts` | Auto-created by `BoatMovement` and `AiBoat`. |

## Enabling the player's boat

    worldProfileData.playerMovement = { "mode": "boat", "boat": { "maxSpeed": 28 } }

That is the whole thing. The engine installs `BoatMovement` at spawn, and the
boat binds itself to the engine's ocean — there is nothing to hand over. The
optional `boat` object overrides any `BoatConfig` field (plain numbers/booleans;
unknown keys ignored).

In code, when a game mounts and dismounts boats:

```ts
import { BoatMovement } from 'engine/boat/index.js';

const boat = new BoatMovement({ maxSpeed: 28 });
playerController.setMovementSystem(boat);          // mount — ocean found automatically
playerController.setMovementSystem(walkingSystem); // dismount
```

Only call `boat.setWaterSurface(surface)` for a game with water the engine does
not own (a scripted cutscene sea, a test double). It is not part of normal setup.

### Where the boat starts

Put the player's spawn on the first course waypoint —
`worldProfileData.playerSpawnPosition` — and let the boat seat itself onto the
swell there. Do NOT build the race and then `teleport()` the boat to the start:
engine spawn placement runs after game setup, so a teleport during setup gets
overwritten and the player begins somewhere else. (`teleport()` is for mid-race
resets, where nothing is competing with it. It reads the surface height itself —
the Y you pass is ignored.)

### Speed is owned by the boat config, not the character

`BoatMovement.setMoveSpeed()` is deliberately a **no-op**. Genre templates call
`getMovementSystem().setMoveSpeed(characterConfig.runSpeed)` at spawn on
whatever movement system is installed; honouring it would clamp a 28 m/s racing
boat to a ~5 m/s walking pace. Change a boat's top speed with
`updateConfig({ maxSpeed })` or the `boat` object in world.json.

## Key config fields (full list: `engine/boat/BoatConfig.ts`)

| Field | Default | Meaning |
|---|---|---|
| maxSpeed / boostMaxSpeed | 26 / 34 | Top speed (m/s) without and with boost |
| acceleration / boostAcceleration | 13 / 9 | Thrust (m/s²) |
| dragLinear | 0.12 | Low-speed skin drag. The quadratic term is DERIVED so `maxSpeed` is exact — there is no drag curve to author |
| turnRateLowDeg / turnRateHighDeg | 40 / 105 | Steering authority at low / high speed |
| turnPeakSpeed | 11 | Speed (m/s) where steering bites hardest |
| gripRate | 3.2 | Drift knob. 8+ on rails, ~3 arcade slide, <1 ice |
| rideHeight / buoyancyRate | 0.34 / 9 | How high the hull rides, and how hard it tracks the surface |
| waveSurfAccel | 7.5 | Speed gained running down a wave face — the reason swell is gameplay |
| gravity / liftoffMargin | 16 / 1.6 | Airborne arc, and how readily crests launch the boat |
| jumpSpeed | 5.2 | Deliberate hop (Space). 0 disables |
| waveAlign / turnLeanDeg | 0.72 / 22 | How much the hull matches the water's tilt, and roll into turns |
| hullColor / trimColor / seatColor | red / yellow / navy | Procedural hull colours |
| showRider | false | Draw a crouched rider. OFF for the player (their character rides it), ON by default for `AiBoat` |

## Reading state (HUD, scoring, VFX)

```ts
const s = boat.getBoatState();
// s.speed (m/s), s.forwardSpeed, s.heading, s.onWater, s.airtimeSeconds,
// s.drift (0 tracking .. 1 fully sideways), s.landingImpact, s.surfaceY, s.hullY
```

Airtime and drift are free scoring hooks — a wave-race game that rewards big air off crests writes itself from `s.airtimeSeconds` and `s.landingImpact`.

## Course, gates and laps

`createBoatRaceCourse({ waypoints, surface })` builds both the visible racing line and the checkpoint system from ONE waypoint list, so they can never disagree.

```ts
if (course.gateCrossed(nextGate, prevBoatPos, boatPos)) {
    nextGate++;
    if (nextGate >= course.gates.length) { nextGate = 0; lap++; }
}
```

`gateCrossed` requires the boat to pass BETWEEN the two buoys, travelling forwards. **Always gate laps on gate order.** Open water has no track to leave, so a finish-line-only lap counter lets the player turn a tight circle over the line and win in seconds.

`course.distanceAlong(point)` gives progress in metres for a standings HUD; `course.centerline` is the racing line to hand `AiBoat`.

## Win / lose conditions

| Variant | Win | Lose |
|---|---|---|
| Sprint race (default) | Finish N laps before every rival | A rival finishes first |
| Time trial | N laps under a target time | Time expires |
| Wave-jump / freestyle | Hit an air-time or trick score target | Time expires |
| Survival / rough seas | Finish the course in a `storm` sea state | Capsized or timed out |

Default to **sprint race, 3 laps, 4 rivals, `ocean` sea state**.

## HUD plan (cross-ref `@docs HUD_ELEMENTS.md`)

- **Lap counter** — top-centre: `Lap 1 / 3`
- **Position** — top-left: `2nd of 5`
- **Lap time** — top-right: current and best
- **Speed** — bottom-centre: km/h (`state.speed * 3.6`)
- **Air time** — bottom-right, only while `!state.onWater`: big airs are the spectacle, show them

## Course layout — cross-reference to `world-plan.md`

Open water needs no terrain, which removes most of the usual world work — but the course still has to be laid out:

- **Course centreline:** 24-32 waypoints in a closed loop. `buildOvalCourse()` in the sample makes one through a chosen origin and heading.
- **Scale:** a lap should take 60-90 s. At the default 26 m/s that is a **1.5-2.3 km** centreline — an oval roughly 300 m × 130 m half-extent. Courses sized like a car track (200 m round) are over in 8 seconds.
- **Gate spacing:** 8-12 gates around the loop. Fewer and the player can cut huge corners; more and the sea disappears behind buoys.
- **Start:** set `worldProfileData.playerSpawnPosition` to waypoint 0. Do not teleport at setup time (see "Where the boat starts").
- **Islands / obstacles** (optional): ordinary environment objects. The player's boat collides with them through the character controller; rivals do not.

## Matching the reference look

The defaults are tuned to a cel-shaded wave-racer. If a prompt asks for a different mood, change these and little else:

All of it is world.json — `worldProfileData.openWater` — so it is an
edit-world-config change, not a code change:

- **Sea state** — `preset` (`calm` | `ocean` | `storm`), `amplitudeScale`, `windDirectionDeg`.
- **Palette** — `palette: { deep, mid, bright, shallow, foam, horizon }` (hex). Keep `horizon` close to the sky's low band or the seam at the horizon shows.
- **Sky** — `skyHorizon`, `skyZenith`, or `sky: false` to supply your own.

Finer shader dials (posterization `toneBands`, `foamThreshold`, `fleckStrength`)
live on `createOceanSurface` for games that build a bespoke sea; the world.json
flag covers everything a normal game needs.

## Common gotchas

Every one of these was hit by the first generated boat game, in one sitting.

- **Forgetting `worldProfileData.openWater`.** The single biggest failure. The
  game gets procedural grass terrain under the sea plus voxel fluid water in a
  low channel, and the player reports *"the water level is too low"*. Set the
  flag; do not try to hide terrain some other way.
- **Setting `waterLevelY` too.** That is the coastal see-through plane, a
  different feature. Open-water levels ignore it and warn.
- **Building your own `OceanSurface`.** Then gameplay and graphics ride
  different water. Use `engine.getOceanSurface()`.
- **Letting the character run speed reach the boat.** Templates call
  `setMoveSpeed(runSpeed)` at spawn; on a boat it is ignored by design, so never
  "fix" that by writing `maxSpeed` from `characterConfig`.
- **Teleporting to the start during setup.** Engine spawn placement overwrites
  it. Move the spawn point instead.
- **Course too small.** A lap should take 60-90 s — 1.5-2.3 km of centreline.
  This is the most common way a boat race that "works" still feels wrong.
- **Rivals with hand-written movement.** Use `AiBoat`; it shares `BoatMotor`
  with the player, so nobody can out-corner physics.
- **Top-down camera.** The swell is the game. Third-person or nothing.

## Reference implementation

`samples/boat-racing-setup.ts` — `BoatRace` (ocean + sky + course + rivals + lap scoring + placings) and `buildOvalCourse`, compile-checked against the live engine.

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Sprint boat race, 3 laps on an open-ocean oval. Player rides a jet-ski in third person
against 4 AI rivals. Swell launches boats off crests; air time is scored.

## World config (set these FIRST, via edit-world-config)
- `worldProfileData.openWater = { "preset": "ocean" }` — engine-owned animated sea + sky, and NO terrain
- `worldProfileData.playerMovement = { "mode": "boat" }` — installs BoatMovement, which finds the ocean itself
- `worldProfileData.playerSpawnPosition` = course waypoint 0, facing waypoint 1

## Core systems
- Player boat — `BoatMovement` from the world.json flag; no water wiring in code
- Rivals — 4 × `AiBoat` on `course.centerline`, staggered start indices and lane offsets
- Course — `createBoatRaceCourse` with a 28-point oval, 10 buoy gates
- Laps — `course.gateCrossed()` in order; lap only after the last gate

## Win / lose conditions
- Win: 3 laps before any rival
- Lose: a rival finishes first

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Top-centre: `Lap 1 / 3`
- Top-left: `1st of 5`
- Top-right: current + best lap time
- Bottom-centre: speed (km/h)
- Bottom-right: air time, shown only while airborne

## Cross-reference to world-plan.md
- No terrain at all — `openWater` handles it. Player spawn at the first course waypoint, facing the second.
- Course: oval, 300 m × 130 m half-extents, ~1.9 km lap (~75 s at 26 m/s)
- 10 buoy gates evenly around the loop; decorative scatter buoys off-course
```
