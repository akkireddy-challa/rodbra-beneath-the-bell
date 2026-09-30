/**
 * MeshLevelLighting — the lighting preset a mesh level applies on load.
 *
 * The engine sun is a `DirectionalLight` at daylight intensity that
 * `GameEngine.applyLightingConfig` re-applies from `worldProfileData.lightingConfig`
 * at load and on every level switch — so a game that dims the light object by
 * hand gets overwritten. The interior preset therefore goes THROUGH that knob:
 * it applies a `LightingConfig` with a near-dark sun (below the engine's
 * sun-shadow threshold, which also switches the sun shadow pass off) and an
 * ambient floor that keeps enclosed geometry navigable.
 *
 * JSON point lights share one `PointLightPool` so the scene's light count stays
 * constant (a light-count change recompiles every material's shader; on WebGPU
 * that is a synchronous 300–500 ms freeze — see lighting-best-practices.md).
 * Spots are real `SpotLight`s: static geometry can bake their shadow maps once
 * (`shadows: 'cached'`), which moving characters then do not cast into.
 */
import * as THREE from 'three';
import type { EngineLike, LightingConfig } from 'types/game.js';
import { PointLightPool, DEFAULT_POINT_LIGHT_POOL_OPTIONS, type PointLightSource } from 'engine/PointLightPool.js';
import { isWebGpuActive } from 'engine/RendererType.js';
import type { MeshLevelLight } from 'engine/meshlevel/MeshLevelSchema.js';

export type MeshLevelShadowMode = 'cached' | 'dynamic' | 'none';

export interface MeshLevelLightingOptions {
    /**
     * `interior` dims the sun through `lightingConfig` and lifts the ambient floor;
     * `exterior` leaves the sun alone and only adds the JSON lights; `none` touches nothing.
     */
    mode: 'interior' | 'exterior' | 'none';
    /** The `lightingConfig` block applied in `interior` mode (merged over the current one). */
    interior: LightingConfig;
    /** Hemisphere fill in `interior` mode: retargets the template's existing HemisphereLight, or creates one. `null` leaves it alone. */
    hemisphere: { sky: string; ground: string; intensity: number } | null;
    /** Real point lights shared by every JSON point light. */
    pointLightPoolSize: number;
    /** JSON spots beyond this count still light but cast no shadow. */
    maxShadowCastingSpots: number;
    /** Shadow map edge for the shadow-casting spots. */
    spotShadowMapSize: number;
}

export const DEFAULT_MESH_LEVEL_LIGHTING: MeshLevelLightingOptions = {
    mode: 'interior',
    interior: { sunIntensity: 0.08, environmentIntensity: 0.22, skyboxIntensity: 0.3, ambientFloor: 0.8 },
    hemisphere: { sky: '#ffffff', ground: '#404040', intensity: 0.65 },
    pointLightPoolSize: DEFAULT_POINT_LIGHT_POOL_OPTIONS.poolSize,
    maxShadowCastingSpots: 2,
    spotShadowMapSize: 512,
};

/** Everything `applyMeshLevelLighting` touched, so `disposeMeshLevelLighting` can undo exactly that. */
export interface AppliedMeshLevelLighting {
    group: THREE.Group;
    pool: PointLightPool | null;
    spots: THREE.SpotLight[];
    /** The lighting config in force before the preset, re-applied on dispose. */
    previousConfig: LightingConfig | null;
    /** Hemisphere state before the preset (the light and its old colours/intensity), or null when untouched. */
    previousHemisphere: { light: THREE.HemisphereLight; sky: THREE.Color; ground: THREE.Color; intensity: number; created: boolean } | null;
    /** The shadow mode actually in force ('cached' degrades to 'dynamic' on WebGPU). */
    shadows: MeshLevelShadowMode;
}

/** Resolve the shadow mode the current backend can honour. */
export function resolveShadowMode(requested: MeshLevelShadowMode): MeshLevelShadowMode {
    // three's WebGPU backend does not honour shadow.autoUpdate=false + needsUpdate
    // reliably for spot lights, so a cached request runs dynamic there.
    if (requested === 'cached' && isWebGpuActive()) return 'dynamic';
    return requested;
}

