import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import { HeightmapSystem, type HeightmapData } from 'engine/HeightmapSystem.js';
import { registerPhysicsBody } from 'engine/PhysicsBodyRegistry.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

// Ground chunk data structure: tracks both visual mesh and physics body together
interface GroundChunkData {
    chunkX: number;
    chunkZ: number;
    worldMinX: number;
    worldMaxX: number;
    worldMinZ: number;
    worldMaxZ: number;
    visualMesh: THREE.Mesh;
    physicsBody: RAPIER.RigidBody | null;
    physicsCollider: RAPIER.Collider | null;
}

/**
 * Configuration for terrain mesh rendering.
 *
 * AI AGENTS: Modify these values in WorldGenerator to customize terrain appearance!
 */
export interface TerrainMeshConfig {
    /**
     * Ground material properties
     */
    material?: {
        /** Roughness of the ground surface (default: 0.95) - 0 = shiny, 1 = matte */
        roughness?: number;
        /** Metalness of the ground surface (default: 0.0) - 0 = non-metal, 1 = metal */
        metalness?: number;
        /** Emissive color hex value (default: 0x000000) - makes ground glow */
        emissive?: number;
        /** Emissive intensity (default: 0.0) - how strongly ground glows */
        emissiveIntensity?: number;
    };

    /**
     * Physics properties for the ground
     */
    physics?: {
        /** Friction coefficient (default: 0.7) - higher = more grip */
        friction?: number;
        /** Restitution/bounciness (default: 0.0) - higher = more bouncy */
        restitution?: number;
    };
}

export class TerrainMeshSystem {
    private world: THREE.Object3D;
    private engine: EngineLike | null;
    private heightmapSystem: HeightmapSystem;
    private terrainRegistry: TerrainTypeRegistry;
    private resolution: number;

    private groundChunkGroup: THREE.Group | null = null;
    private colormapTexture: THREE.Texture | null = null;
    private static readonly GROUND_CHUNK_SIZE = 16; // Size of each ground chunk in meters (matches physics chunks)
    private groundChunkData: GroundChunkData[] = [];

    private groundRenderingType: 'smooth' | 'polygonal' = 'smooth';
    private groundSettings: {
        polygonSize: number;
        worldSizeX: number;
        worldSizeZ: number;
        yGranularity: number;
    };

    // Resolved config values (with defaults applied)
    private materialRoughness: number;
    private materialMetalness: number;
    private materialEmissive: number;
    private materialEmissiveIntensity: number;
    private physicsFriction: number;
    private physicsRestitution: number;

    constructor(
        world: THREE.Object3D,
        engine: EngineLike | null,
        heightmapSystem: HeightmapSystem,
        terrainRegistry: TerrainTypeRegistry,
        resolution: number,
        groundRenderingType: 'smooth' | 'polygonal',
        groundSettings: {
            polygonSize: number;
            worldSizeX: number;
            worldSizeZ: number;
            yGranularity: number;
        },
        config?: TerrainMeshConfig
    ) {
        this.world = world;
        this.engine = engine;
        this.heightmapSystem = heightmapSystem;
        this.terrainRegistry = terrainRegistry;
        this.resolution = resolution;

        // Apply config with defaults
        this.materialRoughness = config?.material?.roughness ?? 0.95;
        this.materialMetalness = config?.material?.metalness ?? 0.0;
        this.materialEmissive = config?.material?.emissive ?? 0x000000;
        this.materialEmissiveIntensity = config?.material?.emissiveIntensity ?? 0.0;
        this.physicsFriction = config?.physics?.friction ?? 0.7;
        this.physicsRestitution = config?.physics?.restitution ?? 0.0;
        this.groundRenderingType = groundRenderingType;
        this.groundSettings = groundSettings;
    }
    
    /**
     * Generate ground mesh from heightmap.
     */
    generateGroundMesh(): void {
        console.log('Step 3: Generating ground mesh with heightmap...');
        
        const heightmapData = this.heightmapSystem.getHeightmapData();
        if (!heightmapData) {
            console.error('No heightmap data available for ground mesh');
            return;
        }
        
        // Generate colormap and create chunked ground meshes
        this.generateColormap();
        
        const material = new THREE.MeshStandardMaterial({
            map: this.colormapTexture,
            roughness: this.materialRoughness,
            metalness: this.materialMetalness,
            emissive: this.materialEmissive,
            emissiveIntensity: this.materialEmissiveIntensity
        });

        // Create chunked ground meshes
        this.generateGroundChunks(material);
    }
    
    /**
     * Set ground rendering type (smooth or polygonal) and regenerate mesh.
     */
    setGroundRenderingType(renderingType: 'smooth' | 'polygonal'): void {
        if (this.groundRenderingType === renderingType) {
            return;
        }
        this.groundRenderingType = renderingType;
        this.regenerateGroundMesh();
    }
    
    /**
     * Regenerate ground mesh after heightmap modifications.
     * If chunks already exist with the same structure, updates them in place instead of recreating.
     * @param affectedChunkKeys Optional set of chunk keys (e.g., "chunkX_chunkZ") to update. If not provided, updates all chunks.
     */
    regenerateGroundMesh(affectedChunkKeys?: Set<string>): void {
        const heightmapData = this.heightmapSystem.getHeightmapData();
        if (!heightmapData) {
            console.error('No heightmap data available for ground mesh regeneration');
            return;
        }

        // Chunks must exist to regenerate
        if (!this.groundChunkGroup) {
            console.warn('Ground chunks not yet created, cannot regenerate');
            return;
        }

        // Check if we can update in place (chunks exist and structure hasn't changed)
        const canUpdateInPlace = this.groundChunkData.length > 0 && this.checkChunkStructureMatches();
        
        if (canUpdateInPlace) {
            // Update existing chunks in place (only Y coordinates change)
            this.updateGroundChunksInPlace(affectedChunkKeys);
        } else {
            // Structure changed or chunks don't exist - regenerate from scratch
            // Get material from groundChunkData
            let material: THREE.MeshStandardMaterial;
            if (this.groundChunkData.length > 0 && this.groundChunkData[0]?.visualMesh?.material) {
                material = this.groundChunkData[0].visualMesh.material as THREE.MeshStandardMaterial;
            } else {
                // Create new material if none exists
                this.generateColormap();
                material = new THREE.MeshStandardMaterial({
                    map: this.colormapTexture,
                    roughness: this.materialRoughness,
                    metalness: this.materialMetalness,
                    emissive: this.materialEmissive,
                    emissiveIntensity: this.materialEmissiveIntensity
                });
            }
            
            this.regenerateGroundChunks(material);
        }
    }
    
