import * as THREE from 'three';

/**
 * Where the ocean's waves are sampled, relative to the world they are drawn in.
 *
 * The wave field (`OceanWaveField`) is defined in its own plane — wave space.
 * Normally wave space IS the world, and the swell is pinned to it. A sea that has
 * to move past something that holds still — a ship whose geometry is baked into
 * the level, sailing a virtual course (`engine/sailing/`) — samples its waves
 * through this frame instead:
 *
 *     wave = A · world + shift        A = rotation by `angle`
 *
 * The one transform runs on the CPU (`OceanSurface.heightAt` / `normalAt`) and in
 * both shader backends (`StylizedOceanMaterial`), so everything that floats sits
 * on the sea that is drawn. Lighting keeps the true world position; only the
 * waves and the patch/foam noise that rides them move.
 *
 * Precision: `shift` grows with the distance sailed. A few kilometres is well
 * inside float32 in the shader; a voyage long enough to matter should re-base.
 */
export interface OceanWaveFrame {
    /** cos of the rotation taking world XZ into wave space. */
    cos: number;
    /** sin of the rotation taking world XZ into wave space. */
    sin: number;
    /** Wave-space translation, applied after the rotation. */
    shiftX: number;
    shiftZ: number;
}

/** Waves pinned to the world — the default, and what every non-sailing level runs. */
export const IDENTITY_OCEAN_WAVE_FRAME: Readonly<OceanWaveFrame> = Object.freeze({
    cos: 1,
    sin: 0,
    shiftX: 0,
    shiftZ: 0,
});

/**
 * The frame for a voyage: the waves live in voyage space, the ship has got to
 * `(voyageX, voyageZ)` in it, and its geometry stands at world `(pivotX, pivotZ)`
 * swung by `swing` radians (`geometryHeading − heading`, as `SeaVoyage.swing()`).
 *
 * World from voyage is `w = pivot + R(swing)·(v − voyage)`, where `R(s)` turns a
 * bearing (measured from +Z towards +X) by +s — the same projection
 * `SeaVoyage.projectToWorld` puts islands with. Inverted, which is what the
 * shader needs: `v = voyage + R(−swing)·(w − pivot)`.
 */
export function oceanWaveFrameForVoyage(
    pivotX: number,
    pivotZ: number,
    voyageX: number,
    voyageZ: number,
    swing: number,
    out: OceanWaveFrame,
): OceanWaveFrame {
    const c = Math.cos(swing);
    const s = Math.sin(swing);
    out.cos = c;
    out.sin = s;
    // R(−s)·(x, z) = (c·x − s·z, s·x + c·z); fold the pivot into the shift.
    out.shiftX = voyageX - (c * pivotX - s * pivotZ);
    out.shiftZ = voyageZ - (s * pivotX + c * pivotZ);
    return out;
}

/** World (x, z) → wave-space (x, z), written into `out`. */
export function toWaveSpace(frame: Readonly<OceanWaveFrame>, x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
    return out.set(
        frame.cos * x - frame.sin * z + frame.shiftX,
        frame.sin * x + frame.cos * z + frame.shiftZ,
    );
}

/**
 * A wave-space surface gradient (∂h/∂x, ∂h/∂z) re-expressed in world space —
 * `Aᵀ · g`, since `h_world(w) = h_wave(A·w + shift)`. Rewrites `gradient` in place.
 */
export function gradientToWorld(frame: Readonly<OceanWaveFrame>, gradient: THREE.Vector2): THREE.Vector2 {
    const gx = gradient.x;
    const gz = gradient.y;
    return gradient.set(frame.cos * gx + frame.sin * gz, -frame.sin * gx + frame.cos * gz);
}
