/**
 * @fileoverview EXAMPLE_MeleeNpcBehavior - Generic melee combat NPC behavior
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚔️ AI AGENT: EXAMPLE MELEE NPC BEHAVIOR
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This file demonstrates how to create NPCs that:
 * - Chase and attack the player with melee weapons
 * - Swing their weapon with the SAME animation as the player
 * - Hit the player using blade sweep raycasting
 * - Deal configurable damage
 * 
 * **⚔️ ATTACK SYSTEM (Same as Player!)**
 * NPCs use the same overhead swing animation as the player's WeaponMeleeSystem:
 * - Manual sword swing (0.4s duration)
 * - Blade sweep hit detection (raycasting from weapon tip/hilt)
 * - Can hit and damage the player!
 * 
 * @see WeaponMeleeSystem.ts - How player attacks (same swing logic!)
 * @see EXAMPLE_ArmedNpcBehavior.ts - Full example with weapon loading
 * @see WeaponRegistry.ts - Available weapon types
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚠️ CRITICAL: ENABLE HEALTH HUD FOR COMBAT GAMES!
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * The player health bar is HIDDEN by default. When using melee NPCs that can
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
 * ## 📋 COMPLETE EXAMPLE: MELEE ENEMY NPCs
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ```typescript
 * // In Game.ts:
 * import { MeleeNpcBehavior } from 'engine/npc/examples/EXAMPLE_MeleeNpcBehavior.js';
 *
 * async load() {
 *     // Register melee NPC behavior with the engine
 *     const handle = this.engine.registerNpc('enemy', new MeleeNpcBehavior({
 *         weaponType: 'sword',   // Type of weapon to create
 *         attackRange: 2.5,      // Attack when within this range
 *         attackCooldown: 1.5,   // Seconds between attacks
 *         damage: 25,            // Damage per hit
 *         chaseSpeed: 4.0        // Movement speed when chasing
 *     }), { hostile: true });
 *
 *     // Spawn enemies
 *     await handle.spawn(10, 5);
 *     await handle.spawn(15, 5);
 * }
 * ```
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🗡️ CONFIGURATION OPTIONS
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * | Option         | Default | Description                              |
 * |----------------|---------|------------------------------------------|
 * | weaponType     | 'sword' | Weapon type (sword, axe, spear, etc.)   |
 * | aggroRange     | 25      | Distance at which the NPC notices you   |
 * | returnToOrigin | true    | Walk back to the spawn point when you escape |
 * | attackRange    | 2.5     | Distance to trigger attack              |
 * | attackCooldown | 1.5     | Seconds between attacks                 |
 * | damage         | 25      | Damage dealt per hit                    |
 * | chaseSpeed     | 4.0     | Movement speed when chasing player      |
 * | weaponScale    | 1.0     | Scale of the weapon mesh                |
 * | bladeLength    | 1.0     | Length of the blade for hit detection   |
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import { MELEE_WEAPON_ANIMATIONS } from 'engine/AnimationPacks.js';
import { segmentHitsCapsule } from 'engine/MeleeSweepTargets.js';
import { orientBladeYawFramed, alignBladeToArm, seatGripTowardFingers, BLADE_IDLE_FORWARD } from 'engine/MeleeWeaponOrientation.js';

/**
 * Distance (m) at which a melee NPC notices the player and starts chasing.
 *
 * A chase behaviour with no aggro range makes EVERY NPC in the level pathfind
 * toward the player from anywhere on the map. Each of those goals is a full
 * layered A*, and the search cost grows with the distance to the goal, so a
 * crowd of distant enemies is the single most expensive thing in the frame
 * while none of them are even visible. 25 m covers a room and the corridor
 * beyond it; raise it for open-world chases, and give bosses their own value.
 */
export const DEFAULT_MELEE_NPC_AGGRO_RANGE = 25;

/**
 * Whether a melee NPC that has lost the player walks back to where it started.
 *
 * On by default, matching `NpcHostileBehavior`'s `returnToOrigin`. Without a
 * leash an aggro range makes every fight kiteable: the NPC stops dead wherever
 * the player left its range, so the player can retreat, heal, and walk back
 * into a fight that never reset. Set false for enemies that should hold the
 * ground they last stood on (e.g. a boss you can pull room by room).
 */
