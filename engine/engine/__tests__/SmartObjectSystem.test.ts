/**
 * Smart objects at runtime: the view's hierarchy and the system's motion.
 *
 * What is pinned: a part's mesh does not move when the view is built (a
 * windmill at rest looks exactly like its static bake), a spin turns about the
 * part's pivot and nothing else, an upright child of a spinning parent stays
 * level (the ferris-wheel property), and speed changes do not make a part jump.
 *
 * @jest-environment node
 */
import * as THREE from 'three';
import { SmartObjectView } from 'engine/SmartObjectView.js';
import { SmartObjectSystem, type SmartObjectHost } from 'engine/SmartObjectSystem.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import type { SmartObjectFitment } from 'types/smartObject.js';

/** A wheel spinning about Z at 6 rpm (one turn per 10 s) with a cabin hanging at its rim. */
const PARTS: VxlV3Part[] = [
    { name: 'wheel', parentJoint: 0, motion: { kind: 'spin', axis: [0, 0, 1], rpm: 6 } },
    { name: 'cabin', parentJoint: 1, motion: { kind: 'upright' } },
];
/** Wheel pivot at (0, 2, 0); cabin hinge 1.5 above the hub (local to the wheel). */
const BIND = new Float32Array([0, 0, 0, 0, 2, 0, 0, 1.5, 0]);

function marker(x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.position.set(x, y, z);
    return mesh;
}

/** The asset-frame position of a mesh's origin after the view's transforms. */
function assetPosition(mesh: THREE.Object3D): THREE.Vector3 {
    mesh.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
}

function makeView(): { view: SmartObjectView; body: THREE.Mesh; wheel: THREE.Mesh; cabin: THREE.Mesh } {
    // Meshes are built in object space; a mesh's own position is its origin
    // there, so an origin-placed mesh must stay at the origin once parented.
    const body = marker(0, 0, 0);
    const wheel = marker(0, 0, 0);
    const cabin = marker(0, 0, 0);
    const view = new SmartObjectView({
        parts: PARTS, bindPositions: BIND,
        meshes: [{ joint: 0, mesh: body }, { joint: 1, mesh: wheel }, { joint: 2, mesh: cabin }],
    });
    return { view, body, wheel, cabin };
}

describe('SmartObjectView', () => {
    test('nests pivots by parent and leaves every mesh where it was at rest', () => {
        const { view, body, wheel, cabin } = makeView();
        expect(view.pivotOf('wheel')!.parent).toBe(view);
        expect(view.pivotOf('cabin')!.parent).toBe(view.pivotOf('wheel'));
        expect(view.pivotOf('cabin')!.position.y).toBeCloseTo(1.5);
        for (const mesh of [body, wheel, cabin]) {
            const p = assetPosition(mesh);
            expect(p.x).toBeCloseTo(0); expect(p.y).toBeCloseTo(0); expect(p.z).toBeCloseTo(0);
        }
    });

    test('subtracts the object pivot when the vertex space is offset from the asset frame', () => {
        const wheel = marker(0, 0, 0);
        const view = new SmartObjectView({
            parts: [PARTS[0]!], bindPositions: new Float32Array([0, 0, 0, 0, 2, 0]),
            meshes: [{ joint: 1, mesh: wheel }], pivot: { x: 0, y: 0.5, z: 0 },
        });
        // Pivot group at asset (0, 2, 0); mesh translated back by (2 − 0.5) in vertex space.
        expect(view.pivotOf('wheel')!.position.y).toBeCloseTo(2);
        expect(wheel.position.y).toBeCloseTo(-1.5);
    });

    test('refuses a rig whose joint count does not match the parts', () => {
        expect(() => new SmartObjectView({ parts: PARTS, bindPositions: new Float32Array(6), meshes: [] }))
            .toThrow(/joints/);
    });
});

