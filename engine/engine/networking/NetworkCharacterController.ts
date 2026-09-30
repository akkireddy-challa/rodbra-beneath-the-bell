// NetworkCharacterController: lightweight controller for remote (non-owner) characters.
// Loads full animated character (GLB skeleton + CharacterAnimationController + BlockCharacterRenderer)
// and drives animations from network state. Use for both remote players and remote NPCs.
//
// Local characters use PlayerController (player) or NpcController (NPC).
// Remote characters use NetworkCharacterController.
//
// USAGE:
//
//   // In onUnknownObject callback:
//   const remoteChar = await NetworkCharacterController.create({
//       engine: this.engine,
//       networkId,
//       initialState: state,
//       playerName: state.playerName ?? 'Player',
//       characterUrl: this.characterGlbUrl,
//       blockCharacterFactory: this.blockFactory,
//       baseAnimations: this.baseAnimations,
//   });
//   networkManager.registerObject(remoteChar.getNetworkObject());
//
//   // Every frame:
//   remoteChar.update(deltaTime);
//
//   // On player left:
//   remoteChar.dispose();

import * as THREE from 'three';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { getDefaultAnimationConfig } from 'engine/CharacterConfig.js';
import { createWeaponMesh, makeWeaponVisualOnly } from 'engine/WeaponRegistry.js';
import { createRangedWeaponMesh, makeRangedWeaponVisualOnly } from 'engine/RangedWeaponRegistry.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { createNameLabelSprite } from 'engine/networking/NetworkUtils.js';
import type { StateMessage, AnimationStateReceiver, WeaponStateReceiver } from 'engine/networking/NetworkTypes.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { EngineLike, BaseAnimationDefinition } from 'types/game.js';
import { loadCharacterModel } from 'engine/loaders/CharacterModelLoader.js';

/** Parameters for NetworkCharacterController.create() */
export interface NetworkCharacterCreateParams {
    /** Engine reference (for scene, loader) */
    engine: EngineLike;
    /** Network ID from the received StateMessage */
    networkId: string;
    /** Initial state message (position, rotation, speed, animation) */
    initialState: StateMessage;
    /** Display name for the floating name label */
    playerName: string;
    /** URL of the GLB character model */
    characterUrl: string;
    /** Factory for creating block character meshes */
    blockCharacterFactory: IBlockCharacterFactory;
    /** Animation definitions (idle, walk, run, jump, attack) */
    baseAnimations: BaseAnimationDefinition[];
    /** Additional animation packs to load after base setup (e.g. combat, weapon animations).
     *  Each entry is loaded via loadAnimationPack() with addToAttackCollection: true. */
    combatAnimations?: BaseAnimationDefinition[];
    /**
     * Game data assets array — enables custom animation playback on remote characters.
     * When a customAnimId arrives from the network, the receiver loads the animation
     * on demand from this list (same as `setGameDataProvider({ assets })` on the local side).
     *
     * Pass the same assets array used by the local game (e.g. from world.json).
     */
    gameAssets?: unknown[];
    /** Target character height in meters. Auto-detected from world.json if not provided. */
    targetHeight?: number;
    /**
     * When true, marks this as an NPC (used for tracking in MultiplayerSetup).
     * Does NOT affect physics or visuals — both players and NPCs use the same rendering pipeline.
     */
    isNpc?: boolean;
}

/**
 * Controller for remote (non-owner) networked characters.
 *
 * Encapsulates the full character visual pipeline:
 * - Hidden GLB skeleton driving animations via CharacterAnimationController
 * - BlockCharacterRenderer for visible block meshes
 * - NetworkObject for position/rotation/animation interpolation
 * - Floating name label sprite
 *
 * Extends CharacterLoader for skeleton loading, block character creation,
 * and per-frame block character positioning (including two-track blending).
 */
export class NetworkCharacterController extends CharacterLoader {
    private name: string = '';
    private networkId: string = '';
    private skeleton: THREE.Object3D | null = null;
    private rootGroup: THREE.Group = new THREE.Group();
    private nameLabel: THREE.Sprite | null = null;
    private networkObject: NetworkObject | null = null;
    private disposed: boolean = false;

