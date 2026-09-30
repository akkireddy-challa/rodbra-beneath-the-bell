import * as THREE from 'three';
import type { LightingConfig } from 'types/game.js';

/**
 * The ambient FLOOR — the minimum light every surface receives, so "unlit" means
 * dark-but-navigable rather than pure black.
 *
 * WHY a separate light instead of raising `environmentIntensity`: the IBL term is
 * the sky image MULTIPLIED by that intensity, so a dark interior (whose sky is
 * near-black by design) stays near-black no matter how high the multiplier goes.
 * A floor has to be additive and independent of the sky to be a floor at all.
 *
 * WHY it is created ONCE and only ever changes intensity: adding or removing a
 * light changes how many lights three.js compiles into every material's shader,
 * and on WebGPU that recompile is synchronous and costs 300–500 ms — a hard frame
 * freeze. So the light is installed at setup and parked at `intensity = 0` when a
 * game opts out; the scene's light COUNT never changes. Same discipline as
 * `PointLightPool`, for the same reason.
 *
 * This does not rescue a scene that has no lamps near the player — it sets the
 * floor, not the key light. Coverage is the content's job.
 */

/** Name of the single floor light in the scene graph. */
export const AMBIENT_FLOOR_LIGHT_NAME = 'AmbientFloor';

/**
 * Default minimum illumination.
 *
 * Chosen to be negligible where a scene is already lit and meaningful where it is
 * not: daylight runs `environmentIntensity` 1 plus a full sun, so this is a few
 * percent of the ambient term and invisible; a dark interior runs it at 0.02–0.15,
 * where the same absolute value is a large share of the ambient term and is what
 * keeps unlit geometry off pure black. Games wanting true blackness set 0.
 */
export const DEFAULT_AMBIENT_FLOOR = 0.05;

/** Resolve the configured floor, falling back to the default. Never negative. */
export function resolveAmbientFloor(config?: LightingConfig | null): number {
    const raw = config?.ambientFloor ?? DEFAULT_AMBIENT_FLOOR;
    return Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_AMBIENT_FLOOR;
}

/** The scene's floor light, or undefined before `installAmbientFloorLight` has run. */
function findAmbientFloorLight(scene: THREE.Scene): THREE.AmbientLight | undefined {
    return scene.getObjectByName(AMBIENT_FLOOR_LIGHT_NAME) as THREE.AmbientLight | undefined;
}

/**
 * Install the floor light on `scene` (once) and return it. Safe to call again —
 * an existing floor light is reused rather than duplicated, so the light count
 * stays constant across re-entrant setup.
 */
export function installAmbientFloorLight(scene: THREE.Scene): THREE.AmbientLight {
    const existing = findAmbientFloorLight(scene);
    if (existing) return existing;
    const light = new THREE.AmbientLight(0xffffff, DEFAULT_AMBIENT_FLOOR);
    light.name = AMBIENT_FLOOR_LIGHT_NAME;
    scene.add(light);
    return light;
}

/** Apply `config`'s floor to the installed light. No-op when it was never installed. */
export function applyAmbientFloor(scene: THREE.Scene, config?: LightingConfig | null): void {
    const light = findAmbientFloorLight(scene);
    if (!light) return;
    light.intensity = resolveAmbientFloor(config);
    light.color.set(config?.ambientColor ?? '#ffffff');
}
