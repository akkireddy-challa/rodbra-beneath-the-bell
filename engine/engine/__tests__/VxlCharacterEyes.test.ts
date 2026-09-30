/**
 * Runtime eyes for rigged voxel characters (VxlV3 eye metadata → meshes).
 *
 * The eye SECTION round-trips through encode/decode elsewhere (VxlV3 format
 * tests); what is defended here is the RUNTIME half that was missing until now:
 * that `instantiateVxlCharacter` turns a decoded `EyeMeta` into a symmetric pair
 * of eye meshes parented to the head bone, hands back a controller to blink
 * them, and that a SkeletonUtils clone (how an NPC crowd is built) can rebind a
 * controller to its OWN eye meshes rather than the original's.
 *
 * A synthetic character is used rather than a corpus fixture: the shipped
 * vxl-v10-samples predate the eye section, and the geometry is irrelevant to
 * what these assertions check.
 */
import * as THREE from 'three';
import { encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import type { EyeMeta } from 'engine/VxlV3Eyes.js';
import {
    clearVxlCharacterTemplateCache,
    instantiateVxlCharacter,
    loadVxlCharacterTemplate,
} from 'engine/loaders/VxlCharacterLoader.js';
import {
    applyVxlEyeSpec,
    getVxlEyeController,
    getVxlEyeSpec,
    tickVxlCharacterEyes,
    tickVxlCharacterEyesAlong,
    setVxlCharacterEyeLook,
    EVIL_VXL_EYE_LOOK,
} from 'engine/loaders/VxlCharacterEyes.js';
import { AnimalEyeController } from 'engine/animal/AnimalEyeController.js';

const SIZE = 0.1;
const EYES: EyeMeta = { type: 'classic', w: 2, h: 2, centreX: 0.5, y: 8, z: 1, halfGap: 1 };

/** A short two-bone column carrying a head socket on joint 5 and an eye record. */
function makeEyedCharacter(): VxlV3Data {
    const leaves: OctreeLeaf[] = [];
    for (let i = 0; i < 12; i++) {
        leaves.push({ x: 0, y: i * SIZE, z: 0, size: SIZE, r: 0.8, g: 0.7, b: 0.6, bone: i < 6 ? 0 : 5 });
    }
    const empty = {
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
            bindPositions: new Float32Array(22 * 3).map((_, i) => i * 0.01),
            fillers: empty,
            sockets: [{ name: 'head', joint: 5, offset: [0, 1.5, 0] }],
        },
        eyes: EYES,
    };
}

/** Run the eye tick until a blink is caught, returning the smallest sclera scale.y seen. */
function minScaleAcrossABlink(scene: THREE.Object3D, sclera: THREE.Mesh): number {
    const pos = new THREE.Vector3();
    let min = 1;
    for (let i = 0; i < 500 && min > 0.5; i++) {   // a blink is due within 6s = 300 ticks
        tickVxlCharacterEyes(scene, 0.02, pos, null);
        min = Math.min(min, sclera.scale.y);
    }
    return min;
}