    // Weapon state
    private weaponMesh: THREE.Group | null = null;
    private currentEquippedWeaponId: string | null = null;
    private weaponIsDual: boolean = false;
    private weaponHeightOffset: number = 0.2;
    private weaponXOffset: number = 0;
    private weaponForwardOffset: number = 0.55;

    private constructor(engine: EngineLike) {
        super(engine);
    }

    /**
     * Create a fully initialized remote character.
     * Loads GLB, creates animation controller + block character + NetworkObject + name label.
     */
    static async create(params: NetworkCharacterCreateParams): Promise<NetworkCharacterController> {
        const {
            engine, networkId, initialState, playerName,
            characterUrl, blockCharacterFactory, baseAnimations,
            combatAnimations, gameAssets,
        } = params;

        // Auto-detect character height from world.json (same source as PlayerLoader)
        // so remote characters match local player scale exactly
        let targetHeight = params.targetHeight ?? 1.75;
        if (!params.targetHeight) {
            const gameData = engine.getGameData?.();
            if (gameData) {
                const wpd = (gameData as Record<string, unknown>).worldProfileData as
                    { characterConfig?: { height?: number }; characterHeight?: number } | undefined;
                if (wpd) {
                    targetHeight = wpd.characterConfig?.height ?? wpd.characterHeight ?? 1.75;
                }
            }
        }

        const ctrl = new NetworkCharacterController(engine);
        ctrl.name = playerName;
        ctrl.networkId = networkId;

        // 1. Load the character model — a GLB or a rigged `.vxl`, routed by
        //    `loadCharacterModel`. A remote player still RENDERS as the block
        //    character (see the `skeleton.visible = false` below), so this only
        //    supplies the pose source; showing a voxel body for remote players is
        //    a separate change. Routing it regardless is what keeps a `.vxl`
        //    characterUrl from throwing a glTF parse error on every remote peer.
        const gltf = await loadCharacterModel(engine.loader, characterUrl) as any;
        const skeleton = gltf.scene;
        ctrl.skeleton = skeleton;

        // 2. Detect armature rotation for block character coordinate correction
        let armatureRotation: THREE.Quaternion | null = null;
        skeleton.traverse((child: THREE.Object3D) => {
            if (armatureRotation) return; // already found
            if (child.name.toLowerCase().includes('armature') ||
                child.name.toLowerCase().includes('deform') ||
                (child.type === 'Bone' && child.parent && !((child.parent as any).isBone))) {
                const armatureNode = (child.type === 'Bone') ? child.parent : child;
                if (armatureNode) {
                    armatureRotation = armatureNode.quaternion.clone();
                }
            }
        });

        // 3. Scale skeleton to target height (same approach as PlayerLoader.setupPlayerCharacter)
        // Measure actual bounding box height rather than using hardcoded constant,
        // so remote characters are exactly the same size as local characters.
        skeleton.updateMatrixWorld(true);
        const skeletonBox = new THREE.Box3().setFromObject(skeleton);
        const measuredHeight = skeletonBox.getSize(new THREE.Vector3()).y;
        if (measuredHeight > 0.01 && Math.abs(measuredHeight - targetHeight) > 0.01) {
            const scale = targetHeight / measuredHeight;
            skeleton.scale.multiplyScalar(scale);
        }

        // 4. Hide skeleton mesh (it's only an animation source)
        skeleton.visible = false;

        // 5. Create root group, position from initial state, add skeleton as child
        // No quaternion offset needed — both FP and TP cameras now produce correct
        // rotation.y values (FP camera applies +PI to compensate for model/camera mismatch).
        const rootGroup = ctrl.rootGroup;
        rootGroup.name = `NetworkCharacter_${playerName}`;
        rootGroup.position.set(
            initialState.position.x,
            initialState.position.y,
            initialState.position.z,
        );
        rootGroup.quaternion.set(
            initialState.quaternion.x, initialState.quaternion.y,
            initialState.quaternion.z, initialState.quaternion.w,
        );
        rootGroup.add(skeleton);
        if (engine.scene) {
            engine.scene.add(rootGroup);
        }
        ctrl.setCharacterGroup(rootGroup);

        // 6. Initialize animation controller (gameDataProvider auto-loads deferred Mixamo animations)
        const animConfig = getDefaultAnimationConfig();
        const animController = new CharacterAnimationController(animConfig);
        animController.setCharacterHeight(targetHeight);
        await animController.initializeWithCharacter(skeleton, gltf, engine.loader, baseAnimations, () => ({
            assets: gameAssets ?? [],
            scene: engine.scene,
        }));
        ctrl.setAnimationController(animController);

        // 7. Adjust skeleton position (feet at y=0)
        ctrl.adjustSkeletonPosition(skeleton);

        // 8. Create block character (adds to scene, computes capsule dimensions + feet offset)
        ctrl.createBlockCharacter(skeleton, blockCharacterFactory, armatureRotation);

        // 8d. Load combat/melee animation packs if provided.
        // These give the remote character attack animations so startAttack() has something to play.
        // Without them, attack state arrives from the network but the remote character has no
        // attack animations loaded and the attack is silently ignored.
        if (combatAnimations && combatAnimations.length > 0) {
            await animController.loadAnimationPack(combatAnimations, { addToAttackCollection: true });
        }

        // 9. Create AnimationStateReceiver
        // Track which custom animations we've attempted to load to avoid repeated retries.
        const customAnimLoadAttempted = new Set<string>();

        const animReceiver: AnimationStateReceiver = {
            applyAnimationState(animState: string, speed: number, attackId?: string, customAnimId?: string): void {
                if (attackId && !animController.getIsAttacking()) {
                    animController.startAttack();
                } else if (customAnimId) {
                    // Check if animation is already loaded
                    const available = animController.getAvailableCustomAnimations?.() ?? [];
                    if (available.includes(customAnimId)) {
                        animController.playCustomAnimation?.(customAnimId);
                    } else if (!customAnimLoadAttempted.has(customAnimId)) {
                        // Try to load on demand from game assets (fire-and-forget).
                        // The animation will play on the next network tick after loading.
                        customAnimLoadAttempted.add(customAnimId);
                        animController.loadCustomAnimation?.(customAnimId).then(() => {
                            animController.playCustomAnimation?.(customAnimId);
                        }).catch(() => {
                            // Animation not in assets — nothing we can do
                        });
                    }
                } else {
                    const isMoving = animState !== 'idle';
                    const isJumping = animState === 'jump';
                    animController.updateAnimation(isMoving, speed, !isJumping, isJumping);
                }
            },
        };

        // 10. Create WeaponStateReceiver
        const weaponReceiver: WeaponStateReceiver = {
            applyWeaponState(weaponId: string | null, aimYaw: number, aimPitch: number): void {
                ctrl.applyNetworkWeaponState(weaponId, aimYaw, aimPitch);
            },
        };

        // 11. Create NetworkObject (non-owner)
        const zeroVelocity = { x: 0, y: 0, z: 0 };
        const netObj = new NetworkObject(rootGroup, networkId, false, {
            velocityGetter: () => zeroVelocity,
            animationReceiver: animReceiver,
            weaponReceiver: weaponReceiver,
        });
        netObj.applyState(initialState);
        ctrl.networkObject = netObj;

        // 12. Create name label
        ctrl.nameLabel = createNameLabelSprite(playerName);
        if (engine.scene) {
            engine.scene.add(ctrl.nameLabel);
        }
        ctrl.nameLabel.position.copy(rootGroup.position);
        ctrl.nameLabel.position.y += ctrl.getCapsuleHeight() + 0.3;

        return ctrl;
    }

