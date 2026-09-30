/**
 * HitEffects - Pre-built visual effect factories for combat
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🎯 PURPOSE
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Provides ready-to-use effect factories that can be assigned to damageable entities:
 * - Blood splatter on hit
 * - Death explosions with gore
 * - Knockback/throw effects
 * - Ground splat markers
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 📚 RELATED FILES
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * - engine/IDamageable.ts - Defines onMeleeHitEffect, onProjectileHitEffect, onDamage, and onDeathEffect
 * - engine/animal/AnimalController.ts - Animals that can use these effects
 * - engine/npc/core/NpcController.ts - NPCs that can use these effects
 * - engine/ExampleAnimalManager.ts - Full usage example
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';
import type RAPIER from '@dimforge/rapier3d-compat';

// Callback types matching IDamageable
export type HitEffectCallback = (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;
export type DeathEffectCallback = (killerDirection?: THREE.Vector3) => void;

/**
 * Configuration for blood splatter effects
 */
export interface BloodSplatterConfig {
    /** Blood color (default: 0x8b0000 - dark red) */
    color?: number;
    /** Maximum number of particles (default: 15, scales with damage) */
    particleCount?: number;
    /** Base particle size (default: 0.08) */
    particleSize?: number;
    /** Effect duration in ms (default: 1500) */
    duration?: number;
    /** Color variation - lighter particles mixed in (default: true) */
    colorVariation?: boolean;
}

/**
 * Configuration for death explosion effects
 */
export interface DeathExplosionConfig {
    /** Primary explosion color (default: 0x8b0000 - dark red) */
    color?: number;
    /** Secondary color for variation (default: 0xffcccc - light pink) */
    secondaryColor?: number;
    /** Number of explosion particles (default: 25) */
    particleCount?: number;
    /** Create ground splat marker (default: true) */
    createGroundSplat?: boolean;
    /** Ground splat duration in ms (default: 3000) */
    splatDuration?: number;
    /** Ground splat size (default: 2.0) */
    splatSize?: number;
    /** Effect duration in ms (default: 1500) */
    duration?: number;
}

/**
 * Configuration for throw/knockback effects
 */
export interface ThrowConfig {
    /** Force multiplier (default: 2.0) */
    forceMultiplier?: number;
    /** Maximum throw force (default: 150) */
    maxForce?: number;
    /** Upward bias for dramatic effect (default: 0.5) */
    upwardBias?: number;
}

const DEFAULT_BLOOD_CONFIG: Required<BloodSplatterConfig> = {
    color: 0x8b0000,
    particleCount: 15,
    particleSize: 0.08,
    duration: 1500,
    colorVariation: true
};

const DEFAULT_DEATH_CONFIG: Required<DeathExplosionConfig> = {
    color: 0x8b0000,
    secondaryColor: 0xffcccc,
    particleCount: 25,
    createGroundSplat: true,
    splatDuration: 3000,
    splatSize: 2.0,
    duration: 1500
};

const DEFAULT_THROW_CONFIG: Required<ThrowConfig> = {
    forceMultiplier: 2.0,
    maxForce: 150,
    upwardBias: 0.5
};

/**
 * Unit shapes shared by every particle and scaled per instance — a geometry
 * per particle was allocation churn and, on WebGPU, a render-object rebuild.
 */
const PARTICLE_GEO = new THREE.SphereGeometry(1, 4, 4);
const SPLAT_GEO = new THREE.CylinderGeometry(1, 1, 0.1, 16);

/** The one material configuration all these particles use. */
function createParticleMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
}

/**
 * Fly a particle on a ballistic arc, fading and shrinking, then remove and
 * dispose it. Every particle these factories spawn takes this path — blood and
 * gore differ only in how fast they shrink.
 *
 * Stepped at a fixed 60 Hz off `requestAnimationFrame`: these effects are
 * fire-and-forget, so they are not driven by the engine's frame clock.
 */
