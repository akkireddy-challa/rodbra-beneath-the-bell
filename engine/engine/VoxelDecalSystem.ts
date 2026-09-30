import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionMask } from 'engine/CollisionLayers.js';

/**
 * Configuration for the decal system
 */
export interface DecalSystemConfig {
    /** Maximum number of decals before recycling (default: 1000) */
    maxDecals?: number;
    /** Default decal size in world units (default: 0.075) */
    decalSize?: number;
    /** Default color when not specified (default: 0x111111 - near black) */
    defaultColor?: number;
    /** Whether decals are enabled (default: true) */
    enabled?: boolean;
    /** Physics world for edge detection raycasts */
    physicsWorld?: PhysicsWorld;
}

/**
 * Options for spawning a single decal
 */
export interface DecalOptions {
    /** Position in world space */
    position: THREE.Vector3;
    /** Surface normal (decal will face this direction) */
    normal: THREE.Vector3;
    /** Color (hex, e.g., 0xff0000 for red). If not provided, uses default */
    color?: number;
    /** Size override (default uses system default) */
    size?: number;
}

/**
 * VoxelDecalSystem - Performant decal system using instanced rendering.
 * 
 * Creates visual marks on surfaces (bullet holes, paint splatters, tire marks).
 * Uses a rolling buffer that recycles old decals for constant memory usage.
 * 
 * Features:
 * - Instanced rendering for high performance (1000+ decals with minimal draw calls)
 * - Per-decal color support
 * - Automatic orientation to surface normals
 * - Rolling buffer prevents memory growth
 * - Can be used for projectile impacts, tire marks, paint, blood, etc.
 */
/** Pending decal spawn request - processed after physics step */
interface PendingDecal {
    position: THREE.Vector3;
    normal: THREE.Vector3;
    color?: number;
    size?: number;
}

export class VoxelDecalSystem {
    /**
     * Sizes tried, as fractions of the requested one, largest first. Three
     * steps is the balance point: each costs four raycasts, and below ~40% a
     * bullet mark is too small to read anyway.
     */
    private static readonly FIT_SCALES = [1, 0.65, 0.4];

    private scene: THREE.Scene;
    private instancedMesh: THREE.InstancedMesh | null = null;
    private maxDecals: number;
    private decalSize: number;
    private defaultColor: number;
    private enabled: boolean;
    private physicsWorld: PhysicsWorld | null = null;
    
    /** Current write index in the rolling buffer */
    private currentIndex: number = 0;
    /** Total decals spawned (for tracking if buffer is full) */
    private totalSpawned: number = 0;
    
    /** Pending decals to spawn after physics step completes */
    private pendingDecals: PendingDecal[] = [];
    
    /** Reusable objects for performance */
    private readonly tempMatrix = new THREE.Matrix4();
    private readonly tempPosition = new THREE.Vector3();
    private readonly tempQuaternion = new THREE.Quaternion();
    private readonly tempScale = new THREE.Vector3();
    private readonly tempColor = new THREE.Color();
    private readonly upVector = new THREE.Vector3(0, 1, 0);
    private readonly tempVector = new THREE.Vector3();

    constructor(scene: THREE.Scene, config: DecalSystemConfig = {}) {
        this.scene = scene;
        this.maxDecals = config.maxDecals ?? 1000;
        this.decalSize = config.decalSize ?? 0.075; // 7.5cm default
        this.defaultColor = config.defaultColor ?? 0x111111;
        this.enabled = config.enabled ?? true;
        this.physicsWorld = config.physicsWorld ?? null;
        
        if (this.enabled) {
            this.initializeInstancedMesh();
        }
    }
    
    /**
     * Set the physics world for edge detection raycasts.
     * Can be called after construction if physics world wasn't available initially.
     */
    setPhysicsWorld(physicsWorld: PhysicsWorld): void {
        this.physicsWorld = physicsWorld;
    }

