// Type checking enabled
import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { raycastGroundY } from 'engine/GroundPlacement.js';

export interface PlacementResult {
    position: THREE.Vector3;
    normal: THREE.Vector3;
    onGround: boolean;
}

export class PlacementHelper {
    // ============================================================================
    // STATIC METHODS - Physics-based ground height detection
    // ============================================================================

    /**
     * Find ground height at a specific position using physics raycasting.
     * This is more accurate than mesh raycasting for terrain with colliders.
     *
     * Shares the ray with `engine/GroundPlacement.ts`. The 0 for "nothing under
     * this point" is kept only because published games call this; prefer
     * `engine.resolveGroundPlacement(x, z)`, which reports a miss instead of
     * handing back a Y that isn't ground, and validates X/Z against the real
     * terrain bounds.
     *
     * @param physicsWorld - The physics world to raycast against
     * @param x - X coordinate
     * @param z - Z coordinate
     * @returns Ground height Y, or 0 if no ground found
     */
    static findGroundHeight(physicsWorld: PhysicsWorld, x: number, z: number): number {
        return raycastGroundY(physicsWorld, x, z) ?? 0;
    }

    /** Ground height at (x, z), or null when the ray hits nothing. No zero fallback. */
    static findGroundHeightOrNull(physicsWorld: PhysicsWorld, x: number, z: number): number | null {
        return raycastGroundY(physicsWorld, x, z);
    }

    /**
     * Find the lowest ground height in a small radius around a position.
     * This prevents objects near slopes from floating - they sit at the lowest nearby ground.
     *
     * Samples the center plus 4 cardinal directions in a cross pattern:
     *     +Z
     *      |
     * -X --●-- +X
     *      |
     *     -Z
     *
     * @param physicsWorld - The physics world to raycast against
     * @param x - X coordinate (center of sampling area)
     * @param z - Z coordinate (center of sampling area)
     * @param radius - Sampling radius (default: 1.0m - small to stay close to intended position)
     * @returns Lowest ground height Y found in the sampled area, or 0 if no sample hit ground
     */
    static findLowestGroundHeight(
        physicsWorld: PhysicsWorld,
        x: number,
        z: number,
        radius: number = 1.0
    ): number {
        // Sample center and 4 cardinal directions. Samples that hit nothing are
        // SKIPPED, not counted as 0 — one neighbour hanging over the map edge used
        // to drag the whole result down to the sky floor and bury the object.
        const samples = [
            raycastGroundY(physicsWorld, x, z),           // Center
            raycastGroundY(physicsWorld, x + radius, z),  // +X
            raycastGroundY(physicsWorld, x - radius, z),  // -X
            raycastGroundY(physicsWorld, x, z + radius),  // +Z
            raycastGroundY(physicsWorld, x, z - radius),  // -Z
        ].filter((y): y is number => y !== null);

        if (samples.length === 0) return 0;

        // Return the lowest valid height
        return Math.min(...samples);
    }

    /**
     * Check if terrain is flat enough for a rectangular footprint at the given position.
     * Samples 5 points (center + 4 corners) and checks height variance.
     *
     * @param physicsWorld - The physics world to raycast against
     * @param x - Center X coordinate
     * @param z - Center Z coordinate
     * @param width - Footprint width (X axis)
     * @param length - Footprint length (Z axis)
     * @param maxHeightVariance - Maximum allowed height difference (default: 0.5m)
     * @returns true if terrain is flat enough, false if it is too uneven or any
     *          sample point has no ground at all (off the map, over a hole)
     */
    static isTerrainFlat(
        physicsWorld: PhysicsWorld,
        x: number,
        z: number,
        width: number,
        length: number,
        maxHeightVariance: number = 0.5
    ): boolean {
        const halfWidth = width / 2;
        const halfLength = length / 2;

        // Sample 5 points: center and 4 corners
        const samplePoints = [
            { x, z },                                    // Center
            { x: x - halfWidth, z: z - halfLength },    // Back-left
            { x: x + halfWidth, z: z - halfLength },    // Back-right
            { x: x - halfWidth, z: z + halfLength },    // Front-left
            { x: x + halfWidth, z: z + halfLength },    // Front-right
        ];

        const heights: number[] = [];
        for (const point of samplePoints) {
            const height = raycastGroundY(physicsWorld, point.x, point.z);
            // No ground under a corner means the footprint hangs off the map — that
            // is not "flat", and treating the miss as Y = 0 reported flat ground
            // wherever the whole footprint happened to miss.
            if (height === null) return false;
            heights.push(height);
        }

        const minHeight = Math.min(...heights);
        const maxHeight = Math.max(...heights);
        const variance = maxHeight - minHeight;

        return variance <= maxHeightVariance;
    }

