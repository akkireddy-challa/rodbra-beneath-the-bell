import * as THREE from 'three';
import type { WeatherConfig } from 'types/game.js';
import { getActiveBackend, isWebGpuActive } from 'engine/RendererType.js';
import { RainHeightField, type RainFieldBounds } from 'engine/weather/RainHeightField.js';
import {
    RainVFXGpu, DEFAULT_RAIN_VFX_GPU_OPTIONS, type ComputeCapableRenderer,
} from 'engine/weather/RainVFXGpu.js';
import { RainVFXWebGl, DEFAULT_RAIN_VFX_WEBGL_OPTIONS } from 'engine/weather/RainVFXWebGl.js';
import {
    VehicleWetFX, DEFAULT_VEHICLE_WET_FX_OPTIONS, type WetFxVehicle,
} from 'engine/weather/VehicleWetFX.js';
import { WetSurfaceController } from 'engine/weather/WetSurfaceController.js';
import { DEFAULT_WET_SURFACE_LOOK, type WetSurfaceLook } from 'engine/weather/WetSurfaceMaterial.js';

/**
 * WeatherSystem — one owner for everything `weatherConfig` drives: the falling
 * rain, the impact splashes, and the wet-surface response of the level. All of
 * it reads ONE shared state (intensity envelope, wetness envelope, wind), so
 * the particles and the surfaces always agree — the classic tell of fake rain
 * is a road rippling to a different rhythm than the drops hitting it.
 *
 * Envelopes: `intensity` eases toward the configured value (rain fades in/out
 * rather than popping), and `wetness` — unless overridden — SOAKS toward the
 * intensity while it rains and dries far more slowly after, so a track stays
 * glossy after a shower passes.
 *
 * Backend split (game/docs/renderer-backends.md): WebGPU gets the compute rain
 * (RainVFXGpu + RainCollisionMap); WebGL gets the vertex-shader-wrapped
 * instanced rain (RainVFXWebGl). The wet surface material handles its own dual
 * path. Subsystems are built lazily in `frameUpdate` once the scene/terrain
 * exist, and rebuilt when the terrain generation changes (level switch).
 *
 * Drive `frameUpdate` from the engine's pre-render update — NOT from an
 * `onBeforeRender` hook: the GPU path dispatches compute, which is illegal
 * inside an active render pass (same constraint as the splat sorter).
 */

export interface WeatherTerrainInfo {
    /** Chunk group of the baked level (surface batch + terrain batches live under it). */
    group: THREE.Object3D;
    /** World AABB, or null before the world finishes decoding. */
    bounds: RainFieldBounds | null;
    /** Ground height at a world XZ (non-finite where there is none). */
    heightAt(x: number, z: number): number;
    /** Increments every time a world/level is (re)built — triggers re-apply + re-bake. */
    generation: number;
}

export interface WeatherSystemDeps {
    getScene(): THREE.Scene | null;
    getCamera(): THREE.Camera | null;
    /** The live renderer (WebGLRenderer or WebGPURenderer). */
    getRenderer(): unknown;
    /** Baked-terrain access, or null while no baked level is loaded. */
    getTerrain(): WeatherTerrainInfo | null;
    /** Live vehicles (VehicleManager), for tyre spray + wet trails. */
    getVehicles(): readonly WetFxVehicle[];
}

export const DEFAULT_WEATHER_WIND = { x: 1.5, z: 0.5 };

/** Rain intensity ease rate (1/s) toward the configured value. */
const INTENSITY_DAMP_RATE = 0.7;
/** Wetness gain per second at full rain. */
const WETNESS_SOAK_RATE = 0.12;
/** Wetness loss per second once the rain has passed. */
const WETNESS_DRY_RATE = 0.03;

/**
 * Merge the `?weather=` URL debug override over a game's config (same pattern
 * as `?carpaint=`): `rain`, `rain:0.6`, or `off`. Lets any game be test-driven
 * in the rain without touching its (agent-owned) world.json.
 */
export function resolveWeatherUrlOverride(config: WeatherConfig | null): WeatherConfig | null {
    if (typeof window === 'undefined') return config;
    const raw = new URLSearchParams(window.location.search).get('weather');
    if (!raw) return config;
    if (raw === 'off' || raw === 'none') return null;
    if (raw === 'rain' || raw.startsWith('rain:')) {
        const val = raw.includes(':') ? Number(raw.split(':')[1]) : 1;
        return {
            ...(config ?? {}),
            precipitation: 'rain',
            intensity: Number.isFinite(val) ? THREE.MathUtils.clamp(val, 0, 1) : 1,
        };
    }
    console.warn(`[Weather] unrecognized ?weather= value "${raw}" — ignoring`);
    return config;
}

/**
 * The wet-surface look dials a game authored, filled in with the tuned
 * racing-game defaults. Single place the mapping lives, so the material never
 * has to know about `weatherConfig` and the agent never has to know about
 * shader constants.
 */
