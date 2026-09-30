import * as THREE from 'three';

/**
 * Physics-capsule measurement for a rigged GLB character.
 *
 * A character GLB is authored in a T-POSE, so its bounding box is dominated by
 * the arm span. A generated 1.5 m character measures 1.63 m wide, and a radius
 * taken from that box is 0.8 m — wider than half the character's height, which
 * is not a capsule at all but a BALL. A ball cannot stand on a voxel edge (it
 * rests on the corner and holds the body out in mid-air) and cannot step up one
 * (it rolls up the corner along a diagonal). The arms are not where a character
 * IS; they drop to its sides the moment any clip plays.
 *
 * So the radius is measured from the body only, skipping every vertex the skin
 * binds to the arm chain — the same rule `measureVxlCharacter` applies to voxel
 * bodies, whose comment documents the identical T-pose trap. Height still comes
 * from the full box: T-posed arms reach sideways, never above the head or below
 * the feet.
 *
 * The result is a RATIO rather than a width, because the caller's box and these
 * vertices are not necessarily in the same space — a Blender-exported character
 * carries a rotated, 0.01-scaled armature, and `Box3.setFromObject` does not
 * report a skinned mesh in the frame `mesh.matrixWorld` would suggest. Both
 * extents here come from one pass over the same untransformed vertices, so
 * their ratio is exact whatever space that is, and the caller applies it to the
 * box it already trusts.
 */

/**
 * Bones of the arm chain, shoulder through fingertips. Matches the joint span
 * the voxel path excludes (`mixamorigLeftShoulder` … `mixamorigRightHand`) and
 * covers the UE5 Manny names the engine also meets (`clavicle_l`, `upperarm_r`).
 * The shoulder/clavicle sits inside the torso silhouette, so dropping it costs
 * nothing — the chest vertices on the spine bones still set the width.
 */
const ARM_BONE_PATTERNS = [
    'shoulder', 'clavicle', 'arm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky',
];

/** True when the bone name reads as part of an arm, hand or finger. */
export function isArmBoneName(name: string): boolean {
    const lower = name.toLowerCase();
    return ARM_BONE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * The share of a character's horizontal bounding box that its BODY occupies,
 * with the arm chain excluded — in `(0, 1]`, where 1 means the arms set no part
 * of the width (a character already posed arms-down, or an unrigged body).
 *
 * Multiply a horizontal extent of the same character by this to get the body's
 * extent. Returns null when there is nothing to measure — no skinned mesh, no
 * skin attributes, or no vertex outside the arm chain — and the caller should
 * keep its own fallback rather than trust a degenerate number.
 *
 * When several skinned meshes are present the widest one decides: that is the
 * body, and it is the mesh whose arms inflated the box in the first place.
 */
export function measureSkinnedBodyWidthRatio(root: THREE.Object3D): number | null {
    let widestFull = 0;
    let ratio: number | null = null;
    const v = new THREE.Vector3();

    root.traverse((obj) => {
        const mesh = obj as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
        const position = mesh.geometry?.attributes?.position;
        const skinIndex = mesh.geometry?.attributes?.skinIndex;
        const skinWeight = mesh.geometry?.attributes?.skinWeight;
        if (!position || !skinIndex || !skinWeight) return;

        // Which of this skin's bones are arms, by index — resolved once per mesh.
        const armBone = mesh.skeleton.bones.map((b) => isArmBoneName(b.name));

        let fullMinX = Infinity, fullMaxX = -Infinity, fullMinZ = Infinity, fullMaxZ = -Infinity;
        let bodyMinX = Infinity, bodyMaxX = -Infinity, bodyMinZ = Infinity, bodyMaxZ = -Infinity;
        let bodyCount = 0;

        for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i);
            if (v.x < fullMinX) fullMinX = v.x;
            if (v.x > fullMaxX) fullMaxX = v.x;
            if (v.z < fullMinZ) fullMinZ = v.z;
            if (v.z > fullMaxZ) fullMaxZ = v.z;

            // The bone carrying the most weight owns the vertex — the same call
            // the renderer makes about where that vertex lives.
            let bestWeight = -1;
            let bestBone = -1;
            for (let k = 0; k < 4; k++) {
                const w = skinWeight.getComponent(i, k);
                if (w > bestWeight) {
                    bestWeight = w;
                    bestBone = skinIndex.getComponent(i, k);
                }
            }
            if (bestBone >= 0 && armBone[bestBone]) continue;

            if (v.x < bodyMinX) bodyMinX = v.x;
            if (v.x > bodyMaxX) bodyMaxX = v.x;
            if (v.z < bodyMinZ) bodyMinZ = v.z;
            if (v.z > bodyMaxZ) bodyMaxZ = v.z;
            bodyCount++;
        }

        const full = Math.max(fullMaxX - fullMinX, fullMaxZ - fullMinZ);
        if (bodyCount === 0 || !(full > 0) || full <= widestFull) return;
        const body = Math.max(bodyMaxX - bodyMinX, bodyMaxZ - bodyMinZ);
        if (!Number.isFinite(body) || body <= 0) return;
        widestFull = full;
        ratio = Math.min(1, body / full);
    });

    return ratio;
}
