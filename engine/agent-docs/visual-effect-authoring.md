# Adapt and author visual effects

Use this guide when the request changes the look or motion of an effect, or the
catalog has no close match. [visual-effects.md](visual-effects.md) is the catalog
and playback reference. All examples below are ordinary game code, usable in
Creator and the GDK. Keep the implementation in the game's own files; importing
engine primitives does not require editing the engine or registering a global preset.

## Choose the smallest useful change

First identify the event, silhouette, motion and ending: for example, a frost
impact with a low expanding ring, rising motes and a short residual mark. Choose
by motion, not just colour. A recoloured explosion is not a sustained flame jet.

| Desired change | Use | Example |
|---|---|---|
| Same mechanism, different scale, colour or timing | Spawn options | Narrower `continuousBeam`, a longer trail, a smaller fire |
| Same particle/layer mechanism, different behaviour | `recipe` on `burst` / `explosion` | Falling magical motes, smoke-free ice fragments, an inward blast |
| Several readable phases/layers | A game-local function composing handles | Ice nova + cooling motes + a surface mark |
| Different geometry or trajectory | `custom()` + `CustomEffectVisual` | Rotating runes, expanding cage, object-shaped energy shell |
| Object mesh must fade or disappear | Built-in `transition()` | Retains the original materials and restores them on cancellation |
| World weather or movement-specific wake | The dedicated system | Rain, snow, boat wakes; see `visual-systems.md` |

Use constants with `satisfies` for authored options, and give the game helper a
name tied to its meaning (`castIceNova`, `startEngineHeat`). Keep gameplay damage,
collision, healing and audio in the gameplay system. Cosmetic changes should not
quietly alter the ability's rules.

## Adapt a recipe without changing other effects

`BurstSpawnOptions.recipe` is `Partial<BurstRecipe>`;
`ExplosionSpawnOptions.recipe` is `Partial<ExplosionRecipe>`.
The engine copies and validates the recipe at spawn, retains fixed buffer limits,
and keeps the selected preset intact. Do not mutate `BURST_PRESETS` or
`EXPLOSION_PRESETS` to customize one game or ability.

```ts
import { type BurstSpawnOptions } from 'engine/effects/index.js';

const coldMotes = {
    radius: 1.4,
    recipe: {
        motion: 'float', count: 20, color: 0xd9ffff, endColor: 0x6285bb,
        duration: 2, speed: 0.5, curl: 2, size: 0.025, flutter: 0.15, ring: 0,
    },
} satisfies BurstSpawnOptions;

// effects is cached from getVisualEffects(engine) during load().
effects.burst('fireflies', impactPosition, { ...coldMotes, seed: eventSeed });
```

The complete, compile-checked version is
[samples/adapt-visual-effects.ts](samples/adapt-visual-effects.ts).
It also demonstrates a layered ice nova and a repeating custom aura.

Precedence is **preset → recipe override → top-level spawn option**. For example,
`recipe.color` and `recipe.duration` set the defaults for that adapted effect;
top-level `color` and `duration` override those values for one trigger. The recipe
keeps its other colours, particle counts and motion. Spreads are shallow: when
combining two option constants, merge their `recipe` objects explicitly.

| Recipe | Fields worth changing together |
|---|---|
| Burst motion | `motion`, `speed`, `gravity`, `spread`, `curl`, `birthWindow` |
| Burst shape/palette | `count`, `size`, `stretch`, `color`, `endColor`, `glow`, `ring`, `tumble`, `flutter` |
| Explosion silhouette | `motion` (`outward`, `inward`, `column`, `disk`), `lift`, `speed`, `swirl`, `debrisStretch` |
| Explosion layer balance | `fire`, `smoke`, `sparks`, `debris` counts; `flash`, `ring` strengths |
| Explosion palette | `color`, `smokeColor`, `sparkColor`, `debrisColor`, `ringColor` |

Recipe counts are high-quality baselines; spawn `amount` and device `quality`
scale them before capacity clamping. Burst `size` is relative to spawn `radius`,
`stretch` is the particle's long-axis multiplier, `spread` is an angular cone in
radians, and `birthWindow` is a fraction of normalized lifetime. Motion coefficients
are artistic values evaluated against normalized age, not physical velocities
in metres per second. Increasing duration slows the same authored trajectory.
Unsupported motions and non-finite numbers throw; numeric ranges are bounded.

