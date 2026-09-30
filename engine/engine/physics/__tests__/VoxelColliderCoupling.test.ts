/**
 * Seam coupling between voxels colliders, against real WASM. Pins the three
 * facts the terrain wiring depends on: an uncoupled seam stops a sliding
 * cuboid, coupling restores single-collider behaviour, and a coupled
 * neighbour's marks must be cleared before it is removed or bodies pass
 * through the seam.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
    cellsFromIntBoxes, coupleVoxelColliders, decoupleVoxelFace, voxelsDesc,
    coupleChunkVoxelColliders, decoupleChunkVoxelColliders,
} from 'engine/physics/VoxelColliders.js';

const S = 0.5;
const N = 16; // cells per chunk edge

function world(gravityY = -9.81): { w: RAPIER.World; fixed: RAPIER.RigidBody } {
    const w = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    w.timestep = 1 / 60;
    return { w, fixed: w.createRigidBody(RAPIER.RigidBodyDesc.fixed()) };
}
/** A chunk-local box run expanded to boundary cells. */
function chunk(w: number, h: number, d: number): Int32Array {
    return cellsFromIntBoxes([{ x: 0, y: 0, z: 0, w, h, d }]);
}
function collider(wd: RAPIER.World, body: RAPIER.RigidBody, cells: Int32Array, originX: number): RAPIER.Collider {
    return wd.createCollider(voxelsDesc(cells, S, S, S, originX, 0, 0).setFriction(0), body);
}
/** Slide a frictionless cuboid along +x from x = 2 over a floor with its top at y = S. */
function slideCuboid(w: RAPIER.World): number {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2, S + 0.2, 4).setLinvel(6, 0, 0));
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.2, 0.2).setFriction(0).setRestitution(0).setDensity(100), b);
    b.lockRotations(true, true);
    for (let i = 0; i < 150; i++) w.step();
    return b.translation().x;
}
/** Fire a cuboid along -x at y = 1, inside a 4-layer block's solid range. Needs a zero-gravity world. */
function fireAtWall(w: RAPIER.World, startX: number): number {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(startX, 1.0, 4).setLinvel(-5, 0, 0));
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.2, 0.2).setFriction(0).setRestitution(0).setDensity(100), b);
    b.lockRotations(true, true);
    for (let i = 0; i < 90; i++) w.step();
    return b.translation().x;
}

describe('voxels collider seam coupling', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it('an uncoupled seam stops a sliding cuboid; coupling lets it through like one collider', () => {
        const floor = chunk(N, 1, N);
        const single = world();
        collider(single.w, single.fixed, chunk(2 * N, 1, N), 0);
        const xSingle = slideCuboid(single.w); single.w.free();

        const split = world();
        collider(split.w, split.fixed, floor, 0); collider(split.w, split.fixed, floor, N * S);
        const xUncoupled = slideCuboid(split.w); split.w.free();

        const coupled = world();
        const a = collider(coupled.w, coupled.fixed, floor, 0);
        const b = collider(coupled.w, coupled.fixed, floor, N * S);
        coupleVoxelColliders(a, b, { x: N, y: 0, z: 0 });
        const xCoupled = slideCuboid(coupled.w); coupled.w.free();

        expect(xSingle).toBeGreaterThan(15);
        expect(xUncoupled).toBeLessThan(N * S + 0.5); // caught at the seam (x = 8)
        expect(xCoupled).toBeCloseTo(xSingle, 2);
    });

    it('a removed neighbour must be decoupled first, or its seam lets bodies through', () => {
        const block = chunk(N, 4, N); // solid y in [0, 2); A spans x [0, 8), B [8, 16)
        const wallX = N * S;

        const fresh = world(0);
        collider(fresh.w, fresh.fixed, block, 0);
        const xFresh = fireAtWall(fresh.w, 12); fresh.w.free();
        expect(xFresh).toBeCloseTo(wallX + 0.2, 1); // stopped at A's face

        const stale = world(0);
        const a1 = collider(stale.w, stale.fixed, block, 0);
        const b1 = collider(stale.w, stale.fixed, block, wallX);
        coupleVoxelColliders(a1, b1, { x: N, y: 0, z: 0 });
        stale.w.step();
        stale.w.removeCollider(b1, true);
        const xStale = fireAtWall(stale.w, 12); stale.w.free();
        expect(xStale).toBeLessThan(wallX - 1); // passed through the seam into A

        const clean = world(0);
        const a2 = collider(clean.w, clean.fixed, block, 0);
        const b2 = collider(clean.w, clean.fixed, block, wallX);
        coupleVoxelColliders(a2, b2, { x: N, y: 0, z: 0 });
        clean.w.step();
        // B is going away: clear what it wrote on A. B's face toward A is its x = 0 column;
        // A's origin relative to B's is -N cells.
        const propagated = decoupleVoxelFace(b2, block, a2, { x: -N, y: 0, z: 0 }, 0, 0);
        clean.w.removeCollider(b2, true);
        const xClean = fireAtWall(clean.w, 12); clean.w.free();
        expect(propagated).toBe(4 * N); // one column of a 4-layer, 16-deep block
        expect(xClean).toBeCloseTo(xFresh, 2);
    });
});

