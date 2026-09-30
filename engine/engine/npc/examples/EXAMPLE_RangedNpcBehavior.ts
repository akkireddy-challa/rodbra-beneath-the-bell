/**
 * @fileoverview EXAMPLE_RangedNpcBehavior - Template for NPCs with ranged weapons
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🔫 AI AGENT: EXAMPLE RANGED NPC WITH GUNS/BOWS
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This file demonstrates how to create NPCs that:
 * - Have ranged weapons equipped (pistol, rifle, bow, laser blaster, etc.)
 * - Use the same weapon system as players (RangedWeaponRegistry)
 * - Shoot projectiles at targets
 * 
 * **🎯 USES SAME APPROACH AS PLAYER!**
 * NPCs share the player's weapon presets and grip metadata:
 * - Weapon added to character root (rotates with NPC)
 * - Arm attachment overrides make arms reach to weapon grips
 *
 * @see RangedWeaponRegistry.ts - Available weapon types and presets
 * @see RangedWeaponSystem.ts - Player ranged weapon system
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚠️ CRITICAL: ENABLE HEALTH HUD FOR COMBAT GAMES!
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * The player health bar is HIDDEN by default. When using ranged NPCs that can
 * damage the player, you MUST enable the health display:
 * 
 * ```typescript
 * // In setupPlayerController() after connecting HUD:
 * this.hud.setPlayerController(this.playerController);
 * this.hud.showHealth();  // ← REQUIRED for combat games!
 * ```
 * 
 * Without this, players take damage but won't see their HP bar.
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 COMPLETE EXAMPLE: RANGED GUARD NPCs
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ```typescript
 * // In Game.ts:
 * import { RangedNpcBehavior } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';
 * import { createStormtrooperNpcFactory } from 'engine/npc/customization/CostumePresets.js';
 *
 * async load() {
 *     const handle = this.engine.registerNpc('trooper', new RangedNpcBehavior({
 *         weaponType: 'laser_blaster'
 *     }), {
 *         characterFactory: createStormtrooperNpcFactory(),
 *         hostile: true
 *     });
 *     await handle.spawn(10, 5);
 * }
 * ```
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import { 
	createRangedWeaponMesh,
	RangedWeaponType,
	makeRangedWeaponVisualOnly,
	type RangedWeaponTypeId,
	type RangedWeaponPreset
} from 'engine/RangedWeaponRegistry.js';
import { ShootableComponent, Projectile, type ProjectileConfig } from 'engine/ShootableComponent.js';
import { CollisionMask } from 'engine/CollisionLayers.js';
import { ProjectileManager } from 'engine/ProjectileManager.js';
import { NpcRangedWeaponHold } from 'engine/npc/examples/NpcRangedWeaponHold.js';

export type RangedNpcWeaponType = RangedWeaponTypeId;

export interface RangedNpcConfig {
	weaponType?: RangedNpcWeaponType;
	/** Multiplies the preset's world size, independently of the NPC model's root scale. */
	weaponScale?: number;
	attackRange?: number;
	aimSpread?: number;
	/** Seconds between shots (default: 3 seconds) */
	shotInterval?: number;
	/**
	 * Projectile + trail color override (default: the weapon preset's color).
	 * Useful for making hostile fire visually distinct from the player's.
	 */
	projectileColor?: number;
}

/**
 * Ranged NPC behavior - uses SAME approach as player RangedWeaponSystem!
 * 
 * **Projectile Management:**
 * All projectiles are registered with the central ProjectileManager on creation.
 * This means projectiles continue functioning normally even if the NPC dies.
 * The ProjectileManager handles updates, collision detection, and cleanup.
 */
export class RangedNpcBehavior extends NpcEnemyBehavior {
	private weaponType: RangedNpcWeaponType;
	private weaponScale: number;
	private attackRange: number;
	private aimSpread: number;
	private shotInterval: number; // Seconds between shots
	private projectileColor: number | null;

	private weaponMesh: THREE.Group | null = null;
	private weaponPreset: RangedWeaponPreset | null = null;
	private weaponHold: NpcRangedWeaponHold | null = null;
	private shootableComponent: ShootableComponent | null = null;
	private npcController: NpcController | null = null;
	private weaponEquipped: boolean = false;
	private equipRetryCount: number = 0;
	
	// Store original config for cloning
	private config: RangedNpcConfig;

