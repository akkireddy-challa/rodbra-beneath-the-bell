/**
 * Smart objects drawn as GLB meshes (engine/GlbSmartObject.ts): a low-poly prop whose file
 * declares `bmSmartObject` + `BM_part_*` nodes animates through SmartObjectSystem unvoxelized.
 *
 * What is pinned: nothing moves when the parts are lifted out (the rest pose is the model as
 * loaded), the wheel turns about its hub, a cabin hanging from it stays level while it orbits,
 * and a model without a declaration is left alone.
 *
 * @jest-environment node
 */
import * as THREE from 'three';
import { GlbSmartObjectHost, canonicalAnchorNames, deriveGlbSmartObject } from 'engine/GlbSmartObject.js';
import { SmartObjectSystem } from 'engine/SmartObjectSystem.js';

const HUB_Y = 5;

function boxMesh(name: string, size: [number, number, number], at: [number, number, number]): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
    mesh.name = name;
    mesh.position.set(...at);
    return mesh;
}

/** A GLB-shaped scene as three's loader returns it: native frame, extras on userData. */
function ferrisScene(declared = true): THREE.Group {
    const scene = new THREE.Group();
    scene.add(boxMesh('frame', [2, 0.2, 2], [0, 0.1, 0]));
    // The wheel spans y 2..8 (radius 3 around the hub); a cabin hangs from the top of the rim.
    const wheel = new THREE.Group();
    wheel.name = 'BM_part_wheel';
    wheel.add(boxMesh('rim', [6, 6, 0.2], [0, HUB_Y, 0]));
    scene.add(wheel);
    const cabin = boxMesh('BM_part_cabin', [1, 1, 1], [0, HUB_Y + 2.5, 0]);
    // bmedit's anchor(): `BM_anchor_<part>__<name>`, a child of the part at its rest offset.
    const floor = new THREE.Object3D();
    floor.name = 'BM_anchor_cabin__floor';
    floor.position.set(0, -0.5, 0);
    cabin.add(floor);
    scene.add(cabin);
    if (declared) {
        scene.userData.bmSmartObject = {
            parts: [
                { name: 'wheel', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 6 } },
                { name: 'cabin', parent: 'wheel', motion: { kind: 'upright' }, pivot: { x: 0, y: HUB_Y + 3, z: 0 } },
            ],
        };
    }
    return scene;
}

/** Build a placed instance the way EnvironmentObjectSystem does: host → scaled body clone. */
function place(scene: THREE.Group): { host: GlbSmartObjectHost; world: THREE.Scene } | null {
    const bbox = new THREE.Box3().setFromObject(scene);
    const center = bbox.getCenter(new THREE.Vector3());
    const derived = deriveGlbSmartObject(scene, { origin: { x: center.x, y: bbox.min.y, z: center.z }, scale: 1, lift: 0 });
    if (!derived) return null;
    const centered = new THREE.Group();
    scene.position.set(-center.x, -bbox.min.y, -center.z);
    centered.add(scene);
    const host = new GlbSmartObjectHost(derived.bake);
    host.add(centered.clone());
    host.position.set(10, 0, -4);
    const world = new THREE.Scene();
    world.add(host);
    return { host, world };
}

function worldPosOf(root: THREE.Object3D, name: string): THREE.Vector3 {
    const node = root.getObjectByName(name)!;
    root.updateMatrixWorld(true);
    return node.getWorldPosition(new THREE.Vector3());
}