describe('chunk neighbourhood helpers', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it('couple a chunk with its neighbours, and decouple it before removal', () => {
        // Two chunk floors side by side, driven through the helpers the terrain systems call.
        const floor = chunk(N, 1, N);
        const { w, fixed } = world();
        const a = { collider: collider(w, fixed, floor, 0), cells: floor };
        const b = { collider: collider(w, fixed, floor, N * S), cells: floor };
        const chunks = new Map<string, typeof a>([['0,0,0', a], ['1,0,0', b]]);
        const neighboursOf = (cx: number) => (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined => {
            const n = chunks.get(`${cx + dx},${dy},${dz}`);
            return n ? [n.collider] : undefined;
        };
        // Built one at a time, as VoxelWorld does: A first (no neighbour yet), then B couples to A.
        coupleChunkVoxelColliders([a.collider], N, neighboursOf(0));
        coupleChunkVoxelColliders([b.collider], N, neighboursOf(1));
        expect(slideCuboid(w)).toBeGreaterThan(15); // crossed the seam at x = 8
        w.free();

        // Removal: B decoupled from A, then removed — A's seam must be exposed again.
        const block = chunk(N, 4, N);
        const w2 = world(0);
        const a2 = { collider: collider(w2.w, w2.fixed, block, 0), cells: block };
        const b2 = { collider: collider(w2.w, w2.fixed, block, N * S), cells: block };
        const chunks2 = new Map([['0,0,0', a2], ['1,0,0', b2]]);
        const nb = (cx: number) => (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined => {
            const n = chunks2.get(`${cx + dx},${dy},${dz}`); return n ? [n.collider] : undefined;
        };
        coupleChunkVoxelColliders([b2.collider], N, nb(1));
        w2.w.step();
        decoupleChunkVoxelColliders([b2], N, nb(1));
        w2.w.removeCollider(b2.collider, true);
        expect(fireAtWall(w2.w, 12)).toBeCloseTo(N * S + 0.2, 1);
        w2.w.free();
    });

    // The aliasing crash: `edit_1789602993223_173e3799` on game NITGUECVUB4A died with
    // rapier `RuntimeError: unreachable` / "recursive use of an object detected which would
    // lead to unsafe aliasing in rust" through decoupleVoxelFace → decoupleChunkVoxelColliders
    // → VoxelWorld.updateChunkPhysics, right after a large world edit, and the Voxel game
    // then could not load at all.
    //
    // What is pinned below is the CALL PATTERN, not `not.toThrow()`. rapier 0.20 tolerates a
    // duplicated `setVoxel`/`propagateVoxelChange` pair in a bare two-collider world — a
    // "does not throw" test passes just as happily on the code that shipped the crash, so it
    // would guard nothing. The wedge needs the borrow to already be held (a contact pair, a
    // step in flight), which a unit test cannot stage. The reachable invariant is the one the
    // fix establishes: each doomed cell is emptied exactly once, each (cell, neighbour)
    // propagation issued exactly once, and no `setVoxel` on a collider after propagation from
    // it has begun. Hold that and there is no duplicate wasm mutation left to alias.
    function recordDecoupleCalls(
        run: () => void,
    ): { setVoxel: string[]; propagate: string[]; order: string[] } {
        const proto = RAPIER.Collider.prototype;
        const realSetVoxel = proto.setVoxel, realPropagate = proto.propagateVoxelChange;
        const calls = { setVoxel: [] as string[], propagate: [] as string[], order: [] as string[] };
        proto.setVoxel = function (x, y, z, filled) {
            calls.setVoxel.push(`${this.handle}:${x},${y},${z}=${filled}`);
            calls.order.push(`set:${this.handle}`);
            return realSetVoxel.call(this, x, y, z, filled);
        };
        proto.propagateVoxelChange = function (other, x, y, z, sx, sy, sz) {
            calls.propagate.push(`${this.handle}->${other.handle}:${x},${y},${z}@${sx},${sy},${sz}`);
            calls.order.push(`prop:${this.handle}`);
            return realPropagate.call(this, other, x, y, z, sx, sy, sz);
        };
        try { run(); } finally { proto.setVoxel = realSetVoxel; proto.propagateVoxelChange = realPropagate; }
        return calls;
    }
    /** Every recorded call is distinct, and no collider is written to again once it starts propagating. */
    function expectNonReentrant(calls: { setVoxel: string[]; propagate: string[]; order: string[] }): void {
        expect(new Set(calls.setVoxel).size).toBe(calls.setVoxel.length);
        expect(new Set(calls.propagate).size).toBe(calls.propagate.length);
        const propagated = new Set<string>();
        for (const step of calls.order) {
            const [kind, handle] = step.split(':') as [string, string];
            if (kind === 'prop') propagated.add(handle);
            else expect(propagated.has(handle)).toBe(false);
        }
    }

    it('decouples a chunk of several collision-material colliders with one mutation per cell', () => {
        // Several friction groups per chunk is what a large edit adds: VoxelWorld's
        // boxesByFriction emits one voxels collider per material, so each neighbour direction
        // answers with a LIST, and the old code re-cleared the doomed face once per element.
        const block = chunk(N, 4, N);
        const { w, fixed } = world(0);
        const mk = (originX: number): { collider: RAPIER.Collider; cells: Int32Array } =>
            ({ collider: collider(w, fixed, block, originX), cells: block });
        const left = [mk(0), mk(0)], right = [mk(N * S), mk(N * S)];
        const nb = (cx: number) => (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined => {
            if (dy !== 0 || dz !== 0) return undefined;
            const side = cx + dx === 0 ? left : cx + dx === 1 ? right : undefined;
            return side?.map(v => v.collider);
        };
        coupleChunkVoxelColliders(left.map(v => v.collider), N, nb(0));
        coupleChunkVoxelColliders(right.map(v => v.collider), N, nb(1));
        w.step();

        const calls = recordDecoupleCalls(() => decoupleChunkVoxelColliders(right, N, nb(1)));
        expectNonReentrant(calls);
        // Each of the two doomed colliders clears its own 4×16 seam column once, and
        // propagates that column to each of the two survivors it is coupled to.
        expect(calls.setVoxel.length).toBe(2 * 4 * N);
        expect(calls.propagate.length).toBe(2 * 2 * 4 * N);

        for (const v of right) w.removeCollider(v.collider, true);
        expect(fireAtWall(w, 12)).toBeCloseTo(N * S + 0.2, 1); // stopped at the left chunk's face
        w.free();
    });

    it('clears a cell shared by two seams once when neighbours sit along several axes', () => {
        // A dense ring of buildings dirties chunks on more than one axis at a time, and a
        // chunk's +x and +z faces SHARE their edge cells. Clearing per (direction, neighbour)
        // pair emptied those twice and propagated between the two writes.
        const block = chunk(N, 4, N);
        const { w, fixed } = world(0);
        const doomed = { collider: collider(w, fixed, block, 0), cells: block };
        const alongX = collider(w, fixed, block, N * S);
        const alongZ = collider(w, fixed, block, 0);
        const nb = (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined => {
            if (dy !== 0) return undefined;
            if (dx === 1 && dz === 0) return [alongX];
            if (dx === 0 && dz === 1) return [alongZ];
            return undefined;
        };
        coupleChunkVoxelColliders([doomed.collider], N, nb);
        w.step();

        const calls = recordDecoupleCalls(() => decoupleChunkVoxelColliders([doomed], N, nb));
        expectNonReentrant(calls);
        // Two 4×16 faces sharing a 4-cell edge column: 2*4*N - 4 distinct cells, each cleared once.
        expect(calls.setVoxel.length).toBe(2 * 4 * N - 4);
        w.free();
    });

    it('survives the same seam being decoupled from both sides, as adjacent dirty chunks do', () => {
        // VoxelWorld.updateChunkPhysics rebuilds each dirty chunk in turn, and a large edit
        // leaves neighbours dirty together: chunk 0 is decoupled and rebuilt while chunk 1
        // still stands, then chunk 1 is decoupled against the REBUILT chunk 0. The same seam
        // is therefore walked twice, in opposite directions, within one pass.
        const block = chunk(N, 4, N);
        const { w, fixed } = world(0);
        let a = { collider: collider(w, fixed, block, 0), cells: block };
        const b = { collider: collider(w, fixed, block, N * S), cells: block };
        const live = new Map<number, { collider: RAPIER.Collider; cells: Int32Array }>([[0, a], [1, b]]);
        const nb = (cx: number) => (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined => {
            if (dy !== 0 || dz !== 0) return undefined;
            const n = live.get(cx + dx);
            return n ? [n.collider] : undefined;
        };
        coupleChunkVoxelColliders([a.collider], N, nb(0));
        coupleChunkVoxelColliders([b.collider], N, nb(1));
        w.step();

        const calls = recordDecoupleCalls(() => {
            // Chunk 0 rebuilt: decouple, remove, recreate, re-couple.
            decoupleChunkVoxelColliders([a], N, nb(0));
            live.delete(0);
            w.removeCollider(a.collider, true);
            a = { collider: collider(w, fixed, block, 0), cells: block };
            live.set(0, a);
            coupleChunkVoxelColliders([a.collider], N, nb(0));
            // Chunk 1 rebuilt in the same pass, revisiting the seam it shares with the new chunk 0.
            decoupleChunkVoxelColliders([b], N, nb(1));
            live.delete(1);
            w.removeCollider(b.collider, true);
        });
        expectNonReentrant(calls);

        expect(fireAtWall(w, 12)).toBeCloseTo(N * S + 0.2, 1); // chunk 1's seam marks were cleared
        w.free();
    });

    it('decouples a one-layer slice whose every cell is on the seam without crashing rapier', () => {
        // Chunk "5,0,2" of a fresh Voxel template world: 20 cells, all in the chunk's top layer,
        // with a chunk above. Decoupling empties rapier's 8³ storage block at x 8..15, z 8..15,
        // and clearing the row across x = 8 in that order threw `RuntimeError: unreachable` and
        // halted physics whenever the chunk was rebuilt mid-game. Unlike the aliasing case
        // above, a bare world does reproduce this one: the test throws without the fix.
        const slice = cellsFromIntBoxes([{ x: 6, y: N - 1, z: N - 2, w: N - 6, h: 1, d: 2 }]);
        const { w, fixed } = world(0);
        const doomed = { collider: collider(w, fixed, slice, 0), cells: slice };
        const above = w.createCollider(voxelsDesc(chunk(N, 1, N), S, S, S, 0, N * S, 0), fixed);
        const nb = (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined =>
            (dx === 0 && dy === 1 && dz === 0 ? [above] : undefined);
        coupleChunkVoxelColliders([doomed.collider], N, nb);
        w.step();

        const calls = recordDecoupleCalls(() => decoupleChunkVoxelColliders([doomed], N, nb));
        w.removeCollider(doomed.collider, true);
        expect(() => w.step()).not.toThrow();

        // Every seam cell is propagated to the neighbour; the extra cells that keep rapier's
        // storage blocks occupied are never propagated, so no seam can see them.
        expect(calls.propagate).toHaveLength(slice.length / 3);
        const cleared = calls.setVoxel.filter(c => c.endsWith('=false'));
        const kept = calls.setVoxel.filter(c => c.endsWith('=true'));
        expect(cleared).toHaveLength(slice.length / 3);
        expect(kept.length).toBeGreaterThan(0);
        for (const k of kept) {
            const [x, y, z] = k.split(':')[1]!.split('=')[0]!.split(',').map(Number);
            for (const v of [x, y, z]) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(N - 1); }
        }
        w.free();
    });
});
