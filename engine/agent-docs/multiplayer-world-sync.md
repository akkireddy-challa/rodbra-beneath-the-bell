# Multiplayer World Sync

What must be synced and how: moving platforms, doors, host ownership, and deterministic voxel /
terrain destruction. Assumes `MultiplayerSetup` is already wired — see `@docs multiplayer-setup.md`.

---

## Syncing Game Objects (CRITICAL for Multiplayer)

**ALL moving/dynamic objects MUST be synced.** If it moves, all players must see it move identically.

### What MUST be synced

| Object Type | Sync Method | Owner |
|-------------|-------------|-------|
| Players | `NetworkObject` + `NetworkCharacterController` | Each player owns theirs |
| Enemies / NPCs | `registerNpc()` + `NetworkCharacterController` | Room host |
| Moving platforms / doors | `NetworkObject` (position only) | Room host |
| Vehicles | `NetworkObject` + `NetworkVehicleController` | Driver |
| Animals | `registerAnimal()` + `NetworkAnimalController` | Room host |
| Pushable objects | `NetworkObject` | Last interacting player |

### What does NOT need syncing

| Object Type | Reason |
|-------------|--------|
| **Bullets** | `sendShoot()` + local sim. Shooter does hit detection, broadcasts via `sendEvent('playerHit', ...)` |
| **Particles** | Visual-only, triggered by events |
| **Static geometry** | Same for all (from world.json) |
| **HUD / UI** | Client-local |

### Host Ownership

The room creator owns all non-player objects. Use `NetworkRoomOwnership` to detect host status:

```typescript
import { NetworkRoomOwnership } from 'engine/networking/index.js';
const roomOwnership = new NetworkRoomOwnership(this.networkManager);
// roomOwnership.isOwner() returns true for the room creator
```

Other clients display received state only — do NOT run AI for synced enemies.

### Syncing Enemies / NPCs

Use `MultiplayerSetup.registerNpc()` — it handles ownership, animation sync and networkId for you.
See `@docs multiplayer-entity-sync.md` → "NPC Multiplayer Sync".

The rest of this section is the **manual** equivalent, for games not using the helper.

**Manual approach (host owns enemy, runs AI):**
```typescript
if (roomOwnership.isOwner()) {
    const enemyNetObj = new NetworkObject(
        enemy.object3D,
        this.networkManager.getLocalPlayerId() + ':enemy-' + enemy.id,
        true,
        {
            speedGetter: () => enemy.controller.getCurrentSpeed(),
            velocityGetter: () => {
                const vel = enemy.controller.getVelocity();
                return { x: vel.x, y: vel.y, z: vel.z };
            },
            objectType: 'character',
            animationProvider: {
                getAnimationState: () => enemy.animController.getCurrentState(),
                getAttackId: () => enemy.animController.getIsAttacking() ? 'attack' : null,
                getCustomAnimId: () => null,
            },
        }
    );
    this.networkManager.registerObject(enemyNetObj);
}
```

**Non-host (in `onUnknownObject`):**
```typescript
if (networkId.includes(':enemy-')) {
    const remoteEnemy = await NetworkCharacterController.create({
        engine: this.engine, networkId, initialState: state,
        playerName: 'Enemy',
        characterUrl: getDefaultCharacterUrl(),
        blockCharacterFactory: this.engine.blockCharacterFactory!,
        baseAnimations: buildAnimationList(),
    });
    this.networkManager.registerObject(remoteEnemy.getNetworkObject());
    this.remoteEnemies.set(networkId, remoteEnemy);
    return;
}
```

### Syncing Moving Platforms / Doors

```typescript
if (roomOwnership.isOwner()) {
    const platformNetObj = new NetworkObject(
        platform.mesh,
        this.networkManager.getLocalPlayerId() + ':platform-' + platform.id,
        true,
        { velocityGetter: () => ({ x: vel.x, y: vel.y, z: vel.z }) }
    );
    this.networkManager.registerObject(platformNetObj);
}
```

Non-host creates non-owner `NetworkObject` attached to platform mesh in `onUnknownObject`. Interpolation handles smooth movement.

### Bullet Pattern (Shoot + Local Sim)

Bullets are the reason the table above says "does NOT need syncing": they are broadcast once with
`sendShoot()` and simulated locally on every client, so only the *shot* and the *hit* cross the
wire, never per-frame bullet positions. Only the shooter runs hit detection.

The full four-step pattern with the remote-bullet code is in `@docs multiplayer-combat-sync.md` →
"Shooting & hit sync". Without `MultiplayerSetup`, step 4 is a plain `sendEvent('playerHit', …)` —
see "Custom Events" in `@docs networking-system.md`.

### Host Migration