	constructor(config: RangedNpcConfig = {}) {
		super();
		this.config = config; // Store for clone()
		this.weaponType = config.weaponType ?? RangedWeaponType.PISTOL;
		this.weaponScale = config.weaponScale ?? 1.0;
		// Default range 15, with ±5 randomness (10-20 range)
		const baseRange = config.attackRange ?? 15;
		const rangeVariation = (Math.random() - 0.5) * 10; // -5 to +5
		this.attackRange = Math.max(8, baseRange + rangeVariation); // Min 8 units
		this.aimSpread = config.aimSpread ?? 0.1;
		// Default: 1 shot per 3 seconds, with ±1 second randomness (2-4 seconds)
		const baseInterval = config.shotInterval ?? 3.0;
		const intervalVariation = (Math.random() - 0.5) * 2.0; // -1 to +1 second
		this.shotInterval = Math.max(1.0, baseInterval + intervalVariation); // Min 1 second
		this.projectileColor = config.projectileColor ?? null;
	}
	
	/**
	 * Clone behavior for each NPC instance.
	 *
	 * Uses `Object.create(Object.getPrototypeOf(this))` so subclasses keep
	 * their own prototype — a `class TalkingRangedBehavior extends RangedNpcBehavior`
	 * still receives a `TalkingRangedBehavior` here, with its overridden
	 * `update()` and added fields intact. Subclasses don't need to override
	 * `clone()` just to preserve their identity.
	 *
	 * `Object.assign(target, this)` shallow-copies own enumerable fields. This
	 * means object-typed state (weaponMesh, controllers, presets) would be
	 * SHARED between clones — including the template instance the registry
	 * holds. Below, every per-NPC mutable field is reset to the same defaults
	 * the class-field initializers would produce, so clones start with their
	 * own state and the template stays untouched.
	 */
	clone(): RangedNpcBehavior {
		const c = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as RangedNpcBehavior;
		c.weaponMesh = null;
		c.weaponPreset = null;
		c.weaponHold = null;
		c.shootableComponent = null;
		c.npcController = null;
		c.weaponEquipped = false;
		c.equipRetryCount = 0;
		return c;
	}

	initialize(controller: ICharacterContext): void {
		super.initialize(controller);
		this.npcController = controller as NpcController;
		this.equipRetryCount = 0;
		
		// Make NPCs die in one melee hit (sword, axe, etc.)
		this.npcController.onMeleeHit = (_dir, _imp) => {
			this.npcController!.takeDamage(9999, 'melee'); // One-shot kill
		};

		// Equip weapon (will retry if block renderer not ready)
		this.equipWeapon(this.npcController);
	}

	/**
	 * Equip a weapon with hands reaching its grips, as in RangedWeaponSystem.
	 * 
	 * 1. Add weapon to NPC character root (rotates with NPC)
	 * 2. Position at shoulder height
	 * 3. Set arm attachment overrides (arms reach to weapon grips)
	 */
	private equipWeapon(controller: NpcController): void {
		// An asynchronous character load may finish after this NPC has died.
		if (controller.isDead()) return;
		const renderSkinned = controller.isRenderingSkinnedMesh();

		// The block renderer drives arm grips for procedural NPCs. In skinned-render
		// mode (custom/generated characters) the block character is hidden and never
		// updated, so its arm overrides would be invisible — the real skeleton's arms
		// are posed via setSkinnedArmGrip instead, and no block renderer is required.
		// Without this branch the gun was parented at a fixed offset with no IK, so it
		// floated beside the character and the hands stayed in their animation pose.
		const blockRenderer = controller.getBlockCharacterRenderer();
		if (!blockRenderer && !renderSkinned) {
			if (this.equipRetryCount < 10) {
				this.equipRetryCount++;
				setTimeout(() => this.equipWeapon(controller), 100);
			} else {
				console.error('🔫 Failed to equip weapon - block renderer never became available');
			}
			return;
		}

		// Create weapon from preset (same as player)
		const weapon = createRangedWeaponMesh(this.weaponType);
		const { mesh, preset } = weapon;
		mesh.name = `NPC_Weapon_${this.weaponType}`;
		this.weaponMesh = mesh;
		this.weaponPreset = preset;

		// Make weapon visual-only (no physics)
		makeRangedWeaponVisualOnly(mesh);

		this.weaponHold = new NpcRangedWeaponHold(controller, weapon, this.weaponScale);

		// Create shootable component
		// Convert shotInterval (seconds) to fire rate (shots per second)
		const fireRate = 1.0 / this.shotInterval;
		this.shootableComponent = new ShootableComponent(
			preset.muzzleOffset.clone(),
			fireRate,
			this.createProjectileConfig()
		);

		this.weaponEquipped = true;
	}

	/** Refresh block weapon targets after the visible body has finished posing. */
	onPoseUpdated(): void {
		if (this.weaponEquipped) this.weaponHold?.onPoseUpdated();
	}

