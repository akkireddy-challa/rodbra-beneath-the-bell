import * as THREE from 'three';
import { NpcWeaponComponent, DEFAULT_NPC_MELEE_WEAPON } from 'engine/npc/core/NpcWeaponComponent.js';
import type { NpcWeaponHost } from 'engine/npc/core/NpcWeaponComponent.js';
import type { NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
import { WeaponType } from 'engine/WeaponRegistry.js';

/**
 * Contact contract for the engine-held NPC weapon. These pin the thing that is invisible
 * in a running game and impossible to eyeball: whether a swing that LOOKS like it connects
 * actually registers. The two failures worth catching are opposites — a blade that reaches
 * nothing (the NPC swings through bodies) and one that reaches everything (damage from
 * across the arena, and from swings thrown the other way).
 */

/** A hand the weapon can hang off, positioned in world space like a posed bone. */
function makeHost(): { host: NpcWeaponHost; character: THREE.Object3D; hand: THREE.Object3D } {
    const character = new THREE.Object3D();
    const hand = new THREE.Object3D();
    character.add(hand);
    return {
        character,
        hand,
        host: {
            getCharacter: () => character,
            getBodyPartObject: () => hand,
            attachToBodyPart: (object) => {
                hand.add(object);
                // The real NpcController tilts anything parented to a hand 90° about X,
                // which is what turns the mesh's +Y blade axis into a forward-pointing
                // weapon. Without it these tests would swing at the sky.
                object.rotation.x = Math.PI / 2;
                return true;
            },
            detachFromBodyPart: (object) => { object.parent?.remove(object); },
            // Block NPCs: no per-frame blade re-orientation, so the weapon sits where the
            // hand puts it and these tests can position it deterministically.
            isRenderingSkinnedMesh: () => false,
        },
    };
}

/** A body standing at `position`, recording what it took. */
function makeTarget(position: THREE.Vector3): { target: NpcMeleeTarget; hits: number[] } {
    const hits: number[] = [];
    return {
        hits,
        target: {
            isPlayer: false,
            getPosition: () => position,
            getFeetPosition: () => position,
            getCapsuleHeight: () => 1.8,
            getCapsuleRadius: () => 0.4,
            isDead: () => false,
            takeDamage: (damage) => { hits.push(damage); },
        },
    };
}

function armed(): {
    weapon: NpcWeaponComponent;
    character: THREE.Object3D;
    hand: THREE.Object3D;
} {
    const { host, character, hand } = makeHost();
    const weapon = new NpcWeaponComponent(host);
    weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
    // Chest height, where a hand actually is. At y=0 every test would sit exactly on the
    // bottom cap of the target capsule and turn on floating-point luck.
    hand.position.y = 1.0;
    return { weapon, character, hand };
}

/** World transforms are read straight off matrixWorld — refresh them as a frame would. */
function poseFrame(character: THREE.Object3D): void {
    character.updateMatrixWorld(true);
}

describe('NpcWeaponComponent — equipping', () => {
    it.each(Object.values(WeaponType).flatMap(id => [id, `${id}_lowpoly`]))('%s attaches, lands a forward hit and disposes on unequip', type => {
        const { host, character, hand } = makeHost();
        hand.position.y = 1;
        const weapon = new NpcWeaponComponent(host);
        try {
            expect(weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type })).toBe(true);
            const held = hand.children[0]!;
            const disposal: jest.SpyInstance[] = [];
            held.traverse(child => {
                if (!(child instanceof THREE.Mesh)) return;
                disposal.push(jest.spyOn(child.geometry, 'dispose'));
                for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                    disposal.push(jest.spyOn(material, 'dispose'));
                }
            });
            poseFrame(character);
            const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 1));
            weapon.beginSwing();
            expect(weapon.sweep(target, 16, 2.5)).toBe(true);
            expect(hits).toEqual([16]);
            weapon.unequip();
            expect(hand.children).toHaveLength(0);
            disposal.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
        } finally { weapon.unequip(); }
    });

    it('arms the NPC and reports the weapon it was given', () => {
        const { weapon } = armed();
        expect(weapon.isArmed()).toBe(true);
        expect(weapon.getOptions()?.type).toBe('sword');
    });

    it('stays unarmed when there is no hand to hold the weapon', () => {
        const { host } = makeHost();
        const weapon = new NpcWeaponComponent({ ...host, getBodyPartObject: () => null });

        expect(weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' })).toBe(false);
        // The flag NpcController gates weapon contact on: a failed equip must not leave
        // the engine landing hits for a weapon that isn't there.
        expect(weapon.isArmed()).toBe(false);
    });

    it('builds no weapon at all when the hand is missing, so retries stay cheap', () => {
        const { host } = makeHost();
        let attachCalls = 0;
        const weapon = new NpcWeaponComponent({
            ...host,
            getBodyPartObject: () => null,
            attachToBodyPart: () => { attachCalls += 1; return false; },
        });

        for (let i = 0; i < 5; i++) weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
        // Bailing on the bone lookup means no geometry/material was allocated per attempt.
        expect(attachCalls).toBe(0);
    });

    it('keeps the weapon it is holding when a re-equip finds no hand', () => {
        // equip() unequips first; doing that before the hand check would disarm an NPC
        // that was already correctly armed.
        const { host, hand } = makeHost();
        let handPresent = true;
        const weapon = new NpcWeaponComponent({ ...host, getBodyPartObject: () => (handPresent ? hand : null) });
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });

        handPresent = false;
        expect(weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'axe' })).toBe(false);
        expect(weapon.isArmed()).toBe(true);
        expect(weapon.getOptions()?.type).toBe('sword');
    });

    it('snapshots the options it was given, so later mutation cannot retune the NPC', () => {
        const { weapon } = armed();
        const options = { ...DEFAULT_NPC_MELEE_WEAPON, type: 'axe', damage: 20 };
        weapon.equip(options);

        options.damage = 999;
        expect(weapon.getOptions()?.damage).toBe(20);
    });

    it('takes a two-handed weapon\'s grip from its preset, which picks its swing set', () => {
        const { host } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'longsword' });
        expect(weapon.getGrip()).toBe('two');

        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'dagger' });
        expect(weapon.getGrip()).toBe('one');
    });

    it('unequips idempotently', () => {
        const { weapon } = armed();
        weapon.unequip();
        weapon.unequip();
        expect(weapon.isArmed()).toBe(false);
        expect(weapon.getOptions()).toBeNull();
    });

    it('lands nothing while unarmed, whatever the target is doing', () => {
        const { host } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 0));

        expect(weapon.sweep(target, 15, 2.5)).toBe(false);
        expect(hits).toHaveLength(0);
    });
});