The host ROLE migrates automatically: when the owner leaves, `NetworkRoomOwnership` hands ownership to the remaining player with the smallest playerId and fires `onOwnerChanged` (`MultiplayerSetup` wires this for you). The objects the old host owned do NOT migrate — they are disposed with that player and stop updating. Mitigation: store state in room data (`updateRoomData`) and have the new host re-create what it now owns when `onOwnerChanged` names it.

---

## Deterministic Voxel / Terrain Destruction (MANDATORY for multiplayer)

**When a projectile or explosion destroys voxel terrain or a voxel object in a multiplayer game,
you MUST use the deterministic destruction API.** The non-deterministic `explodeTerrainSphere()`,
`VoxelObject.explodeAt()`, etc. use `Math.random()` and will produce different results on each client.

### Why deterministic?

When multiple clients need to see the same crater or the same hole in a voxel barrel, they must
all remove the exact same voxels. The deterministic system converts the hit position to 16.16
fixed-point coordinates and uses a seeded PRNG so every client gets identical results.

**What IS deterministic:** Which voxels are destroyed, and each debris piece's initial velocity.
**What is NOT deterministic:** Debris physics after the initial impulse — each client simulates locally. This is fine because small voxel cubes diverge slowly and the visual difference is imperceptible.

### Pattern: Server/Host detects → broadcasts → all clients apply

```typescript
import { DeterministicDestruction } from 'engine/DeterministicDestruction.js';
import type { DeterministicExplosionParams } from 'engine/DeterministicDestruction.js';
```

**Step 1: Host detects a projectile hit (in collision callback):**

```typescript
if (this.multiplayer?.isRoomHost) {
    const params = DeterministicDestruction.createExplosionParams(
        hitPosition,      // { x, y, z } — float world position
        blastRadius,      // float, e.g. 2.0
        impulseStrength,  // float, e.g. 5.0 (outward force on debris)
        impulseUp,        // float, e.g. 2.0 (upward force on debris)
    );
    // Broadcast to all clients (including self)
    this.multiplayer.networkManager.sendEvent('voxelExplosion', {
        ...params,
        targetType: 'terrain',  // or 'object'
        targetId: objectId,     // only for voxel objects — unique ID to find the VoxelObject
    });
    // Also apply locally on the host
    this.applyDeterministicExplosion(params, 'terrain', objectId);
}
```

**Step 2: All clients listen and apply:**

```typescript
this.multiplayer.networkManager.events.on('voxelExplosion', (_senderId, data) => {
    const params: DeterministicExplosionParams = {
        cx: data.cx as number,
        cy: data.cy as number,
        cz: data.cz as number,
        radius: data.radius as number,
        impulseStrength: data.impulseStrength as number,
        impulseUp: data.impulseUp as number,
    };
    this.applyDeterministicExplosion(params, data.targetType as string, data.targetId as string);
});
```

**Step 3: Shared apply function:**

```typescript
private applyDeterministicExplosion(
    params: DeterministicExplosionParams,
    targetType: string,
    targetId?: string,
): void {
    if (targetType === 'terrain') {
        // Terrain destruction (includes foliage cleanup)
        this.voxelTerrainSystem.deterministicExplodeTerrainSphere(
            params,
            this.engine.physicsWorld,
            this.engine.getWorldGroup(),
        );
    } else if (targetType === 'object' && targetId) {
        // Voxel object destruction (barrel, wall, etc.)
        const voxelObj = VoxelObjectBuilder.getObject(targetId);
        if (voxelObj) {
            DeterministicDestruction.explodeVoxelObject(params, voxelObj);
        }
    }
}
```

### API Reference

| Function | Purpose |
|----------|---------|
| `DeterministicDestruction.createExplosionParams(center, radius, strength, upImpulse)` | Convert float hit coords to fixed-point params for network broadcast |
| `DeterministicDestruction.explodeTerrainSphere(params, voxelWorld, physicsWorld, parentGroup)` | Destroy terrain blocks deterministically |
| `DeterministicDestruction.explodeVoxelObject(params, voxelObject, parentGroup?)` | Destroy part of a voxel object deterministically |
| `voxelTerrainSystem.deterministicExplodeTerrainSphere(params, physicsWorld, parentGroup)` | Convenience wrapper that also cleans up foliage |

### Rules

- **NEVER use `explodeTerrainSphere()` or `VoxelObject.explodeAt()` in multiplayer** — they are non-deterministic
- **Only the host/server detects collisions** — clients do NOT run hit detection for terrain/object destruction
- **All clients (including host) apply the same `DeterministicExplosionParams`** — this ensures identical results
- The `DeterministicExplosionParams` object contains only plain integers (Q16.16 fixed-point) — safe to serialize as JSON
- Partial destruction works: a small blast on a large object only removes voxels within the radius, the rest stays intact

---