export function resolveWetSurfaceLook(config: WeatherConfig | null | undefined): WetSurfaceLook {
    return {
        filmGloss: config?.filmGloss ?? DEFAULT_WET_SURFACE_LOOK.filmGloss,
        surfaceDarkening: config?.surfaceDarkening ?? DEFAULT_WET_SURFACE_LOOK.surfaceDarkening,
        envSheen: config?.envSheen ?? DEFAULT_WET_SURFACE_LOOK.envSheen,
        rippleStrength: config?.rippleStrength ?? DEFAULT_WET_SURFACE_LOOK.rippleStrength,
    };
}

/**
 * Reflection dials read by the post-processing chain (GameEnginePostFx). Read
 * at pipeline BUILD time, so `applyWeatherConfig` rebuilds the chain whenever
 * a game changes them.
 */
export interface WeatherReflectionLook {
    strength: number;
    highlight: number;
    streak: number;
    distance: number;
}

export const DEFAULT_WEATHER_REFLECTION_LOOK: WeatherReflectionLook = {
    strength: 0.55,
    highlight: 1.0,
    streak: 3,
    distance: 25,
};

export function resolveReflectionLook(config: WeatherConfig | null | undefined): WeatherReflectionLook {
    return {
        strength: config?.reflectionStrength ?? DEFAULT_WEATHER_REFLECTION_LOOK.strength,
        highlight: config?.reflectionHighlight ?? DEFAULT_WEATHER_REFLECTION_LOOK.highlight,
        streak: config?.reflectionStreak ?? DEFAULT_WEATHER_REFLECTION_LOOK.streak,
        distance: config?.reflectionDistance ?? DEFAULT_WEATHER_REFLECTION_LOOK.distance,
    };
}

/** Whether this (already URL-merged) config asks for the SSR pass. WebGPU-only;
 *  the caller gates on the backend. Shared by WeatherSystem and the post-FX
 *  rebuild so the MRT layout and the material's SSR mask can never disagree. */
export function weatherWantsSsr(config: WeatherConfig | null | undefined): boolean {
    return config?.precipitation === 'rain' && (config.reflections ?? 'ssr') === 'ssr';
}

export class WeatherSystem {
    private readonly deps: WeatherSystemDeps;

    private config: WeatherConfig | null = null;
    private currentIntensity = 0;
    private wetness = 0;

    private readonly surface = new WetSurfaceController();
    private heightField: RainHeightField | null = null;
    private rainGpu: RainVFXGpu | null = null;
    private rainGl: RainVFXWebGl | null = null;
    private vehicleFx: VehicleWetFX | null = null;
    /** Spray setting the live VehicleWetFX was built with (see frameUpdate). */
    private vehicleSprayEnabled = DEFAULT_VEHICLE_WET_FX_OPTIONS.vaporEnabled;
    private surfaceGeneration = -1;
    private fieldGeneration = -1;
    private fieldSynced = false;
    private warnedNoComputeBackend = false;

    private readonly camPos = new THREE.Vector3();

    constructor(deps: WeatherSystemDeps) {
        this.deps = deps;
    }

    /** Current wetness envelope 0..1 (exposed for diagnostics/tests). */
    getWetness(): number {
        return this.wetness;
    }

    /**
     * Apply a (URL-override-merged) weather config. Null or non-raining tears
     * the visuals down; subsystems otherwise build lazily on the next frame.
     */
    applyConfig(config: WeatherConfig | null): void {
        this.config = config;
        if (!config || config.precipitation !== 'rain') {
            this.teardown();
        }
    }

