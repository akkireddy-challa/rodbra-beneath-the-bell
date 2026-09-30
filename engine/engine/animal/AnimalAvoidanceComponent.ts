import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * Context callbacks the avoidance component uses to reach its host controller.
 * Mirrors the NavigationComponent context pattern so AnimalController stays the
 * single owner of its physics body, loader, and navigation state.
 */
export interface AnimalAvoidanceContext {
    getCharacter(): THREE.Object3D;
    getPhysicsBody(): RAPIER.RigidBody | null;
    getPhysicsWorld(): PhysicsWorld;
    getEngine(): EngineLike;
    getCapsuleRadius(): number;
    getCapsuleHeight(): number;
    getMoveSpeed(): number;
    /** Drop the active path AND target (used when avoidance overrides navigation). */
    clearNavigation(): void;
    /** Drop only the active path (obstacle escape keeps the target). */
    clearPath(): void;
    /** Drive the movement motor for one frame in the given world direction. */
    runMovementSystem(deltaTime: number, moveDirection: THREE.Vector3): void;
}

/**
 * Reactive avoidance & recovery for animals:
 *
 * - `avoidDynamicObstacles` — walk away from moving props/vehicles overlapping
 *   the capsule (committed escape direction, hysteresis margins).
 * - `reactToPlayerOverlap` — step straight back (facing preserved) when a
 *   moving player walks into the animal.
 * - `recoverFromObstacle` — escape when standing on top of a navmesh obstacle
 *   cell, where pathfinding cannot start.
 *
 * Extracted verbatim from AnimalController; see the per-method comments for the
 * behavioural rationale (committed directions, hysteresis, elevation gate).
 */
export class AnimalAvoidanceComponent {
    /** Horizontal reach beyond the capsule at which the animal STARTS stepping
     *  away from a dynamic prop / vehicle (reacts just before contact). */
    private static readonly DYNAMIC_AVOID_MARGIN = 0.3;
    /** Once avoiding, keep going until this much clearance — hysteresis, so the
     *  animal can't jitter back and forth across the entry boundary. */
    private static readonly DYNAMIC_AVOID_EXIT_MARGIN = 0.7;
    /** Ignore props/vehicles moving slower than this (m/s). A stationary object
     *  is a navmesh obstacle to route AROUND, not a threat to flee — only react
     *  to one actually moving into the animal. */
    private static readonly DYNAMIC_AVOID_MIN_SPEED = 0.25;

    /** Reach at which the animal reacts to the player OVERLAPPING it — contact
     *  only, so it does NOT move when the player is merely nearby. */
    private static readonly PLAYER_OVERLAP_MARGIN = 0.05;
    /** Don't react to the player unless they're moving at least this fast (m/s) —
     *  a standing player is routed around, never fled. */
    private static readonly PLAYER_MOVE_MIN_SPEED = 0.5;

    /** Committed escape direction (unit XZ) while fleeing a prop/vehicle. */
    private _avoidDir: THREE.Vector2 | null = null;

    /** Whether the animal backs away when the player overlaps it (default true). */
    private _retreatFromPlayerOverlap = true;

    /**
     * Committed obstacle-escape target. Set when the animal is found standing on
     * a navmesh obstacle; the animal moves directly to it and only exits
     * recovery once reached. Committing (rather than re-evaluating every frame)
     * prevents the recovery↔normal-nav flicker that made animals spin in place.
     */
    private _obstacleEscapeTarget: THREE.Vector3 | null = null;

    constructor(private readonly ctx: AnimalAvoidanceContext) {}

    /**
     * Override the default player-overlap reaction. Default `true` (back away).
     */
    setRetreatFromPlayerOverlap(retreat: boolean): void {
        this._retreatFromPlayerOverlap = retreat;
    }

