# Multiplayer Combat Sync

Syncing shooting, hits, explosions and equipped weapons. Assumes `MultiplayerSetup` is already
wired — see `@docs multiplayer-setup.md`.

---

## Shooting & hit sync

Simplified pattern: fire → visual sync → local hit detection → damage sync.

**⚠️ CRITICAL: You MUST implement ALL 4 steps. An empty `onRemoteShoot` handler means remote players' bullets are INVISIBLE.**

Use `sendShoot()` — NOT a generic `sendEvent('shoot', ...)`.

```typescript
// 1. Shooter fires — broadcast to all clients
this.multiplayer.sendShoot({
    position: { x: muzzle.x, y: muzzle.y, z: muzzle.z },
    direction: { x: dir.x, y: dir.y, z: dir.z },
    speed: 40,
    color: 0xff0000,      // optional
    radius: 0.05,         // optional
    gravityScale: 0,      // optional (0 = no gravity)
});

// 2. All clients spawn visual projectile for remote shooters
// ⚠️ NEVER leave this empty! Remote projectiles must be visible.
this.multiplayer.onRemoteShoot((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    const dir = new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z);
    const speed = data.speed;
    const gravity = (data.gravityScale ?? 0) * 9.81;

    // Visual-only bullet (no physics body — just a mesh)
    const bullet = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius ?? 0.05),
        new THREE.MeshBasicMaterial({ color: data.color ?? 0xffff00 })
    );
    bullet.position.copy(pos);
    this.engine.scene.add(bullet);

    let elapsed = 0;
    const animate = () => {
        elapsed += 1 / 60;
        if (elapsed > 3) {
            this.engine.scene.remove(bullet);
            bullet.geometry.dispose();
            (bullet.material as THREE.Material).dispose();
            return;
        }
        bullet.position.addScaledVector(dir, speed / 60);
        bullet.position.y -= gravity / 60 * elapsed;
        requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
});

// 3. Shooter detects hit locally, reports damage to all
if (hitDetected) {
    this.multiplayer.sendHit(targetPlayerId, 25);
}

// 4. All clients apply damage
this.multiplayer.onHit((senderId, targetId, damage) => {
    if (targetId === this.multiplayer.networkManager.localPlayerId) {
        this.playerHealth -= damage;
    }
});
```

`ShootData` contains only JSON-serializable fields — extract plain numbers from Vector3 before
calling `sendShoot()`.

Wiring this without `MultiplayerSetup` uses the same payload on the raw hub —
`networkManager.sendShoot(...)` and `networkManager.events.onRemoteShoot = (senderId, data) => …`
— see `@docs multiplayer-manual-integration.md`.

## Explosion & destruction sync

For explosive weapons (bazookas, grenades), you need **three things**: explosion visual sync, terrain destruction sync, AND PvP AOE hit sync. These are independent — hit and explosion are two separate damage sources.

```typescript
// In onProjectileCreated — broadcast explosion + destruction + PvP AOE
projectile.setOnExplosionTriggered((pos, config) => {
    // Spread the whole config so preset/seed/amount/… replicate the same visual
    this.multiplayer!.sendExplosion({ ...config, position: { x: pos.x, y: pos.y, z: pos.z } });
    this.multiplayer!.sendEnvironmentDestruction({
        position: { x: pos.x, y: pos.y, z: pos.z },
        radius: 3.0, impulse: 8, upImpulse: 5,
    });
});

// PvP AOE: engine auto-detects remote players in blast radius
projectile.setOnAoePlayerHit(
    this.multiplayer!.remoteCharacters,
    (networkId, damage) => this.multiplayer!.sendHit(networkId, damage, { type: 'explosion' }),
);

// Receive — spawn visual explosion + environmental self-damage
this.multiplayer.onExplosion((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    new Explosion(pos,
        { ...data, enabled: true, duration: data.duration ?? 1.0, damage: 0, damageRadius: 0 },
        this.engine
    );
    // Environmental AOE self-damage
    if (this.playerController && data.damageRadius && data.damage) {
        const playerPos = this.playerController.getGroundPosition();
        const dist = pos.distanceTo(playerPos);
        if (dist < data.damageRadius) {
            const aoeDmg = Math.round(data.damage * (1 - dist / data.damageRadius));
            if (aoeDmg > 0) this.playerController.takeDamage(aoeDmg, 'explosion');
        }
    }
});

// Receive — apply terrain/debris destruction
this.multiplayer.onEnvironmentDestruction((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    terrainSystem?.explodeTerrainSphere(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
    VoxelDebrisManager.explodeDebrisInRadius(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
});
```

**⚠️ Without these handlers, remote players never see explosions, terrain craters, or take AOE damage!**

See `EXAMPLE_BazookaGame.ts` and `EXAMPLE_HandGrenadeWeapon.ts` for complete implementations.

---

## Weapon Sync

Weapon state rides on `StateMessage` alongside position/rotation — no extra messages.

| Provider method | StateMessage field | Format |
|---|---|---|
| `getEquippedWeaponId()` | `equippedWeaponId` | `"melee:<type>"` or `"ranged:<type>"` (e.g. `"melee:sword"`, `"ranged:pistol"`) |
| `getWeaponAimYaw()` | `weaponAimYaw` | Radians, relative to character forward |
| `getWeaponAimPitch()` | `weaponAimPitch` | Radians, negative = looking up |

**Owner — add to `animationProvider`:**
```typescript
getEquippedWeaponId: () => {
    if (this.meleeSystem?.getWeaponType()) return 'melee:' + this.meleeSystem.getWeaponType();
    if (this.rangedSystem?.getWeaponType()) return 'ranged:' + this.rangedSystem.getWeaponType();
    return null;
},
getWeaponAimYaw: () => this.rangedSystem?.getWeaponMesh()?.rotation.y ?? 0,
getWeaponAimPitch: () => -(this.rangedSystem?.getWeaponMesh()?.rotation.x ?? 0),
```

**Receiver: `NetworkCharacterController` handles automatically** — it creates the `WeaponStateReceiver` internally, auto-equips/unequips matching weapon meshes, positions melee at hand, ranged at shoulder with arm overrides, and updates aim rotation. DO NOT implement it manually.

Any type from `WeaponRegistry`/`RangedWeaponRegistry` works as the `<type>` half of the id.

Use `sendEvent()` for weapon actions (reload, empty clip) that don't fit the state sync model.

---
