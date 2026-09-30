# Built-in visual systems

The engine keeps voxel/block forms and low-poly forms available. Visual detail
should support the game's `artStyle`, not silently convert a voxel game to smooth
geometry.

## Coastal water

`worldProfileData.waterLevelY` automatically creates the coastal surface after
terrain loads. It samples ground heights at the water mesh's vertices once
(at most 161² queries): shallow water
has turquoise transmission and a narrow foam edge; deeper water absorbs more
light. Waves settle near the shore. Flat geometric normals preserve the facets.
Both WebGL and WebGPU use the same wave and optical parameters.

The legacy ground mask cannot encode negative heights. Saturated mask cells use
baked geometry instead. Depth affects colour and wave amplitude; it never clips
the surface, so narrow channels missed by the mesh still contain water. Actual
terrain occludes dry land. Sun glints track the light relative to its moving target.

Depth here means **static vertical terrain depth**, with an approximate viewing
path. It is not a screen-depth refraction or reflection pass. A bridge, overhang,
or changed terrain cannot be represented exactly by that single height field.
Re-applying `engine.applyWaterSurface(levelY)` rebuilds it after terrain changes.
The open-ocean/boat system remains separate.

For a custom surface, `buildWaterSurfaceMesh(levelY, bounds, sun, heightAt)` takes
an optional world-space ground-height callback; return `null` over missing ground.
Without a callback it uses a deep-water fallback. Geometry, material and time
callback still belong to the returned mesh and its normal engine lifecycle.

## Explosions and impact sparks

For the full preset catalog, sustained fire, tracked beams, shields with hit/break
reactions, moving trails, surface marks, actual-object transitions, elemental
bursts and the shared playback API, read [visual-effects.md](visual-effects.md).
For adapting recipes, composing game-specific effects or creating a new pooled
effect in game code, read [visual-effect-authoring.md](visual-effect-authoring.md).
Explosion recipes now expose particle amount, variance, quality and layer strengths;
impact presets distinguish glowing metal/energy sparks from lit stone/wood/ice debris.

`ExplosionConfig.visualStyle` optionally selects `voxel` or `low-poly`; by default
it follows the game's art style, falling back to voxel. `seed` optionally fixes
the particle arrangement for repeatable scenes. Damage, damage radius and falloff
remain independent of visual motion.

The burst has six draw layers: flash, fire, smoke, sparks, debris and shock ring.
It reuses instance buffers between bursts, keeps up to eight idle bursts per
scene, and frees them when the world is disposed. Motion is evaluated from
normalized age, so varying frame intervals do not change the trajectory.
No dynamic light is created per blast. Bloom is optional; the shapes are readable
without it. `AttackVFX` uses instanced, world-sized spark slivers on both backends.
Fire, smoke and debris use opaque depth-tested geometry. Staggered shrinkage
dissipates the lobes without transparent internal faces; sparks and the ground
ring retain blending. Voxel lobes keep square faces and low-poly lobes keep facets.

## Forge architecture and vehicles

New city-building bakes include window sills/lintels, bay divisions, floor courses,
cornices and entrances. Decoration follows surviving columns under decay. The
parts remain box-built and voxel-bake compatible. Existing baked assets must be
regenerated to pick up these changes.

New vehicle bakes add stepped tire shoulders, rim beads and fasteners, aligned
radial spokes, grille bars and recessed lamp housings. The existing `body.style`
choices (`smooth`, `faceted`, `bricked`) and emissive light slots remain intact.
Bricked bodies retain their steps and studs.
Collapsed profile edges now keep their surviving triangle, closing holes that
previously appeared in bricked fenders and hoods.

## Inspection

From the repo root:

```sh
node game/scripts/preview-visuals.mjs /tmp/visual-workshop webgl
node game/scripts/preview-visuals.mjs /tmp/visual-workshop webgpu
```

Append `motion` to also record four-second water and explosion clips.

This builds a standalone `visuals.html`, renders the real forge outputs and engine
effects, and captures fixed design/close views and explosion phases. The building
and vehicle **Before** switch compares against Git HEAD. Lighting has four mood
panels; water and explosions retain both block and faceted contexts. Metrics record
draws, triangles, geometry count and CPU render submission time. The combined
village profiles 30 frames after warm-up; WebGPU also reports hardware timestamps
when supported (otherwise GPU time is null). It combines six buildings, vehicles,
grass patches, coastal water and a blast. The water-checks view covers negative
seabeds and 4 m / 0.8 m channels in a 1 km world. No server is started, and Chromium
closes on success or failure.

For foliage, use [voxel-terrain-foliage.md](voxel-terrain-foliage.md). For coordinated
lighting, use [lighting-best-practices.md](lighting-best-practices.md).
