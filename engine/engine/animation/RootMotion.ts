import * as THREE from 'three';

/**
 * Root-motion travel extraction for one-shot Mixamo overlays that should
 * COMMIT their forward step to the player's real position (e.g. a soccer kick
 * that steps into the ball) instead of snapping back when the clip ends.
 *
 * The clip's translation lives on the hips bone, expressed in the skeleton's
 * own local frame. The skeleton root is re-positioned to the player every frame
 * and rotated to the player's facing, so a naive hips world-delta would also
 * fold in the player's position/facing. These helpers divide the root transform
 * out, yielding ONLY the clip-authored travel, rotated into world axes by the
 * player's current facing — exactly the displacement to feed back to movement.
 */

/**
 * Capture the hips' rest position in the skeleton-root local frame (the root's
 * translation, rotation and scale removed). Pass the hips world position at the
 * clip's first frame; the returned vector is the baseline that
 * {@link rootMotionWorldTravelXZ} measures travel against. Mutates nothing.
 */
export function captureRootMotionBaseline(
    skeletonRoot: THREE.Object3D,
    hipsWorld: THREE.Vector3,
): THREE.Vector3 {
    return skeletonRoot.worldToLocal(hipsWorld.clone());
}

/**
 * World-space XZ travel of the hips away from `baselineLocal`, with the skeleton
 * root's own transform (player position + facing + scale) divided out so the
 * result is purely the clip's authored root motion expressed in world axes.
 *
 * Both the baseline and the current hips position are mapped through the SAME
 * current root world matrix, so the root translation cancels in the difference
 * and only the root's rotation+scale remain — turning a clip-local forward step
 * into a world step in the direction the player currently faces. Y is zeroed
 * (root motion drives horizontal movement only; gravity owns the vertical).
 *
 * @param out Reused output vector; also returned.
 */
export function rootMotionWorldTravelXZ(
    skeletonRoot: THREE.Object3D,
    hipsWorld: THREE.Vector3,
    baselineLocal: THREE.Vector3,
    out: THREE.Vector3,
): THREE.Vector3 {
    // baseWorld = where the rest pose sits under the CURRENT root matrix.
    out.copy(baselineLocal).applyMatrix4(skeletonRoot.matrixWorld);
    out.set(hipsWorld.x - out.x, 0, hipsWorld.z - out.z);
    return out;
}
