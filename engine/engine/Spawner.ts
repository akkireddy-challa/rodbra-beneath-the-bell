import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { CollisionMask } from 'engine/CollisionLayers.js';
import type { ObjectTransform, BoundingBox } from 'engine/ObjectIdService.js';
import { PlacementHelper } from 'engine/PlacementHelper.js';
import { getActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { levelSpawnPoints } from 'engine/levels/levelResolve.js';

/**
 * Custom position calculator function for extensible spawn positioning.
 * Use this when built-in SpawnRelation values don't fit your needs.
 *
 * @param objectTransform - Transform of the target object (position, rotation, bounding box)
 * @returns World position where the NPC should spawn
 */
export type CustomPositionFn = (objectTransform: ObjectTransform) => THREE.Vector3;

/**
 * Spatial relation for object-relative spawning
 */
export enum SpawnRelation {
    /** On top of the object's bounding box (elevated spawning) */
    ON_TOP = 'on_top',
    /** Next to the object at ground level */
    BESIDE = 'beside',
    /** In front of the object (uses object's rotation) */
    IN_FRONT = 'in_front',
    /** Behind the object */
    BEHIND = 'behind'
}

/**
 * Options for spawning relative to an object
 */
export interface RelativeSpawnOptions {
    /** Spatial relation to the object (use this OR customPosition) */
    relation?: SpawnRelation;
    /** Custom position calculator function (use this OR relation) */
    customPosition?: CustomPositionFn;
    /** Fine-tuning offset in local coordinates (applied after relation or customPosition) */
    offset?: { x?: number; y?: number; z?: number };
    /** For 'beside' relation: which side */
    side?: 'left' | 'right';
    /** Distance from object (used for in_front/behind/beside) */
    distance?: number;
}

/**
 * How far above a requested interior height the floor probe starts. Low enough to stay
 * under the ceiling of a ~2.5 m room when the requested height IS the floor, high enough
 * to clear floor clutter and half-height steps.
 */
export const INTERIOR_PROBE_ABOVE_M = 1.5;

/**
 * Deepest floor accepted below a requested interior height — about one dungeon storey.
 * A first hit further down means the probe fell into an unrelated lower storey or shaft
 * ("wrong column"), not the room the caller asked for.
 */
export const INTERIOR_MAX_DROP_M = 12;

/**
 * Spawner - Generic entity spawning system with ground height detection
 *
 * This is a foundational spawning system that provides ground detection and positioning
 * utilities for any type of entity (vehicles, NPCs, props, collectibles, etc.)
 */
export class Spawner {
    private engine: EngineLike;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /**
     * Get proper ground height at a given X/Z position
     * Uses engine's getWorldHeightAt if available, otherwise uses physics raycasting
     *
     * @param x - World X coordinate
     * @param z - World Z coordinate
     * @param searchHeight - How high above to start searching (default: 100)
     * @returns Ground height Y coordinate, or null if no ground found
     */
    public getGroundHeight(x: number, z: number, searchHeight: number = 100): number | null {
        let bestHeight: number | null = null;

        // 1. Terrain height (fast, but only detects terrain — not placed objects)
        if (this.engine.getWorldHeightAt) {
            const height = this.engine.getWorldHeightAt(x, z);
            if (height !== undefined && height !== null && !isNaN(height)) {
                bestHeight = height;
            }
        }

        // 2. Physics raycast (detects all colliders)
        if (this.engine.physicsWorld) {
            const origin = new THREE.Vector3(x, searchHeight, z);
            const direction = new THREE.Vector3(0, -1, 0);
            const maxDistance = searchHeight * 2;

            const result = this.engine.physicsWorld.raycast(origin, direction, maxDistance, CollisionMask.ALL);
            if (result.hasHit) {
                bestHeight = bestHeight !== null ? Math.max(bestHeight, result.hitPoint.y) : result.hitPoint.y;
            }
        }

        return bestHeight;
    }

    /**
     * Interior-aware ground resolution: the floor directly below `fromY`, by physics
     * raycast alone. {@link getGroundHeight} means "the topmost surface" (it starts its
     * ray in the sky and takes the max with the terrain function), which inside a roofed
     * space resolves the ROOF — this method is for callers that know the intended interior
     * height (e.g. `NpcHandle.spawn(x, z, y)`, which promises "the room's floor, not the
     * roof") and need the storey under it.
     *
     * Deliberately ignores `engine.getWorldHeightAt` — the terrain function only knows
     * exterior surfaces, and mixing it back in would reintroduce the roof.
     *
     * @param fromY - The interior height to probe from; the ray starts
     *                {@link INTERIOR_PROBE_ABOVE_M} above it.
     * @returns The floor height, or null when no floor lies within
     *          {@link INTERIOR_MAX_DROP_M} below `fromY` (wrong column — let the caller
     *          try a neighbouring position).
     */
    public getGroundHeightBelow(x: number, z: number, fromY: number): number | null {
        if (!this.engine.physicsWorld) return null;
        const origin = new THREE.Vector3(x, fromY + INTERIOR_PROBE_ABOVE_M, z);
        const direction = new THREE.Vector3(0, -1, 0);
        const maxDistance = INTERIOR_PROBE_ABOVE_M + INTERIOR_MAX_DROP_M;
        const result = this.engine.physicsWorld.raycast(origin, direction, maxDistance, CollisionMask.ALL);
        return result.hasHit ? result.hitPoint.y : null;
    }

    /**
     * Calculate a spawn position with automatic ground height detection and height offset
     *
     * @param xz - The X and Z coordinates where to spawn
     * @param heightOffset - How far above ground to spawn (e.g., half entity height + margin)
     * @returns Complete spawn position with Y coordinate, or null if no ground found
     */
    public calculateSpawnPosition(
        xz: { x: number; z: number },
        heightOffset: number
    ): THREE.Vector3 | null {
        const groundHeight = this.getGroundHeight(xz.x, xz.z);

        if (groundHeight === null) {
            console.error(`Spawner: Cannot calculate spawn position at (${xz.x}, ${xz.z}) - no ground found`);
            return null;
        }

        const spawnY = groundHeight + heightOffset;
        return new THREE.Vector3(xz.x, spawnY, xz.z);
    }

    /**
     * Calculate spawn position relative to a reference position
     *
     * @param referencePos - Reference position (e.g., player position)
     * @param offset - Offset from reference position {x, z}
     * @param heightOffset - How far above ground to spawn
     * @returns Complete spawn position, or null if no ground found
     */
    public calculateSpawnPositionRelativeTo(
        referencePos: { x: number; z: number },
        offset: { x: number; z: number },
        heightOffset: number
    ): THREE.Vector3 | null {
        const targetX = referencePos.x + offset.x;
        const targetZ = referencePos.z + offset.z;

        return this.calculateSpawnPosition({ x: targetX, z: targetZ }, heightOffset);
    }

    /**
     * Check if a position is valid for spawning (has ground)
     *
     * @param position - Position to check {x, z}
     * @returns true if position has valid ground, false otherwise
     */
    public isValidPosition(position: { x: number; z: number }): boolean {
        const groundHeight = this.getGroundHeight(position.x, position.z);
        return groundHeight !== null;
    }

    /**
     * Find a valid spawn position near a target position
     * Searches in a spiral pattern outward from the target until valid ground is found
     *
     * @param target - Target position {x, z}
     * @param maxSearchRadius - Maximum search radius (default: 20 units)
     * @param step - Distance between search points (default: 2 units)
     * @returns Valid position {x, z}, or null if no valid position found
     */
    public findNearbyValidPosition(
        target: { x: number; z: number },
        maxSearchRadius: number = 20,
        step: number = 2
    ): { x: number; z: number } | null {
        // First check target position itself
        if (this.isValidPosition(target)) {
            return target;
        }

        // Spiral search outward
        let radius = step;
        while (radius <= maxSearchRadius) {
            const numPoints = Math.floor((2 * Math.PI * radius) / step);
            for (let i = 0; i < numPoints; i++) {
                const angle = (i / numPoints) * Math.PI * 2;
                const x = target.x + Math.cos(angle) * radius;
                const z = target.z + Math.sin(angle) * radius;

                if (this.isValidPosition({ x, z })) {
                    return { x, z };
                }
            }
            radius += step;
        }

        console.warn(`Spawner: No valid position found near (${target.x}, ${target.z}) within ${maxSearchRadius} units`);
        return null;
    }

    /**
     * Calculate spawn position with automatic fallback to nearby valid position
     *
     * @param xz - Desired spawn position {x, z}
     * @param heightOffset - How far above ground to spawn
     * @param searchRadius - Maximum search radius for fallback position (default: 20)
     * @returns Spawn position, or null if no valid position found
     */
    public calculateSpawnPositionWithFallback(
        xz: { x: number; z: number },
        heightOffset: number,
        searchRadius: number = 20
    ): THREE.Vector3 | null {
        // Try original position first
        const position = this.calculateSpawnPosition(xz, heightOffset);
        if (position) {
            return position;
        }

        // Find nearby valid position
        console.log(`Spawner: Target position (${xz.x}, ${xz.z}) invalid, searching for nearby position...`);
        const fallbackXZ = this.findNearbyValidPosition(xz, searchRadius);

        if (fallbackXZ) {
            console.log(`Spawner: Found valid fallback position at (${fallbackXZ.x}, ${fallbackXZ.z})`);
            return this.calculateSpawnPosition(fallbackXZ, heightOffset);
        }

        return null;
    }

    /**
     * Get the engine instance (for advanced usage)
     */
    public getEngine(): EngineLike {
        return this.engine;
    }
    
    /**
     * Get the player spawn position from world profile data.
     * Use this at init time instead of player.position (which may not be set yet).
     * 
     * @returns Player spawn position, or default (0, 0, 0) if not configured
     */
    public getPlayerSpawnPosition(): THREE.Vector3 {
        const profile = this.engine.getGameData?.()?.worldProfileData;
        // Levels mode: the active level's spawn points win over the global set.
        const pts = levelSpawnPoints(profile, getActiveLevelManager()?.getActiveLevel() ?? null);
        const spawnPos = pts.find(sp => sp.type === 'player')?.position
            ?? profile?.playerSpawnPosition;
        if (spawnPos) {
            return new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z);
        }
        return new THREE.Vector3(0, 0, 0);
    }
    
    /**
     * Check if a position is in a tight corner (surrounded by voxels on more than 1 side).
     * This prevents spawning animals in corners where they can't move freely.
     * 
     * @param x - World X coordinate
     * @param z - World Z coordinate
     * @param checkRadius - Distance to check for obstructions (default: 1.5m)
     * @returns true if position is open (0-1 sides blocked), false if tight corner (2+ sides blocked)
     */
    public isOpenArea(x: number, z: number, checkRadius: number = 1.5): boolean {
        if (!this.engine.physicsWorld) return true; // Assume open if no physics

        const checkY = this.getGroundHeight(x, z);
        if (checkY === null) return false;

        return this.isOpenAreaAtHeight(x, z, checkY, checkRadius);
    }

    /**
     * {@link isOpenArea} at an explicit ground height. `isOpenArea` resolves its check
     * height sky-down, which inside a roofed space probes the ROOF's storey — pair this
     * with {@link getGroundHeightBelow} to check openness on the interior floor instead.
     *
     * @param groundY - The floor height to probe at (side rays run at `groundY + 0.5`).
     */
    public isOpenAreaAtHeight(x: number, z: number, groundY: number, checkRadius: number = 1.5): boolean {
        if (!this.engine.physicsWorld) return true; // Assume open if no physics

        const rayHeight = groundY + 0.5; // Check at roughly animal height
        let blockedSides = 0;

        // Check 4 cardinal directions
        const directions = [
            { dx: checkRadius, dz: 0 },    // +X
            { dx: -checkRadius, dz: 0 },   // -X
            { dx: 0, dz: checkRadius },    // +Z
            { dx: 0, dz: -checkRadius },   // -Z
        ];

        for (const dir of directions) {
            const origin = new THREE.Vector3(x, rayHeight, z);
            const direction = new THREE.Vector3(dir.dx, 0, dir.dz).normalize();
            const distance = Math.sqrt(dir.dx * dir.dx + dir.dz * dir.dz);

            const result = this.engine.physicsWorld.raycast(origin, direction, distance, CollisionMask.ALL);

            if (result.hasHit) {
                blockedSides++;
            }
        }

        // Open if 0-1 sides blocked, tight corner if 2+ sides blocked
        return blockedSides <= 1;
    }
    
    /**
     * Check if a position is occupied by an existing entity.
     * 
     * @param x - World X coordinate
     * @param z - World Z coordinate
     * @param occupiedRadius - Minimum distance from other entities (default: 2m)
     * @param additionalChecks - Optional additional occupation checks
     * @returns true if position is free, false if occupied
     */
    public isPositionFree(
        x: number, 
        z: number, 
        occupiedRadius: number = 2.0,
        additionalChecks?: {
            /** Current player position (if available) */
            playerPosition?: { x: number; z: number };
            /** Positions already occupied by other spawned entities */
            occupiedPositions?: Array<{ x: number; z: number; radius?: number }>;
            /** Callback to check environment objects (trees, rocks, etc.) */
            isEnvironmentOccupied?: (x: number, z: number, radius: number) => boolean;
        }
    ): boolean {
        // Check against player spawn position
        const playerSpawn = this.getPlayerSpawnPosition();
        const distToPlayerSpawn = Math.sqrt(
            Math.pow(x - playerSpawn.x, 2) + Math.pow(z - playerSpawn.z, 2)
        );
        if (distToPlayerSpawn < occupiedRadius) {
            return false;
        }
        
        // Check against current player position (if provided)
        if (additionalChecks?.playerPosition) {
            const pp = additionalChecks.playerPosition;
            const distToPlayer = Math.sqrt(Math.pow(x - pp.x, 2) + Math.pow(z - pp.z, 2));
            if (distToPlayer < occupiedRadius) {
                return false;
            }
        }
        
        // Check against other occupied positions (other animals, NPCs, etc.)
        if (additionalChecks?.occupiedPositions) {
            for (const occupied of additionalChecks.occupiedPositions) {
                const minDist = occupiedRadius + (occupied.radius ?? 1.0);
                const dist = Math.sqrt(Math.pow(x - occupied.x, 2) + Math.pow(z - occupied.z, 2));
                if (dist < minDist) {
                    return false;
                }
            }
        }
        
        // Check environment objects (trees, rocks, etc.)
        if (additionalChecks?.isEnvironmentOccupied) {
            if (additionalChecks.isEnvironmentOccupied(x, z, occupiedRadius)) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Find a valid spawn position near a target position.
     * 
     * This is the recommended way to spawn entities. It:
     * - Uses proper terrain height (voxel-aware or heightmap)
     * - Avoids the player spawn position and current position
     * - Avoids environment objects (trees, rocks)
     * - Avoids other already-spawned entities
     * - Avoids tight corners (2+ sides blocked)
     * - Searches outward if the exact position is invalid
     * - Respects world boundaries
     * 
     * @param targetPos - Position to spawn near (e.g., player spawn position)
     * @param options - Spawn options
     * @returns Valid spawn position, or null if none found
     */
    public findValidSpawnPositionNear(
        targetPos: THREE.Vector3,
        options: {
            minDistance?: number;
            maxDistance?: number;
            occupiedRadius?: number;
            step?: number;
            /** Current player position (if available at runtime) */
            playerPosition?: { x: number; z: number };
            /** Positions already occupied by spawned entities */
            occupiedPositions?: Array<{ x: number; z: number; radius?: number }>;
            /** Callback to check environment objects (trees, rocks, etc.) */
            isEnvironmentOccupied?: (x: number, z: number, radius: number) => boolean;
        } = {}
    ): THREE.Vector3 | null {
        const {
            minDistance = 3,
            maxDistance = 25,
            occupiedRadius = 2,
            step = 2,
            playerPosition,
            occupiedPositions,
            isEnvironmentOccupied,
        } = options;
        
        // Get world boundaries
        const gameData = this.engine.getGameData?.();
        const worldSizeX = gameData?.worldProfileData?.groundWorldSizeX ?? 128;
        const worldSizeZ = gameData?.worldProfileData?.groundWorldSizeZ ?? 128;
        const halfX = worldSizeX / 2 - 2; // Small margin from edge
        const halfZ = worldSizeZ / 2 - 2;
        
        // Search in a spiral pattern outward from target
        let radius = minDistance;
        while (radius <= maxDistance) {
            const numPoints = Math.max(8, Math.floor((2 * Math.PI * radius) / step));
            
            // Randomize starting angle for variety
            const startAngle = Math.random() * Math.PI * 2;
            
            for (let i = 0; i < numPoints; i++) {
                const angle = startAngle + (i / numPoints) * Math.PI * 2;
                const candidateX = targetPos.x + Math.cos(angle) * radius;
                const candidateZ = targetPos.z + Math.sin(angle) * radius;
                
                // Clamp to world boundaries
                const clampedX = Math.max(-halfX, Math.min(halfX, candidateX));
                const clampedZ = Math.max(-halfZ, Math.min(halfZ, candidateZ));
                
                // Skip if clamping moved us significantly
                if (Math.abs(clampedX - candidateX) > 1 || Math.abs(clampedZ - candidateZ) > 1) {
                    continue;
                }
                
                // Check if position is free (not occupied by player, other entities, or environment)
                if (!this.isPositionFree(clampedX, clampedZ, occupiedRadius, {
                    playerPosition,
                    occupiedPositions,
                    isEnvironmentOccupied,
                })) {
                    continue;
                }
                
                // Check if it's an open area (not a tight corner)
                if (!this.isOpenArea(clampedX, clampedZ)) {
                    continue;
                }
                
                // Get proper Y position using voxel-aware function or heightmap
                let spawnPos: THREE.Vector3 | null = null;
                
                if (this.engine.findValidVoxelSpawnPosition) {
                    spawnPos = this.engine.findValidVoxelSpawnPosition(clampedX, clampedZ);
                }
                
                if (!spawnPos) {
                    const groundY = this.getGroundHeight(clampedX, clampedZ);
                    if (groundY !== null) {
                        spawnPos = new THREE.Vector3(clampedX, groundY, clampedZ);
                    }
                }
                
                if (spawnPos) {
                    return spawnPos;
                }
            }
            
            radius += step;
        }
        
        console.warn(`[Spawner] No valid spawn position found near (${targetPos.x.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
        return null;
    }

    // ============================================================================
    // Object-Relative Spawning Utilities
    // ============================================================================

    /**
     * Default height offset for NPC spawning (distance from surface to NPC center)
     */
    private static readonly NPC_HEIGHT_OFFSET = 0.9;

    /**
     * Default distance for beside/in_front/behind relations
     */
    private static readonly DEFAULT_RELATION_DISTANCE = 2.0;

    /**
     * Calculate spawn position relative to an object using spatial relations.
     * Used for scenarios like "spawn NPC on top of tower" or "spawn guard in front of gate".
     *
     * @param objectTransform - Transform data of the target object (position, rotation, bounding box)
     * @param options - Relation type and optional offset
     * @returns Calculated spawn position in world coordinates
     */
    public calculateRelativePosition(
        objectTransform: ObjectTransform,
        options: RelativeSpawnOptions
    ): THREE.Vector3 {
        const { relation, customPosition, offset, side = 'right', distance = Spawner.DEFAULT_RELATION_DISTANCE } = options;
        const { position, rotation, boundingBox } = objectTransform;

        let result: THREE.Vector3;

        // If custom position function provided, use it
        if (customPosition) {
            result = customPosition(objectTransform);
            // Apply user offset and return
            if (offset) {
                result.x += offset.x ?? 0;
                result.y += offset.y ?? 0;
                result.z += offset.z ?? 0;
            }
            return result;
        }

        // Get bounding box dimensions, or use defaults if not available
        const bbox = boundingBox || this.getDefaultBoundingBox();
        const width = bbox.maxX - bbox.minX;
        const depth = bbox.maxZ - bbox.minZ;

        // Start with object's center position
        result = position.clone();

        switch (relation) {
            case SpawnRelation.ON_TOP:
                // Spawn on top of the object's bounding box
                result.y = position.y + bbox.maxY + Spawner.NPC_HEIGHT_OFFSET;
                break;

            case SpawnRelation.BESIDE: {
                // Spawn to the side of the object at ground level
                const sideOffset = (width / 2) + distance;
                const sideDirection = side === 'left' ? -1 : 1;
                // Use object's rotation to determine left/right
                const rightVec = new THREE.Vector3(1, 0, 0).applyEuler(rotation);
                result.x += rightVec.x * sideOffset * sideDirection;
                result.z += rightVec.z * sideOffset * sideDirection;
                // Y will be set by ground detection
                break;
            }

            case SpawnRelation.IN_FRONT: {
                // Spawn in front of the object (in the direction it's facing)
                const frontOffset = (depth / 2) + distance;
                // Object faces +Z direction by default, rotated by rotation.y
                const forwardVec = new THREE.Vector3(0, 0, 1).applyEuler(rotation);
                result.x += forwardVec.x * frontOffset;
                result.z += forwardVec.z * frontOffset;
                // Y will be set by ground detection
                break;
            }

            case SpawnRelation.BEHIND: {
                // Spawn behind the object
                const backOffset = (depth / 2) + distance;
                const backwardVec = new THREE.Vector3(0, 0, -1).applyEuler(rotation);
                result.x += backwardVec.x * backOffset;
                result.z += backwardVec.z * backOffset;
                // Y will be set by ground detection
                break;
            }
        }

        // Apply user offset
        if (offset) {
            result.x += offset.x ?? 0;
            result.y += offset.y ?? 0;
            result.z += offset.z ?? 0;
        }

        return result;
    }

    /**
     * Get a default bounding box for objects that don't have one defined.
     * Uses a small 1x1x1 meter cube.
     */
    private getDefaultBoundingBox(): BoundingBox {
        return {
            minX: -0.5,
            minY: 0,
            minZ: -0.5,
            maxX: 0.5,
            maxY: 1,
            maxZ: 0.5,
        };
    }

    /**
     * Validate a spawn position and adjust Y for ground-level relations.
     * Uses PlacementHelper for ground detection.
     *
     * @param targetPosition - Desired spawn position (X/Z from relation, Y may need adjustment)
     * @param relation - The relation type (ON_TOP uses bounding box Y, others use ground detection)
     * @returns Valid spawn position, or null if no valid position found
     */
    public validateAndAdjustPosition(
        targetPosition: THREE.Vector3,
        relation: SpawnRelation
    ): THREE.Vector3 | null {
        // For ON_TOP, trust the bounding box calculation directly
        // Y was already calculated from: object.position.y + bbox.maxY + NPC_HEIGHT_OFFSET
        if (relation === SpawnRelation.ON_TOP) {
            return targetPosition.clone();
        }

        // For ground-level relations (BESIDE, IN_FRONT, BEHIND), detect ground height
        // Prefer findValidVoxelSpawnPosition (voxel-aware, avoids trees) over PlacementHelper
        if (this.engine.findValidVoxelSpawnPosition) {
            const validPos = this.engine.findValidVoxelSpawnPosition(targetPosition.x, targetPosition.z);
            if (validPos) {
                return validPos;
            }
        }

        // Fallback to PlacementHelper if voxel system not available
        if (!this.engine.physicsWorld) {
            console.warn(`[Spawner] No physics world for ground detection`);
            return targetPosition.clone();
        }

        const groundY = PlacementHelper.findLowestGroundHeight(
            this.engine.physicsWorld,
            targetPosition.x,
            targetPosition.z,
            1.0
        );

        return new THREE.Vector3(
            targetPosition.x,
            groundY + Spawner.NPC_HEIGHT_OFFSET,
            targetPosition.z
        );
    }
}