    /**
     * Advance animation and update block character visual. Call every frame.
     * Note: NetworkObject.updateInterpolation() is called automatically by NetworkManager.update().
     */
    update(deltaTime: number): void {
        if (this.disposed) return;

        // Advance animation mixer
        if (this.animController) {
            this.animController.update(deltaTime);
        }

        // Propagate interpolated position to skeleton bones
        this.rootGroup.updateMatrixWorld(true);

        // Update weapon position to follow animated shoulder (same as RangedWeaponSystem.updateWeaponHeight)
        this.updateWeaponPosition();

        // Update block character visual (inherited — reads bone transforms, positions block meshes)
        this.updateBlockCharacter(this.rootGroup.position);

        // Update name label position
        if (this.nameLabel) {
            this.nameLabel.position.copy(this.rootGroup.position);
            this.nameLabel.position.y += this.getCapsuleHeight() + 0.3;
        }
    }

    /** Clean up all resources. Call when the remote character disconnects. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        // Unequip weapon (clears arm overrides, removes mesh)
        this.unequipCurrentWeapon();

        // Destroy network object
        if (this.networkObject) {
            this.networkObject.destroy();
        }

        // Dispose animation controller
        if (this.animController) {
            this.animController.dispose();
        }

        // Remove block character from scene and dispose (inherited)
        const blockRoot = this.getBlockCharacterRenderer()?.getRoot();
        if (blockRoot && this.engine.scene) {
            this.engine.scene.remove(blockRoot);
        }
        super.dispose();

        // Remove root group from scene
        if (this.engine.scene) {
            this.engine.scene.remove(this.rootGroup);
        }

        // Dispose name label
        if (this.nameLabel) {
            if (this.engine.scene) {
                this.engine.scene.remove(this.nameLabel);
            }
            const mat = this.nameLabel.material as THREE.SpriteMaterial;
            mat.map?.dispose();
            mat.dispose();
            this.nameLabel = null;
        }

        // Dispose skeleton geometries + materials
        if (this.skeleton) {
            this.skeleton.traverse((child: THREE.Object3D) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    if (mesh.geometry) mesh.geometry.dispose();
                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    materials.forEach(m => m.dispose());
                }
            });
        }
    }

    /** Get the root Object3D (driven by NetworkObject interpolation) */
    getObject3D(): THREE.Object3D {
        return this.rootGroup;
    }

