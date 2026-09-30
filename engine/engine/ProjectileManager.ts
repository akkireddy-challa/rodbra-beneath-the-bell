/**
 * @fileoverview ProjectileManager - Centralized projectile management system
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🎯 CENTRAL PROJECTILE MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This singleton manages ALL projectiles in the game, regardless of who fired them.
 * Projectiles are completely decoupled from their source (player, NPC, turret, etc.)
 * 
 * **Why centralized management?**
 * - Projectiles continue functioning even if their source is destroyed
 * - Cleaner separation of concerns - NPCs/players create projectiles, manager handles lifecycle
 * - Easier collision detection and batch updates
 * - No need for "orphaned projectile" handling
 * 
 * **Performance optimization:**
 * - Uses Rapier's event-based collision detection
 * - Efficient update loop with batch processing
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

import { Projectile } from 'engine/Projectile.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Centralized manager for all projectiles in the game.
 * Uses singleton pattern with lazy initialization - created on first use.
 */
export class ProjectileManager {
    private static instance: ProjectileManager | null = null;
    
    private projectiles: Projectile[] = [];
    private physicsWorld: PhysicsWorld | null = null;
    
    /**
     * Private constructor - use getInstance() instead
     */
    private constructor() {
        console.log('🎯 [ProjectileManager] Created');
    }
    
    /**
     * Get the singleton instance, creating it if necessary.
     * This allows lazy initialization - the manager is only created when needed.
     */
    public static getInstance(): ProjectileManager {
        if (!ProjectileManager.instance) {
            ProjectileManager.instance = new ProjectileManager();
        }
        return ProjectileManager.instance;
    }
    
    /**
     * Check if the manager has been initialized
     */
    public static hasInstance(): boolean {
        return ProjectileManager.instance !== null;
    }
    
    /**
     * Set the physics world for collision detection.
     * Must be called before projectiles can detect collisions.
     */
    setPhysicsWorld(physicsWorld: PhysicsWorld): void {
        this.physicsWorld = physicsWorld;
    }
    
    /**
     * Register a new projectile for management.
     * Call this immediately after creating a projectile.
     * 
     * @param projectile - The projectile to manage
     */
    register(projectile: Projectile): void {
        this.projectiles.push(projectile);
    }
    
    /**
     * Update all active projectiles.
     * Call this once per frame from your game loop.
     * 
     * Uses raycast-based collision detection for each projectile.
     * 
     * @param deltaTime - Time elapsed since last frame in seconds
     */
    update(deltaTime: number): void {
        // Update all projectiles with full collision detection (movement, raycast collision, trails, etc.)
        for (const projectile of this.projectiles) {
            projectile.update(deltaTime);
        }
        
        // Remove expired projectiles — reverse iteration with splice to avoid array allocation
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i]!;
            if (proj.isExpired()) {
                proj.dispose();
                this.projectiles.splice(i, 1);
            }
        }
    }
    
    /**
     * Get all active projectiles.
     * Useful for collision detection or other game logic.
     */
    getAll(): Projectile[] {
        return this.projectiles;
    }
    
    /**
     * Get count of active projectiles
     */
    getCount(): number {
        return this.projectiles.length;
    }
    
    /**
     * Get all enemy projectiles (that can damage the player)
     */
    getEnemyProjectiles(): Projectile[] {
        return this.projectiles.filter(p => p.getIsEnemyProjectile());
    }
    
    /**
     * Get all player projectiles (that can damage enemies)
     */
    getPlayerProjectiles(): Projectile[] {
        return this.projectiles.filter(p => !p.getIsEnemyProjectile());
    }
    
    /**
     * Remove a specific projectile from management.
     * Usually not needed as expired projectiles are auto-removed.
     * 
     * @param projectile - The projectile to remove
     * @param dispose - Whether to also dispose the projectile (default: true)
     */
    remove(projectile: Projectile, dispose: boolean = true): void {
        const index = this.projectiles.indexOf(projectile);
        if (index !== -1) {
            this.projectiles.splice(index, 1);
            if (dispose) {
                projectile.dispose();
            }
        }
    }
    
    /**
     * Clear all projectiles.
     * Call this when resetting the game or changing levels.
     */
    clear(): void {
        for (const projectile of this.projectiles) {
            projectile.dispose();
        }
        this.projectiles = [];
        console.log('🎯 [ProjectileManager] Cleared all projectiles');
    }
    
    /**
     * Dispose the singleton instance.
     * Call this when the game is completely shutting down.
     */
    public static dispose(): void {
        if (ProjectileManager.instance) {
            ProjectileManager.instance.clear();
            ProjectileManager.instance = null;
            console.log('🎯 [ProjectileManager] Disposed');
        }
    }
}
