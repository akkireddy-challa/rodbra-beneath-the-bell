/**
 * Minimal boat-racing wiring (mechanic-boat-racing.md).
 *
 * Note what is NOT here: the ocean and the sky. `worldProfileData.openWater`
 * makes the engine build, own and animate them, skip terrain generation
 * entirely, and hand the sea to the player's `BoatMovement` automatically. Game
 * code only adds the RACE — course, rivals, laps.
 *
 * The first version of this sample built its own `OceanSurface` and passed it
 * around by hand. Every hand-off was a chance to miss one, and missing one is
 * silent: a boat with no surface floats on a flat plane at y = 0 while the
 * visible sea rolls past it. Read the ocean from the engine instead.
 *
 * Referenced from agent docs (read-docs name: `samples/boat-racing-setup`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { OceanSurface } from 'engine/water/OceanSurface.js';
import {
    createBoatRaceCourse, BoatMovement, AiBoat, type BoatRaceCourse,
} from 'engine/boat/index.js';

const RIVAL_COLORS = [0x22304a, 0xb98a4a, 0x2f6ea8, 0x2e7d5a, 0x8d3f7a];

export interface BoatRaceOptions {
    /** Course centreline. A closed loop; the gates and racing line come from it. */
    waypoints: THREE.Vector3[];
    /** Number of AI rivals. */
    rivalCount: number;
    /** Laps to win. */
    totalLaps: number;
}

export const DEFAULT_BOAT_RACE_OPTIONS: BoatRaceOptions = {
    waypoints: [],
    rivalCount: 4,
    totalLaps: 3,
};

/**
 * One race: the course, the rivals, the lap count.
 *
 * Construct it after the engine has loaded (the ocean exists from `loadGame`),
 * then call `update(deltaTime)` from the game loop.
 */
export class BoatRace {
    readonly course: BoatRaceCourse;
    /** The engine's ocean. Everything that floats reads its height from this. */
    readonly ocean: OceanSurface;

    private readonly rivals: AiBoat[] = [];
    private readonly boat: BoatMovement | null;
    private readonly options: BoatRaceOptions;

    private elapsed = 0;
    private nextGate = 0;
    private lap = 0;
    private finished = false;
    private readonly prevBoatPos = new THREE.Vector3();
    private readonly boatPos = new THREE.Vector3();

    constructor(
        engine: GameEngine,
        playerController: PlayerController,
        options: Partial<BoatRaceOptions> & Pick<BoatRaceOptions, 'waypoints'>,
    ) {
        this.options = { ...DEFAULT_BOAT_RACE_OPTIONS, ...options };

        // The engine built the sea from worldProfileData.openWater. If this is
        // null that flag is missing — fix the world config rather than building
        // a second ocean here, or gameplay and graphics ride different water.
        const ocean = engine.getOceanSurface();
        if (!ocean) {
            throw new Error('BoatRace requires worldProfileData.openWater — the engine has no ocean.');
        }
        this.ocean = ocean;

        // ---- course ----
        this.course = createBoatRaceCourse({ waypoints: this.options.waypoints, surface: ocean });
        engine.scene?.add(this.course.group);

        // ---- the player's boat ----
        // Installed by worldProfileData.playerMovement.mode = 'boat', and it
        // found the ocean by itself. Nothing to wire; the handle is only for
        // HUD state and gate scoring. Put the player SPAWN POINT on waypoint 0
        // in world.json rather than teleporting after load — engine spawn
        // placement runs after game setup and would undo a teleport.
        const movement = playerController.getMovementSystem();
        this.boat = movement instanceof BoatMovement ? movement : null;
        if (!this.boat) {
            console.warn('[BoatRace] Player is not on a boat — set worldProfileData.playerMovement.mode = "boat".');
        }
        this.boat?.getHullPosition(this.prevBoatPos);

        // ---- rivals ----
        // Spaced along the racing line and offset into their own lanes, so the
        // pack races side by side instead of nose to tail.
        const scene = engine.scene;
        for (let i = 0; i < this.options.rivalCount && scene; i++) {
            this.rivals.push(new AiBoat(scene, ocean, {
                waypoints: this.course.centerline,
                startIndex: (i + 1) * 3,
                laneOffset: (i % 2 === 0 ? 1 : -1) * (2.5 + Math.floor(i / 2) * 2.5),
                config: {
                    hullColor: RIVAL_COLORS[i % RIVAL_COLORS.length] ?? 0x22304a,
                    // Rivals are slower for a visible reason, never by a cheat
                    // multiplier applied behind the scenes.
                    maxSpeed: 24 - i * 0.8,
                },
            }));
        }
    }