	private createProjectileConfig(): ProjectileConfig {
		if (!this.weaponPreset) {
			return {
				speed: 30,
				localFireDirection: new THREE.Vector3(0, 0, 1),
				// NPC projectiles use ENEMY_PROJECTILE mask to hit players
				collisionMask: CollisionMask.ENEMY_PROJECTILE
			};
		}
		
		const preset = this.weaponPreset;
		const projectileRadius = preset.projectileRadius ?? 0.03;
		const projectileColor = this.projectileColor ?? preset.projectileColor ?? 0xffaa00;
		const trailLength = preset.trailLength ?? 4;
		const hasCustomMesh = !!preset.createProjectileMesh;

		return {
			speed: preset.projectileSpeed,
			localFireDirection: new THREE.Vector3(0, 0, 1),
			// NPC projectiles use ENEMY_PROJECTILE mask to hit players
			collisionMask: CollisionMask.ENEMY_PROJECTILE,
			visualConfig: {
				geometry: hasCustomMesh ? undefined : new THREE.SphereGeometry(projectileRadius, 8, 8),
				customMesh: preset.createProjectileMesh?.(projectileRadius, projectileColor),
				// 'neon' — self-lit in its own colour; glow is in units of the
				// voxel full-glow (3.0), so this keeps the old 3.0/2.0 levels.
				material: createWeaponPartMaterial('neon', {
					color: projectileColor,
					glow: (hasCustomMesh ? 3.0 : 2.0) / 3,
				}),
				trail: {
					enabled: trailLength > 0,
					length: trailLength,
					color: projectileColor
				},
				explosion: preset.explosion,
				gravityScale: preset.gravityScale,
			}
		};
	}

	/**
	 * Update behavior - chase player and shoot when in range
	 */
	update(
		deltaTime: number,
		currentPosition: THREE.Vector3,
		_currentTarget: THREE.Vector3 | null
	): THREE.Vector3 | null {
		// Note: Projectiles are managed by ProjectileManager, no local update needed

		if (!this.npcController) return null;

		// Get player position
		const playerPos = this.getPlayerPosition();
		if (!playerPos) {
			return super.update(deltaTime, currentPosition, _currentTarget);
		}
		
		// Calculate distance to player
		const npcPos = this.npcController.getPosition();
		const distance = npcPos.distanceTo(playerPos);
		
		// Always face the player when we can see them
		this.faceTarget(playerPos);
		
		// If in attack range, STOP moving and SHOOT
		if (distance <= this.attackRange) {
			// Try to shoot at player
			if (this.weaponEquipped) {
				this.tryShoot(playerPos);
			}
			// Return null to STOP movement (stay in place and shoot)
			return null;
		}
		
		// If outside attack range, chase the player
		return playerPos.clone();
	}

	/**
	 * Try to shoot at a target position
	 */
	private tryShoot(targetPos: THREE.Vector3): void {
		if (!this.shootableComponent || !this.weaponMesh || !this.npcController) {
			return;
		}
		
		const engine = this.npcController.getEngine();
		const physicsWorld = engine.physicsWorld;
		if (!physicsWorld) {
			return;
		}
		
		// Check if we can shoot (fire rate cooldown)
		if (!this.shootableComponent.canShoot()) {
			return; // Still on cooldown
		}
		
		// Mark shot time manually since we're bypassing shoot()
		(this.shootableComponent as any).lastShotTime = performance.now();
		
		// CRITICAL: Update world matrices before shooting
		const character = this.npcController.getCharacter();
		character.updateMatrixWorld(true);
		this.weaponMesh.updateMatrixWorld(true);
		
		// Get weapon's world position for projectile spawn
		const spawnPos = new THREE.Vector3();
		this.weaponHold!.getNextMuzzlePosition(spawnPos);
		
		// Aim at player's body center (add some height for torso)
		const aimTarget = targetPos.clone();
		aimTarget.y += 1.0; // Aim at player's torso, not feet
		
		// Calculate direction from spawn to player (3D aiming!)
		const direction = aimTarget.clone().sub(spawnPos).normalize();
		
		// Add some random spread
		const spread = this.aimSpread;
		direction.x += (Math.random() - 0.5) * spread;
		direction.y += (Math.random() - 0.5) * spread * 0.5; // Less vertical spread
		direction.z += (Math.random() - 0.5) * spread;
		direction.normalize();
		
		// Create projectile directly with calculated direction
		const config = this.createProjectileConfig();
		const projectile = new Projectile(
			spawnPos,
			direction,
			config.speed,
			physicsWorld,
			engine,
			config.onHitCallback,
			config.visualConfig,
			undefined,
			config.collisionMask
		);
		
		if (projectile) {
			// Mark as enemy projectile so it can damage the player
			// The callback notifies any registered player health system
			projectile.setEnemyProjectile((proj) => {
				// Fire event that player health system can listen to
				const playerController = (engine as unknown as { playerController?: { onEnemyProjectileHit?: () => void } }).playerController;
				if (playerController?.onEnemyProjectileHit) {
					playerController.onEnemyProjectileHit();
				}
				// Also dispatch a custom event on the engine for flexibility
				const engineAny = engine as unknown as { dispatchEvent?: (event: { type: string; projectile: Projectile }) => void };
				if (engineAny.dispatchEvent) {
					engineAny.dispatchEvent({ type: 'enemyProjectileHitPlayer', projectile: proj });
				}
			});
			
			// Register with central ProjectileManager - handles updates/cleanup even if NPC dies
			ProjectileManager.getInstance().register(projectile);
		}
	}