describe('NpcWeaponComponent — how the weapon is held', () => {
    /** Where the blade (+Y in the mesh's own frame) points in world space. */
    function bladeDirection(mesh: THREE.Object3D): THREE.Vector3 {
        return new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
    }

    /** The weapon the component is holding, reached the way a renderer would. */
    function heldWeapon(hand: THREE.Object3D): THREE.Object3D {
        const weapon = hand.children.find(child => child.userData.isMeleeWeapon);
        if (!weapon) throw new Error('no weapon attached to the hand');
        return weapon;
    }

    /**
     * A hand posed the way an arms-down rest pose leaves `mixamorigRightHand`: its local
     * frame points the blade axis at the character's left. This is the pose that made
     * swords lie sideways across the body — for BLOCK characters too, whose hand groups
     * copy their rotation straight off that same bone.
     */
    function poseHandSideways(hand: THREE.Object3D): void {
        hand.rotation.set(0, 0, Math.PI / 2);
    }

    it('points a block NPC\'s blade along its facing, not wherever the hand bone faces', () => {
        const { host, character, hand } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
        poseHandSideways(hand);
        poseFrame(character);

        weapon.updateHold(false);
        poseFrame(character);

        // BLADE_IDLE_FORWARD is forward with an upward tilt: mostly +Z, never sideways.
        const blade = bladeDirection(heldWeapon(hand));
        expect(blade.z).toBeGreaterThan(0.5);
        expect(Math.abs(blade.x)).toBeLessThan(0.1);
    });

    it('turns the blade with the NPC, so it always leads where the NPC faces', () => {
        const { host, character, hand } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
        poseHandSideways(hand);

        // Facing -Z now.
        character.rotation.y = Math.PI;
        poseFrame(character);
        weapon.updateHold(false);
        poseFrame(character);

        const blade = bladeDirection(heldWeapon(hand));
        expect(blade.z).toBeLessThan(-0.5);
    });

    it('hands a block NPC\'s weapon back to the hand mid-swing', () => {
        // The swing clip drives the whole arm on a block character; world-targeting the
        // blade through it would hold the sword still while the arm swung out from under.
        const { host, character, hand } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
        const attachedQ = heldWeapon(hand).quaternion.clone();

        poseHandSideways(hand);
        poseFrame(character);
        weapon.updateHold(false);
        expect(heldWeapon(hand).quaternion.angleTo(attachedQ)).toBeGreaterThan(0.1);

        weapon.updateHold(true);
        expect(heldWeapon(hand).quaternion.angleTo(attachedQ)).toBeLessThan(1e-6);
    });

    it('leaves a block NPC\'s grip position alone — only skinned hands need seating', () => {
        const { host, character, hand } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        weapon.equip({ ...DEFAULT_NPC_MELEE_WEAPON, type: 'sword' });
        const attachedPosition = heldWeapon(hand).position.clone();

        poseFrame(character);
        weapon.updateHold(false);

        expect(heldWeapon(hand).position).toEqual(attachedPosition);
    });

    it('does nothing at all while unarmed', () => {
        const { host } = makeHost();
        const weapon = new NpcWeaponComponent(host);
        expect(() => weapon.updateHold(false)).not.toThrow();
    });
});

