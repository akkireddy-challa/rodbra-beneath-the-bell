import * as THREE from 'three';
import type { DamageableConfig } from 'engine/IDamageable.js';
import { DEFAULT_DAMAGEABLE_CONFIG } from 'engine/IDamageable.js';
import { DamageFlash } from 'engine/effects/DamageFlash.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';

/**
 * Callbacks for controller-specific health/death operations.
 */
export interface HealthCallbacks {
    /** Called just before death processing (e.g., dismount rider, notify behavior) */
    onPreDeath(): void;
    /** Called to trigger explosion when explodeOnDeath is configured */
    onExplode(): void;
    /**
     * Collapse into a ragdoll (when ragdollOnDeath is set; takes precedence over explode).
     * `deathImpulse` is the killing blow's knockback (world-space m/s on the torso); omit for a
     * gravity-only collapse (vehicle/prop kills push via the solver instead).
     */
    onRagdoll(deathImpulse?: THREE.Vector3): boolean | void;
}

/**
 * HealthComponent - Manages health, damage, death, and damage flash.
 * Shared between NpcController and AnimalController.
 */
export class HealthComponent {
    private _health: number;
    private _maxHealth: number;
    private _isDead: boolean = false;
    private _hasExploded: boolean = false;
    private _hasRagdolled: boolean = false;
    private damageableConfig: Required<DamageableConfig>;
    private damageFlash: DamageFlash | null = null;
    private callbacks: HealthCallbacks;

    // Public callbacks for external customization
    public onDamage?: (damage: number, currentHealth: number, maxHealth: number, source?: string) => void;
    public onDeathEffect?: (killerDirection?: THREE.Vector3) => void;

    constructor(callbacks: HealthCallbacks, damageableConfig?: Partial<DamageableConfig>) {
        this.callbacks = callbacks;
        this.damageableConfig = { ...DEFAULT_DAMAGEABLE_CONFIG, ...damageableConfig };
        // A config that names `maxHealth` but not `health` means "spawn at full health":
        // the default starting health (100) must never survive as a stale value, or a
        // `{ maxHealth: 45 }` NPC spawns overfilled and a `{ maxHealth: 260 }` one
        // spawns at 100/260.
        if (damageableConfig?.maxHealth !== undefined && damageableConfig.health === undefined) {
            this.damageableConfig.health = this.damageableConfig.maxHealth;
        }
        this._maxHealth = this.damageableConfig.maxHealth;
        this._health = this.damageableConfig.health;
    }

    /** Initialize damage flash on a visible mesh root */
    initDamageFlash(root: THREE.Object3D): void {
        this.damageFlash = new DamageFlash(root);
    }

    /** @param deathImpulse - killing blow's knockback (m/s), forwarded to onRagdoll on a lethal hit. */
    takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void {
        if (this._isDead || this._hasExploded) return;

        this._health -= amount;
        if (this._health < 0) this._health = 0;

        // Trailer timeline: lethal hits approach intensity 1 (deaths log
        // separately with position via NpcRegistry/AnimalController).
        getGameEventLog().logEvent({
            type: 'damage',
            intensity: Math.min(1, amount / Math.max(1, this._maxHealth)),
            data: source !== undefined ? { source } : undefined,
        });

        this.damageFlash?.trigger();

        if (this.onDamage) {
            this.onDamage(amount, this._health, this._maxHealth, source);
        }

        if (this._health <= 0 && this.damageableConfig.canDie) {
            this._isDead = true;

            // Controller-specific pre-death logic (dismount rider, notify behavior, etc.)
            this.callbacks.onPreDeath();

            if (this.onDeathEffect) {
                this.onDeathEffect();
            }

            // Ragdoll is the explicit alternative to explosion — it takes precedence.
            if (this.damageableConfig.ragdollOnDeath) {
                // Only count it if a ragdoll was actually built. `_hasRagdolled`
                // makes the owner stop driving the character ("the original body
                // is gone"), so setting it after a FAILED collapse left the NPC
                // standing frozen at the moment of death. `void` from an older
                // implementer is treated as success, preserving prior behaviour.
                const collapsed = this.callbacks.onRagdoll(deathImpulse);
                this._hasRagdolled = collapsed !== false;
                if (!this._hasRagdolled && this.damageableConfig.explodeOnDeath) {
                    this.callbacks.onExplode();
                    this._hasExploded = true;
                }
            } else if (this.damageableConfig.explodeOnDeath) {
                this.callbacks.onExplode();
                this._hasExploded = true;
            }
        }
    }

    isDead(): boolean {
        return this._isDead;
    }

    isExploded(): boolean {
        return this._hasExploded;
    }

    isRagdolled(): boolean {
        return this._hasRagdolled;
    }

    markExploded(): void {
        this._isDead = true;
        this._hasExploded = true;
    }

    getHealth(): number {
        return this._health;
    }

    getMaxHealth(): number {
        return this._maxHealth;
    }

    /** Set max health (also resets current health to max and revives) */
    setMaxHealth(maxHealth: number): void {
        this._maxHealth = Math.max(1, maxHealth);
        this._health = this._maxHealth;
        this._isDead = false;
        this._hasRagdolled = false;
    }

    /** Heal by amount (no effect if dead) */
    heal(amount: number): boolean {
        if (this._isDead) return false;
        const previous = this._health;
        this._health = Math.min(this._maxHealth, this._health + amount);
        return this._health !== previous;
    }

    /** Reset health to max and revive if dead (clears ragdoll state for respawn) */
    resetHealth(): void {
        this._health = this._maxHealth;
        this._isDead = false;
        this._hasRagdolled = false;
    }

    getDamageableConfig(): Required<DamageableConfig> {
        return this.damageableConfig;
    }

    getDamageFlash(): DamageFlash | null {
        return this.damageFlash;
    }

    setDamageFlashEnabled(enabled: boolean): void {
        this.damageFlash?.setEnabled(enabled);
    }

    /** Restore flash materials immediately (called before explosion) */
    restoreFlashImmediately(): void {
        this.damageFlash?.restoreImmediately();
    }

    disposeDamageFlash(): void {
        if (this.damageFlash) {
            this.damageFlash.dispose();
            this.damageFlash = null;
        }
    }
}
