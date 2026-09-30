import * as THREE from 'three';
import type { EngineLike, GameData } from 'types/game.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';
import { vesselFrameFromBowStern } from 'engine/sailing/VesselFrame.js';
import { SeaVoyage } from 'engine/sailing/VoyageSpace.js';
import {
    DEFAULT_VOYAGE_LANDMARK_OPTIONS,
    DEFAULT_VOYAGE_SCENERY_OPTIONS,
    VoyageScenery,
    type VoyageSceneryOptions,
} from 'engine/sailing/VoyageScenery.js';
import { createSailing, type RenderRegionTarget } from 'engine/sailing/Sailing.js';
import { createOceanSurface } from 'engine/water/OceanSurface.js';

/** Every region the sailing facade hands the placed-object system, in order. */
const mockEnvRegions: Array<THREE.Box3 | null> = [];
jest.mock('engine/EnvironmentObjectSystem.js', () => ({
    getActiveEnvironmentObjectSystem: () => ({
        setRenderRegion: (region: THREE.Box3 | null) => { mockEnvRegions.push(region); },
    }),
}));

/** The Black Galleon's keel line (prod game BV0C7Q6DSA9G): heading 24°, centred on (120, 120). */
const bow = new THREE.Vector3(130.58, 0, 143.75);
const stern = new THREE.Vector3(109.42, 0, 96.25);
const frame = vesselFrameFromBowStern(bow, stern, 13.5, 20.4);
const SEA_LEVEL = 17;

function spawningEngine(): { engine: EngineLike; spawned: SpawnedAsset[] } {
    const spawned: SpawnedAsset[] = [];
    const engine = {
        scene: new THREE.Scene(),
        spawnAsset: async (name: string): Promise<SpawnedAsset> => {
            const asset: SpawnedAsset = {
                object: new THREE.Object3D(),
                objectId: `${name}-${spawned.length}`,
                name,
                collectibleComponent: null,
                dispose: jest.fn(),
            };
            spawned.push(asset);
            return asset;
        },
    } as unknown as EngineLike;
    return { engine, spawned };
}

const SCATTER: VoyageSceneryOptions = { ...DEFAULT_VOYAGE_SCENERY_OPTIONS, assets: ['sea_stack_isle', 'low_atoll'] };

/** Horizontal distance and bearing-off-the-bow of an island as the player sees it. */
function seenFromDeck(object: THREE.Object3D): { distance: number; offBow: number } {
    const dx = object.position.x - frame.centre.x;
    const dz = object.position.z - frame.centre.z;
    const offBow = Math.atan2(dx, dz) - frame.heading;
    return { distance: Math.hypot(dx, dz), offBow: Math.atan2(Math.sin(offBow), Math.cos(offBow)) };
}

describe('VoyageScenery', () => {
    it('lays out the same ocean every run', async () => {
        const a = spawningEngine();
        const b = spawningEngine();
        const sceneryA = new VoyageScenery(a.engine, new SeaVoyage(frame), SEA_LEVEL, SCATTER);
        const sceneryB = new VoyageScenery(b.engine, new SeaVoyage(frame), SEA_LEVEL, SCATTER);
        await Promise.all([sceneryA.ready, sceneryB.ready]);
        expect(a.spawned).toHaveLength(SCATTER.count);
        a.spawned.forEach((asset, i) => {
            expect(asset.object.position.distanceTo(b.spawned[i]!.object.position)).toBeLessThan(1e-9);
        });
    });

    it('never lets an island near the hull and brings recycled ones up ahead', async () => {
        const { engine, spawned } = spawningEngine();
        const voyage = new SeaVoyage(frame);
        const scenery = new VoyageScenery(engine, voyage, SEA_LEVEL, SCATTER);
        await scenery.ready;

        // Twenty minutes at 9 knots with the course wandering: every island is
        // passed, sidestepped or recycled several times over.
        const lastDistance = new Map<SpawnedAsset, number>();
        let recycled = 0;
        let heading = frame.heading;
        for (let t = 0; t < 1200; t++) {
            heading += 0.02 * Math.sin(t / 90);
            voyage.advance(1, 4.5, heading);
            scenery.update();
            for (const asset of spawned) {
                if (!asset.object.visible) continue;
                // offBow is measured from the course she is steering, since the
                // projection swings the world by the course change.
                const { distance, offBow } = seenFromDeck(asset.object);
                expect(distance).toBeGreaterThanOrEqual(SCATTER.avoidRadius - 1e-6);
                expect(distance).toBeLessThanOrEqual(SCATTER.recycleDistance + 1e-6);
                // A recycle is the one jump no ship can make in a second: from the
                // back of the fog to the spawn range. It must land ahead.
                const before = lastDistance.get(asset);
                if (before !== undefined && before - distance > 50) {
                    recycled++;
                    expect(Math.abs(offBow)).toBeLessThanOrEqual(SCATTER.spawnArc + 0.05);
                }
                lastDistance.set(asset, distance);
            }
        }
        expect(recycled).toBeGreaterThan(0);
    });

    it('keeps a landmark where it was put and swings it with the course', async () => {
        const { engine } = spawningEngine();
        const voyage = new SeaVoyage(frame);
        const scenery = new VoyageScenery(engine, voyage, SEA_LEVEL, { ...SCATTER, assets: [] });
        const island = await scenery.addLandmark('landfall_island', new THREE.Vector2(0, 500), DEFAULT_VOYAGE_LANDMARK_OPTIONS);
        expect(island).not.toBeNull();
        // Due voyage-north of the ship, on the course the geometry points: due world-north.
        expect(island!.object.position.x).toBeCloseTo(frame.centre.x, 6);
        expect(island!.object.position.z).toBeCloseTo(frame.centre.z + 500, 6);
        expect(island!.object.position.y).toBeCloseTo(SEA_LEVEL - DEFAULT_VOYAGE_LANDMARK_OPTIONS.sink, 9);

        // Put her head round to frame.heading + 0.5: the island still lies at true
        // bearing 0, so from the deck it is now that far on the port bow.
        const course = frame.heading + 0.5;
        voyage.advance(0, 0, course);
        scenery.update();
        const { offBow } = seenFromDeck(island!.object);
        expect(offBow).toBeCloseTo(0 - course, 6);
    });
});

