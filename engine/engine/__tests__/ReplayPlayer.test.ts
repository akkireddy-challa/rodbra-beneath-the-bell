/**
 * Playback tests.
 *
 * The property that matters end to end: a ghost placed at time T sits where the
 * recorded car was at time T. Everything else here defends a piece of that —
 * the recorder/player time mapping agreeing, interpolation not overshooting,
 * and step tracks refusing to interpolate.
 */

import * as THREE from 'three';
import { ReplayPlayer } from 'engine/replay/ReplayPlayer.js';
import { GhostVehicle, DEFAULT_GHOST_VEHICLE_OPTIONS } from 'engine/replay/GhostVehicle.js';
import { applyGhostMaterial, DEFAULT_GHOST_MATERIAL_OPTIONS } from 'engine/replay/GhostMaterial.js';
import {
    DEFAULT_REPLAY_RECORDER_OPTIONS,
    ReplayRecorder,
} from 'engine/replay/ReplayRecorder.js';
import { createInputSampler, createVehicleMotionSampler } from 'engine/replay/ReplaySubjects.js';
import { INPUT_TRACK, MOTION_TRACK } from 'engine/replay/ReplayChannels.js';
import type { RunRecord } from 'engine/replay/ReplayTypes.js';
import type { VehicleDescriptor } from 'engine/networking/NetworkTypes.js';

/** A car on a circle of radius 50, one lap in 10 s. Analytic, so we can check playback against truth. */
function circlePosition(seconds: number): THREE.Vector3 {
    const angle = (seconds / 10) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * 50, 1.5, Math.sin(angle) * 50);
}

function recordCircleLap(seconds = 10, fps = 60): RunRecord {
    const state = { t: 0 };
    const vehicle = {
        getPosition: (): THREE.Vector3 => circlePosition(state.t),
        getChassisObject: (): THREE.Object3D => {
            const object = new THREE.Object3D();
            object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (state.t / 10) * Math.PI * 2);
            return object;
        },
        getForwardSpeed: (): number => 31.4,
        getSteeringAngle: (): number => 0.2,
        getWheelCount: (): number => 4,
        // Rolling without slip: 31.4 m/s on a 0.35 m wheel.
        getWheelRotation: (): number => state.t * (31.4 / 0.35),
    };
    const recorder = new ReplayRecorder(
        { ...DEFAULT_REPLAY_RECORDER_OPTIONS, inputChannels: null },
        createVehicleMotionSampler(vehicle),
        null,
    );
    recorder.start();
    for (let i = 0; i < seconds * fps; i++) {
        state.t += 1 / fps;
        recorder.update(1 / fps);
    }
    return recorder.stop();
}

