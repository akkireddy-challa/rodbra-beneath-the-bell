import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';
import { SeededRandom } from 'engine/SeededRandom.js';
import type { SeaVoyage } from 'engine/sailing/VoyageSpace.js';

/**
 * Land the ship passes on her way somewhere else — and the land she is making for.
 *
 * A helm is only believable if turning it moves something, and on a ship that
 * cannot move the only thing that can is the scenery. Every island here lives in
 * voyage space and is projected into the world each frame (`SeaVoyage`), so
 * putting the wheel over swings the horizon by the course change and holding a
 * course walks the near ones down the beam and astern. Baked terrain cannot do
 * that at any price — which is why the level is clipped to the ship
 * (`setRenderRegion`) and this draws the land instead.
 *
 * The scatter is kept alive rather than laid out once: an island that falls
 * past `recycleDistance` is deep in the fog, so it is lifted round to the arc
 * ahead of the bow without anyone seeing it go, and the sea is never sailed
 * empty. Nothing here collides.
 */
export interface VoyageSceneryOptions {
    /** Asset ids or names to draw the scatter from, cycled in order. Missing ones are skipped. */
    assets: readonly string[];
    /** Islands alive at once. */
    count: number;
    /** Uniform scale range, so copies of one asset do not read as one thing at different ranges. */
    scaleRange: readonly [number, number];
    /** Metres an island is sunk per unit of scale, so its base sits in the water. */
    sinkPerScale: number;
    /** Nearest an island is seeded at the start, in metres. */
    seedMinDistance: number;
    /** Where a recycled island is put back — inside the haze. See `voyageSceneryDistancesForFog`. */
    spawnDistance: number;
    /** Past this it is behind the haze and can be moved. Must exceed `spawnDistance`. */
    recycleDistance: number;
    /**
     * Closest an island may come, in metres. A course held straight at one would
     * otherwise walk it through the deck, so it is eased sideways by exactly the
     * shortfall — it passes down the beam rather than blinking out off the bow.
     */
    avoidRadius: number;
    /** Belt and braces: anything nearer than this is not drawn. */
    nearLimit: number;
    /** Recycled islands are born within this many radians either side of the bow. */
    spawnArc: number;
    /** Seed for the scatter, so the same ocean turns up every run. */
    seed: number;
}

/** Tuned against `fogConfig.far` = 1700 — pass `voyageSceneryDistancesForFog` for another fog. */
export const DEFAULT_VOYAGE_SCENERY_OPTIONS: VoyageSceneryOptions = {
    assets: [],
    count: 12,
    scaleRange: [1.6, 4.6],
    sinkPerScale: 1.2,
    seedMinDistance: 200,
    spawnDistance: 1620,
    recycleDistance: 1760,
    avoidRadius: 140,
    nearLimit: 60,
    spawnArc: 2.0,
    seed: 0x5ea15,
};

/**
 * Spawn and recycle distances for a fog whose far distance is `fogFar`: an island
 * is born already the haze's colour and fades UP out of the horizon, and is
 * moved only once it is behind the haze again.
 */
export function voyageSceneryDistancesForFog(fogFar: number): Pick<VoyageSceneryOptions, 'spawnDistance' | 'recycleDistance'> {
    return { spawnDistance: fogFar - 80, recycleDistance: fogFar + 60 };
}

/** A fixed place in voyage space — a destination. Never recycled, never pushed aside. */
export interface VoyageLandmarkOptions {
    /** Uniform scale. */
    scale: number;
    /** Its own yaw, radians, so it is not presented square-on. */
    spin: number;
    /** Metres it is sunk below sea level, so its base sits in the water. */
    sink: number;
}

export const DEFAULT_VOYAGE_LANDMARK_OPTIONS: VoyageLandmarkOptions = { scale: 1, spin: 0, sink: 1.5 };

interface Placed {
    asset: SpawnedAsset;
    /** Absolute voyage-space position — the same space `SeaVoyage` keeps the ship in. */
    readonly position: THREE.Vector2;
    spin: number;
    readonly sink: number;
    /** Scatter islands recycle and step aside; landmarks stay where they were put. */
    readonly landmark: boolean;
}

export class VoyageScenery {
    /** Resolves once the scatter has spawned (islands that failed to spawn are skipped). */
    readonly ready: Promise<void>;

    private readonly engine: EngineLike;
    private readonly voyage: SeaVoyage;
    private readonly seaLevelY: number;
    private readonly options: VoyageSceneryOptions;
    private readonly random: SeededRandom;
    private readonly placed: Placed[] = [];
    private disposed = false;

    private readonly offset = new THREE.Vector2();
    private readonly sidestep = new THREE.Vector2();

    constructor(engine: EngineLike, voyage: SeaVoyage, seaLevelY: number, options: VoyageSceneryOptions) {
        this.engine = engine;
        this.voyage = voyage;
        this.seaLevelY = seaLevelY;
        this.options = options;
        this.random = new SeededRandom(options.seed);
        this.ready = this.spawnScatter();
    }