describe('VxlCharacterEyes', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        clearVxlCharacterTemplateCache();
    });

    async function loadEyed(url: string): Promise<THREE.Object3D> {
        const encoded = await encodeVxlV3(makeEyedCharacter());
        const buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
        global.fetch = jest.fn(async () => ({
            ok: true,
            arrayBuffer: async () => buf,
        })) as unknown as typeof fetch;
        const template = await loadVxlCharacterTemplate(url);
        expect(template.decoded.eyes).toBeTruthy();   // the section survived encode/decode
        return instantiateVxlCharacter(template).scene;
    }

    it('attaches a symmetric eye pair to the head bone with a controller', async () => {
        const scene = await loadEyed('https://cdn/eyed-a.vxl');

        const head = scene.getObjectByName('mixamorigHead');
        expect(head).toBeTruthy();
        const left = scene.getObjectByName('VxlEyeLeft');
        const right = scene.getObjectByName('VxlEyeRight');
        expect(left!.parent).toBe(head);            // hangs off the head bone → follows the rig
        expect(right!.parent).toBe(head);

        expect(left!.getObjectByName('VxlEyeLeftSclera')).toBeInstanceOf(THREE.Mesh);
        expect(left!.getObjectByName('VxlEyeLeftPupil')).toBeInstanceOf(THREE.Mesh);
        expect(right!.getObjectByName('VxlEyeRightSclera')).toBeInstanceOf(THREE.Mesh);
        expect(right!.getObjectByName('VxlEyeRightPupil')).toBeInstanceOf(THREE.Mesh);

        expect(getVxlEyeController(scene)).toBeInstanceOf(AnimalEyeController);
    });

    it('draws the square voxel eye: black rim, rectangular sclera w×h voxels, rectangular pupil', async () => {
        const scene = await loadEyed('https://cdn/eyed-square.vxl');
        const rim = scene.getObjectByName('VxlEyeLeftBorder') as THREE.Mesh;
        const sclera = scene.getObjectByName('VxlEyeLeftSclera') as THREE.Mesh;
        const pupil = scene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        // Boxes, never circles — the same border/sclera/pupil stack the block animals get.
        for (const mesh of [rim, sclera, pupil]) expect(mesh.geometry).toBeInstanceOf(THREE.BoxGeometry);
        const extent = (m: THREE.Mesh): THREE.Vector3 => {
            m.geometry.computeBoundingBox();
            return m.geometry.boundingBox!.getSize(new THREE.Vector3());
        };
        const scleraSize = extent(sclera);
        expect(scleraSize.x).toBeCloseTo(EYES.w * SIZE, 6);
        expect(scleraSize.y).toBeCloseTo(EYES.h * SIZE, 6);
        expect(extent(rim).x).toBeGreaterThan(scleraSize.x);   // rim shows around the sclera
        expect(extent(pupil).x).toBeLessThan(scleraSize.x);    // pupil has room to slide
        // Stacked front-to-back on the face: rim behind sclera behind pupil.
        expect(rim.position.z).toBeLessThan(sclera.position.z);
        expect(sclera.position.z).toBeLessThan(pupil.position.z);
    });

    it('pupils slide toward a gaze target within range and rest centred without one', async () => {
        const scene = await loadEyed('https://cdn/eyed-gaze.vxl');
        scene.updateMatrixWorld(true);
        const pupil = scene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        const rest = pupil.position.clone();
        const head = scene.getObjectByName('mixamorigHead')!.getWorldPosition(new THREE.Vector3());

        // A target 1 m to the character's right (+X in model space, the eyes face +Z).
        tickVxlCharacterEyes(scene, 0.016, head, head.clone().add(new THREE.Vector3(1, 0, 1)));
        expect(pupil.position.x).toBeGreaterThan(rest.x + 1e-4);
        expect(pupil.position.z).toBeCloseTo(rest.z, 6);        // slides across the face, never off it

        tickVxlCharacterEyes(scene, 0.016, head, null);          // nothing to look at
        // No target leaves the pupil where it was; an out-of-range one recentres it.
        tickVxlCharacterEyes(scene, 0.016, head, head.clone().add(new THREE.Vector3(100, 0, 0)));
        expect(pupil.position.x).toBeCloseTo(rest.x, 6);
    });

    it('a gaze DIRECTION (the player following its aim) moves the pupils the same way', async () => {
        const scene = await loadEyed('https://cdn/eyed-along.vxl');
        scene.updateMatrixWorld(true);
        const pupil = scene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        const rest = pupil.position.clone();

        tickVxlCharacterEyesAlong(scene, 0.016, new THREE.Vector3(-3, 0, 1));   // looking left-forward
        expect(pupil.position.x).toBeLessThan(rest.x - 1e-4);
        tickVxlCharacterEyesAlong(scene, 0.016, new THREE.Vector3(0, 0, 1));    // straight ahead
        expect(pupil.position.x).toBeCloseTo(rest.x, 6);
    });

    it('setVxlCharacterEyeLook recolours both eyes (black sclera, glowing red pupil) and disposes the old materials', async () => {
        const scene = await loadEyed('https://cdn/eyed-look.vxl');
        const pupilL = scene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        const pupilR = scene.getObjectByName('VxlEyeRightPupil') as THREE.Mesh;
        const scleraL = scene.getObjectByName('VxlEyeLeftSclera') as THREE.Mesh;
        const before = pupilL.material as THREE.Material;
        const disposed = jest.spyOn(before, 'dispose');

        expect(setVxlCharacterEyeLook(scene, EVIL_VXL_EYE_LOOK)).toBe(true);

        const pupilMat = pupilL.material as THREE.MeshStandardMaterial;
        expect(pupilR.material).toBe(pupilMat);                       // the pair shares one material
        expect(pupilMat.emissive.getHex()).toBe(EVIL_VXL_EYE_LOOK.pupil);   // glows in its own red
        expect(pupilMat.emissiveIntensity).toBeGreaterThan(0);
        expect((scleraL.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x000000);
        expect(disposed).toHaveBeenCalled();
        // Blink still drives the recoloured meshes.
        expect(minScaleAcrossABlink(scene, scleraL)).toBeLessThan(0.7);

        expect(setVxlCharacterEyeLook(new THREE.Group(), EVIL_VXL_EYE_LOOK)).toBe(false);   // no eyes here
    });

    it('places the two eyes symmetric in model space (same row/depth, gap = 2·halfGap·voxel)', async () => {
        const scene = await loadEyed('https://cdn/eyed-b.vxl');
        scene.updateMatrixWorld(true);
        const lp = scene.getObjectByName('VxlEyeLeft')!.getWorldPosition(new THREE.Vector3());
        const rp = scene.getObjectByName('VxlEyeRight')!.getWorldPosition(new THREE.Vector3());

        expect(lp.y).toBeCloseTo(rp.y, 4);          // same row
        expect(lp.z).toBeCloseTo(rp.z, 4);          // same depth
        expect(Math.abs(lp.x - rp.x)).toBeCloseTo(2 * EYES.halfGap * SIZE, 4);
    });

    it('blink shrinks the eyes vertically then restores them', async () => {
        const scene = await loadEyed('https://cdn/eyed-c.vxl');
        const sclera = scene.getObjectByName('VxlEyeLeftSclera') as THREE.Mesh;

        expect(minScaleAcrossABlink(scene, sclera)).toBeLessThan(0.7);   // a blink happened

        // Let it finish; the eye returns to full height.
        const pos = new THREE.Vector3();
        for (let i = 0; i < 10; i++) tickVxlCharacterEyes(scene, 0.05, pos, null);
        expect(sclera.scale.y).toBeCloseTo(1, 3);
    });

    it('a clone (bones only, no eye meshes, no userData) is re-dressed from the template spec', async () => {
        const scene = await loadEyed('https://cdn/eyed-d.vxl');
        const spec = getVxlEyeSpec(scene);
        expect(spec).toBeTruthy();

        // What SkeletonUtils.clone hands an NPC: the bone hierarchy with neither
        // the eye meshes nor userData (the clone drops both). Built here without
        // SkeletonUtils itself, which under jest resolves to a second `three`
        // instance whose clones are foreign objects to the engine's — a harness
        // artifact the vite-built engine does not have. The TEMPLATE keeps its
        // spec, which is what the NPC path applies to each clone.
        const clonedScene = scene.clone(true);
        for (const name of ['VxlEyeLeft', 'VxlEyeRight']) {
            const o = clonedScene.getObjectByName(name);
            o?.parent?.remove(o);
        }
        clonedScene.userData = {};
        expect(clonedScene.getObjectByName('VxlEyeLeft')).toBeUndefined();
        expect(getVxlEyeController(clonedScene)).toBeNull();

        const controller = applyVxlEyeSpec(clonedScene, spec!);
        expect(controller).toBeInstanceOf(AnimalEyeController);
        expect(applyVxlEyeSpec(clonedScene, spec!)).toBe(controller);   // idempotent

        // Exactly ONE pair on the clone, whatever SkeletonUtils did or did not
        // keep: applying the spec must never stack a second pair on top.
        const countNamed = (name: string): number => {
            let n = 0;
            clonedScene.traverse((o) => { if (o.name === name) n++; });
            return n;
        };
        expect(countNamed('VxlEyeLeft')).toBe(1);
        expect(countNamed('VxlEyeRight')).toBe(1);
        expect(clonedScene.getObjectByName('VxlEyeLeft')!.parent).toBe(clonedScene.getObjectByName('mixamorigHead'));

        // Its meshes are its own, independent of the original's.
        const clonePupil = clonedScene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        const origPupil = scene.getObjectByName('VxlEyeLeftPupil') as THREE.Mesh;
        expect(clonePupil).not.toBe(origPupil);
        const cloneSclera = clonedScene.getObjectByName('VxlEyeLeftSclera') as THREE.Mesh;
        expect(minScaleAcrossABlink(clonedScene, cloneSclera)).toBeLessThan(0.7);
        expect(origPupil.scale.y).toBe(1);   // original untouched by the clone's controller
    });
});
