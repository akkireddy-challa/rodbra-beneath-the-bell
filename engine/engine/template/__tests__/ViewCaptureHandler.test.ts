import * as THREE from 'three';
import { buildFramingCamera, geometryCoverage, parseCaptureViewRequest } from 'engine/template/ViewCaptureHandler.js';

describe('parseCaptureViewRequest', () => {
    it('accepts an entity by id and defaults to one angle', () => {
        expect(parseCaptureViewRequest({ requestId: 'r1', target: { kind: 'entity', id: 'knight_1' } })).toEqual({
            requestId: 'r1',
            target: { kind: 'entity', id: 'knight_1', position: undefined, radius: undefined },
            angles: 1,
            upload: true,
            pins: [],
        });
    });

    it('keeps a position fallback and four angles', () => {
        const parsed = parseCaptureViewRequest({
            requestId: 'r2',
            target: { kind: 'entity', position: { x: 1, y: 0, z: -2 }, radius: 3 },
            angles: 4,
        });
        expect(parsed).toEqual({
            requestId: 'r2',
            target: { kind: 'entity', id: undefined, position: { x: 1, y: 0, z: -2 }, radius: 3 },
            angles: 4,
            upload: true,
            pins: [],
        });
    });

    it('rejects an entity with neither id nor position', () => {
        expect(parseCaptureViewRequest({ requestId: 'r3', target: { kind: 'entity' } })).toBe('entity target needs an id or a position');
    });

    it('rejects a missing requestId and unknown kinds', () => {
        expect(parseCaptureViewRequest({ target: { kind: 'player' } })).toBe('missing requestId');
        expect(parseCaptureViewRequest({ requestId: 'r4', target: { kind: 'sky' } })).toBe('unknown target kind "sky"');
    });

    it('normalises the level preset', () => {
        expect(parseCaptureViewRequest({ requestId: 'r5', target: { kind: 'level', preset: 'whatever' } })).toEqual({
            requestId: 'r5',
            target: { kind: 'level', preset: 'isometric' },
            angles: 1,
            upload: true,
            pins: [],
        });
    });

    it('accepts a stored camera pose and clamps its size', () => {
        expect(parseCaptureViewRequest({
            requestId: 'r7',
            target: { kind: 'camera', position: { x: 0, y: 5, z: 10 }, forward: { x: 0, y: 0, z: -1 }, fov: 60, width: 4000, height: 432 },
            upload: false,
        })).toEqual({
            requestId: 'r7',
            target: { kind: 'camera', position: { x: 0, y: 5, z: 10 }, forward: { x: 0, y: 0, z: -1 }, fov: 60, width: 1024, height: 432 },
            angles: 1,
            upload: false,
            pins: [],
        });
        expect(parseCaptureViewRequest({ requestId: 'r8', target: { kind: 'camera', position: { x: 0, y: 0, z: 0 } } }))
            .toBe('camera target needs position and forward');
    });

    it('keeps valid pins and the inline flag for the current view', () => {
        const parsed = parseCaptureViewRequest({
            requestId: 'r6',
            target: { kind: 'current-view' },
            upload: false,
            pins: [
                { id: 'inst_1', label: 'Knight', position: { x: 1, y: 0, z: 2 } },
                { id: 'broken', position: { x: 'a' } },
                { label: 'no id', position: { x: 0, y: 0, z: 0 } },
            ],
        });
        expect(parsed).toEqual({
            requestId: 'r6',
            target: { kind: 'current-view' },
            angles: 1,
            upload: false,
            pins: [{ id: 'inst_1', label: 'Knight', position: { x: 1, y: 0, z: 2 } }],
        });
    });
});

describe('buildFramingCamera', () => {
    const box = new THREE.Box3(new THREE.Vector3(9, 0, -1), new THREE.Vector3(11, 2, 1));
    const center = new THREE.Vector3(10, 1, 0);
    const forward = new THREE.Vector3(0, 0, 1);

    it('looks at the box centre from in front of the target', () => {
        const cam = buildFramingCamera(box, forward, { yaw: 0, pitch: 0 }, 4 / 3);
        expect(cam.position.x).toBeCloseTo(10);
        expect(cam.position.y).toBeCloseTo(1);
        expect(cam.position.z).toBeGreaterThan(1);
        const dir = cam.getWorldDirection(new THREE.Vector3());
        const toCenter = center.clone().sub(cam.position).normalize();
        expect(dir.dot(toCenter)).toBeCloseTo(1);
    });

    it('fits the whole bounding sphere inside the vertical field of view', () => {
        const cam = buildFramingCamera(box, forward, { yaw: 0, pitch: 0 }, 4 / 3);
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
        const distance = cam.position.distanceTo(center);
        const halfFov = THREE.MathUtils.degToRad(cam.fov) / 2;
        expect(Math.asin(radius / distance)).toBeLessThanOrEqual(halfFov);
    });

    it('turns to the back view with yaw = PI', () => {
        const cam = buildFramingCamera(box, forward, { yaw: Math.PI, pitch: 0 }, 4 / 3);
        expect(cam.position.z).toBeLessThan(-1);
    });

    it('pushes the near plane up to just in front of the target, clipping occluders', () => {
        const cam = buildFramingCamera(box, forward, { yaw: 0, pitch: 0 }, 4 / 3);
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
        const distance = cam.position.distanceTo(center);
        expect(cam.near).toBeGreaterThan(0.05);
        expect(cam.near).toBeLessThan(distance - radius);
    });
});

describe('geometryCoverage', () => {
    function cameraLookingDownZ(): THREE.PerspectiveCamera {
        const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 10000);
        cam.position.set(0, 0, 0);
        cam.lookAt(0, 0, -1);
        cam.updateMatrixWorld(true);
        return cam;
    }

    function wallAt(z: number): THREE.Group {
        const world = new THREE.Group();
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        wall.position.set(0, 0, z);
        world.add(wall);
        world.updateMatrixWorld(true);
        return world;
    }

    it('is 1 when the whole view is geometry', () => {
        expect(geometryCoverage(cameraLookingDownZ(), wallAt(-20), 500)).toBe(1);
    });

    it('is 0 when the pose looks away from the world', () => {
        // The world moved behind the old pose — a forged level centred elsewhere.
        expect(geometryCoverage(cameraLookingDownZ(), wallAt(20), 500)).toBe(0);
    });

    it('ignores geometry beyond the fog', () => {
        expect(geometryCoverage(cameraLookingDownZ(), wallAt(-800), 500)).toBe(0);
    });
});
