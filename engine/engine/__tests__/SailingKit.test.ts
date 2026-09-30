import * as THREE from 'three';
import type { GameData } from 'types/game.js';
import { forgedVesselFrame, vesselFrameFromBowStern } from 'engine/sailing/VesselFrame.js';
import { SeaVoyage } from 'engine/sailing/VoyageSpace.js';
import { DEFAULT_SHIP_HELM_OPTIONS, ShipHelm } from 'engine/sailing/ShipHelm.js';
import { DEFAULT_SWELL_SWAY_OPTIONS, SwellSway } from 'engine/sailing/SwellSway.js';
import { DEFAULT_SAILING_WAKE_OPTIONS, SAILING_WAKE_STREAK_NAME, SailingWake } from 'engine/sailing/SailingWake.js';
import { IDENTITY_OCEAN_WAVE_FRAME, toWaveSpace } from 'engine/water/OceanWaveFrame.js';
import { flatWaterSurface } from 'engine/water/FlatWaterSurface.js';

const DEG = Math.PI / 180;

/**
 * The forged galleon of prod game BV0C7Q6DSA9G ("The Black Galleon"), exactly as
 * its level asset carries it: world-space markers, and a vesselDeck feature whose
 * bow/stern params are offsets from the deck centre.
 */
function galleon(markers: Array<{ name: string; x: number; y: number; z: number }>): GameData {
    return {
        assets: [{
            worldForgerMarkers: { named: markers },
            worldForgerFeatures: [
                { kind: 'path', name: 'Deck walk', points: [] },
                {
                    kind: 'vesselDeck',
                    name: 'ShipDeck',
                    points: [
                        { x: 113.89, y: 20.4, z: 96.04 },
                        { x: 126.11, y: 20.4, z: 143.96 },
                    ],
                    params: {
                        floorY: 3.4, length: 52, beam: 13.5, headingDeg: 24,
                        bow: { name: 'Bow', x: 10.58, y: 7.6, z: 23.75 },
                        stern: { name: 'Stern', x: -10.58, y: 7.6, z: -23.75 },
                    },
                },
            ],
        }],
    } as unknown as GameData;
}

const BOW = { name: 'Bow', x: 130.58, y: 24.6, z: 143.75 };
const STERN = { name: 'Stern', x: 109.42, y: 24.6, z: 96.25 };
const DECK_CENTRE = { name: 'DeckCentre', x: 120, y: 20.4, z: 120 };

describe('VesselFrame', () => {
    it('reads a forged galleon: centred on its keel line, heading the way its spawn faces', () => {
        const frame = forgedVesselFrame(galleon([BOW, STERN, DECK_CENTRE]))!;
        expect(frame).not.toBeNull();
        expect(frame.heading).toBeCloseTo(24 * DEG, 3); // playerSpawnRotationY 0.4189
        expect(frame.centre.x).toBeCloseTo(120, 6);
        expect(frame.centre.z).toBeCloseTo(120, 6);
        expect(frame.deckY).toBeCloseTo(20.4, 6);
        expect(frame.length).toBeCloseTo(52, 1);
        expect(frame.beam).toBe(13.5);
    });

    it('falls back to the feature offsets from the deck centre when Bow/Stern markers are missing', () => {
        const frame = forgedVesselFrame(galleon([DECK_CENTRE]))!;
        expect(frame.bow.x).toBeCloseTo(BOW.x, 6);
        expect(frame.bow.z).toBeCloseTo(BOW.z, 6);
        expect(frame.heading).toBeCloseTo(24 * DEG, 3);
    });

    it('matches marker names the way the designer happened to case them', () => {
        const frame = forgedVesselFrame(galleon([
            { ...BOW, name: 'bow' }, { ...STERN, name: 'STERN' }, DECK_CENTRE,
        ]));
        expect(frame?.heading).toBeCloseTo(24 * DEG, 3);
    });

    it('is null, not a throw, for a level that is not a ship', () => {
        expect(forgedVesselFrame(null)).toBeNull();
        expect(forgedVesselFrame({ assets: [] } as unknown as GameData)).toBeNull();
    });
});

