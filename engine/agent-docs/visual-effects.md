# Visual effects: fire, beams, shields, trails, surfaces and transitions

These are built-in procedural effects, available in Creator and the GDK. Start
with the closest shape and motion, then adapt it to the game's art direction.
Use generated assets only when the requested look actually needs a texture/model.
Use
`getVisualEffects(engine)` from `engine/effects/index.js` during the game's `load()`, once the scene exists. It prepares hidden instances so the engine's
normal scene warmup compiles their materials before gameplay.
GameEngine updates it with **gameplay time**, freezes it on pause, stops it when a
level unloads, and disposes it when the game unloads. Do not update or dispose the
shared system from a template. All positions/directions are world space.

## Choose a starting point

| Need | Starting point |
|---|---|
| Play an existing effect | Catalog below; `samples/visual-effects.ts` shows integration and cancellation |
| Change scale, timing, density, direction or colour | Per-spawn options in Tuning; keep constants in the game's own code |
| Change particle motion, palette, layer balance or proportions | Burst/explosion `recipe` overrides; [visual-effect-authoring.md](visual-effect-authoring.md) |
| Build an ability from several layers | Game-local composition in `samples/adapt-visual-effects.ts` |
| No existing mechanism fits | `effects.custom(definition, target, options)` and `samples/custom-visual-effect.ts`; the engine still owns pause, limits and teardown |

Do not force every request into an existing preset. The authoring guide explains
which changes are data, when to compose layers, and when to write custom geometry.

## Catalog

90 presets: 16 explosions, 26 particle bursts, 10 lightning/beam patterns,
5 sustained fires, 6 shields, 5 moving trails, 6 surface effects, 6 object
transitions and 10 combat impact materials. Presets share bounded pools; a larger catalog does
not allocate every effect when a game starts.

| Family | Presets | Differences |
|---|---|---|
| Explosion | `blast`, `fireball`, `fragmentation`, `plasma`, `emp`, `frost`, `poison`, `dust`, `inferno`, `napalm`, `volcanic`, `steam`, `sonic`, `implosion`, `arcane`, `shatter` | Layered outward blasts, low spreading fire, vertical jets, a flat pressure wave, inward collapse with a delayed flash, and long crystal fragments |
| Particle burst | `sparks`, `ricochet`, `dust`, `smoke`, `flame`, `embers`, `frost`, `poison`, `heal`, `magic`, `portal`, `confetti`, `splash`, `steam`, `ash`, `leaves`, `bubbles`, `fireflies`, `snowflakes`, `stardust`, `tornado`, `fountain`, `shockwave`, `charge`, `comet`, `petals` | Cones, plumes, orbits, inward spirals, tumbling fall, floating motes, widening funnels, ballistic fountains, expanding rings and tapered trails |
| Lightning/beam | `lightning`, `tesla`, `chain`, `laser`, `energy-beam`, `storm`, `ion`, `railgun`, `healing-link`, `tractor-beam` | Return strokes, dense forks, chained contacts, straight beam, rotating helices, traveling rail pulse, flowing wave and widening helix |
| Sustained fire | `torch`, `campfire`, `flamethrower`, `engine-exhaust`, `fire-wall` | Continuous rising flames, wide hearth, directed jet, blue exhaust and spreading wall; smoke and embers vary by recipe |
| Shield | `bubble`, `dome`, `hex-shield`, `barrier`, `hit-ripple`, `shield-break` | Following shells, ground dome, panels, contact rings and outward fragments |
| Moving trail | `missile`, `smoke-trail`, `sword`, `magic-trail`, `ribbon` | Short hot tail, rising smoke puffs, slash ribbon, magical tail and long ribbon |
| Surface | `scorch`, `bullet-mark`, `cracks`, `wet-splash`, `puddle`, `ripples` | Normal-aligned planar marks, spreading splashes, persistent pools and expanding rings |
| Object transition | `dissolve`, `materialize`, `teleport-in`, `teleport-out`, `spawn`, `despawn` | Alpha-hashed fading of actual object meshes, with scattering fragments, scanning rings or floor rings |
| Existing combat impact | `metal`, `stone`, `wood`, `energy`, `ice`, `glass`, `sand`, `mud`, `shield`, `electric` in `IMPACT_EFFECT_PRESETS` from `engine/AttackVFX.js` | Glowing sparks vs lit debris; fine grains, heavy clumps, long shards, flat shield chips and fast electrical streaks |

