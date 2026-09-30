import * as THREE from 'three';
import { createWeaponMesh, isBuiltInWeapon, makeWeaponVisualOnly, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import { orientBladeYawFramed, alignBladeToArm, seatGripTowardFingers, BLADE_IDLE_FORWARD } from 'engine/MeleeWeaponOrientation.js';
import { segmentHitsTarget, type NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';

/**
 * NpcWeaponComponent - the weapon in an NPC's hand, and the contact it makes.
 *
 * An NPC holding a sword used to be three unrelated things: a cosmetic mesh some behavior
 * parented to a hand, an animation pack that behavior may or may not have loaded, and a
 * blade sweep it was expected to hand-roll (copied out of `EXAMPLE_MeleeNpcBehavior`).
 * Skip any one of the three and you get the failure this component exists to remove — an
 * NPC that throws punches while holding a sword, or swings one that passes through people.
 *
 * So the ENGINE holds the weapon: `NpcController.equipMeleeWeapon()` creates it, attaches
 * it, keeps it oriented in the hand each frame, and — because `NpcController` registers
 * contact for `type: 'attack'` moves whenever this component is armed — lands its hits.
 * Behaviors go back to deciding *when* to swing, which is all they ever should have owned.
 *
 * `NpcMeleeAttack` drives this for you via its `weapon` config; a behavior only touches it
 * directly when it drives its own attacks.
 *
 * NOT the path for a weapon a behavior sweeps itself (`EXAMPLE_MeleeNpcBehavior` and the
 * published games built from it). Those attach their mesh with `attachToBodyPart()`, which
 * leaves this component unarmed, so the engine stays out of their hit registration and
 * nothing double-hits.
 */

/** What arming an NPC needs to know. Fill gaps from `DEFAULT_NPC_MELEE_WEAPON`. */
export interface NpcMeleeWeaponOptions {
    /** Weapon id from `WeaponRegistry` — a built-in (`'sword'`, `'axe'`, …) or one a
     *  template registered. Unknown ids fall back to the sword, as they do for the player. */
    type: WeaponTypeId;
    /** Uniform scale for the weapon mesh. The attach keeps the intended WORLD size, so
     *  this is about the weapon's proportions, not about the NPC's height. */
    scale: number;
    /** HP the target loses per landed swing. */
    damage: number;
    /** How far from the hilt a swing can connect (m) — see `sweep()` for why this is not
     *  simply the blade's length. */
    reach: number;
}

export const DEFAULT_NPC_MELEE_WEAPON: Readonly<Omit<NpcMeleeWeaponOptions, 'type'>> = {
    scale: 1.0,
    damage: 15,
    reach: 2.5,
};

/** The part of `NpcController` this component drives. */
export interface NpcWeaponHost {
    getCharacter(): THREE.Object3D;
    /** Resolved BEFORE the weapon mesh is built, so a retry against a character that is
     *  still loading costs a bone lookup rather than a discarded weapon. */
    getBodyPartObject(bodyPartName: string): THREE.Object3D | null;
    attachToBodyPart(object: THREE.Object3D, bodyPartName: string): boolean;
    detachFromBodyPart(object: THREE.Object3D): void;
    /** Skinned (Asset Forger) NPCs need the shared blade orientation each frame; the block
     *  character's hand frame is clean and holds the weapon correctly on its own. */
    isRenderingSkinnedMesh(): boolean;
}

/**
 * Hit geometry, inflated exactly as the player's blade is (`WeaponMeleeSystem`): the thin
 * visual blade let glancing swings slip past, so the HIT volume is fatter than the mesh.
 * Only detection is affected — the rendered weapon is untouched.
 */
const BLADE_RADIUS_SCALE = 1.5;
const MIN_HIT_RADIUS = 0.18;

/** How far past the hand-bone origin, along the live wrist→fingers direction, a skinned
 *  NPC's grip is seated — so the weapon comes out of the fist, not the wrist. */
const GRIP_TOWARD_FINGERS = 0.15;

const _hilt = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _direction = new THREE.Vector3();

export class NpcWeaponComponent {
    private mesh: THREE.Group | null = null;
    private options: NpcMeleeWeaponOptions | null = null;
    /** Hilt/tip in the mesh's own local frame, from the weapon preset. */
    private readonly hiltOffset = new THREE.Vector3();
    private readonly tipOffset = new THREE.Vector3();
    private bladeRadius = 0;
    private damageSource = 'npc_weapon';
    /** The held weapon's grip, which selects its swing set. */
    private grip: 'one' | 'two' = 'one';
    /** The local rotation the attach gave the weapon. A block NPC's swing animation drives
     *  its arm, so mid-swing the blade goes back to riding the hand from this baseline
     *  instead of being world-targeted out from under the clip. */
    private readonly naturalLocalQ = new THREE.Quaternion();

    /** Where the blade was at the previous sample of the CURRENT swing. `hasPrevious` is
     *  false for the first sample, when there is no travel to sweep yet. */
    private readonly prevHilt = new THREE.Vector3();
    private readonly prevTip = new THREE.Vector3();
    private hasPrevious = false;

    constructor(private readonly host: NpcWeaponHost) {}

    /**
     * Put a weapon in the NPC's right hand. Replaces whatever this component was holding;
     * a mesh some behavior attached itself is left alone (this component never knew about
     * it, and taking it would break the behavior that owns its sweep).
     *
     * Returns false when the hand could not be found, which is the one failure a caller
     * can do anything about — it means the character wasn't loaded yet.
     */
    equip(options: NpcMeleeWeaponOptions): boolean {
        // Checked before anything is built: equipping is retried while a character loads,
        // and each failed attempt would otherwise create and throw away a whole weapon.
        if (!this.host.getBodyPartObject('rightHand')) return false;

        this.unequip();

        const { mesh, config, preset } = createWeaponMesh(options.type);
        makeWeaponVisualOnly(mesh);
        // Marks this as a weapon for the melee sweep exclusion list — a swung sword must
        // not be a hit CANDIDATE for the swing that carries it (see MeleeSweepTargets).
        mesh.userData.isMeleeWeapon = true;
        mesh.userData.weaponType = options.type;
        mesh.scale.setScalar(options.scale);

        if (!this.host.attachToBodyPart(mesh, 'rightHand')) {
            disposeWeaponMesh(mesh, options.type);
            return false;
        }

        this.mesh = mesh;
        // Captured AFTER the attach, which is what applies the hand's rotation correction.
        this.naturalLocalQ.copy(mesh.quaternion);
        // Copied, not aliased: the equipped weapon is a snapshot, so a caller reusing one
        // options object across a squad cannot retune NPCs that are already armed.
        this.options = { ...options };
        this.hiltOffset.copy(config.hiltOffset);
        this.tipOffset.copy(config.tipOffset);
        this.bladeRadius = config.bladeRadius;
        this.grip = preset.grip ?? 'one';
        // Damage source names the weapon, so game code reacting to a hit can tell an axe
        // from a fist ('npc_strike') without inspecting the attacker.
        this.damageSource = `npc_${String(options.type).toLowerCase().trim()}`;
        this.hasPrevious = false;
        return true;
    }

    /** Remove the held weapon. Idempotent. */
    unequip(): void {
        if (this.mesh && this.options) {
            this.host.detachFromBodyPart(this.mesh);
            disposeWeaponMesh(this.mesh, this.options.type);
        }
        this.mesh = null;
        this.options = null;
        this.hasPrevious = false;
    }

    /** True once a weapon is held — the flag `NpcController` gates weapon contact on. */
    isArmed(): boolean {
        return this.mesh !== null;
    }

    /** The held weapon's tuning, or null when unarmed. */
    getOptions(): NpcMeleeWeaponOptions | null {
        return this.options;
    }

    /** How the held weapon is gripped — `weaponMovesFor()` turns this into its swing set.
     *  Meaningless while unarmed, where it reads as the one-handed default. */
    getGrip(): 'one' | 'two' {
        return this.grip;
    }

    /**
     * Keep the blade sitting correctly in the hand. Call once per frame AFTER the skeleton
     * is posed — it reads live bone transforms.
     *
     * A weapon rigidly parented to a hand inherits that hand's local frame, and that frame
     * is a Mixamo bone's — messy — for BOTH render modes: a block character's hand group
     * copies its rotation straight off `mixamorigRightHand` (see BlockCharacterRenderer's
     * bone mapping), so it is not the clean frame it looks like. Left alone, the arms-down
     * rest pose points the blade axis at the character's LEFT and the sword lies across the
     * body. So the blade is world-targeted here in every mode, exactly as the player's
     * `stabilizeWeaponMesh` does — that system hit this same bug and fixed it the same way.
     *
     * The one thing that differs by mode is what happens mid-swing: a skinned character's
     * forearm bone is available to align the blade along, while a block character's swing
     * clip already moves the whole arm, so its weapon goes back to riding the hand from the
     * attach-time baseline.
     */
    updateHold(isAttacking: boolean): void {
        const mesh = this.mesh;
        if (!mesh) return;
        const character = this.host.getCharacter();
        const skinned = this.host.isRenderingSkinnedMesh();

        if (!isAttacking) {
            orientBladeYawFramed(mesh, character, BLADE_IDLE_FORWARD);
        } else if (skinned) {
            // alignBladeToArm fails when the forearm bone isn't found — fall back to the
            // idle target rather than leaving the blade wherever the wrist put it.
            if (!alignBladeToArm(mesh, character)) {
                orientBladeYawFramed(mesh, character, BLADE_IDLE_FORWARD);
            }
        } else {
            // Block character mid-swing: the clip drives the arm, so the weapon follows
            // the hand from where the attach seated it.
            mesh.quaternion.copy(this.naturalLocalQ);
        }

        // Position, not rotation: a Mixamo hand bone's origin is the wrist, so a skinned
        // grip has to be pushed out toward the fingers or the blade floats off the wrist
        // and rides up the forearm. A block character's hand group is short and sits where
        // the fist is, so its attach-time position is already right.
        if (skinned) seatGripTowardFingers(mesh, GRIP_TOWARD_FINGERS);
    }

    /** Start of a swing: forget the previous swing's blade positions so the first sample
     *  of this one doesn't sweep across the gap since the last attack. */
    beginSwing(): void {
        this.hasPrevious = false;
    }

    /**
     * One contact sample of the swing in flight. True when it connected, which the caller
     * uses to stop sampling — one swing deals its damage once.
     *
     * The test is the blade LINE, hilt→tip, plus the travel of both ends since the previous
     * sample, so a fast swing can't step over a body between samples. Because it follows
     * the weapon, a swing thrown while facing away misses — which is the whole point of
     * arming an NPC rather than teleporting damage at it.
     *
     * The line is extended to at least `reach` because a swung weapon at character scale
     * does not otherwise reach as far as the behavior's decision to attack: a 1 m sword
     * held at the hip of a 1.3 m voxel fighter puts its tip ~1.6 m out, while the behavior
     * stopped and swung at `attackRange`. Same rule, and same reason, as the forward
     * projection on the unarmed limb (`NpcController.STRIKE_DEFAULT_REACH`).
     */
    sweep(target: NpcMeleeTarget, damage: number, reach: number): boolean {
        const mesh = this.mesh;
        if (!mesh) return false;

        // The bone this hangs off was posed this frame; recompose from it.
        mesh.updateMatrixWorld(true);
        mesh.localToWorld(_hilt.copy(this.hiltOffset));
        mesh.localToWorld(_tip.copy(this.tipOffset));

        _direction.subVectors(_tip, _hilt);
        const bladeLength = _direction.length();
        if (bladeLength > 1e-4) {
            _direction.divideScalar(bladeLength);
        } else {
            // Degenerate weapon geometry (a tip offset at the grip): swing along the
            // NPC's facing so the strike still has a direction. +Z forward, see
            // docs/coordinate-system.md.
            const yaw = this.host.getCharacter().rotation.y;
            _direction.set(Math.sin(yaw), 0, Math.cos(yaw));
        }
        _tip.copy(_direction).multiplyScalar(Math.max(bladeLength, reach)).add(_hilt);

        const hitRadius = Math.max(this.bladeRadius * BLADE_RADIUS_SCALE, MIN_HIT_RADIUS);
        let hit = segmentHitsTarget(_hilt, _tip, target, hitRadius);
        if (!hit && this.hasPrevious) {
            hit = segmentHitsTarget(this.prevTip, _tip, target, hitRadius)
                || segmentHitsTarget(this.prevHilt, _hilt, target, hitRadius);
        }

        // Store the EXTENDED tip: it is the point the next sample must sweep from, and
        // the un-extended one would leave a gap the length of the extension.
        this.prevHilt.copy(_hilt);
        this.prevTip.copy(_tip);
        this.hasPrevious = true;

        if (!hit) return false;
        target.takeDamage(damage, this.damageSource);
        return true;
    }
}

/**
 * Free a weapon's GPU resources — but only for a BUILT-IN weapon.
 *
 * The built-in creators allocate a fresh geometry and material per call, so this instance
 * owns them outright. A template's custom creator (`WeaponRegistry.register`) is code we
 * cannot reason about, and reusing one geometry/material across every instance is a normal
 * optimisation there: disposing those would blank out every other copy of that weapon in
 * the world, the player's included. Those are detached and left alone, which is exactly
 * what the player's own `unequipWeaponByType` does for every weapon.
 */
function disposeWeaponMesh(mesh: THREE.Object3D, type: WeaponTypeId): void {
    if (!isBuiltInWeapon(String(type).toLowerCase().trim())) return;
    mesh.traverse((child) => {
        const child3d = child as THREE.Mesh;
        if (!child3d.isMesh) return;
        child3d.geometry?.dispose();
        const material = child3d.material;
        if (Array.isArray(material)) material.forEach(m => m.dispose());
        else material?.dispose();
    });
}