function findHemisphere(scene: THREE.Scene): THREE.HemisphereLight | null {
    let found: THREE.HemisphereLight | null = null;
    scene.traverse((o) => { if (!found && o instanceof THREE.HemisphereLight) found = o; });
    return found;
}

export function applyMeshLevelLighting(
    engine: EngineLike,
    lights: ReadonlyArray<MeshLevelLight>,
    options: MeshLevelLightingOptions,
    requestedShadows: MeshLevelShadowMode,
): AppliedMeshLevelLighting {
    const scene = engine.scene;
    if (!scene) throw new Error('[MeshLevel] lighting needs engine.scene');
    const shadows = resolveShadowMode(requestedShadows);
    const group = new THREE.Group();
    group.name = 'MeshLevelLights';
    scene.add(group);

    const previousConfig = engine.getLightingConfig?.() ?? null;
    let previousHemisphere: AppliedMeshLevelLighting['previousHemisphere'] = null;

    if (options.mode === 'interior') {
        engine.applyLightingConfig?.({ ...(previousConfig ?? {}), ...options.interior });
        if (options.hemisphere) {
            let light = findHemisphere(scene);
            let created = false;
            if (!light) {
                light = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
                light.name = 'MeshLevelHemisphere';
                scene.add(light);
                created = true;
            }
            previousHemisphere = { light, sky: light.color.clone(), ground: light.groundColor.clone(), intensity: light.intensity, created };
            light.color.set(options.hemisphere.sky);
            light.groundColor.set(options.hemisphere.ground);
            light.intensity = options.hemisphere.intensity;
        }
    }

    const pointSources: PointLightSource[] = [];
    const spots: THREE.SpotLight[] = [];
    let shadowSpots = 0;
    for (const light of lights) {
        if (light.type === 'point') {
            pointSources.push({
                position: new THREE.Vector3(...light.position),
                color: new THREE.Color(light.color),
                intensity: light.intensity,
                distance: light.distance,
                decay: light.decay,
            });
            continue;
        }
        const spot = new THREE.SpotLight(new THREE.Color(light.color), light.intensity, 0, light.angle, light.penumbra, 2);
        spot.name = light.name;
        spot.position.set(...light.position);
        spot.target.position.set(...light.target);
        group.add(spot.target);
        if (light.castShadow && shadows !== 'none' && shadowSpots < options.maxShadowCastingSpots) {
            shadowSpots++;
            spot.castShadow = true;
            spot.shadow.mapSize.set(options.spotShadowMapSize, options.spotShadowMapSize);
            spot.shadow.bias = -0.00005;
            spot.shadow.normalBias = 0.025;
            if (shadows === 'cached') {
                spot.shadow.autoUpdate = false;
                spot.shadow.needsUpdate = true;
            }
        }
        group.add(spot);
        spots.push(spot);
    }

    let pool: PointLightPool | null = null;
    if (pointSources.length > 0) {
        pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: options.pointLightPoolSize });
        pool.setSources(pointSources);
    }

    return { group, pool, spots, previousConfig, previousHemisphere, shadows };
}

/** Re-bake the cached spot shadow maps (call after the level's static geometry changed). */
export function refreshCachedShadows(applied: AppliedMeshLevelLighting): void {
    if (applied.shadows !== 'cached') return;
    for (const spot of applied.spots) {
        if (spot.castShadow) spot.shadow.needsUpdate = true;
    }
}

export function disposeMeshLevelLighting(engine: EngineLike, applied: AppliedMeshLevelLighting): void {
    applied.pool?.dispose();
    for (const spot of applied.spots) {
        spot.shadow.dispose();
        spot.dispose();
    }
    applied.group.removeFromParent();
    if (applied.previousHemisphere) {
        const h = applied.previousHemisphere;
        if (h.created) {
            h.light.removeFromParent();
            h.light.dispose();
        } else {
            h.light.color.copy(h.sky);
            h.light.groundColor.copy(h.ground);
            h.light.intensity = h.intensity;
        }
    }
    engine.applyLightingConfig?.(applied.previousConfig);
}