    /**
     * Find a flat spawn position for a rectangular footprint near the target position.
     * Searches in a spiral pattern for terrain flat enough.
     *
     * @param physicsWorld - The physics world to raycast against
     * @param target - Target position {x, z}
     * @param width - Footprint width (X axis)
     * @param length - Footprint length (Z axis)
     * @param maxHeightVariance - Maximum allowed height difference (default: 0.5m)
     * @param maxSearchRadius - Maximum search radius (default: 30)
     * @param step - Distance between search points (default: 3)
     * @returns Flat position {x, z}, or null if none found
     */
    static findFlatPosition(
        physicsWorld: PhysicsWorld,
        target: { x: number; z: number },
        width: number,
        length: number,
        maxHeightVariance: number = 0.5,
        maxSearchRadius: number = 30,
        step: number = 3
    ): { x: number; z: number } | null {
        // First check target position itself
        if (PlacementHelper.isTerrainFlat(physicsWorld, target.x, target.z, width, length, maxHeightVariance)) {
            return target;
        }

        // Spiral search outward
        let radius = step;
        while (radius <= maxSearchRadius) {
            const numPoints = Math.max(8, Math.floor((2 * Math.PI * radius) / step));
            for (let i = 0; i < numPoints; i++) {
                const angle = (i / numPoints) * Math.PI * 2;
                const x = target.x + Math.cos(angle) * radius;
                const z = target.z + Math.sin(angle) * radius;

                if (PlacementHelper.isTerrainFlat(physicsWorld, x, z, width, length, maxHeightVariance)) {
                    return { x, z };
                }
            }
            radius += step;
        }

        return null;
    }

    // ============================================================================
    // INSTANCE METHODS - Scene-based mesh raycasting
    // ============================================================================

