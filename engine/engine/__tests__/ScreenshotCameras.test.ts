import * as THREE from 'three';
import {
    buildTopdownCamera,
    buildIsometricCamera,
    buildOrbitCamera,
    type TopdownSpec,
    type IsometricSpec,
    type OrbitSpec,
} from 'engine/ScreenshotCameras.js';
import type { GameData } from 'types/game.js';

function makeGameData(sizeX: number, sizeZ: number): GameData {
    return {
        worldProfileData: {
            groundWorldSizeX: sizeX,
            groundWorldSizeZ: sizeZ,
        },
    } as unknown as GameData;
}

describe('buildTopdownCamera', () => {
    it('places camera above world center at the exact fit distance for the larger axis', () => {
        const gameData = makeGameData(100, 60);
        const spec: TopdownSpec = { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null };
        const cam = buildTopdownCamera(gameData, spec, 16 / 9);

        // sizeX=100, sizeZ=60, fovY=50°, aspect=16/9.
        // fovX = 2*atan(tan(25°) * 16/9) ≈ 79.3°.
        // heightForX = (100/2) / tan(fovX/2) ≈ 60.3
        // heightForZ = (60/2) / tan(25°) ≈ 64.3  ← larger, dominates
        // camY = max(heightForX, heightForZ) * 1.0 ≈ 64.3.
        expect(cam.position.x).toBeCloseTo(0, 5);
        expect(cam.position.z).toBeCloseTo(0, 5);
        expect(cam.position.y).toBeGreaterThan(62);
        expect(cam.position.y).toBeLessThan(67);

        // Looks straight down at origin (small floating-point tolerance for lookAt from above).
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        expect(dir.x).toBeCloseTo(0, 3);
        expect(dir.y).toBeCloseTo(-1, 3);
        expect(dir.z).toBeCloseTo(0, 3);

        expect(cam.aspect).toBeCloseTo(16 / 9, 5);
    });

    it('uses explicit height when fitLevel is false', () => {
        const gameData = makeGameData(100, 100);
        const spec: TopdownSpec = { kind: 'topdown', fitLevel: false, height: 25, tilt: 0, margin: null };
        const cam = buildTopdownCamera(gameData, spec, 1);

        expect(cam.position.y).toBeCloseTo(25, 5);
    });

    it('throws when fitLevel is true but worldProfileData is missing', () => {
        const spec: TopdownSpec = { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null };
        expect(() => buildTopdownCamera({} as GameData, spec, 1)).toThrow(/fitLevel requires worldProfileData/);
    });

    it('respects explicit margin (camera height scales linearly with margin)', () => {
        const gameData = makeGameData(60, 60);
        const baseSpec: TopdownSpec = { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null };
        const baseCam = buildTopdownCamera(gameData, baseSpec, 1);

        const widerSpec: TopdownSpec = { ...baseSpec, margin: 1.5 };
        const widerCam = buildTopdownCamera(gameData, widerSpec, 1);

        // margin 1.5 should put camera exactly 1.5× higher than the default 1.0.
        expect(widerCam.position.y / baseCam.position.y).toBeCloseTo(1.5, 5);
    });
});

describe('buildIsometricCamera', () => {
    it('places camera at the true isometric angle (35.264° pitch) above world center', () => {
        const gameData = makeGameData(50, 50);
        const spec: IsometricSpec = { kind: 'isometric', fitLevel: true, distance: null, azimuth: 0, margin: null };
        const cam = buildIsometricCamera(gameData, spec, 1);

        // pitch = atan(1/√2) ≈ 0.6155 rad
        const expectedPitch = Math.atan(1 / Math.SQRT2);
        const pitch = Math.asin(cam.position.y / cam.position.length());
        expect(pitch).toBeCloseTo(expectedPitch, 3);

        // Looks at origin.
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const toOrigin = cam.position.clone().negate().normalize();
        expect(dir.x).toBeCloseTo(toOrigin.x, 3);
        expect(dir.y).toBeCloseTo(toOrigin.y, 3);
        expect(dir.z).toBeCloseTo(toOrigin.z, 3);
    });

    it('uses explicit distance when fitLevel is false', () => {
        const spec: IsometricSpec = { kind: 'isometric', fitLevel: false, distance: 30, azimuth: 0, margin: null };
        const cam = buildIsometricCamera({} as GameData, spec, 1);
        expect(cam.position.length()).toBeCloseTo(30, 5);
    });

    it('throws when fitLevel is true but worldProfileData is missing', () => {
        const spec: IsometricSpec = { kind: 'isometric', fitLevel: true, distance: null, azimuth: 0, margin: null };
        expect(() => buildIsometricCamera({} as GameData, spec, 1)).toThrow(/fitLevel requires worldProfileData/);
    });
});

describe('buildOrbitCamera', () => {
    it('places camera at spherical coords around the given target', () => {
        const target = new THREE.Object3D();
        target.position.set(10, 0, 5);
        const spec: OrbitSpec = {
            kind: 'orbit',
            target,
            distance: 8,
            azimuth: 0,
            pitch: 0,
        };
        const cam = buildOrbitCamera(target, spec, 1);

        // azimuth=0, pitch=0 → camera at +X relative to target.
        expect(cam.position.x).toBeCloseTo(18, 5);
        expect(cam.position.y).toBeCloseTo(0, 5);
        expect(cam.position.z).toBeCloseTo(5, 5);
    });

    it('throws when the resolved target is null', () => {
        const spec: OrbitSpec = {
            kind: 'orbit',
            target: null,
            distance: 5,
            azimuth: 0,
            pitch: 0,
        };
        expect(() => buildOrbitCamera(null, spec, 1)).toThrow(/Orbit camera needs a target/);
    });
});