function animateParticle(
    scene: THREE.Scene,
    particle: THREE.Mesh,
    material: THREE.MeshBasicMaterial,
    velocity: THREE.Vector3,
    duration: number,
    shrinkPerFrame: number,
): void {
    const startTime = Date.now();
    const startOpacity = material.opacity;
    const step = 1 / 60;

    const tick = (): void => {
        const progress = (Date.now() - startTime) / duration;

        if (progress >= 1) {
            scene.remove(particle);
            material.dispose();
            return;
        }

        velocity.y -= 9.81 * step;
        particle.position.addScaledVector(velocity, step);
        material.opacity = startOpacity * (1 - progress);
        particle.scale.multiplyScalar(shrinkPerFrame);

        requestAnimationFrame(tick);
    };

    tick();
}

/**
 * Create a blood splatter effect factory
 * 
 * Returns a callback suitable for `entity.onMeleeHitEffect` or `entity.onProjectileHitEffect`
 * 
 * @param scene - Three.js scene to add particles to
 * @param config - Optional configuration
 * @returns HitEffectCallback function
 */
export function createBloodSplatterEffect(
    scene: THREE.Scene,
    config?: BloodSplatterConfig
): HitEffectCallback {
    const cfg = { ...DEFAULT_BLOOD_CONFIG, ...config };
    // Particles build and dispose their materials; keep the program compiled
    // between bursts and pre-warm it now (see ShaderKeepAlive).
    keepShaderAlive(scene, 'hit-effects:particle', createParticleMaterial(cfg.color, 0.9));
    
    return (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => {
        // Scale particle count with damage
        const particleCount = Math.min(Math.floor(damage / 5), cfg.particleCount);
        
        for (let i = 0; i < particleCount; i++) {
            // Vary particle size
            const size = cfg.particleSize + Math.random() * (cfg.particleSize * 0.5);
            
            // Vary color if enabled
            let particleColor = cfg.color;
            if (cfg.colorVariation && Math.random() > 0.7) {
                particleColor = 0xcc0000; // Lighter red variation
            }
            
            const material = createParticleMaterial(particleColor, 0.9);

            const particle = new THREE.Mesh(PARTICLE_GEO, material);
            particle.scale.setScalar(size);
            particle.position.copy(position);
            
            // Calculate spray direction with variation
            const spreadDirection = direction.clone()
                .multiplyScalar(0.7 + Math.random() * 0.5)
                .add(new THREE.Vector3(
                    (Math.random() - 0.5) * 2,
                    Math.random() * 1.5 + 0.5,
                    (Math.random() - 0.5) * 2
                ).normalize().multiplyScalar(1.5));

            // Physics velocity
            const velocity = spreadDirection.multiplyScalar(3 + Math.random() * 5);
            
            scene.add(particle);

            const duration = cfg.duration * (0.5 + Math.random() * 0.5);
            animateParticle(scene, particle, material, velocity, duration, 0.98);
        }
    };
}

/**
 * Create a death explosion effect factory
 * 
 * Returns a callback suitable for `entity.onDeathEffect`
 * 
 * @param scene - Three.js scene to add particles to
 * @param config - Optional configuration
 * @returns DeathEffectCallback function
 */
export function createDeathExplosionEffect(
    scene: THREE.Scene,
    config?: DeathExplosionConfig
): (position: THREE.Vector3, killerDirection?: THREE.Vector3) => void {
    const cfg = { ...DEFAULT_DEATH_CONFIG, ...config };
    keepShaderAlive(scene, 'hit-effects:particle', createParticleMaterial(cfg.color, 0.9));
    
    // Return a function that takes position as first arg (for easier composition)
    return (position: THREE.Vector3, killerDirection?: THREE.Vector3) => {
        // Create explosion particles
        for (let i = 0; i < cfg.particleCount; i++) {
            // Mix primary and secondary colors
            const useSecondary = Math.random() > 0.7;
            const particleColor = useSecondary ? cfg.secondaryColor : cfg.color;
            
            const material = createParticleMaterial(particleColor, 0.9);

            const particle = new THREE.Mesh(PARTICLE_GEO, material);
            particle.scale.setScalar(0.1 + Math.random() * 0.08);
            particle.position.copy(position);
            particle.position.y += 1; // Lift slightly
            
            // Explosion velocity
            const baseDir = killerDirection 
                ? killerDirection.clone().multiplyScalar(0.5) 
                : new THREE.Vector3(0, 1, 0);
            const randomDir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() * 2 + 1,
                (Math.random() - 0.5) * 2
            ).normalize();

            const velocity = baseDir.add(randomDir.multiplyScalar(8 + Math.random() * 4));
            
            scene.add(particle);

            const duration = cfg.duration * (0.8 + Math.random() * 0.4);
            animateParticle(scene, particle, material, velocity, duration, 0.97);
        }

        // Create ground splat marker
        if (cfg.createGroundSplat) {
            const splatMaterial = createParticleMaterial(cfg.color, 0.3);

            const splatMarker = new THREE.Mesh(SPLAT_GEO, splatMaterial);
            splatMarker.scale.set(cfg.splatSize, 1, cfg.splatSize);
            splatMarker.position.copy(position);
            splatMarker.position.y = position.y + 0.05;
            splatMarker.rotation.x = Math.PI * 0.02;
            
            scene.add(splatMarker);

            // Fade out the splat marker. It stays put, so it does not go
            // through animateParticle — no velocity, no shrink.
            const splatStartTime = Date.now();

            const animateSplat = () => {
                const progress = (Date.now() - splatStartTime) / cfg.splatDuration;

                if (progress >= 1) {
                    scene.remove(splatMarker);
                    splatMaterial.dispose();
                    return;
                }

                splatMaterial.opacity = 0.3 * (1 - progress);

                requestAnimationFrame(animateSplat);
            };
            
            animateSplat();
        }
    };
}

