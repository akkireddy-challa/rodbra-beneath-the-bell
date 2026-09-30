/**
 * `IEditableVoxelVolume` over the shared `VoxelWorld` terrain.
 *
 * Coordinates are world-space voxel min-corners snapped to the terrain
 * grid (`floor(p / voxelSize) * voxelSize`) — the same convention the
 * old `TerrainEditManager` used, so all `VoxelWorld` calls behave
 * identically. Chunk handling is invisible here by construction:
 * `VoxelWorld.setBlock` dirty-marks neighbouring chunks on boundary
 * writes and `updatePhysicsAndMeshing(false)` rebuilds exactly the dirty
 * set (mesh + colliders), so edits anywhere in the world — including
 * across chunk borders — need no chunk awareness from the editor.
 */

import * as THREE from 'three';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { calculateTerrainChecksum } from '../VoxelChecksum.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import {
    type EditVoxel,
    type IEditableVoxelVolume,
    type MaterialPaletteEntry,
    type VolumeCapabilities,
    type VolumeHit,
    type VoxelMaterial,
    blockMaterialPalette,
    blockTypeName,
    defaultBlockMaterial,
    materialsEqual,
} from './VoxelEditTypes.js';

export interface TerrainVolumeDeps {
    scene: THREE.Scene;
    voxelWorld: VoxelWorld;
}

const IDENTITY_QUATERNION = new THREE.Quaternion();

export class TerrainVolume implements IEditableVoxelVolume {
    readonly kind = 'terrain' as const;

    private deps: TerrainVolumeDeps;

    constructor(deps: TerrainVolumeDeps) {
        this.deps = deps;
    }

    /** Swap in a new VoxelWorld after a terrain reload (keeps the session alive). */
    setVoxelWorld(voxelWorld: VoxelWorld): void {
        this.deps.voxelWorld = voxelWorld;
    }

    getVoxelWorld(): VoxelWorld {
        return this.deps.voxelWorld;
    }

    getPickMeshes(): THREE.Object3D[] {
        const meshes: THREE.Object3D[] = [];
        this.deps.scene.traverse((obj) => {
            // VoxelWorld terrain chunk meshes are named VoxelChunk_X_Y_Z.
            if (obj instanceof THREE.Mesh && obj.name.startsWith('VoxelChunk_')) {
                meshes.push(obj);
            }
            if (obj.userData && obj.userData.isVoxelWorld) {
                obj.traverse((child) => {
                    if (child instanceof THREE.Mesh) {
                        meshes.push(child);
                    }
                });
            }
        });
        return meshes;
    }

    pickVoxel(hit: VolumeHit): EditVoxel | null {
        const size = this.deps.voxelWorld.getVoxelSize();
        const snap = (v: number): number => Math.floor(v / size) * size;

        let x = snap(hit.point.x);
        let y = snap(hit.point.y);
        let z = snap(hit.point.z);

        if (this.deps.voxelWorld.getBlock(x, y, z) === 0) {
            // Hit landed on the far side of a face boundary — step half a
            // voxel back along the normal and retry (old TerrainEditManager
            // behaviour, preserved).
            x = snap(hit.point.x - hit.normalWorld.x * size * 0.5);
            y = snap(hit.point.y - hit.normalWorld.y * size * 0.5);
            z = snap(hit.point.z - hit.normalWorld.z * size * 0.5);
            if (this.deps.voxelWorld.getBlock(x, y, z) === 0) return null;
        }

        return this.voxelAt(x, y, z);
    }

    voxelAt(x: number, y: number, z: number): EditVoxel | null {
        const blockType = this.deps.voxelWorld.getBlock(x, y, z) as BlockTypeId;
        if (blockType === 0) return null;
        return this.makeVoxel(x, y, z, blockType);
    }

    addPositionFor(hit: VolumeHit): { x: number; y: number; z: number; size: number } | null {
        const base = this.pickVoxel(hit);
        if (!base) return null;

        const size = base.size;
        const x = base.x + Math.round(hit.normalWorld.x) * size;
        const y = base.y + Math.round(hit.normalWorld.y) * size;
        const z = base.z + Math.round(hit.normalWorld.z) * size;

        if (this.deps.voxelWorld.getBlock(x, y, z) !== 0) return null;
        return { x, y, z, size };
    }

    add(x: number, y: number, z: number, _size: number, material: VoxelMaterial): EditVoxel | null {
        if (material.kind !== 'block') return null;
        if (this.deps.voxelWorld.getBlock(x, y, z) !== 0) return null;

        this.writeBlock(x, y, z, material);
        return this.voxelAt(x, y, z);
    }

