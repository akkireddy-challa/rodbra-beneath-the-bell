# Physics2D Genre

The Physics2D genre uses Rapier 2D physics (`@dimforge/rapier2d-compat`) for gameplay on the X/Y plane with Z as visual depth. Games render 3D objects but all physics runs in 2D (side-scrollers, platformers, puzzle-physics, etc.).

## Coordinate System

- **X** — horizontal movement (left/right)
- **Y** — vertical movement (up/down, gravity acts on -Y)
- **Z** — visual depth only (always 0 for physics bodies, can vary for rendering layers)

This is a 1:1 mapping: Three.js X/Y directly maps to Rapier2D X/Y.

## Key Differences from 3D Genres

| Aspect | 3D Genres | Physics2D |
|--------|-----------|-----------|
| Physics module | `@dimforge/rapier3d-compat` | `@dimforge/rapier2d-compat` |
| PhysicsWorld | `engine/physics/PhysicsWorld.ts` | `engine/physics/PhysicsWorld2D.ts` |
| Body factory | `engine/physics/PhysicsBodyFactory.ts` | `engine/physics/PhysicsBodyFactory2D.ts` |
| Engine field | `engine.physicsWorld` | `engine.physicsWorld2D` |
| Camera | Free 3D camera | Side-view `Physics2DCamera` with smoothed tracking |
| Collider shapes | 3D (box, sphere, capsule, trimesh) | 2D (cuboid, ball, capsule, segment, convex hull, polyline) |

## Config Template

`physics2d-game.json` must include `"physicsMode": "2d"` to trigger 2D WASM loading.

> A **Voxel**-genre game can run Rapier 2D too: declare `"physicsMode": "2d"` AND
> `"physics2d": true` (the sidescroller and top-down templates do). Its voxel terrain, placed
> objects and block characters then collide on the gameplay plane through the
> plane-locked facade — side-on (X/Y) for the sidescroller, the ground plane (X/Z, with a
> virtual Y from the terrain heightmap) under a top-down camera — see
> `game/docs/physics-2d-lane.md`. That is the production
> path for side-on and top-down games; this genre remains the standalone 2D-only starter.

```json
{
  "gameGenre": "Physics2D",
  "physicsMode": "2d",
  "gameName": "My 2D Game"
}
```

## Genre Files

Located in `game/src/genres/physics2d/`:

- **Game.ts** — Entry point, creates world/player/camera/HUD, registers as `Physics2D` genre
- **WorldGenerator.ts** — Builds the world layout in code (platforms, objects, terrain)
- **Physics2DPlayerController.ts** — Keyboard input (A/D + W/Space), ground detection via raycast
- **Physics2DCamera.ts** — Side-view camera with smoothed follow and look-ahead
- **PhysicsConfig.ts** — Default tuning constants (gravity, jump, speed)
- **GameHUD.ts** — Re-exports the shared engine HUD

## Creating Physics Bodies

```typescript
import RAPIER2D from '@dimforge/rapier2d-compat';
import { getRapier2D } from 'engine/physics/index.js';
import { PhysicsBodyFactory2D } from 'engine/physics/index.js';

const R = getRapier2D();

// Static platform
const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(x, y);
const body = physicsWorld2D.createRigidBody(bodyDesc);
const colliderDesc = R.ColliderDesc.cuboid(halfWidth, halfHeight);
physicsWorld2D.createCollider(colliderDesc, body);

// Dynamic object
const { rigidBody, collider } = PhysicsBodyFactory2D.createDynamicBody(
    physicsWorld2D,
    { x, y },
    { shape: { type: 'ball', radius: 0.5 }, mass: 1.0, restitution: 0.5 }
);
```

## Syncing Meshes to Bodies

For dynamic bodies, sync the Three.js mesh position/rotation each frame:

```typescript
const pos = body.translation(); // { x, y }
const rot = body.rotation();    // angle in radians
mesh.position.set(pos.x, pos.y, 0);
mesh.rotation.z = rot;
```

## Available 2D Collider Shapes