export const DEFAULT_MELEE_NPC_RETURN_TO_ORIGIN = true;

/**
 * Configuration for melee NPC behavior
 */
export interface MeleeNpcConfig {
    /** Weapon type for visual and hit detection (default: 'sword') */
    weaponType?: string;
    /** Distance at which the NPC starts chasing the player (default: 25) */
    aggroRange?: number;
    /** Walk back to the spawn point after losing the player (default: true) */
    returnToOrigin?: boolean;
    /** Attack range - NPC will attack when player is within this distance (default: 2.5) */
    attackRange?: number;
    /** Cooldown between attacks in seconds (default: 1.5) */
    attackCooldown?: number;
    /** Damage dealt per hit (default: 25) */
    damage?: number;
    /** Movement speed when chasing player (default: 4.0) */
    chaseSpeed?: number;
    /** Scale of the weapon mesh (default: 1.0) */
    weaponScale?: number;
    /** Length of the blade for hit detection (default: 1.0) */
    bladeLength?: number;
    /** Custom weapon mesh creator (optional - uses default sword if not provided) */
    createWeaponMesh?: () => THREE.Group;
    /** Vertical offset from NPC root to face for conversation camera (default: standing-human eye height) */
    focusOffsetY?: number;
}

/**
 * Generic melee combat NPC behavior
 *
 * Features:
 * - Chases the player once inside `aggroRange`, and leashes back to its spawn
 *   point when the player escapes (interruptible: re-entering range resumes
 *   the chase immediately)
 * - Attacks with overhead sword swing (same as player!)
 * - Blade sweep hit detection
 * - Configurable damage, range, and cooldowns
 */
