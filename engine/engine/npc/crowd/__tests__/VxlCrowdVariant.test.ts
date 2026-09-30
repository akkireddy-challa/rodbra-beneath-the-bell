/**
 * The crowd path for `.vxl` bodies stands or falls on two silent contracts:
 * the geometry must be the articulated body moved into joint-local space
 * (so `boneMatrix * vertex` gives back the model), and the bone table must
 * be laid out exactly as CrowdAnimationBake lays its own, because the shader
 * indexes both the same way. A mistake in either renders a scrambled body,
 * not an error. These tests pin both on a synthetic two-joint column, which
 * is small enough that every expected value is derivable by hand.
 */
import * as THREE from 'three';
import { decodeVxlV3, encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import type { VxlV3Fillers } from 'engine/VxlV3Rig.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { buildVxlCharacterColumns, createVxlBindSkeleton } from 'engine/VxlCharacterMesh.js';
import { resolveFrameRow } from 'engine/npc/crowd/CrowdAnimationBake.js';
import { CROWD_BONE_INDEX_ATTRIBUTE } from 'engine/npc/crowd/CrowdSkinnedMaterial.js';
import { CrowdRenderer, type CrowdRenderMember } from 'engine/npc/crowd/CrowdRenderer.js';
import { buildVxlCrowdGeometry, bakeVxlCrowdTable } from 'engine/npc/crowd/VxlCrowdVariant.js';

const SIZE = 0.1;

/** Twelve voxels stacked on Y, lower half on joint 0 and upper half on joint 1. */
function makeColumn(): VxlV3Data {
    const leaves: OctreeLeaf[] = [];
    for (let i = 0; i < 12; i++) {
        leaves.push({ x: 0, y: i * SIZE, z: 0, size: SIZE, r: 0.8, g: 0.2, b: 0.2, bone: i < 6 ? 0 : 1 });
    }
    const fillers: VxlV3Fillers = {
        count: 0,
        gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        bone: new Uint8Array(0), color: new Uint16Array(0),
    };
    return {
        minVoxelSize: SIZE,
        maxVoxelSize: SIZE,
        physicsGridStep: SIZE,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: SIZE, maxY: 12 * SIZE, maxZ: SIZE },
        useAtlas: false,
        fragments: [{ aabbMin: [0, 0, 0], aabbMax: [SIZE, 12 * SIZE, SIZE], leaves }],
        rig: {
            skeletonRef: 'mixamo-22-v1',
            // Distinct bind translations per joint, so a wrong inverse shows up.
            bindPositions: new Float32Array(22 * 3).map((_, i) => i * 0.01),
            fillers,
            sockets: [],
        },
    };
}

async function decodedColumn() {
    const encoded = await encodeVxlV3(makeColumn());
    return decodeVxlV3(encoded.buffer as ArrayBuffer);
}

function modelBox(decoded: Awaited<ReturnType<typeof decodedColumn>>): THREE.Box3 {
    const columns = buildVxlCharacterColumns(decoded, { includeFillers: false });
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < columns.joint.length; i++) box.expandByPoint(v.fromArray(columns.position, i * 3));
    return box;
}

describe('buildVxlCrowdGeometry', () => {
    test('bone matrix times bind-local vertex reproduces the model-space body', async () => {
        const decoded = await decodedColumn();
        const model = buildVxlCharacterColumns(decoded, { includeFillers: false });
        const { geometry, boneCount, lod } = buildVxlCrowdGeometry({ decoded, bindBox: modelBox(decoded) });
        expect(lod).toBe(0); // the fixture carries no coarser level
        expect(boneCount).toBe(22);

        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const pos = geometry.getAttribute('position');
        const bone = geometry.getAttribute(CROWD_BONE_INDEX_ATTRIBUTE);
        expect(pos.count).toBe(model.joint.length);
        const local = new THREE.Vector3();
        const expected = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
            const joint = bone.getX(i);
            expect(joint).toBe(model.joint[i]);
            local.fromBufferAttribute(pos, i).applyMatrix4(skeleton.bones[joint]!.matrixWorld);
            expected.fromArray(model.position, i * 3);
            expect(local.distanceTo(expected)).toBeLessThan(1e-5);
        }
    });

    test('vertex colours and indices are carried over; the bounding sphere covers the posed body', async () => {
        const decoded = await decodedColumn();
        const model = buildVxlCharacterColumns(decoded, { includeFillers: false });
        const box = modelBox(decoded);
        const { geometry } = buildVxlCrowdGeometry({ decoded, bindBox: box });
        expect(Array.from(geometry.getAttribute('color').array)).toEqual(Array.from(model.color));
        expect(geometry.index!.count).toBe(model.index.length);
        const sphere = geometry.boundingSphere!;
        for (const corner of [box.min, box.max]) {
            expect(sphere.containsPoint(corner)).toBe(true);
        }
        // Bind-local vertices alone would give a sphere far smaller than the body.
        expect(sphere.radius).toBeGreaterThan(box.getSize(new THREE.Vector3()).length() / 2);
    });
});

