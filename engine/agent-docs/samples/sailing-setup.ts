/**
 * Minimal sailing wiring (mechanic-sailing.md): a forged ship that sails while
 * the player walks its deck and steers for an island.
 *
 * Note what is NOT here: anything that moves the ship. It is the level — baked
 * geometry with static colliders — and moving it would leave the player behind.
 * `createSailing` moves everything else: the sea and its foam stream past the
 * hull, the horizon swings when the helm goes over, the camera rides the swell,
 * and the forged coast is clipped away. Game code adds the helm keys, the goal
 * and the HUD text.
 *
 * Referenced from agent docs (read-docs name: `samples/sailing-setup`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import type { EngineLike, GameData } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import {
    createSailing,
    DEFAULT_VOYAGE_LANDMARK_OPTIONS,
    DEFAULT_VOYAGE_SCENERY_OPTIONS,
    voyageSceneryDistancesForFog,
    type RenderRegionTarget,
    type Sailing,
} from 'engine/sailing/index.js';

export interface ShipVoyageOptions {
    /** World position of the ship's wheel — within `helmReach` of it, the helm keys steer. */
    wheelPosition: THREE.Vector3;
    helmReach: number;
    /** Where the island lies in voyage space; the ship starts at (0, 0). */
    destination: THREE.Vector2;
    /** Close enough to call it landfall, in metres. */
    arrivalRadius: number;
    destinationAsset: string;
    islandAssets: string[];
    /** `worldProfileData.fogConfig.far` — the islands rise out of this haze. */
    fogFar: number;
    /** `worldProfileData.openWater.seaLevelY`. */
    seaLevelY: number;
    /** `worldGenerator.getVxlSceneTerrain()` — the forged level, clipped to the hull. */
    renderRegionTarget: RenderRegionTarget | null;
}

export const DEFAULT_SHIP_VOYAGE_OPTIONS: ShipVoyageOptions = {
    wheelPosition: new THREE.Vector3(),
    helmReach: 3.5,
    // ~930 m at about 070° — off the bow, so the wheel matters. ~3.5 min at 4.5 m/s.
    destination: new THREE.Vector2(870, 320),
    arrivalRadius: 30,
    destinationAsset: 'landfall_island',
    islandAssets: [],
    fogFar: 1700,
    seaLevelY: 0,
    renderRegionTarget: null,
};

/**
 * One crossing: the ship under sail, a helm the player works from the wheel,
 * and an island to make. Construct it in `load()` once the player controller
 * exists; call `update` before the camera and `applyCamera` after it.
 */
export class ShipVoyage {
    /** Null when the level is not a forged vessel — the game then plays as a static deck. */
    readonly sailing: Sailing | null;

    private readonly playerController: PlayerController;
    private readonly options: ShipVoyageOptions;
    private readonly fix = { range: Infinity, bearing: 0 };
    private arrived = false;

    constructor(
        engine: EngineLike,
        gameData: GameData | null,
        playerController: PlayerController,
        options: ShipVoyageOptions,
    ) {
        this.playerController = playerController;
        this.options = options;

        this.sailing = createSailing(engine, gameData, {
            seaLevelY: options.seaLevelY,
            renderRegionTarget: options.renderRegionTarget,
            scenery: {
                ...DEFAULT_VOYAGE_SCENERY_OPTIONS,
                ...voyageSceneryDistancesForFog(options.fogFar),
                assets: options.islandAssets,
            },
        });
        void this.sailing?.scenery?.addLandmark(options.destinationAsset, options.destination, {
            ...DEFAULT_VOYAGE_LANDMARK_OPTIONS,
            scale: 4,
        });

        // One call binds the desktop key AND the phone button (control-system.md).
        // Q and E are the engine's own actions, so the helm takes Z and X.
        playerController.registerCustomAction({
            action: 'helmPort',
            desktop: { keys: ['KeyZ'] },
            mobile: {
                label: 'PORT',
                behavior: 'continuous',
                position: { bottom: 'min(290px, 60vh)', right: '100px', width: '70px', height: '70px', borderRadius: '50%', fontSize: '13px' },
            },
        });
        playerController.registerCustomAction({
            action: 'helmStarboard',
            desktop: { keys: ['KeyX'] },
            mobile: {
                label: 'STBD',
                behavior: 'continuous',
                position: { bottom: 'min(290px, 60vh)', right: '20px', width: '70px', height: '70px', borderRadius: '50%', fontSize: '13px' },
            },
        });
    }

    /**
     * Advance the voyage. Call BEFORE the camera controller. Returns true on the
     * one frame she makes landfall — end the game there.
     */
    update(deltaTime: number, playerPosition: THREE.Vector3 | null): boolean {
        if (!this.sailing) return false;

        // Only a helmsman steers. Walk away and the rudder centres itself, so
        // she holds whatever course she was left on.
        const atHelm = playerPosition !== null
            && playerPosition.distanceTo(this.options.wheelPosition) <= this.options.helmReach;
        const keys = this.playerController.keys;
        let command = 0;
        if (atHelm && keys['helmPort']) command -= 1;
        if (atHelm && keys['helmStarboard']) command += 1;

        this.sailing.update(deltaTime, command);

        this.sailing.voyage.rangeAndBearingTo(this.options.destination, this.fix);
        if (!this.arrived && this.fix.range <= this.options.arrivalRadius) {
            this.arrived = true;
            this.sailing.setSpeed(0);
            return true;
        }
        return false;
    }

    /** Ride the swell. Call AFTER the active camera controller has updated. */
    applyCamera(camera: THREE.Camera | null): void {
        this.sailing?.applyCamera(camera);
    }

    /** `930 m · bearing 070°` — the range, and the course that would take her there. */
    landfallText(): string {
        const degrees = Math.round((this.fix.bearing * 180) / Math.PI) % 360;
        return `${Math.round(this.fix.range)} m · bearing ${degrees.toString().padStart(3, '0')}°`;
    }

    dispose(): void {
        this.sailing?.dispose();
    }
}
