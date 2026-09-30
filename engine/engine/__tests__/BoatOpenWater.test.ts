import * as THREE from 'three';
import { BoatMovement } from 'engine/boat/BoatMovement.js';
import { DEFAULT_BOAT_CONFIG, mergeBoatConfig, quadraticDragFor } from 'engine/boat/BoatConfig.js';
import { BoatMotor } from 'engine/boat/BoatMotor.js';
import { pinEnvironmentObjectsToAuthoredPositions } from 'engine/water/OpenWaterWorld.js';
import { flatWaterSurface } from 'engine/water/FlatWaterSurface.js';
import { resolveOpenWaterConfig } from 'engine/water/EngineWaterFeatures.js';

/**
 * Regression guards for the three bugs that made the first boat-racing game
 * unplayable out of the box (game HX0M6O6ZVWX1, 2026-08-14). Each one was
 * silent — the config looked right, nothing threw, and the game just did the
 * wrong thing.
 */
describe('boat racing — out-of-the-box regressions', () => {
    /**
     * BUG 1: every genre template calls
     * `getMovementSystem().setMoveSpeed(characterConfig.runSpeed)` at spawn.
     * BoatMovement honoured it by rewriting maxSpeed, so a 28 m/s racing boat
     * was quietly clamped to a ~5 m/s walking pace and the player reported
     * being "a walking character".
     */
    it('ignores the character run speed pushed in by genre templates', () => {
        const boat = new BoatMovement({ maxSpeed: 28, boostMaxSpeed: 36 });
        boat.setMoveSpeed(5); // what every template does at spawn
        expect(boat.getMoveSpeed()).toBe(28);
        expect(boat.getBoatState().speed).toBe(0);
    });

    it('still allows a deliberate top-speed change through updateConfig', () => {
        const boat = new BoatMovement({ maxSpeed: 28 });
        boat.updateConfig({ maxSpeed: 12 });
        expect(boat.getMoveSpeed()).toBe(12);
    });

    /**
     * BUG 2: nothing pinned placed objects, so with no terrain under them every
     * island/hut asked a missing terrain for its height, got 0, and surfaced at
     * the waterline.
     */
    it('pins placed environment objects to their authored positions', () => {
        const gameData = {
            environmentObjects: [
                { placeOnTerrain: true, flattenTerrain: true },
                { placeOnTerrain: true },
            ],
        };
        expect(pinEnvironmentObjectsToAuthoredPositions(gameData)).toBe(2);
        for (const obj of gameData.environmentObjects) {
            expect(obj).toMatchObject({ forcePosition: true, placeOnTerrain: false, flattenTerrain: false });
        }
    });

    it('tolerates game data with no placed objects', () => {
        expect(pinEnvironmentObjectsToAuthoredPositions(null)).toBe(0);
        expect(pinEnvironmentObjectsToAuthoredPositions({})).toBe(0);
    });

    /**
     * BUG 3 (the tuning trap behind "the boat is slow"): authoring BOTH a top
     * speed and a drag curve let them disagree. Drag is now derived so thrust
     * and drag cancel exactly at maxSpeed.
     */
    it('derives drag so a boat actually reaches its configured top speed', () => {
        const cfg = mergeBoatConfig({ maxSpeed: 26 });
        const q = quadraticDragFor(cfg);
        const dragAtTop = q * cfg.maxSpeed * cfg.maxSpeed + cfg.dragLinear * cfg.maxSpeed;
        expect(dragAtTop).toBeCloseTo(cfg.acceleration, 6);
    });

    it('reaches ~maxSpeed under sustained throttle on flat water', () => {
        const cfg = mergeBoatConfig({ maxSpeed: 26, waveSurfAccel: 0 });
        const motor = new BoatMotor(cfg);
        motor.setPosition(0, cfg.rideHeight, 0, 0);
        const water = flatWaterSurface(0);
        const input = { throttle: 1, steer: 0, boost: false, jump: false };
        const dt = 1 / 60;
        for (let i = 0; i < 60 * 60; i++) {
            motor.commit(motor.step(dt, input, water), dt);
        }
        // Within 5% of the authored top speed. The pre-fix motor plateaued
        // around 8 m/s with the very same config.
        expect(motor.getState().speed).toBeGreaterThan(cfg.maxSpeed * 0.95);
        expect(motor.getState().speed).toBeLessThanOrEqual(cfg.maxSpeed * 1.02);
    });

    it('keeps the documented default top speed reachable', () => {
        expect(quadraticDragFor(DEFAULT_BOAT_CONFIG)).toBeGreaterThan(0);
    });
});

/**
 * The boat must find the engine's ocean by itself. Requiring the game to hand
 * it over produced a silent failure — a boat riding a flat plane at y = 0 while
 * the visible sea rolled past it.
 */
