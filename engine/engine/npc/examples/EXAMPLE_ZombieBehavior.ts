/**
 * @fileoverview EXAMPLE_ZombieBehavior - Template for hostile NPCs that explode on death
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🧟 AI AGENT: EXAMPLE ZOMBIE/ENEMY BEHAVIOR
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This file demonstrates the CORRECT way to create hostile NPCs that:
 * - Wander around the world
 * - Die on first hit (one-shot kill)
 * - Explode into particles on death
 * 
 * **✅ ONE ZombieManager can manage ALL your zombies!**
 * 
 * **🎬 ANIMATIONS LOAD DYNAMICALLY (Same as Player!)**
 * NPCs automatically load core animations (walk, run, jump, idle) via buildAnimationList().
 * You can load additional animations (combat, weapons) using loadAnimationPack().
 * 
 * @see npc/index.ts - For complete examples
 * @see AnimationPacks.ts - For available animation packs
 * @see WeaponMeleeSystem.ts - For melee hit detection (uses RAYCASTING!)
 * @see NpcController.ts - For onMeleeHit, takeDamage, onDeathEffect
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## ⚠️ MELEE DETECTION USES RAYCASTING, NOT PHYSICS COLLISIONS!
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * **❌ WRONG:** Checking physics collision manifolds for melee hits
 * ```typescript
 * // This will NEVER detect sword hits!
 * const numManifolds = physicsWorld.getDispatcher().getNumManifolds();
 * for (let i = 0; i < numManifolds; i++) {
 *     const manifold = physicsWorld.getDispatcher().getManifoldByIndexInternal(i);
 *     // Melee weapons don't create physics collisions!
 * }
 * ```
 * 
 * **✅ CORRECT:** Override controller callbacks to receive hit events
 * ```typescript
 * controller.onMeleeHit = (direction, impulse) => {
 *     controller.takeDamage(9999, 'melee');  // One-shot kill
 * };
 * 
 * controller.onDeathEffect = (direction) => {
 *     createExplosion(controller);
 * };
 * ```
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 📋 COMPLETE EXAMPLE: 100 EXPLODING ZOMBIES
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ```typescript
 * // In Game.ts:
 * import { ExampleZombieBehavior } from 'engine/npc/examples/EXAMPLE_ZombieBehavior.js';
 * import { createZombieNpcFactory } from 'engine/npc/examples/EXAMPLE_ZombieFactory.js';
 *
 * async load() {
 *     // Register zombie NPC type with the engine
 *     // Animations load automatically (walk, run, jump, idle) - same as player!
 *     const handle = this.engine.registerNpc('zombie', new ExampleZombieBehavior(), {
 *         characterFactory: createZombieNpcFactory(),
 *         hostile: true
 *     });
 *
 *     // Spawn 100 zombies - each spawn() ADDS a new one!
 *     // Each zombie has animations loaded dynamically!
 *     for (let i = 0; i < 100; i++) {
 *         const angle = Math.random() * Math.PI * 2;
 *         const distance = 15 + Math.random() * 60;
 *         const x = Math.cos(angle) * distance;
 *         const z = Math.sin(angle) * distance;
 *         await handle.spawn(x, z);
 *     }
 * }
 * ```
 */

import * as THREE from 'three';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';

/**
 * Example zombie behavior with one-shot kill and explosion effects
 * 
 * Copy this file as a starting point for your own hostile NPCs!
 */
export class ExampleZombieBehavior extends NpcEnemyBehavior {
    private hasExploded: boolean = false;
    private npcController: NpcController | null = null;

