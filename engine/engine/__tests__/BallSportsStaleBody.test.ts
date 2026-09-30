/**
 * The kickable ball must be re-resolved from its VoxelObject, never cached.
 *
 * `BallSportsSystem` used to hold the rigid body it found at construction. An
 * env object REBUILDS its body whenever its physics changes (an AI edit
 * re-placing the ball, a level reload, a chunk streaming pass), and Rapier
 * REUSES freed handles — so the cached handle either traps the WASM module
 * ("unreachable" / recursive borrow, physics frozen for the whole session) or
 * kicks whichever body inherited the handle. Every access now goes through
 * `getBallBody()`, which re-reads the VoxelObject and checks `isValid()`.
 */

import { BallSportsSystem } from 'engine/BallSportsSystem.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { VoxelObject } from 'engine/VoxelObject.js';
import type RAPIER from '@dimforge/rapier3d-compat';

const BALL_NAME = 'rugby_ball';

interface FakeBody {
    id: number;
    valid: boolean;
    /** Every method called on this body, in order. */
    calls: string[];
    linvel: { x: number; y: number; z: number } | null;
    asRapier(): RAPIER.RigidBody;
}

/**
 * A body that behaves like Rapier's: once removed, every method other than
 * `isValid()` traps. A throw stands in for the WASM `unreachable` so a test
 * that reaches through a dead handle fails loudly instead of quietly passing.
 */
function fakeBody(id: number, x: number, z: number): FakeBody {
    const guard = (method: string): void => {
        if (!body.valid) throw new Error(`${method}() called through invalid handle ${body.id}`);
        body.calls.push(method);
    };
    const body: FakeBody = {
        id,
        valid: true,
        calls: [],
        linvel: null,
        asRapier: () => ({
            isValid: () => body.valid,
            translation: () => { guard('translation'); return { x, y: 0.2, z }; },
            setLinvel: (v: { x: number; y: number; z: number }) => { guard('setLinvel'); body.linvel = v; },
            setAngvel: () => { guard('setAngvel'); },
            wakeUp: () => { guard('wakeUp'); },
            setTranslation: () => { guard('setTranslation'); },
        }) as unknown as RAPIER.RigidBody,
    };
    return body;
}

/** The ball env object: only the members BallSportsSystem reads. */
function fakeBall(): { ball: VoxelObject; setBody: (b: FakeBody | null) => void } {
    let current: RAPIER.RigidBody | null = null;
    const ball = {
        name: BALL_NAME,
        getRigidBody: () => current,
        getColliders: () => [],
        setAlwaysActive: () => undefined,
    } as unknown as VoxelObject;
    return { ball, setBody: (b) => { current = b ? b.asRapier() : null; } };
}

interface Harness {
    system: BallSportsSystem;
    ball: VoxelObject;
    /** The body the system was constructed over, with the constructor's calls cleared. */
    original: FakeBody;
    /** Stand a different body (or none) behind the ball, as a rebuild would. */
    setBody: (b: FakeBody | null) => void;
    /** Fire the registered kick action. */
    kick: () => void;
}

/** A registered ball with a live body, plus a constructed system watching it. */
function harness(anim: unknown = null): Harness {
    const original = fakeBody(1, 0.5, 0);
    const { ball, setBody } = fakeBall();
    setBody(original);
    VoxelObjectBuilder.registerExternalObject(`${BALL_NAME}_0`, ball);

    let handler: (() => void) | null = null;
    const playerController = {
        player: { position: { x: 0, y: 0, z: 0 } },
        rotation: 0,
        animationController: anim,
        setActionHandler: (_name: string, fn: () => void) => { handler = fn; },
        addExternalDisplacement: () => undefined,
    } as unknown as PlayerController;

    const system = new BallSportsSystem(playerController, { ballName: BALL_NAME, cooldown: 0 });
    original.calls.length = 0; // ignore the constructor's radius probe + wake
    return {
        system,
        ball,
        original,
        setBody,
        kick: () => {
            if (!handler) throw new Error('kick action was never registered');
            handler();
        },
    };
}

describe('BallSportsSystem with a rebuilt or removed ball body', () => {
    beforeEach(() => {
        VoxelObjectBuilder.getAllObjects().clear();
    });

    test('kicks the REBUILT body and never touches the replaced handle', () => {
        const { system, kick, ball, original, setBody } = harness();

        // The object rebuilds its physics (edit re-places the ball): the old
        // handle is freed, a fresh body takes its place.
        original.valid = false;
        const rebuilt = fakeBody(2, 0.5, 0);
        setBody(rebuilt);

        expect(() => kick()).not.toThrow();
        expect(original.calls).toEqual([]);
        expect(rebuilt.linvel).not.toBeNull();
        expect(rebuilt.linvel?.x).toBeGreaterThan(0);
        expect(system.getBallBody()).toBe(ball.getRigidBody());
    });

    test('a removed ball body disables the kick instead of trapping Rapier', () => {
        const { system, kick, original } = harness();
        original.valid = false;

        expect(() => kick()).not.toThrow();
        expect(() => system.resetBall(0, 1, 0)).not.toThrow();
        expect(original.calls).toEqual([]);
        expect(system.getBallBody()).toBeNull();
    });

    test('an in-flight kick swing survives the body being removed mid-swing', () => {
        const anim = {
            playCustomAnimation: () => ({ success: true, duration: 0.6 }),
            getCustomMotionId: () => 'mSoccerKick01',
        };
        const { system, kick, original, setBody } = harness(anim);

        kick(); // opens the contact-sampling window while the body is alive
        original.calls.length = 0;
        original.valid = false; // chunk streamed out / object rebuilt mid-swing

        // The per-frame contact sampling must not reach the dead handle, and the
        // system must keep running so a later kick still works.
        expect(() => system.update(0.016)).not.toThrow();
        expect(original.calls).toEqual([]);

        // A kick with an animation controller fires on foot contact, so the
        // swing itself is the observable: the REBUILT body is the one the new
        // swing measures against.
        const rebuilt = fakeBody(2, 0.5, 0);
        setBody(rebuilt);
        kick();
        expect(rebuilt.calls).toContain('translation');
    });
});
