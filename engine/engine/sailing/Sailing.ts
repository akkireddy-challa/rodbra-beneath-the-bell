import * as THREE from 'three';
import type { EngineLike, GameData } from 'types/game.js';
import type { OceanSurface } from 'engine/water/OceanSurface.js';
import { flatWaterSurface } from 'engine/water/FlatWaterSurface.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { IDENTITY_OCEAN_WAVE_FRAME, type OceanWaveFrame } from 'engine/water/OceanWaveFrame.js';
import { forgedVesselFrame, type VesselFrame } from 'engine/sailing/VesselFrame.js';
import { SeaVoyage } from 'engine/sailing/VoyageSpace.js';
import { DEFAULT_SHIP_HELM_OPTIONS, ShipHelm, type ShipHelmOptions } from 'engine/sailing/ShipHelm.js';
import { DEFAULT_SAILING_WAKE_OPTIONS, SailingWake, type SailingWakeOptions } from 'engine/sailing/SailingWake.js';
import { DEFAULT_SWELL_SWAY_OPTIONS, SwellSway, type SwellSwayOptions } from 'engine/sailing/SwellSway.js';
import { VoyageScenery, type VoyageSceneryOptions } from 'engine/sailing/VoyageScenery.js';

/**
 * A ship that is the level, sailing.
 *
 * The hull is baked geometry and never moves (the player's capsule would be left
 * behind if it did), so this moves everything else: a virtual voyage advances
 * along the helm's course, the ocean's waves and the foam stream past the hull,
 * the horizon's islands swing when she turns, the camera rides the swell, and the
 * baked level is clipped to the ship so no land that cannot move is drawn.
 *
 * The game keeps the parts only it knows: how the helm is worked (keys, touch
 * buttons, a wheel that turns), what the HUD says, the sounds, and what the
 * voyage is for. See `agent-docs/mechanic-sailing.md`.
 */

/** Anything that can draw only part of a baked level — `VxlSceneTerrainSystem` does. */
export interface RenderRegionTarget {
    setRenderRegion(region: THREE.Box3 | null): void;
}

export interface SailingOptions {
    /** Way the ship makes, metres per second. Change it later with `setSpeed`. */
    speed: number;
    /** Mean sea level, for the foam when the level has no engine ocean to ride. */
    seaLevelY: number;
    helm: ShipHelmOptions;
    /** Foam streaming past the hull; null for none. */
    wake: SailingWakeOptions | null;
    /** Camera roll and heave; null to leave the camera alone. */
    sway: SwellSwayOptions | null;
    /** Islands on the horizon; null for an empty sea (landmarks need scenery — pass `assets: []`). */
    scenery: VoyageSceneryOptions | null;
    /**
     * The baked level to clip to the ship — `worldGenerator.getVxlSceneTerrain()`
     * in the voxel genre. Placed objects outside the hull are clipped with it (a
     * prop on the forged coast could not move either). Null draws everything.
     */
    renderRegionTarget: RenderRegionTarget | null;
    /** Metres of level kept round the hull when clipping. */
    renderRegionPadding: number;
    /** Move the engine ocean's waves past the hull as well as the foam. */
    moveOcean: boolean;
}

/** ~9 knots on a ship forged as the level, with the whole illusion switched on. */
export const DEFAULT_SAILING_OPTIONS: SailingOptions = {
    speed: 4.5,
    seaLevelY: 0,
    helm: DEFAULT_SHIP_HELM_OPTIONS,
    wake: DEFAULT_SAILING_WAKE_OPTIONS,
    sway: DEFAULT_SWELL_SWAY_OPTIONS,
    scenery: null,
    renderRegionTarget: null,
    renderRegionPadding: 30,
    moveOcean: true,
};

export class Sailing {
    readonly frame: VesselFrame;
    readonly voyage: SeaVoyage;
    readonly helm: ShipHelm;
    readonly wake: SailingWake | null;
    readonly sway: SwellSway | null;
    readonly scenery: VoyageScenery | null;

    private readonly options: SailingOptions;
    private readonly ocean: OceanSurface | null;
    private readonly waveFrame: OceanWaveFrame = { ...IDENTITY_OCEAN_WAVE_FRAME };
    private speed: number;

