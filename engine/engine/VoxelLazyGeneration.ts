/**
 * VoxelLazyGeneration - Progressive chunk building for large voxel worlds.
 * 
 * Instead of building all chunk meshes/physics upfront (which can take 60+ seconds
 * for a 1024x1024 world), this system:
 * 1. Only builds chunks within initial radius around spawn
 * 2. Progressively builds remaining chunks as player explores
 * 3. Builds 1-2 chunks per frame to avoid frame drops
 */

// ChunkKey type is a string like "cx,cy,cz"
export type ChunkKey = string;

export interface LazyGenerationStats {
    builtChunks: number;
    pendingChunks: number;
    totalChunks: number;
}

export class VoxelLazyGeneration {
    private builtChunks = new Set<ChunkKey>();
    private pendingChunks: ChunkKey[] = [];
    private enabled: boolean = false;
    
    constructor(
        private getChunks: () => Map<ChunkKey, unknown>,
        private getVoxelSize: () => number,
        private getBounds: () => { minX: number; minZ: number } | null,
        private buildChunk: (chunkKey: ChunkKey) => void,
        private updateVisualization: (chunkKeys: Set<string>) => void
    ) {}
    
    enable(): void {
        this.enabled = true;
    }
    
    isEnabled(): boolean {
        return this.enabled;
    }
    
    markChunkBuilt(chunkKey: ChunkKey): void {
        this.builtChunks.add(chunkKey);
    }
    
    isChunkBuilt(chunkKey: ChunkKey): boolean {
        return this.builtChunks.has(chunkKey);
    }
    
    addPendingChunk(chunkKey: ChunkKey): void {
        if (!this.builtChunks.has(chunkKey)) {
            this.pendingChunks.push(chunkKey);
        }
    }
    
    /**
     * Build chunks within a radius - used for initial load.
     */
    buildChunksInRadius(centerX: number, centerZ: number, radius: number): { built: number; deferred: number } {
        const radiusSq = radius * radius;
        const chunks = this.getChunks();
        const voxelSize = this.getVoxelSize();
        const bounds = this.getBounds();
        const boundsOffsetX = bounds?.minX ?? 0;
        const boundsOffsetZ = bounds?.minZ ?? 0;
        const CHUNK_SIZE = 16;
        
        let builtCount = 0;
        let deferredCount = 0;
        const builtKeys = new Set<string>();
        
        for (const [chunkKey] of chunks.entries()) {
            const parts = chunkKey.split(',');
            if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) continue;
            const cx = parseInt(parts[0], 10);
            const cz = parseInt(parts[2], 10);
            if (isNaN(cx) || isNaN(cz)) continue;
            
            const chunkCenterX = boundsOffsetX + (cx * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const chunkCenterZ = boundsOffsetZ + (cz * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            
            const dx = chunkCenterX - centerX;
            const dz = chunkCenterZ - centerZ;
            const distSq = dx * dx + dz * dz;
            
            if (distSq <= radiusSq) {
                this.buildChunk(chunkKey);
                this.builtChunks.add(chunkKey);
                builtKeys.add(chunkKey);
                builtCount++;
            } else {
                this.pendingChunks.push(chunkKey);
                deferredCount++;
            }
        }
        
        if (builtKeys.size > 0) {
            this.updateVisualization(builtKeys);
        }
        
        return { built: builtCount, deferred: deferredCount };
    }
    
    /**
     * Build pending chunks near player position - called every frame.
     */
    buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number, buildRadius: number): number {
        if (!this.enabled || this.pendingChunks.length === 0) return 0;
        
        const voxelSize = this.getVoxelSize();
        const bounds = this.getBounds();
        const boundsOffsetX = bounds?.minX ?? 0;
        const boundsOffsetZ = bounds?.minZ ?? 0;
        const buildRadiusSq = buildRadius * buildRadius;
        const CHUNK_SIZE = 16;
        
        // Sort by distance to player (closest first)
        this.pendingChunks.sort((a, b) => {
            const partsA = a.split(',');
            const partsB = b.split(',');
            if (partsA.length !== 3 || partsB.length !== 3) return 0;
            
            const cxA = parseInt(partsA[0]!, 10), czA = parseInt(partsA[2]!, 10);
            const cxB = parseInt(partsB[0]!, 10), czB = parseInt(partsB[2]!, 10);
            
            const centerXA = boundsOffsetX + (cxA * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const centerZA = boundsOffsetZ + (czA * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const centerXB = boundsOffsetX + (cxB * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const centerZB = boundsOffsetZ + (czB * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            
            const distSqA = (centerXA - playerX) ** 2 + (centerZA - playerZ) ** 2;
            const distSqB = (centerXB - playerX) ** 2 + (centerZB - playerZ) ** 2;
            
            return distSqA - distSqB;
        });
        
        const builtKeys = new Set<string>();
        let builtCount = 0;
        
        while (builtCount < maxChunks && this.pendingChunks.length > 0) {
            const chunkKey = this.pendingChunks[0]!;
            
            if (this.builtChunks.has(chunkKey)) {
                this.pendingChunks.shift();
                continue;
            }
            
            const parts = chunkKey.split(',');
            if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
                this.pendingChunks.shift();
                continue;
            }
            
            const cx = parseInt(parts[0], 10), cz = parseInt(parts[2], 10);
            if (isNaN(cx) || isNaN(cz)) {
                this.pendingChunks.shift();
                continue;
            }
            
            const chunkCenterX = boundsOffsetX + (cx * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const chunkCenterZ = boundsOffsetZ + (cz * CHUNK_SIZE + CHUNK_SIZE / 2) * voxelSize;
            const distSq = (chunkCenterX - playerX) ** 2 + (chunkCenterZ - playerZ) ** 2;
            
            if (distSq > buildRadiusSq) {
                break; // List is sorted, no point checking further
            }
            
            this.buildChunk(chunkKey);
            this.builtChunks.add(chunkKey);
            builtKeys.add(chunkKey);
            builtCount++;
            
            this.pendingChunks.shift();
        }
        
        if (builtKeys.size > 0) {
            this.updateVisualization(builtKeys);
        }
        
        return builtCount;
    }
    
    getStats(): LazyGenerationStats {
        return {
            builtChunks: this.builtChunks.size,
            pendingChunks: this.pendingChunks.length,
            totalChunks: this.getChunks().size
        };
    }
    
    isComplete(): boolean {
        return this.pendingChunks.length === 0;
    }
}