describe('createSailing', () => {
    const galleon = {
        assets: [{
            worldForgerMarkers: {
                named: [
                    { name: 'Bow', x: bow.x, y: 24.6, z: bow.z },
                    { name: 'Stern', x: stern.x, y: 24.6, z: stern.z },
                ],
            },
            worldForgerFeatures: [{
                kind: 'vesselDeck',
                points: [{ x: 113.89, y: 20.4, z: 96.04 }],
                params: { beam: 13.5 },
            }],
        }],
    } as unknown as GameData;

    function oceanEngine(): { engine: EngineLike; ocean: ReturnType<typeof createOceanSurface> } {
        const scene = new THREE.Scene();
        const ocean = createOceanSurface({ seaLevelY: SEA_LEVEL });
        const engine = {
            scene,
            addToWorld: (...objects: THREE.Object3D[]) => { scene.add(...objects); },
            getOceanSurface: () => ocean,
        } as unknown as EngineLike;
        return { engine, ocean };
    }

    it('is null, not a throw, on a level that is not a ship', () => {
        expect(createSailing(oceanEngine().engine, { assets: [] } as unknown as GameData, {})).toBeNull();
    });

    it('clips the level to the hull and moves the sea with the voyage', () => {
        const { engine, ocean } = oceanEngine();
        let region: THREE.Box3 | null = null;
        const target: RenderRegionTarget = { setRenderRegion: (box) => { region = box; } };
        const sailing = createSailing(engine, galleon, { renderRegionTarget: target })!;
        expect(sailing).not.toBeNull();

        const kept = region as THREE.Box3 | null;
        expect(kept?.containsPoint(new THREE.Vector3(bow.x, 20, bow.z))).toBe(true);
        expect(kept?.containsPoint(new THREE.Vector3(stern.x, 20, stern.z))).toBe(true);
        // The forged coast 90 m off the starboard bow is not drawn.
        expect(kept?.containsPoint(new THREE.Vector3(bow.x + 90, 20, bow.z + 40))).toBe(false);
        // Nor are the props placed on it — the forge's islet pines floated in open sea without this.
        expect(mockEnvRegions[mockEnvRegions.length - 1]).toBe(kept);

        // A minute on a steady course (helm amidships) makes 270 m of way.
        for (let i = 0; i < 120; i++) sailing.update(0.5, 0);
        expect(sailing.voyage.position.length()).toBeCloseTo(4.5 * 60, 3);
        for (let i = 0; i < 20; i++) sailing.update(0.5, 1);

        // The sea under the ship's centre is the sea at the ship's voyage position.
        const p = sailing.voyage.position;
        const want = SEA_LEVEL + ocean.waveField.heightAt(p.x, p.y, ocean.time);
        expect(ocean.heightAt(frame.centre.x, frame.centre.z)).toBeCloseTo(want, 9);

        sailing.dispose();
        expect(region).toBeNull();
        expect(mockEnvRegions[mockEnvRegions.length - 1]).toBeNull();
        const pinned = SEA_LEVEL + ocean.waveField.heightAt(frame.centre.x, frame.centre.z, ocean.time);
        expect(ocean.heightAt(frame.centre.x, frame.centre.z)).toBeCloseTo(pinned, 9);
        ocean.dispose();
    });
});
