import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { VoxelObject } from 'engine/VoxelObject.js';
import * as THREE from 'three';

/**
 * Calculates checksums for voxel world state to detect modifications.
 * Uses integer-only arithmetic to avoid floating-point precision issues.
 * 
 * The checksum is calculated by hashing:
 * - Terrain: All voxel positions and block types
 * - Objects: Object positions/rotations (converted to fixed-point) + voxel data
 */

const POSITION_SCALE = 1000; // Convert floats to fixed-point with 3 decimal places

/**
 * Simple hash function that combines values into a single checksum.
 * Uses FNV-1a-like algorithm with integer arithmetic only.
 */
function hashCombine(hash: number, value: number): number {
    // Use bitwise operations to keep values in 32-bit integer range
    hash = hash ^ (value | 0);
    hash = Math.imul(hash, 16777619) | 0;
    return hash >>> 0; // Convert to unsigned 32-bit
}

/**
 * Convert a floating-point value to a fixed-point integer.
 */
function toFixedPoint(value: number): number {
    return Math.round(value * POSITION_SCALE) | 0;
}

/**
 * Calculate checksum for terrain voxels only (VoxelWorld).
 * Uses VoxelWorld's efficient per-chunk cached checksum system.
 */
export function calculateTerrainChecksum(voxelWorld: VoxelWorld | null): number {
    if (!voxelWorld) return 0;
    
    // Use VoxelWorld's efficient cached checksum method
    return voxelWorld.getTerrainChecksum();
}

/**
 * Calculate checksum for a single VoxelObject.
 */
export function calculateVoxelObjectChecksum(voxelObject: VoxelObject): number {
    let hash = 2166136261;
    
    // Include object transform (converted to fixed-point)
    const pos = voxelObject.position;
    hash = hashCombine(hash, toFixedPoint(pos.x));
    hash = hashCombine(hash, toFixedPoint(pos.y));
    hash = hashCombine(hash, toFixedPoint(pos.z));
    
    const rot = voxelObject.rotation;
    hash = hashCombine(hash, toFixedPoint(rot.x));
    hash = hashCombine(hash, toFixedPoint(rot.y));
    hash = hashCombine(hash, toFixedPoint(rot.z));
    
    const scale = voxelObject.scale;
    hash = hashCombine(hash, toFixedPoint(scale.x));
    hash = hashCombine(hash, toFixedPoint(scale.y));
    hash = hashCombine(hash, toFixedPoint(scale.z));

    // Octree (VXL v3) objects keep their voxels as leaves, not chunks —
    // getVoxelData() is empty for them, so hash the leaf list instead
    // (position, size, color and material slot all participate: leaf edits
    // include recolors and material changes).
    // Only ALREADY-materialised leaves are hashed: buffer-backed objects can't
    // have leaf edits, and forcing expansion here would inflate every octree
    // object during whole-scene checksum sweeps.
    // Material slots are asset-level, not per-leaf: retuning how brightly a
    // material glows moves no voxel at all, so without this a glow change
    // reports "no changes" and Save & Exit throws it away.
    for (const slot of voxelObject.getSlots()) {
        for (let i = 0; i < slot.name.length; i++) hash = hashCombine(hash, slot.name.charCodeAt(i));
        hash = hashCombine(hash, Math.round(slot.emissive));
        // The MATERIAL CLASS for the same reason as the glow above: changing what a
        // material is made of moves no voxel either, so leaving it out of the hash
        // makes "this trim is gold now" report no changes and lose the edit on exit.
        const cls = slot.materialClass ?? '';
        for (let i = 0; i < cls.length; i++) hash = hashCombine(hash, cls.charCodeAt(i));
    }

    const leaves = voxelObject.isOctreeV2 ? voxelObject.getMaterializedOctreeLeaves() : null;
    if (leaves) {
        const sorted = [...leaves].sort((a, b) => {
            if (a.x !== b.x) return a.x - b.x;
            if (a.y !== b.y) return a.y - b.y;
            if (a.z !== b.z) return a.z - b.z;
            return a.size - b.size;
        });
        for (const leaf of sorted) {
            hash = hashCombine(hash, toFixedPoint(leaf.x));
            hash = hashCombine(hash, toFixedPoint(leaf.y));
            hash = hashCombine(hash, toFixedPoint(leaf.z));
            hash = hashCombine(hash, toFixedPoint(leaf.size));
            hash = hashCombine(hash, Math.round(leaf.r * 15));
            hash = hashCombine(hash, Math.round(leaf.g * 15));
            hash = hashCombine(hash, Math.round(leaf.b * 15));
            // Material slot too, or moving a selection into a glowing material
            // reports "no changes" and the session exits without saving.
            hash = hashCombine(hash, Math.round(leaf.slot ?? 0));
            // And the owning joint, on the same reasoning: rebinding a voxel to
            // another bone moves nothing and recolours nothing, so without this a
            // session that did only that would report clean and be thrown away.
            hash = hashCombine(hash, Math.round(leaf.bone ?? 0));
        }
        return hash;
    }

    // Get voxel data from the object
    const voxelData = voxelObject.getVoxelData();
    
    // Sort by position for deterministic order
    voxelData.sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
        return a.z - b.z;
    });
    
    for (const voxel of voxelData) {
        // Hash local position (convert to fixed-point)
        hash = hashCombine(hash, toFixedPoint(voxel.x));
        hash = hashCombine(hash, toFixedPoint(voxel.y));
        hash = hashCombine(hash, toFixedPoint(voxel.z));
        // Hash block type
        hash = hashCombine(hash, voxel.blockType | 0);
    }
    
    return hash;
}

/**
 * Calculate checksum for the entire voxel world (terrain + all VoxelObjects).
 */
export function calculateWorldChecksum(
    voxelWorld: VoxelWorld | null,
    scene: THREE.Scene | null
): number {
    let hash = 2166136261;
    
    // Include terrain checksum
    const terrainChecksum = calculateTerrainChecksum(voxelWorld);
    hash = hashCombine(hash, terrainChecksum);
    
    // Find and include all VoxelObjects in the scene
    if (scene) {
        const voxelObjects: VoxelObject[] = [];
        
        scene.traverse((child) => {
            // Check if this is a VoxelObject by checking for characteristic methods
            if (child && 
                typeof (child as any).getVoxelData === 'function' &&
                typeof (child as any).getVoxelSize === 'function') {
                voxelObjects.push(child as VoxelObject);
            }
        });
        
        // Sort VoxelObjects by position for deterministic order
        voxelObjects.sort((a, b) => {
            const posA = a.position;
            const posB = b.position;
            if (posA.x !== posB.x) return posA.x - posB.x;
            if (posA.y !== posB.y) return posA.y - posB.y;
            return posA.z - posB.z;
        });
        
        // Hash each VoxelObject
        for (const voxelObject of voxelObjects) {
            const objectChecksum = calculateVoxelObjectChecksum(voxelObject);
            hash = hashCombine(hash, objectChecksum);
        }
    }
    
    return hash;
}

