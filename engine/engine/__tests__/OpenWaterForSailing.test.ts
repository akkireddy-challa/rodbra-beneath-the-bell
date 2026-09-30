import * as THREE from 'three';
import { createOceanSurface } from 'engine/water/OceanSurface.js';
import { createOceanWaveField } from 'engine/water/OceanWaveField.js';
import {
    IDENTITY_OCEAN_WAVE_FRAME,
    oceanWaveFrameForVoyage,
    toWaveSpace,
    type OceanWaveFrame,
} from 'engine/water/OceanWaveFrame.js';
import { DEFAULT_OPEN_WATER_VIEW_DISTANCE, EngineWaterFeatures } from 'engine/water/EngineWaterFeatures.js';

/**
 * The open ocean a ship-as-the-level sails on (`engine/sailing/`). The ship's
 * geometry is baked and never moves, so the SEA has to: its waves are sampled
 * through an OceanWaveFrame, and everything that floats reads the same frame
 * through `heightAt` / `normalAt`.
 */
describe('ocean wave frame', () => {
    const field = createOceanWaveField();
    const SEA_LEVEL = 3;
    const T = 12.5;

    function ocean(): ReturnType<typeof createOceanSurface> {
        const surface = createOceanSurface({ waveField: field, seaLevelY: SEA_LEVEL });
        surface.update(new THREE.Object3D(), T);
        return surface;
    }

    /** Voyage → world, written independently of the frame: w = pivot + R(s)·(v − voyage). */
    function voyageToWorld(
        pivot: THREE.Vector2, voyage: THREE.Vector2, swing: number, v: THREE.Vector2,
    ): THREE.Vector2 {
        const dx = v.x - voyage.x;
        const dz = v.y - voyage.y;
        const c = Math.cos(swing);
        const s = Math.sin(swing);
        return new THREE.Vector2(pivot.x + dx * c + dz * s, pivot.y - dx * s + dz * c);
    }

    it('leaves a world-pinned sea exactly as it was under the identity frame', () => {
        const surface = ocean();
        surface.setWaveFrame(IDENTITY_OCEAN_WAVE_FRAME);
        for (const [x, z] of [[0, 0], [17.3, -42], [-250, 90]] as const) {
            expect(surface.heightAt(x, z)).toBeCloseTo(SEA_LEVEL + field.heightAt(x, z, T), 10);
            const got = surface.normalAt(x, z, new THREE.Vector3());
            const want = field.normalAt(x, z, T, new THREE.Vector3());
            expect(got.distanceTo(want)).toBeLessThan(1e-9);
        }
        surface.dispose();
    });

    it('samples the wave at the voyage point a world point stands for', () => {
        const pivot = new THREE.Vector2(120, 120);
        const voyage = new THREE.Vector2(400, 1450);
        const swing = 0.52;
        const frame: OceanWaveFrame = { ...IDENTITY_OCEAN_WAVE_FRAME };
        oceanWaveFrameForVoyage(pivot.x, pivot.y, voyage.x, voyage.y, swing, frame);

        const surface = ocean();
        surface.setWaveFrame(frame);
        for (const v of [new THREE.Vector2(410, 1470), new THREE.Vector2(380, 1300), voyage]) {
            const w = voyageToWorld(pivot, voyage, swing, v);
            expect(toWaveSpace(frame, w.x, w.y, new THREE.Vector2()).distanceTo(v)).toBeLessThan(1e-9);
            expect(surface.heightAt(w.x, w.y)).toBeCloseTo(SEA_LEVEL + field.heightAt(v.x, v.y, T), 9);
        }
        surface.dispose();
    });

    it('puts the ship itself at its voyage position', () => {
        const frame = oceanWaveFrameForVoyage(120, 120, 400, 1450, -1.1, { ...IDENTITY_OCEAN_WAVE_FRAME });
        const at = toWaveSpace(frame, 120, 120, new THREE.Vector2());
        expect(at.x).toBeCloseTo(400, 9);
        expect(at.y).toBeCloseTo(1450, 9);
    });

    it('returns a world-space normal that matches the drawn surface', () => {
        const frame = oceanWaveFrameForVoyage(-30, 55, 900, -200, 2.3, { ...IDENTITY_OCEAN_WAVE_FRAME });
        const surface = ocean();
        surface.setWaveFrame(frame);

        const e = 1e-3;
        for (const [x, z] of [[4, 9], [-61.5, 30.25]] as const) {
            const dhdx = (surface.heightAt(x + e, z) - surface.heightAt(x - e, z)) / (2 * e);
            const dhdz = (surface.heightAt(x, z + e) - surface.heightAt(x, z - e)) / (2 * e);
            const want = new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
            const got = surface.normalAt(x, z, new THREE.Vector3());
            expect(got.distanceTo(want)).toBeLessThan(1e-5);
        }
        surface.dispose();
    });
});

describe('open water view distance', () => {
    function openWater(): EngineWaterFeatures {
        const scene = new THREE.Scene();
        const water = new EngineWaterFeatures();
        water.configureOpenWater({
            scene,
            getSunDirection: () => null,
            addToWorld: (object) => { scene.add(object); },
        }, {});
        return water;
    }

    it('lets the default 1 km camera see the whole haze out to the horizon', () => {
        const water = openWater();
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        water.update(1 / 60, camera);
        expect(camera.far).toBe(DEFAULT_OPEN_WATER_VIEW_DISTANCE);
        water.dispose();
    });

    it('never pulls in a far plane a game pushed out further', () => {
        const water = openWater();
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 9000);
        water.update(1 / 60, camera);
        expect(camera.far).toBe(9000);
        water.dispose();
    });

    it('leaves the camera alone on a level with no open water', () => {
        const water = new EngineWaterFeatures();
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        water.update(1 / 60, camera);
        expect(camera.far).toBe(1000);
    });
});
