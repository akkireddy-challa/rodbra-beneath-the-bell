# Mechanic: sailing a ship that is the level (galleon / longship / barge)

> **Coordinate convention:** headings use **+Z gameplay forward** — heading θ means forward is `(sin θ, 0, cos θ)`. See `@docs coordinate-system.md` §2.

## When to use

Prompts where the player WALKS the deck of a ship that is under way: a pirate galleon crossing to an island, a longship on a grey sea, a river barge, "take the wheel and steer for the island". The ship is the level — usually forged with the vessel approach (`@docs world-glb-forge.md`, *Vessels*).

Not this recipe:

- the player DRIVES a small boat around open water → `@docs mechanic-boat-racing.md` (`BoatMovement`);
- the inside of a ship with no sea (`build: "roomsInHull"`, a spaceship) → nothing here applies.

## The model: the hull holds still, the sea moves

A forged ship is baked level geometry with static colliders. It cannot move, and if it could, the player's physics capsule would be left behind. So **the ship never moves**. `engine/sailing/` moves everything else:

- **The voyage.** `SeaVoyage` keeps a virtual position and heading, and advances along the helm's course. Everything off the deck lives in that "voyage space". Each frame it is projected into the world around the ship's centre. Turning the wheel swings the whole horizon by the course change.
- **The sea.** The engine ocean's waves are sampled through an `OceanWaveFrame`, so the swell streams past the hull and swings on a turn. Foam streaks (`SailingWake`) drift aft, and a standing wake peels off the stem and churns astern. All of it sits on the water.
- **The horizon.** `VoyageScenery` scatters islands that recycle through the fog so the sea is never empty. `addLandmark` places the one you are sailing for.
- **The helm.** `ShipHelm` is a heavy-ship model. The wheel takes seconds to put over, and the swing builds and dies on its own time constant. She leans because she is turning, not because the wheel is over.
- **The camera.** `SwellSway` adds about a degree of roll and some heave, plus the heel. It is kept small because the deck rocks WITH the view.
- **The level.** The baked level is clipped to the hull (`setRenderRegion`). Forged land cannot move, so it would sit still while the sea goes by. Its colliders stay.

## Set up the world

    worldProfileData.openWater = { "preset": "ocean", "seaLevelY": <the forged waterline> }

That builds the engine ocean and sky, and it keeps the baked ship: open water no longer skips a level that has a `voxelUrl`. Use `openWater`, not `waterLevelY`. The coastal plane ends a few hundred metres out and cannot carry moving islands.

Keep `fogConfig.far` generous (1500–2000 m). The scenery is born inside the haze and fades up out of it.

## Wiring

```ts
import { createSailing, voyageSceneryDistancesForFog, DEFAULT_VOYAGE_SCENERY_OPTIONS,
    DEFAULT_VOYAGE_LANDMARK_OPTIONS } from 'engine/sailing/index.js';

// load(), once the world and the player controller exist:
this.sailing = createSailing(this.engine, this.gameData, {
    seaLevelY: this.worldProfileData.openWater?.seaLevelY ?? 0,
    renderRegionTarget: this.worldGenerator?.getVxlSceneTerrain() ?? null,
    scenery: {
        ...DEFAULT_VOYAGE_SCENERY_OPTIONS,
        ...voyageSceneryDistancesForFog(1700),       // your fogConfig.far
        assets: ['sea_stack_isle', 'low_atoll'],     // generated island props
    },
});
const destination = new THREE.Vector2(870, 320);  // voyage space; the ship starts at (0, 0)
void this.sailing?.scenery?.addLandmark('landfall_island', destination,
    { ...DEFAULT_VOYAGE_LANDMARK_OPTIONS, scale: 4 });

// update(deltaTime), before the camera controller:
this.sailing?.update(deltaTime, atTheHelm ? helmCommand : 0);
// update(deltaTime), AFTER the active camera controller has updated:
this.sailing?.applyCamera(this.engine.camera);
```

`createSailing` returns `null` on a level with no forged `vesselDeck`, and it never throws. For a ship built from placed props, construct `new Sailing(engine, vesselFrameFromBowStern(bow, stern, beam, deckY), options)`.

## What stays game code