    /**
     * Update only visual meshes (no physics colliders) for affected chunks.
     * Used during heightmap editing to avoid OOM from recreating colliders.
     * @param affectedChunkKeys Optional set of chunk keys (e.g., "chunkX_chunkZ") to update. If not provided, updates all chunks.
     */
    updateVisualMeshesOnly(affectedChunkKeys?: Set<string>): void {
        // Determine which chunks to update
        let chunksToUpdate: GroundChunkData[];
        if (affectedChunkKeys && affectedChunkKeys.size > 0) {
            // Only update affected chunks (and their neighbors for proper normal computation)
            const chunksToUpdateSet = new Set<GroundChunkData>();
            
            // Add affected chunks
            for (const chunk of this.groundChunkData) {
                const chunkKey = `${chunk.chunkX}_${chunk.chunkZ}`;
                if (affectedChunkKeys.has(chunkKey)) {
                    chunksToUpdateSet.add(chunk);
                    
                    // Also add neighboring chunks for proper normal computation at boundaries
                    const neighbors = [
                        { x: chunk.chunkX - 1, z: chunk.chunkZ },
                        { x: chunk.chunkX + 1, z: chunk.chunkZ },
                        { x: chunk.chunkX, z: chunk.chunkZ - 1 },
                        { x: chunk.chunkX, z: chunk.chunkZ + 1 }
                    ];
                    
                    for (const neighbor of neighbors) {
                        const neighborChunk = this.groundChunkData.find(
                            c => c.chunkX === neighbor.x && c.chunkZ === neighbor.z
                        );
                        if (neighborChunk) {
                            chunksToUpdateSet.add(neighborChunk);
                        }
                    }
                }
            }
            
            chunksToUpdate = Array.from(chunksToUpdateSet);
        } else {
            // Update all chunks
            chunksToUpdate = this.groundChunkData;
        }
        
        // Update visual meshes (no physics)
        for (const chunk of chunksToUpdate) {
            this.updateChunkVertexHeights(chunk);
        }
    }
    
    /**
     * Regenerate colormap after terrain type changes.
     */
    regenerateColormap(): void {
        this.generateColormap();
        if (this.colormapTexture) {
            // Update material for all ground chunks
            this.groundChunkData.forEach((chunkData) => {
                const material = chunkData.visualMesh.material as THREE.MeshStandardMaterial;
                material.map = this.colormapTexture;
                material.needsUpdate = true;
            });
        }
        console.log('✅ Colormap regenerated');
    }
    
    /**
     * Regenerate ground mesh and colormap after terrain modifications.
     */
    regenerateTerrain(): void {
        this.regenerateGroundMesh();
        this.regenerateColormap();
    }
    
    /**
     * Add terrain feature: level heightmap, set terrain type, regenerate terrain.
     */
    addTerrainFeature(centerX: number, centerZ: number, widthX: number, widthZ: number, terrainType: number, height?: number): void {
        const targetHeight = height ?? this.heightmapSystem.getHeightAt(centerX, centerZ);
        
        // Level the heightmap
        this.heightmapSystem.levelHeightmapRect(centerX, centerZ, widthX, widthZ, targetHeight, true);
        
        // Set terrain type
        this.heightmapSystem.setTerrainTypeRect(centerX, centerZ, widthX, widthZ, terrainType);
        
        // Regenerate terrain visualization
        this.regenerateTerrain();
        
        console.log(`✅ Terrain feature added: type ${terrainType} at (${centerX}, ${centerZ}), size ${widthX}x${widthZ}`);
    }
    
    /**
     * Get ground chunk group for heightmap editor access.
     * Exposed for HeightmapEditor to find ground meshes for raycasting.
     */
    getGroundChunkGroup(): THREE.Group | null {
        return this.groundChunkGroup;
    }

    /**
     * Get ground chunk data for heightmap editor access.
     * Exposed for HeightmapEditor to find ground meshes for raycasting.
     */
    getGroundChunkData(): GroundChunkData[] {
        return this.groundChunkData;
    }
    
    /**
     * Check if chunk structure matches current settings (can update in place).
     */
    private checkChunkStructureMatches(): boolean {
        if (this.groundChunkData.length === 0) return false;

        const chunkSize = TerrainMeshSystem.GROUND_CHUNK_SIZE;
        const polygonSize = this.groundSettings.polygonSize;
        const worldSizeX = this.groundSettings.worldSizeX;
        const worldSizeZ = this.groundSettings.worldSizeZ;
        const expectedChunksX = Math.ceil(worldSizeX / chunkSize);
        const expectedChunksZ = Math.ceil(worldSizeZ / chunkSize);
        const expectedSegmentsPerChunk = Math.max(1, Math.floor(chunkSize / polygonSize));

        // Check if chunk count matches
        const maxChunkX = Math.max(...this.groundChunkData.map(c => c.chunkX));
        const maxChunkZ = Math.max(...this.groundChunkData.map(c => c.chunkZ));
        if (maxChunkX + 1 !== expectedChunksX || maxChunkZ + 1 !== expectedChunksZ) {
            return false;
        }

        // Check if first chunk's geometry matches expected segments
        const firstChunk = this.groundChunkData[0];
        if (!firstChunk?.visualMesh?.geometry) return false;
        
        const geometry = firstChunk.visualMesh.geometry as THREE.PlaneGeometry;
        const segmentsX = geometry.parameters.widthSegments || 0;
        const segmentsZ = geometry.parameters.heightSegments || 0;
        
        return segmentsX === expectedSegmentsPerChunk && segmentsZ === expectedSegmentsPerChunk;
    }
    
    /**
     * Update vertex heights for a single chunk by iterating through grid positions
     * (same way we build the mesh initially).
     */
    private updateChunkVertexHeights(chunk: GroundChunkData): void {
        const geometry = chunk.visualMesh.geometry as THREE.PlaneGeometry;
        const positions = geometry.attributes.position;
        
        if (!positions) {
            console.warn(`[updateChunkVertexHeights] No positions for chunk [${chunk.chunkX},${chunk.chunkZ}]`);
            return;
        }

        // Get segment count from geometry (same as when we built it)
        const segmentsPerChunk = geometry.parameters.widthSegments || 0;
        const vertexCountX = segmentsPerChunk + 1;
        const vertexCountZ = segmentsPerChunk + 1;
        const chunkWidth = chunk.worldMaxX - chunk.worldMinX;
        const chunkDepth = chunk.worldMaxZ - chunk.worldMinZ;
        
        // Check if geometry has been converted to polygonal (duplicated vertices)
        const expectedGridVertexCount = vertexCountX * vertexCountZ;
        const isPolygonalGeometry = positions.count > expectedGridVertexCount;
        
        if (isPolygonalGeometry) {
            // For polygonal geometry, we need to rebuild from grid heights
            // First, collect grid heights the same way we build the mesh
            const gridHeights = new Float32Array(vertexCountX * vertexCountZ);
            
            for (let gridZ = 0; gridZ < vertexCountZ; gridZ++) {
                for (let gridX = 0; gridX < vertexCountX; gridX++) {
                    const gridIndex = gridZ * vertexCountX + gridX;
                    
                    // Calculate world position exactly as we do when building
                    const worldX = chunk.worldMinX + (gridX / segmentsPerChunk) * chunkWidth;
                    const worldZ = chunk.worldMinZ + (gridZ / segmentsPerChunk) * chunkDepth;
                    
                    // Sample height from heightmap
                    let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                    if (this.groundSettings.yGranularity > 0) {
                        heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                    }
                    
                    gridHeights[gridIndex] = heightValue;
                }
            }
            
            // Update existing polygonal geometry in-place (only Y positions and normals)
            this.updatePolygonalGeometryHeights(geometry, gridHeights, vertexCountX, vertexCountZ, chunk);
        } else {
            // Standard grid geometry - update directly using grid indexing (same as building)
            for (let gridZ = 0; gridZ < vertexCountZ; gridZ++) {
                for (let gridX = 0; gridX < vertexCountX; gridX++) {
                    const index = gridZ * vertexCountX + gridX;
                    
                    // Calculate world position exactly as we do when building
                    const worldX = chunk.worldMinX + (gridX / segmentsPerChunk) * chunkWidth;
                    const worldZ = chunk.worldMinZ + (gridZ / segmentsPerChunk) * chunkDepth;
                    
                    // Sample height from heightmap
                    let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                    if (this.groundSettings.yGranularity > 0) {
                        heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                    }
                    
                    positions.setY(index, heightValue);
                }
            }
            positions.needsUpdate = true;
            
            // Recompute normals
            const tempHeightmapData: HeightmapData = {
                width: vertexCountX,
                height: vertexCountZ,
                heights: new Float32Array(vertexCountX * vertexCountZ),
                minX: chunk.worldMinX,
                maxX: chunk.worldMaxX,
                minZ: chunk.worldMinZ,
                maxZ: chunk.worldMaxZ,
                minY: 0,
                maxY: 0
            };
            
            for (let i = 0; i < positions.count; i++) {
                tempHeightmapData.heights[i] = positions.getY(i);
            }
            
            this.computeHeightmapNormals(geometry, tempHeightmapData);
        }
    }
    
