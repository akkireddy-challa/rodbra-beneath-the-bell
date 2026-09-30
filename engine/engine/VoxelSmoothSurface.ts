/**
 * VoxelSmoothSurface.ts
 * 
 * Handles smooth surface height interpolation for voxel terrain using
 * bicubic Catmull-Rom spline interpolation for true C1 continuous surfaces.
 */

import type { BlockID } from 'engine/VoxelGeometry.js';

/**
 * Interface for providing voxel height data.
 * VoxelWorld implements this to provide height queries.
 */
export interface VoxelHeightProvider {
    getTopmostVoxelHeight(vx: number, vz: number): number;
    getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number;
}

/**
 * Manages smooth surface height calculations for voxel terrain.
 * Uses bicubic Catmull-Rom spline interpolation for C1 continuous surfaces.
 */
export class VoxelSmoothSurfaceManager {
    // Height sample cache - stores 4x4 grids of heights per cell
    private heightGridCache = new Map<string, number[][]>();
    private cacheValid: boolean = true;
    
    // Block types with smooth surfaces enabled
    private smoothBlockTypes = new Set<BlockID>();
    
    // Filter distance (kept for API compatibility, affects sampling radius)
    private filterDistance: number = 2.0;
    
    // Reference to height provider
    private heightProvider: VoxelHeightProvider | null = null;
    
    // Timing stats
    private calcCount = 0;
    private cacheHits = 0;
    
    constructor(filterDistance: number = 2.0) {
        this.filterDistance = Math.max(1, filterDistance);
    }
    
    setHeightProvider(provider: VoxelHeightProvider): void {
        this.heightProvider = provider;
    }
    
    enableForBlockType(blockId: BlockID): void {
        console.log(`[SmoothSurface] enableForBlockType(${blockId}) - now enabled: [${Array.from(this.smoothBlockTypes).join(',')}] + ${blockId}`);
        this.smoothBlockTypes.add(blockId);
        this.invalidateCache();
    }
    
    disableForBlockType(blockId: BlockID): void {
        this.smoothBlockTypes.delete(blockId);
        this.invalidateCache();
    }
    
    isEnabledForBlockType(blockId: BlockID): boolean {
        return this.smoothBlockTypes.has(blockId);
    }
    
    getSmoothBlockTypes(): Set<BlockID> {
        return this.smoothBlockTypes;
    }
    
    setFilterDistance(distance: number): void {
        const newDistance = Math.max(1, distance);
        if (this.filterDistance !== newDistance) {
            this.filterDistance = newDistance;
            this.invalidateCache();
        }
    }
    
    getFilterDistance(): number {
        return this.filterDistance;
    }
    
    invalidateCache(): void {
        this.cacheValid = false;
        this.heightGridCache.clear();
    }
    
    logStats(label: string = ''): void {
        const hitRate = this.calcCount > 0 ? (this.cacheHits / this.calcCount * 100).toFixed(1) : 0;
        console.log(`[SmoothSurface${label ? ' ' + label : ''}] ${this.calcCount} calcs, ${this.cacheHits} cache hits (${hitRate}%), cache size: ${this.heightGridCache.size}`);
        this.calcCount = 0;
        this.cacheHits = 0;
    }
    
    /**
     * Uniform cubic B-spline interpolation for 4 points.
     * Returns the interpolated value at parameter t (0-1).
     * 
     * Properties:
     * - C2 continuous (continuous second derivative)
     * - Does NOT pass through control points - creates smooth approximation
     * - Averages nearby heights to eliminate stair-stepping
     * 
     * At t=0: result = (p0 + 4*p1 + p2) / 6  (weighted average, not p1)
     * At t=1: result = (p1 + 4*p2 + p3) / 6  (weighted average, not p2)
     */
    private bSpline(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t;
        const t3 = t2 * t;
        
        // Uniform cubic B-spline basis functions
        const b0 = (1 - 3*t + 3*t2 - t3) / 6;
        const b1 = (4 - 6*t2 + 3*t3) / 6;
        const b2 = (1 + 3*t + 3*t2 - 3*t3) / 6;
        const b3 = t3 / 6;
        
        return b0 * p0 + b1 * p1 + b2 * p2 + b3 * p3;
    }
    
