/**
 * Geometry and skeleton for a rigged VXL3 v10 character.
 *
 * The invariants defended here are the ones the format's own design notes call
 * out as expensive to establish and silent when broken:
 *
 * - the bind pose must be copied VERBATIM, because the engine applies clip world
 *   rotations with no bind compensation — "helpfully" normalising a quaternion
 *   here produces a leaning body and nothing that looks like a bug;
 * - a face may be culled only against the SAME joint, or limbs open holes when
 *   they bend;
 * - joint fillers must survive, or joints re-open at full extension;
 * - and the two assemblers must agree, which is what lets the skinned form ship
 *   while the demo's per-joint form stays the reference.
 *
 * Culling and filler LOGIC is tested on a synthetic two-bone column, so the
 * behaviour is pinned without depending on any particular corpus body. The real
 * fixtures are used only for invariants that are cheap to assert across all of
 * them and that no synthetic body would exercise honestly — the bind fidelity of
 * real per-body proportions, and the arms-excluded capsule measurement.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { decodeVxlV3, encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import { SKELETON_REFS, type VxlV3Fillers } from 'engine/VxlV3Rig.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import {
    assembleVxlJointMeshes,
    assembleVxlSkinnedMesh,
    buildVxlCharacterColumns,
    createVxlBindSkeleton,
} from 'engine/VxlCharacterMesh.js';
import {
    clearVxlCharacterTemplateCache,
    instantiateVxlCharacter,
    isVxlCharacterUrl,
    loadVxlCharacterTemplate,
    measureVxlCharacter,
} from 'engine/loaders/VxlCharacterLoader.js';

const SIZE = 0.1;
const SAMPLES = path.join(process.cwd(), 'vxl-v10-samples');

function material(): THREE.Material {
    return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/**
 * A 12-voxel column, lower half on joint 0 and upper half on joint 1, with two
 * fillers straddling the boundary. Small enough that every expected face count
 * can be derived by hand rather than frozen from a run.
 */
function makeColumn(fillerCount = 2): VxlV3Data {
    const leaves: OctreeLeaf[] = [];
    for (let i = 0; i < 12; i++) {
        leaves.push({ x: 0, y: i * SIZE, z: 0, size: SIZE, r: 0.8, g: 0.2, b: 0.2, bone: i < 6 ? 0 : 1 });
    }
    const fillers: VxlV3Fillers = {
        count: fillerCount,
        gx: new Uint16Array([0, 0]).subarray(0, fillerCount),
        gy: new Uint16Array([5, 6]).subarray(0, fillerCount),
        gz: new Uint16Array([0, 0]).subarray(0, fillerCount),
        bone: new Uint8Array([1, 0]).subarray(0, fillerCount),
        color: new Uint16Array([0x0f00, 0x000f]).subarray(0, fillerCount),
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
            bindPositions: new Float32Array(22 * 3).map((_, i) => i * 0.01),
            fillers,
            sockets: [{ name: 'head', joint: 5, offset: [0, 1.5, 0] }],
        },
    };
}

async function decodeColumn(fillerCount = 2) {
    const encoded = await encodeVxlV3(makeColumn(fillerCount));
    return decodeVxlV3(encoded.buffer as ArrayBuffer);
}

function sampleFiles(): string[] {
    return fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.vxl')).sort();
}

