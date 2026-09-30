import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SeededRandom } from 'engine/SeededRandom.js';
import { createFoliageMaterial, prepareFoliageInstances, DEFAULT_FOLIAGE_APPEARANCE, type FoliageAppearance } from 'engine/foliage/FoliageMaterial.js';
import { createBlockBlade, addFoliageAttributes, foliagePatch, foliageSeed } from 'engine/foliage/FoliageGeometry.js';
import type { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import { FoliageType } from 'engine/TerrainTypes.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

/**
 * Surface voxel data for foliage generation
 */
export interface SurfaceVoxel {
    worldX: number;
    worldY: number;
    worldZ: number;
    blockType: number;
}

/**
 * Foliage voxel size in meters - use this constant for consistent voxel-style geometry
 */
export const FOLIAGE_VOXEL_SIZE = 0.05;

/**
 * Context passed to custom foliage creators
 */
export interface FoliageCreatorContext {
    /** Random number generator (seeded for consistency) */
    rng: SeededRandom;
    /** Foliage voxel size constant (0.05m) for geometry dimensions */
    voxelSize: number;
    /** Parent group to add meshes to */
    parent: THREE.Group;
    /** Track created meshes for disposal */
    addMesh: (mesh: THREE.InstancedMesh) => void;
    /**
     * Get a random offset for spreading elements within a foliage patch.
     * Call this for each element you want to spread (e.g., each blade of grass).
     * Returns value in range [-spread/2, +spread/2] where spread is ~60% of terrain spacing.
     */
    getRandomOffset: () => number;
}

/**
 * Function that creates instanced meshes for a foliage type.
 * Receives positions and a context with utilities.
 */
export type FoliageCreator = (
    positions: THREE.Matrix4[],
    ctx: FoliageCreatorContext
) => void;

/**
 * Configuration for a custom foliage type.
 * 
 * Use this to add new foliage (mushrooms, rubble, flowers, etc.) to terrain types.
 * Works with both built-in foliage types (FoliageType enum) and custom types
 * registered via FoliageTypeRegistry.
 */
export interface CustomFoliageType {
    /** Unique name for this foliage type */
    name: string;
    /** 
     * Which foliage type IDs this appears in.
     * Use FoliageType enum values for built-in types, or custom IDs from FoliageTypeRegistry.
     */
    foliageTypes: number[];
    /** Spawn chance (0-1) when terrain type matches */
    spawnChance: number;
    /** Function that creates the instanced geometry */
    creator: FoliageCreator;
}

/** Axis-aligned world-space rectangle (XZ) in which no foliage grows. */
export interface FoliageExclusionRect {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

function rectContains(rect: FoliageExclusionRect, x: number, z: number): boolean {
    return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

/** One instance slot a foliage item occupies: the mesh plus its index within it. */
interface FoliageInstanceRef {
    /** Stable mesh reference — survives other chunks being removed/rebuilt. */
    mesh: THREE.InstancedMesh;
    instanceIndex: number;
}

/** A foliage item tracked for destruction; one item can span several mesh instances. */
interface TrackedFoliage {
    x: number;
    y: number;
    z: number;
    instances: FoliageInstanceRef[];
    color: number;
}

/** Scale-to-zero matrix used to hide a single instance (setMatrixAt copies it). */
const HIDDEN_INSTANCE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Grass blade colours, lerped by the patch noise. */
const GRASS_BASE_COLOR = new THREE.Color(0x568d39);
const GRASS_TIP_COLOR = new THREE.Color(0x849943);

/** Default spawn rates per foliage type, and the palette the default flowers pick from. */
const BASE_SPAWN_CHANCE = 0.3;
const DEFAULT_FLOWER_CHANCE = 0.15;
const BEACH_PEBBLE_CHANCE = 0.2;
const DESERT_CACTUS_CHANCE = 0.05;
const DEFAULT_PETAL_COLORS = [0xe6b7ce, 0xf2d16c, 0xe99978, 0xb6a0db, 0xf2ebd6];

/** Detach a mesh from the scene and release its GPU resources. */
function disposeMesh(mesh: THREE.Mesh | THREE.InstancedMesh): void {
    mesh.removeFromParent();
    if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material) mesh.material.dispose();
}

export interface VoxelFoliageConfig {
    terrainVoxelSize: number;
    getTerrainHeight: (x: number, z: number) => number;
    isPositionOccupied?: (x: number, z: number) => boolean;
    /** Custom foliage types to add (replaces default flowers in their terrain types) */
    customFoliage?: CustomFoliageType[];
    appearance?: Partial<FoliageAppearance>;
}

/**
 * VoxelFoliageSystem - Generates grass, flowers, pebbles, cacti using InstancedMesh.
 * 
 * ## Adding Custom Foliage Types
 * 
 * Pass `customFoliage` in config to add new foliage (tulips, bluebonnets, mushrooms, etc.):
 * 
 * IMPORTANT RULES:
 * - Call ctx.addMesh() exactly ONCE per foliage type (1 mesh = 1 draw call per chunk)
 * - Use mergeGeometries() to combine multiple parts into one geometry
 * - Use vertex colors for different-colored parts, NOT separate meshes
 * - See createFlowerInstancesForChunk() for a complete multi-part example
 */
export class VoxelFoliageSystem {
    private world: THREE.Object3D;
    private rng: SeededRandom;
    private terrainRegistry: TerrainTypeRegistry;

    private terrainVoxelSize: number;
    private isPositionOccupied: (x: number, z: number) => boolean;

    // Custom foliage types
    private customFoliage: CustomFoliageType[];
    readonly appearance: FoliageAppearance;
    private readonly seed: number;

    private foliageParent: THREE.Group;
    private instancedMeshes: THREE.InstancedMesh[] = [];

    // Chunk-based foliage storage - key format: "cx,cz"
    private chunkMeshes: Map<string, THREE.InstancedMesh[]> = new Map();

    // Track positions for destruction - each foliage item can span multiple mesh instances
    private foliagePositions: TrackedFoliage[] = [];

    // Persistent rectangular no-foliage zones (building footprints), keyed by owner id.
    // Checked on every chunk (re)generation so a rebuilt chunk never regrows grass inside.
    private exclusions: Map<string, FoliageExclusionRect> = new Map();
    private nextAnonymousExclusionId = 0;

    // Track foliage debris for physics update
    private foliageDebris: Array<{
        mesh: THREE.Mesh;
        velocity: THREE.Vector3;
        angularVel: THREE.Vector3;
        lifetime: number;
        maxLifetime: number;
    }> = [];

    constructor(
        world: THREE.Object3D,
        worldSizeX: number,
        worldSizeZ: number,
        seed: number,
        terrainRegistry: TerrainTypeRegistry,
        terrainHeightProvider: TerrainHeightProvider,
        config: VoxelFoliageConfig
    ) {
        this.appearance = { ...DEFAULT_FOLIAGE_APPEARANCE, ...config.appearance };
        this.seed = seed;
        this.world = world;
        this.rng = new SeededRandom(seed);
        this.terrainRegistry = terrainRegistry;

        this.terrainVoxelSize = config.terrainVoxelSize;
        this.isPositionOccupied = config.isPositionOccupied ?? (() => false);
        this.customFoliage = config.customFoliage ?? [];

        // Fallback parent for foliage not attached to chunks
        this.foliageParent = new THREE.Group();
        this.foliageParent.name = 'VoxelFoliage';
        this.world.add(this.foliageParent);
    }
    
    /**
     * Generate foliage for a single terrain chunk based on its surface voxels.
     * Called by VoxelWorld when a chunk mesh is created/updated.
     * Foliage is parented to the chunk mesh for automatic visibility inheritance.
     * 
     * @param chunkKey - 2D chunk key "cx,cz"
     * @param surfaceVoxels - Top-surface voxels in this chunk (voxels with air above)
     * @param chunkParent - The terrain chunk mesh to parent foliage to
     * @param getTerrainType - Function to map block type to terrain type
     */
    generateFoliageForChunk(
        chunkKey: string,
        surfaceVoxels: SurfaceVoxel[],
        chunkParent: THREE.Object3D,
        getTerrainType: (blockType: number) => number
    ): void {
        // Remove existing foliage for this chunk
        this.removeFoliageForChunk(chunkKey);
        this.rng.setSeed(foliageSeed(this.seed, chunkKey));

        if (surfaceVoxels.length === 0) return;

        // Collect positions by foliage type
        const grassPositions: THREE.Matrix4[] = [];
        const flowerPositions: Array<{matrix: THREE.Matrix4, color: number}> = [];
        const pebblePositions: THREE.Matrix4[] = [];
        const cactusPositions: THREE.Matrix4[] = [];
        const customPositions = new Map<string, THREE.Matrix4[]>();
        for (const custom of this.customFoliage) {
            customPositions.set(custom.name, []);
        }

        for (const voxel of surfaceVoxels) {
            if (this.rng.next() > BASE_SPAWN_CHANCE * (0.65 + foliagePatch(voxel.worldX, voxel.worldZ) * 0.7)) continue;
            if (this.isPositionOccupied(voxel.worldX, voxel.worldZ)) continue;
            if (this.isFoliageExcluded(voxel.worldX, voxel.worldZ)) continue;

            const terrainType = getTerrainType(voxel.blockType);
            const terrainProps = this.terrainRegistry.getType(terrainType);
            if (!terrainProps || terrainProps.foliageType === FoliageType.NONE) continue;

            const matrix = new THREE.Matrix4().setPosition(voxel.worldX, voxel.worldY, voxel.worldZ);
            const foliageType = terrainProps.foliageType;

            // Custom foliage claims the spot first, before the built-in types below.
            const custom = this.customFoliage.find(c => c.foliageTypes.includes(foliageType) && this.rng.next() < c.spawnChance);
            if (custom) {
                customPositions.get(custom.name)!.push(matrix);
                continue;
            }

            // Default foliage by terrain type
            switch (foliageType) {
                case FoliageType.MEADOW:
                case FoliageType.FOREST:
                case FoliageType.FIELD:
                    if (this.rng.next() > DEFAULT_FLOWER_CHANCE) {
                        grassPositions.push(matrix);
                    } else {
                        const colorIdx = Math.floor(this.rng.next() * DEFAULT_PETAL_COLORS.length);
                        flowerPositions.push({ matrix, color: DEFAULT_PETAL_COLORS[colorIdx] ?? 0xFF69B4 });
                    }
                    break;
                case FoliageType.BEACH:
                    if (this.rng.next() < BEACH_PEBBLE_CHANCE) pebblePositions.push(matrix);
                    break;
                case FoliageType.DESERT:
                    if (this.rng.next() < DESERT_CACTUS_CHANCE) cactusPositions.push(matrix);
                    break;
            }
        }

        // Create instanced meshes for this chunk. Each creator returns [] for an empty list.
        const chunkMeshList: THREE.InstancedMesh[] = [
            ...this.createGrassInstancesForChunk(grassPositions),
            ...this.createFlowerInstancesForChunk(flowerPositions),
            ...this.createPebbleInstancesForChunk(pebblePositions),
            ...this.createCactusInstancesForChunk(cactusPositions),
        ];

        // Custom foliage
        const ctx = this.getCreatorContextForChunk(chunkMeshList);
        for (const custom of this.customFoliage) {
            const positions = customPositions.get(custom.name)!;
            if (positions.length > 0) custom.creator(positions, ctx);
        }

        // Parent all meshes to terrain chunk and store for later cleanup
        if (chunkMeshList.length > 0) {
            for (const mesh of chunkMeshList) {
                chunkParent.add(mesh);
            }
            this.chunkMeshes.set(chunkKey, chunkMeshList);
        }
    }
    
    /**
     * Remove foliage for a specific chunk (when terrain is regenerated).
     */
    removeFoliageForChunk(chunkKey: string): void {
        const meshes = this.chunkMeshes.get(chunkKey);
        if (!meshes) return;

        for (const mesh of meshes) {
            disposeMesh(mesh);
            const idx = this.instancedMeshes.indexOf(mesh);
            if (idx >= 0) this.instancedMeshes.splice(idx, 1);
        }
        const removed = new Set(meshes);
        this.foliagePositions = this.foliagePositions.filter(pos => !pos.instances.some(instance => removed.has(instance.mesh)));
        this.chunkMeshes.delete(chunkKey);
    }
    
    /**
     * Get creator context for custom foliage within a specific chunk.
     */
    private getCreatorContextForChunk(chunkMeshList: THREE.InstancedMesh[]): FoliageCreatorContext {
        const spread = this.terrainVoxelSize * 0.6;
        return {
            rng: this.rng,
            voxelSize: FOLIAGE_VOXEL_SIZE,
            parent: this.foliageParent,
            addMesh: (mesh: THREE.InstancedMesh) => {
                this.foliageParent.add(mesh);
                this.instancedMeshes.push(mesh);
                chunkMeshList.push(mesh);
            },
            getRandomOffset: () => (this.rng.next() - 0.5) * spread
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // Chunk-based foliage creation methods
    // ═══════════════════════════════════════════════════════════════════════
    
    private createGrassInstancesForChunk(positions: THREE.Matrix4[]): THREE.InstancedMesh[] {
        if (positions.length === 0) return [];
        const bladesPerPatch = 5;
        const totalBlades = positions.length * bladesPerPatch;

        const bladeGeo = createBlockBlade(FOLIAGE_VOXEL_SIZE);

        const handle = createFoliageMaterial({ appearance: this.appearance, block: true, map: null, selectiveTint: false });
        const mesh = new THREE.InstancedMesh(bladeGeo, handle.material, totalBlades);
        mesh.name = 'VoxelGrassInstanced';

        const tempMatrix = new THREE.Matrix4();
        const tempPos = new THREE.Vector3();
        const color = new THREE.Color();
        const spread = this.terrainVoxelSize * 0.6;

        let instanceIdx = 0;
        for (const baseMatrix of positions) {
            tempPos.setFromMatrixPosition(baseMatrix);
            const instances: FoliageInstanceRef[] = [];

            for (let b = 0; b < bladesPerPatch; b++) {
                const offsetX = (this.rng.next() - 0.5) * spread;
                const offsetZ = (this.rng.next() - 0.5) * spread;
                const voxelHeight = 2 + Math.floor(this.rng.next() * 5);

                tempMatrix.makeRotationY(this.rng.next() * Math.PI * 2);
                tempMatrix.scale(new THREE.Vector3(0.65 + this.rng.next() * 0.35, voxelHeight, 0.65 + this.rng.next() * 0.35));
                tempMatrix.setPosition(tempPos.x + offsetX, tempPos.y, tempPos.z + offsetZ);
                const patch = foliagePatch(tempPos.x, tempPos.z);
                color.copy(GRASS_BASE_COLOR).lerp(GRASS_TIP_COLOR, patch * 0.6);
                color.multiplyScalar(0.85 + this.rng.next() * 0.3);
                mesh.setColorAt(instanceIdx, color);

                instances.push({ mesh, instanceIndex: instanceIdx });
                mesh.setMatrixAt(instanceIdx++, tempMatrix);
            }

            this.foliagePositions.push({
                x: tempPos.x, y: tempPos.y, z: tempPos.z,
                instances, color: 0x3a7d32
            });
        }

        prepareFoliageInstances(mesh, handle);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        this.foliageParent.add(mesh);
        this.instancedMeshes.push(mesh);
        return [mesh];
    }
    
    private createFlowerInstancesForChunk(positions: Array<{matrix: THREE.Matrix4, color: number}>): THREE.InstancedMesh[] {
        if (positions.length === 0) return [];

        // Create merged flower geometry with vertex colors (1 draw call instead of 6)
        const v = FOLIAGE_VOXEL_SIZE;

        // One box part of the flower: coloured, and flagged as petal (instance-tinted) or not.
        const part = (width: number, height: number, depth: number, offset: [number, number, number], color: number, isPetal: boolean): THREE.BoxGeometry => {
            const geo = new THREE.BoxGeometry(width, height, depth);
            geo.translate(...offset);
            this.setGeometryVertexColor(geo, new THREE.Color(color));
            const mask = new Float32Array(geo.getAttribute('position').count);
            if (isPetal) mask.fill(1);
            geo.setAttribute('foliagePetal', new THREE.Float32BufferAttribute(mask, 1));
            return geo;
        };

        // Stem (3 voxels) + yellow center + 4 petals = 6 boxes.
        // Petals are white here: the per-instance foliageTint below carries their real colour.
        const parts = [
            part(v, v * 3, v, [0, v * 1.5, 0], 0x3a7d32, false),
            part(v, v, v, [0, v * 3.5, 0], 0xFFFF00, false),
            part(v, v, v, [v, v * 3.5, 0], 0xffffff, true),
            part(v, v, v, [-v, v * 3.5, 0], 0xffffff, true),
            part(v, v, v, [0, v * 3.5, v], 0xffffff, true),
            part(v, v, v, [0, v * 3.5, -v], 0xffffff, true),
        ];

        const mergedGeo = mergeGeometries(parts);
        for (const p of parts) p.dispose();
        if (!mergedGeo) return [];

        addFoliageAttributes(mergedGeo, v * 4, 0.55);
        const handle = createFoliageMaterial({ appearance: this.appearance, block: true, map: null, selectiveTint: true });
        const mesh = new THREE.InstancedMesh(mergedGeo, handle.material, positions.length);
        const tints = new Float32Array(positions.length * 3);
        mesh.name = 'VoxelFlowerInstanced';

        const tempPos = new THREE.Vector3();
        const color = new THREE.Color();
        const flowerMatrix = new THREE.Matrix4();
        const scale = new THREE.Vector3();

        positions.forEach((p, i) => {
            tempPos.setFromMatrixPosition(p.matrix);
            flowerMatrix.makeRotationY(this.rng.next() * Math.PI * 2);
            flowerMatrix.scale(scale.set(1, 0.85 + this.rng.next() * 0.65, 1));
            flowerMatrix.setPosition(tempPos);
            mesh.setMatrixAt(i, flowerMatrix);
            color.set(p.color);
            tints.set([color.r, color.g, color.b], i * 3);

            this.foliagePositions.push({
                x: tempPos.x, y: tempPos.y, z: tempPos.z,
                instances: [{ mesh, instanceIndex: i }],
                color: p.color
            });
        });

        mergedGeo.setAttribute('foliageTint', new THREE.InstancedBufferAttribute(tints, 3));
        prepareFoliageInstances(mesh, handle);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        this.foliageParent.add(mesh);
        this.instancedMeshes.push(mesh);
        return [mesh];
    }
    
    private setGeometryVertexColor(geometry: THREE.BufferGeometry, color: THREE.Color): void {
        const count = geometry.attributes.position?.count ?? 0;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    
    private createPebbleInstancesForChunk(positions: THREE.Matrix4[]): THREE.InstancedMesh[] {
        if (positions.length === 0) return [];
        const pebbleGeo = new THREE.BoxGeometry(
            FOLIAGE_VOXEL_SIZE * 2,
            FOLIAGE_VOXEL_SIZE,
            FOLIAGE_VOXEL_SIZE * 2
        );
        pebbleGeo.translate(0, FOLIAGE_VOXEL_SIZE * 0.5, 0);

        const pebbleMaterial = new THREE.MeshLambertMaterial({ color: 0x888888 });
        const mesh = new THREE.InstancedMesh(pebbleGeo, pebbleMaterial, positions.length);
        mesh.name = 'VoxelPebbleInstanced';

        const tempMatrix = new THREE.Matrix4();
        const tempPos = new THREE.Vector3();
        const scale = new THREE.Vector3();

        positions.forEach((matrix, i) => {
            const scaleX = 0.5 + this.rng.next() * 0.5;
            const scaleZ = 0.5 + this.rng.next() * 0.5;
            const rotation = this.rng.next() * Math.PI * 2;

            tempPos.setFromMatrixPosition(matrix);
            tempMatrix.makeRotationY(rotation);
            tempMatrix.scale(scale.set(scaleX, 1, scaleZ));
            tempMatrix.setPosition(tempPos);

            mesh.setMatrixAt(i, tempMatrix);

            this.foliagePositions.push({
                x: tempPos.x, y: tempPos.y, z: tempPos.z,
                instances: [{ mesh, instanceIndex: i }],
                color: 0x888888
            });
        });

        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        this.foliageParent.add(mesh);
        this.instancedMeshes.push(mesh);
        return [mesh];
    }

    private createCactusInstancesForChunk(positions: THREE.Matrix4[]): THREE.InstancedMesh[] {
        if (positions.length === 0) return [];

        const cactusMaterial = new THREE.MeshLambertMaterial({ color: 0x2e8b57 });

        // Main trunk
        const trunkGeo = new THREE.BoxGeometry(
            FOLIAGE_VOXEL_SIZE * 2,
            FOLIAGE_VOXEL_SIZE * 10,
            FOLIAGE_VOXEL_SIZE * 2
        );
        trunkGeo.translate(0, FOLIAGE_VOXEL_SIZE * 5, 0);
        const trunkMesh = new THREE.InstancedMesh(trunkGeo, cactusMaterial, positions.length);
        trunkMesh.name = 'VoxelCactusTrunkInstanced';

        // Arms
        const armGeo = new THREE.BoxGeometry(
            FOLIAGE_VOXEL_SIZE * 4,
            FOLIAGE_VOXEL_SIZE * 2,
            FOLIAGE_VOXEL_SIZE * 2
        );
        const leftArm = new THREE.InstancedMesh(armGeo, cactusMaterial, positions.length);
        const rightArm = new THREE.InstancedMesh(armGeo, cactusMaterial, positions.length);
        leftArm.name = 'VoxelCactusLeftArmInstanced';
        rightArm.name = 'VoxelCactusRightArmInstanced';

        const tempMatrix = new THREE.Matrix4();
        const tempPos = new THREE.Vector3();

        positions.forEach((matrix, i) => {
            tempPos.setFromMatrixPosition(matrix);

            trunkMesh.setMatrixAt(i, matrix);

            const armHeight = FOLIAGE_VOXEL_SIZE * (4 + this.rng.next() * 4);

            tempMatrix.setPosition(
                tempPos.x - FOLIAGE_VOXEL_SIZE * 2,
                tempPos.y + armHeight,
                tempPos.z
            );
            leftArm.setMatrixAt(i, tempMatrix);

            tempMatrix.setPosition(
                tempPos.x + FOLIAGE_VOXEL_SIZE * 2,
                tempPos.y + armHeight + FOLIAGE_VOXEL_SIZE * 2,
                tempPos.z
            );
            rightArm.setMatrixAt(i, tempMatrix);

            this.foliagePositions.push({
                x: tempPos.x, y: tempPos.y, z: tempPos.z,
                instances: [
                    { mesh: trunkMesh, instanceIndex: i },
                    { mesh: leftArm, instanceIndex: i },
                    { mesh: rightArm, instanceIndex: i }
                ],
                color: 0x2e8b57
            });
        });

        const meshes = [trunkMesh, leftArm, rightArm];
        for (const m of meshes) {
            m.instanceMatrix.needsUpdate = true;
            m.castShadow = true;
            m.receiveShadow = true;
            this.foliageParent.add(m);
            this.instancedMeshes.push(m);
        }

        return meshes;
    }

    /**
     * Hide the foliage currently growing within `radius` of (x, z). One-shot: a later
     * regeneration of the chunk may regrow it — use `clearFoliageInRect` or
     * `addFoliageExclusion` for a footprint that must stay clear.
     */
    clearFoliageAt(x: number, z: number, radius: number): void {
        const radiusSq = radius * radius;
        this.hideFoliageWhere(pos => (pos.x - x) ** 2 + (pos.z - z) ** 2 <= radiusSq);
    }

    /**
     * Clear foliage inside an axis-aligned world rectangle and keep it clear: current
     * instances are hidden and the rectangle is excluded from every later chunk
     * (re)generation. Returns the exclusion id, releasable via `removeFoliageExclusion`.
     */
    clearFoliageInRect(minX: number, minZ: number, maxX: number, maxZ: number): string {
        const id = `rect_${this.nextAnonymousExclusionId++}`;
        this.addFoliageExclusion(id, minX, minZ, maxX, maxZ);
        return id;
    }

    /**
     * Register (or replace) a named no-foliage rectangle — typically a building footprint.
     * Hides existing foliage inside it now and skips it whenever a chunk is regenerated.
     */
    addFoliageExclusion(id: string, minX: number, minZ: number, maxX: number, maxZ: number): void {
        const rect: FoliageExclusionRect = {
            minX: Math.min(minX, maxX), minZ: Math.min(minZ, maxZ),
            maxX: Math.max(minX, maxX), maxZ: Math.max(minZ, maxZ),
        };
        this.exclusions.set(id, rect);
        this.hideFoliageWhere(pos => rectContains(rect, pos.x, pos.z));
    }

    /**
     * Drop a no-foliage rectangle (e.g. a temporary building was removed). Foliage
     * returns once the covering chunks are regenerated. Returns false for an unknown id.
     */
    removeFoliageExclusion(id: string): boolean {
        return this.exclusions.delete(id);
    }

    /** True when (x, z) lies inside any registered no-foliage rectangle. */
    isFoliageExcluded(x: number, z: number): boolean {
        for (const rect of this.exclusions.values()) {
            if (rectContains(rect, x, z)) return true;
        }
        return false;
    }

    private hideFoliageWhere(predicate: (pos: { x: number; z: number }) => boolean): void {
        this.foliagePositions = this.foliagePositions.filter(pos => {
            if (!predicate(pos)) return true;
            this.hideFoliageItem(pos);
            return false;
        });
    }
    
    /**
     * Detach foliage in a sphere - spawns debris that flies off and disappears.
     * Call this when terrain blocks are detached to also destroy foliage on them.
     * 
     * @param centerX - Center X of explosion
     * @param centerY - Center Y of explosion  
     * @param centerZ - Center Z of explosion
     * @param radius - Radius to affect
     * @param impulseStrength - How fast debris flies (default 5)
     * @param impulseUp - Upward impulse component (default 3)
     */
    detachFoliageInSphere(
        centerX: number,
        centerY: number,
        centerZ: number,
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 3
    ): void {
        const radiusSq = radius * radius;
        this.foliagePositions = this.foliagePositions.filter(pos => {
            const distSq = (pos.x - centerX) ** 2 + (pos.y - centerY) ** 2 + (pos.z - centerZ) ** 2;
            if (distSq > radiusSq) return true;
            this.spawnFoliageDebris(pos, centerX, centerY, centerZ, impulseStrength, impulseUp);
            this.hideFoliageItem(pos);
            return false;
        });
    }

    /**
     * Hide all instances for a foliage item by scaling them to 0
     */
    private hideFoliageItem(pos: { instances: FoliageInstanceRef[] }): void {
        const updatedMeshes = new Set<THREE.InstancedMesh>();

        for (const inst of pos.instances) {
            const mesh = inst.mesh;

            mesh.setMatrixAt(inst.instanceIndex, HIDDEN_INSTANCE_MATRIX);
            const alive = mesh.geometry.getAttribute('foliageRoot');
            if (alive instanceof THREE.InstancedBufferAttribute) {
                alive.setW(inst.instanceIndex, 0); alive.needsUpdate = true;
            }
            updatedMeshes.add(mesh);
        }

        // Mark all affected meshes as needing update
        for (const mesh of updatedMeshes) {
            mesh.instanceMatrix.needsUpdate = true;
        }
    }
    
    /**
     * Spawn a debris mesh for destroyed foliage
     */
    private spawnFoliageDebris(
        pos: { x: number; y: number; z: number; color: number },
        centerX: number,
        centerY: number,
        centerZ: number,
        impulseStrength: number,
        impulseUp: number
    ): void {
        // Create a simple box mesh for debris
        const size = FOLIAGE_VOXEL_SIZE * 2;
        const geometry = new THREE.BoxGeometry(size, size * 2, size);
        
        const material = new THREE.MeshLambertMaterial({ color: pos.color });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(pos.x, pos.y + size, pos.z);
        mesh.castShadow = true;
        
        // Calculate velocity direction (away from explosion center + up)
        const dx = pos.x - centerX;
        const dy = pos.y - centerY;
        const dz = pos.z - centerZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        
        // Normalize and apply impulse
        const velocity = new THREE.Vector3(
            (dx / dist) * impulseStrength + (Math.random() - 0.5) * 2,
            impulseUp + Math.random() * 2,
            (dz / dist) * impulseStrength + (Math.random() - 0.5) * 2
        );
        
        // Random angular velocity
        const angularVel = new THREE.Vector3(
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10
        );
        
        // Random lifetime between 1.5 and 3 seconds
        const maxLifetime = 1500 + Math.random() * 1500;
        
        this.foliageParent.add(mesh);
        this.foliageDebris.push({
            mesh,
            velocity,
            angularVel,
            lifetime: 0,
            maxLifetime
        });
    }
    
    /**
     * Update foliage debris physics and cleanup.
     * Call this every frame to animate debris.
     * 
     * @param deltaTime - Time since last frame in seconds
     */
    updateDebris(deltaTime: number): void {
        const gravity = -20; // m/s²
        const deltaMs = deltaTime * 1000;
        const fadeTime = 300;
        const killY = -100;

        for (let i = this.foliageDebris.length - 1; i >= 0; i--) {
            const debris = this.foliageDebris[i];
            if (!debris) continue;

            debris.lifetime += deltaMs;

            // Check if expired or fell too far
            if (debris.lifetime >= debris.maxLifetime || debris.mesh.position.y < killY) {
                // Fade out in the last 300ms, then remove
                const timeLeft = debris.maxLifetime - debris.lifetime + fadeTime;
                if (timeLeft <= 0 || debris.mesh.position.y < killY) {
                    disposeMesh(debris.mesh);
                    this.foliageDebris.splice(i, 1);
                    continue;
                }
                // Fade opacity
                const mat = debris.mesh.material as THREE.MeshLambertMaterial;
                mat.transparent = true;
                mat.opacity = timeLeft / fadeTime;
            }

            // Apply gravity to velocity
            debris.velocity.y += gravity * deltaTime;

            // Update position and rotation
            debris.mesh.position.addScaledVector(debris.velocity, deltaTime);
            debris.mesh.rotation.x += debris.angularVel.x * deltaTime;
            debris.mesh.rotation.y += debris.angularVel.y * deltaTime;
            debris.mesh.rotation.z += debris.angularVel.z * deltaTime;

            // Simple ground collision (bounce)
            if (debris.mesh.position.y < 0.1) {
                debris.mesh.position.y = 0.1;
                debris.velocity.y *= -0.3; // Bounce with energy loss
                debris.velocity.x *= 0.8; // Friction
                debris.velocity.z *= 0.8;
                debris.angularVel.multiplyScalar(0.5);
            }
        }
    }

    /**
     * Get count of active foliage debris
     */
    getDebrisCount(): number {
        return this.foliageDebris.length;
    }

    dispose(): void {
        // Clean up instanced meshes
        for (const mesh of this.instancedMeshes) disposeMesh(mesh);
        this.instancedMeshes = [];
        this.chunkMeshes.clear();

        // Clean up debris
        for (const debris of this.foliageDebris) disposeMesh(debris.mesh);
        this.foliageDebris = [];
        this.foliagePositions = [];
        this.exclusions.clear();

        this.foliageParent.removeFromParent();
    }
}