describe('NpcWeaponComponent — contact', () => {
    it('lands on a body standing at the distance the NPC decided to attack from', () => {
        // The failure this pins: a 1 m blade held at the hip cannot physically reach a
        // target 2.5 m away, so an honest blade-length test never connects and the NPC
        // swings through everyone. The sweep extends to the move's reach for exactly this.
        const { weapon, character } = armed();
        character.rotation.y = 0; // facing +Z
        poseFrame(character);
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 2.4));

        expect(weapon.sweep(target, 16, 2.5)).toBe(true);
        expect(hits).toEqual([16]);
    });

    it('misses a body standing beyond the reach it was given', () => {
        const { weapon, character } = armed();
        poseFrame(character);
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 8));

        expect(weapon.sweep(target, 16, 2.5)).toBe(false);
        expect(hits).toHaveLength(0);
    });

    it('follows the blade, so a swing thrown away from the target misses', () => {
        // The whole point of arming an NPC rather than applying damage by proximity.
        const { weapon, character, hand } = armed();
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 2.0));

        // A further half-turn about X points the blade back along -Z; the target is at +Z.
        hand.rotation.x = Math.PI;
        poseFrame(character);

        expect(weapon.sweep(target, 16, 2.5)).toBe(false);
        expect(hits).toHaveLength(0);
    });

    it('catches a body the blade stepped over between samples', () => {
        // A fast arc moves further than the target is wide; without sweeping the travel
        // since the previous sample the swing passes clean through.
        const { weapon, character, hand } = armed();
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 0));

        weapon.beginSwing();
        // Sample 1: the whole blade is 3 m to one side of the body.
        hand.position.x = -3;
        poseFrame(character);
        expect(weapon.sweep(target, 16, 1.0)).toBe(false);

        // Sample 2: it is 3 m to the OTHER side. Neither sampled blade line rests on the
        // body — only the travel between them crosses it.
        hand.position.x = 3;
        poseFrame(character);
        expect(weapon.sweep(target, 16, 1.0)).toBe(true);
        expect(hits).toEqual([16]);
    });

    it('forgets the previous swing, so the gap between attacks is not swept', () => {
        // Otherwise an NPC that swings, turns around and swings again would land a hit on
        // everything the blade passed while it was turning.
        const { weapon, character, hand } = armed();
        const { target, hits } = makeTarget(new THREE.Vector3(0, 0, 0));

        weapon.beginSwing();
        hand.position.x = -3;
        poseFrame(character);
        weapon.sweep(target, 16, 1.0);

        weapon.beginSwing();
        hand.position.x = 3;
        poseFrame(character);
        expect(weapon.sweep(target, 16, 1.0)).toBe(false);
        expect(hits).toHaveLength(0);
    });
});
