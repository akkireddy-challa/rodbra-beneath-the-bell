/**
 * One-shot debug bake: render the PVS tile-ID cubemap once from the
 * camera's current world position, then immediately apply chunk culling
 * based on that single sample. Used to validate the GPU pipeline +
 * chunk-to-tile mapping end-to-end without going through the multi-cell
 * walkable-map bake (which is too slow to wait on while iterating).
 *
 * No persistence, no walkable-map dependency — just "from where I'm
 * standing, which voxel chunks can I actually see?".
 */
import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { VisibilityTileGrid } from './VisibilityTileGrid.js';
import { WalkableMapGpuBaker } from './WalkableMapGpuBaker.js';

export interface SampleVisibilityResult {
    cameraPos: { x: number; y: number; z: number };
    tilesVisible: number;
    pixelsHit: number;
    chunksTotal: number;
    chunksShown: number;
    chunksHidden: number;
    tileSize: number;
    elapsedMs: number;
}

/** Default tile size in metres — matches the multi-cell bake. */
const DEFAULT_TILE_SIZE = 2.0;

export async function sampleVisibilityFromCamera(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    world: VoxelWorld,
): Promise<SampleVisibilityResult> {
    const camPos = camera.position;
    // Anchor the tile grid AT the camera so the camera itself lands at
    // tile (0, 0, 0) — byte-encoded as (128, 128, 128), the centre of
    // the storable range. The shader accepts tx ∈ [-128, +127], so
    // fragments in [camPos − 256m, camPos + 254m] are recorded; chunks
    // farther than that fall outside both the shader's clip and the
    // JS chunk-to-tile mapping (kept consistent by sharing the grid).
    const tileGrid = new VisibilityTileGrid({
        minX: camPos.x, minY: camPos.y, minZ: camPos.z,
        maxX: camPos.x, maxY: camPos.y, maxZ: camPos.z,
    }, DEFAULT_TILE_SIZE);

    const baker = new WalkableMapGpuBaker();
    baker.setRenderer(renderer);
    let result: { tiles: Set<number>; pixelsHit: number; elapsedMs: number };
    try {
        result = await baker.bakeOneCell({
            world, tileGrid,
            eyeX: camPos.x, eyeY: camPos.y, eyeZ: camPos.z,
        });
    } finally {
        baker.dispose();
    }

    // Cull chunks by tile-overlap with the freshly-baked tile set. Read
    // each chunk's *actual* world AABB from its rendered mesh.
    const tilesScratch: number[] = [];
    const aabb = new THREE.Box3();
    let shown = 0, hidden = 0;
    let visDistSum = 0, hidDistSum = 0;
    let visDistMin = Infinity, visDistMax = 0, hidDistMin = Infinity, hidDistMax = 0;
    const aabbCenter = new THREE.Vector3();
    // Tile coverage extent in the PVS — decode every tile key once.
    let pvsTxMin = Infinity, pvsTxMax = -Infinity, pvsTyMin = Infinity, pvsTyMax = -Infinity, pvsTzMin = Infinity, pvsTzMax = -Infinity;
    for (const key of result.tiles) {
        const tx = (key & 0xFF) - 128;
        const ty = ((key >>> 8) & 0xFF) - 128;
        const tz = ((key >>> 16) & 0xFF) - 128;
        if (tx < pvsTxMin) pvsTxMin = tx; if (tx > pvsTxMax) pvsTxMax = tx;
        if (ty < pvsTyMin) pvsTyMin = ty; if (ty > pvsTyMax) pvsTyMax = ty;
        if (tz < pvsTzMin) pvsTzMin = tz; if (tz > pvsTzMax) pvsTzMax = tz;
    }
    console.log(`[sample] PVS tile range tx=[${pvsTxMin}, ${pvsTxMax}] ty=[${pvsTyMin}, ${pvsTyMax}] tz=[${pvsTzMin}, ${pvsTzMax}] → world x=[${(pvsTxMin * 2 + camPos.x).toFixed(1)}, ${((pvsTxMax + 1) * 2 + camPos.x).toFixed(1)}] y=[${(pvsTyMin * 2 + camPos.y).toFixed(1)}, ${((pvsTyMax + 1) * 2 + camPos.y).toFixed(1)}] z=[${(pvsTzMin * 2 + camPos.z).toFixed(1)}, ${((pvsTzMax + 1) * 2 + camPos.z).toFixed(1)}]`);
    for (const chunk of world.getChunks().values()) {
        const src = chunk.collisionMesh;
        if (!(src instanceof THREE.Mesh)) continue;
        aabb.setFromObject(src);
        if (aabb.isEmpty()) continue;
        tilesScratch.length = 0;
        tileGrid.tilesOverlappingAabb(aabb.min.x, aabb.min.y, aabb.min.z, aabb.max.x, aabb.max.y, aabb.max.z, tilesScratch);
        let visible = false;
        for (let i = 0; i < tilesScratch.length; i++) {
            if (result.tiles.has(tilesScratch[i]!)) { visible = true; break; }
        }
        src.visible = visible;
        aabb.getCenter(aabbCenter);
        const dist = aabbCenter.distanceTo(camPos);
        if (visible) {
            shown++; visDistSum += dist;
            if (dist < visDistMin) visDistMin = dist;
            if (dist > visDistMax) visDistMax = dist;
        } else {
            hidden++; hidDistSum += dist;
            if (dist < hidDistMin) hidDistMin = dist;
            if (dist > hidDistMax) hidDistMax = dist;
        }
    }
    console.log(`[sample] chunk distances — visible: n=${shown} min=${visDistMin.toFixed(1)}m max=${visDistMax.toFixed(1)}m avg=${(visDistSum/Math.max(1,shown)).toFixed(1)}m; hidden: n=${hidden} min=${hidDistMin.toFixed(1)}m max=${hidDistMax.toFixed(1)}m avg=${(hidDistSum/Math.max(1,hidden)).toFixed(1)}m`);

    console.log(`🎯 [sample-from-camera] cam=(${camPos.x.toFixed(1)}, ${camPos.y.toFixed(1)}, ${camPos.z.toFixed(1)}) → ${result.tiles.size} tiles, ${result.pixelsHit.toLocaleString()} pixels hit → chunks shown=${shown} hidden=${hidden} in ${result.elapsedMs.toFixed(0)}ms`);

    return {
        cameraPos: { x: camPos.x, y: camPos.y, z: camPos.z },
        tilesVisible: result.tiles.size,
        pixelsHit: result.pixelsHit,
        chunksTotal: shown + hidden,
        chunksShown: shown,
        chunksHidden: hidden,
        tileSize: DEFAULT_TILE_SIZE,
        elapsedMs: result.elapsedMs,
    };
}
