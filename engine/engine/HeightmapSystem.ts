import * as THREE from 'three';
import { SeededRandom } from 'engine/SeededRandom.js';
import { isCreatorMode } from 'engine/CreatorMode.js';
import type { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

export interface HeightmapData {
    width: number;
    height: number;
    heights: Float32Array;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY: number;
    maxY: number;
}

/**
 * Configuration for heightmap terrain generation.
 *
 * AI AGENTS: Modify these values in WorldGenerator to customize terrain!
 */
export interface HeightmapConfig {
    /**
     * Noise configuration for terrain shape
     */
    noise?: {
        /** Base noise scale (default: 0.1) - smaller = smoother terrain */
        scale?: number;
        /** Height multiplier (default: 1.25) - larger = more dramatic hills */
        heightMultiplier?: number;
        /** Center depression factor (default: 0.5) - how much terrain dips toward center */
        centerDepression?: number;
    };

    /**
     * Height range limits
     */
    heightLimits?: {
        /** Minimum terrain height (default: -2) */
        min?: number;
        /** Maximum terrain height (default: 3) */
        max?: number;
    };

    /**
     * Terrain type thresholds - controls which biome appears at what height/noise
     */
    terrainThresholds?: {
        /** Height below which terrain becomes ice (default: -2) */
        iceHeight?: number;
        /** Height above which terrain becomes stone (default: 5) */
        stoneHeight?: number;
        /** Noise threshold for sand/beach areas (default: 0.7) */
        sandNoiseThreshold?: number;
        /** Noise scale for terrain type variation (default: 0.05) */
        terrainNoiseScale?: number;
    };

    /**
     * Terrain type IDs (customize if using different terrain registry)
     */
    terrainTypes?: {
        /** Ice terrain type ID (default: 4) */
        ice?: number;
        /** Stone terrain type ID (default: 7) */
        stone?: number;
        /** Sand terrain type ID (default: 2) */
        sand?: number;
        /** Grass terrain type ID (default: 1) */
        grass?: number;
    };
}

/**
 * HeightmapSystem - Manages procedural heightmap generation.
 * Implements TerrainHeightProvider for compatibility with EnvironmentObjectSystem.
 */
export class HeightmapSystem implements TerrainHeightProvider {
    private worldSizeX: number;
    private worldSizeZ: number;
    private resolution: number;
    private rng: SeededRandom;
    private heightmapData: HeightmapData | null = null;
    private terrainTypeMap: Uint8Array | null = null;
    private terrainRegistry: TerrainTypeRegistry;
    private isDirty: boolean = false;
    private config: HeightmapConfig;

    // Resolved config values (with defaults applied)
    private noiseScale: number;
    private heightMultiplier: number;
    private centerDepression: number;
    private heightMin: number;
    private heightMax: number;
    private iceHeight: number;
    private stoneHeight: number;
    private sandNoiseThreshold: number;
    private terrainNoiseScale: number;
    private terrainTypeIce: number;
    private terrainTypeStone: number;
    private terrainTypeSand: number;
    private terrainTypeGrass: number;

    constructor(
        worldSizeX: number,
        worldSizeZ: number,
        resolution: number,
        seed: number,
        terrainRegistry: TerrainTypeRegistry,
        config?: HeightmapConfig
    ) {
        this.worldSizeX = worldSizeX;
        this.worldSizeZ = worldSizeZ;
        this.resolution = resolution;
        this.rng = new SeededRandom(seed);
        this.terrainRegistry = terrainRegistry;
        this.config = config || {};

        // Apply config with defaults
        this.noiseScale = this.config.noise?.scale ?? 0.1;
        this.heightMultiplier = this.config.noise?.heightMultiplier ?? 1.25;
        this.centerDepression = this.config.noise?.centerDepression ?? 0.5;
        this.heightMin = this.config.heightLimits?.min ?? -2;
        this.heightMax = this.config.heightLimits?.max ?? 3;
        this.iceHeight = this.config.terrainThresholds?.iceHeight ?? -2;
        this.stoneHeight = this.config.terrainThresholds?.stoneHeight ?? 5;
        this.sandNoiseThreshold = this.config.terrainThresholds?.sandNoiseThreshold ?? 0.7;
        this.terrainNoiseScale = this.config.terrainThresholds?.terrainNoiseScale ?? 0.05;
        this.terrainTypeIce = this.config.terrainTypes?.ice ?? 4;
        this.terrainTypeStone = this.config.terrainTypes?.stone ?? 7;
        this.terrainTypeSand = this.config.terrainTypes?.sand ?? 2;
        this.terrainTypeGrass = this.config.terrainTypes?.grass ?? 1;
    }
    
    /**
     * Mark heightmap as dirty (modified and needs saving).
     */
    markDirty(): void {
        this.isDirty = true;
    }
    
    /**
     * Mark heightmap as clean (saved).
     */
    markClean(): void {
        this.isDirty = false;
    }
    
    /**
     * Check if heightmap is dirty (has been modified).
     */
    getDirty(): boolean {
        return this.isDirty;
    }

    /**
     * Load heightmap data from provided data structure.
     * Used when loading a saved heightmap instead of generating procedurally.
     */
    loadHeightmapData(data: HeightmapData): void {
        this.heightmapData = {
            width: data.width,
            height: data.height,
            heights: new Float32Array(data.heights),
            minX: data.minX,
            maxX: data.maxX,
            minZ: data.minZ,
            maxZ: data.maxZ,
            minY: data.minY,
            maxY: data.maxY
        };
        // Mark as clean when loading data (user hasn't edited it yet)
        this.markClean();
    }

    /**
     * Generate initial procedural heightmap.
     */
    generateHeightmap(): HeightmapData {
        const data = new Float32Array(this.resolution * this.resolution);
        const cellSizeX = this.worldSizeX / (this.resolution - 1);
        const cellSizeZ = this.worldSizeZ / (this.resolution - 1);
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;

        let minY = Infinity;
        let maxY = -Infinity;

        for (let z = 0; z < this.resolution; z++) {
            for (let x = 0; x < this.resolution; x++) {
                const worldX = (x / (this.resolution - 1)) * this.worldSizeX - halfWorldX;
                const worldZ = (z / (this.resolution - 1)) * this.worldSizeZ - halfWorldZ;
                
                let height = this.generateHeightAt(worldX, worldZ);
                
                const index = z * this.resolution + x;
                data[index] = height;
                
                if (height < minY) minY = height;
                if (height > maxY) maxY = height;
            }
        }

        this.heightmapData = {
            width: this.resolution,
            height: this.resolution,
            heights: data,
            minX: -halfWorldX,
            maxX: halfWorldX,
            minZ: -halfWorldZ,
            maxZ: halfWorldZ,
            minY,
            maxY
        };

        // Mark as clean - procedurally generated heightmaps are not dirty until user edits them
        this.markClean();

        return this.heightmapData;
    }

    private generateHeightAt(x: number, z: number): number {
        const distance = Math.sqrt(x * x + z * z);
        const noise1 = this.simplexNoise2D(x * this.noiseScale, z * this.noiseScale);
        const noise2 = this.simplexNoise2D(x * this.noiseScale * 2, z * this.noiseScale * 2) * 0.5;
        const noise3 = this.simplexNoise2D(x * this.noiseScale * 4, z * this.noiseScale * 4) * 0.25;

        let height = (noise1 + noise2 + noise3) * this.heightMultiplier;

        // Use average of world sizes for center distance calculation
        const avgWorldSize = (this.worldSizeX + this.worldSizeZ) / 2;
        const centerDistance = distance / (avgWorldSize * 0.5);
        height -= centerDistance * this.centerDepression;

        return Math.max(this.heightMin, Math.min(this.heightMax, height));
    }

    private simplexNoise2D(x: number, z: number): number {
        const n0 = this.hashNoise2D(Math.floor(x), Math.floor(z));
        const n1 = this.hashNoise2D(Math.floor(x) + 1, Math.floor(z));
        const n2 = this.hashNoise2D(Math.floor(x), Math.floor(z) + 1);
        const n3 = this.hashNoise2D(Math.floor(x) + 1, Math.floor(z) + 1);
        
        const fx = x - Math.floor(x);
        const fz = z - Math.floor(z);
        
        const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
        const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
        
        const lerp1 = n0 + u * (n1 - n0);
        const lerp2 = n2 + u * (n3 - n2);
        return lerp1 + v * (lerp2 - lerp1);
    }

    private hashNoise2D(x: number, z: number): number {
        const seed = this.rng.getSeed();
        let hash = (x * 374761393 + z * 668265263 + seed) % 982451653;
        hash = ((hash << 13) ^ hash) >>> 0;
        hash = (hash * 1274126177) % 2147483647;
        return (hash / 2147483647) * 2 - 1;
    }

    getHeightAt(x: number, z: number): number {
        if (!this.heightmapData) return 0;
        
        const { width, height, minX, maxX, minZ, maxZ, heights } = this.heightmapData;
        
        if (x < minX || x > maxX || z < minZ || z > maxZ) {
            return 0;
        }
        
        const xNormalized = (x - minX) / (maxX - minX);
        const zNormalized = (z - minZ) / (maxZ - minZ);
        
        const xFloat = xNormalized * (width - 1);
        const zFloat = zNormalized * (height - 1);
        
        const x0 = Math.floor(xFloat);
        const z0 = Math.floor(zFloat);
        const x1 = Math.min(x0 + 1, width - 1);
        const z1 = Math.min(z0 + 1, height - 1);
        
        const fx = xFloat - x0;
        const fz = zFloat - z0;
        
        const h00 = heights[z0 * width + x0] ?? 0;
        const h10 = heights[z0 * width + x1] ?? 0;
        const h01 = heights[z1 * width + x0] ?? 0;
        const h11 = heights[z1 * width + x1] ?? 0;
        
        const h0 = h00 * (1 - fx) + h10 * fx;
        const h1 = h01 * (1 - fx) + h11 * fx;
        
        return h0 * (1 - fz) + h1 * fz;
    }

    levelHeightmapAt(x: number, z: number, radius: number, targetHeight: number, flat: boolean = false): void {
        if (!this.heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ, heights } = this.heightmapData;
        const cellSizeX = (maxX - minX) / (width - 1);
        const cellSizeZ = (maxZ - minZ) / (height - 1);
        
        // Calculate which heightmap cells are affected
        const minXIdx = Math.max(0, Math.floor((x - radius - minX) / cellSizeX));
        const maxXIdx = Math.min(width - 1, Math.ceil((x + radius - minX) / cellSizeX));
        const minZIdx = Math.max(0, Math.floor((z - radius - minZ) / cellSizeZ));
        const maxZIdx = Math.min(height - 1, Math.ceil((z + radius - minZ) / cellSizeZ));
        
        for (let zIdx = minZIdx; zIdx <= maxZIdx; zIdx++) {
            for (let xIdx = minXIdx; xIdx <= maxXIdx; xIdx++) {
                // Calculate actual world coordinates for this cell
                const worldX = minX + (xIdx / (width - 1)) * (maxX - minX);
                const worldZ = minZ + (zIdx / (height - 1)) * (maxZ - minZ);
                
                const distance = Math.sqrt((worldX - x) ** 2 + (worldZ - z) ** 2);
                if (distance <= radius) {
                    const index = zIdx * width + xIdx;
                    if (flat || distance >= radius * 0.9) {
                        // Perfectly flat - set directly to target height
                        heights[index] = targetHeight;
                    } else {
                        // Smooth falloff near edges
                        const falloff = 1 - (distance / radius);
                        const currentHeight = heights[index] ?? 0;
                        heights[index] = currentHeight + (targetHeight - currentHeight) * falloff;
                    }
                }
            }
        }
        
        // Mark as dirty since heightmap was modified
        this.markDirty();
    }

    levelHeightmapRect(x: number, z: number, widthX: number, widthZ: number, targetHeight: number, flat: boolean = true): void {
        if (!this.heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ, heights } = this.heightmapData;
        const cellSizeX = (maxX - minX) / (width - 1);
        const cellSizeZ = (maxZ - minZ) / (height - 1);
        
        const halfWidthX = widthX / 2;
        const halfWidthZ = widthZ / 2;
        
        // Calculate which heightmap cells are affected
        const minXIdx = Math.max(0, Math.floor((x - halfWidthX - minX) / cellSizeX));
        const maxXIdx = Math.min(width - 1, Math.ceil((x + halfWidthX - minX) / cellSizeX));
        const minZIdx = Math.max(0, Math.floor((z - halfWidthZ - minZ) / cellSizeZ));
        const maxZIdx = Math.min(height - 1, Math.ceil((z + halfWidthZ - minZ) / cellSizeZ));
        
        for (let zIdx = minZIdx; zIdx <= maxZIdx; zIdx++) {
            for (let xIdx = minXIdx; xIdx <= maxXIdx; xIdx++) {
                // Calculate actual world coordinates for this cell
                const worldX = minX + (xIdx / (width - 1)) * (maxX - minX);
                const worldZ = minZ + (zIdx / (height - 1)) * (maxZ - minZ);
                
                // Check if within rectangular bounds
                if (Math.abs(worldX - x) <= halfWidthX && Math.abs(worldZ - z) <= halfWidthZ) {
                    const index = zIdx * width + xIdx;
                    if (flat) {
                        heights[index] = targetHeight;
                    } else {
                        // Calculate distance from center for falloff
                        const dx = Math.abs(worldX - x) / halfWidthX;
                        const dz = Math.abs(worldZ - z) / halfWidthZ;
                        const distance = Math.max(dx, dz);
                        const falloff = 1 - distance;
                        const currentHeight = heights[index] ?? 0;
                        heights[index] = currentHeight + (targetHeight - currentHeight) * falloff;
                    }
                }
            }
        }
        
        // Mark as dirty since heightmap was modified
        this.markDirty();
    }

    generateTerrainTypeMap(): Uint8Array {
        const map = new Uint8Array(this.resolution * this.resolution);
        const cellSizeX = this.worldSizeX / (this.resolution - 1);
        const cellSizeZ = this.worldSizeZ / (this.resolution - 1);
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;

        for (let z = 0; z < this.resolution; z++) {
            for (let x = 0; x < this.resolution; x++) {
                const worldX = (x / (this.resolution - 1)) * this.worldSizeX - halfWorldX;
                const worldZ = (z / (this.resolution - 1)) * this.worldSizeZ - halfWorldZ;
                
                const height = this.getHeightAt(worldX, worldZ);
                let terrainType = this.determineTerrainType(worldX, worldZ, height);
                
                const index = z * this.resolution + x;
                map[index] = terrainType;
            }
        }

        this.terrainTypeMap = map;
        return map;
    }

    private determineTerrainType(x: number, z: number, height: number): number {
        const noise = this.simplexNoise2D(x * this.terrainNoiseScale, z * this.terrainNoiseScale);

        // Determine terrain type based on height and noise
        // Foliage/environment object flags are defined in TerrainTypeRegistry properties
        if (height < this.iceHeight) {
            return this.terrainTypeIce;
        } else if (height > this.stoneHeight) {
            return this.terrainTypeStone;
        } else if (Math.abs(noise) > this.sandNoiseThreshold) {
            return this.terrainTypeSand;
        } else {
            return this.terrainTypeGrass;
        }
    }

    getTerrainTypeAt(x: number, z: number): number {
        if (!this.terrainTypeMap || !this.heightmapData) return 0;
        
        const { width, height, minX, maxX, minZ, maxZ } = this.heightmapData;
        
        if (x < minX || x > maxX || z < minZ || z > maxZ) {
            return 0;
        }
        
        const xNormalized = (x - minX) / (maxX - minX);
        const zNormalized = (z - minZ) / (maxZ - minZ);
        
        const xIdx = Math.floor(xNormalized * (width - 1));
        const zIdx = Math.floor(zNormalized * (height - 1));
        
        return this.terrainTypeMap[zIdx * width + xIdx] ?? 0;
    }

    setTerrainTypeAt(x: number, z: number, radius: number, type: number): void {
        if (!this.terrainTypeMap || !this.heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ } = this.heightmapData;
        const cellSizeX = (maxX - minX) / (width - 1);
        const cellSizeZ = (maxZ - minZ) / (height - 1);
        
        const minXIdx = Math.max(0, Math.floor((x - radius - minX) / cellSizeX));
        const maxXIdx = Math.min(width - 1, Math.ceil((x + radius - minX) / cellSizeX));
        const minZIdx = Math.max(0, Math.floor((z - radius - minZ) / cellSizeZ));
        const maxZIdx = Math.min(height - 1, Math.ceil((z + radius - minZ) / cellSizeZ));
        
        for (let zIdx = minZIdx; zIdx <= maxZIdx; zIdx++) {
            for (let xIdx = minXIdx; xIdx <= maxXIdx; xIdx++) {
                const worldX = minX + (xIdx / (width - 1)) * (maxX - minX);
                const worldZ = minZ + (zIdx / (height - 1)) * (maxZ - minZ);
                
                const distance = Math.sqrt((worldX - x) ** 2 + (worldZ - z) ** 2);
                if (distance <= radius) {
                    this.terrainTypeMap[zIdx * width + xIdx] = type;
                }
            }
        }
    }

    setTerrainTypeRect(x: number, z: number, widthX: number, widthZ: number, type: number): void {
        if (!this.terrainTypeMap || !this.heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ } = this.heightmapData;
        const cellSizeX = (maxX - minX) / (width - 1);
        const cellSizeZ = (maxZ - minZ) / (height - 1);
        
        const halfWidthX = widthX / 2;
        const halfWidthZ = widthZ / 2;
        
        const minXIdx = Math.max(0, Math.floor((x - halfWidthX - minX) / cellSizeX));
        const maxXIdx = Math.min(width - 1, Math.ceil((x + halfWidthX - minX) / cellSizeX));
        const minZIdx = Math.max(0, Math.floor((z - halfWidthZ - minZ) / cellSizeZ));
        const maxZIdx = Math.min(height - 1, Math.ceil((z + halfWidthZ - minZ) / cellSizeZ));
        
        for (let zIdx = minZIdx; zIdx <= maxZIdx; zIdx++) {
            for (let xIdx = minXIdx; xIdx <= maxXIdx; xIdx++) {
                const worldX = minX + (xIdx / (width - 1)) * (maxX - minX);
                const worldZ = minZ + (zIdx / (height - 1)) * (maxZ - minZ);
                
                if (Math.abs(worldX - x) <= halfWidthX && Math.abs(worldZ - z) <= halfWidthZ) {
                    this.terrainTypeMap[zIdx * width + xIdx] = type;
                }
            }
        }
    }

    getHeightmapData(): HeightmapData | null {
        return this.heightmapData;
    }

    getTerrainTypeMap(): Uint8Array | null {
        return this.terrainTypeMap;
    }

    ensureLevelSurfaceAt(x: number, z: number, radius: number): void {
        if (!this.heightmapData) return;
        
        const centerHeight = this.getHeightAt(x, z);
        this.levelHeightmapAt(x, z, radius, centerHeight);
    }

    /**
     * Resize the heightmap to new world dimensions.
     * Preserves existing data, fills new areas with default values (0 height, grass terrain).
     */
    resizeHeightmap(newWorldSizeX: number, newWorldSizeZ: number, newResolution: number, defaultTerrainType: number = 1): void {
        if (!this.heightmapData) {
            // If no heightmap exists, just update world size and resolution
            this.worldSizeX = newWorldSizeX;
            this.worldSizeZ = newWorldSizeZ;
            this.resolution = newResolution;
            return;
        }

        const oldData = this.heightmapData;
        const oldTerrainMap = this.terrainTypeMap;
        
        // Use the actual bounds from oldData, not calculated from size
        const oldMinX = oldData.minX;
        const oldMaxX = oldData.maxX;
        const oldMinZ = oldData.minZ;
        const oldMaxZ = oldData.maxZ;
        const newHalfX = newWorldSizeX / 2;
        const newHalfZ = newWorldSizeZ / 2;
        
        console.log(`🔄 Resizing heightmap: ${oldMaxX - oldMinX}x${oldMaxZ - oldMinZ} -> ${newWorldSizeX}x${newWorldSizeZ}, resolution: ${oldData.width}x${oldData.height} -> ${newResolution}x${newResolution}`);

        // Create new heightmap data
        const newHeights = new Float32Array(newResolution * newResolution);
        const newTerrainMap = new Uint8Array(newResolution * newResolution);
        
        const cellSizeX = newWorldSizeX / (newResolution - 1);
        const cellSizeZ = newWorldSizeZ / (newResolution - 1);

        let minY = Infinity;
        let maxY = -Infinity;

        // Helper function to sample from old heightmap data directly
        const sampleOldHeight = (worldX: number, worldZ: number): number => {
            if (worldX < oldMinX || worldX > oldMaxX || 
                worldZ < oldMinZ || worldZ > oldMaxZ) {
                return 0;
            }
            
            const xNormalized = (worldX - oldMinX) / (oldMaxX - oldMinX);
            const zNormalized = (worldZ - oldMinZ) / (oldMaxZ - oldMinZ);
            
            const xFloat = xNormalized * (oldData.width - 1);
            const zFloat = zNormalized * (oldData.height - 1);
            
            const x0 = Math.floor(xFloat);
            const z0 = Math.floor(zFloat);
            const x1 = Math.min(x0 + 1, oldData.width - 1);
            const z1 = Math.min(z0 + 1, oldData.height - 1);
            
            const fx = xFloat - x0;
            const fz = zFloat - z0;
            
            const h00 = oldData.heights[z0 * oldData.width + x0] ?? 0;
            const h10 = oldData.heights[z0 * oldData.width + x1] ?? 0;
            const h01 = oldData.heights[z1 * oldData.width + x0] ?? 0;
            const h11 = oldData.heights[z1 * oldData.width + x1] ?? 0;
            
            const h0 = h00 * (1 - fx) + h10 * fx;
            const h1 = h01 * (1 - fx) + h11 * fx;
            
            return h0 * (1 - fz) + h1 * fz;
        };
        
        const sampleOldTerrainType = (worldX: number, worldZ: number): number => {
            if (!oldTerrainMap || 
                worldX < oldMinX || worldX > oldMaxX || 
                worldZ < oldMinZ || worldZ > oldMaxZ) {
                return defaultTerrainType;
            }
            
            const xNormalized = (worldX - oldMinX) / (oldMaxX - oldMinX);
            const zNormalized = (worldZ - oldMinZ) / (oldMaxZ - oldMinZ);
            
            const xIdx = Math.floor(xNormalized * (oldData.width - 1));
            const zIdx = Math.floor(zNormalized * (oldData.height - 1));
            
            return oldTerrainMap[zIdx * oldData.width + xIdx] ?? defaultTerrainType;
        };

        let preservedCount = 0;
        let filledCount = 0;
        
        for (let z = 0; z < newResolution; z++) {
            for (let x = 0; x < newResolution; x++) {
                const worldX = (x / (newResolution - 1)) * newWorldSizeX - newHalfX;
                const worldZ = (z / (newResolution - 1)) * newWorldSizeZ - newHalfZ;
                
                const index = z * newResolution + x;
                
                // Check if this position is within old bounds
                if (worldX >= oldMinX && worldX <= oldMaxX && 
                    worldZ >= oldMinZ && worldZ <= oldMaxZ) {
                    // Sample from old heightmap data directly
                    newHeights[index] = sampleOldHeight(worldX, worldZ);
                    newTerrainMap[index] = sampleOldTerrainType(worldX, worldZ);
                    preservedCount++;
                } else {
                    // Fill with default values (flat at 0 height, grass terrain)
                    newHeights[index] = 0;
                    newTerrainMap[index] = defaultTerrainType;
                    filledCount++;
                }
                
                if (newHeights[index] < minY) minY = newHeights[index];
                if (newHeights[index] > maxY) maxY = newHeights[index];
            }
        }
        
        console.log(`✅ Heightmap resize complete: preserved ${preservedCount} cells, filled ${filledCount} cells with defaults`);

        // Update heightmap data
        this.heightmapData = {
            width: newResolution,
            height: newResolution,
            heights: newHeights,
            minX: -newHalfX,
            maxX: newHalfX,
            minZ: -newHalfZ,
            maxZ: newHalfZ,
            minY,
            maxY
        };

        this.terrainTypeMap = newTerrainMap;
        this.worldSizeX = newWorldSizeX;
        this.worldSizeZ = newWorldSizeZ;
        this.resolution = newResolution;
    }

    /**
     * Load heightmap from URL (binary format).
     * Returns null if loading fails.
     */
    static async loadHeightmapFromUrl(url: string): Promise<HeightmapData | null> {
        try {
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`Failed to load heightmap: ${response.statusText}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const buffer = new Uint8Array(arrayBuffer);
            
            // Parse binary format:
            // width (4 bytes), height (4 bytes), minX (8 bytes), maxX (8 bytes), 
            // minZ (8 bytes), maxZ (8 bytes), minY (8 bytes), maxY (8 bytes), heights (Float32Array)
            let offset = 0;
            
            const width = new DataView(buffer.buffer).getUint32(offset, true);
            offset += 4;
            const height = new DataView(buffer.buffer).getUint32(offset, true);
            offset += 4;
            const minX = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            const maxX = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            const minZ = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            const maxZ = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            const minY = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            const maxY = new DataView(buffer.buffer).getFloat64(offset, true);
            offset += 8;
            
            // Read heights array
            const heightsCount = width * height;
            const heights = new Float32Array(buffer.buffer, offset, heightsCount);
            
            return {
                width,
                height,
                heights,
                minX,
                maxX,
                minZ,
                maxZ,
                minY,
                maxY
            };
        } catch (error) {
            // Silently fail - heightmap is optional
            return null;
        }
    }

    /**
     * Load heightmap from backend API.
     * Returns null if heightmap doesn't exist or fails to load.
     */
    static async loadHeightmapFromBackend(gameId: string): Promise<HeightmapData | null> {
        try {
            // Determine API URL - use parent window's origin if in creator, otherwise use relative path
            let apiUrl: string;
            if (isCreatorMode) {
                // In creator - get AI_AGENT_URL from parent
                const parentOrigin = window.location.origin.replace(':3001', ':4111');
                apiUrl = `${parentOrigin}/api/load-heightmap?gameId=${encodeURIComponent(gameId)}`;
            } else {
                // Standalone - use relative path
                apiUrl = `/api/load-heightmap?gameId=${encodeURIComponent(gameId)}`;
            }
            
            // First check if heightmap exists using HEAD request
            const headResponse = await fetch(apiUrl, { method: 'HEAD' });
            
            if (headResponse.status === 404) {
                // Heightmap doesn't exist - this is fine, we'll generate procedurally
                return null;
            }
            
            if (!headResponse.ok) {
                // HEAD request failed - don't try GET
                return null;
            }
            
            // Heightmap exists, now load it with GET request
            const response = await fetch(apiUrl);
            
            if (!response.ok) {
                return null;
            }
            
            const result = await response.json();
            
            if (!result.success || !result.heightmapData) {
                return null;
            }
            
            return result.heightmapData;
        } catch (error) {
            // Silently fail - heightmap is optional
            return null;
        }
    }

    /**
     * Resize heightmap data to match new world dimensions.
     * - If resolution changed (polygon size changed): Uses bilinear interpolation to resample
     * - If world size changed (bounds changed): Keeps original data, fills empty areas with zero, culls excess areas
     */
    static resizeHeightmapData(
        data: HeightmapData,
        newWorldSizeX: number,
        newWorldSizeZ: number,
        newResolution: number,
        resolutionChanged: boolean
    ): HeightmapData {
        const newHeights = new Float32Array(newResolution * newResolution);
        const newHalfX = newWorldSizeX / 2;
        const newHalfZ = newWorldSizeZ / 2;
        const newMinX = -newHalfX;
        const newMaxX = newHalfX;
        const newMinZ = -newHalfZ;
        const newMaxZ = newHalfZ;
        
        const oldCellSizeX = (data.maxX - data.minX) / (data.width - 1);
        const oldCellSizeZ = (data.maxZ - data.minZ) / (data.height - 1);
        const newCellSizeX = newWorldSizeX / (newResolution - 1);
        const newCellSizeZ = newWorldSizeZ / (newResolution - 1);
        
        let newMinY = Infinity;
        let newMaxY = -Infinity;
        
        for (let z = 0; z < newResolution; z++) {
            for (let x = 0; x < newResolution; x++) {
                const worldX = (x / (newResolution - 1)) * newWorldSizeX - newHalfX;
                const worldZ = (z / (newResolution - 1)) * newWorldSizeZ - newHalfZ;
                
                let height = 0;
                
                // Check if this world position is within old bounds
                if (worldX >= data.minX && worldX <= data.maxX && worldZ >= data.minZ && worldZ <= data.maxZ) {
                    if (resolutionChanged) {
                        // Resolution changed (polygon size changed) - use bilinear interpolation to resample
                        const oldX = (worldX - data.minX) / oldCellSizeX;
                        const oldZ = (worldZ - data.minZ) / oldCellSizeZ;
                        
                        const x0 = Math.floor(oldX);
                        const x1 = Math.min(x0 + 1, data.width - 1);
                        const z0 = Math.floor(oldZ);
                        const z1 = Math.min(z0 + 1, data.height - 1);
                        
                        const fx = oldX - x0;
                        const fz = oldZ - z0;
                        
                        const h00 = data.heights[z0 * data.width + x0] ?? 0;
                        const h10 = data.heights[z0 * data.width + x1] ?? 0;
                        const h01 = data.heights[z1 * data.width + x0] ?? 0;
                        const h11 = data.heights[z1 * data.width + x1] ?? 0;
                        
                        height = h00 * (1 - fx) * (1 - fz) +
                                 h10 * fx * (1 - fz) +
                                 h01 * (1 - fx) * fz +
                                 h11 * fx * fz;
                    } else {
                        // World size changed but resolution same - sample directly without interpolation
                        // Map world coordinates to old heightmap indices
                        const oldX = (worldX - data.minX) / oldCellSizeX;
                        const oldZ = (worldZ - data.minZ) / oldCellSizeZ;
                        
                        const xIdx = Math.round(oldX);
                        const zIdx = Math.round(oldZ);
                        
                        // Clamp to valid indices
                        const clampedX = Math.max(0, Math.min(data.width - 1, xIdx));
                        const clampedZ = Math.max(0, Math.min(data.height - 1, zIdx));
                        
                        height = data.heights[clampedZ * data.width + clampedX] ?? 0;
                    }
                }
                // If outside old bounds, height remains 0 (empty area)
                
                const index = z * newResolution + x;
                newHeights[index] = height;
                
                if (height < newMinY) newMinY = height;
                if (height > newMaxY) newMaxY = height;
            }
        }
        
        return {
            width: newResolution,
            height: newResolution,
            heights: newHeights,
            minX: newMinX,
            maxX: newMaxX,
            minZ: newMinZ,
            maxZ: newMaxZ,
            minY: newMinY,
            maxY: newMaxY
        };
    }
}

