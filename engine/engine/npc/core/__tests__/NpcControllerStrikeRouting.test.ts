import { NpcController } from 'engine/npc/core/NpcController.js';
import type { CustomAttackMove } from 'types/game.js';

/**
 * Which contact test an NPC's attack animation is routed to — the fist, the engine-held
 * blade, or nothing at all.
 *
 * The third case is the one worth a test of its own: a behavior that attached its own
 * weapon mesh and runs its own blade sweep (`EXAMPLE_MeleeNpcBehavior`, and every
 * published game built from it) plays `type: 'attack'` moves too. The engine must stay
 * out of those, because both sweeps landing means every swing deals double damage — and
 * nothing else in the suite would notice if that gate were removed.
 */

interface AttackStarted { moveName: string; duration: number }

function makeController(options: { armed: boolean; move: CustomAttackMove | undefined; contacts?: readonly number[] }): {
    /** Fire the animation controller's attack-started hook, as a swing would. */
    startAttack: (moveName: string, duration: number) => void;
    /** Checkpoint sets handed to the scheduler — one entry per attack that was routed. */
    scheduled: readonly (readonly number[])[];
    beginSwingCalls: () => number;
} {
    const controller = Object.create(NpcController.prototype) as NpcController;
    const scheduled: (readonly number[])[] = [];
    let beginSwingCalls = 0;
    let listener: ((event: AttackStarted) => void) | null = null;

    const internals = controller as unknown as {
        weaponComp: { isArmed: () => boolean; beginSwing: () => void };
        scheduleHitChecks: (checkpoints: readonly number[], duration: number, land: () => boolean) => void;
        wireStrikeHitRegistration: (animCtl: unknown) => void;
    };
    internals.weaponComp = {
        isArmed: () => options.armed,
        beginSwing: () => { beginSwingCalls += 1; },
    };
    // Stand in for the real scheduler: the routing decision is which checkpoint set the
    // attack was handed, and the two sets differ in length (4 unarmed, 5 weapon).
    internals.scheduleHitChecks = (checkpoints) => { scheduled.push(checkpoints); };

    internals.wireStrikeHitRegistration({
        setEngineAttackStartedListener: (cb: (event: AttackStarted) => void) => { listener = cb; },
        getAttackMoveConfig: () => options.move,
        getAttackContactCheckPhases: (fallback: readonly number[]) => options.contacts ?? fallback,
    });

    return {
        startAttack: (moveName, duration) => listener?.({ moveName, duration }),
        scheduled,
        beginSwingCalls: () => beginSwingCalls,
    };
}

const PUNCH: CustomAttackMove = { name: 'npc_cross', animationMotionId: 'm1', type: 'punch', side: 'right' };
const KICK: CustomAttackMove = { name: 'npc_frontKick', animationMotionId: 'm2', type: 'kick', side: 'right' };
const SWING: CustomAttackMove = { name: 'npc_weapon:slashSide', animationMotionId: 'm3', type: 'attack' };

describe('NpcController — strike hit routing', () => {
    it('uses authored contact markers when the active clip supplies them', () => {
        const contacts = [.21, .3, .42];
        const npc = makeController({ armed: true, move: SWING, contacts });
        npc.startAttack(SWING.name, .8);
        expect(npc.scheduled).toEqual([contacts]);
    });
    it('tests the fist for a punch, whether or not the NPC is holding a weapon', () => {
        for (const armed of [false, true]) {
            const npc = makeController({ armed, move: PUNCH });
            npc.startAttack(PUNCH.name, 0.6);

            expect(npc.scheduled).toHaveLength(1);
            expect(npc.scheduled[0]).toHaveLength(4);
            expect(npc.beginSwingCalls()).toBe(0);
        }
    });

    it('tests the fist for a kick too', () => {
        const npc = makeController({ armed: false, move: KICK });
        npc.startAttack(KICK.name, 0.6);

        expect(npc.scheduled).toHaveLength(1);
        expect(npc.scheduled[0]).toHaveLength(4);
    });

    it('sweeps the blade for a weapon swing when the engine holds the weapon', () => {
        const npc = makeController({ armed: true, move: SWING });
        npc.startAttack(SWING.name, 0.6);

        expect(npc.scheduled).toHaveLength(1);
        expect(npc.scheduled[0]).toHaveLength(5);
        // The swing's blade history has to be cleared at its start, or the first sample
        // sweeps the whole gap since the previous attack.
        expect(npc.beginSwingCalls()).toBe(1);
    });

    it('ignores a weapon swing from an NPC whose weapon the engine does NOT hold', () => {
        // EXAMPLE_MeleeNpcBehavior and its descendants: they attach their own mesh and run
        // their own sweep. Landing a second hit here would double every swing's damage.
        const npc = makeController({ armed: false, move: SWING });
        npc.startAttack(SWING.name, 0.6);

        expect(npc.scheduled).toHaveLength(0);
        expect(npc.beginSwingCalls()).toBe(0);
    });

    it('ignores an attack whose move it cannot resolve', () => {
        // The ATTACK state override path announces a move name that was never registered
        // (`addToAttackCollection`, which the frozen examples use).
        const npc = makeController({ armed: true, move: undefined });
        npc.startAttack('Attack Override', 0.6);

        expect(npc.scheduled).toHaveLength(0);
        expect(npc.beginSwingCalls()).toBe(0);
    });
});