Rain, falling snow, boat wakes and ski powder have their own environment/movement
systems. Keep using those (`weather-snow.md`, `mechanic-boat-racing.md`,
`mechanic-skiing.md`). The new `snowflakes`, `leaves` and `ash` are local bursts
or emitters for a spell, object or small area, not a replacement for world weather.
`CircleTelegraph`, `ConeTelegraph`, `LineTelegraph`,
`GroundZone` and `OrbEffect` remain available for attack warnings and hazards.

## One-shot effects

```ts
import * as THREE from 'three';
import { getVisualEffects } from 'engine/effects/index.js';

const effects = getVisualEffects(this.engine);
const at = new THREE.Vector3(0, 0.1, 0);
const blast = effects.explosion('fireball', at, {
    radius: 4, duration: 1.8, amount: 1.5, variance: 0.8, seed: 42,
});
effects.burst('heal', at, { radius: 1.5, duration: 1.2 });
effects.burst('sparks', at, { direction: surfaceNormal, amount: 0.5 });
effects.lightning([staffTip, enemyPosition], { preset: 'tesla', seed: 17 });
effects.lightning([staffTip, enemyA, enemyB], { preset: 'chain' });
effects.beam(muzzlePosition, hitPosition, 'laser', { color: 0xff5577 });
effects.explosion('implosion', at, { radius: 3, duration: 1.5 });
effects.burst('fountain', at, { direction: surfaceNormal, radius: 1.2 });
effects.beam(staffTip, allyPosition, 'healing-link');
// Optional manual cancellation; a stale handle can never cancel a reused slot.
blast.stop();
```

`lightning()` takes 2–9 ordered points. Endpoints stay pinned, including vertical
bolts. Duplicate adjacent points are skipped. `beam()` and `lightning()` snapshot
the path. Use `continuousBeam()` below for endpoints that move during playback.
They do **not** raycast, select targets or apply damage.
`beam()` accepts `laser`, `energy-beam`, `ion`, `railgun`, `healing-link` and
`tractor-beam`. A tractor beam's animated helix widens toward its target; a railgun
pulse travels from source to target. These names do not imply gameplay forces.

All these APIs produce visuals only: damage, collision, healing, status effects,
terrain destruction, audio and multiplayer events remain the game's responsibility.
A green burst does not restore HP. An explosion's decorative debris does not
create physics bodies. Explosion rings lie horizontally at the supplied position.
Burst rings follow `direction`; portal/charge rings face across the local XY plane.
Supply a surface contact position/normal when a burst ring must sit on terrain.

## Sustained fire, tracked beams and shields

```ts
const fire = effects.fire('flamethrower', muzzleObject, {
    direction: aimDirection, radius: 0.8, duration: 0, amount: 1.2,
});
fire.setDirection(nextAimDirection); // world-space aim
const beam = effects.continuousBeam(muzzleObject, movingEnemy, 'laser');
beam.setEndpoints(muzzleObject, nextEnemy);
const shield = effects.shield('hex-shield', characterCenter, { radius: 1.5 });
shield.hit(contactPosition, contactNormal); // a separate expiring ripple
shield.break(); // retire the shell and emit expiring fragments
fire.stop();
beam.stop();
```

These accept `Object3D` targets (read their world position each gameplay update)
or `Vector3` targets (read by reference). They follow position; fire direction and
barrier normal are explicit world-space vectors. `moveTo()` changes the followed
target. Duration zero keeps fire, beams and the four shield shells alive until
stopped; positive durations expire in seconds. Shield hit/break recipes expire
by default. A shield never blocks gameplay damage on its own.

## Trails, surface marks and object transitions

```ts
const trail = effects.trail('missile', projectileObject, {
    width: 0.12, lifetime: 0.5, teleportDistance: 8,
});
trail.stop();  // stop new samples; the existing tail finishes
trail.clear(); // cancel the tail immediately
effects.surface('scorch', contactPosition, {
    direction: contactNormal, radius: 0.8, duration: 30,
});
effects.surface('puddle', floorPosition, { radius: 1.5 });
const transition = effects.transition('teleport-out', characterObject);
// transition.stop() cancels and restores the original visibility/materials.
```