async function decodeSample(file: string) {
    const bytes = fs.readFileSync(path.join(SAMPLES, file));
    return decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** The fixture used wherever one real body is enough to pin the invariant. */
async function decodeFirstSample() {
    return decodeSample(sampleFiles()[0]!);
}

/** Quad indices grouped by the joint that owns them, in the order they were emitted. */
function quadsByJoint(columns: { quads: number; joint: Uint8Array }): Map<number, number[]> {
    const byJoint = new Map<number, number[]>();
    for (let q = 0; q < columns.quads; q++) {
        const owner = columns.joint[q * 4]!;
        const quads = byJoint.get(owner);
        if (quads) quads.push(q); else byJoint.set(owner, [q]);
    }
    return byJoint;
}

describe('same-owner face culling', () => {
    it('keeps the face between two joints and drops faces inside one', async () => {
        const decoded = await decodeColumn(0);
        const columns = buildVxlCharacterColumns(decoded, { includeFillers: false });
        expect(columns.didCull).toBe(true);
        // 12 stacked cubes = 72 faces. 11 internal boundaries, each hiding a face
        // on both sides = 22 faces that a plain occupancy test would drop. One of
        // those boundaries is between joint 0 and joint 1, and BOTH of its faces
        // must survive because the two halves separate when the joint bends.
        expect(columns.culled).toBe(20);
        expect(columns.quads).toBe(72 - 20);
    });

    it('emits every face when the neighbour belongs to a different joint', async () => {
        const decoded = await decodeColumn(0);
        const columns = buildVxlCharacterColumns(decoded, { includeFillers: false });
        // The two quads at y = 6*SIZE (the joint boundary) face each other; a
        // same-owner rule that ignored ownership would leave neither.
        const boundary = 6 * SIZE;
        let facing = 0;
        for (let q = 0; q < columns.quads; q++) {
            const y = columns.position[q * 12 + 1]!;
            if (Math.abs(y - boundary) < 1e-6) facing++;
        }
        expect(facing).toBeGreaterThanOrEqual(2);
    });
});

describe('joint fillers', () => {
    it('adds exactly six quads per filler, and omitting them removes exactly those', async () => {
        const decoded = await decodeColumn();
        const withFillers = buildVxlCharacterColumns(decoded);
        const without = buildVxlCharacterColumns(decoded, { includeFillers: false });
        expect(withFillers.quads - without.quads).toBe(decoded.rig!.fillers.count * 6);
    });

    it('insets the filler cube so it does not z-fight the voxel it sits inside', async () => {
        const decoded = await decodeColumn();
        const columns = buildVxlCharacterColumns(decoded);
        const without = buildVxlCharacterColumns(decoded, { includeFillers: false });
        // Fillers are appended after the surface quads.
        const first = without.quads;
        const xs = [0, 1, 2, 3].map((k) => columns.position[(first * 4 + k) * 3]!);
        const edge = Math.max(...xs) - Math.min(...xs);
        expect(edge).toBeCloseTo(SIZE * 0.96, 6);
    });

    it('binds each filler to the joint across the pivot, not to its host voxel', async () => {
        const decoded = await decodeColumn();
        const columns = buildVxlCharacterColumns(decoded);
        const without = buildVxlCharacterColumns(decoded, { includeFillers: false });
        const fillers = decoded.rig!.fillers;
        for (let i = 0; i < fillers.count; i++) {
            expect(columns.joint[(without.quads + i * 6) * 4]).toBe(fillers.bone[i]);
        }
    });
});

describe('bind skeleton', () => {
    it('copies the reference rotations and the file positions verbatim', async () => {
        const decoded = await decodeColumn();
        const { bones, ref } = createVxlBindSkeleton(decoded.rig!);
        const bind = decoded.rig!.bindPositions;
        expect(bones).toHaveLength(ref.joints.length);
        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i]!;
            expect(bone.name).toBe(ref.joints[i]);
            // Bit-equal, not approximately: the clips were authored against these
            // exact values and nothing compensates for a difference.
            expect(bone.quaternion.x).toBe(ref.rotations[i * 4]);
            expect(bone.quaternion.y).toBe(ref.rotations[i * 4 + 1]);
            expect(bone.quaternion.z).toBe(ref.rotations[i * 4 + 2]);
            expect(bone.quaternion.w).toBe(ref.rotations[i * 4 + 3]);
            expect(bone.position.x).toBe(bind[i * 3]);
            expect(bone.position.y).toBe(bind[i * 3 + 1]);
            expect(bone.position.z).toBe(bind[i * 3 + 2]);
        }
    });

    it('parents each joint per the reference hierarchy', async () => {
        const decoded = await decodeColumn();
        const { bones, root, ref } = createVxlBindSkeleton(decoded.rig!);
        for (let i = 0; i < bones.length; i++) {
            const parent = ref.parents[i]!;
            expect(bones[i]!.parent).toBe(parent === -1 ? root : bones[parent]);
        }
    });

    it('rejects a skeleton reference the engine does not know', async () => {
        const decoded = await decodeColumn();
        expect(() => createVxlBindSkeleton({ ...decoded.rig!, skeletonRef: 'not-a-skeleton' }))
            .toThrow(/unknown skeletonRef/);
    });
});

