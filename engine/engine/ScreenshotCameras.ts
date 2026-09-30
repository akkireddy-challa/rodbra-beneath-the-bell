/**
 * ScreenshotCameras — pure preset → THREE.PerspectiveCamera builders for
 * the screenshot service. No engine state is mutated; each function returns
 * a fresh camera configured for the requested view.
 */

import * as THREE from 'three';
import type { GameData } from 'types/game.js';
import { fitHeight as fitHeightForFov, DEFAULT_FIT_LEVEL_MARGIN } from 'engine/CameraFit.js';

const DEFAULT_FOV_Y_DEG = 50;
// Camera sits at the exact fit distance for groundWorldSizeX/Z. The world
// bounds typically already include a small buffer, so adding more margin
// here just produces visible sky padding on all sides.

export interface TopdownSpec {
    kind: 'topdown';
    fitLevel: boolean;
    height: number | null;
    tilt: number;
    /** Fit-level margin multiplier. `null` = 1.0 (camera at exact fit distance).
     *  Values > 1 add breathing room around the world; values < 1 crop inward.
     *  Ignored when `fitLevel` is false. */
    margin: number | null;
}

export interface IsometricSpec {
    kind: 'isometric';
    fitLevel: boolean;
    distance: number | null;
    azimuth: number;
    /** Fit-level margin multiplier. `null` = 1.0 (camera at exact fit distance).
     *  Values > 1 add breathing room around the world; values < 1 crop inward.
     *  Ignored when `fitLevel` is false. */
    margin: number | null;
}

export interface OrbitSpec {
    kind: 'orbit';
    target: THREE.Object3D | null;
    distance: number;
    azimuth: number;
    pitch: number;
}

function makePerspective(aspect: number): THREE.PerspectiveCamera {
    return new THREE.PerspectiveCamera(DEFAULT_FOV_Y_DEG, aspect, 0.1, 10000);
}

function fitHeight(sizeX: number, sizeZ: number, aspect: number, margin: number): number {
    return fitHeightForFov(sizeX, sizeZ, aspect, margin, DEFAULT_FOV_Y_DEG);
}

export function buildTopdownCamera(
    gameData: GameData,
    spec: TopdownSpec,
    aspect: number,
): THREE.PerspectiveCamera {
    const cam = makePerspective(aspect);
    let camY: number;
    if (spec.fitLevel) {
        const sizeX = gameData.worldProfileData?.groundWorldSizeX;
        const sizeZ = gameData.worldProfileData?.groundWorldSizeZ;
        if (sizeX == null || sizeZ == null) {
            throw new Error('Topdown fitLevel requires worldProfileData.groundWorldSizeX/Z');
        }
        camY = fitHeight(sizeX, sizeZ, aspect, spec.margin ?? DEFAULT_FIT_LEVEL_MARGIN);
    } else {
        if (spec.height == null) {
            throw new Error('Topdown camera requires `height` when fitLevel is false');
        }
        camY = spec.height;
    }

    cam.position.set(0, camY, 0);
    cam.lookAt(0, 0, 0);
    // `tilt` rotates the camera around world X (forward lean toward +Z).
    if (spec.tilt !== 0) {
        cam.position.applyAxisAngle(new THREE.Vector3(1, 0, 0), spec.tilt);
        cam.lookAt(0, 0, 0);
    }
    cam.updateProjectionMatrix();
    return cam;
}

const ISO_PITCH_RAD = Math.atan(1 / Math.SQRT2); // ≈ 35.264°

export function buildIsometricCamera(
    gameData: GameData,
    spec: IsometricSpec,
    aspect: number,
): THREE.PerspectiveCamera {
    const cam = makePerspective(aspect);
    let distance: number;
    if (spec.fitLevel) {
        const sizeX = gameData.worldProfileData?.groundWorldSizeX;
        const sizeZ = gameData.worldProfileData?.groundWorldSizeZ;
        if (sizeX == null || sizeZ == null) {
            throw new Error('Isometric fitLevel requires worldProfileData.groundWorldSizeX/Z');
        }
        // At iso pitch (35.264°), distance = topdown_height / sin(pitch) = h * √3
        // so the same vertical coverage as buildTopdownCamera is preserved.
        distance = fitHeight(sizeX, sizeZ, aspect, spec.margin ?? DEFAULT_FIT_LEVEL_MARGIN) * Math.sqrt(3);
    } else {
        if (spec.distance == null) {
            throw new Error('Isometric camera requires `distance` when fitLevel is false');
        }
        distance = spec.distance;
    }

    const cosPitch = Math.cos(ISO_PITCH_RAD);
    const sinPitch = Math.sin(ISO_PITCH_RAD);
    cam.position.set(
        distance * cosPitch * Math.cos(spec.azimuth),
        distance * sinPitch,
        distance * cosPitch * Math.sin(spec.azimuth),
    );
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    return cam;
}

export function buildOrbitCamera(
    resolvedTarget: THREE.Object3D | null,
    spec: OrbitSpec,
    aspect: number,
): THREE.PerspectiveCamera {
    if (resolvedTarget == null) {
        throw new Error('Orbit camera needs a target — none provided and no player tracked');
    }
    const cam = makePerspective(aspect);
    const cosP = Math.cos(spec.pitch);
    const sinP = Math.sin(spec.pitch);
    const offset = new THREE.Vector3(
        spec.distance * cosP * Math.cos(spec.azimuth),
        spec.distance * sinP,
        spec.distance * cosP * Math.sin(spec.azimuth),
    );
    const targetWorld = new THREE.Vector3();
    resolvedTarget.getWorldPosition(targetWorld);
    cam.position.copy(targetWorld).add(offset);
    cam.lookAt(targetWorld);
    cam.updateProjectionMatrix();
    return cam;
}