Trails retain at most 96 samples, interpolate births on a time grid and clear
history across jumps larger than `teleportDistance`. `duration` controls emission;
`lifetime` controls the remaining tail. Trail width is independent of radius.

Surface `direction` is the contact normal (world up by default). Marks sit slightly
above that plane. They do not project onto curved geometry or follow moving
surfaces. Scorch, bullet marks and cracks last 30 seconds by default; puddles are
persistent. A zero duration makes any mark persistent. Ripples are decorative;
puddles do not change terrain roughness or simulate fluid.

Transitions fade the target's actual mesh materials using isolated alpha-hashed
copies. Other objects sharing those materials are unchanged. Completion restores
the originals and leaves incoming targets visible or outgoing targets hidden;
cancellation, pool eviction and level unload restore the prior visibility.
Starting a transition on an overlapping parent/child cancels the previous one.
Use ordinary Three.js mesh materials that support opacity/alpha hashing; custom
shaders and custom opacity nodes need their own integration. Targets must contain
nonempty meshes and at most 128 distinct materials. Cached copies are bounded and
may compile on first use. Materials changed by gameplay during a transition should
be coordinated with its lifetime. Decorative transition particles use the initial
world bounds; the target mesh may continue animating.

## Repeated smoke, particles and auras

```ts
const fire = effects.emit('flame', campfirePosition, {
    interval: 0.18,
    duration: 0, // keep emitting until stopped or the world/level unloads
    burst: { radius: 0.8, amount: 0.8, seed: 42 },
});
const smoke = effects.emit('smoke', campfirePosition, {
    interval: 0.4, burst: { radius: 0.65, amount: 0.5 },
});
fire.moveTo(nextPosition); // future births move; already-emitted particles do not
fire.stop();              // particles already alive finish naturally
smoke.stop();
```

The emission schedule uses elapsed seconds, not frames. Catch-up after a long
stall is limited to the four newest births per emitter; already-expired bursts
are skipped. This prevents a resumed tab from spawning minutes of missed smoke.

## Tuning

| Control | Meaning |
|---|---|
| `radius` | World-space visual size for explosions, bursts, fire, shields and surfaces; transition particle spread follows the target bounds. Trails use `width`. Never damage radius |
| `duration` | One-shot bursts/explosions/bolts: 0.01–120 seconds. Fire/shields/surfaces/trails/tracked beams: 0 means persistent, positive values up to 86400 seconds; trails then drain. Transitions always finish, with a minimum of 0.01 seconds |
| `amount` | Particle/panel density, 0–3; independent of radius. Trail amount scales width. Lightning amount controls branch count and zero hides the whole bolt |
| `variance` | Irregularity of size/birth timing/path motion, 0–1 |
| `seed` | Reproducible layout; zero is valid. Omit for an independent new layout from the system's seeded sequence |
| `style` | `voxel` or `low-poly`; default follows the game's art style |
| `quality` | `low`, `medium`, `high`; reduces particle/branch counts while preserving motion and silhouette |
| `color` | Main colour; recipe smoke, debris and secondary colours retain their identities |
| `direction` | Burst/fire axis or surface/shield contact normal; zero uses world up (forward for a shield panel) |
| `width`, `roughness`, `branches` | Lightning width in metres, path displacement multiplier, branch count per span (0–6; -1 uses preset) |
| `layers` | Explosion: individual 0–2 strengths for `flash`, `fire`, `smoke`, `sparks`, `debris`, `ring`. Burst: `{ particles, ring }` booleans. Lightning: `{ core, glow, endpoints }` booleans |
| `recipe` | Bursts/explosions only: a typed per-spawn `Partial<BurstRecipe>` / `Partial<ExplosionRecipe>` changes motion, counts, secondary colours and proportions without editing shared presets. `emit()` accepts it inside `burst`. See the authoring guide for precedence and limits |

For explosions, `amount: 0` removes particles but keeps flash/ring; set their layer
strengths to zero as well for an entirely invisible effect. Burst rings are also
independent of particle amount. Upper density limits are enforced per primitive.
Non-finite numbers and unknown presets/qualities fail explicitly.