describe('SeaVoyage', () => {
    const frame = vesselFrameFromBowStern(
        new THREE.Vector3(BOW.x, 0, BOW.z), new THREE.Vector3(STERN.x, 0, STERN.z), 13.5, 20.4,
    );
    const ahead = (heading: number, distance: number, from = new THREE.Vector2()): THREE.Vector2 =>
        new THREE.Vector2(from.x + Math.sin(heading) * distance, from.y + Math.cos(heading) * distance);

    it('shows what lies ahead on the course off the bow, whatever course is steered', () => {
        for (const course of [frame.heading, frame.heading + 1.3, frame.heading - 2.9]) {
            const voyage = new SeaVoyage(frame);
            voyage.advance(0, 0, course);
            const world = new THREE.Vector3();
            voyage.projectToWorld(ahead(course, 500), 0, world);
            const bearing = Math.atan2(world.x - frame.centre.x, world.z - frame.centre.z);
            expect(Math.cos(bearing - frame.heading)).toBeCloseTo(1, 9);
        }
    });

    it('swings the whole horizon by exactly the course change', () => {
        const voyage = new SeaVoyage(frame);
        const island = new THREE.Vector2(300, -800);
        const before = new THREE.Vector3();
        voyage.projectToWorld(island, 0, before);
        voyage.advance(0, 0, frame.heading + 0.4);
        const after = new THREE.Vector3();
        voyage.projectToWorld(island, 0, after);
        const b0 = Math.atan2(before.x - frame.centre.x, before.z - frame.centre.z);
        const b1 = Math.atan2(after.x - frame.centre.x, after.z - frame.centre.z);
        expect(Math.cos(b1 - (b0 - 0.4))).toBeCloseTo(1, 9);
    });

    it('inverts its own projection', () => {
        const voyage = new SeaVoyage(frame);
        voyage.advance(30, 4.5, frame.heading + 0.7);
        const point = new THREE.Vector2(-120, 640);
        const world = new THREE.Vector3();
        voyage.projectToWorld(point, 0, world);
        expect(voyage.worldToVoyage(world.x, world.z, new THREE.Vector2()).distanceTo(point)).toBeLessThan(1e-9);
    });

    it('closes the range on a destination it steers straight for', () => {
        const voyage = new SeaVoyage(frame);
        const destination = ahead(0.9, 100);
        voyage.advance(10, 4.5, 0.9);
        const fix = voyage.rangeAndBearingTo(destination, { range: 0, bearing: 0 });
        expect(fix.range).toBeCloseTo(55, 6);
        expect(fix.bearing).toBeCloseTo(0.9, 9);
    });

    it('moves the waves with it: the ship stands at its voyage position in wave space', () => {
        const voyage = new SeaVoyage(frame);
        voyage.advance(60, 4.5, frame.heading - 0.5);
        const wave = voyage.waveFrame({ ...IDENTITY_OCEAN_WAVE_FRAME });
        const at = toWaveSpace(wave, frame.centre.x, frame.centre.z, new THREE.Vector2());
        expect(at.distanceTo(voyage.position)).toBeLessThan(1e-9);
    });
});

describe('ShipHelm', () => {
    function run(helm: ShipHelm, seconds: number, command: number, dt = 1 / 60): void {
        const steps = Math.round(seconds / dt);
        for (let i = 0; i < steps; i++) helm.update(dt, command);
    }

    it('takes half the hard-over time to put the rudder from amidships to hard over', () => {
        const helm = new ShipHelm(0, DEFAULT_SHIP_HELM_OPTIONS);
        run(helm, 3.4, 1);
        expect(helm.getRudder()).toBeLessThan(1);
        run(helm, 0.2, 1);
        expect(helm.getRudder()).toBe(1);
    });

    it('builds the swing slowly and carries it after the helm is centred', () => {
        const helm = new ShipHelm(0, DEFAULT_SHIP_HELM_OPTIONS);
        run(helm, 4, 1);
        expect(helm.getTurnRate()).toBeLessThan(0.5 * DEFAULT_SHIP_HELM_OPTIONS.maxTurnRate);
        run(helm, 30, 1);
        expect(helm.getTurnRate()).toBeGreaterThan(0.95 * DEFAULT_SHIP_HELM_OPTIONS.maxTurnRate);
        run(helm, 4, 0);
        expect(helm.getTurnRate()).toBeGreaterThan(0.5 * DEFAULT_SHIP_HELM_OPTIONS.maxTurnRate);
    });

    it('answers the same at 30 and 144 frames a second', () => {
        const slow = new ShipHelm(1, DEFAULT_SHIP_HELM_OPTIONS);
        const fast = new ShipHelm(1, DEFAULT_SHIP_HELM_OPTIONS);
        run(slow, 12, 1, 1 / 30);
        run(fast, 12, 1, 1 / 144);
        run(slow, 12, -0.5, 1 / 30);
        run(fast, 12, -0.5, 1 / 144);
        expect(slow.getHeading()).toBeCloseTo(fast.getHeading(), 2);
        expect(slow.getTurnRate()).toBeCloseTo(fast.getTurnRate(), 3);
    });

    it('leans out of the turn: to port while swinging to starboard', () => {
        const helm = new ShipHelm(0, DEFAULT_SHIP_HELM_OPTIONS);
        run(helm, 20, 1);
        expect(helm.getTurnRate()).toBeGreaterThan(0);
        expect(helm.getHeel()).toBeLessThan(0);
        expect(Math.abs(helm.getHeel())).toBeLessThanOrEqual(DEFAULT_SHIP_HELM_OPTIONS.maxHeel);
    });
});

