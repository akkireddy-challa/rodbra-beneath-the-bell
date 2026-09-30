/**
 * VoxelSplineSurface.ts
 * 
 * COMPREHENSIVE SPLINE SURFACE SYSTEM FOR VOXEL TERRAIN
 * 
 * This file contains ALL code responsible for smooth/spline terrain surfaces:
 * 1. Bicubic Catmull-Rom spline height interpolation
 * 2. Physics collider mesh generation with subdivided surfaces
 * 3. Visual mesh vertex offset calculations
 * 
 * THE PROBLEM TO SOLVE:
 * - Voxel terrain appears as 1-meter grid steps instead of smooth continuous surface
 * - Both visual mesh and physics collider should follow a C1 continuous spline
 * - The spline should interpolate between voxel heights, not just average them
 * 
 * EXPECTED BEHAVIOR:
 * - Terrain slopes should be smooth curves, not stair-steps
 * - Physics colliders should match the visual surface exactly
 * - Ski/vehicle should glide smoothly without hitting edges
 */

import type { BlockID } from 'engine/VoxelGeometry.js';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Interface for providing voxel height data.
 * VoxelWorld implements this to provide height queries.
 */
export interface VoxelHeightProvider {
    /** Get the topmost voxel Y coordinate at (vx, vz), any block type */
    getTopmostVoxelHeight(vx: number, vz: number): number;
    /** Get the topmost voxel Y coordinate at (vx, vz) for a specific block type */
    getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number;
}

/**
 * A collision box from greedy meshing.
 */
export interface CollisionBox {
    x: number;      // Local X within chunk (0-15)
    y: number;      // Local Y within chunk (0-15)
    z: number;      // Local Z within chunk (0-15)
    w: number;      // Width in voxels
    h: number;      // Height in voxels
    d: number;      // Depth in voxels
    blockType?: BlockID;  // Block type for material friction lookup
}

// ============================================================================
// SPLINE HEIGHT INTERPOLATION
// ============================================================================

