/**
 * @fileoverview EXAMPLE_HandGrenadeWeapon — Custom grenade with arc trajectory + AOE + multiplayer
 *
 * SEARCH KEYWORDS: grenade, hand grenade, frag grenade, thrown weapon, arc trajectory,
 * ballistic, gravity, gravityScale, lobbed projectile, throwable, explosive, AOE
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 💣 AI AGENT: HAND GRENADE WEAPON WITH ARC + AOE + MULTIPLAYER
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * This file demonstrates:
 * - Registering a custom grenade weapon via `RangedWeaponRegistry.register()`
 * - Using `gravityScale: 1.0` for ballistic arc trajectory
 * - AOE explosion on impact
 * - Custom grenade mesh (sphere with details)
 * - Voxel terrain/object destruction on hit
 * - Full multiplayer: sendShoot with gravityScale, onRemoteShoot with matching arc
 *
 * **Key concept:** Grenades use the same `Projectile` system as bullets, but with
 * `gravityScale: 1.0` which applies realistic gravity for an arcing flight path.
 * The projectile speed is low (8–12) so the arc is visible.
 *
 * **Copy the patterns below into your Game.ts — do NOT import this file.**
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 1: REGISTER GRENADE WEAPON
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * import * as THREE from 'three';
 * import { RangedWeaponRegistry, RangedWeaponType } from 'engine/RangedWeaponRegistry.js';
 * import type { RangedWeaponPreset, RangedWeaponMeshResult } from 'engine/RangedWeaponRegistry.js';
 * import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
 *
 * // ─── Grenade projectile mesh factory ───
 * function createGrenadeMesh(radius: number, _color: number): THREE.Group {
 *     const grenade = new THREE.Group();
 *
 *     // Dark green body
 *     const body = new THREE.Mesh(
 *         new THREE.SphereGeometry(radius * 1.5, 8, 8),
 *         createWeaponPartMaterial('paint', { color: 0x2d4a1e })
 *     );
 *     grenade.add(body);
 *
 *     // Spoon (lever) on top
 *     const spoon = new THREE.Mesh(
 *         new THREE.BoxGeometry(radius * 0.4, radius * 2, radius * 0.1),
 *         createWeaponPartMaterial('metal', { color: 0x888888 })
 *     );
 *     spoon.position.set(0, radius * 1.0, 0);
 *     grenade.add(spoon);
 *
 *     return grenade;
 * }
 *
 * // ─── Register the weapon (call ONCE, before game loads) ───
 * RangedWeaponRegistry.register('hand_grenade', {
 *     preset: {
 *         name: 'Hand Grenade',
 *         damage: 30,              // Direct hit damage (low — AOE is the main damage)
 *         fireRate: 0.5,           // 1 throw per 2 seconds
 *         projectileSpeed: 10,     // Slow — lets the arc develop visually
 *         magazineSize: 3,         // Limited ammo
 *         hands: 1,                // One-handed throw
 *         muzzleOffset: new THREE.Vector3(0, 0.02, 0.2),
 *         gripOffset: new THREE.Vector3(0, 0, 0),
 *         recoilStrength: 0.05,
 *         heightOffset: 0.2,
 *         // Custom projectile mesh
 *         projectileRadius: 0.06,
 *         projectileColor: 0x2d4a1e,
 *         createProjectileMesh: createGrenadeMesh,
 *         trailLength: 3,          // Short trail
 *         // ⚠️ CRITICAL: gravityScale for ballistic arc!
 *         gravityScale: 1.0,       // 0 = straight line (bullet), 1.0 = realistic arc
 *         // ⚠️ CRITICAL: Explosion config — keep damageRadius proportional to arena
 *         explosion: {
 *             enabled: true,
 *             radius: 3.0,          // Visual explosion radius
 *             duration: 1.2,
 *             color: 0xff6600,      // Orange
 *             damage: 80,           // AOE damage at center
 *             damageRadius: 5.0,    // Damage falloff radius (meters)
 *         },
 *     } as RangedWeaponPreset,
 *     createMesh: (group: THREE.Group, _preset: RangedWeaponPreset): RangedWeaponMeshResult => {
 *         // Simple hand model (player holds the grenade)
 *         // In practice, the projectile mesh is what the player sees in flight.
 *         const holder = new THREE.Mesh(
 *             new THREE.SphereGeometry(0.04, 6, 6),
 *             createWeaponPartMaterial('paint', { color: 0x2d4a1e })
 *         );
 *         group.add(holder);
 *         return { foregrip: null };
 *     },
 * });
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 2: EQUIP + CONFIGURE ARC TRAJECTORY
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';
 * import { Projectile } from 'engine/Projectile.js';
 * import { VoxelObject } from 'engine/VoxelObject.js';
 * import type { VoxelTerrainSystem } from 'engine/VoxelTerrainSystem.js';
 * import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';
 *
 * // Equip the custom grenade weapon
 * this.rangedSystem = new RangedWeaponSystem(this.engine, this.engine.physicsWorld!);
 * this.rangedSystem.equipWeapon('hand_grenade', player, playerLoader);
 * this.playerController.setAttackSystem(this.rangedSystem);
 *
 * // gravityScale: 1.0 in the preset (Step 1) makes grenades arc automatically.
 * // The RangedWeaponSystem passes it through to the Projectile's visual config.
 * this.rangedSystem.onProjectileCreated = (projectile: Projectile) => {
 *
 *     // Wire up voxel destruction on hit
 *     const origUpdate = projectile.update.bind(projectile);
 *     let wasHit = false;
 *     projectile.update = function(dt: number) {
 *         origUpdate(dt);
 *         if (!wasHit && projectile.hasHit()) {
 *             wasHit = true;
 *             const pos = projectile.getPosition();
 *             const radius = 3.0;
 *             const impulse = 8;
 *             const upImpulse = 5;
 *
 *             // Destroy terrain
 *             const terrain = (this as any).terrainSystem as VoxelTerrainSystem | null;
 *             terrain?.explodeTerrainSphere(pos, radius, impulse, upImpulse);
 *
 *             // Destroy VoxelObjects
 *             const hitBody = projectile.getHitBody();
 *             if (hitBody) {
 *                 const voxelObj = VoxelObject.fromRigidBody(hitBody, engine.physicsWorld!);
 *                 if (voxelObj && !voxelObj.isDestroyed()) {
 *                     voxelObj.explodeAt(pos, radius, impulse, upImpulse);
 *                 }
 *             }
 *
 *             // Destroy nearby debris
 *             VoxelDebrisManager.explodeDebrisInRadius(pos, radius, impulse, upImpulse);
 *         }
 *     };
 *
 *     // Multiplayer: sync NPC/animal hits + explosion + destruction
 *     if (this.multiplayer) {
 *         projectile.setOnRemoteNpcHit((networkId, damage, hitPos, hitDir) => {
 *             this.multiplayer!.sendNpcHit(networkId, damage, hitPos, hitDir);
 *         });
 *         projectile.setOnRemoteAnimalHit((networkId, damage, hitPos, hitDir) => {
 *             this.multiplayer!.sendAnimalHit(networkId, damage, hitPos, hitDir);
 *         });
 *
 *         // ⚠️ CRITICAL: Sync explosion visual + environment destruction
 *         projectile.setOnExplosionTriggered((pos, config) => {
 *             this.multiplayer!.sendExplosion({
 *                 position: { x: pos.x, y: pos.y, z: pos.z },
 *                 radius: config.radius,
 *                 duration: config.duration,
 *                 color: config.color,
 *                 damageRadius: config.damageRadius,
 *                 damage: config.damage,
 *             });
 *             this.multiplayer!.sendEnvironmentDestruction({
 *                 position: { x: pos.x, y: pos.y, z: pos.z },
 *                 radius: 3.0,
 *                 impulse: 8,
 *                 upImpulse: 5,
 *             });
 *         });
 *
 *         // ⚠️ PvP AOE: engine auto-detects remote players in blast radius
 *         projectile.setOnAoePlayerHit(
 *             this.multiplayer!.remoteCharacters,
 *             (networkId, damage) => this.multiplayer!.sendHit(networkId, damage, { type: 'explosion' }),
 *         );
 *     }
 * };
 *
 * // Enable health HUD
 * this.hud.setPlayerController(this.playerController);
 * this.hud.showHealth();
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 3: MULTIPLAYER — BROADCAST GRENADE THROWS
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * import type { ShootData } from 'engine/networking/NetworkTypes.js';
 *
 * // Chain onto the existing onProjectileCreated callback
 * const previousCallback = this.rangedSystem!.onProjectileCreated;
 * this.rangedSystem!.onProjectileCreated = (projectile: Projectile) => {
 *     previousCallback?.(projectile);
 *
 *     // Broadcast grenade throw to all clients
 *     if (this.multiplayer) {
 *         const pos = projectile.getPosition();
 *         const dir = projectile.getDirection();
 *         this.multiplayer.sendShoot({
 *             position: { x: pos.x, y: pos.y, z: pos.z },
 *             direction: { x: dir.x, y: dir.y, z: dir.z },
 *             speed: projectile.getSpeed(),
 *             color: 0x2d4a1e,       // Dark green
 *             radius: 0.06,
 *             gravityScale: 1.0,     // ⚠️ CRITICAL: must match local grenade!
 *         });
 *     }
 * };
 *
 * // ⚠️ CRITICAL: Remote players must see the grenade arc too!
 * this.multiplayer?.onRemoteShoot((_senderId: string, data: ShootData) => {
 *     const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
 *     const dir = new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z);
 *     const speed = data.speed;
 *     const gravity = (data.gravityScale ?? 0) * 9.81;
 *
 *     // Create visual grenade
 *     const grenade = new THREE.Mesh(
 *         new THREE.SphereGeometry(data.radius ?? 0.06, 8, 8),
 *         createWeaponPartMaterial('paint', { color: data.color ?? 0x2d4a1e })
 *     );
 *     grenade.position.copy(pos);
 *     this.engine.scene.add(grenade);
 *
 *     // Animate with MATCHING arc trajectory
 *     let elapsed = 0;
 *     const vel = dir.clone().multiplyScalar(speed);
 *     const animate = () => {
 *         const dt = 1 / 60;
 *         elapsed += dt;
 *         if (elapsed > 5) {
 *             this.engine.scene.remove(grenade);
 *             grenade.geometry.dispose();
 *             (grenade.material as THREE.Material).dispose();
 *             return;
 *         }
 *         // Apply gravity to velocity (same physics as Rapier body)
 *         vel.y -= gravity * dt;
 *         grenade.position.addScaledVector(vel, dt);
 *         requestAnimationFrame(animate);
 *     };
 *     requestAnimationFrame(animate);
 * });
 *
 * // ─── Receive explosion visuals from remote players ───
 * import { Explosion } from 'engine/Explosion.js';
 *
 * this.multiplayer?.onExplosion((_senderId: string, data) => {
 *     new Explosion(
 *         new THREE.Vector3(data.position.x, data.position.y, data.position.z),
 *         {
 *             enabled: true,
 *             radius: data.radius,
 *             duration: data.duration ?? 1.2,
 *             color: data.color ?? 0xff6600,
 *             damage: 0,          // No local damage — sender already applied it
 *             damageRadius: 0,
 *         },
 *         this.engine
 *     );
 * });
 *
 * // ─── Receive terrain/voxel destruction from remote players ───
 * this.multiplayer?.onEnvironmentDestruction((_senderId: string, data) => {
 *     const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
 *     const terrain = (this as any).terrainSystem as VoxelTerrainSystem | null;
 *     terrain?.explodeTerrainSphere(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
 *     VoxelDebrisManager.explodeDebrisInRadius(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
 * });
 *
 * // PvP hit sync
 * this.multiplayer?.onHit((_senderId, targetId, damage, _extras) => {
 *     const localId = this.multiplayer!.networkManager.localPlayerId;
 *     if (targetId === localId) {
 *         this.playerController.takeDamage(damage, 'explosion');
 *     }
 * });
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📐 GRENADE TUNING GUIDE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * | Parameter        | Low Arc (mortar) | Medium Arc (grenade) | High Arc (lob) |
 * |------------------|----------------:|---------------------:|---------------:|
 * | projectileSpeed  | 15              | 10                   | 6              |
 * | gravityScale     | 0.5             | 1.0                  | 1.5            |
 * | fireRate         | 0.3             | 0.5                  | 0.8            |
 *
 * **Higher gravityScale** = steeper, shorter arc.
 * **Lower projectileSpeed** = shorter range, more pronounced arc.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

// This file is documentation only — no executable code.
// The examples above are meant to be copied into Game.ts files.
export {};
