import * as THREE from 'three';
import { GroundDetailSystem, groundDetailOptionsFor } from 'engine/vxlscene/GroundDetailSystem.js';
import { GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import type { DecodedVxlSceneWorld } from 'engine/vxlscene/VxlSceneFormat.js';

/** Actual baked-ground pipeline, including its cover planning and instance pool. */
export function createForgedFoliagePreview(scene: THREE.Object3D, seed: number): GroundDetailSystem {
    const types = new Uint8Array(32 * 32), topY = new Uint16Array(32 * 32);
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
        const px = (x + 0.5) * 0.5 - 8, pz = (z + 0.5) * 0.5 - 8;
        types[z * 32 + x] = Math.abs(px - 0.5 * Math.sin(pz * 0.5)) < 0.96 ? GROUND_TYPE.none : GROUND_TYPE.grassLush;
        topY[z * 32 + x] = Math.round(0.25 / GROUND_MASK_HEIGHT_STEP);
    }
    const world: DecodedVxlSceneWorld = {
        chunkSize: 16, minVoxelSize: 0.25, surfaceStep: 0.25,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 }, lodDistances: [100],
        groundMask: { width: 32, height: 32, cellSize: 0.5, types, topY },
        chunks: [{ cx: 0, cy: 0, cz: 0, surfaceTile: null, namedTrimeshes: [],
            voxels: { count: 0, gx: new Uint16Array(), gy: new Uint16Array(), gz: new Uint16Array(), sizeLevel: new Uint8Array(), colorIdx: new Uint16Array(), flags: new Uint8Array(), disp: null },
            lodHints: [{ count: 1, gx: Uint16Array.of(0), gy: Uint16Array.of(0), gz: Uint16Array.of(0),
                w: Uint16Array.of(64), h: Uint16Array.of(64), axisDir: Uint8Array.of(1), colorIdx: Uint16Array.of(0x583), disp: Int8Array.of(0) }],
        }],
    };
    const parent = new THREE.Group(); parent.position.set(-8, -0.25, -8); scene.add(parent);
    const system = new GroundDetailSystem(world, parent, groundDetailOptionsFor({ density: 3 }, seed));
    system.updateDetail(new THREE.Vector3(8, 1, 8));
    return system;
}
