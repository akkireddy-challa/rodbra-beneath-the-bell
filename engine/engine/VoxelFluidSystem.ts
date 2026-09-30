/**
 * VoxelFluidSystem - Handles rendering of transparent fluid blocks (water, lava, slime).
 * 
 * Fluid blocks are rendered separately from solid terrain with special handling:
 * - Uses atlas texture with proper transparency
 * - Two rendering modes:
 *   1. SURFACE_ONLY: Only renders top surface + sides where air exists (efficient)
 *   2. FULL_DEPTH: Renders all faces of all fluid blocks (depth transparency effect)
 */

import * as THREE from 'three';
import { getVoxelTextureAtlas, type VoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { FACE_TEMPLATES, CHUNK_SIZE } from 'engine/VoxelGeometry.js';

export enum FluidRenderMode {
    /** Only render top surface and sides where there's empty space - efficient */
    SURFACE_ONLY = 'surface_only',
    /** Render all faces of all fluid cubes - creates depth transparency effect */
    FULL_DEPTH = 'full_depth'
}

export interface FluidSystemOptions {
    renderMode?: FluidRenderMode;
    opacity?: number;
}

interface FluidChunkMesh {
    mesh: THREE.Mesh;
    chunkKey: string;
}

export class VoxelFluidSystem {
    private parentGroup: THREE.Object3D;
    private voxelWorld: VoxelWorld;
    private fluidMeshes: Map<string, FluidChunkMesh> = new Map();
    private renderMode: FluidRenderMode;
    private opacity: number;
    private material: THREE.Material | null = null;
    private visible: boolean = true;

    constructor(parentGroup: THREE.Object3D, voxelWorld: VoxelWorld, options: FluidSystemOptions = {}) {
        this.parentGroup = parentGroup;
        this.voxelWorld = voxelWorld;
        this.renderMode = options.renderMode ?? FluidRenderMode.SURFACE_ONLY;
        this.opacity = options.opacity ?? 0.6;
        
        // Auto-register callback so fluid meshes update when water blocks change
        voxelWorld.setFluidUpdateCallback((dirtyChunkKeys: Set<string>) => {
            this.updateFluidMeshes(dirtyChunkKeys);
        });
    }

    setRenderMode(mode: FluidRenderMode): void {
        if (this.renderMode !== mode) {
            this.renderMode = mode;
            this.rebuildAllFluidMeshes();
        }
    }

    setOpacity(opacity: number): void {
        this.opacity = opacity;
        if (this.material && this.material instanceof THREE.MeshLambertMaterial) {
            this.material.opacity = opacity;
            this.material.needsUpdate = true;
        }
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        for (const fm of this.fluidMeshes.values()) {
            fm.mesh.visible = visible;
        }
    }

    private createFluidMaterial(): THREE.Material {
        const atlas = getVoxelTextureAtlas();
        const mat = new THREE.MeshLambertMaterial({
            map: atlas.getTexture(),
            side: THREE.FrontSide,
            transparent: true,
            opacity: this.opacity,
            depthWrite: false,
            depthTest: true,
            alphaTest: 0.01
        });
        this.material = mat;
        return mat;
    }

    /**
     * Update fluid meshes for dirty chunks.
     * Call this after VoxelWorld updates its chunks.
     */
    updateFluidMeshes(dirtyChunkKeys?: Set<string>): void {
        const atlas = getVoxelTextureAtlas();
        const voxelSize = this.voxelWorld.getVoxelSize();
        const bounds = this.voxelWorld.getBounds();
        const boundsOffsetX = bounds?.minX ?? 0;
        const boundsOffsetY = bounds?.minY ?? 0;
        const boundsOffsetZ = bounds?.minZ ?? 0;

        // Get all chunks from voxel world
        const chunks = this.voxelWorld.getChunks();

        for (const [chunkKey, chunk] of chunks) {
            // Skip if not dirty (when dirtyChunkKeys provided)
            if (dirtyChunkKeys && !dirtyChunkKeys.has(chunkKey)) continue;

            // Remove existing mesh for this chunk
            const existing = this.fluidMeshes.get(chunkKey);
            if (existing) {
                if (existing.mesh.parent && existing.mesh.parent !== this.parentGroup) {
                    existing.mesh.parent.remove(existing.mesh);
                } else {
                    this.parentGroup.remove(existing.mesh);
                }
                existing.mesh.geometry.dispose();
                this.fluidMeshes.delete(chunkKey);
            }

            // Parse chunk coordinates from key
            const [cxStr, cyStr, czStr] = chunkKey.split(',');
            const cx = parseInt(cxStr!, 10);
            const cy = parseInt(cyStr!, 10);
            const cz = parseInt(czStr!, 10);

            // Fast-reject: if the chunk's palette contains no fluid block id at all,
            // there's nothing to find and we can skip the 4096-voxel inner scan entirely.
            // For uniform-flat worlds (no fluids in palette) this turns N×4096 reads into N×P checks
            // where P = palette.length (typically 1-3).
            const palette = (chunk as { palette?: number[] }).palette;
            if (palette) {
                let paletteHasFluid = false;
                for (let p = 0; p < palette.length; p++) {
                    const id = palette[p]!;
                    if (id !== 0 && atlas.isFluidBlock(id)) { paletteHasFluid = true; break; }
                }
                if (!paletteHasFluid) continue;
            }

            // Collect fluid blocks in this chunk
            const fluidBlocks: Array<{lx: number, ly: number, lz: number, blockType: number}> = [];
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const blockType = chunk.get(lx, ly, lz);
                        if (blockType !== 0 && atlas.isFluidBlock(blockType)) {
                            fluidBlocks.push({ lx, ly, lz, blockType });
                        }
                    }
                }
            }

            if (fluidBlocks.length === 0) continue;

            // Build geometry based on render mode
            const geometry = this.renderMode === FluidRenderMode.FULL_DEPTH
                ? this.buildFullDepthGeometry(chunk, fluidBlocks, cx, cy, cz, voxelSize, boundsOffsetX, boundsOffsetY, boundsOffsetZ, atlas)
                : this.buildSurfaceOnlyGeometry(chunk, fluidBlocks, cx, cy, cz, voxelSize, boundsOffsetX, boundsOffsetY, boundsOffsetZ, atlas);

            if (!geometry) continue;

            const mesh = new THREE.Mesh(geometry, this.material ?? this.createFluidMaterial());
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.frustumCulled = true;
            mesh.renderOrder = 2000; // Render after solid terrain
            mesh.name = `FluidChunk_${cx}_${cy}_${cz}`;
            mesh.visible = this.visible;
            mesh.position.set(0, 0, 0);

            this.parentGroup.add(mesh);
            this.fluidMeshes.set(chunkKey, { mesh, chunkKey });
        }
    }

    /**
     * SURFACE_ONLY mode: Only render top surface of water + sides where there's air.
     * A fluid block only gets a top face if there's no fluid block above it.
     * Side faces only render where there's empty space (air) adjacent.
     */
    private buildSurfaceOnlyGeometry(
        chunk: { get(x: number, y: number, z: number): number },
        fluidBlocks: Array<{lx: number, ly: number, lz: number, blockType: number}>,
        cx: number, cy: number, cz: number,
        voxelSize: number,
        boundsOffsetX: number, boundsOffsetY: number, boundsOffsetZ: number,
        atlas: VoxelTextureAtlas
    ): THREE.BufferGeometry | null {
        const positions: number[] = [];
        const uvs: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        let vertexOffset = 0;

        const chunkWorldX = boundsOffsetX + cx * CHUNK_SIZE * voxelSize;
        const chunkWorldY = boundsOffsetY + cy * CHUNK_SIZE * voxelSize;
        const chunkWorldZ = boundsOffsetZ + cz * CHUNK_SIZE * voxelSize;

        const faceTemplate = FACE_TEMPLATES;
        const faceNormals = [[0,0,-1], [0,0,1], [-1,0,0], [1,0,0], [0,-1,0], [0,1,0]];

        // Water surface is lowered by 1/8 of block height for more natural look
        const surfaceLowering = voxelSize / 8;

        for (const { lx, ly, lz, blockType } of fluidBlocks) {
            const worldX = chunkWorldX + lx * voxelSize;
            const worldY = chunkWorldY + ly * voxelSize;
            const worldZ = chunkWorldZ + lz * voxelSize;
            const centerX = worldX + voxelSize / 2;
            const centerY = worldY + voxelSize / 2;
            const centerZ = worldZ + voxelSize / 2;

            // Check if there's fluid above this block (to determine if this is a surface block)
            let blockAbove = 0;
            if (ly + 1 < CHUNK_SIZE) {
                blockAbove = chunk.get(lx, ly + 1, lz);
            } else {
                const aboveVoxelY = cy * CHUNK_SIZE + ly + 1;
                const aboveWorldY = boundsOffsetY + aboveVoxelY * voxelSize;
                blockAbove = this.voxelWorld.getBlock(
                    boundsOffsetX + (cx * CHUNK_SIZE + lx) * voxelSize,
                    aboveWorldY,
                    boundsOffsetZ + (cz * CHUNK_SIZE + lz) * voxelSize
                );
            }
            const isSurfaceBlock = blockAbove === 0 || !atlas.isFluidBlock(blockAbove);

            const neighbors = [
                { dx: 0, dy: 0, dz: -1, f: 0 }, // -Z
                { dx: 0, dy: 0, dz: 1, f: 1 },  // +Z
                { dx: -1, dy: 0, dz: 0, f: 2 }, // -X
                { dx: 1, dy: 0, dz: 0, f: 3 },  // +X
                { dx: 0, dy: -1, dz: 0, f: 4 }, // -Y (bottom)
                { dx: 0, dy: 1, dz: 0, f: 5 },  // +Y (top)
            ];

            for (const { dx, dy, dz, f } of neighbors) {
                const nx = lx + dx, ny = ly + dy, nz = lz + dz;
                
                // Get neighbor block - check across chunk boundaries using world coordinates
                let neighborBlock = 0;
                if (nx >= 0 && nx < CHUNK_SIZE && ny >= 0 && ny < CHUNK_SIZE && nz >= 0 && nz < CHUNK_SIZE) {
                    neighborBlock = chunk.get(nx, ny, nz);
                } else {
                    const neighborVoxelX = cx * CHUNK_SIZE + nx;
                    const neighborVoxelY = cy * CHUNK_SIZE + ny;
                    const neighborVoxelZ = cz * CHUNK_SIZE + nz;
                    const neighborWorldX = boundsOffsetX + neighborVoxelX * voxelSize;
                    const neighborWorldY = boundsOffsetY + neighborVoxelY * voxelSize;
                    const neighborWorldZ = boundsOffsetZ + neighborVoxelZ * voxelSize;
                    neighborBlock = this.voxelWorld.getBlock(neighborWorldX, neighborWorldY, neighborWorldZ);
                }

                const isTopFace = f === 5;
                const isSideFace = f >= 0 && f <= 3;
                const neighborIsFluid = neighborBlock !== 0 && atlas.isFluidBlock(neighborBlock);
                const neighborIsSolid = neighborBlock !== 0 && !neighborIsFluid;
                const shouldRender = isTopFace
                    ? !neighborIsFluid  // Top: show if no fluid above
                    : (!neighborIsFluid && !neighborIsSolid);  // Sides/bottom: only if air

                if (!shouldRender) continue;

                const base = f * 4;
                const fn = faceNormals[f]!;
                const faceType: 'top' | 'side' | 'bottom' = f === 5 ? 'top' : f === 4 ? 'bottom' : 'side';
                const atlasUV = atlas.getBlockUV(blockType, faceType);

                for (let v = 0; v < 4; v++) {
                    const fv = faceTemplate[base + v];
                    if (!fv) continue;
                    
                    let vertexY = centerY + (fv[1] ?? 0) * voxelSize;
                    
                    // Lower the water surface for surface blocks
                    if (isSurfaceBlock) {
                        if (isTopFace) {
                            // Top face: lower all vertices
                            vertexY -= surfaceLowering;
                        } else if (isSideFace && (fv[1] ?? 0) > 0) {
                            // Side face on surface block: lower only top vertices (y = +0.5)
                            vertexY -= surfaceLowering;
                        }
                    }
                    
                    positions.push(
                        centerX + (fv[0] ?? 0) * voxelSize,
                        vertexY,
                        centerZ + (fv[2] ?? 0) * voxelSize
                    );
                    normals.push(fn[0]!, fn[1]!, fn[2]!);
                    if (atlasUV) {
                        const uvX = v === 0 || v === 3 ? atlasUV.u0 : atlasUV.u1;
                        const uvY = v === 0 || v === 1 ? atlasUV.v0 : atlasUV.v1;
                        uvs.push(uvX, uvY);
                    }
                }
                indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
                vertexOffset += 4;
            }
        }

        if (positions.length === 0) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        if (uvs.length > 0) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        return geometry;
    }

    /**
     * FULL_DEPTH mode: Render ALL faces of ALL fluid cubes (no greedy meshing).
     * Creates depth transparency effect - water near surface is more transparent,
     * deep water accumulates opacity and appears darker.
     */
    private buildFullDepthGeometry(
        chunk: { get(x: number, y: number, z: number): number },
        fluidBlocks: Array<{lx: number, ly: number, lz: number, blockType: number}>,
        cx: number, cy: number, cz: number,
        voxelSize: number,
        boundsOffsetX: number, boundsOffsetY: number, boundsOffsetZ: number,
        atlas: VoxelTextureAtlas
    ): THREE.BufferGeometry | null {
        const positions: number[] = [];
        const uvs: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        let vertexOffset = 0;

        const chunkWorldX = boundsOffsetX + cx * CHUNK_SIZE * voxelSize;
        const chunkWorldY = boundsOffsetY + cy * CHUNK_SIZE * voxelSize;
        const chunkWorldZ = boundsOffsetZ + cz * CHUNK_SIZE * voxelSize;

        const faceTemplate = FACE_TEMPLATES;
        const faceNormals = [[0,0,-1], [0,0,1], [-1,0,0], [1,0,0], [0,-1,0], [0,1,0]];

        for (const { lx, ly, lz, blockType } of fluidBlocks) {
            const worldX = chunkWorldX + lx * voxelSize;
            const worldY = chunkWorldY + ly * voxelSize;
            const worldZ = chunkWorldZ + lz * voxelSize;
            const centerX = worldX + voxelSize / 2;
            const centerY = worldY + voxelSize / 2;
            const centerZ = worldZ + voxelSize / 2;

            // Render ALL 6 faces of every fluid block
            for (let f = 0; f < 6; f++) {
                const base = f * 4;
                const fn = faceNormals[f]!;
                const faceType: 'top' | 'side' | 'bottom' = f === 5 ? 'top' : f === 4 ? 'bottom' : 'side';
                const atlasUV = atlas.getBlockUV(blockType, faceType);

                for (let v = 0; v < 4; v++) {
                    const fv = faceTemplate[base + v];
                    if (!fv) continue;
                    positions.push(
                        centerX + (fv[0] ?? 0) * voxelSize,
                        centerY + (fv[1] ?? 0) * voxelSize,
                        centerZ + (fv[2] ?? 0) * voxelSize
                    );
                    normals.push(fn[0]!, fn[1]!, fn[2]!);
                    if (atlasUV) {
                        const uvX = v === 0 || v === 3 ? atlasUV.u0 : atlasUV.u1;
                        const uvY = v === 0 || v === 1 ? atlasUV.v0 : atlasUV.v1;
                        uvs.push(uvX, uvY);
                    }
                }
                // Use correct winding: 0,2,1 and 0,3,2 for clockwise (Three.js FrontSide)
                indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
                vertexOffset += 4;
            }
        }

        if (positions.length === 0) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        if (uvs.length > 0) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        return geometry;
    }

    private rebuildAllFluidMeshes(): void {
        // Clear all existing meshes
        for (const fm of this.fluidMeshes.values()) {
            this.parentGroup.remove(fm.mesh);
            fm.mesh.geometry.dispose();
        }
        this.fluidMeshes.clear();

        // Rebuild all
        this.updateFluidMeshes();
    }

    dispose(): void {
        for (const fm of this.fluidMeshes.values()) {
            this.parentGroup.remove(fm.mesh);
            fm.mesh.geometry.dispose();
        }
        this.fluidMeshes.clear();
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
    }
}