    /**
     * Initialize zombie with one-shot kill and explosion death effect
     */
    initialize(controller: ICharacterContext): void {
        super.initialize(controller);
        this.npcController = controller as NpcController;

        if (!controller) return;

        // ════════════════════════════════════════════════════════════════════
        // ONE-SHOT KILL: Override onMeleeHit to deal massive damage
        // ════════════════════════════════════════════════════════════════════
        //
        // This callback is invoked by WeaponMeleeSystem.ts when a blade ray
        // intersects the NPC's mesh. The mesh must have:
        //   mesh.userData.damageableController = controller
        //
        // NpcController.storePhysicsBodyInMeshes() sets this up automatically.
        //
        this.npcController.onMeleeHit = (_direction?: THREE.Vector3, _impulse?: number) => {
            console.log('🗡️ Zombie hit by melee weapon!');
            // Deal 9999 damage = instant death (default max HP is 100)
            this.npcController!.takeDamage(9999, 'melee');
        };

        // ════════════════════════════════════════════════════════════════════
        // DEATH EXPLOSION: Override onDeathEffect for visual explosion
        // ════════════════════════════════════════════════════════════════════
        //
        // This callback is invoked automatically by NpcController.takeDamage()
        // when health reaches 0 or below.
        //
        this.npcController.onDeathEffect = (direction?: THREE.Vector3) => {
            if (!this.hasExploded) {
                this.createExplosion(this.npcController!, direction);
            }
        };
    }

    /**
     * Create explosion effect with particles
     * 
     * Spawns colored particles that fly outward and fade away.
     * The NPC is disposed after the explosion.
     */
    private createExplosion(controller: NpcController, direction?: THREE.Vector3): void {
        if (this.hasExploded) return;
        
        this.hasExploded = true;
        console.log('💥 Zombie exploding!');

        const character = controller.getCharacter();
        if (!character) return;

        const explosionPos = character.position.clone();
        const engine = controller.getEngine();
        const now = performance.now() / 1000;

        // Create 30 particle cubes exploding outward
        for (let i = 0; i < 30; i++) {
            const particle = new THREE.Mesh(
                new THREE.BoxGeometry(0.15, 0.15, 0.15),
                new THREE.MeshStandardMaterial({
                    color: new THREE.Color().setHSL(Math.random() * 0.1 + 0.05, 1, 0.4),
                    metalness: 0.3,
                    roughness: 0.7,
                    emissive: new THREE.Color().setHSL(Math.random() * 0.1, 0.8, 0.3)
                })
            );

            particle.position.copy(explosionPos);
            particle.position.y += 0.5;

            // Random direction outward (use hit direction if available)
            const baseAngle = direction 
                ? Math.atan2(direction.x, direction.z) 
                : (Math.PI * 2 * i) / 30;
            const angle = baseAngle + (Math.random() - 0.5) * Math.PI;
            const spread = Math.random() * 0.5 + 0.5;
            
            const velocity = new THREE.Vector3(
                Math.cos(angle) * spread,
                Math.random() * 2 + 1,
                Math.sin(angle) * spread
            ).normalize();

            const speed = Math.random() * 15 + 10;
            velocity.multiplyScalar(speed);

            engine.scene?.add(particle);

            // Animate particle falling with gravity
            const startTime = now;
            const duration = 1.5;
            const startVelocity = velocity.clone();
            
            const updateParticle = () => {
                const elapsed = (performance.now() / 1000) - startTime;
                if (elapsed > duration) {
                    engine.scene?.remove(particle);
                    particle.geometry.dispose();
                    (particle.material as THREE.Material).dispose();
                    return;
                }

                // Apply gravity
                const t = elapsed / duration;
                particle.position.x = explosionPos.x + startVelocity.x * t;
                particle.position.y = explosionPos.y + startVelocity.y * t - 0.5 * 9.8 * t * t;
                particle.position.z = explosionPos.z + startVelocity.z * t;

                // Fade out
                (particle.material as THREE.MeshStandardMaterial).opacity = 1 - t;
                (particle.material as THREE.MeshStandardMaterial).transparent = true;

                // Spin
                particle.rotation.x += Math.random() * 0.2;
                particle.rotation.y += Math.random() * 0.2;
                particle.rotation.z += Math.random() * 0.2;

                requestAnimationFrame(updateParticle);
            };

            updateParticle();
        }

        // Destroy the zombie NPC
        controller.dispose();
    }
}