    remove(voxel: EditVoxel): boolean {
        if (this.deps.voxelWorld.getBlock(voxel.x, voxel.y, voxel.z) === 0) return false;
        this.deps.voxelWorld.setBlock(voxel.x, voxel.y, voxel.z, 0);
        return true;
    }

    changeMaterial(voxel: EditVoxel, material: VoxelMaterial): EditVoxel | null {
        if (material.kind !== 'block') return null;
        if (this.deps.voxelWorld.getBlock(voxel.x, voxel.y, voxel.z) === 0) return null;

        this.writeBlock(voxel.x, voxel.y, voxel.z, material);
        return this.voxelAt(voxel.x, voxel.y, voxel.z);
    }

    /** Write a block-kind material to a terrain cell, with optional COLOR override. */
    private writeBlock(x: number, y: number, z: number, material: { blockType: BlockTypeId; color: number | null }): void {
        if (material.color !== null) {
            this.deps.voxelWorld.setBlock(x, y, z, material.blockType, material.color);
        } else {
            this.deps.voxelWorld.setBlock(x, y, z, material.blockType);
        }
    }

    sameMaterialNeighbors(voxel: EditVoxel): EditVoxel[] {
        const s = voxel.size;
        const offsets = [
            [0, s, 0], [0, -s, 0],
            [-s, 0, 0], [s, 0, 0],
            [0, 0, -s], [0, 0, s],
        ] as const;

        const out: EditVoxel[] = [];
        for (const [dx, dy, dz] of offsets) {
            const neighbor = this.voxelAt(voxel.x + dx, voxel.y + dy, voxel.z + dz);
            if (neighbor && materialsEqual(neighbor.material, voxel.material)) {
                out.push(neighbor);
            }
        }
        return out;
    }

    /**
     * Terrain voxels are atlas block types on a shared world grid: they have no
     * material-slot table, and "similar color" is meaningless when the material
     * IS the block type. Every per-voxel tool stays hidden.
     */
    capabilities(): VolumeCapabilities {
        return { materials: false, similaritySelect: false, paintColor: false };
    }

    selectSimilar(_anchor: EditVoxel, _threshold: number): EditVoxel[] {
        return [];
    }

    getMaterialSlots(): VoxelSlot[] {
        return [];
    }

    setSlot(_voxel: EditVoxel, _slot: number): EditVoxel | null {
        return null;
    }

    createMaterialSlot(_name: string, _emissive: number, _materialClass?: string): number | null {
        return null;
    }

    setSlotEmissive(_slot: number, _emissive: number): boolean {
        return false;
    }

    setSlotMaterialClass(_slot: number, _materialClass: string): boolean {
        return false;
    }

    getHighlightQuaternion(): THREE.Quaternion {
        return IDENTITY_QUATERNION;
    }

    getMaterialPalette(): MaterialPaletteEntry[] {
        return blockMaterialPalette();
    }

    materialName(material: VoxelMaterial): string {
        if (material.kind === 'block') return blockTypeName(material.blockType);
        return `#${material.color.toString(16).padStart(6, '0').toUpperCase()}`;
    }

    defaultMaterial(): VoxelMaterial {
        return defaultBlockMaterial();
    }

    refresh(): void {
        // Rebuild exactly the dirty chunk set — mesh, colliders, caches.
        this.deps.voxelWorld.updatePhysicsAndMeshing(false);
    }

    checksum(): number {
        return calculateTerrainChecksum(this.deps.voxelWorld);
    }

    onSessionStart(): void {
        // Prime per-chunk checksums so has-changes detection is cheap.
        this.deps.voxelWorld.initializeChecksums();
    }

    onSessionEnd(_committed: boolean): void {
        // Physics and meshes are maintained live in refresh(); nothing to finalize.
    }

    update(): void {
        // No per-frame work for terrain.
    }

    private makeVoxel(x: number, y: number, z: number, blockType: BlockTypeId): EditVoxel {
        const size = this.deps.voxelWorld.getVoxelSize();
        const rawColor = this.deps.voxelWorld.getColor(x, y, z);
        const material: VoxelMaterial = {
            kind: 'block',
            blockType,
            color: blockType === BlockType.COLOR ? rawColor : (rawColor || null),
        };
        return {
            x, y, z, size,
            material,
            slot: 0,
            worldCenter: new THREE.Vector3(x + size / 2, y + size / 2, z + size / 2),
        };
    }
}
