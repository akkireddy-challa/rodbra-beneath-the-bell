# Lighting best practices (WebGPU-safe dynamic lights)

## The one rule: keep the scene's light COUNT constant

Adding or removing a `THREE.PointLight`/`SpotLight` at runtime — or hiding a light's
parent with `.visible = false` — changes how many lights three.js compiles into every
material's shader. On the **WebGPU renderer** that recompile is **synchronous**
(`device.createRenderPipeline`) and costs **300–500 ms**: a hard, visible frame freeze.
It is cheap/deferred on WebGL, so the stutter only appears on WebGPU.

Changing a light's `intensity`, `position`, `color`, `distance`, or `decay` is **free**
(those are shader uniforms). So: never change the *number* of lights to control lighting
— change *intensity* instead, and keep a fixed set of lights alive.

Budget: aim for **≤ ~8 dynamic point/spot lights** in the scene at once. Each one costs
per-pixel shading over the whole frame, so fewer-but-pooled beats many.

## Use a light pool (`PointLightPool`)

The engine provides a fixed-size pool: N always-visible lights that follow the nearest
"logical" sources each frame. The count never changes, so no recompile.

```ts
import { PointLightPool, DEFAULT_POINT_LIGHT_POOL_OPTIONS, PointLightSource } from 'engine/PointLightPool.js';

// Create once. focusFromCamera pools auto-tick from the engine each frame.
this.lampPool = new PointLightPool(this.engine.scene, {
    ...DEFAULT_POINT_LIGHT_POOL_OPTIONS,
    poolSize: 3,            // exactly 3 real lights, forever
});

// Register every logical lamp (positions/colors). Mutate `intensity` in place to animate
// (flicker, broken blink, blackout) — the pool reads them live.
const sources: PointLightSource[] = lamps.map(l => ({
    position: l.pos, color: l.color, intensity: l.baseIntensity, distance: 32, decay: 1.8,
}));
this.lampPool.setSources(sources);
// ...each frame, set source.intensity for flicker; the pool aims the 3 lights at the
// nearest sources automatically. Dispose on teardown: this.lampPool.dispose().
```

For a non-camera focus (e.g. follow the player, or update on your own cadence), pass
`focusFromCamera: false` and call `pool.aimAt(focusPosition)` yourself each frame.

## Anti-patterns — do NOT do these (all caused real WebGPU freezes)

**1. Toggling `light.visible` to cap active lights.** Creating one light per lamp and
enabling only the nearest few:
```ts
// ❌ BAD — flips the light count every few steps as you walk → recompile freeze
lamp.light.visible = (idx === nearest0 || idx === nearest1);
```
Fix: a `PointLightPool` (constant count), or set `intensity = 0` for "off" instead of
`visible = false`.

**2. Hiding a light-bearing object's parent.** Setting a mesh `.visible = false` also
drops its child lights from the count:
```ts
// ❌ BAD — keycard mesh carries a child glow PointLight; hiding the mesh drops the light
pickup.mesh.visible = false;
```
Fix: hide the visual meshes/sprites, but keep the light and set `intensity = 0` (or pool
the glow). Sprites/meshes toggling `.visible` is fine — only *lights* trigger recompiles.

**3. Adding/removing lights on game events.** Removing a glow on pickup and re-adding it
on drop, or spawning an NPC that adds its own lights:
```ts
// ❌ BAD — fires on every keycard pickup/drop and NPC spawn → repeated freezes
mesh.remove(glowLight);            // pickup
character.add(eyeLight);           // stalker/NPC spawn
```
Fix: pre-create the lights in a pool (or once, reparented to an always-visible node) and
drive `intensity`/`position`. Never add/remove during gameplay.

**4. A light per explosion, muzzle flash or impact spark.** The most tempting one, because
a blast that does not brighten the street looks limp, and a light created at the moment of
the blast is the obvious way to fix that:
```ts
// ❌ BAD — the first grenade of the run froze Splatter City for 1.3 s; a cluster (three
// blasts, three new lights) for 1.5 s. Measured, on WebGPU.
const flash = new THREE.PointLight(color, 60, radius * 4);
scene.add(flash);                       // +1 light → every pipeline recompiles, synchronously
setTimeout(() => scene.remove(flash), 300);   // −1 light → recompiles again
```
Fix: a `PointLightPool` sized for the most blasts that can overlap (three is plenty), plus
one `PointLightSource` per pooled effect. Fire a blast by writing `position`, `color` and
`intensity` on its source; end it by setting `intensity = 0` and parking the source far
outside the world so an idle slot cannot out-compete a live one for a real light. Same run,
after the change: first grenade 112 ms, cluster 23 ms, light count and program count both
flat.

