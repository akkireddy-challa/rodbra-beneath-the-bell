/**
 * The engine's water, in one owner: the see-through COASTAL plane for voxel
 * levels with a seafloor, and the opaque OPEN-WATER ocean for games played on
 * the open sea. Both are driven from `worldProfileData`, so a game gets them
 * without writing any wiring.
 *
 * ## Why the ocean is engine-owned
 *
 * The first version of the boat stack made the game build its own
 * `OceanSurface` and hand it to the boat, the course and the wake. Every one of
 * those hand-offs was a chance to forget one, and the failure mode was silent:
 * a boat with no surface floats on a flat plane at y = 0, under or above the
 * sea you can see. Owning the ocean here means `BoatMovement` can just ask the
 * engine for it, and there is exactly one for everything to agree on.
 *
 * The two features are mutually exclusive — a level either has a seafloor worth
 * looking through at, or it is open ocean. Turning one on clears the other
 * rather than stacking two water surfaces at different heights.
 */

import * as THREE from 'three';
import type { OpenWaterConfig } from 'types/game.js';
import { buildWaterSurfaceMesh, type CoastalSunDirection } from 'engine/WaterSurface.js';
import type { CoastalHeightAt } from 'engine/water/CoastalDepthField.js';
import { createOceanSurface, oceanWaveFieldForPreset, type OceanSurface } from 'engine/water/OceanSurface.js';
import { createStylizedSkyDome, type StylizedSkyDome } from 'engine/sky/StylizedSkyDome.js';
import type { OceanPalette } from 'engine/shaders/StylizedOceanMaterial.js';

/**
 * How far the camera must see on an open-water level, in metres.
 *
 * The engine builds its camera with a 1 km far plane, which suits a level you
 * walk around and not one you sail: the ocean disc reaches 8 km and hazes into
 * its horizon colour over the first few, so a 1 km clip cuts the sea off
 * mid-haze and the "horizon" becomes a hard navy line against the sky. Out
 * here the sea has finished fading before it is clipped. Depth precision is
 * set by the NEAR plane, which is untouched.
 */
export const DEFAULT_OPEN_WATER_VIEW_DISTANCE = 6000;

/** Level bounds the coastal plane spans. */
export interface CoastalBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

/** What building the ocean needs from the engine. `GameEngine` satisfies it. */
export interface OpenWaterHost {
    readonly scene: THREE.Scene | null;
    getSunDirection(): THREE.Vector3 | null;
    addToWorld(object: THREE.Object3D): void;
}

/**
 * The open-water config a level should actually run with.
 *
 * A boat needs a sea. If `playerMovement.mode` is `boat` the level is open
 * water whether or not anyone wrote the flag, so imply it — the two settings
 * are authored by different parts of the pipeline, and getting one without the
 * other produced a boat game with no ocean in it.
 *
 * The one case where a boat legitimately has no open ocean is a COASTAL level
 * (`waterLevelY`) — a harbour, a lake with a visible bottom — so an explicit
 * `waterLevelY` suppresses the implication rather than fighting it.
 */
export function resolveOpenWaterConfig(
    profile: {
        openWater?: OpenWaterConfig;
        waterLevelY?: number;
        skyboxUrl?: string;
        playerMovement?: { mode?: string };
    } | null | undefined,
): OpenWaterConfig | null {
    let config = profile?.openWater ?? null;
    if (!config) {
        if (profile?.playerMovement?.mode !== 'boat') return null;
        if (typeof profile.waterLevelY === 'number') return null;
        console.warn('[Water] playerMovement.mode="boat" with no worldProfileData.openWater — assuming an open-water level. Set openWater explicitly to choose the sea state.');
        config = {};
    }
    // Two skies is never what anyone wanted. A level that already has a skybox
    // keeps it unless it asked for the painted dome by name; the painted dome
    // is the recommended look, so drop `skyboxUrl` to get it.
    if (profile?.skyboxUrl && config.sky === undefined) {
        config = { ...config, sky: false };
    }
    return config;
}

export class EngineWaterFeatures {
    private coastalMesh: THREE.Mesh | null = null;
    private ocean: OceanSurface | null = null;
    private sky: StylizedSkyDome | null = null;
    private elapsed = 0;
    /** Config for the current level, kept so the ocean can be built on demand. */
    private openWaterConfig: OpenWaterConfig | null = null;
    private host: OpenWaterHost | null = null;

