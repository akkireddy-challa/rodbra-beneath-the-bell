import * as THREE from 'three';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import {
    RangedWeaponSystem,
    DEFAULT_RANGED_WEAPON_OPTIONS,
    CURSOR_FACING_LINGER_MS,
    type RangedWeaponSystemOptions,
} from 'engine/RangedWeaponSystem.js';

/**
 * Cursor-aim facing regression (the "top-down character never turns" report):
 * with the default `cursorFacing: 'while-firing'`, the cursor must NOT steer
 * the character during traversal — movement-driven facing stays in charge —
 * and MUST steer it while the trigger is held plus a short linger.
 * `cursorFacing: 'always'` keeps the classic twin-stick behavior.
 *
 * The private seams are reached via a structural cast: the per-frame driver is
 * updateCursorAim(), the trigger pull is triggerShoot().
 */
interface CursorAimInternals {
    player: THREE.Object3D | null;
    controller: PlayerController | null;
    effectiveAimMode: 'camera' | 'cursor';
    cursorGroundPointThisFrame: THREE.Vector3 | null;
    lastCursorTriggerMs: number;
    updateCursorAim(): void;
}

function makeSystem(options?: Partial<RangedWeaponSystemOptions>): {
    system: RangedWeaponSystem;
    internals: CursorAimInternals;
    player: THREE.Object3D;
    setRotationCalls: number[];
} {
    const system = new RangedWeaponSystem(
        null,
        {} as unknown as PhysicsWorld,
        { ...DEFAULT_RANGED_WEAPON_OPTIONS, ...options },
    );
    const setRotationCalls: number[] = [];
    const controller = {
        getMovementSystem: () => ({
            setRotation: (yaw: number) => setRotationCalls.push(yaw),
        }),
    } as unknown as PlayerController;
    const player = new THREE.Object3D();

    const internals = system as unknown as CursorAimInternals;
    internals.player = player;
    internals.controller = controller;
    internals.effectiveAimMode = 'cursor';
    internals.cursorGroundPointThisFrame = new THREE.Vector3(10, 0, 0); // due +X of the player

    return { system, internals, player, setRotationCalls };
}

const YAW_PLUS_X = Math.atan2(10, 0); // gameplay +Z-forward convention

describe('RangedWeaponSystem cursor facing', () => {
    let nowMs: number;

    beforeEach(() => {
        nowMs = 1_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("default 'while-firing': the cursor does NOT steer the character during traversal", () => {
        const { internals, player, setRotationCalls } = makeSystem();
        internals.updateCursorAim();
        expect(setRotationCalls).toHaveLength(0);
        expect(player.rotation.y).toBe(0);
    });

    it('a trigger pull turns the character to the cursor immediately', () => {
        const { system, player, setRotationCalls } = makeSystem();
        system.triggerShoot();
        expect(setRotationCalls).toEqual([YAW_PLUS_X]);
        expect(player.rotation.y).toBeCloseTo(YAW_PLUS_X, 10);
    });

    it('the cursor keeps steering through the linger window after the last trigger pull', () => {
        const { system, internals, setRotationCalls } = makeSystem();
        system.triggerShoot();
        nowMs += CURSOR_FACING_LINGER_MS; // still inside the window (inclusive)
        internals.updateCursorAim();
        expect(setRotationCalls).toHaveLength(2);
    });

    it('movement facing resumes once the linger expires', () => {
        const { system, internals, player, setRotationCalls } = makeSystem();
        system.triggerShoot();
        nowMs += CURSOR_FACING_LINGER_MS + 1;
        player.rotation.y = 0.42; // movement wrote its own facing this frame
        internals.updateCursorAim();
        expect(setRotationCalls).toHaveLength(1); // only the trigger pull
        expect(player.rotation.y).toBe(0.42);
    });

    it("an empty-magazine trigger pull still opens the facing window (turning IS the feedback)", () => {
        // makeSystem has no weaponMesh/engine, so tryShoot() exits without
        // firing — exactly the empty-clip shape. Facing must still engage.
        const { system, internals, setRotationCalls } = makeSystem();
        system.triggerShoot();
        internals.updateCursorAim();
        expect(setRotationCalls).toHaveLength(2);
    });

    it("'always': the cursor steers every frame without any trigger pull", () => {
        const { internals, player, setRotationCalls } = makeSystem({ cursorFacing: 'always' });
        internals.updateCursorAim();
        expect(setRotationCalls).toEqual([YAW_PLUS_X]);
        expect(player.rotation.y).toBeCloseTo(YAW_PLUS_X, 10);
    });

    it('camera aim mode is untouched: a trigger pull does not open the cursor facing window', () => {
        const { system, internals, setRotationCalls } = makeSystem();
        internals.effectiveAimMode = 'camera';
        system.triggerShoot();
        expect(setRotationCalls).toHaveLength(0);
        expect(internals.lastCursorTriggerMs).toBe(0);
    });

    it('cursor deadzone: a ground point on top of the player does not spin them', () => {
        const { internals, setRotationCalls } = makeSystem({ cursorFacing: 'always' });
        internals.cursorGroundPointThisFrame = new THREE.Vector3(0.2, 0, 0.2);
        internals.updateCursorAim();
        expect(setRotationCalls).toHaveLength(0);
    });
});
