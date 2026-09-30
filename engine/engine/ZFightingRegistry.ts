/**
 * ZFightingRegistry - System-wide z-fighting prevention through unique offset assignment.
 * 
 * Prevents z-fighting between overlapping geometry by assigning unique polygon offsets:
 * - Terrain: Base offset (0, 0) - rendered first, no offset needed
 * - VoxelObjects: Each gets unique negative offsets (-1,-1), (-2,-2), (-3,-3), etc.
 * - Debris: Uses vertex position offsets since merged into same mesh
 */

export interface PolygonOffset {
    factor: number;
    units: number;
}

export interface ZFightingOffsets {
    terrain: PolygonOffset;
    getObjectOffset: (objectId: string) => PolygonOffset;
    getDebrisVertexOffset: (debrisIndex: number) => number;
}

class ZFightingRegistryImpl {
    private objectOffsets: Map<string, PolygonOffset> = new Map();
    private nextObjectOffsetIndex: number = 1;
    private debrisCounter: number = 0;
    
    /** Base offset for terrain chunks - rendered at baseline depth */
    readonly terrainOffset: PolygonOffset = { factor: 0, units: 0 };
    
    /** 
     * Offset increment per object. 
     * Very small values prevent z-fighting without causing see-through artifacts.
     * Using -0.001 factor/units per object provides minimal separation.
     */
    private readonly objectOffsetIncrement: number = -0.001;
    
    /**
     * Vertex position offset for debris merged into terrain.
     * Small enough to be invisible but enough to prevent z-fighting.
     * Each debris gets 0.0001 * index meters offset along its normal.
     */
    private readonly debrisVertexOffsetIncrement: number = 0.0001;
    
    /**
     * Maximum debris offset before wrapping (prevents overflow for long sessions).
     * At 0.0001m per debris, 10000 debris = 1 meter max offset which is too visible.
     * Wrap at 100 to keep offset under 1cm.
     */
    private readonly maxDebrisIndex: number = 100;
    
    /**
     * Acquire a unique polygon offset for a VoxelObject.
     * Call this when creating a VoxelObject's material.
     * 
     * @param objectId - Unique identifier for the object (reuses existing offset if already registered)
     * @returns Polygon offset values to apply to the material
     */
    acquireObjectOffset(objectId: string): PolygonOffset {
        let offset = this.objectOffsets.get(objectId);
        if (!offset) {
            const index = this.nextObjectOffsetIndex++;
            offset = {
                factor: this.objectOffsetIncrement * index,
                units: this.objectOffsetIncrement * index
            };
            this.objectOffsets.set(objectId, offset);
        }
        return offset;
    }
    
    /**
     * Release an object's offset when the object is destroyed.
     * Note: Does NOT recycle offset indices to avoid potential conflicts during async operations.
     * 
     * @param objectId - The object identifier to release
     */
    releaseObjectOffset(objectId: string): void {
        this.objectOffsets.delete(objectId);
    }
    
    /**
     * Get the current offset for an object without acquiring a new one.
     * 
     * @param objectId - The object identifier
     * @returns The offset if registered, undefined otherwise
     */
    getObjectOffset(objectId: string): PolygonOffset | undefined {
        return this.objectOffsets.get(objectId);
    }
    
    /**
     * Acquire a vertex position offset for debris being merged into a terrain chunk.
     * Each call returns a unique offset that should be applied along the debris normal.
     * 
     * @returns Offset distance in meters to apply along the debris face normal
     */
    acquireDebrisVertexOffset(): number {
        const index = this.debrisCounter % this.maxDebrisIndex;
        this.debrisCounter++;
        return this.debrisVertexOffsetIncrement * (index + 1);
    }
    
    /**
     * Get the current debris counter value.
     * Useful for debugging or tracking debris merge operations.
     */
    getDebrisCount(): number {
        return this.debrisCounter;
    }
    
    /**
     * Reset the debris counter.
     * Call this when clearing all debris from the scene.
     */
    resetDebrisCounter(): void {
        this.debrisCounter = 0;
    }
    
    /**
     * Get debug info about current registry state.
     */
    getDebugInfo(): { objectCount: number; nextObjectIndex: number; debrisCount: number } {
        return {
            objectCount: this.objectOffsets.size,
            nextObjectIndex: this.nextObjectOffsetIndex,
            debrisCount: this.debrisCounter
        };
    }
    
    /**
     * Clear all registrations. 
     * Use when resetting the game state or during testing.
     */
    reset(): void {
        this.objectOffsets.clear();
        this.nextObjectOffsetIndex = 1;
        this.debrisCounter = 0;
    }
}

// Singleton instance
let instance: ZFightingRegistryImpl | null = null;

/**
 * Get the global z-fighting registry instance.
 */
export function getZFightingRegistry(): ZFightingRegistryImpl {
    if (!instance) {
        instance = new ZFightingRegistryImpl();
    }
    return instance;
}
