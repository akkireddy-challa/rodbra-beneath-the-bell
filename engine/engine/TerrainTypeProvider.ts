/**
 * Interface for terrain type queries and modifications.
 * 
 * Implemented by:
 * - HeightmapSystem (for heightmap-based terrain)
 * - TerrainTypeGrid (for voxel terrain)
 * 
 * This allows EnvironmentObjectSystem and VoxelFoliageSystem to work 
 * with both terrain systems without tight coupling.
 */
export interface TerrainTypeProvider {
    /**
     * Get terrain type at world coordinates.
     */
    getTerrainTypeAt(x: number, z: number): number;
    
    /**
     * Set terrain type at world coordinates with radius.
     */
    setTerrainTypeAt(x: number, z: number, radius: number, type: number): void;
    
    /**
     * Set terrain type in a rectangular area.
     */
    setTerrainTypeRect(x: number, z: number, widthX: number, widthZ: number, type: number): void;
}

/**
 * Extended interface that also provides height queries.
 * Used by systems that need both terrain types and heights.
 */
export interface TerrainHeightProvider extends TerrainTypeProvider {
    /**
     * Get height at world coordinates.
     */
    getHeightAt(x: number, z: number): number;
}