describe('bakeVxlCrowdTable', () => {
    test('lays frames out clip-major then bone, column-major per matrix, at the shared fps', async () => {
        const decoded = await decodedColumn();
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const clips = [
            { motionId: 'idle', duration: 0.5, loop: true },
            { motionId: 'jump', duration: 0.1, loop: false },
        ];
        // Frame f of clip c raises the root by c + f/10 so every cell is distinguishable.
        const table = bakeVxlCrowdTable(skeleton, clips, (c, t) => { skeleton.root.position.y = c + t; }, 10);
        expect(table.boneCount).toBe(22);
        expect(table.frameCount).toBe(5 + 1);
        expect(table.clips.map(r => [r.frameOffset, r.frameCount, r.loop])).toEqual([[0, 5, true], [5, 1, false]]);
        expect(table.data.length).toBe(6 * 22 * 16);

        // Row for (clip 1, frame 0), bone 3: the bone's bind world matrix with the root lifted by 1.
        const bone = 3;
        const base = (5 + 0) * 22 * 16 + bone * 16;
        const stored = new THREE.Matrix4().fromArray(table.data, base);
        skeleton.root.position.y = 1;
        skeleton.root.updateMatrixWorld(true);
        const expected = skeleton.bones[bone]!.matrixWorld;
        for (let i = 0; i < 16; i++) expect(stored.elements[i]).toBeCloseTo(expected.elements[i], 6);
    });

    test('resolveFrameRow wraps looping clips and clamps one-shots', async () => {
        const decoded = await decodedColumn();
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const table = bakeVxlCrowdTable(skeleton, [
            { motionId: 'walk', duration: 1, loop: true },
            { motionId: 'jump', duration: 1, loop: false },
        ], () => { /* bind pose */ }, 10);
        expect(resolveFrameRow(table, 0, 1.25)).toBe(2);      // wrapped into the loop
        expect(resolveFrameRow(table, 1, 5)).toBe(10 + 9);    // clamped to the last frame
    });
});

describe('CrowdRenderer per-instance scale', () => {
    class Member implements CrowdRenderMember {
        constructor(private scale: number) { }
        getCrowdX(): number { return 1; }
        getCrowdY(): number { return 2; }
        getCrowdZ(): number { return 3; }
        getCrowdYaw(): number { return 0; }
        getCrowdFrameRow(): number { return 0; }
        getCrowdColor(): THREE.Color { return new THREE.Color(1, 1, 1); }
        getCrowdScale(): number { return this.scale; }
    }

    test('a shrunken character stays shrunken in the batch', () => {
        const renderer = new CrowdRenderer();
        const parent = new THREE.Object3D();
        renderer.registerVariant('v', new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), parent);
        renderer.acquire('v', new Member(0.4));
        renderer.update();
        const mesh = parent.children[0] as THREE.InstancedMesh;
        const m = new THREE.Matrix4();
        mesh.getMatrixAt(0, m);
        const scale = new THREE.Vector3();
        m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
        expect(scale.y).toBeCloseTo(0.4, 6);
        // The WebGPU shader places instances from these two attributes, not the
        // matrix (see CrowdSkinnedMaterial); they must say the same thing.
        const xfm = mesh.geometry.getAttribute('instanceCrowdXfm');
        const yaw = mesh.geometry.getAttribute('instanceCrowdYaw');
        expect([xfm.getX(0), xfm.getY(0), xfm.getZ(0)]).toEqual([1, 2, 3]);
        expect(xfm.getW(0)).toBeCloseTo(0.4, 6);   // float32 storage
        expect(yaw.getX(0)).toBe(0);
    });
});
