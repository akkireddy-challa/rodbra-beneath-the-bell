# Performance Best Practices

## Preserve the visual direction

Build the creator's requested look first, then profile the assembled scene. There is no default
60 FPS acceptance target on desktop or mobile. Keep the efficient implementation practices below
from the start; they help retain the look while removing unnecessary work.

Never omit or reduce detail, lighting, shadows, effects, density, resolution or draw distance
for performance without the creator's approval of the visible tradeoff. An FPS target or a
request to optimize does not itself authorize changing the look. First try changes that preserve
it, such as pooling, batching, shared resources and better queries. Compare the same views and
gameplay before and after to check that an optimization really preserves the result.

When tests show poor FPS or stutter, report the measured rate, platform, renderer and test
conditions, including untested gameplay or hardware. Explain the bottleneck when known; do not
guess one from a still image or a draw-call count. Preserve the visual version and let the creator
choose whether to iterate on performance and which visible compromises to accept. A short
headless run is a smoke test; mobile emulation uses the host GPU and is not a phone benchmark.
Crashes, leaks, stalled rendering and broken controls still need fixing.

## CRITICAL: Avoid O(n²) Entity Loops

**NEVER nest entity iteration loops.** Tower-vs-enemy, projectile-vs-enemy, or any "each A checks each B" pattern creates O(n²) complexity that kills FPS on slower devices.

### Bad — O(n²) targeting:
```typescript
// DON'T: Every tower loops every enemy, every frame
for (const tower of this.towers) {
    for (const enemy of this.enemies) {
        const d = tower.mesh.position.distanceTo(enemy.mesh.position);
        if (d <= tower.range) { /* target */ }
    }
}
```

### Good — Use the engine's SpatialGrid:
```typescript
import { SpatialGrid } from 'engine/SpatialGrid.js';

// Class field — cellSize 10 works well for most games:
private enemyGrid = new SpatialGrid<Enemy>(10);

// Per frame: rebuild grid once, query per tower
this.enemyGrid.clear();
for (const enemy of this.enemies) {
    if (enemy.alive) this.enemyGrid.insert(enemy.mesh.position.x, enemy.mesh.position.z, enemy);
}
for (const tower of this.towers) {
    const nearby = this.enemyGrid.queryRadius(tower.worldX, tower.worldZ, tower.currentRange);
    // Only check nearby enemies — typically 5-10 instead of 50+
    for (const enemy of nearby) {
        const d = tower.mesh.position.distanceTo(enemy.mesh.position);
        if (d <= tower.currentRange) { /* target */ }
    }
}
```

### Alternative — Physics-based spatial query:
The engine provides `PhysicsWorld.queryEntitiesInRadius(center, radius)` which uses Rapier's optimized broad-phase. Use this when entities have physics bodies:
```typescript
const nearby = this.engine.physicsWorld.queryEntitiesInRadius(
    { x: tower.worldX, y: 0, z: tower.worldZ },
    tower.currentRange
);
```

## Object Pooling

**NEVER create and destroy meshes in hot loops.** Projectiles, particles, and effects should be pooled.

### Bad — create/destroy per projectile:
```typescript
fireProjectile() {
    const mesh = this.buildProjectileMesh(); // 10+ new geometries + materials
    this.scene.add(mesh);
}
removeProjectile(proj) {
    this.scene.remove(proj.mesh);
    this.disposeObject3D(proj.mesh); // GPU buffer deallocation + GC pressure
}
```

### Good — Use the engine's ObjectPool:
```typescript
import { ObjectPool } from 'engine/ObjectPool.js';

// One pool per projectile type:
private snowballPool = new ObjectPool<THREE.Group>(
    () => this.buildSnowballMesh(),                  // factory
    (mesh) => { mesh.visible = false; },             // reset
    20                                               // pre-warm count
);

// Spawn: const mesh = this.snowballPool.get(); mesh.visible = true;
// Despawn: this.snowballPool.release(mesh); (don't scene.remove or dispose!)
// Level reset: this.snowballPool.releaseAll();
```

### Effects with a lifetime — use `EffectPool` (this is also a shader rule)

**NEVER dispose an effect's material or geometry when the effect fades.** Disposing the
last material (or, on WebGPU, geometry) that uses a shader program makes three.js delete
the program, and the next spawn compiles it again — a synchronous stall on its first draw.
Measured: 160–210 ms per sword swing and per hit. A burst, trail, arc or spark that is
built per spawn and disposed per fade is a hitch on EVERY spawn, not a memory saving.

