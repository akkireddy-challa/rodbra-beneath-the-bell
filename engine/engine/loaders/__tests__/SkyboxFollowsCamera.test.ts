import * as THREE from 'three';
import { attachSkyboxCameraFollow } from 'engine/loaders/SkyboxFollow.js';

// World-forger worlds are not centred at (0,0,0). The skybox sphere must follow
// the camera every frame so the camera always sits at its centre — otherwise the
// equirect direction skews and, past the sphere radius, the camera exits the
// sphere and the sky breaks. attachSkyboxCameraFollow wires that up.
describe('skybox follows the camera', () => {
    it('recentres the sphere on the camera world position before render', () => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 8, 6));
        attachSkyboxCameraFollow(mesh);

        // Camera far from origin, like a player on the far side of a forged world.
        const camera = new THREE.PerspectiveCamera();
        camera.position.set(1234, 56, -7890);
        camera.updateMatrixWorld(true);

        expect(mesh.onBeforeRender).toBeInstanceOf(Function);
        // Three calls onBeforeRender(renderer, scene, camera, geometry, material, group).
        mesh.onBeforeRender(
            null as unknown as THREE.WebGLRenderer,
            null as unknown as THREE.Scene,
            camera,
            mesh.geometry,
            mesh.material as THREE.Material,
            null as unknown as THREE.Group,
        );

        expect(mesh.position.x).toBeCloseTo(1234);
        expect(mesh.position.y).toBeCloseTo(56);
        expect(mesh.position.z).toBeCloseTo(-7890);

        // matrixWorld must be refreshed too — the renderer derives modelViewMatrix
        // (and the TSL positionWorld) from it, not from .position.
        const t = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
        expect(t.x).toBeCloseTo(1234);
        expect(t.y).toBeCloseTo(56);
        expect(t.z).toBeCloseTo(-7890);
    });

    it('follows a camera nested under a parent transform (world, not local, position)', () => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 8, 6));
        attachSkyboxCameraFollow(mesh);

        const rig = new THREE.Group();
        rig.position.set(1000, 0, 0);
        const camera = new THREE.PerspectiveCamera();
        camera.position.set(5, 0, 0); // local offset within the rig
        rig.add(camera);
        rig.updateMatrixWorld(true);

        mesh.onBeforeRender(
            null as unknown as THREE.WebGLRenderer,
            null as unknown as THREE.Scene,
            camera,
            mesh.geometry,
            mesh.material as THREE.Material,
            null as unknown as THREE.Group,
        );

        expect(mesh.position.x).toBeCloseTo(1005);
    });

    it('keeps the skybox out of frustum culling', () => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 8, 6));
        attachSkyboxCameraFollow(mesh);
        expect(mesh.frustumCulled).toBe(false);
    });
});
