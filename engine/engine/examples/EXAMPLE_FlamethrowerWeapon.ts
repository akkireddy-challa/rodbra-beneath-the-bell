/**
 * @fileoverview EXAMPLE_FlamethrowerWeapon — Rapid-fire short-range flame weapon + multiplayer
 *
 * SEARCH KEYWORDS: flamethrower, flame thrower, fire weapon, fire breath, flame,
 * continuous fire, spray weapon, short range, rapid fire, napalm, incendiary
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🔥 AI AGENT: FLAMETHROWER WEAPON WITH MULTIPLAYER
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * This file demonstrates a flamethrower built on the existing projectile system:
 * - Very high fireRate (15–20 shots/sec) for continuous stream effect
 * - Low projectileSpeed + short lifetime = short range
 * - Small bright particles with random spread = flame cone
 * - Low damage per particle, high DPS from volume
 * - No explosion — direct hit damage only
 * - Multiplayer: throttled sendShoot + onRemoteShoot visual particles
 *
 * **Design:** Instead of a custom particle system, this uses rapid-fire tiny
 * projectiles. The engine's existing hold-to-fire (`continuous: true`) on
 * `RangedWeaponSystem` makes this work seamlessly with desktop + mobile input.
 *
 * **Copy the patterns below into your Game.ts — do NOT import this file.**
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 1: REGISTER FLAMETHROWER WEAPON
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * import * as THREE from 'three';
 * import { RangedWeaponRegistry } from 'engine/RangedWeaponRegistry.js';
 * import type { RangedWeaponPreset, RangedWeaponMeshResult } from 'engine/RangedWeaponRegistry.js';
 * import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
 *
 * // ─── Flame particle mesh (small bright sphere) ───
 * function createFlameMesh(radius: number, _color: number): THREE.Group {
 *     const flame = new THREE.Group();
 *     const particle = new THREE.Mesh(
 *         new THREE.SphereGeometry(radius * 2, 4, 4),  // Low-poly for performance
 *         new THREE.MeshBasicMaterial({
 *             color: 0xff4400,
 *             transparent: true,
 *             opacity: 0.8,
 *         })
 *     );
 *     flame.add(particle);
 *     return flame;
 * }
 *
 * // ─── Flamethrower weapon mesh (nozzle + tank) ───
 * function createFlamethrowerMesh(group: THREE.Group, _preset: RangedWeaponPreset): RangedWeaponMeshResult {
 *     const metalMat = createWeaponPartMaterial('metal', { color: 0x444444 });
 *
 *     // Barrel/nozzle
 *     const barrel = new THREE.Mesh(
 *         new THREE.CylinderGeometry(0.015, 0.02, 0.25, 8),
 *         metalMat
 *     );
 *     barrel.rotation.x = Math.PI / 2; // Point forward (+Z)
 *     barrel.position.set(0, 0, 0.15);
 *     group.add(barrel);
 *
 *     // Fuel tank (behind grip)
 *     const tank = new THREE.Mesh(
 *         new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8),
 *         createWeaponPartMaterial('paint', { color: 0xcc3300 })
 *     );
 *     tank.position.set(0, -0.02, -0.08);
 *     group.add(tank);
 *
 *     // Foregrip position (left hand holds front of weapon)
 *     const foregrip = new THREE.Vector3(0, -0.02, 0.08);
 *
 *     return { foregrip };
 * }
 *
 * // ─── Register ───
 * RangedWeaponRegistry.register('flamethrower', {
 *     preset: {
 *         name: 'Flamethrower',
 *         damage: 3,               // Low per-particle — DPS comes from volume
 *         fireRate: 18,            // 18 particles/sec = dense flame stream
 *         projectileSpeed: 8,      // Slow — short range
 *         magazineSize: 200,       // Large fuel tank
 *         hands: 2,
 *         muzzleOffset: new THREE.Vector3(0, 0.01, 0.28),
 *         gripOffset: new THREE.Vector3(0, 0, -0.05),
 *         foregrip: new THREE.Vector3(0, -0.02, 0.08),
 *         recoilStrength: 0.02,    // Minimal recoil
 *         heightOffset: 0.2,
 *         // Flame particles
 *         projectileRadius: 0.04,
 *         projectileColor: 0xff4400,
 *         createProjectileMesh: createFlameMesh,
 *         trailLength: 2,          // Short trail for flame effect
 *         // No explosion — damage is per-particle direct hits
 *     } as RangedWeaponPreset,
 *     createMesh: createFlamethrowerMesh,
 * });
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 2: EQUIP + ADD SPREAD FOR CONE EFFECT
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';
 * import { Projectile } from 'engine/Projectile.js';
 *
 * this.rangedSystem = new RangedWeaponSystem(this.engine, this.engine.physicsWorld!);
 * this.rangedSystem.equipWeapon('flamethrower', player, playerLoader);
 * this.playerController.setAttackSystem(this.rangedSystem);
 * // RangedWeaponSystem already uses { continuous: true } — hold to fire works.
 *
 * this.rangedSystem.onProjectileCreated = (projectile: Projectile) => {
 *     // Flame particles are short-lived — the low projectileSpeed (8) combined
 *     // with the default 10s lifetime already limits effective range. The particles
 *     // fly ~12m before expiring, which is appropriate for a flamethrower.
 *     // For shorter range, reduce projectileSpeed in the preset.
 *
 *     // Multiplayer: sync NPC/animal hits
 *     if (this.multiplayer) {
 *         projectile.setOnRemoteNpcHit((networkId, damage, hitPos, hitDir) => {
 *             this.multiplayer!.sendNpcHit(networkId, damage, hitPos, hitDir);
 *         });
 *         projectile.setOnRemoteAnimalHit((networkId, damage, hitPos, hitDir) => {
 *             this.multiplayer!.sendAnimalHit(networkId, damage, hitPos, hitDir);
 *         });
 *     }
 * };
 *
 * // Enable health HUD
 * this.hud.setPlayerController(this.playerController);
 * this.hud.showHealth();
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 STEP 3: MULTIPLAYER — THROTTLED SHOOT SYNC
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * **⚠️ IMPORTANT:** At 18 shots/sec, sending every projectile would flood the
 * network. Instead, throttle to ~5 events/sec — remote clients interpolate.
 *
 * ```typescript
 * import type { ShootData } from 'engine/networking/NetworkTypes.js';
 *
 * // Throttle sendShoot to ~5 per second (every 200ms)
 * let lastShootSendTime = 0;
 * const SHOOT_SEND_INTERVAL = 200; // ms
 *
 * const previousCallback = this.rangedSystem!.onProjectileCreated;
 * this.rangedSystem!.onProjectileCreated = (projectile: Projectile) => {
 *     previousCallback?.(projectile);
 *
 *     // Throttle network sends
 *     const now = performance.now();
 *     if (this.multiplayer && now - lastShootSendTime >= SHOOT_SEND_INTERVAL) {
 *         lastShootSendTime = now;
 *         const pos = projectile.getPosition();
 *         const dir = projectile.getDirection();
 *         this.multiplayer.sendShoot({
 *             position: { x: pos.x, y: pos.y, z: pos.z },
 *             direction: { x: dir.x, y: dir.y, z: dir.z },
 *             speed: projectile.getSpeed(),
 *             color: 0xff4400,
 *             radius: 0.04,
 *             gravityScale: 0,
 *         });
 *     }
 * };
 *
 * // ⚠️ CRITICAL: Remote flame visuals!
 * // Each received event spawns a BURST of visual particles to match the
 * // local player's continuous stream appearance.
 * this.multiplayer?.onRemoteShoot((_senderId: string, data: ShootData) => {
 *     const basePos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
 *     const baseDir = new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z);
 *     const speed = data.speed;
 *
 *     // Spawn a burst of 3-4 flame particles with slight spread
 *     const particleCount = 3 + Math.floor(Math.random() * 2);
 *     for (let i = 0; i < particleCount; i++) {
 *         const flame = new THREE.Mesh(
 *             new THREE.SphereGeometry(0.04 + Math.random() * 0.03, 4, 4),
 *             new THREE.MeshBasicMaterial({
 *                 color: new THREE.Color().setHSL(
 *                     0.05 + Math.random() * 0.05, // Orange-red hue
 *                     1.0,
 *                     0.5 + Math.random() * 0.2
 *                 ),
 *                 transparent: true,
 *                 opacity: 0.8,
 *             })
 *         );
 *         flame.position.copy(basePos);
 *         this.engine.scene.add(flame);
 *
 *         // Randomize direction slightly for cone spread
 *         const dir = baseDir.clone();
 *         dir.x += (Math.random() - 0.5) * 0.3;
 *         dir.y += (Math.random() - 0.5) * 0.15;
 *         dir.z += (Math.random() - 0.5) * 0.3;
 *         dir.normalize();
 *
 *         // Animate: fly forward, fade out, shrink
 *         let elapsed = 0;
 *         const lifetime = 0.8 + Math.random() * 0.7; // 0.8–1.5 seconds
 *         const mat = flame.material as THREE.MeshBasicMaterial;
 *
 *         const animate = () => {
 *             elapsed += 1 / 60;
 *             if (elapsed > lifetime) {
 *                 this.engine.scene.remove(flame);
 *                 flame.geometry.dispose();
 *                 mat.dispose();
 *                 return;
 *             }
 *             const t = elapsed / lifetime; // 0→1 normalized time
 *             flame.position.addScaledVector(dir, speed / 60 * (1 - t * 0.5)); // Slow down
 *             mat.opacity = 0.8 * (1 - t);   // Fade out
 *             const s = 1 + t * 1.5;          // Grow as it disperses
 *             flame.scale.set(s, s, s);
 *             requestAnimationFrame(animate);
 *         };
 *         // Stagger start for natural look
 *         setTimeout(() => requestAnimationFrame(animate), i * 30);
 *     }
 * });
 *
 * // PvP hit sync
 * this.multiplayer?.onHit((_senderId, targetId, damage, _extras) => {
 *     const localId = this.multiplayer!.networkManager.localPlayerId;
 *     if (targetId === localId) {
 *         this.playerController.takeDamage(damage, 'fire');
 *     }
 * });
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📐 FLAMETHROWER TUNING GUIDE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * | Parameter        | Short Range | Medium Range | Long Range  |
 * |------------------|------------:|-------------:|------------:|
 * | projectileSpeed  | 6           | 8            | 12          |
 * | fireRate         | 20          | 15           | 10          |
 * | damage (per hit) | 2           | 3            | 5           |
 * | **Effective DPS** | **40**     | **45**       | **50**      |
 *
 * **DPS** = damage × fireRate × hit_probability. Not all particles hit, so
 * actual DPS is lower at range. Tune `damage` and `fireRate` together.
 * Range is controlled by `projectileSpeed` — lower speed = shorter range.
 *
 * **Network throttle:** Adjust `SHOOT_SEND_INTERVAL`:
 * - 100ms = smoother remote visuals, more bandwidth
 * - 300ms = choppier visuals, less bandwidth
 * - 200ms is a good default
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚠️ PERFORMANCE NOTES
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * - At 18 particles/sec with default 10s lifetime, many projectiles exist simultaneously
 * - Each has a physics body — keep `collisionRadius` small (0.04) to reduce load
 * - If performance drops, reduce `fireRate` to 12 and increase `damage` to 5
 * - The `magazineSize: 200` gives ~11 seconds of continuous fire
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

// This file is documentation only — no executable code.
// The examples above are meant to be copied into Game.ts files.
export {};