    /**
     * Get raw voxel height at a position (no smoothing).
     */
    private getRawHeightAt(vx: number, vz: number, blockType: BlockID): number {
        if (!this.heightProvider) return 0;
        const height = this.heightProvider.getTopmostVoxelHeightOfType(vx, vz, blockType);
        return height !== -Infinity ? height : -Infinity;
    }
    
    /**
     * Get Gaussian-smoothed height at a voxel grid position.
     * Applies 5x5 Gaussian kernel to average nearby voxel heights.
     * This pre-smoothing reduces stair-stepping before B-spline interpolation.
     * 
     * Gaussian kernel (sigma ≈ 1.4):
     *   1   4   6   4   1
     *   4  16  24  16   4
     *   6  24  36  24   6   / 256
     *   4  16  24  16   4
     *   1   4   6   4   1
     */
    private getHeightAt(vx: number, vz: number, blockType: BlockID): number {
        if (!this.heightProvider) return 0;
        
        // Gaussian 5x5 kernel weights (sum = 256)
        const kernel = [
            [1,  4,  6,  4, 1],
            [4, 16, 24, 16, 4],
            [6, 24, 36, 24, 6],
            [4, 16, 24, 16, 4],
            [1,  4,  6,  4, 1]
        ];
        
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
                const h = this.getRawHeightAt(vx + dx, vz + dz, blockType);
                if (h !== -Infinity) {
                    const weight = kernel[dz + 2]![dx + 2]!;
                    weightedSum += h * weight;
                    totalWeight += weight;
                }
            }
        }
        
        if (totalWeight === 0) {
            // No valid heights found, try to extrapolate from further away
            for (let dz = -3; dz <= 3; dz++) {
                for (let dx = -3; dx <= 3; dx++) {
                    const h = this.getRawHeightAt(vx + dx, vz + dz, blockType);
                    if (h !== -Infinity) {
                        weightedSum += h;
                        totalWeight += 1;
                    }
                }
            }
        }
        
        return totalWeight > 0 ? weightedSum / totalWeight : 0;
    }
    
    /**
     * Bicubic Catmull-Rom spline interpolation.
     * 
     * This creates a true C1 continuous surface that:
     * - Passes through (or near) the control points
     * - Has continuous first derivatives everywhere
     * - Provides smooth tangents for physics simulation
     * 
     * @param vx Voxel X coordinate (can be fractional for sub-voxel precision)
     * @param vz Voxel Z coordinate (can be fractional for sub-voxel precision)
     * @param blockType Only consider voxels of this type
     * @returns Interpolated height value
     */
    // Debug: log first grid to see height samples
    private debugHeightGridLogged = false;
    
    getSmoothedHeight(vx: number, vz: number, blockType: BlockID): number {
        if (!this.heightProvider) return 0;
        this.calcCount++;
        
        // Get the integer grid cell and fractional position within it
        const ix = Math.floor(vx);
        const iz = Math.floor(vz);
        const fx = vx - ix;  // Fractional X [0, 1)
        const fz = vz - iz;  // Fractional Z [0, 1)
        
        // Cache the 4x4 HEIGHT SAMPLES (not the interpolated result) for this grid cell
        const cellCacheKey = `${ix},${iz},${blockType}`;
        let heights = this.heightGridCache.get(cellCacheKey);
        
        if (!heights || !this.cacheValid) {
            // Sample 4x4 grid of heights around the query point
            heights = [];
            for (let dz = -1; dz <= 2; dz++) {
                const row: number[] = [];
                for (let dx = -1; dx <= 2; dx++) {
                    row.push(this.getHeightAt(ix + dx, iz + dz, blockType));
                }
                heights.push(row);
            }
            this.heightGridCache.set(cellCacheKey, heights);
            this.cacheValid = true;
            
            // Debug: log first height grid
            if (!this.debugHeightGridLogged) {
                console.log(`[SmoothSurface] First 4x4 height grid at (${ix},${iz}) type ${blockType}:`);
                for (let row = 0; row < 4; row++) {
                    console.log(`  row ${row}: [${heights[row]!.map(h => h.toFixed(1)).join(', ')}]`);
                }
                this.debugHeightGridLogged = true;
            }
        } else {
            this.cacheHits++;
        }
        
        // Bicubic B-spline interpolation: first interpolate 4 rows in X, then interpolate results in Z
        // B-spline does NOT pass through control points - it creates a smooth approximation
        const rowInterp: number[] = [];
        for (let row = 0; row < 4; row++) {
            const r = heights[row]!;
            rowInterp.push(this.bSpline(r[0]!, r[1]!, r[2]!, r[3]!, fx));
        }
        
        // Final interpolation in Z direction
        return this.bSpline(rowInterp[0]!, rowInterp[1]!, rowInterp[2]!, rowInterp[3]!, fz);
    }
    
    /**
     * Calculate the Y offset for a surface vertex using bicubic spline interpolation.
     * 
     * @param cornerVx Voxel X coordinate of the corner
     * @param cornerVz Voxel Z coordinate of the corner
     * @param voxelX The X coordinate of the voxel itself (for topmost check)
     * @param voxelZ The Z coordinate of the voxel itself (for topmost check)
     * @param boxTopY The top Y of the current box (in voxel coords)
     * @param blockType The block type of this voxel
     * @param voxelSize Size of each voxel in world units
     * @returns The smooth Y offset to apply, or 0 if no smoothing
     */
    // Debug counter for logging
    private debugLogCount = 0;
    
    calculateSmoothOffset(
        cornerVx: number, 
        cornerVz: number, 
        voxelX: number,
        voxelZ: number,
        boxTopY: number,
        blockType: BlockID,
        voxelSize: number
    ): number {
        if (!this.heightProvider || !this.smoothBlockTypes.has(blockType)) {
            return 0;
        }
        
        // Check if this voxel is topmost at its OWN position
        const voxelTopHeight = this.heightProvider.getTopmostVoxelHeight(Math.floor(voxelX), Math.floor(voxelZ));
        
        // Only smooth if this is the topmost voxel
        if (voxelTopHeight === -Infinity || boxTopY < voxelTopHeight) {
            if (this.debugLogCount < 5) {
                console.log(`[SmoothSurface] Skipping non-topmost: boxTopY=${boxTopY} voxelTopHeight=${voxelTopHeight}`);
                this.debugLogCount++;
            }
            return 0;
        }
        
        // Get bicubic spline interpolated height at this corner position
        const smoothedHeight = this.getSmoothedHeight(cornerVx, cornerVz, blockType);
        
        // Calculate offset from current voxel top to smoothed surface
        const currentTopVoxel = boxTopY + 1;
        const targetTopVoxel = smoothedHeight + 1;
        const offset = (targetTopVoxel - currentTopVoxel) * voxelSize;
        
        // Debug log first few calls
        if (this.debugLogCount < 20) {
            console.log(`[SmoothSurface] corner(${cornerVx.toFixed(2)},${cornerVz.toFixed(2)}) boxTopY=${boxTopY} smoothedH=${smoothedHeight.toFixed(2)} offset=${offset.toFixed(3)}`);
            this.debugLogCount++;
        }
        
        return offset;
    }
    
    /**
     * Get the surface normal at a point using bicubic spline derivatives.
     * Useful for physics and rendering.
     */
    getSurfaceNormal(vx: number, vz: number, blockType: BlockID, voxelSize: number): { x: number; y: number; z: number } {
        // Compute gradient using central differences on the spline surface
        const epsilon = 0.1;  // Small step for derivative approximation
        
        const hCenter = this.getSmoothedHeight(vx, vz, blockType);
        const hPlusX = this.getSmoothedHeight(vx + epsilon, vz, blockType);
        const hMinusX = this.getSmoothedHeight(vx - epsilon, vz, blockType);
        const hPlusZ = this.getSmoothedHeight(vx, vz + epsilon, blockType);
        const hMinusZ = this.getSmoothedHeight(vx, vz - epsilon, blockType);
        
        // Gradient in world units
        const dhdx = (hPlusX - hMinusX) / (2 * epsilon) * voxelSize;
        const dhdz = (hPlusZ - hMinusZ) / (2 * epsilon) * voxelSize;
        
        // Normal = normalize((-dhdx, 1, -dhdz))
        const len = Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
        return {
            x: -dhdx / len,
            y: 1 / len,
            z: -dhdz / len
        };
    }
}
