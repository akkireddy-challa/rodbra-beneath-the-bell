import * as THREE from 'three';
import { type ChunkKey, CHUNK_SIZE, parseChunkKey } from 'engine/VoxelGeometry.js';

export interface CullingStats {
    visibleChunks: number;
    totalChunks: number;
    culledByDistance: number;
    culledByFrustum: number;
}

export interface ChunkLike {
    collisionMesh: THREE.Object3D | null;
}

export interface CullableBounds {
    minX: number;
    minY: number;
    minZ: number;
}

export class VoxelChunkCulling {
    private cullingFrustum = new THREE.Frustum();
    private cullingMatrix = new THREE.Matrix4();
    private chunkBoundingBoxes = new Map<ChunkKey, THREE.Box3>();
    private chunkCenters = new Map<ChunkKey, THREE.Vector3>();
    private cullingEnabled: boolean = false;
    private maxRenderDistance: number = 150;
    private lastCullingStats: CullingStats = { visibleChunks: 0, totalChunks: 0, culledByDistance: 0, culledByFrustum: 0 };
    
    // Callback for when chunk visibility changes (used to update foliage/environment)
    // Key is 2D chunk key "cx,cz"
    private onChunkVisibilityChanged: ((chunkKey2D: string, visible: boolean) => void) | null = null;
    // Track previous visibility state per chunk to only fire on changes
    private chunkVisibility = new Map<ChunkKey, boolean>();
    
    constructor(
        private voxelSize: number,
        private bounds: CullableBounds | null,
        private chunksShouldBeVisible: boolean
    ) {}
    
    setOnChunkVisibilityChanged(callback: (chunkKey2D: string, visible: boolean) => void): void {
        this.onChunkVisibilityChanged = callback;
    }
    
    setCullingEnabled(enabled: boolean, chunks: Map<ChunkKey, ChunkLike>): void {
        this.cullingEnabled = enabled;
        if (!enabled) {
            for (const [, chunk] of chunks) {
                if (chunk.collisionMesh) chunk.collisionMesh.visible = this.chunksShouldBeVisible;
            }
        }
    }
    
    isCullingEnabled(): boolean { return this.cullingEnabled; }
    setMaxRenderDistance(distance: number): void { this.maxRenderDistance = distance; }
    getMaxRenderDistance(): number { return this.maxRenderDistance; }
    getCullingStats(): CullingStats { return { ...this.lastCullingStats }; }
    
    clearCache(): void {
        this.chunkBoundingBoxes.clear();
        this.chunkCenters.clear();
    }
    
    updateBounds(bounds: CullableBounds | null): void {
        this.bounds = bounds;
        this.clearCache();
    }
    
    updateVisibility(camera: THREE.Camera, chunks: Map<ChunkKey, ChunkLike>): void {
        if (!this.cullingEnabled) return;
        this.cullingMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.cullingFrustum.setFromProjectionMatrix(this.cullingMatrix);
        const cameraPos = camera.position, maxDistSq = this.maxRenderDistance * this.maxRenderDistance;
        this.lastCullingStats = { totalChunks: 0, visibleChunks: 0, culledByDistance: 0, culledByFrustum: 0 };
        
        // Track visibility changes per 2D chunk (cx,cz) - aggregate all Y layers
        const chunk2DVisibility = new Map<string, boolean>();
        
        for (const [key, chunk] of chunks) {
            if (!chunk.collisionMesh) continue;
            this.lastCullingStats.totalChunks++;
            
            let visible = false;
            let center = this.chunkCenters.get(key);
            if (!center) { center = this.computeChunkCenter(key); if (!center) continue; this.chunkCenters.set(key, center); }
            const dx = center.x - cameraPos.x, dz = center.z - cameraPos.z;
            if (dx * dx + dz * dz > maxDistSq) {
                chunk.collisionMesh.visible = false;
                this.lastCullingStats.culledByDistance++;
            } else {
                let bbox = this.chunkBoundingBoxes.get(key);
                if (!bbox) {
                    bbox = this.computeChunkBoundingBox(key);
                    if (!bbox) {
                        visible = this.chunksShouldBeVisible;
                        chunk.collisionMesh.visible = visible;
                        this.lastCullingStats.visibleChunks++;
                    } else {
                        this.chunkBoundingBoxes.set(key, bbox);
                    }
                }
                if (bbox) {
                    if (this.cullingFrustum.intersectsBox(bbox)) {
                        visible = this.chunksShouldBeVisible;
                        chunk.collisionMesh.visible = visible;
                        this.lastCullingStats.visibleChunks++;
                    } else {
                        chunk.collisionMesh.visible = false;
                        this.lastCullingStats.culledByFrustum++;
                    }
                }
            }
            
            // Track visibility per 2D chunk - any visible Y layer makes the 2D chunk visible
            const parsed = parseChunkKey(key);
            if (!parsed) continue;
            const key2D = `${parsed.cx},${parsed.cz}`;
            if (visible) chunk2DVisibility.set(key2D, true);
            else if (!chunk2DVisibility.has(key2D)) chunk2DVisibility.set(key2D, false);
        }
        
        // Fire callbacks for visibility changes
        if (this.onChunkVisibilityChanged) {
            for (const [key2D, visible] of chunk2DVisibility) {
                const prevVisible = this.chunkVisibility.get(key2D as ChunkKey);
                if (prevVisible !== visible) {
                    this.chunkVisibility.set(key2D as ChunkKey, visible);
                    this.onChunkVisibilityChanged(key2D, visible);
                }
            }
        }
    }
    
    private computeChunkCenter(key: ChunkKey): THREE.Vector3 | undefined {
        const p = parseChunkKey(key); if (!p) return undefined;
        const s = CHUNK_SIZE * this.voxelSize, ox = this.bounds?.minX ?? 0, oy = this.bounds?.minY ?? 0, oz = this.bounds?.minZ ?? 0;
        return new THREE.Vector3(ox + p.cx * s + s/2, oy + p.cy * s + s/2, oz + p.cz * s + s/2);
    }
    
    private computeChunkBoundingBox(key: ChunkKey): THREE.Box3 | undefined {
        const p = parseChunkKey(key); if (!p) return undefined;
        const s = CHUNK_SIZE * this.voxelSize, ox = this.bounds?.minX ?? 0, oy = this.bounds?.minY ?? 0, oz = this.bounds?.minZ ?? 0;
        const minX = ox + p.cx * s, minY = oy + p.cy * s, minZ = oz + p.cz * s;
        return new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(minX + s, minY + s, minZ + s));
    }
}