    /**
     * Initialize the instanced mesh for rendering all decals
     */
    private initializeInstancedMesh(): void {
        // Simple quad geometry for decals
        const geometry = new THREE.PlaneGeometry(1, 1);
        
        // Material with vertex colors for per-instance coloring
        const material = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            depthWrite: false, // Prevent z-fighting
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });
        
        // Create instanced mesh
        this.instancedMesh = new THREE.InstancedMesh(geometry, material, this.maxDecals);
        this.instancedMesh.name = 'DecalSystem';
        this.instancedMesh.frustumCulled = false; // Decals are small, culling overhead not worth it
        
        // Initialize all instances as invisible (scale 0)
        const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < this.maxDecals; i++) {
            this.instancedMesh.setMatrixAt(i, zeroMatrix);
            this.instancedMesh.setColorAt(i, this.tempColor.setHex(this.defaultColor));
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        if (this.instancedMesh.instanceColor) {
            this.instancedMesh.instanceColor.needsUpdate = true;
        }
        
        // Add to scene
        this.scene.add(this.instancedMesh);
    }

    /**
     * Spawn a decal at the given position oriented to the surface normal.
     * 
     * @param options - Decal spawn options
     * @returns The index of the spawned decal (for tracking/debugging)
     */
    spawn(options: DecalOptions): number {
        if (!this.enabled || !this.instancedMesh) {
            return -1;
        }
        
        const index = this.currentIndex;
        const size = options.size ?? this.decalSize;
        const color = options.color ?? this.defaultColor;
        
        // Calculate orientation - face the decal away from the surface
        // The decal normal should point AWAY from the surface (opposite of hit normal)
        this.tempPosition.copy(options.position);
        
        // Offset slightly from surface to prevent z-fighting (0.001m = 1mm)
        this.tempPosition.addScaledVector(options.normal, 0.001);
        
        // Create rotation to align plane with surface
        // Plane's default normal is (0, 0, 1), we want it to face options.normal
        this.tempQuaternion.setFromUnitVectors(
            this.tempVector.set(0, 0, 1),
            options.normal
        );
        
        // Add slight random rotation around the normal for variety
        const randomAngle = Math.random() * Math.PI * 2;
        const rotationAroundNormal = new THREE.Quaternion().setFromAxisAngle(options.normal, randomAngle);
        this.tempQuaternion.premultiply(rotationAroundNormal);
        
        // Set scale
        this.tempScale.set(size, size, size);
        
        // Compose matrix
        this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
        
        // Update instance
        this.instancedMesh.setMatrixAt(index, this.tempMatrix);
        this.instancedMesh.setColorAt(index, this.tempColor.setHex(color));
        
        // Mark for update
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        if (this.instancedMesh.instanceColor) {
            this.instancedMesh.instanceColor.needsUpdate = true;
        }
        
        // Advance rolling buffer
        this.currentIndex = (this.currentIndex + 1) % this.maxDecals;
        this.totalSpawned++;
        
        return index;
    }

    /**
     * Queue a decal to be spawned from a projectile hit.
     * The decal is added to a pending queue and will be spawned on the next
     * call to processPendingDecals() (which should happen after physics step).
     * 
     * This deferred spawning is necessary because edge detection uses raycasts,
     * and Rapier doesn't allow raycasting during collision event processing.
     * 
     * @param hitPoint - World position of the hit
     * @param hitNormal - Surface normal at the hit point
     * @param color - Optional color (defaults to system default)
     * @param size - Optional size override
     */
    spawnFromHit(hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, color?: number, size?: number): number {
        // Queue for deferred processing - can't raycast during collision events
        this.pendingDecals.push({
            position: hitPoint.clone(),
            normal: hitNormal.clone(),
            color,
            size
        });
        return -1; // Actual index will be determined when processed
    }
    
    /**
     * Process all pending decal spawns.
     * Call this AFTER the physics step completes, not during collision events.
     * 
     * This performs edge detection raycasts and spawns valid decals.
     */
    processPendingDecals(): void {
        for (const pending of this.pendingDecals) {
            const requested = pending.size ?? this.decalSize;
            const fitted = this.fitDecalSize(pending.position, pending.normal, requested);
            // Only a hit with no room for even the smallest mark is dropped —
            // a shot into an inside corner, or one that grazed an edge.
            if (fitted === null) continue;

            this.spawn({
                position: pending.position,
                normal: pending.normal,
                color: pending.color,
                size: fitted
            });
        }
        
        // Clear the pending queue
        this.pendingDecals = [];
    }
    
    /**
     * Largest size at which this decal still lands entirely on a surface, or
     * null if even the smallest does not.
     *
     * Voxel geometry is all edges: at 0.0625-0.125 m voxels, a 0.075 m decal
     * overhangs something most of the time. The original all-or-nothing corner
     * test therefore DISCARDED a large fraction of hits, which is why bullet
     * marks appeared only occasionally rather than on every shot. Shrinking to
     * fit keeps the mark — slightly smaller on a narrow surface, full size on a
     * flat wall — which is far better than nothing appearing at all.
     */
    private fitDecalSize(position: THREE.Vector3, normal: THREE.Vector3, requested: number): number | null {
        if (!this.physicsWorld) return requested;
        for (const scale of VoxelDecalSystem.FIT_SCALES) {
            const size = requested * scale;
            if (this.checkCornersOnSurface(position, normal, size)) return size;
        }
        // Corner rays all missed — common on voxel geometry, where the contact
        // normal is not always the true face normal and a tilted tangent plane
        // sends every corner ray past the edges. One ray through the CENTRE
        // settles whether there is actually a surface here at all; if there is,
        // a smallest-size mark is right, and dropping it is what made bullet
        // impacts appear to do nothing.
        const centerProbe = this.physicsWorld.raycast(
            position.clone().addScaledVector(normal, 0.05),
            normal.clone().negate(),
            0.15,
            CollisionMask.ALL,
        );
        const smallest = VoxelDecalSystem.FIT_SCALES[VoxelDecalSystem.FIT_SCALES.length - 1] ?? 0.4;
        return centerProbe.hasHit ? requested * smallest : null;
    }

    /**
     * Check if all 4 corners of the decal would land on a surface.
     * Uses raycasts from each corner toward the surface.
     * 
     * @returns true if all corners are on surface, false if any corner is in empty space
     */
    private checkCornersOnSurface(center: THREE.Vector3, normal: THREE.Vector3, size: number): boolean {
        if (!this.physicsWorld) return true; // No physics world, skip check
        
        const halfSize = size / 2;
        
        // Calculate two perpendicular tangent vectors on the surface plane
        // First tangent: cross product of normal with up vector (or right vector if normal is up)
        let tangent1: THREE.Vector3;
        if (Math.abs(normal.y) > 0.9) {
            // Normal is roughly vertical, use X axis as reference
            tangent1 = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
        } else {
            // Normal is not vertical, use Y axis as reference
            tangent1 = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
        }
        
        // Second tangent: cross product of normal with first tangent
        const tangent2 = new THREE.Vector3().crossVectors(normal, tangent1).normalize();
        
        // Calculate the 4 corners of the decal
        const corners = [
            new THREE.Vector3().copy(center).addScaledVector(tangent1, halfSize).addScaledVector(tangent2, halfSize),
            new THREE.Vector3().copy(center).addScaledVector(tangent1, -halfSize).addScaledVector(tangent2, halfSize),
            new THREE.Vector3().copy(center).addScaledVector(tangent1, halfSize).addScaledVector(tangent2, -halfSize),
            new THREE.Vector3().copy(center).addScaledVector(tangent1, -halfSize).addScaledVector(tangent2, -halfSize),
        ];
        
        // Raycast direction: opposite of normal (toward the surface)
        const rayDir = normal.clone().negate();
        
        // Check each corner
        for (const corner of corners) {
            // Start the ray slightly above the surface
            const rayOrigin = corner.clone().addScaledVector(normal, 0.05);
            
            // Cast a short ray toward the surface
            const result = this.physicsWorld.raycast(rayOrigin, rayDir, 0.1, CollisionMask.ALL);
            
            if (!result.hasHit) {
                // This corner doesn't hit any surface - decal would overflow
                return false;
            }
        }
        
        return true; // All corners are on a surface
    }

    /**
     * Spawn a tire mark segment.
     * Tire marks are elongated decals that follow the tire path.
     * 
     * @param position - Position of the tire contact point
     * @param direction - Direction the vehicle is moving
     * @param width - Width of the tire mark
     * @param color - Color (default: dark gray for rubber)
     */
    spawnTireMark(position: THREE.Vector3, direction: THREE.Vector3, width: number = 0.2, color: number = 0x222222): number {
        // Tire marks face up (ground normal is typically Y-up)
        const normal = this.upVector.clone();
        
        // Create elongated mark in the direction of travel
        // We'll use a slightly larger size and let the instancing handle it
        return this.spawn({
            position,
            normal,
            color,
            size: width
        });
    }

    /**
     * Clear all decals
     */
    clear(): void {
        if (!this.instancedMesh) return;
        
        const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < this.maxDecals; i++) {
            this.instancedMesh.setMatrixAt(i, zeroMatrix);
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        
        this.currentIndex = 0;
        this.totalSpawned = 0;
    }

    /**
     * Get the number of active decals
     */
    getActiveCount(): number {
        return Math.min(this.totalSpawned, this.maxDecals);
    }

    /**
     * Get the maximum number of decals
     */
    getMaxDecals(): number {
        return this.maxDecals;
    }

    /**
     * Check if the system is enabled
     */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Enable or disable the decal system
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (this.instancedMesh) {
            this.instancedMesh.visible = enabled;
        }
    }

    /**
     * Update configuration (e.g., from world.json changes)
     */
    updateConfig(config: DecalSystemConfig): void {
        if (config.enabled !== undefined) {
            this.setEnabled(config.enabled);
        }
        if (config.decalSize !== undefined) {
            this.decalSize = config.decalSize;
        }
        if (config.defaultColor !== undefined) {
            this.defaultColor = config.defaultColor;
        }
        // Note: maxDecals cannot be changed after initialization
        // (would require recreating the instanced mesh)
    }

    /**
     * Dispose of all resources
     */
    dispose(): void {
        if (this.instancedMesh) {
            this.scene.remove(this.instancedMesh);
            this.instancedMesh.geometry.dispose();
            (this.instancedMesh.material as THREE.Material).dispose();
            this.instancedMesh = null;
        }
    }
}

// Singleton instance for global access
let globalDecalSystem: VoxelDecalSystem | null = null;

/**
 * Initialize the global decal system.
 * Call this once during game initialization.
 */
export function initDecalSystem(scene: THREE.Scene, config?: DecalSystemConfig): VoxelDecalSystem {
    if (globalDecalSystem) {
        globalDecalSystem.dispose();
    }
    globalDecalSystem = new VoxelDecalSystem(scene, config);
    return globalDecalSystem;
}

/**
 * Get the global decal system instance.
 * Returns null if not initialized.
 */
export function getDecalSystem(): VoxelDecalSystem | null {
    return globalDecalSystem;
}

/**
 * Spawn a decal using the global system.
 * Convenience function for quick decal spawning.
 */
export function spawnDecal(options: DecalOptions): number {
    if (!globalDecalSystem) {
        return -1;
    }
    return globalDecalSystem.spawn(options);
}

/**
 * Spawn a decal from a hit using the global system.
 */
export function spawnDecalFromHit(hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, color?: number, size?: number): number {
    if (!globalDecalSystem) {
        return -1;
    }
    return globalDecalSystem.spawnFromHit(hitPoint, hitNormal, color, size);
}

