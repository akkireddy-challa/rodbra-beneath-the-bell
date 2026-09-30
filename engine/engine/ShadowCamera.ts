/**
 * Directional-shadow camera helpers, split out of GameEngine.ts to respect the
 * max-lines limit. Operations on the sun DirectionalLight:
 *  - resolveShadowDistance() / resolveShadowMapSize(): derive the coverage
 *    radius (default clamped to the world footprint) and the shadow-map
 *    resolution (density-targeted, device-capped) from it.
 *  - configureDirectionalShadow(): one-shot shadow-map + ortho-frustum setup,
 *    returning the world-units-per-texel used for stabilization.
 *  - updateShadowCameraPosition(): per-frame texel-snapped re-centering of the
 *    shadow frustum on the player, so shadow edges don't crawl as the camera
 *    moves. Returns the new snapped centre, or null when it hasn't moved a
 *    texel since last frame (caller skips the update).
 */
import * as THREE from 'three';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import type { TerrainBounds } from 'engine/DynamicObjectManager.js';
import { isWebGpuActive } from 'engine/RendererType.js';

export interface ShadowConfig {
    /**
     * Shadow-map resolution (one square texture). DERIVED, never authored:
     * configureDirectionalShadow() overwrites it from shadowDistance (or
     * mapSizeOverride) via resolveShadowMapSize() on every apply. Kept in the
     * config so getShadowConfig() reports the real allocated size — 0 while the
     * sun casts no shadow (the rescue rung), and under WebGPU the size the map
     * was first allocated at (see resolveLiveShadowMapSize).
     */
    mapSize: number;
    /**
     * Explicit resolution requested via renderConfig.shadowMapSize; undefined
     * (the default) derives the size from shadowDistance instead. Snapped to a
     * power of two and clamped to the device cap on apply — the mobile cap
     * applies even here, because an oversized map that fails to allocate is
     * the silent-no-shadows failure this sizing exists to prevent.
     */
    mapSizeOverride?: number;
    bias: number;
    normalBias: number;
    shadowBlurRadius: number; // Controls shadow edge softness (higher = softer edges)
    shadowDistance: number; // Shadow map coverage radius in meters
}

/**
 * Default directional-shadow coverage radius (m). The shadow map covers a
 * 2×this square centred on the view, so shadows are visible out to ~this far.
 * Overridable per game via `worldProfileData.renderConfig.shadowDistance`;
 * without an override the effective radius also shrinks to the world footprint
 * (see resolveShadowDistance). Farther = shadows at distance but softer up
 * close (single map, no cascades).
 */
export const DEFAULT_SHADOW_DISTANCE = 200;

/** Floor for the world-fitted radius, so degenerate/tiny bounds keep a sane frustum. */
const MIN_FITTED_SHADOW_DISTANCE = 40;

/**
 * Target shadow-texel density. 10 texels/m reproduces the legacy fixed look:
 * a 4096 map over the default 2×200 m frustum was 10.24 texels/m.
 */
const SHADOW_TEXELS_PER_METER = 10;

const SHADOW_MAP_MIN_SIZE = 512;
/**
 * Device caps, now carried by the quality tier (`DeviceQualityPolicy.live.shadowMapMaxSize`)
 * rather than derived from a mobile flag. The top rung keeps the legacy 4096 ceiling;
 * everything else gets 2048, which is also a device FLOOR in `clampPolicyToDevice` — a
 * 4096² depth target (64 MB) frequently fails to allocate on mobile GPUs even though they
 * report maxTextureSize ≥ 4096, and the map then silently never exists so the sun casts no
 * shadows at all. 2048² (16 MB) allocates reliably.
 *
 * A cap of 0 means the rescue rung: no sun shadows at all, rather than a small blurry map.
 */
export const SHADOW_MAP_MAX_SIZE_DESKTOP = 4096;
export const SHADOW_MAP_MAX_SIZE_MOBILE = 2048;

/**
 * Effective shadow coverage radius: an explicit renderConfig.shadowDistance
 * always wins; otherwise the default, clamped down to the world's XZ diagonal
 * once terrain bounds exist. The diagonal (not half) guarantees the whole
 * level stays covered from any player position, so shadows never pop out
 * inside a small world; null bounds (still loading) keep the plain default.
 */