    /** Get the NetworkObject for registering with NetworkManager */
    getNetworkObject(): NetworkObject {
        return this.networkObject!;
    }

    /** Get the animation controller for advanced queries */
    getAnimationController(): CharacterAnimationController | null {
        return this.animController;
    }

    /** Get the display name */
    getName(): string {
        return this.name;
    }

    /** Show or hide the character (for death/respawn) */
    setVisible(visible: boolean): void {
        // Weapons are children of rootGroup, while the block mesh is separate.
        this.rootGroup.visible = visible;
        const blockRenderer = this.getBlockCharacterRenderer();
        if (blockRenderer) {
            blockRenderer.getRoot().visible = visible;
        }
        if (this.nameLabel) {
            this.nameLabel.visible = visible;
        }
    }

    /** Find a named child object in the block character hierarchy (e.g. 'rightHand', 'torso'). */
    getBodyPart(name: string): THREE.Object3D | null {
        return this.getBlockCharacterRenderer()?.getBodyPart(name) ?? null;
    }

    /** Recolor a named body part on the remote character. Returns true if the part was found. */
    tintBodyPart(name: string, color: number): boolean {
        return this.getBlockCharacterRenderer()?.tintBodyPart(name, color) ?? false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WEAPON SYNC
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Per-frame weapon position update — mirrors RangedWeaponSystem.updateWeaponHeight().
     * Reads shoulder position from block character body part (which has Mixamo blended
     * transforms applied) and repositions weapon mesh so the arm chain IK has a correct
     * target every frame.
     */
    private updateWeaponPosition(): void {
        if (!this.weaponMesh || !this.currentEquippedWeaponId?.startsWith('ranged:')) return;

        // Get shoulder from block character body part (same as local RangedWeaponSystem).
        // This is critical because the body part position includes Mixamo blend transforms,
        // whereas the raw skeleton bone does not — causing arm/weapon vertical mismatch.
        const blockRenderer = this.getBlockCharacterRenderer();
        if (!blockRenderer) return;
        const rightShoulder = blockRenderer.getBodyPart('rightUpperArm');
        if (!rightShoulder) return;

        rightShoulder.updateMatrixWorld(true);
        const shoulderWorldPos = new THREE.Vector3();
        rightShoulder.getWorldPosition(shoulderWorldPos);

        // Convert to rootGroup local space (same as RangedWeaponSystem.updateWeaponHeight)
        this.rootGroup.updateMatrixWorld(true);
        const rootWorldPos = new THREE.Vector3();
        this.rootGroup.getWorldPosition(rootWorldPos);
        const rootQuat = new THREE.Quaternion();
        this.rootGroup.getWorldQuaternion(rootQuat);

        const shoulderLocal = shoulderWorldPos.clone().sub(rootWorldPos);
        shoulderLocal.applyQuaternion(rootQuat.clone().invert());

        const xPos = this.weaponIsDual ? this.weaponXOffset : (shoulderLocal.x + this.weaponXOffset);
        const yPos = shoulderLocal.y + this.weaponHeightOffset;

        this.weaponMesh.position.set(xPos, yPos, this.weaponForwardOffset);
    }

    /**
     * Called by WeaponStateReceiver when weapon state arrives from network.
     * Handles equip/unequip and ranged weapon aim rotation.
     */
    private applyNetworkWeaponState(weaponId: string | null, aimYaw: number, aimPitch: number): void {
        if (this.disposed) return;

        // Equip/unequip if weapon changed
        if (weaponId !== this.currentEquippedWeaponId) {
            this.unequipCurrentWeapon();
            if (weaponId) {
                this.equipWeaponById(weaponId);
            }
            this.currentEquippedWeaponId = weaponId;
        }

        // Update aim rotation for ranged weapons
        if (this.weaponMesh && weaponId?.startsWith('ranged:')) {
            this.weaponMesh.rotation.order = 'YXZ';
            this.weaponMesh.rotation.y = aimYaw;
            this.weaponMesh.rotation.x = -aimPitch;
        }
    }

    /**
     * Equip a weapon by its network ID (format: "melee:<type>" or "ranged:<type>").
     */
    private equipWeaponById(weaponId: string): void {
        const colonIndex = weaponId.indexOf(':');
        if (colonIndex === -1) return;

        const category = weaponId.substring(0, colonIndex);
        const weaponType = weaponId.substring(colonIndex + 1);

        const blockRenderer = this.getBlockCharacterRenderer();
        if (!blockRenderer) return;

        if (category === 'melee') {
            this.equipMeleeWeapon(weaponType);
        } else if (category === 'ranged') {
            this.equipRangedWeapon(weaponType);
        }
    }

    /**
     * Equip a melee weapon on the remote character (attaches to right hand body part).
     */
    private equipMeleeWeapon(weaponType: string): void {
        const blockRenderer = this.getBlockCharacterRenderer();
        if (!blockRenderer) return;

        const { mesh } = createWeaponMesh(weaponType);
        makeWeaponVisualOnly(mesh);

        // Find right hand body part in block character
        const rightHand = blockRenderer.getBodyPart('rightHand');
        if (rightHand) {
            rightHand.add(mesh);
            // Default hand rotation: 90° X-axis (holds weapon upright, same as PlayerController default)
            mesh.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);
        }

        this.weaponMesh = mesh;
    }