    private scene: THREE.Scene;
    private raycaster: THREE.Raycaster;
    private maxRayHeight: number = 1000;
    private minClearanceHeight: number = 0.1; // Minimum space needed above placement point

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.raycaster = new THREE.Raycaster();
    }

    /**
     * Find a valid placement position for an object at given x, z coordinates.
     * Uses raycasting to determine the y coordinate and checks for space.
     *
     * @param object - The Three.js object to place (used for size calculations)
     * @param x - X coordinate in world space
     * @param z - Z coordinate in world space
     * @returns PlacementResult with position and metadata, or null if no valid placement found
     */
    findPlacement(object: THREE.Object3D, x: number, z: number): PlacementResult | null {
        // Compute bounding box to determine object size
        const boundingBox = new THREE.Box3().setFromObject(object);
        const objectSize = new THREE.Vector3();
        boundingBox.getSize(objectSize);

        // Cast ray downward from high above to find surface
        const rayOrigin = new THREE.Vector3(x, this.maxRayHeight, z);
        const rayDirection = new THREE.Vector3(0, -1, 0);

        this.raycaster.set(rayOrigin, rayDirection);
        this.raycaster.far = this.maxRayHeight * 2;

        // Get all intersections with scene objects (filter to only meshes)
        const raycastTargets = this.getRaycastableObjects();
        const intersects = this.raycaster.intersectObjects(raycastTargets, false);

        if (intersects.length === 0) {
            // No surface found
            return null;
        }

        // Use the first (topmost) intersection
        const firstIntersect = intersects[0]!;
        const hitPoint = firstIntersect.point;

        // Get world-space normal (face normal is in local space, need to transform it)
        let hitNormal = new THREE.Vector3(0, 1, 0); // Default to up
        if (firstIntersect.face) {
            hitNormal = firstIntersect.face.normal.clone();
            // Transform normal to world space using the hit object's normal matrix
            const hitObject = firstIntersect.object;
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(hitObject.matrixWorld);
            hitNormal.applyMatrix3(normalMatrix);
            hitNormal.normalize();
        }

        // Check if surface is reasonably flat (normal should point mostly upward)
        const upDot = hitNormal.dot(new THREE.Vector3(0, 1, 0));
        if (upDot < 0.7) {
            // Surface too steep (more than ~45 degrees from horizontal)
            return null;
        }

        // Check for vertical clearance above the hit point
        const requiredClearance = Math.max(objectSize.y, this.minClearanceHeight);
        const clearanceCheck = this.checkVerticalClearance(
            hitPoint.x,
            hitPoint.y,
            hitPoint.z,
            requiredClearance
        );

        if (!clearanceCheck) {
            // Not enough space above the surface
            return null;
        }

        // Determine if we hit the ground or another object
        const isGround = hitPoint.y < 5; // Simple heuristic: ground is usually low

        // Valid placement found
        return {
            position: new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z),
            normal: hitNormal.normalize(),
            onGround: isGround
        };
    }

    /**
     * Check if there's enough vertical space above a point
     *
     * @param x - X coordinate
     * @param y - Y coordinate (base of object)
     * @param z - Z coordinate
     * @param height - Required clearance height
     * @returns true if space is available, false otherwise
     */
    private checkVerticalClearance(x: number, y: number, z: number, height: number): boolean {
        // Cast ray upward from the placement point
        const rayOrigin = new THREE.Vector3(x, y + 0.01, z); // Slightly above to avoid self-intersection
        const rayDirection = new THREE.Vector3(0, 1, 0);

        this.raycaster.set(rayOrigin, rayDirection);
        this.raycaster.far = height;

        const raycastTargets = this.getRaycastableObjects();
        const intersects = this.raycaster.intersectObjects(raycastTargets, false);

        // If we hit something within the required height, there's not enough space
        if (intersects.length > 0 && intersects[0]!.distance < height) {
            return false;
        }

        return true;
    }

    /**
     * Find multiple placement attempts in a radius around the target position
     * Useful for finding alternative placements if the exact position is blocked
     *
     * @param object - The Three.js object to place
     * @param x - Target X coordinate
     * @param z - Target Z coordinate
     * @param radius - Search radius for alternative positions
     * @param attempts - Number of random positions to try
     * @returns PlacementResult or null if no valid placement found
     */
    findPlacementInRadius(
        object: THREE.Object3D,
        x: number,
        z: number,
        radius: number = 2,
        attempts: number = 8
    ): PlacementResult | null {
        // Try exact position first
        const exactPlacement = this.findPlacement(object, x, z);
        if (exactPlacement) {
            return exactPlacement;
        }

        // Try random positions in radius
        for (let i = 0; i < attempts; i++) {
            const angle = (Math.PI * 2 * i) / attempts;
            const offsetX = Math.cos(angle) * radius;
            const offsetZ = Math.sin(angle) * radius;

            const placement = this.findPlacement(object, x + offsetX, z + offsetZ);
            if (placement) {
                return placement;
            }
        }

        return null;
    }

    /**
     * Find ground height at a specific X, Z coordinate using scene raycasting.
     * Filters out foliage, grass, Gaussian splats, and other non-solid objects.
     *
     * @param x - X coordinate in world space
     * @param z - Z coordinate in world space
     * @param excludeObject - Optional object to exclude from raycasting (e.g., the object being snapped)
     * @returns Ground height Y, or null if no ground found
     */
    findGroundHeightAt(x: number, z: number, excludeObject?: THREE.Object3D): number | null {
        // Cast ray downward from high above to find surface
        const rayOrigin = new THREE.Vector3(x, this.maxRayHeight, z);
        const rayDirection = new THREE.Vector3(0, -1, 0);

        this.raycaster.set(rayOrigin, rayDirection);
        this.raycaster.far = this.maxRayHeight * 2;

        // Get all intersections with filtered scene objects
        const raycastTargets = this.getRaycastableObjects(excludeObject);
        const intersects = this.raycaster.intersectObjects(raycastTargets, false);

        if (intersects.length === 0) {
            return null;
        }

        // Return the Y coordinate of the first (topmost) intersection
        return intersects[0]!.point.y;
    }

    /**
     * Cast UPWARD from a world-space point and report whether anything
     * raycastable is overhead within `maxDistance` metres. Used by editor
     * "snap-to-ground" logic to detect when a marker sits inside a building /
     * cave / under a roof so the snap can skip and preserve the user-placed Y.
     */
    isAnythingAbove(x: number, y: number, z: number, maxDistance: number = 6, excludeObject?: THREE.Object3D): boolean {
        const origin = new THREE.Vector3(x, y, z);
        const direction = new THREE.Vector3(0, 1, 0);
        this.raycaster.set(origin, direction);
        this.raycaster.far = maxDistance;
        const targets = this.getRaycastableObjects(excludeObject);
        const hits = this.raycaster.intersectObjects(targets, false);
        return hits.length > 0;
    }

    /**
     * Get raycastable objects from scene (filters out Gaussian splats, foliage, and other non-terrain objects)
     *
     * @param excludeObject - Optional object to exclude (along with all its children)
     * @returns Array of meshes that can be used for raycasting
     */
    private getRaycastableObjects(excludeObject?: THREE.Object3D): THREE.Object3D[] {
        const raycastable: THREE.Object3D[] = [];

        this.scene.traverse((object) => {
            // Only include meshes with geometry
            if ((object as any).isMesh && (object as any).geometry) {
                // Exclude Gaussian splats and other custom objects that don't support raycasting
                const type = object.type || object.constructor.name;

                if (type.includes('Splat') || type.includes('GaussianSplat')) {
                    return;
                }

                // Exclude InstancedMesh (used for foliage/grass)
                if ((object as any).isInstancedMesh) {
                    return;
                }

                // Exclude foliage and grass objects by name
                const name = object.name.toLowerCase();
                if (name.includes('foliage') || name.includes('grass') || name.includes('billboard')) {
                    return;
                }

                // Exclude TransformControls helper objects (gizmo handles and plane)
                if (type.includes('TransformControls') ||
                    object.name === 'X' || object.name === 'Y' || object.name === 'Z' ||
                    object.name === 'XY' || object.name === 'XZ' || object.name === 'YZ' ||
                    object.name === 'XYZ' || object.name === 'XYZE') {
                    return;
                }

                // Check if object is the excludeObject or a child of it
                if (excludeObject) {
                    let current: THREE.Object3D | null = object;
                    while (current) {
                        if (current === excludeObject) {
                            return; // Skip this object - it's the excluded object or its child
                        }
                        current = current.parent;
                    }
                }

                // Exclude VoxelObject children (these are placed objects, not terrain)
                // Also exclude TransformControls gizmo children (parent hierarchy check)
                let parent = object.parent;
                let shouldExclude = false;
                while (parent) {
                    // Check for VoxelObject parents
                    if (parent.userData?.isVoxelObject ||
                        parent.name?.includes('VoxelObject') ||
                        parent.name?.includes('voxelTree') ||
                        parent.name?.includes('voxelRock')) {
                        shouldExclude = true;
                        break;
                    }
                    // Check for TransformControls gizmo parents
                    const parentType = parent.type || parent.constructor.name;
                    if (parentType.includes('TransformControls') ||
                        parent.name === '__transformControlsPivot__') {
                        shouldExclude = true;
                        break;
                    }
                    parent = parent.parent;
                }
                if (shouldExclude) {
                    return;
                }

                raycastable.push(object);
            }
        });

        return raycastable;
    }

    /**
     * Update the max ray height for raycasting
     *
     * @param height - Maximum height to cast rays from
     */
    setMaxRayHeight(height: number): void {
        this.maxRayHeight = height;
    }

    /**
     * Update the minimum clearance height requirement
     *
     * @param height - Minimum vertical space needed
     */
    setMinClearanceHeight(height: number): void {
        this.minClearanceHeight = height;
    }
}
