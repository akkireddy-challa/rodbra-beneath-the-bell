import type { GameEngine } from 'engine/GameEngine.js';
import { VxlSceneTerrainSystem } from 'engine/VxlSceneTerrainSystem.js';
import { createCoastalGroundSampler } from 'engine/water/CoastalGroundSampler.js';
import type { CoastalHeightAt } from 'engine/water/CoastalDepthField.js';

/** Prefer baked ground heights: props and sleeping physics chunks must not punch holes in water. */
export function coastalTerrainSampler(engine: GameEngine): CoastalHeightAt {
    const baked = engine.getDynamicObjectManager().getBakedTerrain();
    if (baked instanceof VxlSceneTerrainSystem) {
        return createCoastalGroundSampler(baked.getGroundMask(), baked.getBounds(), (x, z) => baked.getBakedSurfaceHeightAt(x, z));
    }
    return (x, z) => {
        const ground = engine.resolveGroundPlacement(x, z, { boundsMargin: 0 });
        return ground.status === 'ok' ? ground.groundY : null;
    };
}