    /**
     * Walk away from any DYNAMIC_PROP / VEHICLE collider overlapping (or within
     * DYNAMIC_AVOID_MARGIN of) the animal's capsule. Returns true while avoiding.
     *
     * The escape direction is COMMITTED on first detection and held until clear.
     * Re-deriving it every frame makes it whip around when the animal is near the
     * obstacle's centre (it is the normalised difference of two nearly-coincident
     * points), and the movement motor — which faces the move direction instantly
     * on the ground — then spins the nose back and forth. We do NOT rotate here:
     * the motor already faces the (now stable) committed direction. (Same lesson
     * as recoverFromObstacle's "no orbit / no heading flip" note.)
     */
    avoidDynamicObstacles(deltaTime: number): boolean {
        const body = this.ctx.getPhysicsBody();
        if (!body) return false;
        const c = body.translation();
        const radius = this.ctx.getCapsuleRadius();
        const halfHeight = Math.max(0, (this.ctx.getCapsuleHeight() - 2 * radius) / 2);
        const margin = this._avoidDir
            ? AnimalAvoidanceComponent.DYNAMIC_AVOID_EXIT_MARGIN
            : AnimalAvoidanceComponent.DYNAMIC_AVOID_MARGIN;
        const away = this.ctx.getPhysicsWorld().computeGroupAvoidance(
            { x: c.x, y: c.y, z: c.z },
            radius,
            halfHeight,
            margin,
            CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE,
            AnimalAvoidanceComponent.DYNAMIC_AVOID_MIN_SPEED,
        );
        if (!away) { this._avoidDir = null; return false; } // clear of obstacles
        if (!this._avoidDir) this._avoidDir = new THREE.Vector2(away.x, away.z);
        // Abandon any path/target that pointed into the obstacle so navigation
        // doesn't immediately tug the animal back into it. Without this the
        // avoidance push and the nav pull fight at the boundary — the animal
        // jitters in place facing the prop and the path line flickers on/off
        // every other frame. The behaviour picks a fresh, reachable target once
        // the animal is clear (past the exit margin).
        this.ctx.clearNavigation();
        this.ctx.runMovementSystem(deltaTime, new THREE.Vector3(this._avoidDir.x, 0, this._avoidDir.y));
        return true;
    }

    /**
     * Step straight back when the player capsule OVERLAPS this animal, WITHOUT
     * turning (facing is preserved — backs off while still watching the player).
     * Contact-only; the player re-plans around standing animals on its own, so
     * this only fires when the player walks straight into one.
     */
    reactToPlayerOverlap(deltaTime: number): boolean {
        const body = this.ctx.getPhysicsBody();
        if (!this._retreatFromPlayerOverlap || !body) return false;
        // Only react to a MOVING player walking into us. A stationary player is
        // routed around by PathConflictAvoidance, not fled (otherwise the animal
        // approaches, backs off, and re-approaches forever).
        const playerSpeed = this.ctx.getEngine().getPlayerController?.()?.getCurrentSpeed?.() ?? 0;
        if (playerSpeed < AnimalAvoidanceComponent.PLAYER_MOVE_MIN_SPEED) return false;
        const c = body.translation();
        const radius = this.ctx.getCapsuleRadius();
        const halfHeight = Math.max(0, (this.ctx.getCapsuleHeight() - 2 * radius) / 2);
        const away = this.ctx.getPhysicsWorld().computeGroupAvoidance(
            { x: c.x, y: c.y, z: c.z },
            radius,
            halfHeight,
            AnimalAvoidanceComponent.PLAYER_OVERLAP_MARGIN,
            CollisionGroup.PLAYER,
        );
        if (!away) return false;
        // Direct displacement (NOT runMovementSystem) so the motor never rotates
        // the body toward the move direction — facing is preserved.
        const stepDist = Math.max(this.ctx.getMoveSpeed(), 3.0) * deltaTime;
        body.setTranslation(
            { x: c.x + away.x * stepDist, y: c.y, z: c.z + away.z * stepDist },
            true,
        );
        return true;
    }