    /**
     * Update existing ground chunks in place (only Y coordinates change).
     * This avoids OOM by not destroying and recreating physics bodies.
     * Updates chunks one at a time with delays to avoid creating all physics meshes at once.
     * @param affectedChunkKeys Optional set of chunk keys (e.g., "chunkX_chunkZ") to update. If not provided, updates all chunks.
     */
    private updateGroundChunksInPlace(affectedChunkKeys?: Set<string>): void {
        // Determine which chunks to update
        let chunksToUpdate: GroundChunkData[];
        if (affectedChunkKeys && affectedChunkKeys.size > 0) {
            // Only update affected chunks (and their neighbors for proper normal computation)
            const chunksToUpdateSet = new Set<GroundChunkData>();
            
            // Add affected chunks
            for (const chunk of this.groundChunkData) {
                const chunkKey = `${chunk.chunkX}_${chunk.chunkZ}`;
                if (affectedChunkKeys.has(chunkKey)) {
                    chunksToUpdateSet.add(chunk);
                    
                    // Also add neighboring chunks for proper normal computation at boundaries
                    const neighbors = [
                        { x: chunk.chunkX - 1, z: chunk.chunkZ },
                        { x: chunk.chunkX + 1, z: chunk.chunkZ },
                        { x: chunk.chunkX, z: chunk.chunkZ - 1 },
                        { x: chunk.chunkX, z: chunk.chunkZ + 1 }
                    ];
                    
                    for (const neighbor of neighbors) {
                        const neighborChunk = this.groundChunkData.find(
                            c => c.chunkX === neighbor.x && c.chunkZ === neighbor.z
                        );
                        if (neighborChunk) {
                            chunksToUpdateSet.add(neighborChunk);
                        }
                    }
                }
            }
            
            chunksToUpdate = Array.from(chunksToUpdateSet);
        } else {
            // Update all chunks
            chunksToUpdate = this.groundChunkData;
        }
        
        // Update visual meshes (no physics)
        for (const chunk of chunksToUpdate) {
            this.updateChunkVertexHeights(chunk);
        }
        
        // Now update physics colliders one at a time with delays to avoid OOM
        // Process chunks in batches to yield to browser and allow garbage collection
        let chunkIndex = 0;
        const processNextChunk = () => {
            if (chunkIndex >= chunksToUpdate.length) {
                return;
            }
            
            const chunk = chunksToUpdate[chunkIndex];
            if (chunk) {
                this.updatePhysicsChunkInPlace(chunk);
            }
            chunkIndex++;
            
            // Process next chunk after a short delay (yield to browser)
            // This prevents creating all physics meshes at once
            requestAnimationFrame(processNextChunk);
        };
        
        // Start processing physics chunks
        processNextChunk();
    }
    
    /**
     * Update physics chunk collider by recreating the collider with new heights.
     * In Rapier, we remove the old collider and create a new one on the same body.
     */
    private updatePhysicsChunkInPlace(chunk: GroundChunkData): void {
        if (!chunk.physicsBody || !this.engine || !this.engine.physicsWorld) {
            return;
        }

        const RAPIER = getRapier();

        try {
            // Remove old collider (body stays)
            if (chunk.physicsCollider) {
                this.engine.physicsWorld.removeCollider(chunk.physicsCollider);
            }
            
            // Get geometry from visual mesh to extract new heights
            const geometry = chunk.visualMesh.geometry as THREE.PlaneGeometry;
            const positions = geometry.attributes.position;
            
            if (!positions) {
                console.error(`[UpdatePhysicsChunk] Missing geometry data for chunk [${chunk.chunkX},${chunk.chunkZ}]`);
                return;
            }

            // Calculate physics segments (may be capped)
            const segmentsPerChunk = geometry.parameters.widthSegments || 0;
            const chunkSize = TerrainMeshSystem.GROUND_CHUNK_SIZE;
            const MAX_PHYSICS_GRANULARITY = 1.0;
            const maxPhysicsSegments = Math.floor(chunkSize / MAX_PHYSICS_GRANULARITY);
            const physicsSegments = Math.min(segmentsPerChunk, maxPhysicsSegments);
            const physicsResolution = physicsSegments + 1;
            const chunkWidth = chunk.worldMaxX - chunk.worldMinX;
            const chunkDepth = chunk.worldMaxZ - chunk.worldMinZ;

            // Build physics vertex positions array (in world space)
            const physicsVertices = new Float32Array(physicsResolution * physicsResolution * 3);
            let vertexIndex = 0;
            
            for (let gridZ = 0; gridZ < physicsResolution; gridZ++) {
                for (let gridX = 0; gridX < physicsResolution; gridX++) {
                    // Calculate world position for this physics vertex
                    const worldX = chunk.worldMinX + (gridX / physicsSegments) * chunkWidth;
                    const worldZ = chunk.worldMinZ + (gridZ / physicsSegments) * chunkDepth;
                    
                    // Sample height from heightmap
                    let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                    
                    // Apply Y-granularity snapping if enabled
                    if (this.groundSettings.yGranularity > 0) {
                        heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                    }
                    
                    // Store vertex position (X, Y, Z) in world space
                    physicsVertices[vertexIndex++] = worldX;
                    physicsVertices[vertexIndex++] = heightValue;
                    physicsVertices[vertexIndex++] = worldZ;
                }
            }
            
            // Build indices for triangle mesh
            const numTriangles = physicsSegments * physicsSegments * 2;
            const indices = new Uint32Array(numTriangles * 3);
            let indexPos = 0;
            
            for (let z = 0; z < physicsSegments; z++) {
                for (let x = 0; x < physicsSegments; x++) {
                    const i0 = z * physicsResolution + x;
                    const i1 = z * physicsResolution + x + 1;
                    const i2 = (z + 1) * physicsResolution + x;
                    const i3 = (z + 1) * physicsResolution + x + 1;
                    
                    // First triangle
                    indices[indexPos++] = i0;
                    indices[indexPos++] = i1;
                    indices[indexPos++] = i2;
                    
                    // Second triangle
                    indices[indexPos++] = i1;
                    indices[indexPos++] = i3;
                    indices[indexPos++] = i2;
                }
            }
            
            // Create new trimesh collider
            // FIX_INTERNAL_EDGES (144) fixes zero/bad normals at triangle edges
            const colliderDesc = RAPIER.ColliderDesc.trimesh(physicsVertices, indices, 144);
            if (!colliderDesc) {
                console.error(`[UpdatePhysicsChunk] Failed to create trimesh collider for chunk [${chunk.chunkX},${chunk.chunkZ}]`);
                return;
            }
            
            colliderDesc.setFriction(this.physicsFriction);
            colliderDesc.setRestitution(this.physicsRestitution);
            colliderDesc.setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL));
            