export function resolveShadowDistance(
    explicitDistance: number | undefined,
    bounds: TerrainBounds | null,
): number {
    if (explicitDistance !== undefined) return explicitDistance;
    if (!bounds) return DEFAULT_SHADOW_DISTANCE;
    const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    return Math.min(DEFAULT_SHADOW_DISTANCE, Math.max(MIN_FITTED_SHADOW_DISTANCE, diagonal));
}

/**
 * Shadow-map resolution for a coverage radius: the smallest power of two that
 * reaches SHADOW_TEXELS_PER_METER over the 2×distance frustum, clamped to the
 * device cap. Default 200 m resolves to the legacy 4096 on desktop and to
 * 2048 on mobile; a world-fitted small radius shrinks the map further.
 *
 * An explicit size (renderConfig.shadowMapSize) replaces the density ladder:
 * it is clamped to [floor, `cap`] and snapped to the nearest power of two.
 * Non-finite/non-numeric values (world.json is untrusted input) fall through
 * to the derived sizing — and an authored size is still clamped to the cap,
 * so a game cannot ask a phone for a map it cannot allocate.
 *
 * A `cap` of 0 returns 0, meaning the caller should not enable shadows at all.
 */
export function resolveShadowMapSize(shadowDistance: number, cap: number, explicitSize?: number): number {
    if (cap <= 0) return 0;
    if (typeof explicitSize === 'number' && Number.isFinite(explicitSize)) {
        const clamped = Math.min(cap, Math.max(SHADOW_MAP_MIN_SIZE, explicitSize));
        return 2 ** Math.round(Math.log2(clamped));
    }
    const idealTexels = 2 * shadowDistance * SHADOW_TEXELS_PER_METER;
    let size = SHADOW_MAP_MIN_SIZE;
    while (size < idealTexels && size < cap) size *= 2;
    return size;
}

// Pre-allocated temp vectors for updateShadowCameraPosition() — reused across
// frames to avoid per-frame allocation in the render loop.
const _center = new THREE.Vector3();
const _lightDir = new THREE.Vector3();
const _worldUp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upOnPlane = new THREE.Vector3();
const _snappedCenter = new THREE.Vector3();

/**
 * The size to give a shadow map that may already be allocated.
 *
 * Classic WebGLRenderer: `mapSize`. That backend only (re)creates the render target while
 * shadow.map is null, so a stale-sized target is dropped for the next pass to reallocate.
 *
 * WebGPURenderer (either backend): once its ShadowNode has allocated the map (it assigns
 * shadow.map), the map keeps its size for the life of the light. The node resizes its target
 * from mapSize every frame, and a resize destroys the depth texture. three r185 rebuilds a
 * render object's bind groups only when the material observer asks for a refresh. That
 * observer is shared per material, so a still object sharing its material with another
 * never gets one, and keeps submitting the destroyed texture ("Destroyed texture
 * [ShadowDepthTexture] used in a submit") every frame until it moves. Disposing the map
 * ourselves breaks the node outright. A new size lands with the next engine.
 */
function resolveLiveShadowMapSize(lightShadow: THREE.LightShadow, mapSize: number): number {
    if (!lightShadow.map) return mapSize;
    if (isWebGpuActive()) return lightShadow.mapSize.width;
    if (lightShadow.mapSize.width !== mapSize || lightShadow.mapSize.height !== mapSize) {
        lightShadow.map.dispose();
        lightShadow.map = null;
    }
    return mapSize;
}

/**
 * Configure the shadow map and directional light's orthographic shadow frustum
 * from `config`. Returns world-units-per-shadow-texel (used by
 * updateShadowCameraPosition to snap the frustum on the texel grid).
 */