    /**
     * Coastal see-through plane at `waterLevelY`, or null to remove it. The
     * caller supplies the level bounds because only it knows which terrain
     * system is active.
     */
    applyCoastal(
        scene: THREE.Object3D | null,
        waterLevelY: number | null,
        bounds: CoastalBounds | null,
        sunPosition: CoastalSunDirection,
        heightAt?: CoastalHeightAt,
    ): THREE.Mesh | null {
        this.disposeCoastal();
        if (waterLevelY === null || !scene || !bounds) return null;
        if (this.ocean) {
            console.warn('[Water] waterLevelY ignored: this level is openWater. A level is either coastal (seafloor visible through the surface) or open ocean, never both.');
            return null;
        }
        this.coastalMesh = buildWaterSurfaceMesh(waterLevelY, bounds, sunPosition, heightAt);
        return this.coastalMesh;
    }

    /**
     * Set (or clear) this level's open-water config and build the sea now.
     *
     * MUST be called before genre code runs. Generated game code asks for the
     * ocean while it is being constructed — i.e. inside `genreModule.load()` —
     * so an ocean applied after that point does not exist when the game looks
     * for it, and the game concludes the level is misconfigured. `getOceanSurface`
     * below also builds on demand, so late callers are covered either way.
     */
    configureOpenWater(host: OpenWaterHost, config: OpenWaterConfig | null): void {
        this.disposeOpenWater();
        this.host = host;
        this.openWaterConfig = config;
        if (config) this.buildOpenWater();
    }

    private buildOpenWater(): void {
        const host = this.host;
        const config = this.openWaterConfig;
        if (!host || !config || !host.scene || this.ocean) return;
        this.elapsed = 0;

        const waveField = oceanWaveFieldForPreset(
            config.preset ?? 'ocean',
            config.amplitudeScale ?? 1,
            config.windDirectionDeg ?? 0,
        );
        const sunDirection = host.getSunDirection();
        this.ocean = createOceanSurface({
            waveField,
            seaLevelY: config.seaLevelY ?? 0,
            ...(config.palette ? { palette: config.palette as Partial<OceanPalette> } : {}),
            ...(sunDirection ? { sunDirection } : {}),
        });
        host.addToWorld(this.ocean.mesh);

        if (config.sky !== false) {
            this.sky = createStylizedSkyDome({
                ...(config.skyHorizon !== undefined ? { horizon: config.skyHorizon } : {}),
                ...(config.skyZenith !== undefined ? { zenith: config.skyZenith } : {}),
            });
            host.addToWorld(this.sky.group);
        }

        // The coastal plane and the ocean must never coexist; the ocean wins
        // because it is the one the gameplay rides.
        this.disposeCoastal();
    }

    /**
     * The live ocean, or null when this level is not open water. Everything
     * that floats — boats, buoys, course ribbons, wake — reads its height from
     * this one object.
     */
    getOceanSurface(): OceanSurface | null {
        // Build on demand: an ordering slip in a caller must not read as "this
        // level has no ocean", which is indistinguishable from a missing flag.
        if (!this.ocean && this.openWaterConfig) this.buildOpenWater();
        return this.ocean;
    }

    /**
     * Advance the sea and recentre it on the camera. Called once per frame from
     * the engine's render path — deliberately NOT gated on gameplay being
     * unpaused: the editor moves the camera with gameplay stopped, and an ocean
     * that stops following it leaves the viewer staring off the edge of the disc.
     */
    update(deltaTime: number, camera: THREE.Object3D | null): void {
        if (!camera || !this.ocean) return;
        this.elapsed += Math.max(0, Math.min(0.1, deltaTime));
        this.ocean.update(camera, this.elapsed);
        this.sky?.update(camera, this.elapsed);
        this.ensureViewDistance(camera);
    }

    /**
     * Let the camera see to the horizon (see DEFAULT_OPEN_WATER_VIEW_DISTANCE).
     * Checked every frame rather than set once, because CameraManager can hand
     * over a different camera mid-game. Only ever raises: a game that pushed
     * its far plane out further keeps it.
     */
    private ensureViewDistance(camera: THREE.Object3D): void {
        const perspective = camera as THREE.PerspectiveCamera;
        if (!perspective.isPerspectiveCamera || perspective.far >= DEFAULT_OPEN_WATER_VIEW_DISTANCE) return;
        perspective.far = DEFAULT_OPEN_WATER_VIEW_DISTANCE;
        perspective.updateProjectionMatrix();
    }

    private disposeCoastal(): void {
        if (!this.coastalMesh) return;
        this.coastalMesh.removeFromParent();
        this.coastalMesh.geometry.dispose();
        (this.coastalMesh.material as THREE.Material).dispose();
        this.coastalMesh = null;
    }

    private disposeOpenWater(): void {
        this.ocean?.dispose();
        this.ocean = null;
        this.sky?.dispose();
        this.sky = null;
        this.openWaterConfig = null;
        this.host = null;
    }

    dispose(): void {
        this.disposeCoastal();
        this.disposeOpenWater();
    }
}