describe('assemblers', () => {
    it('gives every vertex exactly one influence at full weight', async () => {
        const decoded = await decodeColumn();
        const columns = buildVxlCharacterColumns(decoded);
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const mesh = assembleVxlSkinnedMesh(columns, skeleton, material());
        const weight = mesh.geometry.getAttribute('skinWeight');
        const index = mesh.geometry.getAttribute('skinIndex');
        for (let v = 0; v < weight.count; v++) {
            expect(weight.getX(v)).toBe(1);
            expect(weight.getY(v) + weight.getZ(v) + weight.getW(v)).toBe(0);
            expect(index.getX(v)).toBe(columns.joint[v]);
        }
    });

    it('builds cubes that still tile after their bone transform, not sheared plates', async () => {
        // The trap this defends: transforming only a cube's min corner into bone
        // space and adding axis-aligned offsets builds it in the BONE's frame, so
        // every cube comes out rotated by that bone's bind rotation — invisible on
        // the torso, ~120 degrees out on the arms. Transform each quad back by its
        // bone's world matrix and it must land axis-aligned again.
        const decoded = await decodeFirstSample();
        const columns = buildVxlCharacterColumns(decoded);
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const meshes = assembleVxlJointMeshes(columns, skeleton, material());
        const corner = new THREE.Vector3();
        let worstNormal = 0;
        let worstOffAxisEdge = 0;
        for (const mesh of meshes) {
            const position = mesh.geometry.getAttribute('position');
            const world = mesh.parent!.matrixWorld;
            for (let q = 0; q < position.count / 4; q++) {
                const corners: THREE.Vector3[] = [];
                for (let k = 0; k < 4; k++) {
                    corners.push(corner.fromBufferAttribute(position, q * 4 + k).applyMatrix4(world).clone());
                }
                for (let k = 0; k < 4; k++) {
                    const edge = corners[(k + 1) % 4]!.clone().sub(corners[k]!);
                    const sorted = [Math.abs(edge.x), Math.abs(edge.y), Math.abs(edge.z)].sort((a, b) => b - a);
                    worstOffAxisEdge = Math.max(worstOffAxisEdge, sorted[1]!);
                }
                const normal = corners[1]!.clone().sub(corners[0]!)
                    .cross(corners[2]!.clone().sub(corners[0]!)).normalize();
                const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
                const nearest = Math.min(...axes.flatMap(([x, y, z]) => {
                    const axis = new THREE.Vector3(x, y, z);
                    return [axis.distanceTo(normal), axis.clone().negate().distanceTo(normal)];
                }));
                worstNormal = Math.max(worstNormal, nearest);
            }
        }
        expect(worstOffAxisEdge).toBeLessThan(1e-5);
        expect(worstNormal).toBeLessThan(1e-5);
    });

    it('puts the skinned and per-joint forms in the same place at bind', async () => {
        // The equivalence that lets the skinned form ship: same columns, same
        // bind-pose geometry. If either assembler drifts, this catches it.
        const decoded = await decodeFirstSample();
        const columns = buildVxlCharacterColumns(decoded);
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const skinned = assembleVxlSkinnedMesh(columns, skeleton, material());
        const rigid = assembleVxlJointMeshes(columns, skeleton, material());
        const skinnedPos = skinned.geometry.getAttribute('position');

        const byJoint = quadsByJoint(columns);
        const point = new THREE.Vector3();
        let worst = 0;
        for (const mesh of rigid) {
            const joint = skeleton.ref.joints.indexOf(mesh.name.split(':')[1]!);
            const quads = byJoint.get(joint)!;
            const position = mesh.geometry.getAttribute('position');
            for (let n = 0; n < quads.length; n++) {
                for (let k = 0; k < 4; k++) {
                    point.fromBufferAttribute(position, n * 4 + k).applyMatrix4(mesh.parent!.matrixWorld);
                    const v = quads[n]! * 4 + k;
                    worst = Math.max(worst, point.distanceTo(new THREE.Vector3(
                        skinnedPos.getX(v), skinnedPos.getY(v), skinnedPos.getZ(v))));
                }
            }
        }
        expect(worst).toBeLessThan(1e-5);
    });
});