            // Create new collider attached to existing body
            chunk.physicsCollider = this.engine.physicsWorld.createCollider(colliderDesc, chunk.physicsBody);
            
        } catch (error) {
            console.error(`[UpdatePhysicsChunk] Error updating physics chunk [${chunk.chunkX},${chunk.chunkZ}]:`, error);
        }
    }
    
    /**
     * Generate ground mesh as chunks for better performance.
     * Now properly tracks both visual mesh and physics body together.
     */
    private generateGroundChunks(material: THREE.MeshStandardMaterial): void {
        const chunkSize = TerrainMeshSystem.GROUND_CHUNK_SIZE; // 16x16 meters
        const worldSizeX = this.groundSettings.worldSizeX;
        const worldSizeZ = this.groundSettings.worldSizeZ;
        const polygonSize = this.groundSettings.polygonSize;
        
        const halfWorldX = worldSizeX / 2;
        const halfWorldZ = worldSizeZ / 2;
        
        // Calculate number of chunks needed
        const chunksX = Math.ceil(worldSizeX / chunkSize);
        const chunksZ = Math.ceil(worldSizeZ / chunkSize);
        
        // Create a group to hold all chunks
        if (!this.groundChunkGroup) {
            this.groundChunkGroup = new THREE.Group();
            this.groundChunkGroup.name = 'GroundChunks';
            this.world.add(this.groundChunkGroup);
        }
        
        // Clear existing chunk data (but only if not already cleared)
        // This prevents double-clearing when called from regenerateGroundChunks
        if (this.groundChunkData.length > 0) {
            this.clearAllGroundChunks();
        }
        
        // Clear arrays (but don't clear groundChunkGroup - we reuse it)
        this.groundChunkData = [];
        
        // Calculate segments per chunk based on polygon size
        const segmentsPerChunk = Math.max(1, Math.floor(chunkSize / polygonSize));
        const verticesPerChunk = segmentsPerChunk + 1;
        const trianglesPerChunk = segmentsPerChunk * segmentsPerChunk * 2;
        
        // Debug: verify polygon size is being used correctly
        console.log(`🔍 generateGroundChunks: polygonSize=${polygonSize}m, chunkSize=${chunkSize}m, segmentsPerChunk=${segmentsPerChunk}, verticesPerChunk=${verticesPerChunk}x${verticesPerChunk}`);
        
        for (let chunkZ = 0; chunkZ < chunksZ; chunkZ++) {
            for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                // Calculate chunk world bounds
                const chunkMinX = chunkX * chunkSize - halfWorldX;
                const chunkMaxX = Math.min((chunkX + 1) * chunkSize - halfWorldX, halfWorldX);
                const chunkMinZ = chunkZ * chunkSize - halfWorldZ;
                const chunkMaxZ = Math.min((chunkZ + 1) * chunkSize - halfWorldZ, halfWorldZ);
                
                const chunkWidth = chunkMaxX - chunkMinX;
                const chunkDepth = chunkMaxZ - chunkMinZ;
                
                // Build geometry directly in the correct format (no conversion)
                const geometry = this.groundRenderingType === 'polygonal'
                    ? this.generatePolygonalChunkGeometry(
                        chunkMinX, chunkMaxX, chunkMinZ, chunkMaxZ,
                        chunkWidth, chunkDepth, segmentsPerChunk
                    )
                    : this.generateSmoothChunkGeometry(
                        chunkMinX, chunkMaxX, chunkMinZ, chunkMaxZ,
                        chunkWidth, chunkDepth, segmentsPerChunk
                    );
                
                // Create visual mesh for this chunk
                const chunkMesh = new THREE.Mesh(geometry, material.clone());
                chunkMesh.position.set(
                    chunkMinX + chunkWidth / 2,
                    0,
                    chunkMinZ + chunkDepth / 2
                );
                chunkMesh.receiveShadow = true;
                chunkMesh.castShadow = true;
                chunkMesh.name = `GroundChunk_${chunkX}_${chunkZ}`;
                chunkMesh.layers.set(0);
                chunkMesh.layers.disable(2);
                
                this.groundChunkGroup.add(chunkMesh);
                
                // Create physics body for this chunk (matches visual chunk size and position)
                // Wrap in try-catch to handle OOM errors gracefully
                let physicsBody: any = null;
                try {
                    physicsBody = this.createPhysicsChunkForVisualChunk(
                        chunkX,
                        chunkZ,
                        chunkMinX,
                        chunkMaxX,
                        chunkMinZ,
                        chunkMaxZ,
                        chunkWidth,
                        chunkDepth,
                        segmentsPerChunk
                    );
                    
                    if (!physicsBody) {
                        console.error(`❌ Failed to create physics body for chunk [${chunkX},${chunkZ}]`);
                    }
                } catch (error) {
                    console.error(`❌ Error creating physics body for chunk [${chunkX},${chunkZ}]:`, error);
                    // If OOM error, stop creating chunks and clean up
                    if (error instanceof Error && (error.message.includes('OOM') || error.message.includes('Aborted'))) {
                        console.error('💥 Out of Memory error during physics chunk creation. Stopping generation.');
                        // Clean up any partially created chunks
                        this.clearAllGroundChunks();
                        throw new Error('Out of Memory: World size too large for current polygon size. Please reduce world size or increase polygon size and try again.');
                    }
                    // Re-throw other errors
                    throw error;
                }
                
                // Store both visual and physics together
                this.groundChunkData.push({
                    chunkX,
                    chunkZ,
                    worldMinX: chunkMinX,
                    worldMaxX: chunkMaxX,
                    worldMinZ: chunkMinZ,
                    worldMaxZ: chunkMaxZ,
                    visualMesh: chunkMesh,
                    physicsBody: physicsBody?.body ?? null,
                    physicsCollider: physicsBody?.collider ?? null
                });
            }
        }
        
        // In Rapier, physics bodies are automatically added to the world when created
        // Just count and log how many were successfully created
        let physicsBodiesCreated = 0;
        let physicsBodiesNull = 0;
        this.groundChunkData.forEach((chunk) => {
            if (chunk.physicsBody) {
                physicsBodiesCreated++;
            } else {
                physicsBodiesNull++;
            }
        });
        
        if (physicsBodiesNull > 0) {
            console.error(`⚠️ ${physicsBodiesNull} chunks have null physics bodies out of ${this.groundChunkData.length} total chunks`);
        }
        
        console.log(`🔧 Created ${physicsBodiesCreated} physics bodies (expected ${this.groundChunkData.length})`);
    }
    
    /**
     * Clear all ground chunks (visual and physics) properly.
     */
    private clearAllGroundChunks(): void {
        // CRITICAL: Remove all physics bodies FIRST, before disposing meshes
        // This ensures memory is freed before creating new chunks
        const chunkCount = this.groundChunkData.length;
        let physicsBodiesRemoved = 0;
        this.groundChunkData.forEach((chunk) => {
            if (this.engine && this.engine.physicsWorld) {
                try {
                    // Remove collider first, then body (Rapier handles cleanup automatically)
                    if (chunk.physicsCollider) {
                        this.engine.physicsWorld.removeCollider(chunk.physicsCollider);
                    }
                    if (chunk.physicsBody) {
                        this.engine.physicsWorld.removeRigidBody(chunk.physicsBody);
                        physicsBodiesRemoved++;
                    }
                } catch (e) {
                    console.warn('Error removing physics body:', e);
                }
            }
        });
        
        // Now dispose visual meshes (after physics bodies are removed)
        this.groundChunkData.forEach((chunk) => {
            // Dispose visual mesh geometry
            if (chunk.visualMesh && chunk.visualMesh.geometry) {
                try {
                    chunk.visualMesh.geometry.dispose();
                } catch (e) {
                    console.warn('Error disposing geometry:', e);
                }
            }
            
            // Remove mesh from scene if it's still attached
            if (chunk.visualMesh.parent) {
                chunk.visualMesh.parent.remove(chunk.visualMesh);
            }
        });
        
        // Remove chunk group from world (but keep reference for reuse)
        if (this.groundChunkGroup) {
            const parent = this.groundChunkGroup.parent;
            if (parent) {
                parent.remove(this.groundChunkGroup);
            }
            // Clear children array - remove all meshes
            while (this.groundChunkGroup.children.length > 0) {
                const child = this.groundChunkGroup.children[0];
                if (child) {
                    this.groundChunkGroup.remove(child);
                    // Dispose geometry if it's a mesh
                    if ((child as THREE.Mesh).geometry) {
                        try {
                            (child as THREE.Mesh).geometry.dispose();
                        } catch (e) {
                            console.warn('Error disposing child geometry:', e);
                        }
                    }
                } else {
                    break;
                }
            }
            // Re-add the group to world (will be populated with new chunks)
            this.world.add(this.groundChunkGroup);
        }
        
        // Clear arrays AFTER everything is disposed
        this.groundChunkData = [];
        
        // Log cleanup (use chunkCount, not this.groundChunkData.length since it's cleared)
        if (physicsBodiesRemoved > 0 || chunkCount > 0) {
            console.log(`🗑️ Cleared ${physicsBodiesRemoved} physics bodies and ${chunkCount} visual chunks`);
        }
    }
    
    /**
     * Regenerate all ground chunks after terrain changes.
     */
    private regenerateGroundChunks(material: THREE.MeshStandardMaterial): void {
        // CRITICAL: Clear all existing chunks FIRST and ensure they're fully destroyed
        // before creating new ones to prevent OOM errors
        this.clearAllGroundChunks();
        
        // Small delay to ensure physics bodies are fully destroyed before creating new ones
        // This helps prevent OOM when regenerating many chunks
        // Use requestAnimationFrame to yield to browser and allow cleanup
        requestAnimationFrame(() => {
            try {
                // Regenerate chunks - this will sample from the CURRENT heightmap
                this.generateGroundChunks(material);
            } catch (error) {
                console.error('❌ Error regenerating ground chunks:', error);
                // If OOM or other error, try to recover by clearing everything
                if (error instanceof Error && (error.message.includes('OOM') || error.message.includes('Aborted'))) {
                    console.error('💥 Out of Memory error detected. Attempting recovery...');
                    this.clearAllGroundChunks();
                    // Don't regenerate - let user try again with smaller settings
                    alert('Out of Memory error: World size is too large for current polygon size. Please reduce world size or increase polygon size and try again.');
                } else {
                    throw error;
                }
            }
        });
    }
    
    /**
     * Generate smooth chunk geometry directly (no conversion needed).
     */
    private generateSmoothChunkGeometry(
        chunkMinX: number, chunkMaxX: number,
        chunkMinZ: number, chunkMaxZ: number,
        chunkWidth: number, chunkDepth: number,
        segmentsPerChunk: number
    ): THREE.PlaneGeometry {
        const geometry = new THREE.PlaneGeometry(
            chunkWidth,
            chunkDepth,
            segmentsPerChunk,
            segmentsPerChunk
        );
        
        geometry.rotateX(-Math.PI / 2);
        
        const positions = geometry.attributes.position;
        if (!positions) {
            throw new Error('Chunk geometry missing position attribute');
        }
        
        const vertexCountX = segmentsPerChunk + 1;
        const vertexCountZ = segmentsPerChunk + 1;
        
        // Sample heights and set positions
        for (let gridZ = 0; gridZ < vertexCountZ; gridZ++) {
            for (let gridX = 0; gridX < vertexCountX; gridX++) {
                const index = gridZ * vertexCountX + gridX;
                
                // Calculate world position for this vertex
                const worldX = chunkMinX + (gridX / segmentsPerChunk) * chunkWidth;
                const worldZ = chunkMinZ + (gridZ / segmentsPerChunk) * chunkDepth;
                
                // Sample height from heightmap system
                let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                
                // Apply Y-granularity snapping if enabled
                if (this.groundSettings.yGranularity > 0) {
                    heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                }
                
                positions.setY(index, heightValue);
            }
        }
        
        positions.needsUpdate = true;
        
        // Compute smooth normals
        this.computeHeightmapNormals(geometry, {
            width: vertexCountX,
            height: vertexCountZ,
            heights: new Float32Array(vertexCountX * vertexCountZ),
            minX: chunkMinX,
            maxX: chunkMaxX,
            minZ: chunkMinZ,
            maxZ: chunkMaxZ,
            minY: 0,
            maxY: 0
        });
        
        return geometry;
    }
    
    /**
     * Generate polygonal chunk geometry directly (no conversion needed).
     */
    private generatePolygonalChunkGeometry(
        chunkMinX: number, chunkMaxX: number,
        chunkMinZ: number, chunkMaxZ: number,
        chunkWidth: number, chunkDepth: number,
        segmentsPerChunk: number
    ): THREE.PlaneGeometry {
        const vertexCountX = segmentsPerChunk + 1;
        const vertexCountZ = segmentsPerChunk + 1;
        
        // First, collect grid heights
        const gridHeights = new Float32Array(vertexCountX * vertexCountZ);
        for (let gridZ = 0; gridZ < vertexCountZ; gridZ++) {
            for (let gridX = 0; gridX < vertexCountX; gridX++) {
                const gridIndex = gridZ * vertexCountX + gridX;
                
                // Calculate world position for this vertex
                const worldX = chunkMinX + (gridX / segmentsPerChunk) * chunkWidth;
                const worldZ = chunkMinZ + (gridZ / segmentsPerChunk) * chunkDepth;
                
                // Sample height from heightmap system
                let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                
                // Apply Y-granularity snapping if enabled
                if (this.groundSettings.yGranularity > 0) {
                    heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                }
                
                gridHeights[gridIndex] = heightValue;
            }
        }
        
        // Create base geometry (will be converted to polygonal)
        const geometry = new THREE.PlaneGeometry(
            chunkWidth,
            chunkDepth,
            segmentsPerChunk,
            segmentsPerChunk
        );
        
        geometry.rotateX(-Math.PI / 2);
        
        // Set heights on base geometry
        const positions = geometry.attributes.position;
        if (!positions) {
            throw new Error('Chunk geometry missing position attribute');
        }
        
        for (let i = 0; i < gridHeights.length; i++) {
            positions.setY(i, gridHeights[i] ?? 0);
        }
        positions.needsUpdate = true;
        
        // Convert to polygonal format (duplicates vertices, sets normals)
        this.computePolygonalNormals(geometry, {
            width: vertexCountX,
            height: vertexCountZ,
            heights: gridHeights,
            minX: chunkMinX,
            maxX: chunkMaxX,
            minZ: chunkMinZ,
            maxZ: chunkMaxZ,
            minY: 0,
            maxY: 0
        });
        
        return geometry;
    }
    
    private computeHeightmapNormals(geometry: THREE.PlaneGeometry, heightmapData: HeightmapData): void {
        const { width, height } = heightmapData;
        const positions = geometry.attributes.position;
        const normals = geometry.attributes.normal;
        
        if (!positions || !normals) {
            console.error('Geometry missing position or normal attributes');
            geometry.computeVertexNormals();
            return;
        }

        const cellSizeX = (heightmapData.maxX - heightmapData.minX) / (width - 1);
        const cellSizeZ = (heightmapData.maxZ - heightmapData.minZ) / (height - 1);

        for (let gridZ = 0; gridZ < height; gridZ++) {
            for (let gridX = 0; gridX < width; gridX++) {
                const index = gridZ * width + gridX;
                
                // Get heights from geometry positions instead of heightmap data
                let hL = positions.getY(index);
                let hR = positions.getY(index);
                let hD = positions.getY(index);
                let hU = positions.getY(index);
                
                if (gridX > 0) {
                    hL = positions.getY(gridZ * width + (gridX - 1));
                }
                if (gridX < width - 1) {
                    hR = positions.getY(gridZ * width + (gridX + 1));
                }
                if (gridZ > 0) {
                    hD = positions.getY((gridZ - 1) * width + gridX);
                }
                if (gridZ < height - 1) {
                    hU = positions.getY((gridZ + 1) * width + gridX);
                }
                
                const dx = (hR - hL) / (2 * cellSizeX);
                const dz = (hU - hD) / (2 * cellSizeZ);
                
                const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
                normals.setXYZ(index, normal.x, normal.y, normal.z);
            }
        }
        
        normals.needsUpdate = true;
    }
    
    /**
     * Update Y positions and normals for an already-polygonal geometry.
     * Does NOT modify indices or UVs - only updates positions and normals.
     */
    private updatePolygonalGeometryHeights(
        geometry: THREE.PlaneGeometry,
        gridHeights: Float32Array,
        gridWidth: number,
        gridHeight: number,
        chunk: GroundChunkData
    ): void {
        const positions = geometry.attributes.position;
        const indices = geometry.index;
        
        if (!positions || !indices) {
            console.error('Geometry missing position or index attributes');
            return;
        }
        
        const chunkWidth = chunk.worldMaxX - chunk.worldMinX;
        const chunkDepth = chunk.worldMaxZ - chunk.worldMinZ;
        const segmentsPerChunk = gridWidth - 1;
        const triangleCount = indices.count / 3;
        const indexArray = indices.array;
        
        // Update vertices using the same approach as computePolygonalNormals.getVertexPos
        // We need to map each vertex's LOCAL X/Z coordinates back to grid position
        // This is the same logic used in computePolygonalNormals to determine heights
        for (let tri = 0; tri < triangleCount; tri++) {
            const idx0 = indexArray[tri * 3] ?? 0;
            const idx1 = indexArray[tri * 3 + 1] ?? 0;
            const idx2 = indexArray[tri * 3 + 2] ?? 0;
            
            // Helper to map vertex position to grid index (same as getVertexPos in computePolygonalNormals)
            const getGridIndex = (vertexIdx: number): number => {
                const x = positions.getX(vertexIdx);
                const z = positions.getZ(vertexIdx);
                
                // Map LOCAL X/Z to grid position (same logic as computePolygonalNormals)
                // PlaneGeometry centers at origin: localX = -width/2 to +width/2
                const gridX = Math.round((x + chunkWidth / 2) / chunkWidth * segmentsPerChunk);
                const gridZ = Math.round((z + chunkDepth / 2) / chunkDepth * segmentsPerChunk);
                
                // Clamp to valid range
                const clampedX = Math.max(0, Math.min(gridWidth - 1, gridX));
                const clampedZ = Math.max(0, Math.min(gridHeight - 1, gridZ));
                
                return clampedZ * gridWidth + clampedX;
            };
            
            // Update each vertex's Y position based on its grid position
            const gridIdx0 = getGridIndex(idx0);
            const gridIdx1 = getGridIndex(idx1);
            const gridIdx2 = getGridIndex(idx2);
            
            positions.setY(idx0, gridHeights[gridIdx0] ?? positions.getY(idx0));
            positions.setY(idx1, gridHeights[gridIdx1] ?? positions.getY(idx1));
            positions.setY(idx2, gridHeights[gridIdx2] ?? positions.getY(idx2));
        }
        
        positions.needsUpdate = true;
        
        // Recalculate normals for each triangle
        const normals = geometry.attributes.normal;
        if (!normals) {
            console.error('Geometry missing normal attribute');
            return;
        }
        
        // Recalculate normals using the same triangle loop
        for (let tri = 0; tri < triangleCount; tri++) {
            const idx0 = indexArray[tri * 3] ?? 0;
            const idx1 = indexArray[tri * 3 + 1] ?? 0;
            const idx2 = indexArray[tri * 3 + 2] ?? 0;
            
            const v0 = new THREE.Vector3(
                positions.getX(idx0),
                positions.getY(idx0),
                positions.getZ(idx0)
            );
            const v1 = new THREE.Vector3(
                positions.getX(idx1),
                positions.getY(idx1),
                positions.getZ(idx1)
            );
            const v2 = new THREE.Vector3(
                positions.getX(idx2),
                positions.getY(idx2),
                positions.getZ(idx2)
            );
            
            // Calculate triangle normal
            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
            
            // Update normals for all three vertices of this triangle
            normals.setXYZ(idx0, normal.x, normal.y, normal.z);
            normals.setXYZ(idx1, normal.x, normal.y, normal.z);
            normals.setXYZ(idx2, normal.x, normal.y, normal.z);
        }
        
        normals.needsUpdate = true;
    }
    
    private computePolygonalNormals(geometry: THREE.PlaneGeometry, heightmapData: HeightmapData): void {
        const positions = geometry.attributes.position;
        const indices = geometry.index;

        if (!positions || !indices) {
            console.error('Geometry missing position or index attributes');
            geometry.computeVertexNormals();
            return;
        }

        // Get original position data
        const originalPositions = new Float32Array(positions.array);
        const originalIndices = indices.array instanceof Uint16Array 
            ? new Uint16Array(indices.array)
            : new Uint32Array(indices.array);

        // Calculate number of triangles
        const triangleCount = originalIndices.length / 3;

        // For polygonal rendering, we need to duplicate vertices for each triangle
        // Each triangle gets its own 3 vertices with per-polygon normals
        const newVertexCount = triangleCount * 3;
        const newPositions = new Float32Array(newVertexCount * 3);
        const newNormals = new Float32Array(newVertexCount * 3);
        const newIndices = triangleCount * 3 <= 65535 
            ? new Uint16Array(triangleCount * 3)
            : new Uint32Array(triangleCount * 3);
        const newUVs = new Float32Array(newVertexCount * 2);

        // Helper to get vertex position with updated Y from heightmap
        const getVertexPos = (idx: number): THREE.Vector3 => {
            const i = idx * 3;
            const x = originalPositions[i] ?? 0;
            const z = originalPositions[i + 2] ?? 0;
            
            // CRITICAL: Geometry vertices are in LOCAL space (PlaneGeometry centers at origin)
            // PlaneGeometry arranges vertices in grid order: row by row, left to right, bottom to top
            // Local X goes from -width/2 to +width/2, Local Z goes from -depth/2 to +depth/2
            // Grid position (gridX, gridZ) maps to local position:
            //   localX = -width/2 + (gridX / segmentsPerChunk) * width
            //   localZ = -depth/2 + (gridZ / segmentsPerChunk) * depth
            // To reverse: gridX = (localX + width/2) / width * segmentsPerChunk
            const localWidth = heightmapData.maxX - heightmapData.minX;
            const localDepth = heightmapData.maxZ - heightmapData.minZ;
            const segmentsPerChunk = heightmapData.width - 1;
            
            // Map LOCAL X/Z to grid position
            const gridX = Math.round((x + localWidth / 2) / localWidth * segmentsPerChunk);
            const gridZ = Math.round((z + localDepth / 2) / localDepth * segmentsPerChunk);
            
            // Clamp to valid range
            const clampedX = Math.max(0, Math.min(heightmapData.width - 1, gridX));
            const clampedZ = Math.max(0, Math.min(heightmapData.height - 1, gridZ));
            
            const heightIndex = clampedZ * heightmapData.width + clampedX;
            const y = heightmapData.heights[heightIndex] ?? originalPositions[i + 1] ?? 0;
            
            return new THREE.Vector3(x, y, z);
        };

        // Process each triangle
        for (let tri = 0; tri < triangleCount; tri++) {
            const idx0 = originalIndices[tri * 3] ?? 0;
            const idx1 = originalIndices[tri * 3 + 1] ?? 0;
            const idx2 = originalIndices[tri * 3 + 2] ?? 0;

            const v0 = getVertexPos(idx0);
            const v1 = getVertexPos(idx1);
            const v2 = getVertexPos(idx2);

            // Calculate triangle normal
            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

            // Create new vertices for this triangle
            const newBaseIdx = tri * 3;
            
            // Vertex 0
            newPositions[newBaseIdx * 3] = v0.x;
            newPositions[newBaseIdx * 3 + 1] = v0.y;
            newPositions[newBaseIdx * 3 + 2] = v0.z;
            newNormals[newBaseIdx * 3] = normal.x;
            newNormals[newBaseIdx * 3 + 1] = normal.y;
            newNormals[newBaseIdx * 3 + 2] = normal.z;
            
            // Vertex 1
            newPositions[(newBaseIdx + 1) * 3] = v1.x;
            newPositions[(newBaseIdx + 1) * 3 + 1] = v1.y;
            newPositions[(newBaseIdx + 1) * 3 + 2] = v1.z;
            newNormals[(newBaseIdx + 1) * 3] = normal.x;
            newNormals[(newBaseIdx + 1) * 3 + 1] = normal.y;
            newNormals[(newBaseIdx + 1) * 3 + 2] = normal.z;
            
            // Vertex 2
            newPositions[(newBaseIdx + 2) * 3] = v2.x;
            newPositions[(newBaseIdx + 2) * 3 + 1] = v2.y;
            newPositions[(newBaseIdx + 2) * 3 + 2] = v2.z;
            newNormals[(newBaseIdx + 2) * 3] = normal.x;
            newNormals[(newBaseIdx + 2) * 3 + 1] = normal.y;
            newNormals[(newBaseIdx + 2) * 3 + 2] = normal.z;

            // Set indices (sequential)
            newIndices[tri * 3] = newBaseIdx;
            newIndices[tri * 3 + 1] = newBaseIdx + 1;
            newIndices[tri * 3 + 2] = newBaseIdx + 2;

            // Calculate UVs (we need to compute these from original vertex positions)
            // For a plane geometry, UVs are typically based on x/z coordinates
            const uvs = geometry.attributes.uv;
            if (uvs) {
                const origUVs = uvs.array as Float32Array;
                const uvIdx0 = idx0 * 2;
                const uvIdx1 = idx1 * 2;
                const uvIdx2 = idx2 * 2;
                newUVs[newBaseIdx * 2] = origUVs[uvIdx0] ?? 0;
                newUVs[newBaseIdx * 2 + 1] = origUVs[uvIdx0 + 1] ?? 0;
                newUVs[(newBaseIdx + 1) * 2] = origUVs[uvIdx1] ?? 0;
                newUVs[(newBaseIdx + 1) * 2 + 1] = origUVs[uvIdx1 + 1] ?? 0;
                newUVs[(newBaseIdx + 2) * 2] = origUVs[uvIdx2] ?? 0;
                newUVs[(newBaseIdx + 2) * 2 + 1] = origUVs[uvIdx2 + 1] ?? 0;
            }
        }

        // Update geometry with new data
        geometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
        
        // Mark attributes as needing update
        const positionAttr = geometry.attributes.position;
        const normalAttr = geometry.attributes.normal;
        if (positionAttr) positionAttr.needsUpdate = true;
        if (normalAttr) normalAttr.needsUpdate = true;
        
        // Set index - convert typed array to regular array for setIndex
        const indexArray = Array.from(newIndices);
        geometry.setIndex(indexArray);
        
        if (geometry.attributes.uv) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(newUVs, 2));
            const uvAttr = geometry.attributes.uv;
            if (uvAttr) uvAttr.needsUpdate = true;
        }

        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }
    
    private generateColormap(): void {
        const canvas = document.createElement('canvas');
        canvas.width = this.resolution;
        canvas.height = this.resolution;
        const ctx = canvas.getContext('2d')!;
        const imageData = ctx.createImageData(this.resolution, this.resolution);
        
        const terrainTypeMap = this.heightmapSystem.getTerrainTypeMap();
        if (!terrainTypeMap) return;
        
        for (let z = 0; z < this.resolution; z++) {
            for (let x = 0; x < this.resolution; x++) {
                const index = z * this.resolution + x;
                const terrainType = terrainTypeMap[index] ?? 0;
                const terrainProps = this.terrainRegistry.getType(terrainType);
                
                let r = 0.2, g = 0.6, b = 0.2;
                if (terrainProps && terrainProps.color) {
                    r = terrainProps.color.r;
                    g = terrainProps.color.g;
                    b = terrainProps.color.b;
                }
                
                const pixelIndex = (z * this.resolution + x) * 4;
                imageData.data[pixelIndex] = Math.floor(r * 255);
                imageData.data[pixelIndex + 1] = Math.floor(g * 255);
                imageData.data[pixelIndex + 2] = Math.floor(b * 255);
                imageData.data[pixelIndex + 3] = 255;
            }
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        this.colormapTexture = new THREE.CanvasTexture(canvas);
        this.colormapTexture.magFilter = THREE.LinearFilter;
        this.colormapTexture.minFilter = THREE.LinearFilter;
        // Disable mipmap generation if texture is very small to avoid WebGL warnings
        // Colormap is typically larger, but disable if it's small
        if (canvas.width <= 4 || canvas.height <= 4) {
            this.colormapTexture.generateMipmaps = false;
        }
    }
    
    /**
     * Create physics chunk that matches a visual chunk (same size and position).
     * Physics resolution is capped at 1.0m granularity maximum for performance.
     * Returns { body: RAPIER.RigidBody, collider: RAPIER.Collider } or null on failure.
     */
    private createPhysicsChunkForVisualChunk(
        chunkX: number,
        chunkZ: number,
        chunkWorldMinX: number,
        chunkWorldMaxX: number,
        chunkWorldMinZ: number,
        chunkWorldMaxZ: number,
        chunkWidth: number,
        chunkDepth: number,
        segmentsPerChunk: number
    ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } | null {
        if (!this.engine || !this.engine.physicsWorld) {
            console.error('Physics chunk: engine or physics world not available');
            return null;
        }
        
        const RAPIER = getRapier();
        
        // Cap physics resolution at 1.0m granularity maximum for memory safety
        // For 16m chunks: max 16 segments = 17 vertices per side = 512 triangles per chunk
        // This prevents OOM when regenerating many chunks at once
        const MAX_PHYSICS_GRANULARITY = 1.0; // meters
        const chunkSize = TerrainMeshSystem.GROUND_CHUNK_SIZE;
        const maxPhysicsSegments = Math.floor(chunkSize / MAX_PHYSICS_GRANULARITY);
        const physicsSegments = Math.min(segmentsPerChunk, maxPhysicsSegments);
        const physicsResolution = physicsSegments + 1;
        
        const geometry = new THREE.PlaneGeometry(
            chunkWidth,
            chunkDepth,
            physicsSegments,
            physicsSegments
        );
        
        geometry.rotateX(-Math.PI / 2);
        
        const positions = geometry.attributes.position;
        if (!positions) {
            console.error('Physics chunk geometry missing position attribute');
            return null;
        }
        
        // Sample heights for this chunk from CURRENT heightmap
        const vertexCountX = physicsResolution;
        const vertexCountZ = physicsResolution;
        
        const currentHeightmapData = this.heightmapSystem.getHeightmapData();
        if (!currentHeightmapData) {
            console.error('Physics chunk: no heightmap data available');
            return null;
        }
        
        // Calculate chunk center for positioning
        const chunkCenterX = (chunkWorldMinX + chunkWorldMaxX) / 2;
        const chunkCenterZ = (chunkWorldMinZ + chunkWorldMaxZ) / 2;
        
        for (let gridZ = 0; gridZ < vertexCountZ; gridZ++) {
            for (let gridX = 0; gridX < vertexCountX; gridX++) {
                const index = gridZ * vertexCountX + gridX;
                
                // Calculate world position for this vertex
                // Use physicsSegments for spacing (not segmentsPerChunk)
                const worldX = chunkWorldMinX + (gridX / physicsSegments) * chunkWidth;
                const worldZ = chunkWorldMinZ + (gridZ / physicsSegments) * chunkDepth;
                
                // Sample from CURRENT heightmap
                let heightValue = this.heightmapSystem.getHeightAt(worldX, worldZ);
                
                // Apply Y-granularity snapping if enabled
                if (this.groundSettings.yGranularity > 0) {
                    heightValue = Math.round(heightValue / this.groundSettings.yGranularity) * this.groundSettings.yGranularity;
                }
                
                positions.setY(index, heightValue);
            }
        }
        positions.needsUpdate = true;
        
        geometry.computeVertexNormals();
        
        const posArray = positions.array as Float32Array;
        const indexArray = geometry.index!.array;
        const expectedTriangles = physicsSegments * physicsSegments * 2;
        const actualTriangles = indexArray.length / 3;
        
        if (Math.abs(actualTriangles - expectedTriangles) > 1) {
            console.error(`❌ Physics chunk [${chunkX},${chunkZ}]: Expected ${expectedTriangles} triangles but geometry has ${actualTriangles} (segments: visual=${segmentsPerChunk}, physics=${physicsSegments})`);
            geometry.dispose();
            return null;
        }
        
        // Log before adding triangles (only for first chunk to avoid spam)
        if (chunkX === 0 && chunkZ === 0) {
            console.log(`🔧 Physics chunk [${chunkX},${chunkZ}]: Adding ${actualTriangles} triangles to mesh (physics segments: ${physicsSegments})`);
        }
        
        // Convert vertex positions to world coordinates (add chunk center offset)
        // Rapier trimesh expects vertices in world space
        const worldVertices = new Float32Array(posArray.length);
        for (let i = 0; i < posArray.length; i += 3) {
            worldVertices[i] = posArray[i]! + chunkCenterX;     // X
            worldVertices[i + 1] = posArray[i + 1]!;             // Y (height already in world space)
            worldVertices[i + 2] = posArray[i + 2]! + chunkCenterZ; // Z
        }
        
        // Convert indices to Uint32Array for Rapier
        const indices = new Uint32Array(indexArray);
        
        // Dispose geometry after extracting triangle data (we don't need it anymore)
        geometry.dispose();
        
        try {
            // Create fixed (static) rigid body at origin since vertices are in world space
            const bodyDesc = RAPIER.RigidBodyDesc.fixed();
            const body = this.engine.physicsWorld.createRigidBody(bodyDesc);
            
            // Create trimesh collider
            // FIX_INTERNAL_EDGES (144) fixes zero/bad normals at triangle edges
            const colliderDesc = RAPIER.ColliderDesc.trimesh(worldVertices, indices, 144);
            if (!colliderDesc) {
                console.error(`❌ Physics chunk [${chunkX},${chunkZ}]: Failed to create trimesh collider descriptor`);
                this.engine.physicsWorld.removeRigidBody(body);
                return null;
            }
            
            colliderDesc.setFriction(this.physicsFriction);
            colliderDesc.setRestitution(this.physicsRestitution);
            colliderDesc.setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL));
            
            const collider = this.engine.physicsWorld.createCollider(colliderDesc, body);
            
            registerPhysicsBody(body, 'terrain-mesh');
            
            return { body, collider };
        } catch (error) {
            console.error(`❌ Physics chunk [${chunkX},${chunkZ}]: Error creating physics:`, error);
            throw error;
        }
    }
}