describe('GLB smart objects', () => {
    it('derives the parts and their pivots from the declaration and the part nodes', () => {
        const scene = ferrisScene();
        const bbox = new THREE.Box3().setFromObject(scene);
        const derived = deriveGlbSmartObject(scene, { origin: { x: 0, y: bbox.min.y, z: 0 }, scale: 1, lift: 0 })!;
        expect(derived.bake.table.map((p) => p.name)).toEqual(['wheel', 'cabin']);
        // The wheel turns about its box centre (the hub); the cabin hangs from its declared hinge.
        expect(derived.bake.pivots[0]!.y).toBeCloseTo(HUB_Y);
        expect(derived.bake.pivots[1]!.y).toBeCloseTo(HUB_Y + 3);
    });

    it('leaves a model with no declaration alone', () => {
        expect(place(ferrisScene(false))).toBeNull();
    });

    it('turns the wheel about its hub and keeps the cabin level, from an unmoved rest pose', () => {
        const placed = place(ferrisScene())!;
        const { host, world } = placed;
        const restCabin = worldPosOf(world, 'BM_part_cabin');
        const restRim = worldPosOf(world, 'rim');

        expect(host.liftParts()).toBe(true);
        const system = new SmartObjectSystem();
        expect(system.attach('ferris_1', host, { version: 1, parts: [] })).toBe(true);
        // Attached but not yet ticked: exactly where the model put it.
        expect(worldPosOf(world, 'BM_part_cabin').distanceTo(restCabin)).toBeLessThan(1e-6);
        expect(worldPosOf(world, 'rim').distanceTo(restRim)).toBeLessThan(1e-6);

        // 6 rpm: a quarter turn in 2.5 s. The rim's centre is the hub, so it stays put; the
        // cabin, 2.5 above the hub, swings round to the side.
        system.update(2.5);
        expect(worldPosOf(world, 'rim').distanceTo(restRim)).toBeLessThan(1e-4);
        const cabin = worldPosOf(world, 'BM_part_cabin');
        // The hinge is now 3 to the side of the hub, and the cabin still hangs 0.5 below it.
        expect(Math.abs(cabin.x - 10)).toBeCloseTo(3, 4);
        expect(cabin.y).toBeCloseTo(HUB_Y - 0.5, 4);

        // Upright: the cabin's world orientation is still the host's (level).
        const q = world.getObjectByName('BM_part_cabin')!.getWorldQuaternion(new THREE.Quaternion());
        expect(q.angleTo(host.getWorldQuaternion(new THREE.Quaternion()))).toBeLessThan(1e-4);
    });

    it('names each part\'s anchors for code, and they ride with the part', () => {
        const { host, world } = place(ferrisScene())!;
        host.liftParts();
        const system = new SmartObjectSystem();
        system.attach('ferris_1', host, { version: 1, parts: [] });
        const floor = system.pivotOf('ferris_1', 'cabin')!.getObjectByName('BM_anchor_floor')!;
        expect(floor).toBeDefined();
        world.updateMatrixWorld(true);
        const rest = floor.getWorldPosition(new THREE.Vector3());
        expect(rest.y).toBeCloseTo(HUB_Y + 2, 4); // cabin centre 2.5 above the hub, floor 0.5 below that

        system.update(2.5); // a quarter turn: the floor swings to the side, still 1 below the hinge
        world.updateMatrixWorld(true);
        const moved = floor.getWorldPosition(new THREE.Vector3());
        expect(Math.abs(moved.x - 10)).toBeCloseTo(3, 4);
        expect(moved.y).toBeCloseTo(HUB_Y - 1, 4);
    });

    it('gives an anchor on the static body its short name too', () => {
        const body = new THREE.Group();
        const door = new THREE.Object3D();
        door.name = 'BM_anchor_tower__door';
        body.add(door);
        canonicalAnchorNames(body);
        expect(body.getObjectByName('BM_anchor_door')).toBe(door);
    });

    it('puts the parts back, still, when nothing animates them', () => {
        const { host, world } = place(ferrisScene())!;
        const rest = worldPosOf(world, 'BM_part_cabin');
        host.liftParts();
        expect(world.getObjectByName('BM_part_cabin')).toBeUndefined();
        host.restoreParts();
        expect(worldPosOf(world, 'BM_part_cabin').distanceTo(rest)).toBeLessThan(1e-6);
    });
});
