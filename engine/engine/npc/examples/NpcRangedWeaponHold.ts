import * as THREE from 'three';
import type { createRangedWeaponMesh } from 'engine/RangedWeaponRegistry.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import {
    bringSkinnedDualWeaponsInward, createSkinnedRangedGrip,
    setRangedWeaponHoldUpdater, SKINNED_RANGED_HOLD,
} from 'engine/weapons/RangedWeaponGrip.js';

// Box hands attach by their palm centres and their short arms reach from the
// widened block shoulders. Keep their guns close enough for those visible limbs.
const BLOCK_RANGED_HOLD = {
    single: { drop: 0.24, inward: 0.08, forward: 0 },
    rifle: { drop: 0.18, inward: 0.28, forward: 0 },
    dual: { drop: 0.2, inward: 0, forward: 0 },
} as const;

/** NPC placement is measured in world metres, even when its model root is scaled. */
export class NpcRangedWeaponHold {
    private readonly scale: THREE.Vector3;
    private readonly shoulder = new THREE.Vector3();
    private readonly origin = new THREE.Vector3();
    private readonly rootScale = new THREE.Vector3();
    private readonly rootRotation = new THREE.Quaternion();
    private readonly corpseWeapons: THREE.Object3D[] = [];
    private nextLeftMuzzle = false;

    constructor(
        private readonly controller: NpcController,
        private readonly weapon: ReturnType<typeof createRangedWeaponMesh>,
        weaponScale: number,
    ) {
        const { mesh, preset, isDual, rightWeaponMesh, leftWeaponMesh, rightGrip, leftGrip,
            grip = preset.gripOffset, foregrip } = weapon;
        this.scale = (preset.weaponScale ?? new THREE.Vector3(3, 3, 1.5)).clone().multiplyScalar(weaponScale);
        controller.getCharacter().add(mesh);
        mesh.rotation.set(0, 0, 0);
        this.updatePlacement();

        const skinned = controller.isRenderingSkinnedMesh();
        const attach = (side: 'left' | 'right', point: THREE.Vector3, role: 'trigger' | 'support'): void => {
            if (skinned) {
                const grip = createSkinnedRangedGrip(mesh, side, point, this.scale, role);
                controller.setSkinnedArmGrip(side, mesh, grip.offset, grip.rotation);
            } else {
                // Block hands are centred on the palm; skinned joints are at the wrist.
                const offset = point.clone().multiply(this.scale);
                offset.y -= 0.08;
                offset.x += side === 'right' ? 0.05 : -0.05;
                controller.getBlockCharacterRenderer()!.setArmAttachmentOverride(side, mesh, offset,
                    new THREE.Euler(-Math.PI / 2, 0, side === 'right' ? Math.PI / 2 : -Math.PI / 2),
                    { followTargetHeight: true });
            }
        };
        if (isDual && rightGrip && leftGrip) {
            if (skinned && rightWeaponMesh && leftWeaponMesh) {
                bringSkinnedDualWeaponsInward(this.scale, rightWeaponMesh, leftWeaponMesh, rightGrip, leftGrip);
            }
            // Mesh names retain the historical +X "right" convention. Anatomy is -X right.
            attach('right', leftGrip, 'trigger');
            attach('left', rightGrip, 'trigger');
        } else {
            attach('right', grip, 'trigger');
            if (preset.hands === 2 && foregrip) attach('left', foregrip, 'support');
        }
        if (skinned) setRangedWeaponHoldUpdater(mesh, () => this.updatePlacement());
    }

    /** Runs after animation/grounding, before the registered skin grips are solved. */
    private updatePlacement(): void {
        const { mesh, preset, isDual } = this.weapon;
        const character = this.controller.getCharacter();
        const skinned = this.controller.isRenderingSkinnedMesh();
        character.updateWorldMatrix(true, false);
        character.getWorldPosition(this.origin);
        character.getWorldQuaternion(this.rootRotation);
        character.getWorldScale(this.rootScale);
        const bone = skinned ? this.controller.getBodyPartObject('rightUpperArm') : null;
        if (bone) bone.getWorldPosition(this.shoulder);
        else if (!this.controller.getBlockCharacterRenderer()?.getArmAttachmentShoulder('right', this.shoulder)) {
            this.shoulder.set(-0.2, this.controller.getCapsuleHeight() * 0.55, 0)
                .applyQuaternion(this.rootRotation).add(this.origin);
        }
        this.shoulder.sub(this.origin).applyQuaternion(this.rootRotation.invert());
        const hold = (skinned ? SKINNED_RANGED_HOLD : BLOCK_RANGED_HOLD)[isDual ? 'dual' : preset.hands === 2 ? 'rifle' : 'single'];
        const x = (isDual ? 0 : this.shoulder.x) + (preset.xOffset ?? 0) + hold.inward;
        const y = this.shoulder.y + (preset.heightOffset ?? 0.2) - hold.drop;
        const preferredForward = (preset.forwardOffset ?? 0.55) + hold.forward;
        const z = skinned ? preferredForward : Math.min(preferredForward, isDual ? 0.4 : 0.28);
        mesh.position.set(x, y, z).divide(this.rootScale);
        mesh.scale.copy(this.scale).divide(this.rootScale);
        mesh.updateWorldMatrix(false, false);
    }

    /** Block arms are refreshed after the visible body has completed its feet alignment. */
    onPoseUpdated(): void {
        if (this.controller.isRenderingSkinnedMesh()) return;
        this.updatePlacement();
        this.controller.getBlockCharacterRenderer()?.refreshArmAttachments();
    }

    /** Actual authored muzzle, including the equipped scale and each dual gun's placement. */
    getNextMuzzlePosition(target: THREE.Vector3): THREE.Vector3 {
        const { mesh, preset, isDual, leftWeaponMesh, rightWeaponMesh } = this.weapon;
        const muzzleRoot = isDual && leftWeaponMesh && rightWeaponMesh
            ? this.nextLeftMuzzle ? rightWeaponMesh : leftWeaponMesh : mesh;
        this.nextLeftMuzzle = !this.nextLeftMuzzle;
        return muzzleRoot.localToWorld(target.copy(preset.muzzleOffset));
    }

    /** Each dual gun follows its own corpse hand instead of both riding the right wrist. */
    attachToCorpseHands(): void {
        const { mesh, isDual, leftWeaponMesh, rightWeaponMesh } = this.weapon;
        const weapons: Array<['left' | 'right', THREE.Object3D]> = isDual && leftWeaponMesh && rightWeaponMesh
            ? [['right', leftWeaponMesh], ['left', rightWeaponMesh]] : [['right', mesh]];
        for (const [side, gun] of weapons) {
            const hand = this.controller.getBodyPartObject(`${side}Hand`);
            if (hand) hand.attach(gun);
            else {
                console.warn(`RangedNpcBehavior: missing ${side} hand at death; removing the held weapon`);
                gun.removeFromParent();
            }
            this.corpseWeapons.push(gun);
        }
        if (isDual && leftWeaponMesh && rightWeaponMesh) mesh.removeFromParent();
    }

    dispose(): void {
        for (const gun of this.corpseWeapons) gun.removeFromParent();
        this.corpseWeapons.length = 0;
    }
}