describe('real corpus bodies', () => {
    it('ships fixtures to test against', () => {
        expect(sampleFiles().length).toBeGreaterThan(0);
    });

    it('carries a rig with a known skeleton and a bone for every voxel', async () => {
        for (const file of sampleFiles()) {
            const decoded = await decodeSample(file);
            expect(decoded.rig).toBeDefined();
            expect(SKELETON_REFS[decoded.rig!.skeletonRef]).toBeDefined();
            const leaves = decoded.fragments[0]!.leaves;
            expect(leaves.bone).not.toBeNull();
            expect(leaves.bone!.length).toBeGreaterThanOrEqual(leaves.count);
        }
    });

    it('measures a capsule narrower than the T-pose it is stored in', async () => {
        // The point of excluding the arms: these bodies are stored in a T-pose up
        // to 2.65 m wide, and a radius taken from that bounding box pins a capsule
        // wider than the character is tall onto every one of them.
        //
        // The remaining spread is real and must NOT be clamped away — the observed
        // torso-and-legs radius runs 0.26 to 0.72 across these fixtures, because
        // some of them genuinely are wide-bodied (on b0282 the hips, torso, neck
        // and head all measure ~1.3 m across). A narrower capsule there would let
        // the visible body pass through walls.
        for (const file of sampleFiles()) {
            const decoded = await decodeSample(file);
            const measured = measureVxlCharacter(decoded);
            const leaves = decoded.fragments[0]!.leaves;
            const size = leaves.minVoxelSize;
            let minX = Infinity, maxX = -Infinity;
            for (let i = 0; i < leaves.count; i++) {
                minX = Math.min(minX, leaves.worldX(i));
                maxX = Math.max(maxX, leaves.worldX(i) + size);
            }
            expect(measured.height).toBeCloseTo(1.72, 2);
            expect(measured.radius).toBeLessThan((maxX - minX) / 2 * 1.1);
            expect(measured.radius).toBeGreaterThanOrEqual(0.2);
            expect(measured.radius).toBeLessThanOrEqual(0.8);
        }
    });
});

describe('isVxlCharacterUrl', () => {
    it.each([
        ['https://cdn/body.vxl', true],
        ['https://cdn/body.VXL', true],
        ['https://cdn/body.vxl?v=3', true],
        ['https://cdn/body.vxl#frag', true],
        ['https://cdn/body.glb', false],
        // A query string that merely mentions .vxl is not a vxl file; matching the
        // raw string would send this down the wrong loader.
        ['https://cdn/body.glb?from=old.vxl', false],
    ])('%s -> %s', (url, expected) => {
        expect(isVxlCharacterUrl(url as string)).toBe(expected);
    });
});

