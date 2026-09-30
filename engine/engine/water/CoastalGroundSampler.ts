import { groundMaskCellIndex, GROUND_MASK_HEIGHT_STEP, type GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import type { VxlWorldBounds } from 'engine/VxlWorldFormat.js';
import type { CoastalHeightAt } from 'engine/water/CoastalDepthField.js';

/** The legacy unsigned mask saturates at both ends; those cells need real geometry. */
export function createCoastalGroundSampler(
    mask: Readonly<GroundMaskData> | null, bounds: VxlWorldBounds | null, fallback: CoastalHeightAt,
): CoastalHeightAt {
    return (x, z) => {
        if (!bounds || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) return null;
        if (mask) {
            const index = groundMaskCellIndex(mask, x, z, bounds.minX, bounds.minZ);
            const top = index >= 0 ? mask.topY[index] : 0;
            if (top !== undefined && top > 1 && top < 65535) return top * GROUND_MASK_HEIGHT_STEP;
        }
        // A sleeping physics chunk returns the world floor, a conservative deep
        // estimate. It must never be mistaken for dry land by the water shader.
        return fallback(x, z);
    };
}
