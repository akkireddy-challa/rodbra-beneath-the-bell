import * as THREE from 'three';
import type { LightingConfig } from 'types/game.js';

/**
 * Where the sun sits in the sky — the DIRECTION of the scene's one directional
 * light, as `lightingConfig.sunElevationDeg` / `sunAzimuthDeg`.
 *
 * `LightingConfig` used to scale only the sun's intensity and colour; its
 * direction was the hardcoded noon-ish (1, 2, 1). That is why no game could get
 * dusk: warm light and a dim sky are colour and intensity, but LONG shadows are
 * an angle, and the angle had no knob. These two fields are that knob.
 *
 * Only the direction lives here. The light's position is re-derived every frame
 * by `ShadowCamera` from `position − target` (it slides the light with the
 * player to keep the shadow map centred), so the direction is set ONCE on the
 * light and survives; nothing per-frame reads the config.
 */

/** Elevation of the default (1, 2, 1) sun above the horizon: atan(2 / √2). */
export const DEFAULT_SUN_ELEVATION_DEG = 54.7356;
/** Azimuth of the default (1, 2, 1) sun: light from the +X/+Z diagonal. */
export const DEFAULT_SUN_AZIMUTH_DEG = 45;
/**
 * Lowest elevation honoured. At the horizon the light direction is parallel to
 * the ground: shadows stretch without bound and the shadow camera's frustum
 * degenerates. A couple of degrees keeps dusk shadows long but finite.
 */
export const MIN_SUN_ELEVATION_DEG = 2;

/**
 * Unit vector pointing FROM the lit scene TOWARD the sun (the direction a
 * `DirectionalLight` sits in, relative to its target), from the config or the
 * engine's default sun. Elevation is degrees above the horizon (90 = straight
 * overhead); azimuth is the compass bearing the light comes from, degrees
 * clockwise from +Z seen from above (0 = from +Z, 90 = from +X) — the gameplay
 * "forward" of `@docs coordinate-system.md`.
 */
export function resolveSunDirection(config?: LightingConfig | null, out = new THREE.Vector3()): THREE.Vector3 {
    const elevationRaw = config?.sunElevationDeg ?? DEFAULT_SUN_ELEVATION_DEG;
    const elevation = THREE.MathUtils.degToRad(
        THREE.MathUtils.clamp(Number.isFinite(elevationRaw) ? elevationRaw : DEFAULT_SUN_ELEVATION_DEG, MIN_SUN_ELEVATION_DEG, 90),
    );
    const azimuthRaw = config?.sunAzimuthDeg ?? DEFAULT_SUN_AZIMUTH_DEG;
    const azimuth = THREE.MathUtils.degToRad(Number.isFinite(azimuthRaw) ? azimuthRaw : DEFAULT_SUN_AZIMUTH_DEG);
    const flat = Math.cos(elevation);
    return out.set(Math.sin(azimuth) * flat, Math.sin(elevation), Math.cos(azimuth) * flat).normalize();
}

/**
 * Point `light` at the sky position the config describes, keeping its target
 * and its distance from that target (the shadow-camera reach) as they are.
 */
export function applySunDirection(light: THREE.DirectionalLight, config?: LightingConfig | null): void {
    const distance = Math.max(1, light.position.distanceTo(light.target.position));
    const dir = resolveSunDirection(config);
    light.position.copy(light.target.position).addScaledVector(dir, distance);
}

/** Restore the default around the shadow camera's current target, not world origin. */
export function resetSunDirection(light: THREE.DirectionalLight, gaussianSplat: boolean): void {
    const distance = Math.max(1, light.position.distanceTo(light.target.position));
    const direction = new THREE.Vector3(gaussianSplat ? 0 : 1, 2, 1).normalize();
    light.position.copy(light.target.position).addScaledVector(direction, distance);
}