describe('BoatMovement water binding', () => {
    /** Minimal stand-in for the one thing the auto-bind reads. */
    function fakeOcean(height: number): {
        heightAt: () => number;
        normalAt: (x: number, z: number, out: THREE.Vector3) => THREE.Vector3;
    } {
        return {
            heightAt: () => height,
            normalAt: (_x, _z, out) => out.set(0, 1, 0),
        };
    }

    it('adopts an explicitly supplied surface', () => {
        const boat = new BoatMovement({});
        const ocean = fakeOcean(7);
        boat.setWaterSurface(ocean);
        const pos = new THREE.Vector3();
        boat.teleport(new THREE.Vector3(3, 0, 4), 0);
        boat.getHullPosition(pos);
        expect(pos.y).toBeCloseTo(7 + DEFAULT_BOAT_CONFIG.rideHeight, 5);
    });

    /**
     * The fix for "the whole ocean is missing": the boat binds to the engine's
     * ocean itself. It has to POLL — `applyOpenWater` runs inside loadGame,
     * which can land after the movement system is installed, so a one-shot read
     * at attach time sees nothing and the boat stays on flat water for ever.
     */
    it('adopts the engine ocean as soon as one exists, not just at attach time', () => {
        const boat = new BoatMovement({});
        let ocean: ReturnType<typeof fakeOcean> | null = null;
        const engine = { getOceanSurface: () => ocean };
        const resolve = (boat as unknown as {
            resolveSurface: (e: typeof engine) => void;
        }).resolveSurface.bind(boat);

        resolve(engine); // ocean not built yet — nothing to adopt
        const pos = new THREE.Vector3();
        boat.teleport(new THREE.Vector3(0, 0, 0), 0);
        boat.getHullPosition(pos);
        expect(pos.y).toBeCloseTo(DEFAULT_BOAT_CONFIG.rideHeight, 5);

        ocean = fakeOcean(11); // loadGame finishes, engine now owns a sea
        resolve(engine);
        boat.teleport(new THREE.Vector3(0, 0, 0), 0);
        boat.getHullPosition(pos);
        expect(pos.y).toBeCloseTo(11 + DEFAULT_BOAT_CONFIG.rideHeight, 5);
    });

    it('never lets the engine ocean override an explicitly supplied surface', () => {
        const boat = new BoatMovement({});
        boat.setWaterSurface(fakeOcean(3));
        const resolve = (boat as unknown as {
            resolveSurface: (e: { getOceanSurface: () => unknown }) => void;
        }).resolveSurface.bind(boat);
        resolve({ getOceanSurface: () => fakeOcean(99) });

        const pos = new THREE.Vector3();
        boat.teleport(new THREE.Vector3(0, 0, 0), 0);
        boat.getHullPosition(pos);
        expect(pos.y).toBeCloseTo(3 + DEFAULT_BOAT_CONFIG.rideHeight, 5);
    });

    it('falls back to flat water rather than failing when there is no ocean', () => {
        const boat = new BoatMovement({});
        const pos = new THREE.Vector3();
        boat.teleport(new THREE.Vector3(0, 0, 0), 0);
        boat.getHullPosition(pos);
        expect(pos.y).toBeCloseTo(DEFAULT_BOAT_CONFIG.rideHeight, 5);
    });
});

/**
 * The second field failure (game 6QK3F8973OXJ): both flags were set correctly
 * and the game STILL reported "no ocean", because game code asks for it while
 * `genreModule.load()` is running — before the engine had applied it. The
 * ordering is fixed at the call site; these guard the config resolution that
 * decides whether there is an ocean at all.
 */
describe('resolveOpenWaterConfig', () => {
    it('uses an explicit openWater config as authored', () => {
        expect(resolveOpenWaterConfig({ openWater: { preset: 'storm' } })).toEqual({ preset: 'storm' });
    });

    it('implies open water for a boat game that forgot the flag', () => {
        expect(resolveOpenWaterConfig({ playerMovement: { mode: 'boat' } })).toEqual({});
    });

    it('leaves a coastal boat level alone — waterLevelY means a visible seafloor', () => {
        expect(resolveOpenWaterConfig({ playerMovement: { mode: 'boat' }, waterLevelY: 4 })).toBeNull();
    });

    it('does not draw a painted sky over a level that already has a skybox', () => {
        expect(resolveOpenWaterConfig({ openWater: {}, skyboxUrl: 'sky.png' })).toEqual({ sky: false });
        // ...unless the level explicitly asked for it.
        expect(resolveOpenWaterConfig({ openWater: { sky: true }, skyboxUrl: 'sky.png' })).toEqual({ sky: true });
    });

    it('does not turn every other game into an ocean', () => {
        expect(resolveOpenWaterConfig({})).toBeNull();
        expect(resolveOpenWaterConfig(null)).toBeNull();
        expect(resolveOpenWaterConfig({ playerMovement: { mode: 'ski' } })).toBeNull();
    });
});
