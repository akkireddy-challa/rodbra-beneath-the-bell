import * as THREE from 'three';

/**
 * Make a skybox mesh follow the camera so the camera is always at the sphere's
 * centre. The skybox is a finite sphere; its equirect sampler maps each vertex's
 * direction-from-camera to the texture, which is only correct while the camera
 * sits at the centre. World-forger worlds are not centred at (0,0,0), so a
 * sphere anchored at the origin skews the sky as the player moves away — and
 * once the player passes the sphere radius the camera exits the sphere entirely
 * and the sky breaks. Re-centring on the camera each frame keeps it infinite.
 *
 * Lives in its own module (importing only `three`) so it stays unit-testable —
 * SkyboxMaterialHelper pulls in `three/webgpu`, which the test runner can't load.
 */
export function attachSkyboxCameraFollow(mesh: THREE.Mesh): void {
    // A camera-centred sphere is always around the viewer; never cull it.
    mesh.frustumCulled = false;

    mesh.onBeforeRender = (_renderer, _scene, camera): void => {
        // World position, so a camera nested under a rig/parent is handled too.
        camera.getWorldPosition(mesh.position);
        // The renderer derives modelViewMatrix (and TSL positionWorld) from
        // matrixWorld, which was already computed for this frame with the old
        // position — refresh it so the new position takes effect this draw.
        mesh.updateMatrixWorld(true);
    };
}