- **Working the helm.** Use `registerCustomAction` for a port and a starboard action. The pirate-ship used Z / X on desktop and PORT / STBD touch buttons, shown only within reach of the wheel. Send `helmCommand` −1 / 0 / +1. Send 0 when nobody is at the wheel, and she holds the course she is on.
- **A wheel that turns.** Spawn the wheel asset under a pivot at its hub (not as a placed environment object, which cannot move). Then `pivot.rotateZ(-sailing.helm.getRudder() * 2.4)` on top of its yaw.
- **The HUD.**
  - `sailing.helm.getHeading()` for a compass.
  - `sailing.helm.getTurnRate()` for how much swing is still in her. A heavy ship gives no other way of reading it.
  - `sailing.voyage.rangeAndBearingTo(destination, out)` for range and bearing.
- **Sounds and win/lose.** Arrival is `range <= radius`, and steering off course grows the range by itself. Make it with the engine's end-game systems.
- **Speed.** `sailing.setSpeed(0)` to drop anchor, or raise it for more sail.

## Tuning

| What | Where | Default |
|---|---|---|
| Ship speed | `SailingOptions.speed` / `setSpeed` | 4.5 m/s (~9 knots) |
| Wheel hard over to hard over | `ShipHelmOptions.hardOverSeconds` | 7 s |
| Rate of turn at full helm | `ShipHelmOptions.maxTurnRate` | 0.045 rad/s (~2.6°/s) |
| How long the swing takes to build | `ShipHelmOptions.turnLagSeconds` | 6 s |
| Heel in a full turn | `ShipHelmOptions.maxHeel` | 0.044 rad (~2.5°) |
| Camera roll / heave | `SwellSwayOptions.amplitudeScale` | 1 (~1°, 15 cm) |
| Foam patches | `SailingWakeOptions.streakCount` | 60 |
| Islands alive | `VoyageSceneryOptions.count` | 12 |
| Island spawn / recycle range | `voyageSceneryDistancesForFog(fogFar)` | far − 80 / far + 60 |
| Level kept round the hull | `SailingOptions.renderRegionPadding` | 30 m |

A crossing is the destination's distance divided by the speed. Leave a minute or two of slack in any time limit for steering.

## Common gotchas

- **Trying to move the ship.** It is the level. Translate it and the player falls through the deck. Everything in this recipe exists so you never have to.
- **Islands as `environmentObjects`.** A placed object is a slot in a shared instanced mesh. It cannot move, so it sits at a fixed bearing forever while the helm swings everything else. Spawn scenery through `VoyageScenery`.
- **Forgetting `renderRegionTarget`.** The forged coast stays drawn, welded to the view, and ignores the wheel. With it set, placed objects outside the hull (the forge's islet pines, say) are clipped too — they could not move either.
- **Leaving the forge's coastal water level.** A forged vessel carries `levels[].overrides.waterLevelY`. Under `openWater` it is ignored with a `[Water] waterLevelY ignored` warning — delete it when you switch the level to open water.
- **Calling `applyCamera` before the camera controller.** The controller rebuilds the camera each frame and wipes the sway. Call it after.
- **Pushing the sway past a degree.** The deck rocks with the view, so more reads as a drunk cameraman, not a ship at sea.
- **A turn rate like a rowing boat's.** A galleon comes round in minutes. Keep `turnLagSeconds` — without it the course is just a dial read off the key being held.

## Reference implementation

`samples/sailing-setup.ts` is a `ShipVoyage` wiring helm keys, the sailing kit, a destination and landfall, compile-checked against the live engine. The first game built this way was prod game BV0C7Q6DSA9G, *The Black Galleon*.

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Voyage on a forged galleon: take the wheel on the quarterdeck and steer for an island
beyond the haze before the light goes. Third person on foot; the ship is the level.

## World config (set these FIRST)
- Forge the ship with the vessel approach (`--vessel`), environment "sea"
- `worldProfileData.openWater = { "preset": "ocean", "seaLevelY": <waterline> }`
- `fogConfig.far` ~1700 so islands rise out of the haze

## Core systems
- Sailing — `createSailing` from `engine/sailing/`: voyage, wake, moving sea, swell, clipped level
- Helm — Z / X + PORT / STBD via `registerCustomAction`, live within 3.5 m of the wheel
- Scenery — 12 recycled islands + one `addLandmark` destination

## Win / lose conditions
- Win: range to the destination under 30 m
- Lose: the daylight timer runs out

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Top-centre: compass heading + swing marks
- Top-left: range and bearing to the island
- Top-right: daylight timer
```