function descriptor(): VehicleDescriptor {
    return {
        chassisSize: { width: 1.8, height: 0.6, length: 4.2 },
        chassisColor: 0xcc2222,
        wheels: [
            { position: { x: -0.9, y: -0.3, z: 1.4 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
            { position: { x: 0.9, y: -0.3, z: 1.4 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
            { position: { x: -0.9, y: -0.3, z: -1.4 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
            { position: { x: 0.9, y: -0.3, z: -1.4 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
        ],
        bodyParts: [
            { position: { x: 0, y: 0.5, z: 0 }, size: { width: 1.6, height: 0.5, length: 2.0 }, color: 0x222222, isWindow: true },
        ],
    };
}

describe('ReplayPlayer time addressing', () => {
    test('the ghost retraces the recorded path within quantization error', () => {
        const player = new ReplayPlayer(recordCircleLap());
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        const posX = motion.indexOf('posX');
        const posZ = motion.indexOf('posZ');

        // Sample at times deliberately BETWEEN stored samples (15 Hz = 66.7 ms).
        let worst = 0;
        for (let ms = 0; ms <= 9000; ms += 37) {
            motion.seek(ms);
            const truth = circlePosition(ms / 1000);
            const error = Math.hypot(motion.scalar(posX) - truth.x, motion.scalar(posZ) - truth.z);
            worst = Math.max(worst, error);
        }
        // Catmull-Rom through 15 Hz samples of a 50 m circle, with reflected
        // endpoints. Duplicating the endpoint instead measured 0.115 m in the
        // first segment alone, so this bound is what defends that fix.
        expect(worst).toBeLessThan(0.02);
    });

    test('seeking is order-independent', () => {
        const player = new ReplayPlayer(recordCircleLap());
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        const posX = motion.indexOf('posX');

        motion.seek(4321);
        const forwards = motion.scalar(posX);
        motion.seek(8000);
        motion.seek(4321);
        expect(motion.scalar(posX)).toBe(forwards);
    });

    test('before the start and after the end clamp to the endpoints', () => {
        const player = new ReplayPlayer(recordCircleLap(2));
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        const posX = motion.indexOf('posX');

        motion.seek(-5000);
        const atStart = motion.scalar(posX);
        motion.seek(0);
        expect(atStart).toBeCloseTo(motion.scalar(posX), 6);

        motion.seek(999_999);
        const atEnd = motion.scalar(posX);
        expect(Number.isFinite(atEnd)).toBe(true);
        motion.seek(2000);
        expect(atEnd).toBeCloseTo(motion.scalar(posX), 2);
    });

    test('quaternions stay unit length through slerp', () => {
        const player = new ReplayPlayer(recordCircleLap());
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        const rot = motion.indexOf('rot');
        const out = new THREE.Quaternion();
        for (let ms = 0; ms <= 9000; ms += 133) {
            motion.seek(ms);
            motion.quaternion(rot, out);
            expect(out.length()).toBeCloseTo(1, 4);
        }
    });

    test('isFinished tracks the recorded duration', () => {
        const run = recordCircleLap(3);
        const player = new ReplayPlayer(run);
        expect(player.isFinished(run.durationMs - 1)).toBe(false);
        expect(player.isFinished(run.durationMs)).toBe(true);
    });

    test('a missing track reads as null rather than throwing later', () => {
        expect(new ReplayPlayer(recordCircleLap(1)).getTrack('nope')).toBeNull();
    });
});

describe('ReplayPlayer step tracks', () => {
    test('input holds its value between transitions and never interpolates', () => {
        const state = { steer: 0, throttle: 0, brake: 0, buttons: 0 };
        const recorder = new ReplayRecorder(
            { ...DEFAULT_REPLAY_RECORDER_OPTIONS, inputHz: 60 },
            () => { /* motion unused */ },
            createInputSampler(() => state),
        );
        recorder.start();
        for (let i = 0; i < 120; i++) {
            if (i === 60) state.buttons = 0b1000;
            recorder.update(1 / 60);
        }
        const player = new ReplayPlayer(recorder.stop());
        const input = player.getTrack(INPUT_TRACK);
        if (!input) throw new Error('no input track');
        const buttons = input.indexOf('buttons');

        // Just before the change the bitfield must still read 0 — an
        // interpolated 0.5 here would be meaningless.
        input.seek(950);
        expect(input.exact(buttons)).toBe(0);
        input.seek(1010);
        expect(input.exact(buttons)).toBe(0b1000);
        input.seek(1900);
        expect(input.exact(buttons)).toBe(0b1000);
    });
});

describe('GhostVehicle', () => {
    test('builds chassis, body parts, and wheels with no colliders', () => {
        const ghost = new GhostVehicle(
            new ReplayPlayer(recordCircleLap(2)),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        const meshes: THREE.Mesh[] = [];
        ghost.getObject3D().traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh) meshes.push(mesh);
        });
        // 1 chassis + 1 body part + 4 wheels.
        expect(meshes).toHaveLength(6);
        // Ghosts are visual only; nothing here should cast into the scene.
        expect(meshes.every((m) => !m.castShadow)).toBe(true);
        ghost.dispose();
    });

    test('every material is translucent and depth-write disabled', () => {
        const ghost = new GhostVehicle(
            new ReplayPlayer(recordCircleLap(2)),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        ghost.getObject3D().traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const material = mesh.material as THREE.Material;
            expect(material.transparent).toBe(true);
            expect(material.opacity).toBeCloseTo(DEFAULT_GHOST_MATERIAL_OPTIONS.opacity, 6);
            expect(material.depthWrite).toBe(false);
            expect(mesh.renderOrder).toBe(DEFAULT_GHOST_MATERIAL_OPTIONS.renderOrder);
        });
        ghost.dispose();
    });

    test('the ghost body follows the recorded path', () => {
        const ghost = new GhostVehicle(
            new ReplayPlayer(recordCircleLap()),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        for (let ms = 0; ms <= 9000; ms += 100) {
            ghost.updateAt(ms, 0.1);
            const truth = circlePosition(ms / 1000);
            expect(ghost.getObject3D().position.distanceTo(truth)).toBeLessThan(0.02);
        }
        ghost.dispose();
    });

    test('wheels sit on the car in WORLD space, not double-transformed', () => {
        // Wheels are children of the vehicle group, so three applies the root
        // transform. An earlier version also copied the world position onto the
        // child, composing the transform twice and flinging the wheels ~50 m
        // away once the car left the origin. Comparing LOCAL coordinates hid
        // it — this compares what actually renders.
        const ghost = new GhostVehicle(
            new ReplayPlayer(recordCircleLap()),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        const scene = new THREE.Scene();
        scene.add(ghost.getObject3D());
        ghost.updateAt(5000, 1 / 60);

        const body = ghost.getObject3D();
        body.updateMatrixWorld(true);
        const bodyWorld = body.getWorldPosition(new THREE.Vector3());
        const wheels: THREE.Mesh[] = [];
        body.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.geometry.type === 'CylinderGeometry') wheels.push(mesh);
        });

        expect(wheels).toHaveLength(4);
        expect(bodyWorld.length()).toBeGreaterThan(10); // genuinely away from the origin
        for (const wheel of wheels) {
            const wheelWorld = wheel.getWorldPosition(new THREE.Vector3());
            // Each corner sits within the car's own footprint.
            expect(wheelWorld.distanceTo(bodyWorld)).toBeLessThan(3);
        }
        ghost.dispose();
    });

    test('a reversing ghost spins its wheels backwards', () => {
        // Speed is signed precisely so this works.
        const state = { t: 0 };
        const recorder = new ReplayRecorder(
            { ...DEFAULT_REPLAY_RECORDER_OPTIONS, inputChannels: null },
            createVehicleMotionSampler({
                getPosition: () => new THREE.Vector3(0, 0, -state.t),
                getChassisObject: () => new THREE.Object3D(),
                getForwardSpeed: () => -8,
                getSteeringAngle: () => 0,
                getWheelCount: () => 4,
                getWheelRotation: () => -state.t * (8 / 0.35),
            }),
            null,
        );
        recorder.start();
        for (let i = 0; i < 120; i++) {
            state.t += 1 / 60;
            recorder.update(1 / 60);
        }
        const ghost = new GhostVehicle(
            new ReplayPlayer(recorder.stop()),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        const wheel = (): THREE.Mesh => {
            let found: THREE.Mesh | null = null;
            ghost.getObject3D().traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!found && mesh.isMesh && mesh.geometry.type === 'CylinderGeometry') found = mesh;
            });
            if (!found) throw new Error('no wheel');
            return found;
        };

        ghost.updateAt(500, 0.5);
        const first = wheel().quaternion.clone();
        ghost.updateAt(1000, 0.5);
        expect(wheel().quaternion.angleTo(first)).toBeGreaterThan(0.01);
        ghost.dispose();
    });

    test('wheel spin is decoupled from ground speed — a burnout stays a burnout', () => {
        // The case that rules out deriving spin from speed: a car barely
        // moving while its wheels spin flat out. Ground speed would imply
        // ~2 rad/s; the solver says 180.
        const state = { t: 0 };
        const recorder = new ReplayRecorder(
            { ...DEFAULT_REPLAY_RECORDER_OPTIONS, inputChannels: null },
            createVehicleMotionSampler({
                getPosition: () => new THREE.Vector3(0, 0, state.t * 0.7),
                getChassisObject: () => new THREE.Object3D(),
                getForwardSpeed: () => 0.7,
                getSteeringAngle: () => 0,
                getWheelCount: () => 4,
                getWheelRotation: () => state.t * 180,
            }),
            null,
        );
        recorder.start();
        for (let i = 0; i < 120; i++) {
            state.t += 1 / 60;
            recorder.update(1 / 60);
        }

        const player = new ReplayPlayer(recorder.stop());
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        motion.seek(1000);
        const recorded = motion.scalar(motion.indexOf('wheelW0'));
        const impliedByGroundSpeed = 0.7 / 0.35;

        expect(recorded).toBeGreaterThan(150);
        expect(recorded).toBeGreaterThan(impliedByGroundSpeed * 50);
    });

    test('a wheel locked under braking stops while the car keeps moving', () => {
        const state = { t: 0 };
        const recorder = new ReplayRecorder(
            { ...DEFAULT_REPLAY_RECORDER_OPTIONS, inputChannels: null },
            createVehicleMotionSampler({
                getPosition: () => new THREE.Vector3(0, 0, state.t * 25),
                getChassisObject: () => new THREE.Object3D(),
                getForwardSpeed: () => 25,
                getSteeringAngle: () => 0,
                getWheelCount: () => 4,
                // Locked: the angle never advances even though the car does.
                getWheelRotation: () => 0,
            }),
            null,
        );
        recorder.start();
        for (let i = 0; i < 120; i++) {
            state.t += 1 / 60;
            recorder.update(1 / 60);
        }

        const player = new ReplayPlayer(recorder.stop());
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) throw new Error('no motion track');
        motion.seek(1000);
        // Deriving from speed would give ~71 rad/s here.
        expect(Math.abs(motion.scalar(motion.indexOf('wheelW0')))).toBeLessThan(1);
    });

    test('dispose detaches from the scene and is idempotent', () => {
        const scene = new THREE.Scene();
        const ghost = new GhostVehicle(
            new ReplayPlayer(recordCircleLap(1)),
            descriptor(),
            DEFAULT_GHOST_VEHICLE_OPTIONS,
        );
        scene.add(ghost.getObject3D());
        expect(scene.children).toHaveLength(1);

        ghost.dispose();
        expect(scene.children).toHaveLength(0);
        expect(() => ghost.dispose()).not.toThrow();
        // Updating a disposed ghost must be inert, not a crash mid-race.
        expect(() => ghost.updateAt(500, 0.016)).not.toThrow();
    });

    test('a run with no motion track is rejected at construction', () => {
        const empty: RunRecord = { formatVersion: 1, durationMs: 0, tracks: [] };
        expect(() => new GhostVehicle(new ReplayPlayer(empty), descriptor(), DEFAULT_GHOST_VEHICLE_OPTIONS))
            .toThrow(/motion/);
    });
});

describe('applyGhostMaterial', () => {
    test('clones materials so the source object is untouched', () => {
        // The live car and its ghost routinely share a cached material. Mutating
        // in place would turn the player's own vehicle translucent.
        const shared = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        const original = new THREE.Mesh(new THREE.BoxGeometry(), shared);
        const ghost = new THREE.Mesh(new THREE.BoxGeometry(), shared);

        applyGhostMaterial(ghost, DEFAULT_GHOST_MATERIAL_OPTIONS);

        expect((ghost.material as THREE.Material).transparent).toBe(true);
        expect(shared.transparent).toBe(false);
        expect((original.material as THREE.Material).transparent).toBe(false);
    });

    test('handles multi-material meshes', () => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [
            new THREE.MeshStandardMaterial({ color: 0x111111 }),
            new THREE.MeshStandardMaterial({ color: 0x222222 }),
        ]);
        applyGhostMaterial(mesh, DEFAULT_GHOST_MATERIAL_OPTIONS);
        for (const material of mesh.material as THREE.Material[]) {
            expect(material.transparent).toBe(true);
            expect(material.depthWrite).toBe(false);
        }
    });

    test('a tint shifts colour without replacing it outright', () => {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(),
            new THREE.MeshStandardMaterial({ color: 0xff0000 }),
        );
        applyGhostMaterial(mesh, { ...DEFAULT_GHOST_MATERIAL_OPTIONS, tint: 0x0000ff, tintStrength: 0.5 });
        const color = (mesh.material as THREE.MeshStandardMaterial).color;
        expect(color.b).toBeGreaterThan(0);
        expect(color.r).toBeGreaterThan(0);
    });
});
