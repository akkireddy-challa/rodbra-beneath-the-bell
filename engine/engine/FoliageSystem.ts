import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SeededRandom } from 'engine/SeededRandom.js';
import { createFoliageMaterial, DEFAULT_FOLIAGE_APPEARANCE, type FoliageAppearance, type FoliageMaterialHandle } from 'engine/foliage/FoliageMaterial.js';
import { createMeadowTuft, createMeadowFlower, addFoliageAttributes, translateFoliage, foliageSeed } from 'engine/foliage/FoliageGeometry.js';
import type { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import { FoliageType } from 'engine/TerrainTypes.js';
import type { HeightmapSystem } from 'engine/HeightmapSystem.js';

export interface FoliageRegion {
    centerX: number;
    centerZ: number;
    mesh: THREE.Mesh | null;
    recreate: () => THREE.Mesh | null;
}

export class FoliageSystem {
    private world: THREE.Object3D;
    private worldSizeX: number;
    private worldSizeZ: number;
    private resolution: number;
    private rng: SeededRandom;
    private terrainRegistry: TerrainTypeRegistry;
    private heightmapSystem: HeightmapSystem;
    private foliageTexture: THREE.Texture | null = null;
    private foliageMaterial: THREE.Material | null = null;
    private foliageMaterialHandle: FoliageMaterialHandle | null = null;
    readonly appearance: FoliageAppearance;
    private regions: Map<string, FoliageRegion> = new Map();
    private regionSizeMeters: number = 8;
    private foliageRegionsParent: THREE.Group;

    constructor(
        world: THREE.Object3D,
        worldSizeX: number,
        worldSizeZ: number,
        resolution: number,
        seed: number,
        terrainRegistry: TerrainTypeRegistry,
        heightmapSystem: HeightmapSystem,
        appearance: Partial<FoliageAppearance> = {}
    ) {
        this.appearance = { ...DEFAULT_FOLIAGE_APPEARANCE, ...appearance };
        this.world = world;
        this.worldSizeX = worldSizeX;
        this.worldSizeZ = worldSizeZ;
        this.resolution = resolution;
        this.rng = new SeededRandom(seed);
        this.terrainRegistry = terrainRegistry;
        this.heightmapSystem = heightmapSystem;

        // NOTE: Foliage texture/material is NOT initialized here.
        // Template code must call initializeFoliageTexture() with desired colors
        // before calling generateFoliage().
        // This allows templates to customize colors (e.g., purple grass, blue flowers).

        // Create parent object for all foliage regions
        this.foliageRegionsParent = new THREE.Group();
        this.foliageRegionsParent.name = 'FoliageRegions';
        this.world.add(this.foliageRegionsParent);
    }

    /**
     * Initialize the foliage texture with custom colors.
     * Must be called from template code BEFORE calling generateFoliage().
     *
     * AI AGENTS: Call this method to customize foliage colors!
     *
     * @param colors - Object with color strings for grass, flowerPetals, flowerStems, and pebbles
     *                 Default: { grass: '#679341', flowerPetals: '#f7da75', flowerStems: '#42753c', pebbles: '#808080' }
     *
     * Example - Purple grass with blue flowers:
     */
    public initializeFoliageTexture(colors?: {
        grass?: string;
        flowerPetals?: string;
        flowerStems?: string;
        pebbles?: string;
    }): void {
        const grassColor = colors?.grass ?? '#679341';
        const flowerPetalsColor = colors?.flowerPetals ?? '#f7da75';
        const flowerStemsColor = colors?.flowerStems ?? '#42753c';
        const pebblesColor = colors?.pebbles ?? '#808080';

        // Create a small 1x4 texture (1 pixel wide, 4 pixels tall) - power of 2
        // Each pixel represents one color
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 4;
        const ctx = canvas.getContext('2d')!;

        // Pixel 0 (row 0): Grass color
        ctx.fillStyle = grassColor;
        ctx.fillRect(0, 0, 1, 1);

        // Pixel 1 (row 1): Flower petals color
        ctx.fillStyle = flowerPetalsColor;
        ctx.fillRect(0, 1, 1, 1);

        // Pixel 2 (row 2): Flower stems color
        ctx.fillStyle = flowerStemsColor;
        ctx.fillRect(0, 2, 1, 1);

        // Pixel 3 (row 3): Pebbles color
        ctx.fillStyle = pebblesColor;
        ctx.fillRect(0, 3, 1, 1);

        this.foliageTexture?.dispose();
        this.foliageMaterial?.dispose();
        this.foliageTexture = new THREE.CanvasTexture(canvas);
        this.foliageTexture.colorSpace = THREE.SRGBColorSpace;
        // Use nearest neighbor for pixel-perfect color selection
        this.foliageTexture.magFilter = THREE.NearestFilter;
        this.foliageTexture.minFilter = THREE.NearestFilter;
        this.foliageTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.foliageTexture.wrapT = THREE.ClampToEdgeWrapping;
        // Disable mipmap generation for very small textures to avoid WebGL warnings
        this.foliageTexture.generateMipmaps = false;

        this.foliageMaterialHandle = createFoliageMaterial({ appearance: this.appearance, block: false, map: this.foliageTexture, selectiveTint: false });
        this.foliageMaterial = this.foliageMaterialHandle.material;
        for (const region of this.regions.values()) if (region.mesh) {
            region.mesh.material = this.foliageMaterial;
            this.foliageMaterialHandle.bind(region.mesh);
        }
    }

    generateFoliage(): void {
        this.clearRegions();
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;
        const regionSizeMeters = this.regionSizeMeters;
        // Calculate number of regions needed to cover each dimension
        const regionsX = Math.ceil(this.worldSizeX / regionSizeMeters);
        const regionsZ = Math.ceil(this.worldSizeZ / regionSizeMeters);

        for (let regionZ = 0; regionZ < regionsZ; regionZ++) {
            for (let regionX = 0; regionX < regionsX; regionX++) {
                // Calculate region center: start at -halfWorld, add regionSizeMeters/2 for first region center
                // then add regionSizeMeters for each subsequent region
                const centerX = -halfWorldX + (regionSizeMeters / 2) + (regionX * regionSizeMeters);
                const centerZ = -halfWorldZ + (regionSizeMeters / 2) + (regionZ * regionSizeMeters);
                
                // Check if center is within world bounds
                if (centerX < -halfWorldX || centerX > halfWorldX || 
                    centerZ < -halfWorldZ || centerZ > halfWorldZ) {
                    continue;
                }
                
                const terrainType = this.heightmapSystem.getTerrainTypeAt(centerX, centerZ);
                const terrainProps = this.terrainRegistry.getType(terrainType);
                
                if (terrainProps && terrainProps.foliageType !== FoliageType.NONE) {
                    const region = this.createFoliageRegion(centerX, centerZ, terrainProps.foliageType);
                    if (region && region.mesh) {
                        this.foliageRegionsParent.add(region.mesh);
                        const key = `${regionX}_${regionZ}`;
                        this.regions.set(key, region);
                    }
                }
            }
        }
    }

    private createFoliageRegion(centerX: number, centerZ: number, foliageType: FoliageType): FoliageRegion | null {
        const regionWorldSize = this.regionSizeMeters;
        const geometries: THREE.BufferGeometry[] = [];

        const rng = new SeededRandom(
            foliageSeed(this.rng.getSeed(), `${centerX},${centerZ}`)
        );

        const density = this.getFoliageDensity(foliageType);
        const count = Math.floor(density * regionWorldSize * regionWorldSize);

        for (let i = 0; i < count; i++) {
            const localX = (rng.next() - 0.5) * regionWorldSize;
            const localZ = (rng.next() - 0.5) * regionWorldSize;
            const worldX = centerX + localX;
            const worldZ = centerZ + localZ;

            const terrainType = this.heightmapSystem.getTerrainTypeAt(worldX, worldZ);
            const terrainProps = this.terrainRegistry.getType(terrainType);
            
            if (!terrainProps || terrainProps.foliageType === FoliageType.NONE) {
                continue;
            }

            const height = this.heightmapSystem.getHeightAt(worldX, worldZ);
            const positionFoliageType = terrainProps.foliageType;
            const foliageGeom = this.createFoliageGeometry(positionFoliageType, rng, worldX, worldZ, height);
            
            if (foliageGeom) {
                if (!foliageGeom.hasAttribute('foliageRoot')) addFoliageAttributes(foliageGeom, 1, 0);
                translateFoliage(foliageGeom, localX, height, localZ);
                geometries.push(foliageGeom);
            }
        }

        if (geometries.length === 0) {
            return null;
        }

        if (!this.foliageMaterial) {
            return null;
        }

        const mergedGeometry = mergeGeometries(geometries);
        for (const geometry of geometries) geometry.dispose();
        mergedGeometry.computeBoundingBox(); mergedGeometry.computeBoundingSphere();
        mergedGeometry.boundingBox!.expandByScalar(0.6); mergedGeometry.boundingSphere!.radius += 0.6;
        const mesh = new THREE.Mesh(mergedGeometry, this.foliageMaterial);
        this.foliageMaterialHandle!.bind(mesh);
        mesh.position.set(centerX, 0, centerZ);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `FoliageRegion_${centerX.toFixed(1)}_${centerZ.toFixed(1)}`;

        const recreate = () => {
            if (mesh.parent) {
                mesh.parent.remove(mesh);
            }
            if (mergedGeometry) {
                mergedGeometry.dispose();
            }
            return this.createFoliageRegion(centerX, centerZ, foliageType)?.mesh ?? null;
        };

        return {
            centerX,
            centerZ,
            mesh,
            recreate
        };
    }

    private createFoliageGeometry(
        foliageType: FoliageType,
        rng: SeededRandom,
        x: number,
        z: number,
        height: number
    ): THREE.BufferGeometry | null {
        switch (foliageType) {
            case FoliageType.MEADOW:
                return this.createGrassTuftGeometry(rng, x, z, height);
            case FoliageType.FIELD:
                return this.createFieldFoliageGeometry(rng, x, z, height);
            case FoliageType.BEACH:
                return this.createBeachFoliageGeometry(rng, x, z, height);
            case FoliageType.FOREST:
                return this.createForestFoliageGeometry(rng, x, z, height);
            case FoliageType.DESERT:
                return this.createDesertFoliageGeometry(rng, x, z, height);
            default:
                return null;
        }
    }

    private createGrassTuftGeometry(rng: SeededRandom, x: number, z: number, height: number): THREE.BufferGeometry {
        return createMeadowTuft(rng, x, z, height, (px, pz) => this.heightmapSystem.getHeightAt(px, pz));
    }

    private createFieldFoliageGeometry(rng: SeededRandom, x: number, z: number, height: number): THREE.BufferGeometry | null {
        // Create distinct flower patches and grass patches based on position
        // Use a noise-like function based on world position to create patches
        const flowerPatchNoise = Math.sin(x * 0.5) * Math.cos(z * 0.5) + 
                                 Math.sin(x * 0.3) * Math.cos(z * 0.3) * 0.5;
        
        // Create flower patches where noise is high, grass patches where noise is low
        const isFlowerPatch = flowerPatchNoise > 0.3;
        const isGrassPatch = flowerPatchNoise < -0.3;
        
        // Add some randomness within patches for natural variation
        const localRandom = rng.next();
        
        if (isFlowerPatch) {
            // Flower patch: mostly flowers with some grass
            if (localRandom > 0.65) {
                return this.createFlowerGeometry(rng, height);
            } else {
                return this.createGrassTuftGeometry(rng, x, z, height);
            }
        } else if (isGrassPatch) {
            // Grass patch: pure grass
            return this.createGrassTuftGeometry(rng, x, z, height);
        } else {
            // Transition area: mix of both
            if (localRandom > 0.9) {
                return this.createFlowerGeometry(rng, height);
            } else {
                return this.createGrassTuftGeometry(rng, x, z, height);
            }
        }
    }

    private createFlowerGeometry(rng: SeededRandom, _height: number): THREE.BufferGeometry {
        return createMeadowFlower(rng);
    }

    private createBeachFoliageGeometry(rng: SeededRandom, x: number, z: number, height: number): THREE.BufferGeometry | null {
        if (rng.next() > 0.9) {
            // Pebble - small sphere
            const pebbleGeometry = new THREE.SphereGeometry(0.1 + rng.next() * 0.1, 6, 6);
            
            // Set UV coordinates to map to gray pixel (row 3 in 1x4 texture)
            // If V is inverted: pixel 3 = V 0-0.25, center = 0.125
            const uvAttribute = pebbleGeometry.attributes.uv;
            if (uvAttribute) {
                for (let j = 0; j < uvAttribute.count; j++) {
                    uvAttribute.setXY(j, 0, 0.125); // Center of pixel 3 (gray) - if V is inverted
                }
                uvAttribute.needsUpdate = true;
            }
            
            return pebbleGeometry;
        }
        return null;
    }

    private createForestFoliageGeometry(rng: SeededRandom, x: number, z: number, height: number): THREE.BufferGeometry {
        return this.createGrassTuftGeometry(rng, x, z, height);
    }

    private createDesertFoliageGeometry(rng: SeededRandom, x: number, z: number, height: number): THREE.BufferGeometry | null {
        if (rng.next() > 0.95) {
            // Cactus - vertical cylinder
            const cactusGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.5, 6);
            
            // Set UV coordinates to map to green pixel (row 0 in 1x4 texture)
            // If V is inverted: pixel 0 = V 0.75-1.0, center = 0.875
            const uvAttribute = cactusGeometry.attributes.uv;
            if (uvAttribute) {
                for (let j = 0; j < uvAttribute.count; j++) {
                    uvAttribute.setXY(j, 0, 0.875); // Center of pixel 0 (green) - if V is inverted
                }
                uvAttribute.needsUpdate = true;
            }
            
            return cactusGeometry;
        }
        return null;
    }

    private getFoliageDensity(foliageType: FoliageType): number {
        switch (foliageType) {
            case FoliageType.MEADOW:
                return 1.35;
            case FoliageType.FIELD:
                return 1.3;
            case FoliageType.BEACH:
                return 0.1;
            case FoliageType.FOREST:
                return 0.75;
            case FoliageType.DESERT:
                return 0.05;
            default:
                return 0;
        }
    }

    recreateRegionAt(x: number, z: number): void {
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;
        const regionSizeMeters = this.regionSizeMeters;
        const regionX = Math.floor((x + halfWorldX) / regionSizeMeters);
        const regionZ = Math.floor((z + halfWorldZ) / regionSizeMeters);
        
        const key = `${regionX}_${regionZ}`;
        const region = this.regions.get(key);
        
        if (region) {
            region.mesh?.removeFromParent();
            region.mesh?.geometry.dispose();
            this.regions.delete(key);
            const props = this.terrainRegistry.getType(this.heightmapSystem.getTerrainTypeAt(region.centerX, region.centerZ));
            const replacement = this.createFoliageRegion(region.centerX, region.centerZ, props?.foliageType ?? FoliageType.NONE);
            if (replacement?.mesh) {
                this.foliageRegionsParent.add(replacement.mesh);
                this.regions.set(key, replacement);
            }
        }
    }

    clearFoliageAt(x: number, z: number, radius: number): void {
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;
        const regionSizeMeters = this.regionSizeMeters;
        
        const minRegionX = Math.floor((x - radius + halfWorldX) / regionSizeMeters);
        const maxRegionX = Math.floor((x + radius + halfWorldX) / regionSizeMeters);
        const minRegionZ = Math.floor((z - radius + halfWorldZ) / regionSizeMeters);
        const maxRegionZ = Math.floor((z + radius + halfWorldZ) / regionSizeMeters);
        
        for (let rz = minRegionZ; rz <= maxRegionZ; rz++) {
            for (let rx = minRegionX; rx <= maxRegionX; rx++) {
                const key = `${rx}_${rz}`;
                const region = this.regions.get(key);
                
                if (region && region.mesh) {
                    region.mesh.removeFromParent();
                    if (region.mesh.geometry) {
                        region.mesh.geometry.dispose();
                    }
                    this.regions.delete(key);
                }
            }
        }
    }

    private clearRegions(): void {
        for (const region of this.regions.values()) {
            region.mesh?.removeFromParent();
            region.mesh?.geometry.dispose();
        }
        this.regions.clear();
    }

    dispose(): void {
        this.clearRegions();
        this.foliageRegionsParent.removeFromParent();
        if (this.foliageTexture) {
            this.foliageTexture.dispose();
        }
        if (this.foliageMaterial) {
            this.foliageMaterial.dispose();
        }
    }
}

