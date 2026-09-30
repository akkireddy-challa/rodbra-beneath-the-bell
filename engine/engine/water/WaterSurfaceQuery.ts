/**
 * What gameplay needs to know about the water it is floating on.
 *
 * Deliberately tiny and deliberately NOT `OceanSurface`: boats, buoys, course
 * ribbons, wake spray and AI all need "how high is the water here, and which
 * way is it tilted", and nothing else. Depending on the whole ocean object
 * would drag its mesh, material and camera-follow behaviour into every one of
 * them, and would stop a game from swapping in a flat harbour, a scripted
 * cutscene sea, or a test double.
 *
 * `engine/water/OceanSurface.ts` implements it. So does anything else that can
 * answer the two questions — a still pond is a valid implementation returning a
 * constant and (0, 1, 0).
 *
 * Both methods are sampled at the surface's CURRENT animation time, which the
 * owner advances once per frame. Call the owner's `update()` first, then every
 * consumer, so a frame's queries all agree.
 */

import type * as THREE from 'three';

export interface WaterSurfaceQuery {
    /** World Y of the water surface at (x, z). */
    heightAt(x: number, z: number): number;
    /** Unit surface normal at (x, z) — written into `out`, which is returned. */
    normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}