    /**
     * Equip a ranged weapon on the remote character.
     * Replicates RangedWeaponSystem.equipWeapon() visual logic: creates weapon mesh,
     * positions at shoulder height, sets arm attachment overrides.
     *
     * NOTE: This mirrors RangedWeaponSystem.equipWeapon() (lines ~246-393) and must be
     * kept in sync if the local weapon positioning/attachment logic changes.
     */
    private equipRangedWeapon(weaponType: string): void {
        const blockRenderer = this.getBlockCharacterRenderer();
        if (!blockRenderer) return;

        const creationResult = createRangedWeaponMesh(weaponType);
        const { mesh, preset, grip = preset.gripOffset, foregrip, isDual, rightGrip, leftGrip } = creationResult;
        mesh.name = `NetworkWeapon_${weaponType}`;

        makeRangedWeaponVisualOnly(mesh);

        // Add to root group (same as local player adds to player root)
        this.rootGroup.add(mesh);

        // Scale weapon
        const scale = preset.weaponScale ?? new THREE.Vector3(3, 3, 1.5);
        mesh.scale.copy(scale);

        // Store preset values for per-frame updateWeaponPosition()
        this.weaponIsDual = isDual ?? false;
        this.weaponHeightOffset = preset.heightOffset ?? 0.2;
        this.weaponXOffset = preset.xOffset ?? 0;
        this.weaponForwardOffset = preset.forwardOffset ?? 0.55;

        // Set initial position (updateWeaponPosition() will correct per-frame)
        mesh.position.set(this.weaponXOffset, 1.0 + this.weaponHeightOffset, this.weaponForwardOffset);
        mesh.rotation.set(0, 0, 0);

        // Set arm attachment overrides (same logic as RangedWeaponSystem)
        if (isDual && rightGrip && leftGrip) {
            // Dual weapons: each hand attaches to its own weapon's grip
            const xScaleFactor = 1.3;

            const rightGripOffset = leftGrip.clone();
            rightGripOffset.x *= xScaleFactor;
            rightGripOffset.y *= scale.y;
            rightGripOffset.z *= scale.z;
            blockRenderer.setArmAttachmentOverride(
                'right',
                mesh,
                rightGripOffset,
                new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2),
            );

            const leftGripOffset = rightGrip.clone();
            leftGripOffset.x *= xScaleFactor;
            leftGripOffset.y *= scale.y;
            leftGripOffset.z *= scale.z;
            blockRenderer.setArmAttachmentOverride(
                'left',
                mesh,
                leftGripOffset,
                new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2),
            );
        } else {
            // Single weapon: standard grip attachment
            const rightGripOffset = grip.clone();
            rightGripOffset.x *= scale.x;
            rightGripOffset.y *= scale.y;
            rightGripOffset.z *= scale.z;
            rightGripOffset.y -= 0.08;
            rightGripOffset.x += 0.05;
            blockRenderer.setArmAttachmentOverride(
                'right',
                mesh,
                rightGripOffset,
                new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2),
            );

            // Two-handed: left hand grips foregrip
            if (preset.hands === 2 && foregrip) {
                const leftGripOffset = foregrip.clone();
                leftGripOffset.x *= scale.x;
                leftGripOffset.y *= scale.y;
                leftGripOffset.z *= scale.z;
                leftGripOffset.y -= 0.08;
                leftGripOffset.x -= 0.05;
                blockRenderer.setArmAttachmentOverride(
                    'left',
                    mesh,
                    leftGripOffset,
                    new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2),
                );
            }
        }

        this.weaponMesh = mesh;
    }

    /**
     * Unequip and dispose the current weapon mesh.
     * Clears arm attachment overrides and removes weapon from scene.
     */
    private unequipCurrentWeapon(): void {
        if (!this.weaponMesh) return;

        // Clear arm attachment overrides
        const blockRenderer = this.getBlockCharacterRenderer();
        if (blockRenderer) {
            blockRenderer.clearArmAttachmentOverride('right');
            blockRenderer.clearArmAttachmentOverride('left');
        }

        // Remove from parent
        this.weaponMesh.parent?.remove(this.weaponMesh);

        // Dispose geometries and materials
        this.weaponMesh.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const m = child as THREE.Mesh;
                if (m.geometry) m.geometry.dispose();
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                mats.forEach(mat => mat.dispose());
            }
        });

        this.weaponMesh = null;
        this.currentEquippedWeaponId = null;
    }

}