`EffectPool` owns the fix: a finished effect is hidden and kept, then re-armed. Implement
four members and let the pool drive the lifecycle:

```typescript
import { EffectPool, PooledEffect } from 'engine/effects/EffectPool.js';

class SparkBurst implements PooledEffect {
    readonly capacity: number;              // buffer size the mesh was built for
    get isFinished(): boolean { return this.age >= this.life; }
    update(dt: number): void { /* move, fade */ }
    rearm(position: THREE.Vector3, count: number): void { /* reset state, mesh.visible = true */ }
    retire(): void { this.mesh.visible = false; }   // KEEP mesh, geometry, material
    dispose(): void { /* geometry.dispose(); material.dispose(); scene.remove(mesh) */ }
}

private readonly bursts = new EffectPool<SparkBurst>();

spawnSparks(position: THREE.Vector3, count: number): void {
    this.bursts.spawn({
        fits: (b) => b.capacity >= count,
        rearm: (b) => b.rearm(position, count),
        create: () => new SparkBurst(this.scene, position, count),
    });
}
update(dt: number): void { this.bursts.update(dt); }   // retires finished effects
dispose(): void { this.bursts.dispose(); }              // the ONLY place GPU resources go
// Hard cap on live effects: this.bursts.retireOldest(overflow) before spawning.
```

The Creator's perf stats warn `[BM PERF] Shader churn: a MeshBasicMaterial program was
deleted and compiled again during play` when an effect bypasses this. That warning is a
bug report: find the effect that disposes per spawn and move it onto an `EffectPool`, or
register its material with `ShaderKeepAlive` (next section).

### Effects you cannot pool — `keepShaderAlive`

Some effects have no re-armable lifecycle: a class the game constructs per attack and
disposes (`CircleTelegraph`, `Explosion`), or a one-shot closure. For those, register the
material configuration ONCE per scene and the program stays compiled no matter how many
instances come and go. It also pre-warms: the registered configuration compiles with the
scene at load, so the first real spawn is free.

```typescript
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';

// In the effect's constructor (idempotent — a map lookup after the first call):
keepShaderAlive(scene, 'my-effect:ring', this.ringMat);                       // Mesh
keepShaderAlive(scene, 'my-effect:sparks', this.sparkMat, 'points',
    [{ name: 'color', itemSize: 3 }]);                                        // Points + attributes
```

Pass the material as configured (it is cloned), the object type (`'mesh' | 'points' |
'line'`), and the geometry layout: omit it for a mesh on a built-in geometry (they all
carry `normal` and `uv`), or pass the real geometry / the attribute list for a custom one
(three.js keys the program on which attributes exist — `normal`, `color` with itemSize 4
for per-vertex alpha, `uv1`, tangents). One key per distinct configuration; the same key
from several systems is fine. Each registration costs one clipped draw call per frame, and
the twins re-key themselves when the scene's visible light count changes (on WebGL that
count is part of every program, unlit ones included). A pooled system should still call
this from its constructor so its program compiles at load instead of on the first spawn.

### Never build a GPU resource inside `update()` — this is lint-enforced

A geometry, material, texture or render target constructed from an `update()` body allocates
GPU memory the renderer never gets back. Nothing looks wrong for the first minute; several
minutes in the browser drops the rendering device and the game dies mid-session with no error
the player can act on. A shipped voxel game lost the WebGPU device exactly this way, across
several generated visual systems at once.

```typescript
// Bad — a new geometry per marker per frame. The count only ever goes up.
update(deltaTime: number): void {
    this.markers.forEach((m) => {
        m.radius += deltaTime;
        m.mesh.geometry = new THREE.RingGeometry(m.radius, m.radius + 0.2, 32);  // ← lint error
    });
}