- `cuboid(halfWidth, halfHeight)` — rectangle
- `ball(radius)` — circle
- `capsule(halfHeight, radius)` — rounded rectangle
- `segment(pointA, pointB)` — line segment
- `convexHull(vertices)` — convex polygon from float array
- `polyline(vertices, indices?)` — open polyline for terrain edges

## World Layout — Code-Driven

The world is built in `WorldGenerator.ts` code. Platforms and procedural geometry go in `WorldGenerator.buildDefaultWorld()`. Uploaded voxel assets are loaded from `environmentObjects` in `world.json` automatically, AND can be placed via code using `loadAssetByName` / `loadAssetById`.

`WorldGenerator` provides helper methods for building the world:

- `createVoxelPlatform(R, { x, y, width, height, color })` — static VoxelObject platform with 2D collider
- `createDynamicBox(x, y, width, height, color)` — dynamic VoxelObject box with 2D collider
- `loadAssetByName(assetName, x, y)` — **preferred** — load asset by name from the assets library (URL resolved at runtime from `gameData.assets`)
- `loadAssetById(assetId, x, y)` — load asset by ID from the assets library (URL resolved at runtime)
- `loadVoxelAsset(url, x, y)` — load a .vxl asset from a direct URL (**avoid** — hardcoded URL breaks when the user re-voxelizes the asset)
- `explodeAt(worldX, worldY, radius, impulseStrength?)` — explode voxel objects near a point
- `update()` — called every frame to sync debris physics (already wired in Game.ts)

Add new methods for custom object types (balls, moving platforms, etc.) following the same pattern: create a Rapier2D body + collider, create a Three.js visual, track both for cleanup.

### Placing Uploaded Assets

**CRITICAL: NEVER hardcode asset URLs in source code.** Asset URLs change when the user re-voxelizes an asset. Always reference assets by name or ID:

```typescript
// In WorldGenerator.loadEnvironmentObjects() or buildDefaultWorld():
await this.loadAssetByName('my-castle', 14, -1.5);
await this.loadAssetById('1775592573282', 5, 0);
```

Assets are also automatically loaded from `world.json`'s `environmentObjects` array. Each entry references an `assetId` that is resolved to the current URL at runtime:

```json
{
  "environmentObjects": [
    {
      "id": "obj_001",
      "type": "my-castle",
      "assetId": "1775592573282",
      "position": { "x": 14, "y": -1.5, "z": 0 }
    }
  ]
}
```

## Voxel Asset Colliders

Loaded .vxl assets get voxel-accurate 2D colliders (compound cuboids projected from the 3D greedy-merged physics boxes), not a single bounding box. The engine utility `engine/physics/VoxelPhysics2D.ts` handles the projection.

```typescript
// WorldGenerator.loadVoxelAsset does this internally:
import { createVoxelColliders2D } from 'engine/physics/VoxelPhysics2D.js';
const voxelBody = createVoxelColliders2D(voxelObj, physicsWorld2D, { x, y });
```

## Explosions and Destruction

Voxel objects can be partially destroyed. `WorldGenerator.explodeAt()` removes voxels within a blast radius, rebuilds the visual mesh and 2D colliders, and spawns physics debris that fades out over time.

```typescript
// In a hit callback or game event:
this.worldGenerator.explodeAt(hitX, hitY, 2.0, 8);
```

For direct control, use the engine utilities:

```typescript
import { explodeVoxelObject2D, type VoxelBody2D } from 'engine/physics/VoxelPhysics2D.js';

const debris = explodeVoxelObject2D(voxelBody, { x, y }, radius, physicsWorld2D, scene);
```

Debris is automatically synced and cleaned up by `WorldGenerator.update()` (max 4 seconds lifetime).

## Projectiles

Physics2D has its own projectile system. **NEVER** use the 3D `Projectile`/`ProjectileManager` — they silently fail (null physicsWorld).

