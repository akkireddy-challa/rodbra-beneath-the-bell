# Multiplayer Entity Sync (characters, animals, NPCs)

Syncing animated entities: animation state, per-species visual config, and client-side hit
detection. Assumes `MultiplayerSetup` is already wired — see `@docs multiplayer-setup.md`.

---

## Animation Sync

Animation state rides on `StateMessage` — no extra messages.

| Provider method | StateMessage field | Purpose |
|---|---|---|
| `getAnimationState()` | `animState` | Current state: `'idle'`, `'walk'`, `'run'`, `'jump'`, `'attack'` |
| `getAttackId()` | `attackId` | Attack move name when attacking, `null` otherwise |
| `getCustomAnimId()` | `customAnimId` | Custom motion ID for emotes/interactions, `null` otherwise |

**Animal animations** use different states: `'idle'`, `'walk'`, `'trot'`, `'run'`. Same provider
interface, different state strings.

**Owner — `AnimationStateProvider`:**
```typescript
animationProvider: {
    getAnimationState: () => animController.getCurrentState(),    // 'idle', 'run', 'jump', etc.
    getAttackId: () => animController.getIsAttacking() ? 'attack' : null,
    getCustomAnimId: () => null,
}
```

**Non-owner — `AnimationStateReceiver`:**
```typescript
animationReceiver: {
    applyAnimationState(animState, speed, attackId, customAnimId) {
        if (attackId && !remoteAnimController.getIsAttacking()) {
            remoteAnimController.startAttack();
        } else if (customAnimId) {
            remoteAnimController.playCustomAnimation?.(customAnimId);
        } else {
            remoteAnimController.updateAnimation(animState !== 'idle', speed, animState !== 'jump', animState === 'jump');
        }
    }
}
```

**For remote players: DO NOT manually create receivers** — `NetworkCharacterController` handles this internally.

### Animal Multiplayer Sync

Animals sync via `MultiplayerSetup.registerAnimal()` (host) and `NetworkAnimalController` (remote).
Remote clients auto-create block animal visuals with procedural animation from network state.

**CRITICAL: Only the host spawns animals.** Non-host clients must NOT spawn local animals — they
receive network-synced animals automatically via `NetworkAnimalController`. If both host and non-host
spawn animals, non-host will see duplicate animals (local + remote) at different positions.

```typescript
// ✅ CORRECT — only spawn on host, with bodyConfig for visual sync
if (this.multiplayer?.isRoomHost) {
    await this.spawnAnimals();
    // Register each animal for sync — pass bodyConfig so remotes look identical
    registry.forEach((animal, id) => {
        this.multiplayer!.registerAnimal(animal.getCharacter(), id, 'Dog', {
            velocityGetter: () => animal.getVelocity(),
            animationController: animal.getAnimationController(),
            bodyConfig: DOG_CONFIG,       // ← BlockAnimalBodyConfig used to create the animal
            displayName: 'Wolf',          // ← floating name label on remote clients
        });
    });
}

// ❌ WRONG — spawning for all clients creates duplicates
await this.spawnAnimals();  // both host AND non-host spawn local animals

// ❌ WRONG — missing bodyConfig means remotes get generic brown animal
this.multiplayer!.registerAnimal(animal.getCharacter(), id, 'Dog', {
    velocityGetter: () => animal.getVelocity(),
    animationController: animal.getAnimationController(),
    // no bodyConfig → remote clients won't match host visuals!
});
```

**Visual sync:** When `bodyConfig` is provided to `registerAnimal()`, the engine automatically
transmits the `BlockAnimalBodyConfig` to remote clients during initial sync. Remote clients
use `createBlockAnimalFactory(config)` to build identical block geometry — same colors, shapes,
proportions, eyes, and shoulder height as the host's animal. Without `bodyConfig`, remotes
fall back to a generic brown animal mesh.

