import { CHUNK_SIZE } from 'engine/VoxelGeometry.js';

/**
 * Helper utilities for VoxelWorld chunk update prioritization.
 * Extracted to keep VoxelWorld.ts under the line limit.
 */

export interface ChunkEntry<T> {
    key: string;
    chunk: T;
}

export interface PlayerPosition {
    x: number;
    z: number;
}

export interface WorldBounds {
    minX: number;
    minZ: number;
}

/**
 * Calculate distance from chunk center to player position.
 */
export function getChunkDistanceToPlayer(
    chunkKey: string,
    playerPos: PlayerPosition,
    bounds: WorldBounds | null,
    voxelSize: number
): number {
    const parts = chunkKey.split(',');
    if (parts.length !== 3 || !parts[0] || !parts[2]) return Infinity;
    const cx = parseInt(parts[0], 10), cz = parseInt(parts[2], 10);
    if (isNaN(cx) || isNaN(cz)) return Infinity;
    const chunkX = (bounds?.minX ?? 0) + (cx + 0.5) * CHUNK_SIZE * voxelSize;
    const chunkZ = (bounds?.minZ ?? 0) + (cz + 0.5) * CHUNK_SIZE * voxelSize;
    return Math.sqrt((chunkX - playerPos.x) ** 2 + (chunkZ - playerPos.z) ** 2);
}

/**
 * Sort chunk entries by distance to player (nearest first).
 */
export function sortChunksByDistance<T>(
    chunks: Array<[string, T]>,
    playerPos: PlayerPosition,
    bounds: WorldBounds | null,
    voxelSize: number
): Array<[string, T]> {
    return chunks.sort((a, b) => {
        const distA = getChunkDistanceToPlayer(a[0], playerPos, bounds, voxelSize);
        const distB = getChunkDistanceToPlayer(b[0], playerPos, bounds, voxelSize);
        return distA - distB;
    });
}

/** Default configuration for distance-based chunk prioritization */
export const CHUNK_PRIORITY_CONFIG = {
    MAX_DISTANT_CHUNKS: 2,  // Max distant chunks to process per frame
    NEAR_DISTANCE: 50       // Chunks within this distance (meters) are always processed
} as const;