```typescript
import { Projectile2D, type ProjectileVisualConfig2D } from 'engine/Projectile2D.js';
import { ProjectileManager2D } from 'engine/ProjectileManager2D.js';
import { CollisionMask } from 'engine/CollisionLayers.js';

// Get the singleton manager
const manager = ProjectileManager2D.getInstance();

// Fire a projectile
const config: ProjectileVisualConfig2D = {
    collisionRadius: 0.1,
    bloomLayer: true,
    trail: { enabled: true, length: 6 },
    // gravityScale: 1.0,  // Uncomment for ballistic arc
    // explosion: { enabled: true, radius: 2, duration: 0.5, damage: 50, damageRadius: 3 },
};

const projectile = new Projectile2D(
    { x: spawnX, y: spawnY },      // position
    { x: dirX, y: dirY },          // direction (auto-normalized)
    speed,                          // m/s
    this.physicsWorld,              // PhysicsWorld2D
    this.engine.scene!,             // THREE.Scene
    (proj, hitBody) => {            // hit callback
        if (hitBody) {
            this.worldGenerator.explodeAt(proj.getPosition().x, proj.getPosition().y, 2.0);
        }
    },
    config,
    // CollisionMask.ENEMY_PROJECTILE,  // Optional: use for NPC-fired projectiles that hit the player
);
// projectile.setDamage(40);
// projectile.setEnemyProjectile((p) => { /* player hit */ });

manager.register(projectile);

// In update loop:
manager.update(deltaTime);

// On dispose:
ProjectileManager2D.dispose();
```

## Spawn Position Validation

The engine provides `findValidSpawnPosition2D()` to prevent spawning underground. It raycasts down from above the configured spawn X to find solid ground, then places the capsule on top.

```typescript
import { findValidSpawnPosition2D } from 'engine/SpawnHelper2D.js';

const validated = findValidSpawnPosition2D(physicsWorld2D, spawnX, spawnY, capsuleHalfHeight);
// validated.x, validated.y — safe spawn position (capsule center)
```

The default `Game.ts` template already calls this after `generateWorld()`.

## 3D-Only Systems — DO NOT USE

The following engine systems use Rapier 3D (`engine.physicsWorld`) and will silently fail or crash in Physics2D games. **NEVER import or use them:**

| 3D-Only System | Use Instead |
|----------------|-------------|
| `engine/Projectile.ts` | `engine/Projectile2D.ts` |
| `engine/ProjectileManager.ts` | `engine/ProjectileManager2D.ts` |
| `engine/ProjectileShootSystem.ts` | Create projectiles directly with `Projectile2D` |
| `engine/RangedWeaponSystem.ts` | Create projectiles directly with `Projectile2D` |
| `engine/WeaponMeleeSystem.ts` | Use `physicsWorld2D.raycast()` for melee hit detection |
| `engine/UnarmedMeleeSystem.ts` | Use `physicsWorld2D.raycast()` for melee hit detection |
| `engine/Spawner.ts` | Use `findValidSpawnPosition2D()` from `engine/SpawnHelper2D.ts` |
| `engine/PlayerController.ts` | Use `Physics2DPlayerController` (template) |
| `engine/loaders/PlayerLoader.ts` | Load character directly in `Game.ts` (see template) |
| `engine/WalkingAndJumpingMovement.ts` | Handled by `Physics2DPlayerController` |
| `engine/ThirdPersonCamera.ts` | Use `Physics2DCamera` (template) |
| `engine/npc/core/NpcController.ts` | Build 2D NPC with `PhysicsBodyFactory2D` + custom logic |
| `engine/VoxelWorld.ts` | Use `VoxelObject` for individual assets + `VoxelPhysics2D` for colliders |
| `engine/VoxelTerrainSystem.ts` | Build terrain in `WorldGenerator.ts` code |
| `engine/InteractableComponent.ts` | Use sensor colliders via `PhysicsWorld2D` |
| `engine/CollectibleComponent.ts` | Use sensor colliders via `PhysicsWorld2D` |
| `engine/ShootableComponent.ts` | Handle hit detection via `Projectile2D` callbacks |
| `engine/physics/PhysicsWorld.ts` | `engine/physics/PhysicsWorld2D.ts` |
| `engine/physics/PhysicsBodyFactory.ts` | `engine/physics/PhysicsBodyFactory2D.ts` |

**Rule of thumb:** If an import path contains `rapier3d`, `PhysicsWorld` (without `2D`), or `engine.physicsWorld` (without `2D`), it is 3D-only and must not be used.