// Good — built once, mutated per frame.
constructor() {
    this.ringGeometry = new THREE.RingGeometry(1, 1.2, 32);   // unit ring, scaled per marker
}
update(deltaTime: number): void {
    this.markers.forEach((m) => { m.radius += deltaTime; m.mesh.scale.setScalar(m.radius); });
}
```

`game-conventions/no-gpu-alloc-in-update` reports this in the session type-check, so it is
caught while the code is being written rather than by a player minutes into a session. It
covers `update`, `fixedUpdate`, `lateUpdate`, `tick` and `registerBeforeRender` callbacks,
including allocations nested inside a `forEach` or `map` in one of them.

A genuinely one-time allocation is allowed when it is guarded, and both spellings are
recognised:

```typescript
if (!this.beamGeometry) this.beamGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1, 8);
this.beamMaterial ??= new THREE.MeshBasicMaterial({ color: 0x66ccff });
```

For an effect that plays and finishes, `EffectPool` above is the answer — it hides and reuses
a finished effect instead of rebuilding it. What you must never do is silence the rule and
keep the allocation: if a mesh needs different geometry per frame, write into the existing
`BufferAttribute` and set `needsUpdate`, rather than replacing the geometry.

## Vector Allocation in Update Loops

**NEVER allocate `new THREE.Vector3()` or call `.clone()` inside per-frame update loops.** Pre-allocate reusable temp vectors as class fields.

### Bad — allocations every frame:
```typescript
update(dt: number) {
    for (const enemy of this.enemies) {
        const dir = target.position.clone().sub(enemy.position); // NEW object every frame!
        dir.normalize();
    }
}
```

### Good — reuse pre-allocated vectors:
```typescript
private _tempDir = new THREE.Vector3();
private _tempPos = new THREE.Vector3();

update(dt: number) {
    for (const enemy of this.enemies) {
        this._tempDir.copy(target.position).sub(enemy.position).normalize();
    }
}
```

## Material and Geometry Sharing

**Share materials and geometries across identical objects.** Don't create new materials for every tower, enemy, or projectile when they use the same color/properties.

### Bad — unique materials per instance:
```typescript
for (let i = 0; i < 20; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 }); // 20 identical materials!
    towers.push(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
}
```

### Good — Use the engine's MaterialCache and GeometryCache:
```typescript
import { MaterialCache } from 'engine/MaterialCache.js';
import { GeometryCache } from 'engine/GeometryCache.js';

// Class fields (one per game system):
private matCache = new MaterialCache();
private geoCache = new GeometryCache();

// Name what the surface IS MADE OF — the class ('metal', 'wood', 'plastic',
// 'gold', 'glass', …) picks tuned PBR and rides the material-quality ladder
// (Physical on desktop-high, Phong on mobile, Lambert on low):
// Replace: new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.45 })
// With:    this.matCache.getClassed('plastic', 0xff0000)
// (the numeric this.matCache.get(color, { roughness }) form is legacy — it
// always pays full Standard+IBL; kept for existing games, avoid in new code.
// For uncached one-off parts, createWeaponPartMaterial('metal', { color })
// from 'engine/WeaponPartMaterial.js' is the same ladder without the cache.)

// Replace: new THREE.BoxGeometry(1, 1, 1)
// With:    this.geoCache.box(1, 1, 1)

// Replace: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
// With:    this.matCache.getBasic(0xffffff, { transparent: true, opacity: 0.5 })

// Cleanup on game end:
this.matCache.dispose();
this.geoCache.dispose();
```

### Cloned characters: dispose what you own, not what you share

A crowd is one loaded character cloned per NPC. Both clone paths the engine uses
(`SkeletonUtils.clone` for skinned characters, `Object3D.clone(true)` for block ones) give the
clone its own bones and its own meshes while **sharing the geometry and materials with the
template by reference**.

So a clone must never dispose the meshes it is holding. Doing so frees buffers the template and
every sibling clone are still drawing with, and the GPU backend quietly re-uploads them on the
next frame — nothing looks broken, and the cost simply reappears. In a game that spawns and
despawns a horde all session, the same character geometry is uploaded, freed and uploaded again
forever: measured at ~30 MB per species per spawn/despawn cycle on Splatter City's monsters,
which is a heap that grows and stalls rather than one that settles.

`engine/character/SharedCharacterResources.js` makes the ownership explicit:

```typescript
import { markSharedCharacterResources, isSharedCharacterResource } from 'engine/character/SharedCharacterResources.js';

const clone = cloneSkinnedScene(template.scene);
applyVxlEyeSpec(clone, spec);                 // dress it FIRST — see below
markSharedCharacterResources(clone);          // then mark, before anything can dispose it

