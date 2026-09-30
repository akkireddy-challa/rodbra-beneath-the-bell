/**
 * IDamageable - Common interface for entities that can receive damage from melee/projectile attacks
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🎯 PURPOSE
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This interface provides a consistent way for melee and projectile systems to:
 * 1. Detect hittable entities (via userData.damageableController)
 * 2. Apply damage and effects (via onMeleeHit, onProjectileHit)
 * 3. Check entity state (via isExploded, isDead, getHealth)
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ✅ WHAT'S ALREADY IMPLEMENTED (works out of the box)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * NpcController and AnimalController ALREADY implement IDamageable:
 * - ✅ Melee weapons detect and hit them automatically
 * - ✅ They have health (100 HP default), take damage, and can die
 * - ✅ They explode into physics blocks when killed
 * - ✅ Physical knockback is applied
 * 
 * **You don't need to implement IDamageable yourself** unless creating a new
 * entity type. Just use NpcController or AnimalController.
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🎨 CUSTOMIZING HIT/DEATH EFFECTS (optional)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * The default hit/death behavior is: log to console + explode into blocks.
 * To add blood, gore, particles, sounds, health bars, etc., override these methods:
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🔧 CREATING A NEW DAMAGEABLE ENTITY TYPE (advanced)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Only do this if NpcController/AnimalController don't fit your needs.
 * 
 * Required steps:
 * 1. Implement this interface in your controller class
 * 2. Store these on ALL meshes in your entity:
 *    - `mesh.userData.damageableController = this`
 *    - `mesh.userData.physicsBody = yourPhysicsBody`
 *    - `mesh.userData.mass = 70` (or appropriate mass, must be > 0)
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 📋 IMPLEMENTED BY
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * - NpcController (engine/npc/core/NpcController.ts) - Humanoid NPCs
 * - AnimalController (engine/animal/AnimalController.ts) - 4-legged animals
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 📚 RELATED FILES
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * **Combat systems that call onMeleeHit():**
 * - engine/WeaponMeleeSystem.ts - Weapon combat (swords, axes, spears)
 * - engine/UnarmedMeleeSystem.ts - Unarmed combat (punches, kicks)
 * 
 * **Entity systems that implement IDamageable:**
 * - engine/animal/index.ts - Animal system entry point (createAnimal, etc.)
 * - engine/npc/index.ts - NPC system entry point (NpcManager, etc.)
 * 
 * **Weapon setup:**
 * - engine/WeaponMeleeSystem.ts - Melee weapon combat system
 * - engine/RangedWeaponSystem.ts - Ranged weapon combat system
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️ COMMON MISTAKES (AI AGENTS: AVOID THESE!)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ❌ WRONG: Using physics dispatcher to detect weapon hits
 * 
 * ❌ WRONG: Creating custom hit detection for built-in entities
 * 
 * ✅ CORRECT: Use the built-in callbacks
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';

/**
 * Configuration for health and death behavior
 * 
 * Note: Visual effects (particles, blood, gore) are NOT configured here.
 * Override `onMeleeHitEffect()`, `onProjectileHitEffect()`, `onDamage()`, and `onDeathEffect()` to add custom effects.
 */
export interface DamageableConfig {
    /** Maximum health (default: 100) */
    maxHealth?: number;
    /** Initial health (default: maxHealth) */
    health?: number;
    /** Whether entity can be killed (default: true) */
    canDie?: boolean;
    /** Whether to explode into physics blocks on death (default: true) */
    explodeOnDeath?: boolean;
    /** Collapse into a limp jointed ragdoll on death instead of exploding (default: false; wins over explodeOnDeath). */
    ragdollOnDeath?: boolean;
    /** 
     * Whether entity dies on first hit (default: false)
     * When true, any melee or projectile hit instantly kills the entity.
     * Useful for fragile targets, one-shot kill gameplay, etc.
     */
    oneHitKill?: boolean;
    /**
     * How long debris blocks persist after explosion, in milliseconds.
     * Default: 10000 (10 seconds). Set to 0 for permanent debris (until level unload).
     */
    debrisLifetimeMs?: number;
}

/**
 * Interface for entities that can receive damage
 */
export interface IDamageable {
    /**
     * Called when entity is hit by melee attack (weapon or unarmed)
     * This is the primary entry point for melee damage.
     * 
     * @param impactDirection - Direction of the attack (normalized, from attacker toward entity)
     * @param impulseStrength - Strength of the attack (default ~8-12, higher for weapons)
     */
    onMeleeHit(impactDirection?: THREE.Vector3, impulseStrength?: number): void;
    
    /**
     * Called when entity is hit by projectile
     * Override to handle projectile damage differently from melee.
     */
    onProjectileHit?(): void;
    
    /**
     * Check if entity has been destroyed/exploded
     * Used by combat systems to skip dead entities.
     * 
     * @returns true if entity is destroyed and should not receive more damage
     */
    isExploded(): boolean;
    
    /**
     * Check if entity is dead (health <= 0)
     * Entity may be dead but not yet exploded (e.g., death animation playing)
     * 
     * @returns true if entity is dead
     */
    isDead?(): boolean;
    
    /**
     * Get current health
     * @returns Current health value
     */
    getHealth?(): number;
    
    /**
     * Get maximum health
     * @returns Maximum health value
     */
    getMaxHealth?(): number;
    
    /**
     * Apply damage to entity
     * Useful for damage-over-time effects, fall damage, etc.
     * 
     * @param amount - Amount of damage to apply
     * @param source - Optional: What caused the damage (for death messages, etc.)
     */
    takeDamage?(amount: number, source?: string): void;
    
    /**
     * Optional callback for custom melee hit effects
     * Override this to create blood splatter, sparks, screen shake, etc.
     * 
     * @param position - World position where hit occurred
     * @param direction - Direction of impact (from attacker)
     * @param damage - Amount of damage dealt
     */
    onMeleeHitEffect?(position: THREE.Vector3, direction: THREE.Vector3, damage: number): void;
    
    /**
     * Optional callback for custom projectile hit effects
     * Override this to create impact particles, bullet holes, etc.
     * 
     * @param position - World position where hit occurred
     * @param direction - Direction of impact (from projectile)
     * @param damage - Amount of damage dealt
     */
    onProjectileHitEffect?(position: THREE.Vector3, direction: THREE.Vector3, damage: number): void;
    
    /**
     * Optional callback called whenever damage is taken from any source.
     * Use for health bar updates, damage numbers, sound effects, etc.
     * Called AFTER health is reduced but BEFORE death processing.
     * 
     * @param damage - Amount of damage dealt
     * @param currentHealth - Health remaining after damage
     * @param maxHealth - Maximum health
     * @param source - What caused the damage (e.g., 'melee', 'projectile', 'fall')
     */
    onDamage?(damage: number, currentHealth: number, maxHealth: number, source?: string): void;
    
    /**
     * Optional callback for death effects
     * Override this to create death particles, sounds, drops, etc.
     * Called just before entity is marked as exploded/dead.
     * 
     * @param killerDirection - Direction from killer (for death physics/effects)
     */
    onDeathEffect?(killerDirection?: THREE.Vector3): void;
}

/**
 * Default damage configuration
 */
export const DEFAULT_DAMAGEABLE_CONFIG: Required<DamageableConfig> = {
    maxHealth: 100,
    health: 100,
    canDie: true,
    explodeOnDeath: true,
    ragdollOnDeath: false,
    oneHitKill: false,
    debrisLifetimeMs: 10000
};