**Name tags:** Remote animals always get a floating name label (from `displayName` or `animalType`).
Host-side local animals do NOT get name labels (they're local `AnimalController` instances).

**Host (room creator) — register animals:**
```typescript
// After creating an animal — always pass bodyConfig for visual consistency:
const animal = await createAnimal(scene, physics, engine, pos, 'Dog', 2.0, factory);
this.multiplayer.registerAnimal(
    animal.getCharacter(),    // Object3D
    'dog-1',                  // unique ID
    'Dog',                    // species (sent to remotes for mesh building)
    {
        velocityGetter: () => animal.getVelocity(),
        animationController: animal.getAnimationController(),
        bodyConfig: DOG_CONFIG,   // BlockAnimalBodyConfig for identical visuals
        displayName: 'Good Boy',  // optional custom name label
    },
);

// On animal death — syncs removal to all clients automatically:
this.multiplayer.sendAnimalDeath('dog-1');
// This: 1) unregisters the NetworkObject on host, 2) broadcasts _animalDeath event,
// 3) remote clients auto-dispose their NetworkAnimalController + remove from scene.
```

**Death sync in `onAnimalDeath` callback:**
```typescript
// ✅ CORRECT — use sendAnimalDeath() so clients see the animal disappear
registry.onAnimalDeath = (id: string) => {
    this.multiplayer?.sendAnimalDeath(id);
    this.killCount++;
    this.hud.updateCounter('kills', this.killCount);
};

// ❌ WRONG — unregisterAnimal only stops sync, doesn't tell clients to remove the visual
registry.onAnimalDeath = (id: string) => {
    this.multiplayer?.unregisterAnimal(id);  // client still sees a frozen animal ghost
};
```

**Non-host — automatic.** `MultiplayerSetup.onUnknownObject` detects `objectType === 'animal'`,
creates a `NetworkAnimalController` with the correct species mesh, and adds it to `remoteAnimals`.
When the host calls `sendAnimalDeath()`, the `_animalDeath` event auto-disposes the remote animal.

#### Client-Side Animal Hit Detection

Remote animals on non-host clients have **kinematic physics bodies** (in `CollisionGroup.ANIMAL`,
filtering `CollisionGroup.PROJECTILE`). Rapier automatically fires collision events when
projectiles hit remote animals — **NO manual proximity checks needed**.

When a projectile hits a remote animal's physics body (`__type === 'remoteAnimal'`), the
`Projectile` class fires `onRemoteAnimalHitCallback`. The game wires this via
`RangedWeaponSystem.onProjectileCreated`:

**Setup — wire up all projectiles via onProjectileCreated (once during setup):**
```typescript
// ✅ CORRECT — use onProjectileCreated hook, engine handles collision detection
this.rangedSystem.onProjectileCreated = (proj) => {
    proj.setOnRemoteAnimalHit((networkId, damage, hitPos, hitDir) => {
        // Send hit info to host for authoritative damage
        this.multiplayer!.sendAnimalHit(networkId, damage, hitPos, hitDir);
        // Show visual effects immediately on client (blood, flash, etc.)
        // e.g. createDamageFlash, particle effect, etc.
    });
};

// ❌ WRONG — never iterate projectiles manually for animal hit detection:
// for (const proj of this.rangedSystem.getProjectiles()) {  // NO!
//     for (const [, animal] of remoteAnimals) {              // NO!
//         if (distSq < HIT_RADIUS_SQ) { ... }               // NO! Engine handles this
```

**Setup on host — receive hits and apply damage:**
```typescript
// Host registers handler to apply damage from remote client hits
this.multiplayer.onAnimalHit((_senderId, networkId, damage, _hitPos, _hitDir) => {
    // Extract animal ID from networkId format: "<playerId>:animal-<animalId>"
    const animalId = networkId.split(':animal-')[1];
    if (!animalId) return;
    const animal = this.engine.getAnimalRegistry?.()?.get(animalId);
    animal?.takeDamage(damage, 'projectile');
});
```

**Host's own hits work as before** — `Projectile` detects `__type === 'animal'` on local
`AnimalController` bodies, calls `onProjectileCollision()` directly, no network round-trip needed.

**Kill tracking:** Use `_animalDeath` events (auto-sent by `sendAnimalDeath()`) to track kills
on all clients. Do NOT send custom kill-count events — each client counts deaths independently:
```typescript
// ✅ CORRECT — count _animalDeath events on each client
this.multiplayer.networkManager?.events.on('_animalDeath', () => {
    this.killCount++;
    this.hud.updateCounter('kills', this.killCount);
});

// ❌ WRONG — manual kill count sync via custom event
// this.multiplayer.networkManager.sendEvent('buffaloKill', { killCount }); // NO!
```

**Low-level (manual NetworkObject):**
```typescript
// Owner
animationProvider: {
    getAnimationState: () => animalAnimController.getCurrentState(), // 'idle', 'walk', 'trot', 'run'
    getAttackId: () => null,
    getCustomAnimId: () => null,
}

// Receiver
animationReceiver: {
    applyAnimationState(animState, speed) {
        animalAnimController.setState(animState);
        animalAnimController.updateAnimation(animState !== 'idle', speed, true, false);
    }
}
```

### NPC Multiplayer Sync

NPCs sync via `MultiplayerSetup.registerNpc()` (host) and `NetworkCharacterController` (remote).
Remote clients auto-create NPC visuals with the correct appearance from transmitted `NpcCustomizationConfig`.

**CRITICAL: Only the host spawns NPCs.** Non-host clients receive network-synced NPCs automatically.

**Host — register NPCs with visual config:**
```typescript
// Pass npcConfig so remotes look identical (same colors, clothing, body shape)
this.multiplayer.registerNpc(npc.getCharacter(), npcId, {
    velocityGetter: () => npc.getVelocity(),
    animationController: npc.getAnimationController(),
    npcConfig: GUARD_CUSTOMIZATION,  // NpcCustomizationConfig for identical visuals
    displayName: 'Guard',            // floating name label on remote clients
});

// On NPC death — syncs removal to all clients automatically:
this.multiplayer.sendNpcDeath(npcId);
```

**Non-host — automatic.** `MultiplayerSetup.onUnknownObject` detects `objectType === 'npc'`,
creates a `NetworkCharacterController` with the correct NPC visuals from the transmitted config.
When the host calls `sendNpcDeath()`, the `_npcDeath` event auto-disposes the remote NPC.

#### Client-Side NPC Hit Detection

Remote NPCs have **no physics body** — `NetworkCharacterController` creates none (unlike
`NetworkAnimalController`), so nothing carries the `__type: 'remoteNpc'` tag that `Projectile` looks
for, and `setOnRemoteNpcHit` does not fire on non-host clients. Only remote animals report hits this way.

**Setup — wire up projectile hit callback (once during setup):**
```typescript
this.rangedSystem.onProjectileCreated = (proj) => {
    proj.setOnRemoteAnimalHit((networkId, damage, hitPos, hitDir) => {
        this.multiplayer!.sendAnimalHit(networkId, damage, hitPos, hitDir);
    });
    proj.setOnRemoteNpcHit((networkId, damage, hitPos, hitDir) => {
        this.multiplayer!.sendNpcHit(networkId, damage, hitPos, hitDir);
    });
};
```

**Host receives NPC hits and applies damage:**
```typescript
this.multiplayer.onNpcHit((_senderId, networkId, damage) => {
    const npcId = networkId.split(':npc-')[1];
    if (!npcId) return;
    const npc = engine.getNpcRegistry()?.get(npcId);
    npc?.takeDamage(damage, 'projectile');
});
```

---