export class MeleeNpcBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private npcController: NpcController | null = null;
    private config: MeleeNpcConfig;

    // Configuration
    private weaponType: string;
    private aggroRange: number;
    private returnToOrigin: boolean;
    private attackRange: number;
    private attackCooldown: number;
    private attackDamage: number;
    private chaseSpeed: number;
    private weaponScale: number;
    private bladeLength: number;
    
    // Weapon reference
    private weaponMesh: THREE.Group | null = null;
    
    // Chase state — true once the player has come inside aggroRange, and it
    // stays true out to AGGRO_RELEASE_FACTOR × aggroRange so an NPC standing
    // near the boundary doesn't toggle chase on and off, repathing each time.
    private isAggroed: boolean = false;

    // The controller's own speed, captured on the aggro edge so disengage can
    // put it back — chaseSpeed applies while chasing, not while leashing home.
    // Captured on the edge rather than in initialize() because the template may
    // change the NPC's speed after construction. Same handling, and the same
    // known corner (a setMoveSpeed() call made *during* aggro is discarded on
    // disengage), as NpcMeleeAttack.
    private baseMoveSpeed: number | null = null;

    // Leash anchor — where this NPC stood when the behavior was attached, i.e.
    // its spawn point (NpcController is constructed at the spawn position and
    // the behavior is initialized straight after). Per-NPC: set in initialize(),
    // cleared in clone(). Null only before initialize().
    private originPosition: THREE.Vector3 | null = null;

    // Attack state
    private attackCooldownTimer: number = 0;
    private isSwinging: boolean = false;
    private swingStartTime: number = 0;
    private swingDuration: number = 0.4; // 400ms swing like player
    private swingOrientation: THREE.Quaternion = new THREE.Quaternion();
    
    // Blade sweep hit detection
    private prevTipPos: THREE.Vector3 = new THREE.Vector3();
    private prevHiltPos: THREE.Vector3 = new THREE.Vector3();
    private isFirstFrame: boolean = true;
    private hitPlayerThisSwing: boolean = false;
    private bladeRadius: number = 0.15;

    /** Extra reach (m) added around the player's capsule so swings that visually
     *  connect register reliably (mirrors MELEE_BODY_HIT_MARGIN on the player side). */
    private static readonly PLAYER_HIT_MARGIN = 0.2;
    /** How far past the hand-bone origin (m), along the live wrist→fingers direction,
     *  the skinned NPC's weapon grip is seated each frame — so the sword comes out of
     *  the fist rather than the wrist. Raise to push further toward the fingertips. */
    private static readonly GRIP_TOWARD_FINGERS = 0.15;
    /** An NPC already chasing gives up at this multiple of aggroRange (hysteresis). */
    private static readonly AGGRO_RELEASE_FACTOR = 1.25;
    /** Distance (m) from the origin at which a returning NPC counts as home and idles.
     *  Same value NpcHostileBehavior uses for its returnToOrigin leash. */
    private static readonly ORIGIN_ARRIVAL_RADIUS = 1.0;
    private static readonly _tmpPlayerPos = new THREE.Vector3();
    private static readonly SWING_AXIS = new THREE.Vector3(1, 0, 0);

    constructor(config: MeleeNpcConfig = {}) {
        this.config = config;
        this.weaponType = config.weaponType ?? 'sword';
        this.aggroRange = config.aggroRange ?? DEFAULT_MELEE_NPC_AGGRO_RANGE;
        this.returnToOrigin = config.returnToOrigin ?? DEFAULT_MELEE_NPC_RETURN_TO_ORIGIN;
        this.attackRange = config.attackRange ?? 2.5;
        this.attackCooldown = config.attackCooldown ?? 1.5;
        this.attackDamage = config.damage ?? 25;
        this.chaseSpeed = config.chaseSpeed ?? 4.0;
        this.weaponScale = config.weaponScale ?? 1.0;
        this.bladeLength = config.bladeLength ?? 1.0;
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Clone behavior for each NPC instance.
     *
     * Uses `Object.create(Object.getPrototypeOf(this))` so subclasses keep
     * their own prototype — a `class TalkingMeleeBehavior extends MeleeNpcBehavior`
     * still receives a `TalkingMeleeBehavior` here, with its overridden
     * `update()` and added fields intact. Subclasses don't need to override
     * `clone()` just to preserve their identity.
     *
     * `Object.assign(target, this)` shallow-copies own enumerable fields. This
     * means object-typed state (Vector3, Euler, THREE.Group, controllers)
     * would be SHARED between clones — including the template instance the
     * registry holds. Below, every per-NPC mutable field is reset to the same
     * defaults the class-field initializers would produce, so clones start
     * with their own state and the template stays untouched.
     */
    clone(): MeleeNpcBehavior {
        const c = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as MeleeNpcBehavior;
        // Fresh per-NPC mutable state (object instances must NOT be shared)
        c.weaponMesh = null;
        c.swingOrientation = new THREE.Quaternion();
        c.prevTipPos = new THREE.Vector3();
        c.prevHiltPos = new THREE.Vector3();
        // Reset transient runtime state
        c.attackCooldownTimer = 0;
        c.isAggroed = false;
        c.baseMoveSpeed = null;
        // Leash anchor is per-NPC — initialize() sets it from THIS clone's
        // spawn position. Sharing the template's would send every NPC home to
        // wherever the last one spawned.
        c.originPosition = null;
        c.isSwinging = false;
        c.swingStartTime = 0;
        c.isFirstFrame = true;
        c.hitPlayerThisSwing = false;
        // Controllers are wired up in initialize() — clear so a stale
        // template reference can't leak into the clone.
        c.controller = null;
        c.npcController = null;
        return c;
    }

    /**
     * Initialize behavior when assigned to controller
     */
    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.npcController = controller as NpcController;
        this.attackCooldownTimer = 0;
        // Leash anchor: the position the NPC holds right now. Same rule as
        // NpcHostileBehavior — see originPosition.
        this.originPosition = controller.getPosition().clone();

        // Make NPCs die in one melee hit from player
        this.npcController.onMeleeHit = (_dir, _imp) => {
            this.npcController!.takeDamage(9999, 'melee'); // One-shot kill
        };

        // Load weapon animations and equip weapon
        this.loadAnimationsAndEquipWeapon(this.npcController);
    }
    
    /**
     * Load melee weapon animations and equip the weapon
     */
    private async loadAnimationsAndEquipWeapon(controller: NpcController): Promise<void> {
        // Load weapon animations first (replaces locomotion with weapon-holding versions)
        const animController = controller.getAnimationController();
        if (animController?.loadAnimationPack) {
            try {
                await animController.loadAnimationPack(MELEE_WEAPON_ANIMATIONS, {
                    replaceLocomotion: true,    // Replace walk/run/idle with weapon-holding versions
                    addToAttackCollection: true  // Enable attack animations
                });
            } catch (error) {
                console.warn('⚔️ MeleeNpcBehavior: Failed to load weapon animations:', error);
            }
        }
        
        // Create and equip weapon after animations are loaded
        this.equipWeapon(controller);
    }

    /**
     * Create and equip the weapon
     */
    private equipWeapon(controller: NpcController): void {
        // Use custom mesh creator if provided, otherwise create default sword
        if (this.config.createWeaponMesh) {
            this.weaponMesh = this.config.createWeaponMesh();
        } else {
            this.weaponMesh = this.createDefaultWeapon();
        }
        
        // Mark for identification
        this.weaponMesh.userData.isMeleeWeapon = true;
        this.weaponMesh.userData.weaponType = this.weaponType;
        
        // Scale weapon
        this.weaponMesh.scale.setScalar(this.weaponScale);
        
        // Attach to right hand
        const attached = controller.attachToBodyPart(this.weaponMesh, 'rightHand');
        if (!attached) {
            console.warn(`⚔️ MeleeNpcBehavior: Failed to attach ${this.weaponType}`);
        }
    }

    /**
     * Create a default sword weapon mesh
     */
    private createDefaultWeapon(): THREE.Group {
        const group = new THREE.Group();
        const len = this.bladeLength;
        // Seat the grip near the mesh origin (small offset along the blade axis), matching the
        // player's createSword. The "ride up the arm" problem is fixed per-frame by
        // seatGripTowardFingers (see update/updateSwing), NOT by this — increasing this just
        // slides the sword along the blade, which reads as "up".
        const g = 0.06;

        // Blade — thin on X (flat-to-flat), wide on Z (edge-to-edge): the SAME axis convention
        // as the player's sword, so the shared orientation helper presents the flat sideways
        // and the edge forward/down (not the edge sideways).
        const blade = new THREE.Mesh(
            new THREE.BoxGeometry(0.04, len, 0.08),
            createWeaponPartMaterial('metal', { color: 0xaaaaaa })
        );
        blade.position.y = len / 2 + g;
        blade.castShadow = true;
        group.add(blade);

        // Guard — long on Z (across the flats), matching the blade convention.
        const guard = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, 0.03, 0.2),
            createWeaponPartMaterial('wood', { color: 0x654321 })
        );
        guard.position.y = g;
        guard.castShadow = true;
        group.add(guard);

        // Handle — the grip straddles the hand-bone origin so the fist holds the handle.
        const handle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, 0.15, 8),
            createWeaponPartMaterial('leather', { color: 0x3a2510 })
        );
        handle.position.y = -0.075 + g;
        handle.castShadow = true;
        group.add(handle);

        // Pommel
        const pommel = new THREE.Mesh(
            new THREE.SphereGeometry(0.035, 8, 8),
            createWeaponPartMaterial('metal', { color: 0x654321 })
        );
        pommel.position.y = -0.15 + g;
        pommel.castShadow = true;
        group.add(pommel);

        return group;
    }

    /**
     * Update behavior - chase and attack player
     */
    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;
        
        // Update attack cooldown
        if (this.attackCooldownTimer > 0) {
            this.attackCooldownTimer -= deltaTime;
        }
        
        // Also run on an AI tick for contexts that drive this example directly.
        // NpcController repeats the correction after posing, since its live hand
        // can change between AI ticks (and after this update's hit sampling).
        this.onPoseUpdated();
        
        // Get player position
        const playerPos = this.getPlayerPosition();
        if (!playerPos) return this.leashTarget(currentPosition);

        // Calculate distance to player
        const distanceToPlayer = currentPosition.distanceTo(playerPos);

        // Aggro gate. Out of range the NPC leashes home (or, once home / with
        // returnToOrigin off, gets no goal at all — which clears its target and
        // cancels its queued path request, so an enemy on the far side of the
        // level costs nothing instead of a full layered A*). Everything below
        // (facing, attacking, chasing) is for NPCs that have noticed the player,
        // and this gate runs every update, so a player who walks back into range
        // mid-return is chased again on that same frame.
        const chaseLimit = this.isAggroed
            ? this.aggroRange * MeleeNpcBehavior.AGGRO_RELEASE_FACTOR
            : this.aggroRange;
        if (distanceToPlayer > chaseLimit) {
            if (this.isAggroed) this.restoreMoveSpeed();
            this.isAggroed = false;
            return this.leashTarget(currentPosition);
        }
        if (!this.isAggroed && this.baseMoveSpeed === null && this.controller) {
            this.baseMoveSpeed = this.controller.getMoveSpeed();
            this.controller.setMoveSpeed(this.chaseSpeed);
        }
        this.isAggroed = true;

        // Face the player
        this.faceTarget(playerPos);
        
        // Attack if in range
        if (distanceToPlayer <= this.attackRange) {
            // Stop and attack
            if (!this.isSwinging && this.attackCooldownTimer <= 0) {
                this.startSwing();
            }
            
            // Check for hits during swing
            if (this.isSwinging) {
                this.checkWeaponHit();
            }
            
            return null; // Stop moving while attacking
        }
        
        // Reset swing state when out of range
        if (!this.isSwinging) {
            this.hitPlayerThisSwing = false;
            this.isFirstFrame = true;
        }
        
        // Chase player
        return playerPos.clone();
    }

    /**
     * Where a de-aggroed NPC should walk: back to its origin, or nowhere.
     *
     * Mirrors NpcHostileBehavior's returnToOrigin leash. Without it an aggro
     * range makes every fight kiteable — the NPC parks wherever the player left
     * its range, so the player retreats past the release distance, heals, and
     * returns to a fight that never reset. Returns null once inside
     * ORIGIN_ARRIVAL_RADIUS (arrived → idle) so the NPC isn't given a goal it
     * is already standing on.
     */
    private leashTarget(currentPosition: THREE.Vector3): THREE.Vector3 | null {
        if (!this.returnToOrigin || !this.originPosition) return null;
        if (currentPosition.distanceTo(this.originPosition) <= MeleeNpcBehavior.ORIGIN_ARRIVAL_RADIUS) {
            return null;
        }
        // Clone: the caller (NavigationComponent) keeps the returned vector as
        // its live target, and the anchor must not be mutated from under us.
        return this.originPosition.clone();
    }

    /**
     * Get the player's position
     */
    private getPlayerPosition(): THREE.Vector3 | null {
        if (!this.controller) return null;
        
        const engine = this.controller.getEngine();
        const playerController = engine.getPlayerController?.();
        if (playerController?.getPosition) {
            return playerController.getPosition();
        }
        
        return null;
    }

    /**
     * Face toward a target position
     */
    /** Put the controller's own speed back. No-op if nothing was captured. */
    private restoreMoveSpeed(): void {
        if (this.baseMoveSpeed === null) return;
        this.controller?.setMoveSpeed(this.baseMoveSpeed);
        this.baseMoveSpeed = null;
    }

    private faceTarget(targetPos: THREE.Vector3): void {
        if (!this.controller) return;
        
        const npcPos = this.controller.getPosition();
        const direction = new THREE.Vector3(
            targetPos.x - npcPos.x,
            0,
            targetPos.z - npcPos.z
        ).normalize();
        
        if (direction.lengthSq() > 0.001) {
            const targetRotation = Math.atan2(direction.x, direction.z);
            const character = this.controller.getCharacter();
            if (character) {
                character.rotation.y = targetRotation;
            }
        }
    }

    /**
     * Start the overhead sword swing (same as player's WeaponMeleeSystem)
     */
    private startSwing(): void {
        if (!this.weaponMesh || this.isSwinging) return;
        
        // Initialize swing state
        this.isSwinging = true;
        this.swingStartTime = performance.now();
        this.hitPlayerThisSwing = false;
        this.isFirstFrame = true;
        
        // Start cooldown
        this.attackCooldownTimer = this.attackCooldown;
        
        // Play attack animation if available
        const animController = (this.controller as unknown as NpcController)?.getAnimationController();
        if (animController?.startAttack) {
            animController.startAttack();
        }
        
    }

    /** Both block hands and skinned hands inherit the Mixamo bone frame.
     * Apply facing after the current pose, rather than leaving a blade pointed
     * left/down by that hand frame or compensating for last frame's wrist. */
    onPoseUpdated(): void {
        if (!this.controller || !this.weaponMesh) return;
        const skinned = (this.controller as unknown as NpcController).isRenderingSkinnedMesh?.() === true;
        if (this.isSwinging) {
            this.updateSwing(skinned);
        } else {
            orientBladeYawFramed(this.weaponMesh, this.controller.getCharacter(), BLADE_IDLE_FORWARD);
            if (skinned) seatGripTowardFingers(this.weaponMesh, MeleeNpcBehavior.GRIP_TOWARD_FINGERS);
        }
    }

    /**
     * Update the overhead swing animation (same as player's WeaponMeleeSystem)
     */
    private updateSwing(skinned: boolean): void {
        if (!this.weaponMesh) return;

        const elapsed = (performance.now() - this.swingStartTime) / 1000;
        const progress = Math.min(elapsed / this.swingDuration, 1.0);

        if (skinned) {
            // Skinned NPCs: the attack animation drives the arm; align the blade to it
            // (forearm→hand + downward chop), same as the player's skinned swing. Fall back
            // to the world-targeted idle pose if the forearm bone isn't found.
            const character = this.controller!.getCharacter();
            if (!alignBladeToArm(this.weaponMesh, character)) {
                orientBladeYawFramed(this.weaponMesh, character, BLADE_IDLE_FORWARD);
            }
            seatGripTowardFingers(this.weaponMesh, MeleeNpcBehavior.GRIP_TOWARD_FINGERS);
        } else {
            // Raise, chop forward/down, then recover in the CHARACTER's frame.
            // Adding Euler X in the hand frame sends this arc sideways whenever
            // a block hand inherits a rolled Mixamo wrist.
            let angle: number;
            if (progress < 0.2) {
                angle = THREE.MathUtils.lerp(75, -30, this.easeOutQuad(progress / 0.2));
            } else if (progress < 0.7) {
                angle = THREE.MathUtils.lerp(-30, 140, this.easeOutQuad((progress - 0.2) / 0.5));
            } else {
                angle = THREE.MathUtils.lerp(140, 75, this.easeOutQuad((progress - 0.7) / 0.3));
            }
            this.swingOrientation.setFromAxisAngle(MeleeNpcBehavior.SWING_AXIS, THREE.MathUtils.degToRad(angle));
            orientBladeYawFramed(this.weaponMesh, this.controller!.getCharacter(), this.swingOrientation);
        }

        // Finish swing
        if (progress >= 1.0) {
            this.finishSwing();
        }
    }

    /**
     * Easing function for smooth animation
     */
    private easeOutQuad(t: number): number {
        return 1 - (1 - t) * (1 - t);
    }

    /**
     * Finish the swing and restore weapon rotation
     */
    private finishSwing(): void {
        if (!this.weaponMesh) return;
        
        // The hand may have moved since swing start; resolve the ready pose now.
        orientBladeYawFramed(this.weaponMesh, this.controller!.getCharacter(), BLADE_IDLE_FORWARD);
        
        // Reset state
        this.isSwinging = false;
    }

    /**
     * Check for weapon hit using blade sweep detection
     */
    private checkWeaponHit(): void {
        if (!this.weaponMesh || !this.controller || this.hitPlayerThisSwing) return;
        
        const engine = this.controller.getEngine();
        if (!engine.scene) return;
        
        // Only check during strike phase (10-70%)
        const elapsed = (performance.now() - this.swingStartTime) / 1000;
        const progress = Math.min(elapsed / this.swingDuration, 1.0);
        if (progress < 0.1 || progress > 0.7) return;
        
        // Get current world positions of weapon points
        const worldPos = new THREE.Vector3();
        this.weaponMesh.getWorldPosition(worldPos);
        
        // Transform tip offset by weapon rotation
        const tipOffset = new THREE.Vector3(0, this.bladeLength, 0);
        tipOffset.applyQuaternion(this.weaponMesh.quaternion);
        
        const currentHilt = worldPos.clone();
        const currentTip = worldPos.clone().add(tipOffset);
        
        // First frame - just record position
        if (this.isFirstFrame) {
            this.prevTipPos.copy(currentTip);
            this.prevHiltPos.copy(currentHilt);
            this.isFirstFrame = false;
            return;
        }
        
        // Blade sweep vs the player's BODY CAPSULE. Raycasting the player mesh (name-matched
        // BlockCharacter) missed skinned players and layer-1 block meshes, so enemy swings
        // rarely registered. The capsule is authoritative: feet + size come from the player's
        // physics capsule, padded by the blade girth and a forgiveness margin so swings that
        // visually connect land. Mirrors the player→NPC body test (gatherMeleeBodyHits).
        // Capsule size falls back to default humanoid dimensions, and the centre falls back
        // from feet→visual position, so a PlayerControllerLike that omits the optional capsule
        // accessors still takes damage (rather than silently becoming unhittable).
        const playerController = engine.getPlayerController?.();
        if (playerController) {
            const height = playerController.getCapsuleHeight?.() ?? 1.8;
            const radius = (playerController.getCapsuleRadius?.() ?? 0.4) + this.bladeRadius + MeleeNpcBehavior.PLAYER_HIT_MARGIN;
            // Capsule centre: feet + height/2 (preferred), else the visual player position.
            const feet = playerController.getGroundPosition?.();
            const visual = feet ? null : playerController.getPosition?.();
            const center = feet
                ? MeleeNpcBehavior._tmpPlayerPos.set(feet.x, feet.y + height / 2, feet.z)
                : (visual ? MeleeNpcBehavior._tmpPlayerPos.copy(visual) : null);
            if (center) {
                const halfSpine = Math.max(0, height / 2 - radius);
                if (segmentHitsCapsule(this.prevTipPos, currentTip, center, halfSpine, radius)
                    || segmentHitsCapsule(currentHilt, currentTip, center, halfSpine, radius)
                    || segmentHitsCapsule(this.prevHiltPos, currentHilt, center, halfSpine, radius)) {
                    this.damagePlayer();
                    this.hitPlayerThisSwing = true;
                }
            }
        }

        // Update previous position for next frame
        this.prevTipPos.copy(currentTip);
        this.prevHiltPos.copy(currentHilt);
    }

    /**
     * Apply damage to the player
     * Uses PlayerController.takeDamage() which is built into the engine.
     * The HUD will auto-update if showHealth() was called.
     */
    private damagePlayer(): void {
        if (!this.controller) return;
        
        const engine = this.controller.getEngine();
        const playerController = engine.getPlayerController?.();

        if (playerController?.takeDamage) {
            // Use built-in PlayerController.takeDamage()
            // This auto-updates the HUD health bar if showHealth() was called
            playerController.takeDamage(this.attackDamage, `npc_${this.weaponType}`);
        } else {
            console.warn(`MeleeNpcBehavior: PlayerController.takeDamage not found`);
        }
    }

    /**
     * NPC is hostile
     */
    isHostile(): boolean {
        return true;
    }

    /**
     * Get behavior name
     */
    getName(): string {
        return 'MeleeEnemy';
    }

    /**
     * Cleanup
     */
    dispose(): void {
        if (this.weaponMesh && this.controller) {
            (this.controller as unknown as NpcController).detachFromBodyPart(this.weaponMesh);
            this.weaponMesh.traverse((obj) => {
                const mesh = obj as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    if (mesh.material) {
                        if (Array.isArray(mesh.material)) {
                            mesh.material.forEach(m => m.dispose());
                        } else {
                            mesh.material.dispose();
                        }
                    }
                }
            });
        }
        this.weaponMesh = null;
        this.controller = null;
        this.npcController = null;
    }
}

/**
 * Convenience: Create sword-wielding NPC behavior
 */
export function createSwordNpcBehavior(damage: number = 25): MeleeNpcBehavior {
    return new MeleeNpcBehavior({ weaponType: 'sword', damage });
}

/**
 * Convenience: Create axe-wielding NPC behavior
 */
export function createAxeNpcBehavior(damage: number = 35): MeleeNpcBehavior {
    return new MeleeNpcBehavior({ weaponType: 'axe', damage, bladeLength: 0.8 });
}

/**
 * Convenience: Create spear-wielding NPC behavior
 */
export function createSpearNpcBehavior(damage: number = 20): MeleeNpcBehavior {
    return new MeleeNpcBehavior({ weaponType: 'spear', damage, bladeLength: 1.5, attackRange: 3.5 });
}
