/**
 * @fileoverview EXAMPLE_BazookaGame — Complete bazooka arena with multiplayer
 *
 * SEARCH KEYWORDS: bazooka, rocket launcher, RPG, AOE, area of effect, explosion,
 * explosive weapon, multiplayer shooting, remote shoot, arena combat, PvP
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🚀 AI AGENT: BAZOOKA ARENA GAME SETUP
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * This file demonstrates a complete bazooka arena game with:
 * - Player bazooka (built-in BAZOOKA preset) with AOE explosions
 * - Explosion config override for arena size
 * - NPCs that shoot back with bazookas (RangedNpcBehavior)
 * - Full multiplayer: remote shoot visuals, PvP damage, NPC hit sync
 * - Player health HUD
 *
 * **Copy the patterns below into your Game.ts — do NOT import this file.**
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚠️ CRITICAL RULES
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **NEVER set damage to absurd values** like 9999 — use the preset's built-in
 *    damage (100 for BAZOOKA) or a small modifier.
 *
 * 2. **ALWAYS check explosion damageRadius vs arena size.** Rule of thumb:
 *    `damageRadius ≤ 10%` of the arena's smallest dimension.
 *    For a 60×60 arena → damageRadius ≤ 6m.
 *
 * 3. **NEVER leave onRemoteShoot empty** — always spawn a visual projectile.
 *
 * 4. **Use RangedNpcBehavior** for NPCs in combat games — don't use default melee.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 COMPLETE EXAMPLE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ```typescript
 * // ═══════════════════════════════════════════════════════════════════
 * // IMPORTS
 * // ═══════════════════════════════════════════════════════════════════
 *
 * import * as THREE from 'three';
 * import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';
 * import { RangedWeaponType } from 'engine/RangedWeaponRegistry.js';
 * import { Projectile } from 'engine/Projectile.js';
 * import { ProjectileManager } from 'engine/ProjectileManager.js';
 * import { NpcManager, SimpleNpcManagerBehavior } from 'engine/npc/index.js';
 * import { RangedNpcBehavior } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';
 * import { MultiplayerSetup } from 'engine/networking/index.js';
 * import type { ShootData } from 'engine/networking/NetworkTypes.js';
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // CLASS FIELDS
 * // ═══════════════════════════════════════════════════════════════════
 *
 * private rangedSystem: RangedWeaponSystem | null = null;
 * private enemyManager: NpcManager | null = null;
 * private multiplayer: MultiplayerSetup | null = null;
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 1: EQUIP BAZOOKA + OVERRIDE EXPLOSION CONFIG
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // In setupPlayerController() or after player is ready:
 *
 * this.rangedSystem = new RangedWeaponSystem(this.engine, this.engine.physicsWorld!);
 * this.rangedSystem.equipWeapon(RangedWeaponType.BAZOOKA, player, playerLoader);
 * this.playerController.setAttackSystem(this.rangedSystem);
 *
 * // Default BAZOOKA: radius=4, damageRadius=6 — good for most arenas.
 * // To override explosion for a SMALL arena, set the explosion field
 * // in the preset BEFORE equipping (explosion config is baked at creation time):
 * //
 * //   import { RangedWeaponRegistry } from 'engine/RangedWeaponRegistry.js';
 * //   RangedWeaponRegistry.register('small_bazooka', {
 * //       ...bazookaPreset,
 * //       explosion: { enabled: true, radius: 2.0, duration: 1.0,
 * //                    damage: 60, damageRadius: 3.0, color: 0xff4400 },
 * //   });
 * //   rangedSystem.equipWeapon('small_bazooka', player, playerLoader);
 *
 * this.rangedSystem.onProjectileCreated = (projectile: Projectile) => {
 *
 *     // Wire up multiplayer NPC/animal hit callbacks
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
 *             // Broadcast explosion visual to remote clients
 *             this.multiplayer!.sendExplosion({
 *                 position: { x: pos.x, y: pos.y, z: pos.z },
 *                 radius: config.radius,
 *                 duration: config.duration,
 *                 color: config.color,
 *                 damageRadius: config.damageRadius,
 *                 damage: config.damage,
 *             });
 *             // Broadcast terrain/voxel destruction
 *             this.multiplayer!.sendEnvironmentDestruction({
 *                 position: { x: pos.x, y: pos.y, z: pos.z },
 *                 radius: 3.0,       // Destruction radius
 *                 impulse: 8,
 *                 upImpulse: 5,
 *             });
 *         });
 *
 *         // ⚠️ PvP AOE: engine auto-detects remote players in blast radius
 *         // Two damage types: "hit" (sendHit) = direct AOE, "explosion" (onExplosion) = environmental
 *         projectile.setOnAoePlayerHit(
 *             this.multiplayer!.remoteCharacters,
 *             (networkId, damage) => this.multiplayer!.sendHit(networkId, damage, { type: 'explosion' }),
 *         );
 *     }
 * };
 *
 * // Enable health HUD — REQUIRED for combat games!
 * this.hud.setPlayerController(this.playerController);
 * this.hud.showHealth();
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 2: SPAWN RANGED ENEMY NPCs
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // NPCs shoot bazookas at the player — NOT default melee chase!
 * this.enemyManager = new NpcManager(
 *     this.engine,
 *     new SimpleNpcManagerBehavior('Trooper', new RangedNpcBehavior({
 *         weaponType: RangedWeaponType.BAZOOKA,
 *         attackRange: 20,     // How far NPCs start shooting
 *         shotInterval: 3.0,   // Seconds between NPC shots
 *         aimSpread: 0.15,     // Inaccuracy (higher = worse aim)
 *     }), true)  // true = enemy (hostile)
 * );
 *
 * // Spawn NPCs at positions
 * await this.enemyManager.spawnNpc(10, 5);
 * await this.enemyManager.spawnNpc(-10, 5);
 * await this.enemyManager.spawnNpc(0, -10);
 *
 * // Register NPCs for multiplayer sync (host only)
 * if (this.multiplayer?.isRoomHost) {
 *     const npcs = this.enemyManager.getAllNpcs();
 *     for (const npc of npcs) {
 *         this.multiplayer.registerNpc(npc.getCharacter(), npc.id, {
 *             animationController: npc.getAnimationController(),
 *         });
 *     }
 * }
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 3: MULTIPLAYER — sendShoot + onRemoteShoot
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // Hook into the ranged system to broadcast shots
 * const originalCallback = this.rangedSystem.onProjectileCreated;
 * this.rangedSystem.onProjectileCreated = (projectile: Projectile) => {
 *     // Call the original callback first (NPC hit wiring from Step 1)
 *     originalCallback?.(projectile);
 *
 *     // Broadcast shot to all other players
 *     if (this.multiplayer) {
 *         const pos = projectile.getPosition();
 *         const dir = projectile.getDirection();
 *         this.multiplayer.sendShoot({
 *             position: { x: pos.x, y: pos.y, z: pos.z },
 *             direction: { x: dir.x, y: dir.y, z: dir.z },
 *             speed: projectile.getSpeed(),
 *             color: 0x556b2f,       // Olive drab (matches BAZOOKA)
 *             radius: 0.08,
 *             gravityScale: 0,       // Bazookas fly straight
 *         });
 *     }
 * };
 *
 * // ⚠️ CRITICAL: Spawn visual rockets for remote players' shots!
 * // Without this, other players' rockets are INVISIBLE.
 * this.multiplayer?.onRemoteShoot((_senderId: string, data: ShootData) => {
 *     const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
 *     const dir = new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z);
 *     const speed = data.speed;
 *     const gravity = (data.gravityScale ?? 0) * 9.81;
 *
 *     // Create a simple visual rocket mesh
 *     const rocket = new THREE.Group();
 *     const body = new THREE.Mesh(
 *         new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8),
 *         createWeaponPartMaterial('paint', { color: data.color ?? 0x556b2f })
 *     );
 *     body.rotation.x = Math.PI / 2; // Align with travel direction
 *     rocket.add(body);
 *     rocket.position.copy(pos);
 *     this.engine.scene.add(rocket);
 *
 *     // Animate the remote rocket (no physics, visual only)
 *     let elapsed = 0;
 *     const animate = () => {
 *         elapsed += 1 / 60;
 *         if (elapsed > 5) {
 *             this.engine.scene.remove(rocket);
 *             body.geometry.dispose();
 *             (body.material as THREE.Material).dispose();
 *             return;
 *         }
 *         rocket.position.addScaledVector(dir, speed / 60);
 *         rocket.position.y -= gravity / 60 * elapsed;
 *         // Face travel direction
 *         rocket.lookAt(rocket.position.clone().add(dir));
 *         requestAnimationFrame(animate);
 *     };
 *     requestAnimationFrame(animate);
 * });
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 3b: MULTIPLAYER — RECEIVE EXPLOSION + DESTRUCTION SYNC
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // ⚠️ CRITICAL: Without these handlers, remote players never see
 * // explosions or terrain craters from other players' rockets!
 *
 * import { Explosion } from 'engine/Explosion.js';
 * import type { VoxelTerrainSystem } from 'engine/VoxelTerrainSystem.js';
 * import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';
 *
 * // Receive explosion visuals from remote players
 * this.multiplayer?.onExplosion((_senderId: string, data) => {
 *     new Explosion(
 *         new THREE.Vector3(data.position.x, data.position.y, data.position.z),
 *         {
 *             enabled: true,
 *             radius: data.radius,
 *             duration: data.duration ?? 1.0,
 *             color: data.color ?? 0xff4400,
 *             damage: 0,          // No local damage — sender already applied it
 *             damageRadius: 0,
 *         },
 *         this.engine
 *     );
 * });
 *
 * // Receive terrain/voxel destruction from remote players
 * this.multiplayer?.onEnvironmentDestruction((_senderId: string, data) => {
 *     const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
 *     const radius = data.radius;
 *     const impulse = data.impulse ?? 8;
 *     const upImpulse = data.upImpulse ?? 5;
 *
 *     // Destroy terrain (if using VoxelTerrainSystem)
 *     const terrain = (this as any).terrainSystem as VoxelTerrainSystem | null;
 *     terrain?.explodeTerrainSphere(pos, radius, impulse, upImpulse);
 *
 *     // Scatter nearby debris
 *     VoxelDebrisManager.explodeDebrisInRadius(pos, radius, impulse, upImpulse);
 * });
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 4: MULTIPLAYER — PvP HIT SYNC
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // When this player's rocket hits another player
 * // (handled automatically by AOE system for nearby players)
 * // For direct hits, the projectile collision system handles it.
 *
 * // Report hits to all clients
 * this.multiplayer?.onHit((_senderId, targetId, damage, _extras) => {
 *     const localId = this.multiplayer!.networkManager.localPlayerId;
 *     if (targetId === localId) {
 *         // This player was hit — apply damage
 *         this.playerController.takeDamage(damage, 'explosion');
 *     }
 * });
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // STEP 5: CLEANUP IN dispose()
 * // ═══════════════════════════════════════════════════════════════════
 *
 * dispose() {
 *     this.rangedSystem?.dispose();
 *     this.enemyManager?.dispose();
 *     this.multiplayer?.dispose();
 * }
 * ```
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📐 EXPLOSION CONFIG SIZING GUIDE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * | Arena Size | radius (visual) | damageRadius (AOE) |
 * |------------|----------------:|-------------------:|
 * | 30×30      | 2.0             | 3.0                |
 * | 60×60      | 4.0             | 6.0 (BAZOOKA default) |
 * | 100×100    | 5.0             | 8.0                |
 * | 200×200    | 6.0             | 12.0               |
 *
 * **Rule:** damageRadius ≤ 10% of smallest arena dimension.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

// This file is documentation only — no executable code.
// The examples above are meant to be copied into Game.ts files.
export {};