	/**
	 * Get the player's current position
	 */
	private getPlayerPosition(): THREE.Vector3 | null {
		if (!this.npcController) return null;
		
		const engine = this.npcController.getEngine();
		
		// Try to get player position from engine's player controller
		const playerController = (engine as any).playerController;
		if (playerController && typeof playerController.getPosition === 'function') {
			return playerController.getPosition();
		}
		
		// Fallback: search scene for player block character
		const scene = engine.scene;
		if (!scene) return null;
		
		let playerPos: THREE.Vector3 | null = null;
		scene.traverse((obj) => {
			if (obj.name === 'BlockCharacter' || obj.name === 'BlockCharacter_Bitmagic') {
				playerPos = obj.position.clone();
			}
		});
		
		return playerPos;
	}

	/**
	 * Face toward a target position
	 */
	private faceTarget(targetPos: THREE.Vector3): void {
		if (!this.npcController) return;
		
		const npcPos = this.npcController.getPosition();
		const direction = new THREE.Vector3(
			targetPos.x - npcPos.x,
			0,
			targetPos.z - npcPos.z
		).normalize();
		
		// Only rotate if we have a valid direction
		if (direction.lengthSq() > 0.001) {
			const targetRotation = Math.atan2(direction.x, direction.z);
			const character = this.npcController.getCharacter();
			if (character) {
				character.rotation.y = targetRotation;
			}
		}
	}

	/**
	 * Get enemy projectiles from the central ProjectileManager.
	 * Note: This returns ALL enemy projectiles, not just ones fired by this NPC.
	 * For most use cases, query ProjectileManager directly.
	 */
	getProjectiles(): Projectile[] {
		return ProjectileManager.getInstance().getEnemyProjectiles();
	}

	/**
	 * Hand the gun from the live aiming rig to the corpse's trigger hand.
	 * Preserve its world transform: the skinned ragdoll drives that bone, while
	 * the block ragdoll clones the hand and its attached weapon into one limb.
	 * Existing projectiles continue functioning via ProjectileManager.
	 */
	onNpcDeath(): void {
		this.weaponEquipped = false;
		const controller = this.npcController;
		const mesh = this.weaponMesh;
		if (!controller || !mesh) return;
		const hand = controller.getBodyPartObject('rightHand');
		if (this.weaponHold) {
			this.weaponHold.attachToCorpseHands();
		} else if (hand) {
			hand.attach(mesh);
		} else {
			console.warn('RangedNpcBehavior: missing right hand at death; removing the held weapon');
			mesh.removeFromParent();
		}
		// The hand now owns the weapon; an IK target beneath that same hand would
		// form a feedback loop if the controller evaluates one last live pose.
		controller.clearSkinnedArmGrip('right');
		controller.clearSkinnedArmGrip('left');
		const renderer = controller.getBlockCharacterRenderer();
		renderer?.clearArmAttachmentOverride('right');
		renderer?.clearArmAttachmentOverride('left');
	}

	dispose(): void {
		this.weaponHold?.dispose();
		this.weaponHold = null;
		// Note: Projectiles are managed by ProjectileManager, no cleanup needed here
		
		// Clear arm grips. Only one path was active, but clearing both the block-renderer
		// overrides and the skinned IK grips is harmless and stays robust if a character
		// swap changed the render mode after equip.
		if (this.npcController) {
			const blockRenderer = this.npcController.getBlockCharacterRenderer();
			if (blockRenderer) {
				blockRenderer.clearArmAttachmentOverride('right');
				blockRenderer.clearArmAttachmentOverride('left');
			}
			this.npcController.clearSkinnedArmGrip('right');
			this.npcController.clearSkinnedArmGrip('left');
		}
		
		if (this.weaponMesh && this.weaponMesh.parent) {
			this.weaponMesh.parent.remove(this.weaponMesh);
		}
		this.weaponMesh = null;
		
		super.dispose();
	}
}

export { RangedWeaponType };