/**
 * Manages smooth surface height calculations for voxel terrain.
 * Uses bicubic Catmull-Rom spline interpolation for C1 continuous surfaces.
 * 
 * CATMULL-ROM SPLINE PROPERTIES:
 * - Passes through control points (voxel heights at integer coordinates)
 * - C1 continuous (smooth first derivative / tangent)
 * - Uses 4x4 grid of samples for bicubic interpolation
 * 
 * CURRENT ISSUE: The interpolation may not be working correctly.
 * Debug by checking:
 * 1. Is enableForBlockType() called for snow?
 * 2. Does getSmoothedHeight() return different values for fractional coordinates?
 * 3. Does calculateSmoothOffset() return non-zero values?
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
        console.log(`[SplineSurface] Enabling smooth surface for block type ${blockId}`);
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
        console.log(`[SplineSurface${label ? ' ' + label : ''}] ${this.calcCount} calcs, ${this.cacheHits} cache hits (${hitRate}%), cache size: ${this.heightGridCache.size}, enabled types: ${Array.from(this.smoothBlockTypes).join(',')}`);
        this.calcCount = 0;
        this.cacheHits = 0;
    }
    
    /**
     * Catmull-Rom cubic interpolation for 4 points.
     * Returns the interpolated value at parameter t (0-1) between p1 and p2.
     * 
     * Properties:
     * - C1 continuous (continuous first derivative)
     * - Passes through p1 at t=0 and p2 at t=1
     * - Uses p0 and p3 to determine tangents
     * 
     * Formula: 0.5 * [(2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t^2 + (-p0+3*p1-3*p2+p3)*t^3]
     */
    private catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t;
        const t3 = t2 * t;
        
        // Catmull-Rom basis with tension = 0.5 (standard)
        // This formulation guarantees C1 continuity
        return 0.5 * (
            (2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        );
    }
    
    /**
     * Get the height at a voxel grid position for a specific block type.
     * Returns the voxel height or uses neighbor extrapolation if not found.
     */
    private getHeightAt(vx: number, vz: number, blockType: BlockID): number {
        if (!this.heightProvider) return 0;
        
        const height = this.heightProvider.getTopmostVoxelHeightOfType(vx, vz, blockType);
        if (height !== -Infinity) return height;
        
        // If no voxel of this type at this position, extrapolate from nearby
        // This prevents discontinuities at terrain edges
        let totalHeight = 0;
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                const h = this.heightProvider.getTopmostVoxelHeightOfType(vx + dx, vz + dz, blockType);
                if (h !== -Infinity) {
                    totalHeight += h;
                    count++;
                }
            }
        }
        return count > 0 ? totalHeight / count : 0;
    }
    
    /**
     * Bicubic Catmull-Rom spline interpolation.
     * 
     * This creates a true C1 continuous surface that:
     * - Passes through (or near) the control points
     * - Has continuous first derivatives everywhere
     * - Provides smooth tangents for physics simulation
     * 
     * HOW IT WORKS:
     * 1. Sample a 4x4 grid of voxel heights around the query point
     * 2. Interpolate 4 rows in X direction using Catmull-Rom
     * 3. Interpolate the 4 row results in Z direction using Catmull-Rom
     * 
     * @param vx Voxel X coordinate (can be fractional for sub-voxel precision)
     * @param vz Voxel Z coordinate (can be fractional for sub-voxel precision)
     * @param blockType Only consider voxels of this type
     * @returns Interpolated height value
     */
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
            // Grid layout: [-1, 0, 1, 2] in both X and Z
            // The spline interpolates between indices 1 and 2 (the center cell)
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
        } else {
            this.cacheHits++;
        }
        
        // Bicubic interpolation: first interpolate 4 rows in X, then interpolate results in Z
        // Each row has 4 heights: [h(-1), h(0), h(1), h(2)]
        // We interpolate between h(0) and h(1) using fx as the parameter
        const rowInterp: number[] = [];
        for (let row = 0; row < 4; row++) {
            const r = heights[row]!;
            // r[0] = height at dx=-1, r[1] = height at dx=0, r[2] = height at dx=1, r[3] = height at dx=2
            // Catmull-Rom interpolates between r[1] and r[2] using fx
            rowInterp.push(this.catmullRom(r[0]!, r[1]!, r[2]!, r[3]!, fx));
        }
        
        // Final interpolation in Z direction
        // rowInterp[0] = result at dz=-1, rowInterp[1] = result at dz=0, etc.
        // Catmull-Rom interpolates between rowInterp[1] and rowInterp[2] using fz
        return this.catmullRom(rowInterp[0]!, rowInterp[1]!, rowInterp[2]!, rowInterp[3]!, fz);
    }
    
    /**
     * Calculate the Y offset for a surface vertex using bicubic spline interpolation.
     * 
     * THIS IS THE KEY FUNCTION that determines vertex heights for both visual and physics meshes.
     * 
     * @param cornerVx Voxel X coordinate of the corner (can be fractional)
     * @param cornerVz Voxel Z coordinate of the corner (can be fractional)
     * @param voxelX The X coordinate of the voxel itself (for topmost check)
     * @param voxelZ The Z coordinate of the voxel itself (for topmost check)
     * @param boxTopY The top Y of the current box (in voxel coords, integer)
     * @param blockType The block type of this voxel
     * @param voxelSize Size of each voxel in world units
     * @returns The smooth Y offset to apply (in world units), or 0 if no smoothing
     */
    calculateSmoothOffset(
        cornerVx: number, 
        cornerVz: number, 
        voxelX: number,
        voxelZ: number,
        boxTopY: number,
        blockType: BlockID,
        voxelSize: number
    ): number {
        // Check if smoothing is enabled for this block type
        if (!this.heightProvider || !this.smoothBlockTypes.has(blockType)) {
            return 0;
        }
        
        // Check if this voxel is topmost at its OWN position
        // We only smooth the top surface, not buried voxels
        const voxelTopHeight = this.heightProvider.getTopmostVoxelHeight(Math.floor(voxelX), Math.floor(voxelZ));
        
        // Only smooth if this is the topmost voxel
        if (voxelTopHeight === -Infinity || boxTopY < voxelTopHeight) {
            return 0;
        }
        
        // Get bicubic spline interpolated height at this corner position
        const smoothedHeight = this.getSmoothedHeight(cornerVx, cornerVz, blockType);
        
        // Calculate offset from current voxel top to smoothed surface
        // boxTopY is the voxel Y coordinate (integer), add 1 for the top surface
        const currentTopVoxel = boxTopY + 1;  // e.g., voxel at Y=45 has top at Y=46
        const targetTopVoxel = smoothedHeight + 1;  // Spline-interpolated top
        const offset = (targetTopVoxel - currentTopVoxel) * voxelSize;
        
        return offset;
    }
    
    /**
     * Get the surface normal at a point using bicubic spline derivatives.
     * Useful for physics and rendering.
     */
    getSurfaceNormal(vx: number, vz: number, blockType: BlockID, voxelSize: number): { x: number; y: number; z: number } {
        // Compute gradient using central differences on the spline surface
        const epsilon = 0.1;  // Small step for derivative approximation
        
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

// ============================================================================
// PHYSICS COLLIDER MESH GENERATION
// ============================================================================

/**
 * Number of subdivisions per voxel for smooth physics surfaces.
 * 4 subdivisions = 5x5 grid of vertices = 32 triangles per voxel.
 * Higher values = smoother but more expensive.
 */
export const SMOOTH_PHYSICS_SUBDIVISIONS = 4;

/**
 * Build a physics trimesh from collision boxes, with smooth surface support.
 * 
 * This function generates vertex/index buffers for Rapier trimesh colliders.
 * For smooth-surface blocks, it subdivides the top surface into a grid
 * with vertices positioned according to spline interpolation.
 * 
 * @param boxes Collision boxes from greedy meshing
 * @param chunkWorldX World X coordinate of chunk origin
 * @param chunkWorldY World Y coordinate of chunk origin  
 * @param chunkWorldZ World Z coordinate of chunk origin
 * @param chunkGridX Chunk grid X coordinate (for voxel coords)
 * @param chunkGridY Chunk grid Y coordinate (for voxel coords)
 * @param chunkGridZ Chunk grid Z coordinate (for voxel coords)
 * @param voxelSize Size of each voxel in world units
 * @param smoothSurfaceManager Manager for smooth surface calculations
 * @returns Vertex and index arrays for trimesh, or null if empty
 */
export function buildSmoothPhysicsTrimesh(
    boxes: CollisionBox[],
    chunkWorldX: number,
    chunkWorldY: number,
    chunkWorldZ: number,
    chunkGridX: number,
    chunkGridY: number,
    chunkGridZ: number,
    voxelSize: number,
    smoothSurfaceManager: VoxelSmoothSurfaceManager
): { vertices: Float32Array; indices: Uint32Array } | null {
    if (boxes.length === 0) return null;
    
    const subdiv = SMOOTH_PHYSICS_SUBDIVISIONS;
    const sm = smoothSurfaceManager;
    
    // Separate smooth and non-smooth boxes
    const smoothBoxes: CollisionBox[] = [];
    const regularBoxes: CollisionBox[] = [];
    
    for (const box of boxes) {
        const bt = box.blockType;
        if (bt !== undefined && sm.isEnabledForBlockType(bt)) {
            smoothBoxes.push(box);
        } else {
            regularBoxes.push(box);
        }
    }
    
    // Calculate buffer sizes
    // Regular boxes: 8 vertices + 36 indices per box (full cube)
    // Smooth boxes: (subdiv+1)^2 vertices for top grid + 8 for sides = ~33 verts
    //               subdiv^2 * 2 * 3 indices for top + 24 for sides = ~120 indices
    const regularVertCount = regularBoxes.length * 8;
    const regularIdxCount = regularBoxes.length * 36;
    const smoothVertsPerBox = (subdiv + 1) * (subdiv + 1) + 8;
    const smoothIdxPerBox = subdiv * subdiv * 6 + 24;
    const totalVerts = regularVertCount + smoothBoxes.length * smoothVertsPerBox;
    const totalIdx = regularIdxCount + smoothBoxes.length * smoothIdxPerBox;
    
    const vertices = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(totalIdx);
    
    // Standard cube indices for regular boxes
    const boxIndices = [
        0, 2, 1, 0, 3, 2,  // -Z face
        4, 5, 6, 4, 6, 7,  // +Z face
        0, 4, 7, 0, 7, 3,  // -X face
        1, 2, 6, 1, 6, 5,  // +X face
        0, 1, 5, 0, 5, 4,  // -Y face
        3, 7, 6, 3, 6, 2   // +Y face
    ];
    
    let vIdx = 0;
    let iIdx = 0;
    
    // Build regular (non-smooth) boxes as simple cubes
    for (const box of regularBoxes) {
        const x = chunkWorldX + box.x * voxelSize;
        const y = chunkWorldY + box.y * voxelSize;
        const z = chunkWorldZ + box.z * voxelSize;
        const w = box.w * voxelSize;
        const h = box.h * voxelSize;
        const d = box.d * voxelSize;
        const baseV = vIdx / 3;
        
        // 8 vertices of a cube
        vertices[vIdx++] = x;     vertices[vIdx++] = y;     vertices[vIdx++] = z;      // 0: -X -Y -Z
        vertices[vIdx++] = x + w; vertices[vIdx++] = y;     vertices[vIdx++] = z;      // 1: +X -Y -Z
        vertices[vIdx++] = x + w; vertices[vIdx++] = y + h; vertices[vIdx++] = z;      // 2: +X +Y -Z
        vertices[vIdx++] = x;     vertices[vIdx++] = y + h; vertices[vIdx++] = z;      // 3: -X +Y -Z
        vertices[vIdx++] = x;     vertices[vIdx++] = y;     vertices[vIdx++] = z + d;  // 4: -X -Y +Z
        vertices[vIdx++] = x + w; vertices[vIdx++] = y;     vertices[vIdx++] = z + d;  // 5: +X -Y +Z
        vertices[vIdx++] = x + w; vertices[vIdx++] = y + h; vertices[vIdx++] = z + d;  // 6: +X +Y +Z
        vertices[vIdx++] = x;     vertices[vIdx++] = y + h; vertices[vIdx++] = z + d;  // 7: -X +Y +Z
        
        for (const bi of boxIndices) {
            indices[iIdx++] = baseV + bi;
        }
    }
    
    // Build smooth boxes with subdivided top surface
    for (const box of smoothBoxes) {
        const x = chunkWorldX + box.x * voxelSize;
        const y = chunkWorldY + box.y * voxelSize;
        const z = chunkWorldZ + box.z * voxelSize;
        const w = voxelSize;  // Each smooth box is 1x1 after splitting
        const h = box.h * voxelSize;
        const d = voxelSize;
        
        const bt = box.blockType!;
        const boxTopY = chunkGridY + box.y + box.h - 1;  // Voxel Y coord of top
        const centerVx = chunkGridX + box.x + 0.5;  // Center of voxel in voxel coords
        const centerVz = chunkGridZ + box.z + 0.5;
        
        const topBaseV = vIdx / 3;
        
        // Generate subdivided top surface grid
        // This creates a (subdiv+1) x (subdiv+1) grid of vertices
        for (let sz = 0; sz <= subdiv; sz++) {
            for (let sx = 0; sx <= subdiv; sx++) {
                const fx = sx / subdiv;  // 0 to 1 across the voxel
                const fz = sz / subdiv;
                
                // Sample position in voxel coordinates
                const sampleX = chunkGridX + box.x + fx;
                const sampleZ = chunkGridZ + box.z + fz;
                
                // Get smooth Y offset from spline interpolation
                const smoothY = sm.calculateSmoothOffset(
                    sampleX, sampleZ,
                    centerVx, centerVz,
                    boxTopY, bt, voxelSize
                );
                
                // DEBUG: Log first few smooth offsets
                if (smoothBoxes.indexOf(box) === 0 && sx === 0 && sz === 0) {
                    console.log(`[SplineSurface] First smooth vertex: sample(${sampleX.toFixed(2)}, ${sampleZ.toFixed(2)}) boxTopY=${boxTopY} offset=${smoothY.toFixed(3)}`);
                }
                
                vertices[vIdx++] = x + fx * w;
                vertices[vIdx++] = y + h + smoothY;  // Apply smooth offset to top surface
                vertices[vIdx++] = z + fz * d;
            }
        }
        
        // Generate triangles for the subdivided top surface
        // Each cell in the grid becomes 2 triangles
        const gridW = subdiv + 1;
        for (let gz = 0; gz < subdiv; gz++) {
            for (let gx = 0; gx < subdiv; gx++) {
                const i00 = topBaseV + gz * gridW + gx;
                const i10 = i00 + 1;
                const i01 = i00 + gridW;
                const i11 = i01 + 1;
                
                // Two triangles per grid cell
                indices[iIdx++] = i00;
                indices[iIdx++] = i01;
                indices[iIdx++] = i10;
                
                indices[iIdx++] = i10;
                indices[iIdx++] = i01;
                indices[iIdx++] = i11;
            }
        }
        
        // Add simplified side faces (4 walls connecting to base)
        // These don't need smooth interpolation
        const sideBaseV = vIdx / 3;
        
        // Bottom 4 corners
        vertices[vIdx++] = x;     vertices[vIdx++] = y; vertices[vIdx++] = z;      // 0
        vertices[vIdx++] = x + w; vertices[vIdx++] = y; vertices[vIdx++] = z;      // 1
        vertices[vIdx++] = x + w; vertices[vIdx++] = y; vertices[vIdx++] = z + d;  // 2
        vertices[vIdx++] = x;     vertices[vIdx++] = y; vertices[vIdx++] = z + d;  // 3
        
        // Top 4 corners (use the corner vertices from the subdivided grid)
        const topCorner00 = topBaseV;                           // (0,0)
        const topCorner10 = topBaseV + subdiv;                  // (subdiv,0)
        const topCorner01 = topBaseV + subdiv * gridW;          // (0,subdiv)
        const topCorner11 = topBaseV + subdiv * gridW + subdiv; // (subdiv,subdiv)
        
        // -Z face (connects bottom 0,1 to top corners at z=0)
        indices[iIdx++] = sideBaseV + 0;
        indices[iIdx++] = topCorner00;
        indices[iIdx++] = sideBaseV + 1;
        indices[iIdx++] = sideBaseV + 1;
        indices[iIdx++] = topCorner00;
        indices[iIdx++] = topCorner10;
        
        // +Z face
        indices[iIdx++] = sideBaseV + 2;
        indices[iIdx++] = topCorner11;
        indices[iIdx++] = sideBaseV + 3;
        indices[iIdx++] = sideBaseV + 3;
        indices[iIdx++] = topCorner11;
        indices[iIdx++] = topCorner01;
        
        // -X face
        indices[iIdx++] = sideBaseV + 3;
        indices[iIdx++] = topCorner01;
        indices[iIdx++] = sideBaseV + 0;
        indices[iIdx++] = sideBaseV + 0;
        indices[iIdx++] = topCorner01;
        indices[iIdx++] = topCorner00;
        
        // +X face
        indices[iIdx++] = sideBaseV + 1;
        indices[iIdx++] = topCorner10;
        indices[iIdx++] = sideBaseV + 2;
        indices[iIdx++] = sideBaseV + 2;
        indices[iIdx++] = topCorner10;
        indices[iIdx++] = topCorner11;
    }
    
    // Trim arrays to actual size used
    return {
        vertices: vertices.slice(0, vIdx),
        indices: indices.slice(0, iIdx)
    };
}

// ============================================================================
// VISUAL MESH VERTEX CALCULATION
// ============================================================================

/**
 * Calculate the smooth Y offset for a visual mesh vertex.
 * 
 * This is used when building the visual voxel mesh to offset top-surface
 * vertices according to spline interpolation.
 * 
 * @param vertexVx Vertex position in voxel X coordinates
 * @param vertexVz Vertex position in voxel Z coordinates
 * @param boxCenterVx Center of the box in voxel X coordinates
 * @param boxCenterVz Center of the box in voxel Z coordinates
 * @param boxTopY Top Y coordinate of the box (integer voxel coord)
 * @param blockType Block type ID
 * @param voxelSize Size of each voxel in world units
 * @param smoothSurfaceManager Manager for smooth surface calculations
 * @returns Y offset in world units to add to the vertex
 */
export function calculateVisualMeshSmoothOffset(
    vertexVx: number,
    vertexVz: number,
    boxCenterVx: number,
    boxCenterVz: number,
    boxTopY: number,
    blockType: BlockID,
    voxelSize: number,
    smoothSurfaceManager: VoxelSmoothSurfaceManager
): number {
    return smoothSurfaceManager.calculateSmoothOffset(
        vertexVx, vertexVz,
        boxCenterVx, boxCenterVz,
        boxTopY, blockType, voxelSize
    );
}

// ============================================================================
// DEBUG UTILITIES
// ============================================================================

/**
 * Test the spline interpolation by sampling heights across a voxel.
 * Logs the results to help diagnose smoothing issues.
 */
export function debugSplineInterpolation(
    voxelX: number,
    voxelZ: number,
    blockType: BlockID,
    smoothSurfaceManager: VoxelSmoothSurfaceManager
): void {
    console.log(`[SplineSurface] Debug sampling at voxel (${voxelX}, ${voxelZ}) type ${blockType}:`);
    
    // Sample at 5 points across the voxel
    for (let i = 0; i <= 4; i++) {
        const fx = i / 4;
        const sampleX = voxelX + fx;
        const sampleZ = voxelZ + 0.5;  // Middle of voxel in Z
        const height = smoothSurfaceManager.getSmoothedHeight(sampleX, sampleZ, blockType);
        console.log(`  x=${sampleX.toFixed(2)}: height=${height.toFixed(3)}`);
    }
    
    // Check if offsets are being calculated
    const offset1 = smoothSurfaceManager.calculateSmoothOffset(
        voxelX, voxelZ, voxelX + 0.5, voxelZ + 0.5, 45, blockType, 1.0
    );
    const offset2 = smoothSurfaceManager.calculateSmoothOffset(
        voxelX + 0.5, voxelZ + 0.5, voxelX + 0.5, voxelZ + 0.5, 45, blockType, 1.0
    );
    const offset3 = smoothSurfaceManager.calculateSmoothOffset(
        voxelX + 1, voxelZ + 1, voxelX + 0.5, voxelZ + 0.5, 45, blockType, 1.0
    );
    
    console.log(`  Offsets at boxTopY=45: corner=${offset1.toFixed(3)}, center=${offset2.toFixed(3)}, opposite=${offset3.toFixed(3)}`);
}
