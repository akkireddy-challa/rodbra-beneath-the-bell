import * as THREE from 'three';
import { isArmBoneName, measureSkinnedBodyWidthRatio } from 'engine/loaders/SkinnedCharacterMeasure.js';

/**
 * A T-posed character: a torso 0.4 wide on the spine bone, plus two arms
 * reaching out to ±1.0 on their own bones. Full width 2.0, body width 0.4.
 */
function makeTPosedCharacter(opts: { armBoneNames?: [string, string]; weightArmsToSpine?: boolean } = {}) {
    const [leftName, rightName] = opts.armBoneNames ?? ['mixamorigLeftArm', 'mixamorigRightArm'];
    const spine = new THREE.Bone(); spine.name = 'mixamorigSpine';
    const left = new THREE.Bone(); left.name = leftName;
    const right = new THREE.Bone(); right.name = rightName;
    spine.add(left, right);

    // 2 torso verts at x=±0.2, 1 vert per arm at x=±1.0. z is constant (thin body).
    const positions = [-0.2, 0, 0, 0.2, 0, 0, -1.0, 0.5, 0, 1.0, 0.5, 0];
    const boneOf = opts.weightArmsToSpine ? [0, 0, 0, 0] : [0, 0, 1, 2];
    const skinIndex: number[] = []; const skinWeight: number[] = [];
    for (const b of boneOf) { skinIndex.push(b, 0, 0, 0); skinWeight.push(1, 0, 0, 0); }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const root = new THREE.Group();
    root.add(spine, mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton([spine, left, right]), new THREE.Matrix4());
    return root;
}

describe('isArmBoneName', () => {
    it('matches the arm chain across the rig namings the engine meets', () => {
        for (const n of ['mixamorigLeftArm', 'mixamorigRightForeArm', 'mixamorigLeftHand',
            'mixamorigRightHandThumb2', 'clavicle_l', 'upperarm_r', 'lowerarm_l', 'hand_r']) {
            expect(isArmBoneName(n)).toBe(true);
        }
    });

    it('leaves the body, head and legs alone', () => {
        for (const n of ['mixamorigHips', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead',
            'mixamorigLeftUpLeg', 'mixamorigRightLeg', 'mixamorigLeftFoot', 'thigh_r', 'calf_l', 'foot_l']) {
            expect(isArmBoneName(n)).toBe(false);
        }
    });
});

describe('measureSkinnedBodyWidthRatio', () => {
    it('discounts the T-posed arms out of the width', () => {
        // body 0.4 wide inside a 2.0-wide box.
        expect(measureSkinnedBodyWidthRatio(makeTPosedCharacter())).toBeCloseTo(0.2, 6);
    });

    it('returns 1 when the arms set no part of the width', () => {
        // Every vertex is weighted to the spine, so nothing is excluded.
        expect(measureSkinnedBodyWidthRatio(makeTPosedCharacter({ weightArmsToSpine: true }))).toBe(1);
    });

    it('turns a ball capsule back into a capsule', () => {
        // The real regression, in the numbers the loader uses: a 1.5 m character
        // measured 1.63 m wide in its T-pose, which clamps to a 0.8 m radius —
        // a sphere, since that exceeds half the 1.575 m capsule height.
        const ratio = measureSkinnedBodyWidthRatio(makeTPosedCharacter())!;
        const clamp = (r: number) => Math.max(0.2, Math.min(r, 0.8));
        const capsuleHeight = 1.5 * 1.05;
        expect(clamp((1.629 / 2) * 1.1)).toBeGreaterThanOrEqual(capsuleHeight / 2); // old: a ball
        expect(clamp((1.629 * ratio / 2) * 1.1)).toBeLessThan(capsuleHeight / 2);   // new: a capsule
    });

    it('is null for a rig with no skinned mesh, so the caller keeps its fallback', () => {
        const root = new THREE.Group();
        root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
        expect(measureSkinnedBodyWidthRatio(root)).toBeNull();
    });

    it('is null when the skin carries no weights to read', () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
        const bone = new THREE.Bone(); bone.name = 'mixamorigSpine';
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
        const root = new THREE.Group();
        root.add(bone, mesh);
        root.updateMatrixWorld(true);
        mesh.bind(new THREE.Skeleton([bone]), new THREE.Matrix4());
        expect(measureSkinnedBodyWidthRatio(root)).toBeNull();
    });
});