// …and in teardown, dispose only what this instance actually allocated:
if (mesh.geometry && !isSharedCharacterResource(mesh.geometry)) mesh.geometry.dispose();
```

**Mark AFTER dressing, not straight after the clone.** Anything added to the clone from the
template — the voxel eye layers are the case that bit us — shares its geometry and materials
with every other instance too, and a mark that ran before it was added leaves it exposed. One
monster despawning then destroyed the pupil geometry that every living monster of that species
was still drawing. On WebGPU that is a draw with a dead index buffer, which invalidates the
whole command buffer, so `Queue.submit` throws the frame away — thousands of validation errors
a minute, for the rest of the session, from one despawn.

`NpcController` already does both, so NPC crowds get this for free. Do the same in any game code
that clones a character and later tears the clone down. The template's own buffers live as long
as the template does — one upload per character type per session, whatever the spawn rate.

## Avoid Per-Frame mesh.traverse()

**NEVER call `mesh.traverse()` every frame** to find or update child meshes. Cache references on first access.

### Bad — traverse every frame:
```typescript
update(dt: number) {
    for (const enemy of this.enemies) {
        enemy.mesh.traverse(c => {
            if (c instanceof THREE.Mesh) c.material.emissive.setHex(0xff0000);
        });
    }
}
```

### Good — cache mesh references:
```typescript
// On spawn, cache the meshes you need
const meshes: THREE.Mesh[] = [];
enemy.mesh.traverse(c => { if (c instanceof THREE.Mesh) meshes.push(c); });
enemy.cachedMeshes = meshes;

// In update, iterate cached array directly
update(dt: number) {
    for (const mesh of enemy.cachedMeshes) {
        mesh.material.emissive.setHex(0xff0000);
    }
}
```

## Draw Calls

Measure draw calls alongside CPU/GPU frame time on the intended device. There is no universal
draw-call or mesh-part cap: hundreds of cheap draws can cost less than a few expensive effects.
Use the measured bottleneck to guide optimization, not a quota that limits the visual design.

Baked terrain stays a handful of draws by design: one `BatchedMesh` per depth-bias step, times the level's material classes (capped at 3 non-matte classes per level, so at most ~4× the unclassified count). The `?matq=` quality tier (`engine/MaterialQuality.ts`: high/medium/low — desktop defaults high, mobile medium) clamps how expensively those classes shade; `low` renders a classified level exactly as an unclassified one. Procedural weapon parts (`engine/WeaponPartMaterial.ts`) ride the same ladder: built-in and class-authored custom weapons clamp to Phong on mobile instead of paying Standard+IBL on every device, and `low` renders them Lambert.

Strategies to reduce draw calls:
- **InstancedMesh**: Use `THREE.InstancedMesh` for many identical objects (e.g., 50 enemies of same type)
- **Merged geometry**: Use `THREE.BufferGeometryUtils.mergeGeometries()` for static objects
- **Shared materials**: Same material across meshes enables automatic batching
- Batch compatible parts of complex meshes while preserving their silhouettes, materials and detail

## Engine Utilities Reference

| Utility | Import | Purpose |
|---------|--------|---------|
| `SpatialGrid<T>` | `engine/SpatialGrid.js` | O(1) range queries instead of O(n²) loops |
| `ObjectPool<T>` | `engine/ObjectPool.js` | Reuse projectiles/particles/effects |
| `EffectPool<T>` | `engine/effects/EffectPool.js` | Effects with a lifetime (bursts, trails, arcs): hide-and-reuse so shader programs are never deleted and recompiled |
| `keepShaderAlive` | `engine/effects/ShaderKeepAlive.js` | Effects you construct and dispose per use: register the material configuration once so its program stays compiled and pre-warms at load |
| `MaterialCache` | `engine/MaterialCache.js` | Deduplicate materials — `getClassed('metal', color)` for class-tuned, quality-clamped surfaces; `getBasic` for unlit |
| `GeometryCache` | `engine/GeometryCache.js` | Deduplicate geometries by dimensions |

## Summary Checklist

Before writing game logic with many entities, verify:
- [ ] No nested entity loops (use `SpatialGrid` or `queryEntitiesInRadius`)
- [ ] Projectiles/particles use `ObjectPool` (not create/destroy)
- [ ] Effects that fade (bursts, trails, arcs) live in an `EffectPool`, or register their material with `keepShaderAlive`; no material/geometry `dispose()` outside the system's own `dispose()`
- [ ] No geometry/material/texture constructed inside `update()` — build it once and mutate it (enforced by `game-conventions/no-gpu-alloc-in-update`)
- [ ] No `new THREE.Vector3()` or `.clone()` in update loops
- [ ] Materials use `MaterialCache`, geometries use `GeometryCache`
- [ ] No `mesh.traverse()` in per-frame code (cache references)
- [ ] Performance is measured on the assembled scene; poor FPS/stutter and test limitations are reported
- [ ] Any performance change that reduces visual quality has the creator's approval