The base preset still matters: `flame` uses opaque emissive lobes with a narrowing
plume, `confetti` uses a rainbow palette, and `dust` flattens its launch direction.
Use another base (such as `magic`, `smoke` or `fireflies`) when those behaviours
are unwanted. `recipe` is not a universal option on fire/shield/trail/beam APIs.
Use their published controls, composition, or the custom path for a new mechanism.

Emitters accept the same adaptation in `burst.recipe` and snapshot it when the
emitter starts. Existing particles finish when the emitter stops. To change the
recipe of a running emitter, stop it and start a new one. Spawn again to change
the recipe of an existing one-shot; `seek()` only changes its age.

These recipe objects are local visual configuration. The existing projectile
`ExplosionConfig` and network `ExplosionEvent` do not transport them. Keep a named
game-specific visual helper on both peers and replicate its event name, seed and
parameters if needed; retain the game's existing authoritative damage logic.

## Compose an ability

Use one function with a few intentional layers: a core that establishes the
shape, accents that communicate motion, then smoke or a mark if the event needs
residue. Return a cancellation function or retain the individual handles. The
sample's `castIceNova()` gives every layer a deterministic seed derived from the
same event seed and a distinct role. Each layer consumes an active pool slot.

Cache `getVisualEffects(engine)` in the game's load path. Trigger the composition
from an actual gameplay event (hit, ability start/end, landing), not every update
frame. For phased abilities, use the gameplay timer/state machine or a single
custom effect's age; avoid `setTimeout`, `Date.now` and separate animation loops.
Stop entity-bound effects when the entity/ability ends. Level teardown is a final
cleanup guarantee, not a replacement for normal lifecycle cancellation.

## Create a new mechanism in game code

Copy [samples/custom-visual-effect.ts](samples/custom-visual-effect.ts) into the
game's code. It is a complete rotating rune halo with deterministic variation,
two art styles, quality-scaled instances and no per-frame allocation. Change its
geometry, trajectory, envelope and material as the requested mechanism needs.

In that sample, edit the constructor to change each rune's geometry/material,
`rearm()` to change density or seeded variation, and `setProgress()` to change
the effect's shape over time. The `envelope` controls appearance/disappearance;
`radius`, `angle` and the instance position control expansion, orbit and rise.
Changing `turns` or `rise` needs only spawn options. Adding a new authored control
means adding it to `RuneHaloOptions`, its defaults and `rearm()` validation before
using it in the trajectory. Keep those changes together in the game's copied file.

The small contract is:

```ts
interface CustomEffectDefinition<Options extends CustomEffectOptions> {
    defaults: Readonly<Options>;
    create(scene: THREE.Scene, style: VFXStyle): CustomEffectVisual<Options>;
}
```

Keep the definition at module scope. Its object identity and art style are the
pool key; constructing a new definition for each trigger defeats reuse. Extend
`CustomEffectOptions` for authored parameters and spread
`DEFAULT_CUSTOM_EFFECT_OPTIONS` into a complete defaults object.

```ts
import { runeHalo } from './custom-visual-effect.js';

const hit = effects.custom(runeHalo, contactPosition, {
    direction: contactNormal, turns: -0.4, rise: 0.6, seed: eventSeed,
});
const aura = effects.custom(runeHalo, characterObject, {
    loop: true, duration: 2, radius: 1.2,
});
hit.seek(0.35); // absolute normalized age, useful for a fixed preview
aura.stop();
```

The returned `FollowEffectHandle` supports `isAlive`, `stop()`, `seek()` and
`moveTo()`. `Object3D` targets supply world position; `Vector3` targets are read
by reference. Custom effects follow position, not the target's rotation. Apply
the supplied world-space `direction` in `rearm()` if the mechanism needs an axis.

`duration` is a positive cycle length, bounded like a one-shot burst. `loop: false`
finishes at age 1; `loop: true` repeats age 0–1 until stopped. Seeking a looping
effect to 1 wraps to the next cycle's start. The scene supplies style, quality and
the next seed unless explicitly overridden at spawn. Other defaults come from
the definition. Nested custom data belongs to the author: copy mutable arrays or
objects in `rearm()` if external changes must not affect active instances.