    private async spawnScatter(): Promise<void> {
        const { assets, count, scaleRange } = this.options;
        if (assets.length === 0) return;
        for (let i = 0; i < count; i++) {
            const scale = scaleRange[0] + this.random.next() * (scaleRange[1] - scaleRange[0]);
            const bearing = this.random.next() * Math.PI * 2;
            // sqrt keeps the scatter even by area rather than crowding the ship.
            const distance = this.options.seedMinDistance
                + Math.sqrt(this.random.next()) * (this.options.recycleDistance - this.options.seedMinDistance);
            const spin = this.random.next() * Math.PI * 2;
            const asset = await this.spawn(assets[i % assets.length]!, scale, `VoyageIsle${i}`);
            if (!asset) continue;
            const isle: Placed = {
                asset,
                position: new THREE.Vector2(
                    this.voyage.position.x + Math.sin(bearing) * distance,
                    this.voyage.position.y + Math.cos(bearing) * distance,
                ),
                spin,
                sink: this.options.sinkPerScale * scale,
                landmark: false,
            };
            this.placed.push(isle);
            this.place(isle);
        }
    }

    /**
     * Put `asset` at a fixed voyage-space `position` — the island the voyage is
     * making for. Resolves to the spawned asset, or null when it did not spawn
     * (the voyage can still be sailed on instruments).
     */
    async addLandmark(asset: string, position: THREE.Vector2, options: VoyageLandmarkOptions): Promise<SpawnedAsset | null> {
        const spawned = await this.spawn(asset, options.scale, `VoyageLandmark:${asset}`);
        if (!spawned) return null;
        const landmark: Placed = {
            asset: spawned,
            position: position.clone(),
            spin: options.spin,
            sink: options.sink,
            landmark: true,
        };
        this.placed.push(landmark);
        this.place(landmark);
        return spawned;
    }

    private async spawn(name: string, scale: number, label: string): Promise<SpawnedAsset | null> {
        if (!this.engine.spawnAsset) return null;
        try {
            const asset = await this.engine.spawnAsset(name, {
                position: { x: 0, y: this.seaLevelY, z: 0 },
                scale,
                collision: false,
                shadows: false,
                name: label,
            });
            if (!asset) console.warn(`[VoyageScenery] asset "${name}" did not spawn — skipping it`);
            // A dispose() that raced the load must not leave the island behind.
            if (asset && this.disposed) {
                asset.dispose();
                return null;
            }
            return asset;
        } catch (error) {
            console.warn(`[VoyageScenery] asset "${name}" failed to spawn`, error);
            return null;
        }
    }

    /** Call once a frame, after the voyage has advanced. */
    update(): void {
        for (const item of this.placed) this.place(item);
    }

    private place(item: Placed): void {
        const ship = this.voyage.position;
        const heading = this.voyage.getHeading();
        this.offset.subVectors(item.position, ship);
        let distance = this.offset.length();

        if (!item.landmark) {
            const { avoidRadius, recycleDistance } = this.options;
            if (distance > recycleDistance) {
                this.recycle(item, ship, heading);
                this.offset.subVectors(item.position, ship);
                distance = this.offset.length();
            } else if (distance < avoidRadius && distance > 0.001) {
                // Across the course, on whichever side it already lies, so it draws
                // off the bow and down the beam instead of holding station ahead.
                const side = this.offset.x * Math.cos(heading) - this.offset.y * Math.sin(heading);
                const hand = side < 0 ? -1 : 1;
                this.sidestep.set(Math.cos(heading) * hand, -Math.sin(heading) * hand);
                // The push that lands it exactly on the radius: |offset + t·sidestep| = avoidRadius.
                // `along` ≥ 0 because the side was chosen to match, so t is the positive root.
                const along = this.offset.dot(this.sidestep);
                const push = -along + Math.sqrt(along * along - distance * distance + avoidRadius * avoidRadius);
                item.position.addScaledVector(this.sidestep, push);
                this.offset.subVectors(item.position, ship);
                distance = this.offset.length();
            }
        }

        const object = item.asset.object;
        object.visible = item.landmark || distance > this.options.nearLimit;
        if (!object.visible) return;
        const swing = this.voyage.projectToWorld(item.position, this.seaLevelY - item.sink, object.position);
        // Turn WITH the sea, not on the spot: the island keeps the face it had.
        object.rotation.y = item.spin + swing;
    }

    /** Lift an island out of the back of the fog round to the arc ahead of the bow. */
    private recycle(item: Placed, ship: THREE.Vector2, heading: number): void {
        const bearing = heading + (this.random.next() * 2 - 1) * this.options.spawnArc;
        item.position.set(
            ship.x + Math.sin(bearing) * this.options.spawnDistance,
            ship.y + Math.cos(bearing) * this.options.spawnDistance,
        );
        item.spin = this.random.next() * Math.PI * 2;
    }

    dispose(): void {
        this.disposed = true;
        for (const item of this.placed) item.asset.dispose();
        this.placed.length = 0;
    }
}
