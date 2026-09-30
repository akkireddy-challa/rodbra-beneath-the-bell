/**
 * VoxelWaterRefill - Handles water refilling after terrain destruction.
 * 
 * When terrain is destroyed adjacent to water, this system:
 * 1. Removes existing water blocks in the affected area
 * 2. Re-fills water using the same algorithm as initial world generation
 *    (fill from terrain surface up to water level)
 */

import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

export interface VoxelWorldLike {
    getBlock(x: number, y: number, z: number): number;
    setBlock(x: number, y: number, z: number, block: number): void;
    getVoxelSize(): number;
    getBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
    beginBatchUpdate(): void;
    endBatchUpdate(): void;
    triggerFluidMeshRebuild(dirtyChunkKeys: Set<string>): void;
}

export class VoxelWaterRefill {
    private voxelWorld: VoxelWorldLike;
    
    constructor(voxelWorld: VoxelWorldLike) {
        this.voxelWorld = voxelWorld;
    }
    
    /**
     * Check if removed blocks are adjacent to water and get the water surface level.
     */
    private findAdjacentWaterInfo(
        removedBlocks: Array<{ x: number; y: number; z: number; blockType: number }>
    ): { hasWater: boolean; waterSurfaceY: number; fluidBlockType: number } {
        const atlas = getVoxelTextureAtlas();
        const vs = this.voxelWorld.getVoxelSize();
        const bounds = this.voxelWorld.getBounds();
        const neighbors = [
            { dx: -vs, dy: 0, dz: 0 },
            { dx: vs, dy: 0, dz: 0 },
            { dx: 0, dy: -vs, dz: 0 },
            { dx: 0, dy: vs, dz: 0 },
            { dx: 0, dy: 0, dz: -vs },
            { dx: 0, dy: 0, dz: vs }
        ];
        
        let waterSurfaceY = -Infinity;
        let fluidBlockType = 0;
        
        for (const block of removedBlocks) {
            for (const { dx, dy, dz } of neighbors) {
                const nx = block.x + dx;
                const ny = block.y + dy;
                const nz = block.z + dz;
                const neighborBlock = this.voxelWorld.getBlock(nx, ny, nz);
                
                if (neighborBlock !== 0 && atlas.isFluidBlock(neighborBlock)) {
                    fluidBlockType = neighborBlock;
                    
                    // Find water surface Y by going up until we hit air or non-fluid
                    let surfaceY = ny;
                    for (let checkY = ny + vs; checkY < (bounds?.maxY ?? 100); checkY += vs) {
                        const aboveBlock = this.voxelWorld.getBlock(nx, checkY, nz);
                        if (aboveBlock === 0 || !atlas.isFluidBlock(aboveBlock)) {
                            surfaceY = checkY - vs;
                            break;
                        }
                        surfaceY = checkY;
                    }
                    
                    if (surfaceY > waterSurfaceY) {
                        waterSurfaceY = surfaceY;
                    }
                }
            }
        }
        
        return { hasWater: fluidBlockType !== 0, waterSurfaceY, fluidBlockType };
    }
    
    
    private getChunkKey(x: number, y: number, z: number): string {
        const vs = this.voxelWorld.getVoxelSize();
        const bounds = this.voxelWorld.getBounds();
        const bX = bounds?.minX ?? 0;
        const bY = bounds?.minY ?? 0;
        const bZ = bounds?.minZ ?? 0;
        const CHUNK_SIZE = 16;
        const vx = Math.floor((x - bX + 1e-6) / vs);
        const vy = Math.floor((y - bY + 1e-6) / vs);
        const vz = Math.floor((z - bZ + 1e-6) / vs);
        const cx = Math.floor(vx / CHUNK_SIZE);
        const cy = Math.floor(vy / CHUNK_SIZE);
        const cz = Math.floor(vz / CHUNK_SIZE);
        return `${cx},${cy},${cz}`;
    }
    
    /**
     * Refill water after terrain destruction.
     * 
     * Strategy: Simply fill water into the removed block positions that are
     * at or below the water surface level. Fast and simple.
     */
    refillWaterAfterDestruction(
        removedBlocks: Array<{ x: number; y: number; z: number; blockType: number }>
    ): void {
        const waterInfo = this.findAdjacentWaterInfo(removedBlocks);
        
        if (!waterInfo.hasWater) {
            return;
        }
        
        const waterSurfaceY = waterInfo.waterSurfaceY;
        const fluidType = waterInfo.fluidBlockType;
        const dirtyChunks = new Set<string>();
        
        this.voxelWorld.beginBatchUpdate();
        
        // Fill water into each removed block position that is at or below water surface
        for (const block of removedBlocks) {
            if (block.y <= waterSurfaceY) {
                const currentBlock = this.voxelWorld.getBlock(block.x, block.y, block.z);
                if (currentBlock === 0) {
                    this.voxelWorld.setBlock(block.x, block.y, block.z, fluidType);
                    dirtyChunks.add(this.getChunkKey(block.x, block.y, block.z));
                }
            }
        }
        
        this.voxelWorld.endBatchUpdate();
        
        if (dirtyChunks.size > 0) {
            this.voxelWorld.triggerFluidMeshRebuild(dirtyChunks);
        }
    }
}