export function configureDirectionalShadow(
    renderer: THREE.WebGLRenderer,
    directionalLight: THREE.DirectionalLight,
    config: ShadowConfig,
): number {
    const mapSize = resolveShadowMapSize(
        config.shadowDistance,
        activeQualityPolicy().live.shadowMapMaxSize,
        config.mapSizeOverride,
    );
    // The rescue rung asks for no sun shadows at all. Returning before anything is
    // configured is deliberate: a 0-sized map is not a thing three can allocate, and
    // leaving the light's castShadow untouched here keeps every other caller's meaning.
    if (mapSize === 0) {
        renderer.shadowMap.enabled = false;
        directionalLight.castShadow = false;
        config.mapSize = 0;
        return 0;
    }
    renderer.shadowMap.enabled = true;
    // PCFShadowMap and PCFSoftShadowMap both produce animated speckle on
    // Adreno 730 / 740 (Snapdragon 8 Gen 1/2 — Samsung S22-series, Galaxy
    // Tab S8, OnePlus 10/11, Nothing Phone 2, etc.). BasicShadowMap is the
    // only filter type that renders cleanly on those drivers. Use it on
    // all Android devices: hard-edged shadows are visually acceptable on
    // small screens, and trying to detect specific Adreno chips via
    // UNMASKED_RENDERER_WEBGL doesn't work under WebGPU.
    const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    renderer.shadowMap.type = isAndroid ? THREE.BasicShadowMap : THREE.PCFShadowMap;

    const lightShadow = directionalLight.shadow;
    const shadowCam = lightShadow.camera;
    const distance = config.shadowDistance;
    shadowCam.left = -distance;
    shadowCam.right = distance;
    shadowCam.top = distance;
    shadowCam.bottom = -distance;
    shadowCam.near = 0.5;
    shadowCam.far = distance * 3.0;
    shadowCam.updateProjectionMatrix();

    const appliedSize = resolveLiveShadowMapSize(lightShadow, mapSize);
    config.mapSize = appliedSize; // what is actually allocated — keeps getShadowConfig()/unitsPerTexel coherent
    const unitsPerTexel = (shadowCam.right - shadowCam.left) / appliedSize;

    lightShadow.mapSize.set(appliedSize, appliedSize);
    lightShadow.bias = config.bias;
    lightShadow.normalBias = config.normalBias;
    lightShadow.radius = config.shadowBlurRadius;

    // Enable EnvironmentObjectSystem's shadow-only layer on the shadow
    // camera. Per-type shadow meshes for off-screen instances live on
    // this layer; the main camera (default layer 0) skips them, but the
    // shadow camera renders them so their shadows still appear on
    // visible geometry. Layer index kept in sync with
    // EnvironmentObjectSystem.SHADOW_ONLY_LAYER.
    shadowCam.layers.enable(1);

    console.log(`Shadow system initialized: ${appliedSize}x${appliedSize}, distance=${distance}`);

    return unitsPerTexel;
}

/**
 * Re-centre the directional light's shadow frustum on `playerPosition`, snapped
 * to the shadow-texel grid so shadow edges stay stable as the camera moves.
 * Returns the new snapped centre when it changed, or null when it hasn't moved a
 * texel since `lastSnappedCenter` (caller can skip the update).
 */
export function updateShadowCameraPosition(
    directionalLight: THREE.DirectionalLight,
    playerPosition: THREE.Vector3,
    config: ShadowConfig,
    unitsPerTexel: number,
    lastSnappedCenter: THREE.Vector3 | null,
    isGaussianSplatMode: boolean,
): THREE.Vector3 | null {
    const center = _center.copy(playerPosition);

    const lightDir = _lightDir
        .subVectors(directionalLight.position, directionalLight.target.position)
        .normalize();

    // normalize() leaves a zero-length vector at zero, so this catches a light
    // sitting exactly on its target — fall back to a default sun angle.
    if (lightDir.length() < 0.001) {
        lightDir.set(isGaussianSplatMode ? 0 : 1, 2, 1).normalize();
    }

    const worldUp = _worldUp.set(0, 1, 0);
    if (Math.abs(lightDir.dot(worldUp)) > 0.999) worldUp.set(1, 0, 0);

    const right = _right.crossVectors(worldUp, lightDir).normalize();
    const upOnPlane = _upOnPlane.crossVectors(lightDir, right).normalize();

    const units = Math.max(unitsPerTexel, 1e-6);
    const cx = center.dot(right);
    const cy = center.dot(upOnPlane);
    const cz = center.dot(lightDir);

    const snappedCx = Math.round(cx / units) * units;
    const snappedCy = Math.round(cy / units) * units;

    const snappedCenter = _snappedCenter.set(0, 0, 0)
        .addScaledVector(right, snappedCx)
        .addScaledVector(upOnPlane, snappedCy)
        .addScaledVector(lightDir, cz);

    if (lastSnappedCenter && lastSnappedCenter.distanceToSquared(snappedCenter) < 1e-12) {
        return null;
    }

    // Move the light onto the new centre, keeping it `shadowDistance` back along
    // its own direction so the ortho frustum's near/far still bracket the scene.
    directionalLight.target.position.copy(snappedCenter);
    directionalLight.position.copy(snappedCenter).addScaledVector(lightDir, config.shadowDistance);

    return snappedCenter;
}
