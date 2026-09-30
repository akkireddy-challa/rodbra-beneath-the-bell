import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

/**
 * Terrain type provider for voxel worlds.
 * 
 * Instead of storing a separate 2D terrain type map, this queries the VoxelWorld
 * directly to determine terrain type from the surface block type.
 * 
 * This is the correct approach for voxel terrain because:
 * - Block type IS terrain type (grass block = grass terrain)
 * - Voxel worlds are 3D - a 2D map can't represent caves/overhangs
 * - No duplicate data - terrain type comes from actual voxels
 * - Always accurate - changes to voxels automatically change terrain type
 */
export class VoxelTerrainTypeProvider implements TerrainHeightProvider {
    private voxelWorld: VoxelWorld | null = null;
    private blockTypeToTerrainType: Map<number, number> = new Map();
    private defaultTerrainType: number = 0;
    private terrainRegistry: TerrainTypeRegistry | null = null;
    
    /**
     * Create a VoxelTerrainTypeProvider.
     * @param terrainRegistry - Optional terrain registry for grip lookups. 
     *                          Only needed if you call registerBlockTerrainMapping()
     *                          and want automatic grip/friction values.
     */
    constructor(terrainRegistry?: TerrainTypeRegistry) {
        this.terrainRegistry = terrainRegistry ?? null;
    }
    
    /**
     * Set the VoxelWorld to query for terrain information.
     * Must be called after VoxelWorld is initialized.
     */
    setVoxelWorld(voxelWorld: VoxelWorld): void {
        this.voxelWorld = voxelWorld;
    }
    
    /**
     * Register a mapping from block type to terrain type.
     * This only sets the terrain type mapping (for foliage placement, etc.)
     * Grip is NOT set here - use atlas.setBlockGrip() directly.
     * 
     * @param blockType - Block type ID (from BlockType enum or custom)
     * @param terrainType - Terrain type ID (from TerrainTypes)
     */
    registerBlockTerrainMapping(blockType: number, terrainType: number): void {
        this.blockTypeToTerrainType.set(blockType, terrainType);
        getVoxelTextureAtlas().setBlockTerrainType(blockType, terrainType);
    }
    
    /**
     * Set the default terrain type for unmapped block types.
     */
    setDefaultTerrainType(terrainType: number): void {
        this.defaultTerrainType = terrainType;
    }
    
    /**
     * Get terrain height at world coordinates.
     * Scans from top to bottom to find the first solid block.
     */
    getHeightAt(x: number, z: number): number {
        if (!this.voxelWorld) {
            return 0;
        }
        
        const bounds = this.voxelWorld.getBounds();
        const maxY = bounds?.maxY ?? 100;
        const minY = bounds?.minY ?? -20;
        const blockSize = this.voxelWorld.getVoxelSize();
        
        // Scan from top to bottom to find the first solid block
        for (let y = maxY; y >= minY; y -= blockSize) {
            if (this.voxelWorld.getBlock(x, y, z) !== 0) {
                // Found solid block - return top of this block
                return y + blockSize;
            }
        }
        
        return minY;
    }
    
    /**
     * Get terrain type at world coordinates.
     * Queries the surface block type and maps it to terrain type.
     */
    getTerrainTypeAt(x: number, z: number): number {
        if (!this.voxelWorld) {
            return this.defaultTerrainType;
        }
        
        const bounds = this.voxelWorld.getBounds();
        const maxY = bounds?.maxY ?? 100;
        const minY = bounds?.minY ?? -20;
        const blockSize = this.voxelWorld.getVoxelSize();
        
        // Find the surface block
        for (let y = maxY; y >= minY; y -= blockSize) {
            const blockType = this.voxelWorld.getBlock(x, y, z);
            if (blockType !== 0) {
                // Map block type to terrain type
                return this.blockTypeToTerrainType.get(blockType) ?? this.defaultTerrainType;
            }
        }
        
        // No blocks found - return NONE terrain type (prevents trees/rocks/foliage in empty space)
        return 0;
    }

    /**
     * Get terrain type from block type directly (for foliage generation).
     * Returns 0 (NONE) for unmapped block types - custom blocks must explicitly
     * register their terrain mapping to get foliage.
     */
    getTerrainTypeForBlockType(blockType: number): number {
        return this.blockTypeToTerrainType.get(blockType) ?? 0;
    }
    
    /**
     * Set terrain type at coordinates - NO-OP for voxel worlds.
     */
    setTerrainTypeAt(_x: number, _z: number, _radius: number, _type: number): void {}
    
    /**
     * Set terrain type in rectangle - NO-OP for voxel worlds.
     * In voxel worlds, terrain type is determined by block type.
     * To change terrain type, change the voxel blocks instead.
     */
    setTerrainTypeRect(_x: number, _z: number, _widthX: number, _widthZ: number, _type: number): void {
        // No-op: terrain type is determined by voxel block types
    }
}