    /** Advance envelopes + drive all subsystems. Call once per frame, pre-render.
     *  `clockTime` is wall-clock (ambience keeps moving in pause/editor). */
    frameUpdate(deltaTime: number, clockTime: number): void {
        const cfg = this.config;
        if (!cfg || cfg.precipitation !== 'rain') return;
        const scene = this.deps.getScene();
        const camera = this.deps.getCamera();
        if (!scene || !camera) return;

        // ── Shared envelopes ──────────────────────────────────────────────────
        const target = THREE.MathUtils.clamp(cfg.intensity ?? 1, 0, 1);
        this.currentIntensity += (target - this.currentIntensity) * Math.min(1, deltaTime * INTENSITY_DAMP_RATE);
        if (cfg.wetness !== undefined) {
            this.wetness = THREE.MathUtils.clamp(cfg.wetness, 0, 1);
        } else if (this.wetness < this.currentIntensity) {
            this.wetness = Math.min(this.currentIntensity, this.wetness + deltaTime * WETNESS_SOAK_RATE);
        } else {
            this.wetness = Math.max(this.currentIntensity, this.wetness - deltaTime * WETNESS_DRY_RATE);
        }

        camera.getWorldPosition(this.camPos);
        const terrain = this.deps.getTerrain();
        const webgpu = isWebGpuActive();

        // ── Wet surface (ride-surface swap + terrain dim) ─────────────────────
        if (this.surface.needsReapply()) {
            this.surface.restore();
            this.surfaceGeneration = -1;
        }
        if (terrain && this.surfaceGeneration !== terrain.generation) {
            this.surface.apply(terrain.group);
            this.surfaceGeneration = terrain.generation;
        }
        this.surface.setTime(clockTime);
        this.surface.setWetness(this.wetness);
        this.surface.setPuddles(cfg.puddles ?? 0.5);
        this.surface.setRippleAmount(this.currentIntensity);
        this.surface.setLook(resolveWetSurfaceLook(cfg));
        // Mirror the scene env so envMapIntensity damping applies (no-op while
        // unchanged) — see WET_ENV_INTENSITY in WetSurfaceMaterial.
        this.surface.setEnvironment(scene.environment);

        // ── Vehicle spray + wet tyre trails ───────────────────────────────────
        // `spray` is construction-time (it allocates the particle buffers), so
        // a game toggling it rebuilds the effect rather than flipping a flag.
        const wantSpray = cfg.spray ?? DEFAULT_VEHICLE_WET_FX_OPTIONS.vaporEnabled;
        if (this.vehicleFx && this.vehicleSprayEnabled !== wantSpray) {
            this.vehicleFx.dispose();
            this.vehicleFx = null;
        }
        if (!this.vehicleFx) {
            this.vehicleSprayEnabled = wantSpray;
            this.vehicleFx = new VehicleWetFX(scene, {
                ...DEFAULT_VEHICLE_WET_FX_OPTIONS,
                vaporEnabled: wantSpray,
                trailAlpha: cfg.trailStrength ?? DEFAULT_VEHICLE_WET_FX_OPTIONS.trailAlpha,
            });
        }
        this.vehicleFx.update(deltaTime, clockTime, this.wetness, this.deps.getVehicles());

        // ── Rain ──────────────────────────────────────────────────────────────
        const wind = cfg.wind ?? DEFAULT_WEATHER_WIND;
        if (webgpu) {
            const renderer = this.deps.getRenderer() as ComputeCapableRenderer | null;
            if (!renderer) return;
            // A WebGPURenderer silently running on its WebGL2 fallback backend
            // cannot dispatch compute (and classic ShaderMaterials don't render
            // under the node pipeline either) — skip the rain rather than
            // simulate into the void. The wet surface (pure node material)
            // still works there.
            if (getActiveBackend(renderer) !== 'webgpu') {
                if (!this.warnedNoComputeBackend) {
                    this.warnedNoComputeBackend = true;
                    console.warn('[Weather] WebGPURenderer is on the WebGL2 fallback backend — rain particles disabled (wet surfaces still active).');
                }
                return;
            }
            if (!this.heightField) this.heightField = new RainHeightField();
            if (!this.rainGpu) this.rainGpu = new RainVFXGpu(scene, this.heightField, DEFAULT_RAIN_VFX_GPU_OPTIONS);
            if (terrain?.bounds) {
                if (this.fieldGeneration !== terrain.generation) {
                    this.heightField.start(terrain.bounds);
                    this.fieldSynced = false;
                    this.fieldGeneration = terrain.generation;
                }
                // Time-sliced collider raycasts; drops couple to the surface
                // once the field is complete (a few seconds after level load).
                if (!this.heightField.isReady) {
                    this.heightField.step(terrain.heightAt);
                } else if (!this.fieldSynced) {
                    this.rainGpu.syncField(this.heightField);
                    this.fieldSynced = true;
                }
            }
            this.rainGpu.setFrameState(this.camPos, wind.x, wind.z);
            this.rainGpu.setIntensity(this.currentIntensity);
            this.rainGpu.computeStep(renderer);
        } else {
            if (!this.rainGl) this.rainGl = new RainVFXWebGl(scene, DEFAULT_RAIN_VFX_WEBGL_OPTIONS);
            this.rainGl.setIntensity(this.currentIntensity);
            const heightAt = terrain
                ? (x: number, z: number): number => terrain.heightAt(x, z)
                : (): number => Number.NaN;
            this.rainGl.update(deltaTime, clockTime, this.camPos, wind.x, wind.z, heightAt);
        }
    }

    /** Tear down all visuals (config off / level without weather). Idempotent. */
    private teardown(): void {
        this.surface.restore();
        this.rainGpu?.dispose();
        this.rainGpu = null;
        this.rainGl?.dispose();
        this.rainGl = null;
        this.vehicleFx?.dispose();
        this.vehicleFx = null;
        this.heightField?.dispose();
        this.heightField = null;
        this.surfaceGeneration = -1;
        this.fieldGeneration = -1;
        this.fieldSynced = false;
        this.currentIntensity = 0;
    }

    dispose(): void {
        this.teardown();
    }
}
