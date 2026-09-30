import * as THREE from 'three';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { Projectile, type ProjectileVisualConfig } from 'engine/Projectile.js';
import type { EngineLike } from 'types/game.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { resolveProjectileSpawn } from 'engine/weapons/PointBlank.js';

// Projectile configuration for ShootableComponent
export interface ProjectileConfig {
  speed: number;
  visualConfig?: ProjectileVisualConfig;
  /**
   * Direction to fire in local space. Defaults to (0, 0, 1) (Forward Z).
   * For CylinderGeometry (which aligns to Y), set this to (0, 1, 0).
   */
  localFireDirection?: THREE.Vector3;
  onHitCallback?: (projectile: Projectile, hitBody?: RAPIER.RigidBody) => void;
  /**
   * Custom collision mask for the projectile.
   * Use CollisionMask.ENEMY_PROJECTILE for NPC projectiles that should hit players.
   * Defaults to CollisionMask.PROJECTILE (hits enemies, not players).
   */
  collisionMask?: number;
}

// Re-export from engine/Projectile for convenience
export { Projectile, Explosion, type ProjectileVisualConfig, type ExplosionConfig } from 'engine/Projectile.js';

// The shootable component
export class ShootableComponent {
  muzzleOffset: THREE.Vector3;
  fireRate: number; // shots per second
  projectileConfig: ProjectileConfig;
  private lastShotTime: number = 0;

  constructor(
    muzzleOffset: THREE.Vector3,
    fireRate: number,
    projectileConfig: ProjectileConfig
  ) {
    this.muzzleOffset = muzzleOffset;
    this.fireRate = fireRate;
    this.projectileConfig = projectileConfig;
  }

  canShoot(): boolean {
    const now = performance.now();
    const cooldown = 1000 / this.fireRate;
    return (now - this.lastShotTime) >= cooldown;
  }

  shoot(
    parentTransform: THREE.Object3D,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    aimPoint?: THREE.Vector3
  ): Projectile | null {
    if (!this.canShoot()) return null;

    this.lastShotTime = performance.now();
    return this.spawnProjectile(parentTransform, physicsWorld, engine, aimPoint);
  }

  /**
   * Fire several projectiles as ONE shot — a shotgun's pellets.
   *
   * One rate-limit check and one timestamp for the whole volley, so a spread
   * counts as a single trigger pull rather than tripping the cooldown on its
   * own second pellet. Callers consume one round of ammunition per volley.
   */
  shootVolley(
    parentTransform: THREE.Object3D,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    aimPoints: readonly THREE.Vector3[]
  ): Projectile[] {
    if (aimPoints.length === 0 || !this.canShoot()) return [];

    this.lastShotTime = performance.now();
    const projectiles: Projectile[] = [];
    for (const aimPoint of aimPoints) {
      projectiles.push(this.spawnProjectile(parentTransform, physicsWorld, engine, aimPoint));
    }
    return projectiles;
  }

  /** One projectile from the muzzle toward `aimPoint`. No rate limiting here. */
  private spawnProjectile(
    parentTransform: THREE.Object3D,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    aimPoint?: THREE.Vector3
  ): Projectile {
    // Calculate world position and direction
    const worldMuzzlePos = new THREE.Vector3();
    parentTransform.localToWorld(worldMuzzlePos.copy(this.muzzleOffset));

    // Use configured local direction or default to Z-forward (0, 0, 1)
    const direction = this.projectileConfig.localFireDirection?.clone()
      ?? new THREE.Vector3(0, 0, 1);

    // Get true world rotation (handles nested hierarchies like Tank -> Turret -> Barrel)
    const worldQuat = new THREE.Quaternion();
    parentTransform.getWorldQuaternion(worldQuat);

    direction.applyQuaternion(worldQuat).normalize();

    // Exact convergence when the caller knows WHERE the shot should land:
    // fire muzzle -> aimPoint instead of along the barrel's orientation. The
    // barrel is aimed from the WEAPON's origin, so a bullet leaving the
    // offset muzzle along the barrel axis misses the aim point by the
    // parallax (measured 0.36° / ~6cm at 9m on the pistol). Standard
    // over-the-shoulder behaviour: the crosshair point is the contract.
    if (aimPoint) {
      const converged = aimPoint.clone().sub(worldMuzzlePos);
      // Degenerate when the aim surface is at/behind the muzzle — a wall the
      // player is pressed into. Keep the barrel direction there.
      //
      // Not on a plane-locked (2D) lane: there the aim point IS the shot's
      // line. The barrel can point out of the gameplay plane entirely (a
      // character the game has not turned), and the plane offers only two
      // directions to choose between — so the "is it in front of the barrel?"
      // test would reject a perfectly good shot and leave the bullet with
      // nowhere to travel.
      const inPlaneAim = isPlaneLockedPhysics(physicsWorld);
      if (converged.lengthSq() > 0.01 && (inPlaneAim || converged.dot(direction) > 0)) {
        direction.copy(converged.normalize());
      }
    }

    // Point-blank: a target standing between the shooter's body and the muzzle
    // (characters do not collide with each other, so a charging enemy ends up
    // inside that gap) would otherwise have every round spawn BEHIND it. Start
    // the projectile at the shooter's centre then, so it flies into the target.
    // The shooter is the muzzle transform's owner — the player group, an NPC,
    // a turret — read at muzzle height. See engine/weapons/PointBlank.ts.
    const owner = parentTransform.parent;
    const shooterCentre = owner ? owner.getWorldPosition(new THREE.Vector3()) : null;
    if (shooterCentre) shooterCentre.y = worldMuzzlePos.y;
    const spawnPos = resolveProjectileSpawn(
      worldMuzzlePos,
      shooterCentre,
      this.projectileConfig.collisionMask ?? CollisionMask.PROJECTILE,
      // A shot fired with no physics world (headless tests, a turret built before the world)
      // simply has nothing between muzzle and body: report "clear" rather than throwing.
      (origin, dir, maxDistance, mask) =>
        physicsWorld?.raycastWithFilter(origin, dir, maxDistance, CollisionGroup.PROJECTILE, mask).hasHit ?? false,
    );

    // Create projectile using existing engine/Projectile.ts
    // Pass collision mask for enemy projectiles to hit players
    return new Projectile(
      spawnPos,
      direction,
      this.projectileConfig.speed,
      physicsWorld,
      engine,
      this.projectileConfig.onHitCallback,
      this.projectileConfig.visualConfig,
      undefined, // projectileType - use default
      this.projectileConfig.collisionMask // collision mask for enemy projectiles
    );
  }
}