`getVisualEffects(engine, options)` selects quality from the device tier on first
access (minimal/low → low; medium → medium; high/ultra → high). Options apply when
that scene's system is first created. Defaults allow 48 active effects, retain up
to 64 reusable slots, and allow 16 sustained emitters. The oldest effect/emitter is
retired when its active limit is reached. If `maxActive` exceeds `maxRetained`,
active slots can reach `maxActive`; idle retention shrinks as effects retire.
Explosion buffers additionally keep up to eight idle bursts per scene. Persistent
fires, shells, marks, trails, beams and transitions share the same active limit.

For standalone rendering, construct `new VisualEffects(scene,
{ ...DEFAULT_VISUAL_EFFECTS_OPTIONS, ...overrides })`, then own its `update(dt)` /
`dispose()` and call `ExplosionVisual.disposeScene(scene)` at final scene teardown.
This is unnecessary inside GameEngine. Reuse the system; never construct it per hit.
In standalone scenes, call `prepare()` before your renderer warmup. First access
after loading, a newly requested art style, target material for a transition, or changed scene lighting can still
compile a new material pipeline; pooled replay retains those buffers.

## Existing projectile explosions

`ExplosionConfig` keeps all existing fields and defaults. It now also accepts
`preset`, `amount`, `variance`, `quality` and `layers`; `visualStyle` and `seed`
remain available. Built-in explosive weapons automatically get the improved
blast animation. Set a preset in a custom weapon's projectile explosion config
for a different recipe. Damage, destruction and damage radius are unaffected.

For multiplayer, `sendExplosion` / `onExplosion` accept all these optional visual
fields via `ExplosionEvent`. Broadcast the chosen seed and visual fields along
with the original damage fields. Pass them through on the receiving side; older
receiver code that only copies radius/colour will still show a default blast.
For example, send `{ ...config, position: { x, y, z } }` and construct the remote
visual with `{ ...data, enabled: true, duration: data.duration ?? 1,
damage: 0, damageRadius: 0 }`. Keep the existing self-damage/destruction handlers
from `multiplayer-combat-sync.md`; visual replication does not replace them.

## Inspection and limits

Run `pnpm --dir game effects:preview` to build the interactive workshop without
starting a server or running captures. Open `game/scripts/effect-workshop.html`
directly in a browser. It includes all JavaScript and works offline. Rebuild after
editing effects and refresh the tab. The editable shell is
`game/scripts/effect-workshop.template.html`; opening it in a browser forwards
to the built workshop, preserving the renderer query and URL fragment.

Run `node game/scripts/preview-effects.mjs /tmp/effect-workshop webgl motion` and
repeat with `webgpu`. The standalone gallery exposes fixed seeds, normalized age,
playback, amount/variance, quality, styles, camera distances, night lighting,
layer isolation and a depth-test occluder. It uses the real engine primitives,
without bloom/post-processing. `before` compares explosions with Git HEAD.
The view selector shows pages of up to eight effects or one named preset at full
size. The workshop exposes 100 effects in 13 families: the 90 presets above plus
the existing muzzle flash, limb trail, snow, rain, boat wake and five telegraph
systems. Fire/smoke and lasers/beams have dedicated top-level categories. Captures
and motion clips cover every page. Unsupported layer views and tuning controls
are disabled for existing systems that use their own authored settings.
Captures, clips and metrics are written beside the HTML. No server is started;
the script closes its browser on success/failure.

For per-preset CPU/GPU profiling and exact before/after image comparisons, use
`game/scripts/profile-effects.mjs` against separately retained workshop builds.
See `game/docs/effect-performance.md` for the measured results and commands.

The effects are stylized meshes, not fluid simulation, flipbooks or volumetric
smoke. Solid lobes intentionally dissolve by shrinking rather than transparent
sorting. There is no per-effect dynamic light. No effect-specific render targets,
textures or backend-specific shaders are allocated by the new procedural library.
The existing weather showcases retain their own textures/compute paths and
the muzzle flash retains its existing light. See the compile-checked
`samples/visual-effects.ts` for integration and `visual-systems.md` for the rest of
the engine's built-in visuals.
