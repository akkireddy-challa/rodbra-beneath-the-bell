import { Projectile2D } from 'engine/Projectile2D.js';

/**
 * Centralized manager for all 2D projectiles (Physics2D genre).
 *
 * This is the Physics2D equivalent of `ProjectileManager` (3D-only).
 * Uses singleton pattern — only one instance per game session.
 */
export class ProjectileManager2D {
    private static instance: ProjectileManager2D | null = null;

    private projectiles: Projectile2D[] = [];

    private constructor() {}

    static getInstance(): ProjectileManager2D {
        if (!ProjectileManager2D.instance) {
            ProjectileManager2D.instance = new ProjectileManager2D();
        }
        return ProjectileManager2D.instance;
    }

    static hasInstance(): boolean {
        return ProjectileManager2D.instance !== null;
    }

    register(projectile: Projectile2D): void {
        this.projectiles.push(projectile);
    }

    update(deltaTime: number): void {
        for (const p of this.projectiles) {
            p.update(deltaTime);
        }

        this.projectiles = this.projectiles.filter(p => {
            if (p.isExpired()) {
                p.dispose();
                return false;
            }
            return true;
        });
    }

    getAll(): Projectile2D[] {
        return this.projectiles;
    }

    getCount(): number {
        return this.projectiles.length;
    }

    getEnemyProjectiles(): Projectile2D[] {
        return this.projectiles.filter(p => p.getIsEnemyProjectile());
    }

    getPlayerProjectiles(): Projectile2D[] {
        return this.projectiles.filter(p => !p.getIsEnemyProjectile());
    }

    remove(projectile: Projectile2D, dispose = true): void {
        const idx = this.projectiles.indexOf(projectile);
        if (idx !== -1) {
            this.projectiles.splice(idx, 1);
            if (dispose) projectile.dispose();
        }
    }

    clear(): void {
        for (const p of this.projectiles) p.dispose();
        this.projectiles = [];
    }

    static dispose(): void {
        if (ProjectileManager2D.instance) {
            ProjectileManager2D.instance.clear();
            ProjectileManager2D.instance = null;
        }
    }
}
