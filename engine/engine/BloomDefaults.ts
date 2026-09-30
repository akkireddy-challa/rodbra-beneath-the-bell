import type { BloomConfig } from 'types/game.js';

/**
 * The bloom a game gets when world.json says nothing.
 *
 * Voxel games have always had a faint bloom (emissive blocks and the sunset
 * hemisphere light read better with it); every other genre had none. A low-poly
 * game (game.json `artStyle: "low-poly"`) is a voxel-genre game whose look is a
 * Blender-built mesh level with its own lighting, so it takes the no-bloom
 * default too — flat-shaded facets under bloom go milky.
 *
 * Pure so it can be tested without a renderer; `GameEngine.applyBloomConfig`
 * is the one caller.
 */
export function resolveBloomDefaults(genre: string, artStyle: string | undefined): BloomConfig {
    return genre === 'voxel' && artStyle !== 'low-poly'
        ? { enabled: true, strength: 0.15, radius: 0.2, threshold: 0.98 }
        : { enabled: false };
}