    /**
     * Obstacle-escape recovery. If the animal is standing on a navmesh obstacle
     * cell (climbed or pushed onto it), it cannot pathfind out — every route
     * starts in a blocked cell. Move the body DIRECTLY toward the nearest
     * walkable cell and descend it to that cell's ground height, bypassing the
     * normal ground-follow/step-climb (which would otherwise immediately
     * re-mount it onto the obstacle, causing the minute-long twitch-in-place).
     * A straight move off the obstacle is the correct behaviour here — the
     * animal is escaping, not pathing to a target. Returns true while recovery
     * is active (caller treats nav as handled).
     */
    recoverFromObstacle(deltaTime: number): boolean {
        const body = this.ctx.getPhysicsBody();
        if (!body) return false;
        const nav = getGlobalNavMesh();
        if (!nav || !nav.isReady()) return false;

        const pos = this.ctx.getCharacter().position;

        // Enter recovery only when standing on an obstacle, and COMMIT to one
        // fixed escape point. Aim slightly PAST the nearest walkable cell, in the
        // outward direction, so the animal ends up clearly off the obstacle
        // instead of teetering on the edge and immediately re-mounting.
        if (!this._obstacleEscapeTarget) {
            if (nav.isWalkableAt(pos.x, pos.z)) return false;
            const escape = nav.findNearestValidTarget(pos);
            if (!escape) return false;
            // CRITICAL: only recover if the animal is genuinely ELEVATED above the
            // nearest walkable ground — i.e. actually standing ON TOP of an
            // obstacle. The navmesh also marks an agent-radius band AROUND every
            // obstacle as non-walkable, so `isWalkableAt` is false for plenty of
            // normal ground next to obstacles. Without this height gate, animals
            // merely walking near obstacles were flagged "stuck on an obstacle"
            // and teleported every frame → constant jitter. If the animal is at
            // ground level (not elevated), leave it to normal navigation.
            const ESCAPE_ELEVATION = 0.5;
            if (pos.y <= escape.y + ESCAPE_ELEVATION) return false;
            const ex = escape.x - pos.x;
            const ez = escape.z - pos.z;
            const elen = Math.hypot(ex, ez) || 1;
            const margin = this.ctx.getCapsuleRadius() + 0.4;
            this._obstacleEscapeTarget = new THREE.Vector3(
                escape.x + (ex / elen) * margin,
                escape.y,
                escape.z + (ez / elen) * margin,
            );
        }

        const target = this._obstacleEscapeTarget;
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const distXZ = Math.hypot(dx, dz);

        // Reached the escape point → hand back to normal navigation.
        if (distXZ < 0.4) {
            this._obstacleEscapeTarget = null;
            return false;
        }

        // Move STRAIGHT toward the fixed escape point, clamped so we can never
        // overshoot it (overshoot is what made the earlier version orbit and
        // flip heading back and forth). Direct body move bypasses the
        // ground-follow that would otherwise re-mount the obstacle.
        const escapeSpeed = Math.max(this.ctx.getMoveSpeed(), 3.0);
        const t = Math.min(1, (escapeSpeed * deltaTime) / distXZ);
        const nx = pos.x + dx * t;
        const nz = pos.z + dz * t;

        // Descend toward the escape point's ground height (smoothed, not a snap).
        const ny = pos.y + (target.y - pos.y) * Math.min(1, deltaTime * 8);
        const capsuleH = this.ctx.getCapsuleHeight();
        body.setTranslation({ x: nx, y: ny + capsuleH / 2, z: nz }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);

        // Drop any active path/target so normal navigation doesn't fight the escape.
        this.ctx.clearPath();

        // Face EXACTLY the direction we actually moved this frame. Heading is
        // derived from the real movement delta, so it is impossible for the nose
        // to disagree with the motion — no lag, no snap-back, no oscillation. If
        // the nose still points at the obstacle, the escape TARGET is wrong (the
        // nearest-walkable query returned an inward cell), which is a different
        // bug to chase.
        const mdx = nx - pos.x;
        const mdz = nz - pos.z;
        if (mdx * mdx + mdz * mdz > 1e-8) {
            this.ctx.getCharacter().rotation.y = Math.atan2(mdx, mdz);
        }
        return true;
    }
}