/** A stand-in for VoxelObject: a Group the system can attach to, already in a scene. */
function makeHost(meshes: Array<{ joint: number; mesh: THREE.Mesh }>): SmartObjectHost & { own: THREE.Mesh } {
    const host = new THREE.Group() as THREE.Group & SmartObjectHost & { own: THREE.Mesh };
    host.own = marker(0, 0, 0);
    host.add(host.own);
    host.getDecodedVxlV3 = () => ({ parts: PARTS, rig: { bindPositions: BIND } });
    host.buildSmartPartMeshes = () => meshes;
    host.getMesh = () => host.own;
    host.getPivot = () => ({ x: 0, y: 0, z: 0 });
    // A parentless host is dropped on the next update(), so every host needs one.
    new THREE.Scene().add(host);
    return host;
}

const FITMENT: SmartObjectFitment = {
    version: 1,
    parts: [
        { name: 'wheel', pivot: { x: 0, y: 2, z: 0 }, motion: { kind: 'spin', axis: [0, 0, 1], rpm: 6 } },
        { name: 'cabin', parent: 'wheel', pivot: { x: 0, y: 3.5, z: 0 }, motion: { kind: 'upright' } },
    ],
    source: { version: 1, grid: 128, parts: [], lights: [] },
};

describe('SmartObjectSystem', () => {
    test('attach hides the host mesh and adds the view; detach restores it', () => {
        const system = new SmartObjectSystem();
        const host = makeHost([{ joint: 1, mesh: marker(0, 0, 0) }]);
        expect(system.attach('mill', host, FITMENT)).toBe(true);
        expect(host.own.visible).toBe(false);
        expect(host.children.some((child) => child instanceof SmartObjectView)).toBe(true);
        expect(system.partsOf('mill')).toEqual(['wheel', 'cabin']);
        expect(system.attach('mill', host, FITMENT)).toBe(false);
        system.detach('mill');
        expect(host.own.visible).toBe(true);
        expect(host.children.some((child) => child instanceof SmartObjectView)).toBe(false);
    });

    test('a spin turns about the pivot: a point on the rim orbits the hub', () => {
        const system = new SmartObjectSystem();
        // A part mesh's own position belongs to the view; a child stands in for a
        // vertex. This one sits 1 m right of the hub, which is at (0, 2, 0).
        const wheel = marker(0, 0, 0);
        const rim = marker(1, 2, 0);
        wheel.add(rim);
        const host = makeHost([{ joint: 1, mesh: wheel }]);
        system.attach('wheel', host, FITMENT);
        // 6 rpm = a quarter turn in 2.5 s: (1, 2, 0) about Z through (0, 2, 0) → (0, 3, 0).
        system.update(2.5);
        const p = assetPosition(rim);
        expect(p.x).toBeCloseTo(0, 5);
        expect(p.y).toBeCloseTo(3, 5);
        expect(p.z).toBeCloseTo(0, 5);
    });

    test('an upright cabin stays level while its wheel turns, and orbits the hub', () => {
        const system = new SmartObjectSystem();
        const cabin = marker(0, 0, 0);
        const hinge = marker(0, 3.5, 0);      // a vertex at the hinge
        const floor = marker(0, 2.5, 0);      // a vertex 1 m below it
        cabin.add(hinge, floor);
        const host = makeHost([{ joint: 2, mesh: cabin }]);
        system.attach('ferris', host, FITMENT);
        system.update(5);                     // half a turn: hinge (0, 3.5) → (0, 0.5)
        const p = assetPosition(hinge);
        expect(p.x).toBeCloseTo(0, 5);
        expect(p.y).toBeCloseTo(0.5, 5);
        // Level: the floor is still 1 m straight below the hinge.
        const f = assetPosition(floor);
        expect(f.x).toBeCloseTo(0, 5);
        expect(f.y).toBeCloseTo(-0.5, 5);
        const q = new THREE.Quaternion().setFromRotationMatrix(cabin.matrixWorld);
        expect(Math.abs(q.w)).toBeCloseTo(1, 5);
    });

    test('anchorToWorld carries an asset-frame point with its part, through the host transform', () => {
        const system = new SmartObjectSystem();
        const host = makeHost([{ joint: 1, mesh: marker(0, 0, 0) }]);
        // The instance stands at (10, 0, 0), turned a quarter about Y.
        host.position.set(10, 0, 0);
        host.rotation.y = Math.PI / 2;
        system.attach('wheel', host, FITMENT);
        const out = new THREE.Vector3();
        // At rest a lamp at asset (1, 2, 0) is on the rim; the host's quarter turn
        // about Y takes asset +X to world −Z.
        system.update(0);
        expect(system.anchorToWorld('wheel', 'wheel', { x: 1, y: 2, z: 0 }, out)).toBe(true);
        expect(out.x).toBeCloseTo(10, 5); expect(out.y).toBeCloseTo(2, 5); expect(out.z).toBeCloseTo(-1, 5);
        // A quarter turn of the wheel lifts it to asset (0, 3, 0) → world (10, 3, 0).
        system.update(2.5);
        expect(system.anchorToWorld('wheel', 'wheel', { x: 1, y: 2, z: 0 }, out)).toBe(true);
        expect(out.x).toBeCloseTo(10, 5); expect(out.y).toBeCloseTo(3, 5); expect(out.z).toBeCloseTo(0, 5);
        expect(system.anchorToWorld('wheel', 'nope', { x: 0, y: 0, z: 0 }, out)).toBe(false);
        expect(system.anchorToWorld('other', 'wheel', { x: 0, y: 0, z: 0 }, out)).toBe(false);
    });

    test('changing a speed re-phases so the part does not jump', () => {
        const system = new SmartObjectSystem();
        const rim = marker(1, 2, 0);
        const host = makeHost([{ joint: 1, mesh: rim }]);
        system.attach('wheel', host, FITMENT);
        system.update(1);
        const before = assetPosition(rim);
        expect(system.setPartSpeed('wheel', 'wheel', 0)).toBe(true);
        system.update(0);
        const after = assetPosition(rim);
        expect(after.distanceTo(before)).toBeCloseTo(0, 5);
        system.update(10);                    // stopped: still there
        expect(assetPosition(rim).distanceTo(before)).toBeCloseTo(0, 5);
        expect(system.setPartSpeed('wheel', 'nope', 1)).toBe(false);
    });

    test('a pendulum swings amplitude either side of rest and returns', () => {
        const system = new SmartObjectSystem();
        const parts: VxlV3Part[] = [{ name: 'sign', parentJoint: 0, motion: { kind: 'pendulum', axis: [1, 0, 0], amplitudeDeg: 30, periodS: 4 } }];
        const host = makeHost([{ joint: 1, mesh: marker(0, 0, 0) }]);
        host.getDecodedVxlV3 = () => ({ parts, rig: { bindPositions: new Float32Array([0, 0, 0, 0, 2, 0]) } });
        system.attach('sign', host, { ...FITMENT, parts: [] });
        const angleOf = (): number => 2 * Math.acos(Math.min(1, Math.abs(system.pivotOf('sign', 'sign')!.quaternion.w)));
        system.update(1);                     // quarter period: full amplitude
        expect(angleOf()).toBeCloseTo(30 * Math.PI / 180, 5);
        system.update(1);                     // half period: back at rest
        expect(angleOf()).toBeCloseTo(0, 5);
    });

    test('an instance removed from the scene is dropped on the next update', () => {
        const system = new SmartObjectSystem();
        const host = makeHost([{ joint: 1, mesh: marker(0, 0, 0) }]);
        system.attach('mill', host, FITMENT);
        host.removeFromParent();
        system.update(0.1);
        expect(system.ids()).toEqual([]);
    });
});