describe('skinning under a posed skeleton', () => {
    /**
     * `SkinnedMesh.applyBoneTransform` runs three's OWN skinning math on the CPU
     * — the same bone matrices, skinIndex and skinWeight the GPU would use. So
     * this exercises the actual binding rather than a screenshot of it, and it
     * holds for every backend instead of whichever one a test machine has.
     */
    /** Where vertex `v` lands under the skeleton's CURRENT pose. */
    function posed(mesh: THREE.SkinnedMesh, columns: { position: Float32Array }, v: number): THREE.Vector3 {
        return mesh.applyBoneTransform(v, new THREE.Vector3(
            columns.position[v * 3]!, columns.position[v * 3 + 1]!, columns.position[v * 3 + 2]!)).clone();
    }

    async function posedBody() {
        const decoded = await decodeFirstSample();
        const columns = buildVxlCharacterColumns(decoded);
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const mesh = assembleVxlSkinnedMesh(columns, skeleton, material());
        skeleton.root.add(mesh);
        skeleton.root.updateMatrixWorld(true);
        const bind: THREE.Vector3[] = [];
        for (let v = 0; v < columns.joint.length; v++) {
            bind.push(posed(mesh, columns, v));
        }
        return { decoded, columns, skeleton, mesh, bind };
    }

    it('moves the voxels of a rotated joint and leaves the rest of the body alone', async () => {
        const { columns, skeleton, mesh, bind } = await posedBody();
        const armJoint = skeleton.ref.joints.indexOf('mixamorigRightArm');
        const hipsJoint = skeleton.ref.joints.indexOf('mixamorigHips');

        skeleton.bones[armJoint]!.rotateZ(Math.PI / 3);
        skeleton.root.updateMatrixWorld(true);
        mesh.skeleton.update();

        let movedArm = 0, movedHips = 0;
        for (let v = 0; v < columns.joint.length; v++) {
            const delta = posed(mesh, columns, v).distanceTo(bind[v]!);
            if (columns.joint[v] === armJoint && delta > 1e-3) movedArm++;
            if (columns.joint[v] === hipsJoint && delta > 1e-6) movedHips++;
        }
        expect(movedArm).toBeGreaterThan(0);
        // Rigid binding: rotating one joint must not disturb a vertex owned by another.
        expect(movedHips).toBe(0);
    });

    it('keeps every cube a cube once posed, rather than shearing it', async () => {
        // This is what one-influence-at-weight-1.0 buys. Blended weights would
        // shear the cubes spanning a joint into wafer slices — the reason the
        // format binds rigidly in the first place.
        const { decoded, columns, skeleton, mesh } = await posedBody();
        for (const name of ['mixamorigRightArm', 'mixamorigLeftLeg', 'mixamorigSpine2']) {
            skeleton.bones[skeleton.ref.joints.indexOf(name)]!.rotateX(0.7);
        }
        skeleton.root.updateMatrixWorld(true);
        mesh.skeleton.update();

        const edge = decoded.fragments[0]!.leaves.minVoxelSize;
        let worst = 0;
        // Surface quads only — fillers are inset 4 % and have their own edge length.
        const surface = buildVxlCharacterColumns(decoded, { includeFillers: false }).quads;
        for (let q = 0; q < surface; q++) {
            const c = [0, 1, 2, 3].map((k) => posed(mesh, columns, q * 4 + k));
            for (let k = 0; k < 4; k++) {
                worst = Math.max(worst, Math.abs(c[(k + 1) % 4]!.distanceTo(c[k]!) - edge));
            }
        }
        expect(worst).toBeLessThan(1e-5);
    });
});

describe('NPC cloning preconditions', () => {
    /**
     * NPCs are spawned by handing the loaded model to `SkeletonUtils.clone`
     * (`NpcController`), which rebuilds each SkinnedMesh's skeleton by mapping the
     * ORIGINAL bones through a parallel traverse of the source and the clone. A
     * bone that is not a descendant of the cloned root therefore maps to
     * `undefined`, and the failure is silent in the worst way: the clone stays
     * bound to the original skeleton, so posing it never deforms the mesh and the
     * NPC stands in a permanent T-pose. That precondition is what these assert.
     *
     * SkeletonUtils itself is stubbed under jest (it is ESM-only), so the
     * structure is checked rather than the clone; the crowd check in a browser
     * covers the rest.
     */
    async function model() {
        const decoded = await decodeSample(sampleFiles()[0]!);
        const columns = buildVxlCharacterColumns(decoded);
        const skeleton = createVxlBindSkeleton(decoded.rig!);
        const mesh = assembleVxlSkinnedMesh(columns, skeleton, material());
        skeleton.root.add(mesh);
        return { skeleton, mesh };
    }

    it('keeps every skeleton bone inside the cloned root', async () => {
        const { skeleton, mesh } = await model();
        const inTree = new Set<THREE.Object3D>();
        skeleton.root.traverse((o) => inTree.add(o));
        for (const bone of mesh.skeleton.bones) {
            expect(inTree.has(bone)).toBe(true);
        }
    });

    it('exposes exactly one skinned mesh, so an NPC is one draw call', async () => {
        const { skeleton } = await model();
        let skinned = 0;
        skeleton.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++; });
        expect(skinned).toBe(1);
    });

    it('shares geometry between instances built from one template', async () => {
        // What makes a crowd affordable: the body is decoded and built once per
        // URL, and every instance points at the same BufferGeometry.
        const decoded = await decodeSample(sampleFiles()[0]!);
        const columns = buildVxlCharacterColumns(decoded);
        const shared = material();
        const a = assembleVxlSkinnedMesh(columns, createVxlBindSkeleton(decoded.rig!), shared);
        const b = assembleVxlSkinnedMesh(columns, createVxlBindSkeleton(decoded.rig!), shared);
        expect(a.geometry.getAttribute('position').array)
            .toBe(b.geometry.getAttribute('position').array);
        // ...while the bones are per-instance, or every NPC would animate in lockstep.
        expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]);
    });
});

