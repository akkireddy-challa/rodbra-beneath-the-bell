/**
 * A `WaterSurfaceQuery` that is dead flat.
 *
 * Two uses, both real:
 *
 * - **Boot order.** A boat installed from world.json exists before the game
 *   code has built its ocean. Without a stand-in the first frames have no
 *   surface to sample, and "no surface" means falling through the world.
 *   Starting on calm water and switching to the real ocean a frame later is
 *   invisible; a fall is not.
 * - **Harbours and pools.** Not every game with a boat wants a swell.
 */

import type * as THREE from 'three';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';

export function flatWaterSurface(seaLevelY: number): WaterSurfaceQuery {
    return {
        heightAt: (): number => seaLevelY,
        normalAt: (_x: number, _z: number, out: THREE.Vector3): THREE.Vector3 => out.set(0, 1, 0),
    };
}