describe('SwellSway', () => {
    it('lays the same offset over a camera rebuilt every frame instead of accumulating it', () => {
        const sway = new SwellSway(DEFAULT_SWELL_SWAY_OPTIONS);
        sway.update(3.7);
        const first = new THREE.PerspectiveCamera();
        const second = new THREE.PerspectiveCamera();
        sway.apply(first, 0.01);
        sway.apply(second, 0.01);
        // angleTo goes through acos, which cannot resolve identical quaternions below ~1e-8.
        expect(first.quaternion.angleTo(second.quaternion)).toBeLessThan(1e-6);
        expect(first.position.y).toBeCloseTo(sway.getHeave(), 12);
    });

    it('stays within about a degree of roll', () => {
        const sway = new SwellSway(DEFAULT_SWELL_SWAY_OPTIONS);
        for (let i = 0; i < 2000; i++) {
            sway.update(0.1);
            expect(Math.abs(sway.getRoll())).toBeLessThanOrEqual(0.023);
        }
    });
});

describe('SailingWake', () => {
    const frame = vesselFrameFromBowStern(
        new THREE.Vector3(BOW.x, 0, BOW.z), new THREE.Vector3(STERN.x, 0, STERN.z), 13.5, 20.4,
    );

    function streaks(wake: SailingWake): THREE.Mesh[] {
        return wake.group.children.filter((c): c is THREE.Mesh => c.name === SAILING_WAKE_STREAK_NAME);
    }

    it('floats every patch on the water', () => {
        const wake = new SailingWake(frame, flatWaterSurface(17), DEFAULT_SAILING_WAKE_OPTIONS);
        wake.update(1 / 60, 4.5, 0);
        for (const mesh of wake.group.children) {
            expect(mesh.position.y).toBeCloseTo(17 + DEFAULT_SAILING_WAKE_OPTIONS.surfaceClearance, 9);
        }
        wake.dispose();
    });

    it('streams aft and is born again ahead of the bow, clear of the hull', () => {
        const opts = DEFAULT_SAILING_WAKE_OPTIONS;
        const wake = new SailingWake(frame, flatWaterSurface(0), opts);
        const clear = frame.beam / 2 + opts.hullClearance;
        for (let i = 0; i < 60 * 60; i++) {
            wake.update(1 / 60, 4.5, 0);
            for (const mesh of streaks(wake)) {
                expect(mesh.position.z).toBeGreaterThanOrEqual(-opts.fieldAft - 0.1);
                expect(mesh.position.z).toBeLessThanOrEqual(opts.fieldForward);
                expect(Math.abs(mesh.position.x)).toBeGreaterThanOrEqual(clear - 1e-9);
            }
        }
        expect(streaks(wake)).toHaveLength(opts.streakCount);
        wake.dispose();
    });

    it('sweeps the field to port while she swings to starboard', () => {
        const wake = new SailingWake(frame, flatWaterSurface(0), DEFAULT_SAILING_WAKE_OPTIONS);
        const ahead = streaks(wake).filter(m => m.position.z > 20);
        const before = ahead.map(m => m.position.x);
        wake.update(1, 0, 0.05);
        ahead.forEach((m, i) => expect(m.position.x).toBeLessThan(before[i]!));
        wake.dispose();
    });
});