| Method | Responsibility |
|---|---|
| Constructor | Allocate owned geometry, materials, fixed buffers and scratch values once; add meshes to `group` |
| `rearm(position, options)` | Reset every parameter and old state; copy position/options; validate custom fields; generate seeded variation; select active instance count |
| `setProgress(t)` | Compute the image at absolute normalized age, including backwards seeks; no timers, random sampling, geometry creation or scene parenting |
| Inherited `retire()` | Hide the group for reuse |
| Inherited `dispose()` | Remove the group and dispose owned mesh geometry/materials/instance buffers |

Call `super(scene, 'EffectName')` from the constructor. The system invokes
`setProgress(0)` after rearming. Use exported `effectRandom(seed)` during rearm,
`effectDensity(quality)` for density, `effectNumber` for finite bounded values,
and `updateEffectAttribute(attribute, liveCount)` after writing instance/vertex
data. The last helper marks only the live prefix for GPU upload; use vertex count
for geometry attributes and instance count for instance attributes.

The base owns only meshes you create. Never parent a gameplay mesh into its group
or give it a material shared with gameplay objects. Textures, render targets,
listeners, lines and other non-mesh resources need explicit cleanup overrides;
call the base cleanup and make repeated disposal safe. If a borrowed object is
modified, restore it on retirement as well as disposal. Prefer the built-in
`transition()` when its material/visibility ownership already solves the request.

The shared manager applies gameplay time, pause, bounded concurrency, oldest-effect
eviction, stale-handle safety and level/world teardown to custom effects too.
Never call its `update()` or `dispose()` from a game template. To prepare a known
custom material before gameplay, spawn that definition once during load and stop
it before the engine's scene warmup. Automatically preparing built-ins does not
enumerate game-local definitions.

## Find the implementation you need

All paths in this table are engine module paths; `.js` imports resolve to the
TypeScript source in this repo. Start from signatures in the engine API digest
and read implementation only when the authoring change needs its actual math.

| Concern | Source |
|---|---|
| Layered burst recipes and trajectories | `engine/effects/ExplosionPresets.ts`, `ExplosionVisual.ts` |
| Particle motion modes and recipes | `engine/effects/BurstPresets.ts`, `BurstVisual.ts` |
| Paths, branches, helices, beam pulses | `engine/effects/LightningVisual.ts` |
| Continuous flames, shields, planar marks | `FireVisual.ts`, `ShieldVisual.ts`, `SurfaceVisual.ts` under `engine/effects/` |
| Movement history and fading tails | `engine/effects/RibbonTrailVisual.ts` |
| Target-material restoration | `engine/effects/TransitionVisual.ts` |
| Custom contract / mesh ownership | `engine/effects/CustomEffectVisual.ts`, `EffectShapes.ts` |
| Pooling, handles, emitters and clock | `engine/effects/VisualEffects.ts` |

Game authors should keep custom looks local. When contributing a reusable engine
preset instead, add its type and recipe at the family source, expose the public
type through `engine/effects/index.ts`, and add a deterministic sample/test. For a
new family, also wire lifecycle/pooling and register it in `debug/EffectWorkshop.ts`
and its fixture in `debug/EffectWorkshopScenes.ts`; update the catalog docs.
Some workshop families derive their presets from the tables, while beams and
the fire/burst grouping use explicit lists. Check that the new preset is visible.

## Verify the authored result

1. Run the game's normal type/check command. These reference samples are compiled
   by the engine's `pnpm run check`; copied samples must pass the game's own check.
2. Trigger from a fixed position/direction/seed. Inspect first appearance, peak,
   tail and completion; seek backwards and replay a pooled instance with a new seed.
3. Inspect daylight/night, both styles and lower quality, near and far, against
   an opaque foreground object. Preserve a readable shape without bloom.
4. Verify entity cancellation, pause/resume, level unload and repeated spawning.
   An effect disappearing under concurrency pressure is different from a bad
   lifetime curve: inspect the manager's `stats` when diagnosing it.
5. Check both renderers. Measure dense combinations after warmup, including the
   game's actual bloom/grade path, and separate initialization from frame cost.

Inside this repo, `pnpm --dir game effects:preview` rebuilds the built-in workshop;
`game/scripts/profile-effects.mjs` profiles its catalog and compares fixed images.
It does not automatically discover game-local custom definitions. Preview those
in a small fixture in the game (Creator or `bitmagic dev`) using fixed inputs, or
temporarily add the definition to a repository workshop fixture when contributing
an engine effect. The compiled rune-halo sample is also exercised by the effect
authoring tests. Never claim runtime or visual validation from type checking alone.