describe('material-classed slots (v11)', () => {
    /**
     * The column with its top three voxels in a gold-classed slot, and one
     * filler sitting inside a slot-1 cell but owned by joint 0 — pinning that
     * a filler inherits its CELL's slot, not anything bone-derived.
     */
    function makeClassedColumn(): VxlV3Data {
        const data = makeColumn(0);
        for (const l of data.fragments[0]!.leaves as OctreeLeaf[]) {
            if (l.y >= 9 * SIZE - 1e-9) l.slot = 1;
        }
        data.rig!.fillers = {
            count: 1,
            gx: new Uint16Array([0]),
            gy: new Uint16Array([10]),
            gz: new Uint16Array([0]),
            bone: new Uint8Array([0]),
            color: new Uint16Array([0x0f00]),
        };
        data.slots = [{ name: 'gold', emissive: 0, materialClass: 'gold' }];
        return data;
    }

    async function classedColumns() {
        const encoded = await encodeVxlV3(makeClassedColumn());
        const decoded = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        expect(decoded.slots).toHaveLength(1);
        return buildVxlCharacterColumns(decoded);
    }

    it('emits contiguous material groups that partition the index buffer', async () => {
        const columns = await classedColumns();
        expect(columns.groups).toHaveLength(2);
        expect(columns.groups[0]!.start).toBe(0);
        expect(columns.groups[1]!.start).toBe(columns.groups[0]!.count);
        expect(columns.groups[0]!.count + columns.groups[1]!.count).toBe(columns.index.length);
        expect(columns.groups[1]!.count).toBeGreaterThan(0);
    });

    it("the slot group holds exactly the slotted voxels' quads — filler included", async () => {
        const columns = await classedColumns();
        const slotGroup = columns.groups[1]!;
        // Slot 1 is the top three voxels (y ≥ 9·SIZE) plus the filler inside
        // one of their cells; every vertex the group references sits up there.
        for (let k = slotGroup.start; k < slotGroup.start + slotGroup.count; k++) {
            const v = columns.index[k]!;
            expect(columns.position[v * 3 + 1]!).toBeGreaterThanOrEqual(9 * SIZE - 1e-6);
        }
        // 3 stacked slot voxels (18 faces) lose 2×2 to culling between
        // themselves, plus voxel 9's bottom face against voxel 8 — same joint,
        // different SLOT, and slots must not affect the same-owner rule (a
        // slot boundary inside one limb is a colour change, not a seam that
        // opens when the joint bends) = 13 surface quads, plus 6 filler quads.
        expect(slotGroup.count).toBe((13 + 6) * 6);
    });

    it('a v10 body yields one base group covering everything, and no geometry groups', async () => {
        const decoded = await decodeColumn();
        const columns = buildVxlCharacterColumns(decoded);
        expect(columns.groups).toHaveLength(1);
        expect(columns.groups[0]!).toEqual({ start: 0, count: columns.index.length });
        const mesh = assembleVxlSkinnedMesh(columns, createVxlBindSkeleton(decoded.rig!), material());
        expect(mesh.geometry.groups).toHaveLength(0);
    });

    it('a material array renders the groups, with skinning intact across the reorder', async () => {
        const columns = await classedColumns();
        const encoded = await encodeVxlV3(makeClassedColumn());
        const decoded = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        const mesh = assembleVxlSkinnedMesh(columns, createVxlBindSkeleton(decoded.rig!), [material(), material()]);
        expect(mesh.geometry.groups).toHaveLength(2);
        expect(mesh.geometry.groups.map((gr) => gr.materialIndex)).toEqual([0, 1]);
        const index = mesh.geometry.getAttribute('skinIndex');
        for (let v = 0; v < index.count; v++) {
            expect(index.getX(v)).toBe(columns.joint[v]);
        }
    });
});