    constructor(engine: EngineLike, frame: VesselFrame, options: SailingOptions) {
        this.frame = frame;
        this.options = options;
        this.speed = options.speed;
        this.voyage = new SeaVoyage(frame);
        this.helm = new ShipHelm(frame.heading, options.helm);

        const ocean = engine.getOceanSurface?.() ?? null;
        this.ocean = options.moveOcean ? ocean : null;

        const surfaceY = ocean?.seaLevelY ?? options.seaLevelY;
        this.wake = options.wake
            ? new SailingWake(frame, ocean ?? flatWaterSurface(options.seaLevelY), options.wake)
            : null;
        if (this.wake) {
            if (engine.addToWorld) engine.addToWorld(this.wake.group);
            else engine.scene?.add(this.wake.group);
        }

        this.sway = options.sway ? new SwellSway(options.sway) : null;
        this.scenery = options.scenery ? new VoyageScenery(engine, this.voyage, surfaceY, options.scenery) : null;
        if (options.renderRegionTarget) {
            const region = this.shipRegion();
            options.renderRegionTarget.setRenderRegion(region);
            getActiveEnvironmentObjectSystem()?.setRenderRegion(region);
        }
    }

    /** The hull's footprint, padded, from sea floor to sky. */
    private shipRegion(): THREE.Box3 {
        const pad = this.options.renderRegionPadding + this.frame.beam / 2;
        const { bow, stern } = this.frame;
        return new THREE.Box3(
            new THREE.Vector3(Math.min(bow.x, stern.x) - pad, -Infinity, Math.min(bow.z, stern.z) - pad),
            new THREE.Vector3(Math.max(bow.x, stern.x) + pad, Infinity, Math.max(bow.z, stern.z) + pad),
        );
    }

    /** Way the ship makes, metres per second — drop it to anchor, raise it under more sail. */
    setSpeed(metresPerSecond: number): void {
        this.speed = Math.max(0, metresPerSecond);
    }

    getSpeed(): number {
        return this.speed;
    }

    /**
     * Advance the voyage one frame. `helmCommand` is the order at the wheel: −1
     * hard a-port, +1 hard a-starboard, 0 to let the rudder centre (a helmsman
     * walking away should send 0 — she then holds whatever course she is on).
     */
    update(deltaTime: number, helmCommand: number): void {
        this.helm.update(deltaTime, helmCommand);
        this.voyage.advance(deltaTime, this.speed, this.helm.getHeading());
        this.wake?.update(deltaTime, this.speed, this.helm.getTurnRate());
        this.sway?.update(deltaTime);
        this.scenery?.update();
        this.ocean?.setWaveFrame(this.voyage.waveFrame(this.waveFrame));
    }

    /**
     * Ride the swell and lean into the turn. Call AFTER the active camera
     * controller has updated this frame (see `SwellSway.apply`).
     */
    applyCamera(camera: THREE.Camera | null): void {
        this.sway?.apply(camera, this.helm.getHeel());
    }

    dispose(): void {
        this.wake?.dispose();
        this.scenery?.dispose();
        this.ocean?.setWaveFrame(IDENTITY_OCEAN_WAVE_FRAME);
        if (this.options.renderRegionTarget) {
            this.options.renderRegionTarget.setRenderRegion(null);
            getActiveEnvironmentObjectSystem()?.setRenderRegion(null);
        }
    }
}

/**
 * Put a forged vessel level under sail, or return `null` when the level is not
 * a ship (no `vesselDeck` feature) — degrade, never throw. For a ship built some
 * other way, construct `Sailing` with `vesselFrameFromBowStern`.
 */
export function createSailing(
    engine: EngineLike,
    gameData: GameData | null | undefined,
    options: Partial<SailingOptions>,
): Sailing | null {
    const frame = forgedVesselFrame(gameData);
    if (!frame) {
        console.warn('[Sailing] this level has no forged vesselDeck feature — nothing to sail');
        return null;
    }
    return new Sailing(engine, frame, { ...DEFAULT_SAILING_OPTIONS, ...options });
}