While you are there, pre-create the effect's MESHES too and warm their pipelines behind the
loading screen (`renderer.compileAsync(scene, camera)` with them briefly visible). A
material compiles the first time it is actually drawn, and left alone that lands on the
first grenade rather than on the load.

## Time of day is `lightingConfig` — and the sun's ANGLE is part of it

For a coordinated starting point, set `lightingConfig.preset` in world.json (or
on the active `levels[]` entry): `stylized-day`, `golden-hour`,
`overcast-forest`, or `moonlit-street`. These pair sun direction and colour with
ambient illumination and fog. They work with both voxel and low-poly art.
Individual lighting fields and explicit `fogConfig` fields override the preset;
remove old explicit fields when you want the preset to own them. `ambientColor`
tints the existing ambient-floor light without adding another light.

Presets are opt-in. Games without one retain the classic defaults. They do not
replace a skybox image, so choose a skybox that matches the mood. Preview all four
with `node game/scripts/preview-visuals.mjs /tmp/visual-workshop webgpu` from the
repo root, then open the generated `visuals.html` and select **lighting**.

Dusk, dawn, a low winter sun: all of it is `worldProfileData.lightingConfig` in world.json,
no game code. The intensities are multipliers on daylight; the two angle fields are what
make shadows long — colour and dimness alone never move a shadow.

```json
"lightingConfig": {
  "sunElevationDeg": 12,          // height above the horizon; dusk 8–15, noon default ≈55
  "sunAzimuthDeg": 250,           // bearing the light comes FROM, clockwise from +Z
  "sunColor": "#ffa564",          // warm, saturated dusk light
  "sunIntensity": 0.8,
  "environmentIntensity": 0.35,   // the sky image lights surfaces less
  "skyboxIntensity": 0.7,
  "ambientFloor": 0.12            // keep the shadow side readable
}
```

Pair the azimuth with a skybox whose bright horizon sits on that side (`bitmagic generate
skybox` for a dusk sky), and mind the fog: `fogConfig.color` should match the horizon, not
the old blue day. Emissive things — glowing eyes, neon, lamps — read far stronger once the
scene is darker, which is often the point.

## Mood after lighting: color grade + vignette (`renderConfig`)

Saturation, contrast, warmth and darkened edges are a final-image grade, not a lighting
change — set them in `worldProfileData.renderConfig`, never with a custom pass or a
CSS overlay. Both run after tone mapping on both renderers; every field is optional and
neutral by default, so set only what you want.

```json
"renderConfig": {
  "colorGrading": { "enabled": true, "saturation": 0.7, "contrast": 1.15, "temperature": -0.3 },
  "vignette":     { "enabled": true, "intensity": 0.6, "radius": 0.5 }
}
```

`colorGrading` also takes `brightness` (-1..1), `tint` (green −/magenta +) and
per-channel `lift`/`gamma`/`gain` triples; `vignette` takes `softness` and `color`.
Keep grades subtle: saturation 0.7–1.4, contrast 0.9–1.3, temperature ±0.5.

For gameplay changes call the engine at runtime — value changes cost nothing, and only
switching `enabled` rebuilds the post-FX chain:

```ts
// Low health: drain the colour and close in a red vignette.
const hurt = 1 - hp / maxHp;
engine.setColorGrading?.({ enabled: true, saturation: 1 - 0.8 * hurt });
engine.setVignette?.({ enabled: true, color: '#8a0000', intensity: 0.7 * hurt });
```

Each setter merges over the current values. The next level load re-applies world.json.

## See also

- `mesh-level.md` — the interior preset a `MeshLevel` applies (sun through `lightingConfig`, JSON point lights through a pool, cached spot shadows)
- `@docs performance-best-practices.md` — draw calls, pooling, allocation.
- `@docs custom-shaders.md` — WebGPU vs WebGL material paths (the other renderer gotcha).
