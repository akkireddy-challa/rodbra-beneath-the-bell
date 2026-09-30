import * as THREE from 'three';
import { VoxelFoliageSystem, type SurfaceVoxel } from 'engine/VoxelFoliageSystem.js';
import { TerrainTypeRegistry, FoliageType } from 'engine/TerrainTypes.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

/** Real addon geometry + material factories; the unit runner mocks Three's ESM addons. */
export function checkFoliageChunkLifecycle(): object {
    const scene = new THREE.Scene(), registry = new TerrainTypeRegistry();
    registry.registerType(1, { name: 'Meadow', foliageType: FoliageType.MEADOW, canPlaceTrees: false, canPlaceRocks: false });
    const provider = { getHeightAt: () => -2 } as unknown as TerrainHeightProvider;
    const system = new VoxelFoliageSystem(scene, 80, 80, 919, registry, provider, { terrainVoxelSize: 0.25, getTerrainHeight: () => -2 });
    const surface = (offset: number): SurfaceVoxel[] => Array.from({ length: 144 }, (_, i) => ({
        worldX: offset + (i % 12) * 0.25, worldY: -2, worldZ: Math.floor(i / 12) * 0.25, blockType: 1,
    }));
    const a = new THREE.Group(), b = new THREE.Group(); scene.add(a, b);
    const bSurface = surface(40);
    const snapshot = (): string => JSON.stringify(b.children.map(child => {
        const mesh = child as THREE.InstancedMesh;
        return { name: mesh.name, matrices: [...mesh.instanceMatrix.array], colors: mesh.instanceColor ? [...mesh.instanceColor.array] : null };
    }));
    try {
        system.generateFoliageForChunk('0,0', surface(0), a, type => type);
        system.generateFoliageForChunk('1,0', bSurface, b, type => type);
        const original = snapshot();
        system.removeFoliageForChunk('0,0');
        if (a.children.length) throw new Error('Removed chunk retains foliage');
        const survivors = b.children.filter(child => child instanceof THREE.InstancedMesh);
        if (!survivors.length) throw new Error('Lifecycle fixture has no foliage');
        system.detachFoliageInSphere(41, -2, 1, 10);
        if (!system.getDebrisCount()) throw new Error('Destruction did not find surviving chunk plants');
        const matrix = new THREE.Matrix4();
        for (const mesh of survivors) for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, matrix);
            if (matrix.elements.some(value => value !== 0 && value !== 1)) throw new Error('Destruction missed a surviving instance');
            if (matrix.elements[0] !== 0) throw new Error('Destroyed foliage is still visible');
            const root = mesh.geometry.getAttribute('foliageRoot');
            if (root.getW(i) !== 0) throw new Error('Destroyed plant below sea level can still bend into view');
        }
        system.generateFoliageForChunk('1,0', bSurface, b, type => type);
        if (snapshot() !== original) throw new Error('Regeneration reshuffled the foliage');
        const flower = b.children.find(child => child.name === 'VoxelFlowerInstanced') as THREE.InstancedMesh;
        if (!flower || flower.instanceColor) throw new Error('Flower tint must not multiply the whole stem');
        const petal = flower.geometry.getAttribute('foliagePetal'), colors = flower.geometry.getAttribute('color');
        let greenStem = false;
        for (let i = 0; i < petal.count; i++) if (petal.getX(i) === 0 && colors.getY(i) > colors.getX(i)) greenStem = true;
        if (!greenStem) throw new Error('Flower lost its green stem');
        system.dispose();
        if (a.children.length || b.children.length || scene.children.some(child => child.name === 'VoxelFoliage')) throw new Error('Disposal retains foliage objects');
        return { regeneration: 'stable', chunkRemoval: 'correct', destructionBelowSeaLevel: 'hidden', flowerStem: 'green', disposal: 'clean' };
    } finally { system.dispose(); }
}
