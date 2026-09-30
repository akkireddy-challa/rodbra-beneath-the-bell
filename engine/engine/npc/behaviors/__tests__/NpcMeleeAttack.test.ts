import * as THREE from 'three';
import { NpcMeleeAttack, resolveNpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import type { NpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import { playerMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
import type { NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
import { makeFakeRival, makeFakeWorld, runFrames, settleAnimations } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';
import type { FakeRival, FakeWorld, FakeWorldOptions } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';

/**
 * Behaviour contract for the shared unarmed combat helper. Every test targets a decision
 * branch (engaged/not, in reach/not, planted/not), never a particular tuning value.
 *
 * Contact itself is NOT tested here and cannot be: `NpcController` registers unarmed hits
 * engine-side off the strike animation. What this module owns — and what these tests
 * pin — is *when* a strike is thrown and *what damage/range the registered move carries*.
 */

function setup(
    config?: NpcMeleeAttackConfig,
    worldOptions?: FakeWorldOptions,
): { melee: NpcMeleeAttack; world: FakeWorld; tick: (dt: number) => void } {
    const world = makeFakeWorld(worldOptions);
    const melee = new NpcMeleeAttack(config);
    melee.initialize(world.context);
    return { melee, world, tick: (dt) => { melee.update(dt, world.character.position); } };
}

/** Engage once and let the strike clips register, as a real chase would. */
async function engageAndArm(melee: NpcMeleeAttack, world: FakeWorld): Promise<void> {
    world.setPlayerAt(0, 0, 5);
    melee.update(1 / 60, world.character.position);
    await settleAnimations(melee);
}

describe('NpcMeleeAttack — striking', () => {
    it('throws one strike per cooldown while the player stands in reach', async () => {
        const { melee, world, tick } = setup({ attackCooldown: 1.5 });
        await engageAndArm(melee, world);

        world.setPlayerAt(0, 0, 1);
        tick(1 / 60);
        expect(world.damageTaken).toEqual([{ amount: 10, source: 'npc_strike' }]);

        // Still in reach, cooldown not elapsed — no second strike.
        runFrames(1.0, tick);
        expect(world.damageTaken).toHaveLength(1);

        runFrames(1.0, tick);
        expect(world.damageTaken).toHaveLength(2);
    });

    it('stays planted for the length of the strike clip instead of sliding', async () => {
        const { melee, world } = setup();
        await engageAndArm(melee, world);

        world.setPlayerAt(0, 0, 1);

        melee.update(1 / 60, world.character.position);
        // Player walks out of reach mid-strike; the NPC holds its ground rather than
        // stutter-chasing.
        world.setPlayerAt(0, 0, 6);
        expect(melee.update(1 / 60, world.character.position).state).toBe('attack');

        runFrames(1.0, (dt) => { melee.update(dt, world.character.position); });
        expect(melee.update(1 / 60, world.character.position).state).toBe('chase');
    });

    it('cannot land a hit without an animation controller — contact is animation-driven', async () => {
        // Documents a real limit of delegating contact to the engine: no strike clip
        // means no engine-registered hit. The behavior still chases and squares up.
        const { melee, world, tick } = setup(undefined, { withAnimationController: false });
        await engageAndArm(melee, world);

        world.setPlayerAt(0, 0, 1);
        runFrames(4.0, tick);

        expect(world.damageTaken).toHaveLength(0);
    });

    it('chases and faces but never strikes when attacksPlayer is false', async () => {
        const { melee, world, tick } = setup({ attacksPlayer: false });
        await engageAndArm(melee, world);

        world.setPlayerAt(0, 0, 1);
        runFrames(4.0, tick);

        expect(world.anim?.startAttackCalls).toBe(0);
        expect(world.damageTaken).toHaveLength(0);
        expect(world.character.rotation.y).toBeCloseTo(0);
    });
});

describe('NpcMeleeAttack — engagement', () => {
    it('holds aggro between detectionRange and loseInterestRange (hysteresis)', () => {
        const { melee, world } = setup({ detectionRange: 10, loseInterestRange: 15 });
        const tick = (): ReturnType<NpcMeleeAttack['update']> => melee.update(1 / 60, world.character.position);

        world.setPlayerAt(0, 0, 10);
        expect(tick().state).not.toBe('disengaged');

        // Past detection but inside lose-interest: still engaged.
        world.setPlayerAt(0, 0, 12);
        expect(tick().state).toBe('chase');

        world.setPlayerAt(0, 0, 15.5);
        expect(tick().state).toBe('disengaged');

        // And it does not re-engage until back inside detectionRange.
        world.setPlayerAt(0, 0, 12);
        expect(tick().state).toBe('disengaged');
    });

    it('returns a clone of the target position, not the live vector', () => {
        const { melee, world } = setup();
        world.setPlayerAt(0, 0, 5);

        const engagement = melee.update(1 / 60, world.character.position);
        expect(engagement.state).toBe('chase');
        if (engagement.state === 'disengaged') throw new Error('expected an engagement target');
        engagement.targetPosition.set(999, 999, 999);

        const next = melee.update(1 / 60, world.character.position);
        if (next.state === 'disengaged') throw new Error('expected an engagement target');
        expect(next.targetPosition).toEqual(new THREE.Vector3(0, 0, 5));
    });

    it('disengages when the player controller disappears', () => {
        const { melee, world } = setup();
        world.setPlayerAt(0, 0, 5);
        expect(melee.update(1 / 60, world.character.position).state).toBe('chase');

        world.removePlayer();

        expect(melee.update(1 / 60, world.character.position).state).toBe('disengaged');
    });

    it('faces the player across frames where the behavior holds still', () => {
        const { world, tick } = setup();
        world.setPlayerAt(3, 0, 0);
        runFrames(0.2, tick);
        expect(world.character.rotation.y).toBeCloseTo(Math.PI / 2);

        world.setPlayerAt(-3, 0, 0);
        runFrames(0.2, tick);
        expect(world.character.rotation.y).toBeCloseTo(-Math.PI / 2);
    });
});

describe('NpcMeleeAttack — chase speed', () => {
    it('applies chaseSpeed on aggro and restores the base speed on disengage', () => {
        const { world, tick } = setup({ chaseSpeed: 7, detectionRange: 10, loseInterestRange: 15 }, { moveSpeed: 3 });

        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);
        expect(world.moveSpeed()).toBe(7);

        world.setPlayerAt(0, 0, 40);
        tick(1 / 60);
        expect(world.moveSpeed()).toBe(3);
    });

    it('restores the base speed when disposed mid-aggro', () => {
        const { melee, world, tick } = setup({ chaseSpeed: 7 }, { moveSpeed: 3 });
        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);
        expect(world.moveSpeed()).toBe(7);

        melee.dispose();
        expect(world.moveSpeed()).toBe(3);

        // Idempotent: a second dispose must not re-apply anything.
        melee.dispose();
        expect(world.setMoveSpeedCalls).toEqual([7, 3]);
    });

    it('never touches move speed when detectionRange is 0', () => {
        const { world, tick } = setup({ detectionRange: 0 }, { moveSpeed: 3 });
        world.setPlayerAt(0, 0, 0.5);

        runFrames(5.0, tick);

        expect(world.setMoveSpeedCalls).toHaveLength(0);
        expect(world.damageTaken).toHaveLength(0);
    });
});

describe('NpcMeleeAttack — strike registration', () => {
    it('registers strikes carrying the configured damage and reach', async () => {
        // These two fields are the whole of this module's contribution to damage:
        // NpcController's engine-level hit registration reads them off the move.
        const { melee, world } = setup({ damage: 25, attackRange: 3 });
        await engageAndArm(melee, world);

        expect(world.anim?.registered.length).toBeGreaterThan(0);
        for (const move of world.anim?.registered ?? []) {
            expect(move.damage).toBe(25);
            expect(move.range).toBe(3);
            expect(move.filterRootMotion).toBe(true);
        }
    });

    it('loads strike clips only — no guard stance, no locomotion replacement', async () => {
        const { melee, world } = setup();
        await engageAndArm(melee, world);

        expect(world.anim?.packs).toHaveLength(1);
        const pack = world.anim!.packs[0];
        expect(pack.animations.some(a => a.name.toLowerCase().includes('idle'))).toBe(false);
        // addToAttackCollection would bind one clip as the sole ATTACK state override.
        expect(pack.options?.addToAttackCollection).toBeUndefined();
        expect(pack.options?.replaceLocomotion).toBeUndefined();
    });

    it('loads the pack once across repeated aggro cycles', async () => {
        const { melee, world } = setup();
        await engageAndArm(melee, world);

        world.setPlayerAt(0, 0, 40);
        melee.update(1 / 60, world.character.position);
        world.setPlayerAt(0, 0, 5);
        melee.update(1 / 60, world.character.position);
        await settleAnimations(melee);

        expect(world.anim?.packs).toHaveLength(1);
    });

    it('leaves an NPC that already has its own moves alone (template owns combat)', async () => {
        const { melee, world } = setup(undefined, { existingAttackMoves: ['sword_slash'] });
        await engageAndArm(melee, world);

        expect(world.anim?.packs).toHaveLength(0);
        expect(world.anim?.registered).toHaveLength(0);
    });
});

describe('NpcMeleeAttack — armed', () => {
    it('hands the weapon to the engine at initialize, before any fight starts', () => {
        // A guard carries its axe while it patrols; it does not draw one the instant it
        // notices you. Equipping is also what decides which moves get registered later.
        const { world } = setup({ weapon: { type: 'axe' }, damage: 20, attackRange: 2.3 });

        expect(world.weapon.equipped).toEqual([
            expect.objectContaining({ type: 'axe', damage: 20, reach: 2.3, scale: 1.0 }),
        ]);
        expect(world.weapon.isArmed()).toBe(true);
    });

    it('swings the weapon instead of throwing punches', async () => {
        const { melee, world } = setup({ weapon: { type: 'sword' } });
        await settleAnimations(melee);

        const registered = world.anim?.registered ?? [];
        expect(registered.length).toBeGreaterThan(0);
        // 'attack' is what routes contact to the blade sweep; a punch/kick here would be
        // the bug this config exists to remove — fists thrown while holding a sword.
        for (const move of registered) expect(move.type).toBe('attack');
    });

    it('registers the swing set of the weapon it holds, not one clip for every weapon', async () => {
        const sword = setup({ weapon: { type: 'sword' } });
        await settleAnimations(sword.melee);
        const axe = setup({ weapon: { type: 'axe' } });
        await settleAnimations(axe.melee);

        const names = (world: FakeWorld): string[] => (world.anim?.registered ?? []).map(m => m.name);
        expect(names(sword.world).length).toBeGreaterThan(1);
        expect(names(sword.world)).not.toEqual(names(axe.world));
    });

    it('carries the weapon from the moment it is drawn, not from first aggro', async () => {
        // The weapon-holding locomotion has to be in place while the NPC patrols: loading
        // it on aggro leaves a guard walking an empty-handed cycle around a drawn sword.
        const { melee, world } = setup({ weapon: { type: 'sword' }, detectionRange: 10 });
        await settleAnimations(melee);

        // No target has come near yet — the NPC has never engaged.
        const pack = world.anim!.packs[0];
        expect(pack).toBeDefined();
        expect(pack.options?.replaceLocomotion).toBe(true);
        // Same reason as unarmed: this would bind one clip as the sole ATTACK override,
        // and every weapon would swing identically.
        expect(pack.options?.addToAttackCollection).toBeUndefined();
    });

    it('registers swings carrying the configured damage and reach', async () => {
        const { melee, world } = setup({ weapon: { type: 'spear' }, damage: 14, attackRange: 3.2 });
        await settleAnimations(melee);

        for (const move of world.anim?.registered ?? []) {
            expect(move.damage).toBe(14);
            expect(move.range).toBe(3.2);
            expect(move.filterRootMotion).toBe(true);
        }
    });

    it('swaps the whole swing set with the weapon, leaving none of the old one behind', async () => {
        // Without unregistering, a re-armed NPC keeps rolling its previous weapon's clips
        // — an axe that still slashes like the sword it replaced.
        const { melee, world } = setup({ weapon: { type: 'sword' } });
        await settleAnimations(melee);
        const swordMoves = (world.anim?.registered ?? []).map(m => m.name);
        expect(swordMoves.length).toBeGreaterThan(0);

        expect(melee.setWeapon('axe')).toBe(true);
        const axeMoves = (world.anim?.registered ?? []).map(m => m.name);

        expect(axeMoves.length).toBeGreaterThan(0);
        for (const name of axeMoves) expect(swordMoves).not.toContain(name);
    });

    it('retries the equip while the character is still loading its hand', async () => {
        const { melee, world, tick } = setup({ weapon: { type: 'sword' } }, { canEquipWeapon: false });
        expect(world.weapon.isArmed()).toBe(false);

        // The skeleton lands a few frames later, as a skinned character's does.
        world.weapon.setHandReady(true);
        runFrames(0.5, tick);
        await settleAnimations(melee);

        expect(world.weapon.isArmed()).toBe(true);
        for (const move of world.anim?.registered ?? []) expect(move.type).toBe('attack');
    });

    it('falls back to fists once the retries run out', async () => {
        // An animal, or a character with no right hand at all. Registering weapon swings
        // anyway would leave it slashing at the air with nothing in its hand.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { melee, world, tick } = setup({ weapon: { type: 'sword' } }, { canEquipWeapon: false });
            runFrames(2.0, tick);
            await engageAndArm(melee, world);

            expect(world.weapon.isArmed()).toBe(false);
            for (const move of world.anim?.registered ?? []) {
                expect(['punch', 'kick']).toContain(move.type);
            }
            // Silence here is the failure mode: an NPC configured with a weapon that
            // quietly fights bare-handed reads exactly like a config that was ignored.
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('stops registering swings when the weapon is taken away behind its back', async () => {
        // Cached "am I armed" state would keep this NPC throwing sword swings the engine
        // refuses to land — full animations, zero damage, no diagnostic.
        const { melee, world } = setup({ weapon: { type: 'sword' } });
        world.weapon.disarm();

        world.setPlayerAt(0, 0, 5);
        melee.update(1 / 60, world.character.position);
        await settleAnimations(melee);

        for (const move of world.anim?.registered ?? []) {
            expect(['punch', 'kick']).toContain(move.type);
        }
    });

    it('puts the weapon away when disposed, and takes its swings with it', async () => {
        const { melee, world } = setup({ weapon: { type: 'sword' } });
        await settleAnimations(melee);
        expect(world.anim?.registered.length).toBeGreaterThan(0);

        melee.dispose();

        expect(world.weapon.unequipCalls).toBe(1);
        expect(world.weapon.isArmed()).toBe(false);
        // A controller outliving this helper (behavior swap) must not keep swings for a
        // weapon that is no longer in its hand.
        expect(world.anim?.registered).toHaveLength(0);
    });

    it('leaves an unarmed NPC entirely alone — no weapon, no equip call', () => {
        const { world } = setup();
        expect(world.weapon.equipped).toHaveLength(0);
        expect(world.weapon.isArmed()).toBe(false);
    });
});

describe('NpcMeleeAttack — fighting someone other than the player', () => {
    /** A free-for-all roster: the player plus every rival, as a battle royale builds it. */
    function royale(rivals: FakeRival[], world: FakeWorld): () => readonly NpcMeleeTarget[] {
        const player = playerMeleeTarget(world.context.getEngine().getPlayerController());
        const roster = [...(player ? [player] : []), ...rivals.map(r => r.target)];
        return () => roster;
    }

    /** Engage from out of reach and let the clips register, as a real approach would —
     *  a strike thrown before they load spends its cooldown without connecting. */
    async function engageAndArm(melee: NpcMeleeAttack, world: FakeWorld): Promise<void> {
        melee.update(1 / 60, world.character.position);
        await settleAnimations(melee);
    }

    it('strikes the nearest rival, and the damage lands on that rival — not the player', async () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 4) });
        const near = makeFakeRival(0, 0, 5);
        const far = makeFakeRival(0, 0, 7);
        const melee = new NpcMeleeAttack({ damage: 22, findTargets: royale([near, far], world) });
        melee.initialize(world.context);
        await engageAndArm(melee, world);

        // Everyone closes in; the player stays a step further out than the nearest rival.
        near.setAt(0, 0, 1);
        far.setAt(0, 0, 3);
        melee.update(1 / 60, world.character.position);

        expect(near.damageTaken).toEqual([{ amount: 22, source: 'npc_strike' }]);
        expect(far.damageTaken).toHaveLength(0);
        expect(world.damageTaken).toHaveLength(0);
    });

    it('aims the engine hit test before swinging, so contact is tested against the rival', async () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 4) });
        const rival = makeFakeRival(0, 0, 3);
        const melee = new NpcMeleeAttack({ findTargets: royale([rival], world) });
        melee.initialize(world.context);
        await engageAndArm(melee, world);

        rival.setAt(0, 0, 1);
        melee.update(1 / 60, world.character.position);

        expect(world.strikeTarget()).toBe(rival.target);
        // And disposing releases it, so a respawn does not inherit the old victim.
        melee.dispose();
        expect(world.strikeTarget()).toBeNull();
    });

    it('re-picks when the current target dies, instead of beating a corpse', async () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 40) });
        const first = makeFakeRival(0, 0, 5);
        const second = makeFakeRival(0, 0, 5.5);
        const melee = new NpcMeleeAttack({ attackCooldown: 0.5, findTargets: royale([first, second], world) });
        melee.initialize(world.context);
        await engageAndArm(melee, world);

        first.setAt(0, 0, 1);
        second.setAt(0, 0, 1.5);
        melee.update(1 / 60, world.character.position);
        expect(first.damageTaken).toHaveLength(1);

        first.kill();
        runFrames(1.0, (dt) => { melee.update(dt, world.character.position); });

        expect(first.damageTaken).toHaveLength(1);
        expect(second.damageTaken).toHaveLength(1);
    });

    it('disengages once every rival is dead and the player is out of range', () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 40) });
        const rival = makeFakeRival(0, 0, 2);
        const melee = new NpcMeleeAttack({ findTargets: royale([rival], world) });
        melee.initialize(world.context);
        expect(melee.update(1 / 60, world.character.position).state).toBe('attack');

        rival.kill();

        expect(melee.update(1 / 60, world.character.position).state).toBe('disengaged');
    });

    it('ignores itself when the resolver hands back the whole roster', () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 40) });
        const rival = makeFakeRival(0, 0, 3);
        // `self` reports the NPC's own live position vector, exactly as npcMeleeTarget
        // would for the controller running this behavior.
        const self: NpcMeleeTarget = {
            isPlayer: false,
            getPosition: () => world.character.position,
            getFeetPosition: () => world.character.position,
            getCapsuleHeight: () => 1.8,
            getCapsuleRadius: () => 0.4,
            isDead: () => false,
            takeDamage: () => { throw new Error('an NPC must not punch itself'); },
        };
        const melee = new NpcMeleeAttack({ findTargets: () => [self, rival.target] });
        melee.initialize(world.context);

        const engagement = melee.update(1 / 60, world.character.position);
        if (engagement.state === 'disengaged') throw new Error('expected the rival to be picked');
        expect(engagement.target).toBe(rival.target);
    });

    it('reports isPlayer so a chase after an NPC skips the shared player goal field', () => {
        const world = makeFakeWorld({ player: new THREE.Vector3(0, 0, 5) });
        const rival = makeFakeRival(0, 0, 8);
        const melee = new NpcMeleeAttack({ findTargets: royale([rival], world) });
        melee.initialize(world.context);

        const onPlayer = melee.update(1 / 60, world.character.position);
        if (onPlayer.state === 'disengaged') throw new Error('expected a target');
        expect(onPlayer.target.isPlayer).toBe(true);

        world.setPlayerAt(0, 0, 30);
        const onRival = melee.update(1 / 60, world.character.position);
        if (onRival.state === 'disengaged') throw new Error('expected a target');
        expect(onRival.target.isPlayer).toBe(false);
    });
});

describe('resolveNpcMeleeAttackConfig', () => {
    it('derives loseInterestRange from the configured detectionRange', () => {
        expect(resolveNpcMeleeAttackConfig({ detectionRange: 30 }).loseInterestRange).toBe(45);
        expect(resolveNpcMeleeAttackConfig({ detectionRange: 30, loseInterestRange: 32 }).loseInterestRange).toBe(32);
    });

    it('preserves explicit zeros rather than falling back to defaults', () => {
        const resolved = resolveNpcMeleeAttackConfig({ detectionRange: 0, damage: 0 });
        expect(resolved.detectionRange).toBe(0);
        expect(resolved.damage).toBe(0);
    });
});
