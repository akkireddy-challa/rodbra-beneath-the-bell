import type { GameData } from 'types/game.js';

/**
 * The Z of the locked gameplay plane for a side-on 2D game, or null when the
 * game has no such plane.
 *
 * A side-on game (sidescroller, side-view platformer) plays entirely on one
 * X/Y plane: the template locks the PLAYER to it, the World-Forger places every
 * walkable surface, coin, checkpoint and goal on it, and only backdrop decor
 * sits behind it. The engine's NPC behaviors, pathfinding and crowd avoidance
 * are 3D, though — a chasing enemy strafes in Z, the crowd solver separates
 * neighbours in Z, and a wander target lands off-plane — so without a lock the
 * enemies visibly drift off the plane the whole game happens on, out of reach
 * of the player who cannot follow them there. NPC code resolves this once per
 * load via `engine.getGameplayPlaneZ()` and self-constrains (see
 * `NpcController.applyGameplayPlaneLock`).
 *
 * Deliberately NOT every 2D game: a top-down 2D game plays on the X/Z ground
 * plane, where Z is a real gameplay axis and locking it would pin every NPC to
 * one row of the world. The Physics2D genre never sets `gameDimension`, so it
 * resolves to null and keeps owning its own movement — this rule only claims
 * the games whose plane the voxel engine itself established.
 */
export function resolveGameplayPlaneZ(gameData: GameData): number | null {
    if (gameData.gameDimension !== '2d') return null;
    if (gameData.worldProfileData?.cameraMode === 'top-down') return null;
    return 0;
}

/**
 * Which world plane the Rapier 2D world simulates when a game runs 2D physics
 * (`engine/physics/PlaneLockedPhysics.ts`).
 *
 *  - `'xy'` — side-on: 2D (x, y) is world (X, Y), world Z is locked to `planeZ`
 *    and gravity is real (the sidescroller).
 *  - `'xz'` — ground plane: 2D (x, y) is world (X, Z), the 2D world has no
 *    gravity, and world Y is a virtual axis the facade answers from the terrain
 *    heightmap (the top-down template — see `engine/physics/TopDownGround.ts`).
 */
export type PlaneOrientation = 'xy' | 'xz';

export interface PhysicsPlane {
    orientation: PlaneOrientation;
    /** Side-on only: the world Z every body reports. Zero on the ground plane. */
    planeZ: number;
}

/**
 * The plane a 2D-physics game simulates. The camera decides: a top-down camera
 * looks down on the X/Z ground plane (the same signal that makes
 * `WorldGenerator` stamp flat terrain), everything else is a side view on the
 * X/Y plane at the locked gameplay Z (0 when the game declares no plane).
 */
export function resolvePhysicsPlane(gameData: GameData): PhysicsPlane {
    if (gameData.worldProfileData?.cameraMode === 'top-down') return { orientation: 'xz', planeZ: 0 };
    return { orientation: 'xy', planeZ: resolveGameplayPlaneZ(gameData) ?? 0 };
}