/**
 * Create a combined blood + death effect that tracks quest kills
 * 
 * Convenience function that sets up both hit and death effects,
 * with optional quest tracking callback.
 * 
 * @param scene - Three.js scene
 * @param onKill - Optional callback when entity dies (e.g., quest tracking)
 * @param bloodConfig - Optional blood splatter configuration
 * @param deathConfig - Optional death explosion configuration
 * @returns Object with onMeleeHitEffect and onDeathEffect callbacks
 */
export function createCombatEffects(
    scene: THREE.Scene,
    onKill?: () => void,
    bloodConfig?: BloodSplatterConfig,
    deathConfig?: DeathExplosionConfig
): {
    onMeleeHitEffect: HitEffectCallback;
    onDeathEffect: DeathEffectCallback;
} {
    const bloodEffect = createBloodSplatterEffect(scene, bloodConfig);
    // Built for its shader pre-warm alone: the returned onDeathEffect gets no
    // entity position, so it can only report the kill, not draw the burst.
    // Wire `createDeathExplosionEffect` up directly if you need the visual.
    createDeathExplosionEffect(scene, deathConfig);

    return {
        onMeleeHitEffect: bloodEffect,
        onDeathEffect: () => {
            onKill?.();
        }
    };
}

/**
 * Apply throw/knockback physics to a physics body
 * 
 * @param physicsBody - Rapier rigid body
 * @param direction - Direction to throw
 * @param damage - Damage amount (affects force)
 * @param config - Optional throw configuration
 */
export function applyThrowForce(
    physicsBody: RAPIER.RigidBody,
    direction: THREE.Vector3,
    damage: number,
    config?: ThrowConfig
): void {
    if (!physicsBody) return;
    
    const cfg = { ...DEFAULT_THROW_CONFIG, ...config };
    
    // Calculate throw force based on damage
    const throwForce = Math.min(damage * cfg.forceMultiplier, cfg.maxForce);
    
    // Create impulse direction with upward bias
    const impulseDirection = direction.clone().normalize();
    impulseDirection.y += cfg.upwardBias;
    impulseDirection.normalize();

    const impulse = impulseDirection.multiplyScalar(throwForce);

    // Apply linear velocity for immediate effect using Rapier
    try {
        physicsBody.setLinvel({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
        physicsBody.wakeUp();
    } catch (e) {
        console.warn('applyThrowForce: Could not apply physics impulse', e);
    }
}