describe('classed template materials (loader)', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        clearVxlCharacterTemplateCache();
    });

    async function stubFetchWith(data: VxlV3Data): Promise<void> {
        const encoded = await encodeVxlV3(data);
        const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => bytes,
        })) as unknown as typeof fetch;
    }

    it('a v10 body keeps exactly the one flat vertex-colour Lambert it always had', async () => {
        await stubFetchWith(makeColumn());
        const template = await loadVxlCharacterTemplate('https://cdn/plain-body.vxl');
        expect(template.materials).toHaveLength(1);
        const base = template.materials[0] as THREE.MeshLambertMaterial;
        expect(base).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(base.vertexColors).toBe(true);
        expect(base.flatShading).toBe(true);
        // ...and the instance renders it as a single material, no groups.
        const { scene } = instantiateVxlCharacter(template);
        const mesh = scene.getObjectByName('vxlCharacterBody') as THREE.SkinnedMesh;
        expect(Array.isArray(mesh.material)).toBe(false);
    });

    it('a v11 gold slot gets a classed vertex-colour material beside the Lambert base', async () => {
        // Runs at the default quality ('high' off-mobile — node has no stored
        // choice): the gold slot must climb above Lambert while the base stays
        // exactly the flat Lambert body.
        const data = makeColumn(0);
        for (const l of data.fragments[0]!.leaves as OctreeLeaf[]) {
            if (l.y >= 9 * SIZE - 1e-9) l.slot = 1;
        }
        data.slots = [{ name: 'gold', emissive: 0, materialClass: 'gold' }];
        await stubFetchWith(data);

        const template = await loadVxlCharacterTemplate('https://cdn/gold-body.vxl');
        expect(template.materials).toHaveLength(2);
        expect(template.materials[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
        const gold = template.materials[1]!;
        expect(gold).not.toBeInstanceOf(THREE.MeshLambertMaterial);
        expect((gold as THREE.MeshPhysicalMaterial).vertexColors).toBe(true);

        const { scene } = instantiateVxlCharacter(template);
        const mesh = scene.getObjectByName('vxlCharacterBody') as THREE.SkinnedMesh;
        expect(Array.isArray(mesh.material)).toBe(true);
        expect((mesh.material as THREE.Material[])).toHaveLength(2);
        expect(mesh.geometry.groups.length).toBeGreaterThan(0);
    });
});

describe('body detail level (loader)', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        clearVxlCharacterTemplateCache();
    });

    /** The 12-voxel column plus a coarser level: six double-size voxels, same joint split. */
    function columnWithCoarseLevel(): VxlV3Data {
        const data = makeColumn(0);
        const leaves: OctreeLeaf[] = [];
        for (let i = 0; i < 6; i++) {
            leaves.push({ x: 0, y: i * SIZE * 2, z: 0, size: SIZE * 2, r: 0.8, g: 0.2, b: 0.2, bone: i < 3 ? 0 : 1 });
        }
        data.additionalLods = [{
            minVoxelSize: SIZE * 2, maxVoxelSize: SIZE * 2,
            fragments: [{ aabbMin: [0, 0, 0], aabbMax: [SIZE * 2, 12 * SIZE, SIZE * 2], leaves }],
        }];
        return data;
    }

    async function stubFetchWith(data: VxlV3Data): Promise<jest.Mock> {
        const encoded = await encodeVxlV3(data);
        const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
        const mock = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes }));
        global.fetch = mock as unknown as typeof fetch;
        return mock;
    }

    it('level 1 builds the coarser body, level 0 the full one, from one fetch', async () => {
        const fetchMock = await stubFetchWith(columnWithCoarseLevel());
        const full = await loadVxlCharacterTemplate('https://cdn/lod-body.vxl', 0);
        const coarse = await loadVxlCharacterTemplate('https://cdn/lod-body.vxl', 1);
        expect(full.lod).toBe(0);
        expect(coarse.lod).toBe(1);
        expect(coarse.columns.joint.length).toBeLessThan(full.columns.joint.length);
        // Same body, same height: the coarser level must not read as a different character.
        expect(coarse.bindBox.max.y - coarse.bindBox.min.y).toBeCloseTo(full.bindBox.max.y - full.bindBox.min.y, 6);
        expect(coarse.measurements).toEqual(full.measurements);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a file without the requested level yields the finest it has, and says so', async () => {
        await stubFetchWith(makeColumn(0));
        const template = await loadVxlCharacterTemplate('https://cdn/plain-body.vxl', 1);
        expect(template.lod).toBe(0);
        expect(template.columns.joint.length).toBeGreaterThan(0);
    });
});
