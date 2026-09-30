import * as THREE from 'three';
import { GoalField, GoalFieldManager, GOAL_FIELD_DEFAULTS, type CellNavSource } from 'engine/npc/nav/GoalField.js';

/** 20x20 all-walkable grid at cellSize 1, origin 0,0; wall column at gx=10 except gz=15 (a doorway). */
function makeFakeNav(): CellNavSource {
    const cols = 20, rows = 20;
    const blocked = (gx: number, gz: number): boolean => gx === 10 && gz !== 15;
    return {
        isReady: () => true,
        getGridInfo: () => ({ cols, rows, minX: 0, minZ: 0, cellSize: 1 }),
        getCellGroundY: (gx, gz) => (gx < 0 || gz < 0 || gx >= cols || gz >= rows || blocked(gx, gz)) ? null : 0,
        canStepCells: (fx, fz, tx, tz) => {
            if (fx < 0 || fz < 0 || fx >= cols || fz >= rows) return false;
            if (tx < 0 || tz < 0 || tx >= cols || tz >= rows) return false;
            return !blocked(fx, fz) && !blocked(tx, tz);
        },
        worldToCell: (x, z) => ({ gx: Math.max(0, Math.min(cols - 1, Math.floor(x))), gz: Math.max(0, Math.min(rows - 1, Math.floor(z))) }),
        cellToWorld: (gx, gz) => ({ x: gx + 0.5, z: gz + 0.5 }),
        getCellMutationVersion: () => 1,
    };
}

describe('GoalField', () => {
    test('gradient points toward the goal on open ground', () => {
        const field = new GoalField('test', 50);
        field.setGoal(new THREE.Vector3(5.5, 0, 5.5));
        while (!field.isComplete()) field.updateSlice(makeFakeNav(), 10_000);
        const dir = field.sampleDirection(2.5, 5.5);
        expect(dir).not.toBeNull();
        expect(dir!.x).toBeGreaterThan(0.5);   // goal is at +X
        expect(Math.abs(dir!.z)).toBeLessThan(0.7);
    });

    test('gradient routes through the doorway, not through the wall', () => {
        const field = new GoalField('test', 50);
        field.setGoal(new THREE.Vector3(15.5, 0, 5.5));  // goal on far side of wall
        while (!field.isComplete()) field.updateSlice(makeFakeNav(), 10_000);
        // NPC at (5.5, 5.5): straight line goes through the wall at gx=10; field must head toward doorway (gz=15)
        const dir = field.sampleDirection(9.5, 5.5); // right next to the wall
        expect(dir).not.toBeNull();
        expect(dir!.z).toBeGreaterThan(0.3);  // pushed toward the +Z doorway
    });

    test('resumable: sliced flood equals one-shot flood', () => {
        const nav = makeFakeNav();
        const oneShot = new GoalField('a', 50);
        oneShot.setGoal(new THREE.Vector3(5.5, 0, 5.5));
        while (!oneShot.isComplete()) oneShot.updateSlice(nav, 1_000_000);
        const sliced = new GoalField('b', 50);
        sliced.setGoal(new THREE.Vector3(5.5, 0, 5.5));
        while (!sliced.isComplete()) sliced.updateSlice(nav, 7); // tiny slices
        for (const [x, z] of [[2.5, 2.5], [18.5, 18.5], [9.5, 5.5]] as const) {
            const a = oneShot.getCost(x, z);
            const b = sliced.getCost(x, z);
            expect(a).toEqual(b);
        }
    });

    test('unreachable / outside cells sample null', () => {
        const field = new GoalField('test', 50);
        field.setGoal(new THREE.Vector3(5.5, 0, 5.5));
        while (!field.isComplete()) field.updateSlice(makeFakeNav(), 10_000);
        expect(field.sampleDirection(10.5, 5.5)).toBeNull();  // inside the wall
    });

    test('double-buffer: old field serves while goal moves and rebuild is in progress', () => {
        const nav = makeFakeNav();
        const field = new GoalField('test', 50);
        field.setGoal(new THREE.Vector3(5.5, 0, 5.5));
        while (!field.isComplete()) field.updateSlice(nav, 10_000);
        field.setGoal(new THREE.Vector3(15.5, 0, 15.5));  // moved > rebuild threshold
        field.updateSlice(nav, 5);                         // rebuild only started
        expect(field.sampleDirection(2.5, 5.5)).not.toBeNull();  // still served by old buffer
    });

    test('goal on a blocked cell anchors the flood at the nearest walkable cell', () => {
        const field = new GoalField('test', 50);
        field.setGoal(new THREE.Vector3(10.5, 0, 5.5)); // inside the wall column (gx=10)
        while (!field.isComplete()) field.updateSlice(makeFakeNav(), 10_000);
        // The field is usable: an NPC west of the wall walks toward the anchor
        // cell hugging the wall's edge (nearest walkable to the blocked goal).
        const dir = field.sampleDirection(5.5, 5.5);
        expect(dir).not.toBeNull();
        expect(dir!.x).toBeGreaterThan(0.5); // anchor is at +X of the NPC
        // The anchor cell (9,5) has cost 0; the blocked goal cell itself stays null.
        expect(field.getCost(9.5, 5.5)).toBe(0);
        expect(field.getCost(10.5, 5.5)).toBeNull();
    });

    test('manager caps active fields and evicts least-recently-used', () => {
        const mgr = new GoalFieldManager();
        for (let i = 0; i < GOAL_FIELD_DEFAULTS.maxActiveFields + 1; i++) {
            mgr.getOrCreate('key' + i, 50);
        }
        expect(mgr.activeCount()).toBe(GOAL_FIELD_DEFAULTS.maxActiveFields);
        expect(mgr.get('key0')).toBeNull();  // evicted
    });
});
