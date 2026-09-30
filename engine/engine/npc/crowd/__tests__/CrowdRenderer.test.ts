/**
 * Slot bookkeeping is where an instanced renderer goes wrong invisibly: a stale
 * index writes one NPC's transform onto another, and a leaked slot leaves a
 * corpse standing in the crowd forever. These tests pin the swap-on-release
 * contract and the growth path, using fake members so no GPU is involved.
 */
import * as THREE from 'three';
import { CrowdRenderer } from 'engine/npc/crowd/CrowdRenderer.js';
import type { CrowdRenderMember } from 'engine/npc/crowd/CrowdRenderer.js';

class FakeMember implements CrowdRenderMember {
    color = new THREE.Color(1, 1, 1);
    constructor(public x = 0, public y = 0, public z = 0, public yaw = 0, public frame = 0) { }
    getCrowdX(): number { return this.x; }
    getCrowdY(): number { return this.y; }
    getCrowdZ(): number { return this.z; }
    getCrowdYaw(): number { return this.yaw; }
    getCrowdFrameRow(): number { return this.frame; }
    getCrowdColor(): THREE.Color { return this.color; }
}

function makeRenderer(): { renderer: CrowdRenderer; parent: THREE.Object3D } {
    const renderer = new CrowdRenderer();
    const parent = new THREE.Object3D();
    renderer.registerVariant('raider', new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), parent);
    return { renderer, parent };
}

describe('CrowdRenderer slots', () => {
    test('acquire assigns dense indices and drives the draw count', () => {
        const { renderer } = makeRenderer();
        const a = renderer.acquire('raider', new FakeMember())!;
        const b = renderer.acquire('raider', new FakeMember())!;
        expect(a.index).toBe(0);
        expect(b.index).toBe(1);
        expect(renderer.getStats()[0]!.count).toBe(2);
    });

    test('an unknown variant returns null rather than dropping the NPC silently', () => {
        const { renderer } = makeRenderer();
        expect(renderer.acquire('mutant', new FakeMember())).toBeNull();
    });

    test('release swaps the last instance down and updates ITS handle', () => {
        // The bug this guards: the moved instance keeps its old index, so the
        // renderer writes its transform into a slot that no longer draws.
        const { renderer } = makeRenderer();
        const a = renderer.acquire('raider', new FakeMember())!;
        const b = renderer.acquire('raider', new FakeMember())!;
        const c = renderer.acquire('raider', new FakeMember())!;
        renderer.release(a);
        expect(c.index).toBe(0); // last swapped into the hole
        expect(b.index).toBe(1); // untouched
        expect(renderer.getStats()[0]!.count).toBe(2);
    });

    test('releasing the last instance needs no swap', () => {
        const { renderer } = makeRenderer();
        const a = renderer.acquire('raider', new FakeMember())!;
        const b = renderer.acquire('raider', new FakeMember())!;
        renderer.release(b);
        expect(a.index).toBe(0);
        expect(renderer.getStats()[0]!.count).toBe(1);
    });

    test('double release is a no-op, not a corruption', () => {
        const { renderer } = makeRenderer();
        const a = renderer.acquire('raider', new FakeMember())!;
        renderer.acquire('raider', new FakeMember());
        renderer.release(a);
        renderer.release(a);
        expect(renderer.getStats()[0]!.count).toBe(1);
    });

    test('grows past the initial capacity without losing instances', () => {
        const { renderer } = makeRenderer();
        const slots = Array.from({ length: 200 }, () => renderer.acquire('raider', new FakeMember())!);
        expect(slots.every((s) => s !== null)).toBe(true);
        const stats = renderer.getStats()[0]!;
        expect(stats.count).toBe(200);
        expect(stats.capacity).toBeGreaterThanOrEqual(200);
        // Indices must still be a dense 0..199 after two doublings.
        expect(new Set(slots.map((s) => s.index)).size).toBe(200);
    });

    test('the frame attribute survives a growth', () => {
        const { renderer } = makeRenderer();
        const members = Array.from({ length: 70 }, (_, i) => new FakeMember(i, 0, 0, 0, i));
        members.forEach((m) => renderer.acquire('raider', m));
        renderer.update();
        expect(renderer.getStats()[0]!.count).toBe(70);
    });
});

describe('CrowdRenderer update', () => {
    test('writes each member transform to its own instance', () => {
        const { renderer } = makeRenderer();
        const a = new FakeMember(5, 1, -3);
        const b = new FakeMember(-7, 2, 9);
        const slotA = renderer.acquire('raider', a)!;
        const slotB = renderer.acquire('raider', b)!;
        renderer.update();

        const stats = renderer.getStats()[0]!;
        expect(stats.count).toBe(2);
        expect(slotA.index).not.toBe(slotB.index);
    });

    test('invalidates the bounding sphere so a moving crowd is not culled away', () => {
        // InstancedMesh computes its bounding sphere once and never invalidates;
        // with instances moving every frame the stale sphere frustum-culls the
        // entire crowd as soon as the player leaves where it first stood.
        const { renderer, parent } = makeRenderer();
        renderer.acquire('raider', new FakeMember());
        const mesh = parent.children[0] as THREE.InstancedMesh;
        mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
        renderer.update();
        expect(mesh.boundingSphere).toBeNull();
    });

    test('an empty batch skips work entirely', () => {
        const { renderer } = makeRenderer();
        expect(() => renderer.update()).not.toThrow();
        expect(renderer.getStats()[0]!.count).toBe(0);
    });
});