    /**
     * Drive the race. The engine already advanced the ocean this frame, so
     * everything here reads a surface that is up to date.
     */
    update(deltaTime: number): void {
        this.elapsed += deltaTime;
        this.course.update();
        for (const r of this.rivals) r.update(deltaTime);
        this.scoreGates();
    }

    /**
     * Lap counting, gated on gate ORDER. Counting a lap on the finish line
     * alone lets the player U-turn over it and rack up laps in seconds — the
     * same trap the car-racing recipe warns about, and open water makes it
     * easier, not harder, because there is no track to leave.
     */
    private scoreGates(): void {
        if (this.finished || !this.boat) return;
        this.boat.getHullPosition(this.boatPos);
        if (this.course.gateCrossed(this.nextGate, this.prevBoatPos, this.boatPos)) {
            this.nextGate++;
            if (this.nextGate >= this.course.gates.length) {
                this.nextGate = 0;
                this.lap++;
                if (this.lap >= this.options.totalLaps) this.finished = true;
            }
        }
        this.prevBoatPos.copy(this.boatPos);
    }

    /** Feed a HUD: speed in km/h, lap, gate, airtime, and whether it's won. */
    getRaceState(): {
        speedKmh: number;
        lap: number;
        totalLaps: number;
        nextGate: number;
        airborne: boolean;
        elapsedSeconds: number;
        finished: boolean;
    } {
        const s = this.boat?.getBoatState();
        return {
            speedKmh: (s?.speed ?? 0) * 3.6,
            lap: Math.min(this.lap + 1, this.options.totalLaps),
            totalLaps: this.options.totalLaps,
            nextGate: this.nextGate,
            airborne: s ? !s.onWater : false,
            elapsedSeconds: this.elapsed,
            finished: this.finished,
        };
    }

    /** Player position among the rivals, 1-based, by course progress. */
    getPlacing(): number {
        const mine = this.course.distanceAlong(this.boatPos) + this.lap * this.course.length;
        let ahead = 0;
        const scratch = new THREE.Vector3();
        for (const r of this.rivals) {
            r.getPosition(scratch);
            const theirs = this.course.distanceAlong(scratch) + r.getLaps() * this.course.length;
            if (theirs > mine) ahead++;
        }
        return ahead + 1;
    }

    dispose(): void {
        for (const r of this.rivals) r.dispose();
        this.course.dispose();
        // The ocean and sky belong to the engine — never dispose them here.
    }
}

/**
 * A closed oval course on open water, with its first straight running through
 * `origin` on the given heading — so the player spawn, the camera and the first
 * gates all line up without hand-placing anything.
 *
 * Sizing: a lap should take 60-90 s. At the default 26 m/s that is a 1.5-2.3 km
 * centreline, i.e. roughly the defaults below. A course sized like a car track
 * is over in eight seconds.
 */
export function buildOvalCourse(
    origin: THREE.Vector3,
    headingRad: number,
    halfLength = 300,
    halfWidth = 130,
    points = 28,
): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const cos = Math.cos(headingRad);
    const sin = Math.sin(headingRad);
    for (let i = 0; i < points; i++) {
        const a = (i / points) * Math.PI * 2;
        // Local frame: +Z along the heading, +X to its right.
        const lz = Math.sin(a) * halfLength;
        const lx = halfWidth - Math.cos(a) * halfWidth;
        out.push(new THREE.Vector3(
            origin.x + lx * cos + lz * sin,
            0,
            origin.z - lx * sin + lz * cos,
        ));
    }
    return out;
}
