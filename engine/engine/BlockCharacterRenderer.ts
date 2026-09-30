import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { captureRigBindPose } from 'engine/loaders/SkinnedRigRetarget.js';

/**
 * Game-wide block-character pose-convention version.
 *
 * - **v1 (default / legacy):** the torso group is positioned straight from the
 *   shoulder/spine basis, whose local **+Z points BACKWARD** (opposite the head,
 *   which the renderer flips 180°). Front details placed on the torso at +Z come
 *   out reversed, so v1 factories work around it by flipping the torso body mesh
 *   180° themselves (`torsoBodyMesh.rotation.y = Math.PI`). Hundreds of existing
 *   games rely on this — never change it.
 * - **v2:** the engine flips the torso group 180° so its local **+Z faces FRONT**,
 *   matching the head and the documented "+Z = front" convention. New games (whose
 *   templates set `worldProfileData.characterPoseVersion: 2`) place every body-part
 *   detail at +Z naturally — no per-mesh torso flip.
 *
 * Set once per game by `GameEngine.loadGame` from `worldProfileData.characterPoseVersion`
 * (absent ⇒ 1). It is game-wide: player, NPCs, and remote players all read it.
 */
let blockCharacterPoseVersion = 1;

/**
 * @internal Install the game-wide block-character pose version. Called by
 * `GameEngine.loadGame`; defaults to 1 (legacy) when world.json omits it.
 */
export function setBlockCharacterPoseVersion(version: number | undefined | null): void {
    blockCharacterPoseVersion = typeof version === 'number' && version >= 2 ? 2 : 1;
}

/** Shoulder bone-name candidates (Mixamo, simple, Unreal Manny) — the shoulder
 *  line is the basis for the torso, the neck and the limb width offset alike. */
const LEFT_SHOULDER_BONE_NAMES = ['mixamorigLeftShoulder', 'LeftShoulder', 'left_shoulder', 'Shoulder_L', 'shoulder_l', 'clavicle_l', 'Clavicle_L'];
const RIGHT_SHOULDER_BONE_NAMES = ['mixamorigRightShoulder', 'RightShoulder', 'right_shoulder', 'Shoulder_R', 'shoulder_r', 'clavicle_r', 'Clavicle_R'];

/** Body parts a pose override pins when `preserveFeet` is on. */
const FOOT_PART_NAMES = ['leftFoot', 'rightFoot'];

const ANKLE_BONE_NAMES = {
    left: ['mixamorigLeftFoot', 'LeftFoot', 'left_foot', 'Left_Foot', 'Foot_L', 'foot_l'],
    right: ['mixamorigRightFoot', 'RightFoot', 'right_foot', 'Right_Foot', 'Foot_R', 'foot_r'],
};

/** Source-pose facts, before block bounding-box grounding. Optional on update()
 * so direct renderer users retain the skeleton-driven path. */
export interface BlockFootPose {
    grounded: boolean;
    /** Explicit movement-system bindings retain their existing block alignment. */
    bound: boolean;
    /** Null for a directly animated GLTF, where rest-relative lift is measured here. */
    authoredFootLift: number | null;
    characterHeight: number;
    deltaSeconds: number;
    /** Source rest rotations, in its root frame (not a sampled idle/run pose). */
    restRotations: ReadonlyMap<string, THREE.Quaternion> | null;
}

interface BlockAnkle {
    bone: THREE.Bone;
    restPosition: THREE.Vector3;
    restRotation: THREE.Quaternion;
    rotation: THREE.Quaternion;
    position: THREE.Vector3;
    release: number | null;
}

/**
 * One owned body part's offset from the pose snapshot.
 *
 * Both fields are ABSOLUTE offsets from the captured base pose — never
 * accumulated onto the previous frame — so writing the same values every frame
 * reproduces exactly the same pose.
 */
export interface BlockPosePartOffset {
    /** Translation added to the captured local position, in the character root's frame. */
    position: THREE.Vector3;
    /** Rotation applied on top of the captured local rotation, in the character root's frame. */
    rotation: THREE.Quaternion;
}

/**
 * One arm laid out from its shoulder to a world point. Only the named side's
 * three groups are written, so the other arm keeps following the animation.
 */
export interface BlockPoseArmTarget {
    side: 'left' | 'right';
    /** World-space point the hand reaches. */
    position: THREE.Vector3;
    /** World-space orientation for the hand block. */
    rotation: THREE.Quaternion;
}

/**
 * Everything a pose override holds. The renderer keeps the object it is handed
 * BY REFERENCE, so the owner animates the pose by mutating these fields between
 * frames rather than re-installing (which would re-capture the base pose).
 */
export interface BlockPoseOverrideState {
    /** Owned body-part group name → absolute offset from the captured base pose. */
    parts: Map<string, BlockPosePartOffset>;
    /** 0 = pure animation, 1 = the override pose alone. */
    weight: number;
    /** Pin the captured foot transforms so a lean cannot drag the feet. */
    preserveFeet: boolean;
    /** Hold the root height captured on install — see `resolvePoseOverrideRootY`. */
    preserveRootHeight: boolean;
    /** Single-arm reach, or null to leave both arms to the animation. */
    armTarget: BlockPoseArmTarget | null;
}

/** A body-part group's transform as it stood when the pose override was installed. */
interface CapturedPart {
    group: THREE.Group;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    /**
     * False when nothing re-poses this group each frame (no bone binding, or it
     * was already detached from the animation). Such a group has no live
     * animated pose to blend against, so the override writes it outright
     * instead of lerping toward the target and creeping a little every frame.
     */
    animated: boolean;
}

/**
 * The body-part groups every block character is built from. The engine creates
 * one empty `THREE.Group` per name, the factory fills them with meshes, and each
 * group is bound to a skeleton bone (see `boneNamesForPart`).
 */
export const BLOCK_BODY_PART_NAMES = [
    'head', 'neck', 'torso',
    'leftUpperArm', 'leftForearm', 'leftHand',
    'rightUpperArm', 'rightForearm', 'rightHand',
    'leftThigh', 'leftShin', 'leftFoot',
    'rightThigh', 'rightShin', 'rightFoot'
] as const;

const STANDARD_PART_NAMES: ReadonlySet<string> = new Set(BLOCK_BODY_PART_NAMES);

/**
 * A pre-built set of block meshes for one look ("outfit"), recorded per body
 * part so it can be swapped in and out of a live renderer.
 *
 * A set holds only what a factory produced. Meshes the game attaches itself
 * (`getBodyPart('rightHand').add(gun)`) are never part of one, which is why they
 * survive a swap — see `applyMeshSet`.
 */
export interface BlockMeshSet {
    /** Body-part group name -> the objects this set contributed to that group. */
    readonly parts: Map<string, THREE.Object3D[]>;
    /** Top-level groups the factory added beyond the standard body parts. */
    readonly extraGroups: THREE.Group[];
}

/**
 * Block Character Renderer
 *
 * Reads bone transforms from an animated skeleton and positions block meshes to match.
 *
 * Architecture Pattern: Animated Skeleton + Block Overlay Renderer
 * ----------------------------------------------------------------
 * This class implements the "overlay renderer" part of the pattern:
 * 1. An animated skeleton (hidden mesh) provides bone transforms
 * 2. This renderer reads those transforms and positions block meshes
 * 3. The skeleton is never visible - it's just an animation source
 *
 * Benefits:
 * - Easy character switching (swap skeleton, blocks follow automatically)
 * - Realistic animations from professionally-made GLB files
 * - Customizable visual appearance (blocks, voxels, any geometry)
 */
export class BlockCharacterRenderer {
    private root: THREE.Group;
    private animatedSkeleton: THREE.Object3D;
    private bodyPartBindings: BodyPartBinding[];
    private boneMap: Map<string, THREE.Bone> = new Map();
    private readonly ankles: BlockAnkle[] = [];
    private coordinateCorrection: THREE.Quaternion | null = null;
    private cachedTorsoRotation: THREE.Quaternion | null = null;
    /** When set, the head faces this fixed world yaw instead of following the
     *  torso (e.g. a snowboarder looking down the hill while the torso is wound
     *  across the body). null = follow the torso. */
    private headWorldYaw: number | null = null;

    // Model's forward direction in local space (default -Z for Three.js convention,
    // +Z for models using atan2(x,z) movement convention like NPC/UE models)
    private modelForward: THREE.Vector3 = new THREE.Vector3(0, 0, -1);
    
    // Body parts detached from animation (e.g., hands holding guns)
    private detachedBodyParts: Set<string> = new Set();
    
    // Bone transform overrides - when set, these world transforms are used instead of reading from bones
    // This is used for blending: we blend bone transforms externally, then set them here
    private boneTransformOverrides: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> | null = null;
    
    // Attachment overrides - body parts that should attach to external objects (e.g., gun grip)
    private attachmentOverrides: Map<string, AttachmentOverride> = new Map();

    // The meshes this renderer was built with, and the set currently in the body
    // part groups. Swapping between sets is how a character changes clothes:
    // the groups (and therefore the bone bindings and the pose) never move.
    private originalMeshSet: BlockMeshSet;
    private appliedMeshSet: BlockMeshSet;

    // Body-part names already reported as unbindable, so a mesh-set swap does not
    // re-print the same warning on every change of clothes.
    private warnedUnboundParts: Set<string> = new Set();

    // Held pose (a seated NPC leaning, one hand raised): the state its owner
    // mutates, the base pose captured once, and the root height it holds.
    private poseOverride: BlockPoseOverrideState | null = null;
    private poseSnapshot: Map<string, CapturedPart> | null = null;
    /** Arm-chain groups captured on first reach, restored on release. Kept out of
     *  `poseSnapshot` so clearing the hand target hands the arm back to the
     *  animation instead of pinning it to the capture. */
    private poseArmSnapshot: Map<string, CapturedPart> | null = null;
    private poseRootOffsetY: number | null = null;
    
    // Reusable 180° rotation about Y. Used wherever a backward bone-basis must be
    // turned to face front: the head and neck flips, and the pose-v2 torso correction.
    // `multiply()` only reads it, so sharing this immutable constant is safe.
    private static readonly FLIP_Y_180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    // Hard-coded foot rotation values (60° X-axis offset for both feet)
    public static footRotationTuning = {
        baseY: 0,          // Base Y-axis rotation (shared, for fixing block orientation)
        leftX: 60,         // Left foot X-axis tilt
        leftY: 0,          // Left foot Y-axis rotation
        leftZ: 0,          // Left foot Z-axis rotation
        rightX: 60,        // Right foot X-axis tilt
        rightY: 0,         // Right foot Y-axis rotation
        rightZ: 0          // Right foot Z-axis rotation
    };

    /**
     * Private constructor - use BlockCharacterRenderer.create() instead
     */
    private constructor(
        root: THREE.Group,
        animatedSkeleton: THREE.Object3D,
        meshSet: BlockMeshSet
    ) {
        this.root = root;
        this.animatedSkeleton = animatedSkeleton;
        this.bodyPartBindings = [];
        this.originalMeshSet = meshSet;
        this.appliedMeshSet = meshSet;

        // Build fast bone lookup map
        this.animatedSkeleton.traverse((child) => {
            const bone = child as THREE.Bone;
            if (bone.isBone) {
                this.boneMap.set(bone.name, bone);
            }
        });

        this.rebuildBindings();
        this.captureAnkleRestPose();
    }

    /**
     * Factory method to create a block character renderer
     *
     * @param animatedSkeleton - The skeleton that will drive animations (typically a hidden GLB mesh)
     * @param factory - Template-provided factory to create block meshes
     * @returns Configured BlockCharacterRenderer instance
     */
    static create(
        animatedSkeleton: THREE.Object3D,
        factory: IBlockCharacterFactory
    ): BlockCharacterRenderer {
        const characterGroup = BlockCharacterRenderer.buildPartGroups();

        // Let template factory populate groups with meshes
        factory.createBlockCharacter(characterGroup);
        BlockCharacterRenderer.applyZFightOffsets(characterGroup);

        return new BlockCharacterRenderer(
            characterGroup,
            animatedSkeleton,
            BlockCharacterRenderer.captureMeshSet(characterGroup)
        );
    }

    /**
     * Build the character root with one empty group per standard body part —
     * the shape `IBlockCharacterFactory.createBlockCharacter()` expects.
     */
    private static buildPartGroups(): THREE.Group {
        const characterGroup = new THREE.Group();
        characterGroup.name = 'BlockCharacter';

        BLOCK_BODY_PART_NAMES.forEach(partName => {
            const partGroup = new THREE.Group();
            partGroup.name = partName;
            characterGroup.add(partGroup);
        });

        return characterGroup;
    }

    /**
     * Apply an incremental scale offset to every mesh to prevent z-fighting
     * between overlapping blocks (skull vs hair, torso vs shirt, etc.).
     * Done here so it covers both NpcCustomization and custom template characters.
     */
    private static applyZFightOffsets(group: THREE.Group): void {
        let zFightCounter = 0;
        group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const offset = 1.0 + zFightCounter * 0.001;
                child.scale.set(offset, offset, offset);
                zFightCounter++;
            }
        });
    }

    /**
     * Record what a factory put into a freshly built character group, so the
     * meshes can later be removed and re-added as one unit.
     */
    private static captureMeshSet(characterGroup: THREE.Group): BlockMeshSet {
        const parts = new Map<string, THREE.Object3D[]>();
        const extraGroups: THREE.Group[] = [];

        for (const child of characterGroup.children) {
            if (STANDARD_PART_NAMES.has(child.name)) {
                parts.set(child.name, [...child.children]);
            } else if (child instanceof THREE.Group) {
                // Factories may add their own top-level groups (e.g. animal block
                // characters). They belong to the set and bind like any other.
                extraGroups.push(child);
            }
        }

        return { parts, extraGroups };
    }

    /**
     * Get the root group containing all block meshes
     */
    getRoot(): THREE.Group {
        return this.root;
    }

    /**
     * Find a named child object in the block character hierarchy.
     * Useful for attaching meshes (hats, accessories) to a specific body part.
     */
    getBodyPart(name: string): THREE.Object3D | null {
        return this.root.getObjectByName(name) ?? null;
    }

    /**
     * Recolor every mesh under a named body part by cloning materials and setting their color.
     * Returns true if the body part was found, false otherwise.
     */
    tintBodyPart(name: string, color: number): boolean {
        const part = this.getBodyPart(name);
        if (!part) return false;
        part.traverse(child => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.material) return;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const cloned = mats.map(m => {
                const c = (m as THREE.Material).clone() as THREE.MeshStandardMaterial;
                // clone() copies userData — drop the shared-cache flag so this
                // per-NPC clone is disposed normally on teardown.
                delete c.userData.__sharedLodCache;
                if ('color' in c) (c.color as THREE.Color).setHex(color);
                return c;
            });
            mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
        });
        return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Mesh sets — changing a character's clothes without touching its skeleton
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Build a second look from another factory, detached from the scene.
     *
     * The set is inert until `applyMeshSet()` installs it. Callers that need the
     * engine's material/layer treatment (the loaders do) must run it over the
     * set's objects — `forEachMeshSetObject()` — before applying.
     */
    buildMeshSet(factory: IBlockCharacterFactory): BlockMeshSet {
        const scratch = BlockCharacterRenderer.buildPartGroups();
        factory.createBlockCharacter(scratch);
        BlockCharacterRenderer.applyZFightOffsets(scratch);
        return BlockCharacterRenderer.captureMeshSet(scratch);
    }

    /**
     * Swap the character's meshes for another set's.
     *
     * Only the CHILDREN of the body-part groups change; the groups themselves —
     * and therefore the bone bindings and the transforms the last pose wrote —
     * stay exactly as they are. Two consequences worth relying on:
     *   1. the new look is already posed on the frame it appears (no bind-pose flash);
     *   2. anything the game attached to a body part itself (a weapon in a hand,
     *      a hat on the head) is not part of any set, so it stays put.
     */
    applyMeshSet(set: BlockMeshSet): void {
        if (set === this.appliedMeshSet) return;

        for (const [partName, objects] of this.appliedMeshSet.parts) {
            const group = this.getPartGroup(partName);
            if (group && objects.length > 0) group.remove(...objects);
        }
        for (const extra of this.appliedMeshSet.extraGroups) {
            this.root.remove(extra);
        }

        for (const [partName, objects] of set.parts) {
            const group = this.getPartGroup(partName);
            if (group && objects.length > 0) group.add(...objects);
        }
        for (const extra of set.extraGroups) {
            this.root.add(extra);
        }

        this.appliedMeshSet = set;
        // A set may carry its own top-level groups, which bind like body parts.
        this.rebuildBindings();
    }

    /** The set this renderer was created with — pass it to `applyMeshSet()` to undress back to the original look. */
    getOriginalMeshSet(): BlockMeshSet {
        return this.originalMeshSet;
    }

    /** The set currently installed in the body-part groups. */
    getAppliedMeshSet(): BlockMeshSet {
        return this.appliedMeshSet;
    }

    /**
     * Release a set's geometry and materials. Shared-cache materials
     * (`userData.__sharedLodCache`) are owned by the cache, not by the mesh, and
     * are left alone. Refuses to dispose the set that is currently worn.
     */
    disposeMeshSet(set: BlockMeshSet): void {
        if (set === this.appliedMeshSet) {
            console.warn('[BlockCharacterRenderer] Refusing to dispose the mesh set that is currently applied — apply another set first.');
            return;
        }
        BlockCharacterRenderer.forEachMeshSetObject(set, obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            // Cache-owned geometry (getSharedBoxGeometry) is disposed centrally by
            // clearBlockPartCaches(), same rule the material loop below follows.
            if (mesh.geometry && !mesh.geometry.userData.__sharedLodCache) {
                mesh.geometry.dispose();
            }
            const materials = Array.isArray(mesh.material)
                ? mesh.material
                : (mesh.material ? [mesh.material] : []);
            for (const material of materials) {
                if (material.userData?.__sharedLodCache) continue;
                material.dispose();
            }
        });
    }

    /** Visit every object in a set, including nested children. */
    static forEachMeshSetObject(set: BlockMeshSet, callback: (object: THREE.Object3D) => void): void {
        for (const objects of set.parts.values()) {
            for (const object of objects) object.traverse(callback);
        }
        for (const extra of set.extraGroups) extra.traverse(callback);
    }

    /** Direct child group for a body-part name (the groups the bindings pose). */
    private getPartGroup(name: string): THREE.Group | null {
        for (const child of this.root.children) {
            if (child.name === name && child instanceof THREE.Group) return child;
        }
        return null;
    }

    /**
     * (Re)bind every top-level group to its skeleton bones. Runs at construction
     * and after a mesh-set swap, which can add or remove factory groups.
     */
    private rebuildBindings(): void {
        const bindings: BodyPartBinding[] = [];
        this.root.children.forEach(group => {
            if (group instanceof THREE.Group) {
                const possibleBoneNames = BlockCharacterRenderer.boneNamesForPart(group.name);
                const bones = BlockCharacterRenderer.findBonesInSkeleton(this.animatedSkeleton, possibleBoneNames);

                const firstBone = bones[0];
                if (firstBone) {
                    bindings.push({
                        group: group,
                        boneName: firstBone.name, // Use the actual found bone name
                        bones: bones
                    });
                } else if (!this.warnedUnboundParts.has(group.name)) {
                    this.warnedUnboundParts.add(group.name);
                    console.warn(`No bones found for body part: ${group.name} (tried: ${possibleBoneNames.join(', ')})`);
                }
            }
        });
        this.bodyPartBindings = bindings;
    }

    /**
     * Update block positions and rotations to match current skeleton pose
     * Call this every frame after skeleton animations have been updated
     * 
     * ⚠️ IMPORTANT: Only updates groups that have bone bindings.
     * Groups without bindings (e.g., animal block characters) are NOT rotated.
     * 
     * After normal skeleton-driven update, attachment overrides are applied
     * to reposition specific body parts (e.g., hands attached to gun grips).
     */
    // This renderer samples a finished pose; it does not advance animation time.
    // eslint-disable-next-line game-conventions/update-method-signature
    update(footPose?: BlockFootPose): void {
        // Ensure skeleton transforms are up-to-date.
        //
        // A pruned walk (bound bones + ancestors only) was tried and REVERTED:
        // composing matrixWorld by hand leaves three's matrixWorldNeedsUpdate
        // flag set, so the renderer's own scene-graph pass re-walks the same
        // bones and their subtrees anyway — the manual pass became extra work
        // rather than a replacement. Pruning is still worth doing (a Mixamo rig
        // is ~65 bones and a block character binds ~20), but it has to clear the
        // dirty flags and account for every other reader of those matrices
        // (leg IK, blended poses, attachment overrides, the melee proxy).
        this.animatedSkeleton.updateMatrixWorld(true);
        this.root.updateMatrixWorld(true);
        this.updateAnkleRotations(footPose);

        // Update each body part to match its bone(s)
        // ⚠️ CRITICAL: Only groups with bone bindings are updated.
        // Groups without bindings (like animal block characters) remain untouched.
        this.bodyPartBindings.forEach(binding => {
            this.updateBodyPart(binding);
        });
        
        // Apply attachment overrides AFTER normal skeleton update
        // This allows hands to be repositioned to gun grips without reparenting
        if (this.attachmentOverrides.size > 0) {
            this.applyAttachmentOverrides();
        }

        // Held pose LAST: it owns its parts outright, on top of both the
        // animation and any attachment override.
        if (this.poseOverride) {
            this.applyPoseOverride(this.poseOverride);
        }

        // Root group rotation is never modified - only child groups with bindings are rotated
    }

    /** Capture the direct GLTF path's reference once, before animation. Skins
     * carry immutable inverse binds; animation-only skeletons arrive at rest.
     * A composed Mixamo pose supplies its OWN rest rotations in update(). */
    private captureAnkleRestPose(): void {
        this.animatedSkeleton.updateWorldMatrix(true, true);
        const bind = captureRigBindPose(this.animatedSkeleton);
        const rootInverse = this.animatedSkeleton.getWorldQuaternion(new THREE.Quaternion()).invert();
        for (const names of Object.values(ANKLE_BONE_NAMES)) {
            const bone = this.findBoneByNames(names);
            if (!bone || /toe|ball/i.test(bone.name)) continue; // a toe is not an ankle pivot
            const position = bone.getWorldPosition(new THREE.Vector3());
            const restRotation = bind?.rotations.get(bone.name)?.clone()
                ?? bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInverse);
            const restPosition = this.animatedSkeleton.worldToLocal(position.clone());
            this.ankles.push({ bone, position, restPosition, restRotation, rotation: new THREE.Quaternion(), release: null });
        }
    }

    /** Explicit attachments, detached limbs and held poses outrank automatic clearance. */
    canGroundLeg(side: 'left' | 'right'): boolean {
        return !this.poseOverride && ['Thigh', 'Shin', 'Foot'].every(part =>
            !this.detachedBodyParts.has(`${side}${part}`) && !this.attachmentOverrides.has(`${side}${part}`));
    }

    /** The flat sole is only a near-contact correction. In swing, apply the
     * ankle's authored rotation DELTA to the legacy block-foot basis. Using a
     * shin direction loses the ankle joint; using a raw bone quaternion without
     * its rest correction introduces rig-dependent 60/90-degree shoe tilts.
     * All heights are source-world measurements, BEFORE block grounding, so
     * last frame's root correction cannot feed back into contact classification.
     * Smoothstep defines the contact band; a 55ms exponential response on its
     * strength prevents source height discontinuities snapping the ankle. The
     * authored quaternion itself is never time-filtered. Attachments/held poses
     * still run after this pass. */
    private updateAnkleRotations(pose?: BlockFootPose): void {
        if (!this.ankles.length) return;
        const characterQuat = this.animatedSkeleton.getWorldQuaternion(new THREE.Quaternion());
        const localFlat = this.flatFootRotation(this.modelForward, new THREE.Quaternion());
        const flatWorld = this.flatFootRotation(this.modelForward.clone().applyQuaternion(characterQuat), new THREE.Quaternion());
        let lowest = Infinity;
        let restLift = Infinity;
        for (const ankle of this.ankles) {
            this.getBoneWorldPosition(ankle.bone, ankle.position);
            lowest = Math.min(lowest, ankle.position.y);
            const restY = ankle.restPosition.clone().applyMatrix4(this.animatedSkeleton.matrixWorld).y;
            restLift = Math.min(restLift, ankle.position.y - restY);
        }
        const flight = pose?.authoredFootLift ?? Math.max(0, restLift);
        const height = pose?.characterHeight ?? 1.75;
        for (const ankle of this.ankles) {
            const lift = ankle.position.y - lowest + flight;
            const targetRelease = pose?.bound ? 0 : pose?.grounded === false ? 1
                : THREE.MathUtils.smoothstep(lift, height * .015, height * .065);
            const dt = Math.max(0, pose?.deltaSeconds ?? 1 / 60);
            // Explicit bindings are authoritative immediately; ordinary contact
            // changes blend in seconds, independent of render FPS.
            ankle.release = ankle.release === null || pose?.bound ? targetRelease
                : THREE.MathUtils.lerp(ankle.release, targetRelease, 1 - Math.exp(-dt / .055));
            const rest = pose?.restRotations?.get(ankle.bone.name) ?? ankle.restRotation;
            this.getBoneWorldQuaternion(ankle.bone, ankle.rotation);
            ankle.rotation.multiply(rest.clone().invert()).multiply(localFlat);
            ankle.rotation.slerp(flatWorld, 1 - ankle.release).normalize();
        }
    }

    /** Legacy foot-group basis: local Y is the heel direction, local Z is up.
     * Existing factories offset shoe meshes along -Y; do not change that basis. */
    private flatFootRotation(forward: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
        const heel = forward.clone().setY(0);
        if (heel.lengthSq() < 1e-8) heel.set(0, 0, -1);
        heel.normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(heel, up).normalize();
        return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, heel, up));
    }


    /**
     * Update a single body part to match its bone transform
     */
    private updateBodyPart(binding: BodyPartBinding): void {
        const { group, boneName, bones } = binding;

        // Skip detached body parts - they are controlled externally
        if (this.detachedBodyParts.has(group.name)) {
            return;
        }

        if (!bones || bones.length === 0) return;

        const position = new THREE.Vector3();
        const rotation = new THREE.Quaternion();

        // Special handling for torso - use shoulder line and spine direction
        // Check if this is a spine/torso bone (try multiple naming conventions)
        const spineNames = ['mixamorigspine', 'spine', 'spine1', 'spine_bone'];
        const lowerBoneName = boneName.toLowerCase();
        const isSpineBone = spineNames.some(name => lowerBoneName.includes(name));
        if (isSpineBone) {
            if (this.updateTorso(position, rotation)) {
                // Cache the RAW torso basis for the head & neck. Each applies its OWN
                // 180° Y flip to this (see the head branch below / updateNeck), which is
                // what makes them face +Z forward — so the cache must stay un-flipped or
                // the head/neck (and the ski "look downhill" headWorldYaw) would invert.
                this.cachedTorsoRotation = rotation.clone();
                // Pose v2: align the torso group with the head — flip it 180° so its local
                // +Z faces the character's FRONT, matching the documented "+Z = front"
                // convention. This is what lets new games place torso front details (chest
                // emblem, belly) at +Z and back details (a tail) at −Z without a per-mesh
                // flip. Pose v1 (legacy, the default) skips this and is byte-for-byte
                // unchanged, so existing games keep working.
                if (blockCharacterPoseVersion >= 2) {
                    rotation.multiply(BlockCharacterRenderer.FLIP_Y_180);
                }
                this.applyTransform(group, position, rotation);
                return;
            }
        }

        // Try joint-pair positioning for limbs (more accurate than single bone)
        const partName = group.name.toLowerCase();
        if (this.tryJointPairPositioning(partName, position, rotation)) {
            this.applyTransform(group, position, rotation);
            return;
        }

        // Special handling for neck - position it between torso and head
        if (partName.includes('neck')) {
            if (this.updateNeck(position, rotation)) {
                this.applyTransform(group, position, rotation);
                return;
            }
        }

        // Fallback: use single bone transform
        const bone = bones[0];
        if (!bone) {
            console.warn(`No bone found for body part: ${group.name}`);
            return;
        }

        bone.updateMatrixWorld(true);
        this.getBoneWorldPosition(bone, position);
        this.getBoneWorldQuaternion(bone, rotation);
        
        // Apply width offset for hands
        if (partName.includes('hand')) {
            this.applyTorsoWidthOffset(partName, position);
        }

        // Special handling for head - use torso rotation with 180° Y flip
        if (partName.includes('head') && this.cachedTorsoRotation) {
            // A controller can pin the head to a world yaw (look down the hill)
            // independent of the wound torso; otherwise it follows the torso.
            if (this.headWorldYaw !== null) {
                rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.headWorldYaw);
            } else {
                rotation.copy(this.cachedTorsoRotation);
            }
            // Apply 180° Y rotation to face forward instead of backward
            rotation.multiply(BlockCharacterRenderer.FLIP_Y_180);
        } else {
            // Apply coordinate correction before transform for other parts
            if (this.coordinateCorrection) {
                rotation.premultiply(this.coordinateCorrection);
            }
        }

        this.applyTransform(group, position, rotation);
    }

    /**
     * Find a bone by trying multiple possible names.
     */
    private findBoneByNames(possibleNames: string[]): THREE.Bone | null {
        // Try exact matches first
        for (const name of possibleNames) {
            const bone = this.boneMap.get(name);
            if (bone) return bone;
        }
        
        // Try case-insensitive partial matches
        const lowerNames = possibleNames.map(n => n.toLowerCase());
        for (const [boneName, bone] of this.boneMap) {
            const lowerBoneName = boneName.toLowerCase();
            for (const searchName of lowerNames) {
                if (lowerBoneName.includes(searchName) || searchName.includes(lowerBoneName)) {
                    return bone;
                }
            }
        }
        
        return null;
    }
    
    /**
     * Get world position for a bone, using override if available.
     * This is the single source of truth for bone positions - used by all update methods.
     */
    private getBoneWorldPosition(bone: THREE.Bone, target: THREE.Vector3): void {
        if (this.boneTransformOverrides) {
            const override = this.boneTransformOverrides.get(bone.name);
            if (override) {
                target.copy(override.position);
                return;
            }
        }
        bone.getWorldPosition(target);
    }
    
    /**
     * Get world rotation for a bone, using override if available.
     * This is the single source of truth for bone rotations - used by all update methods.
     */
    private getBoneWorldQuaternion(bone: THREE.Bone, target: THREE.Quaternion): void {
        if (this.boneTransformOverrides) {
            const override = this.boneTransformOverrides.get(bone.name);
            if (override) {
                target.copy(override.rotation);
                return;
            }
        }
        bone.getWorldQuaternion(target);
    }
    
    /**
     * Set bone transform overrides. When set, getBoneWorldPosition/Quaternion will
     * return these values instead of reading from the actual bones.
     * Pass null to clear overrides and read from bones directly.
     */
    setBoneTransformOverrides(overrides: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> | null): void {
        this.boneTransformOverrides = overrides;
    }

    /** Pin the head to a fixed world yaw (radians) instead of following the
     *  torso; null restores torso-following. */
    setHeadWorldYaw(yaw: number | null): void {
        this.headWorldYaw = yaw;
    }

    /**
     * Update neck position to sit directly between torso and head
     */
    private updateNeck(position: THREE.Vector3, rotation: THREE.Quaternion): boolean {
        // Find head bone for top connection point
        const head = this.findBoneByNames(['mixamorigHead', 'Head', 'head', 'head_bone', 'Head_Bone']);
        // Find shoulders to determine torso top
        const lShoulder = this.findBoneByNames(LEFT_SHOULDER_BONE_NAMES);
        const rShoulder = this.findBoneByNames(RIGHT_SHOULDER_BONE_NAMES);

        if (!head || !lShoulder || !rShoulder) return false;

        head.updateMatrixWorld(true);
        lShoulder.updateMatrixWorld(true);
        rShoulder.updateMatrixWorld(true);

        const headPos = new THREE.Vector3();
        const shoulderL = new THREE.Vector3();
        const shoulderR = new THREE.Vector3();

        this.getBoneWorldPosition(head, headPos);
        this.getBoneWorldPosition(lShoulder, shoulderL);
        this.getBoneWorldPosition(rShoulder, shoulderR);

        // Position neck between head (top) and shoulder line (bottom)
        const shoulderCenter = new THREE.Vector3().lerpVectors(shoulderL, shoulderR, 0.5);
        position.lerpVectors(shoulderCenter, headPos, 0.3);

        // Use cached torso rotation if available (neck should follow torso orientation)
        if (this.cachedTorsoRotation) {
            rotation.copy(this.cachedTorsoRotation);
            // Apply 180° Y rotation to face forward
            rotation.multiply(BlockCharacterRenderer.FLIP_Y_180);
        } else {
            // Fallback to neck bone rotation
            const neckBone = this.findBoneByNames(['mixamorigNeck', 'Neck', 'neck', 'neck_01', 'Neck_01']);
            if (neckBone) {
                this.getBoneWorldQuaternion(neckBone, rotation);
            }
        }

        return true;
    }

    /**
     * Update torso using shoulder line and spine for better orientation
     */
    private updateTorso(position: THREE.Vector3, rotation: THREE.Quaternion): boolean {
        // Shoulders - Mixamo and Unreal Manny (clavicle_l/r)
        const lShoulder = this.findBoneByNames(LEFT_SHOULDER_BONE_NAMES);
        const rShoulder = this.findBoneByNames(RIGHT_SHOULDER_BONE_NAMES);
        // Hips/Pelvis - Mixamo and Unreal Manny (pelvis)
        const hips = this.findBoneByNames(['mixamorigHips', 'Hips', 'hips', 'hip', 'Hip', 'Pelvis', 'pelvis', 'pelvis', 'Pelvis']);
        // Neck - Mixamo and Unreal Manny (neck_01, or spine_02/spine_03)
        const neck = this.findBoneByNames(['mixamorigNeck', 'Neck', 'neck', 'mixamorigSpine2', 'Spine2', 'spine2', 'neck_01', 'Neck_01', 'spine_02', 'spine_03', 'Spine_02', 'Spine_03']);

        if (!lShoulder || !rShoulder || !hips || !neck) return false;

        lShoulder.updateMatrixWorld(true);
        rShoulder.updateMatrixWorld(true);
        hips.updateMatrixWorld(true);
        neck.updateMatrixWorld(true);

        const pL = new THREE.Vector3();
        const pR = new THREE.Vector3();
        const pTop = new THREE.Vector3();
        const pBottom = new THREE.Vector3();

        this.getBoneWorldPosition(lShoulder, pL);
        this.getBoneWorldPosition(rShoulder, pR);
        this.getBoneWorldPosition(neck, pTop);
        this.getBoneWorldPosition(hips, pBottom);

        // Build orthonormal basis from shoulder line and spine
        const axisX = new THREE.Vector3().subVectors(pR, pL).normalize();
        const axisY = new THREE.Vector3().subVectors(pTop, pBottom).normalize();
        const axisZ = new THREE.Vector3().crossVectors(axisX, axisY).normalize();
        axisY.crossVectors(axisZ, axisX).normalize(); // Re-orthogonalize

        // Position: center slightly below neck
        const torsoHeight = 0.4;
        position.copy(pTop).add(axisY.clone().multiplyScalar(-torsoHeight * 0.5));

        // Build rotation from basis vectors
        const m = new THREE.Matrix4().makeBasis(axisX, axisY, axisZ);
        rotation.setFromRotationMatrix(m);

        return true;
    }

    /**
     * Try to position a limb using joint pair (more accurate than single bone)
     */
    private tryJointPairPositioning(
        partName: string,
        position: THREE.Vector3,
        rotation: THREE.Quaternion
    ): boolean {
        let boneA: THREE.Bone | null = null;
        let boneB: THREE.Bone | null = null;
        let referenceBone: THREE.Bone | null = null; // For feet: use shin bone as reference

        // Map body part names to bone pairs using flexible bone finding
        switch (partName) {
            case 'leftupperarm':
                boneA = this.findBoneByNames(['mixamorigLeftArm', 'LeftArm', 'left_arm', 'Left_Arm', 'Arm_L', 'arm_l', 'upperarm_l', 'UpperArm_L']);
                boneB = this.findBoneByNames(['mixamorigLeftForeArm', 'LeftForeArm', 'LeftForearm', 'left_forearm', 'Left_Forearm', 'ForeArm_L', 'forearm_l', 'lowerarm_l', 'LowerArm_L']);
                break;
            case 'rightupperarm':
                boneA = this.findBoneByNames(['mixamorigRightArm', 'RightArm', 'right_arm', 'Right_Arm', 'Arm_R', 'arm_r', 'upperarm_r', 'UpperArm_R']);
                boneB = this.findBoneByNames(['mixamorigRightForeArm', 'RightForeArm', 'RightForearm', 'right_forearm', 'Right_Forearm', 'ForeArm_R', 'forearm_r', 'lowerarm_r', 'LowerArm_R']);
                break;
            case 'leftforearm':
                boneA = this.findBoneByNames(['mixamorigLeftForeArm', 'LeftForeArm', 'LeftForearm', 'left_forearm', 'Left_Forearm', 'ForeArm_L', 'forearm_l', 'lowerarm_l', 'LowerArm_L']);
                boneB = this.findBoneByNames(['mixamorigLeftHand', 'LeftHand', 'left_hand', 'Left_Hand', 'Hand_L', 'hand_l', 'hand_l', 'Hand_L']);
                break;
            case 'rightforearm':
                boneA = this.findBoneByNames(['mixamorigRightForeArm', 'RightForeArm', 'RightForearm', 'right_forearm', 'Right_Forearm', 'ForeArm_R', 'forearm_r', 'lowerarm_r', 'LowerArm_R']);
                boneB = this.findBoneByNames(['mixamorigRightHand', 'RightHand', 'right_hand', 'Right_Hand', 'Hand_R', 'hand_r', 'hand_r', 'Hand_R']);
                break;
            case 'leftthigh':
                boneA = this.findBoneByNames(['mixamorigLeftUpLeg', 'LeftUpLeg', 'LeftThigh', 'left_thigh', 'Left_Thigh', 'Thigh_L', 'thigh_l', 'LeftLeg', 'left_leg', 'thigh_l', 'Thigh_L']);
                boneB = this.findBoneByNames(['mixamorigLeftLeg', 'LeftLeg', 'LeftShin', 'left_shin', 'Left_Shin', 'Shin_L', 'shin_l', 'LeftLowerLeg', 'left_lower_leg', 'calf_l', 'Calf_L']);
                break;
            case 'rightthigh':
                boneA = this.findBoneByNames(['mixamorigRightUpLeg', 'RightUpLeg', 'RightThigh', 'right_thigh', 'Right_Thigh', 'Thigh_R', 'thigh_r', 'RightLeg', 'right_leg', 'thigh_r', 'Thigh_R']);
                boneB = this.findBoneByNames(['mixamorigRightLeg', 'RightLeg', 'RightShin', 'right_shin', 'Right_Shin', 'Shin_R', 'shin_r', 'RightLowerLeg', 'right_lower_leg', 'calf_r', 'Calf_R']);
                break;
            case 'leftshin':
                boneA = this.findBoneByNames(['mixamorigLeftLeg', 'LeftLeg', 'LeftShin', 'left_shin', 'Left_Shin', 'Shin_L', 'shin_l', 'LeftLowerLeg', 'left_lower_leg', 'calf_l', 'Calf_L']);
                boneB = this.findBoneByNames(['mixamorigLeftFoot', 'mixamorigLeftToeBase', 'LeftFoot', 'LeftToeBase', 'left_foot', 'Left_Foot', 'Foot_L', 'foot_l', 'foot_l', 'Foot_L']);
                break;
            case 'rightshin':
                boneA = this.findBoneByNames(['mixamorigRightLeg', 'RightLeg', 'RightShin', 'right_shin', 'Right_Shin', 'Shin_R', 'shin_r', 'RightLowerLeg', 'right_lower_leg', 'calf_r', 'Calf_R']);
                boneB = this.findBoneByNames(['mixamorigRightFoot', 'mixamorigRightToeBase', 'RightFoot', 'RightToeBase', 'right_foot', 'Right_Foot', 'Foot_R', 'foot_r', 'foot_r', 'Foot_R']);
                break;
            case 'lefthand':
                // Hand: position at hand bone, orient using forearm
                boneA = this.findBoneByNames(['mixamorigLeftHand', 'LeftHand', 'left_hand', 'Left_Hand', 'Hand_L', 'hand_l']);
                boneB = null; // Hand is positioned at a single bone
                // Use forearm bone as reference for hand orientation
                referenceBone = this.findBoneByNames(['mixamorigLeftForeArm', 'LeftForeArm', 'LeftForearm', 'left_forearm', 'Left_Forearm', 'ForeArm_L', 'forearm_l', 'lowerarm_l', 'LowerArm_L']);
                break;
            case 'righthand':
                // Hand: position at hand bone, orient using forearm
                boneA = this.findBoneByNames(['mixamorigRightHand', 'RightHand', 'right_hand', 'Right_Hand', 'Hand_R', 'hand_r']);
                boneB = null; // Hand is positioned at a single bone
                // Use forearm bone as reference for hand orientation
                referenceBone = this.findBoneByNames(['mixamorigRightForeArm', 'RightForeArm', 'RightForearm', 'right_forearm', 'Right_Forearm', 'ForeArm_R', 'forearm_r', 'lowerarm_r', 'LowerArm_R']);
                break;
            case 'leftfoot':
                // Ankle pivot first; toe-only legacy rigs keep the flat fallback.
                boneA = this.findBoneByNames([...ANKLE_BONE_NAMES.left, 'mixamorigLeftToeBase', 'LeftToeBase']);
                boneB = null; // Foot is positioned at a single bone
                break;
            case 'rightfoot':
                boneA = this.findBoneByNames([...ANKLE_BONE_NAMES.right, 'mixamorigRightToeBase', 'RightToeBase']);
                boneB = null; // Foot is positioned at a single bone
                break;
            default:
                return false;
        }

        // For hands and feet, boneB can be null (single bone positioning with reference bone)
        if (!boneA) return false;
        if (!partName.includes('hand') && !partName.includes('foot') && !boneB) return false;

        boneA.updateMatrixWorld(true);
        if (boneB) {
            boneB.updateMatrixWorld(true);
        }

        const posA = new THREE.Vector3();
        this.getBoneWorldPosition(boneA, posA);

        // For feet (single bone), position at the foot bone
        if (!boneB) {
            position.copy(posA);
        } else {
            // For other limbs, position at midpoint between joints
            const posB = new THREE.Vector3();
            this.getBoneWorldPosition(boneB, posB);
            position.lerpVectors(posA, posB, 0.5);
        }
        
        // Apply width offset for entire limb chains based on torso size
        const isLeftArm = partName === 'leftupperarm' || partName === 'leftforearm' || partName === 'lefthand';
        const isRightArm = partName === 'rightupperarm' || partName === 'rightforearm' || partName === 'righthand';
        const isLeftLeg = partName === 'leftthigh' || partName === 'leftshin' || partName === 'leftfoot';
        const isRightLeg = partName === 'rightthigh' || partName === 'rightshin' || partName === 'rightfoot';
        
        if (isLeftArm || isRightArm || isLeftLeg || isRightLeg) {
            this.applyTorsoWidthOffset(partName, position);
        }
        
        // Special handling for hands
        if (partName.includes('hand') && referenceBone) {
            // Use the hand bone's own rotation, unmodified.
            //
            // Every other limb block is a long box, so it is built with its Y
            // along the bone. A hand is a small cube whose orientation barely
            // reads on its own — what it actually carries is the weapon, via the
            // attach correction that maps the weapon's blade onto this part's
            // local +Z. So the useful thing for a hand to do is report what the
            // animation says, not what the forearm implies.
            //
            // The earlier versions did the opposite. First the roll came from a
            // guess at how vertical the arm was, which twisted the weapon 90° in
            // the middle of a swing. Replacing that with the bone's roll was
            // closer but still forced Y along the arm, so the bone's blade axis
            // had to be projected onto the perpendicular plane — and a held blade
            // points roughly ALONG the arm, so that projection was almost pure
            // noise: 31 of 31 frames of a thrust, with the result swinging up to
            // 106° between frames. That is the "sword pivoting weirdly".
            //
            // Taking the bone rotation whole removes the constraint, the
            // projection, and the noise together. `bladeAim` then renders exactly
            // as authored, including straight down the arm for a thrust.
            this.getBoneWorldQuaternion(boneA, rotation);
        } else if (partName.includes('foot')) {
            const ankle = this.ankles.find(entry => entry.bone === boneA);
            if (ankle) rotation.copy(ankle.rotation);
            else this.flatFootRotation(this.modelForward.clone().applyQuaternion(
                this.animatedSkeleton.getWorldQuaternion(new THREE.Quaternion())), rotation);
        } else if (boneB) {
            // For limbs (arms, legs): align Y-axis to bone direction and constrain
            // the twist around the bone axis using the character's forward direction.
            // setFromUnitVectors alone doesn't constrain twist, causing visible
            // spinning artifacts on rectangular block parts.
            const posB = new THREE.Vector3();
            this.getBoneWorldPosition(boneB, posB);
            const boneDir = new THREE.Vector3().subVectors(posB, posA).normalize();

            const characterQuat = new THREE.Quaternion();
            this.animatedSkeleton.getWorldQuaternion(characterQuat);
            const charForward = this.modelForward.clone().applyQuaternion(characterQuat);

            // Build perpendicular axis from character forward projected onto the
            // plane perpendicular to boneDir
            let perp = new THREE.Vector3().crossVectors(boneDir, charForward);
            if (perp.lengthSq() < 0.001) {
                // boneDir parallel to charForward — use world up instead
                perp.crossVectors(boneDir, new THREE.Vector3(0, 1, 0));
            }
            perp.normalize();

            // Re-derive the third axis to ensure orthonormality
            const third = new THREE.Vector3().crossVectors(perp, boneDir).normalize();

            const m = new THREE.Matrix4().makeBasis(perp, boneDir, third);
            rotation.setFromRotationMatrix(m);
        } else {
            // Fallback: no rotation (identity)
            rotation.identity();
        }

        return true;
    }

    /**
     * Apply width offset for limbs based on torso size
     * Moves upper arms and thighs outward from centerline based on torso block width
     */
    private applyTorsoWidthOffset(partName: string, position: THREE.Vector3): void {
        // Find shoulder bones for direction vector
        const lShoulder = this.findBoneByNames(LEFT_SHOULDER_BONE_NAMES);
        const rShoulder = this.findBoneByNames(RIGHT_SHOULDER_BONE_NAMES);
        
        if (!lShoulder || !rShoulder) return;
        
        lShoulder.updateMatrixWorld(true);
        rShoulder.updateMatrixWorld(true);
        
        const shoulderL = new THREE.Vector3();
        const shoulderR = new THREE.Vector3();
        this.getBoneWorldPosition(lShoulder, shoulderL);
        this.getBoneWorldPosition(rShoulder, shoulderR);
        
        // Get right direction from shoulders
        const shoulderVector = new THREE.Vector3().subVectors(shoulderR, shoulderL);
        const rightDirection = shoulderVector.normalize();
        
        // Try to get actual torso mesh width
        const torsoGroup = this.root.getObjectByName('torso') as THREE.Group;
        let torsoWidth = shoulderVector.length(); // Fallback to shoulder distance
        
        if (torsoGroup) {
            // Find the widest mesh in torso group
            let maxWidth = 0;
            torsoGroup.traverse((child) => {
                if (child instanceof THREE.Mesh && child.geometry) {
                    child.geometry.computeBoundingBox();
                    const bbox = child.geometry.boundingBox;
                    if (bbox) {
                        const meshWidth = bbox.max.x - bbox.min.x;
                        if (meshWidth > maxWidth) {
                            maxWidth = meshWidth;
                        }
                    }
                }
            });
            if (maxWidth > 0) {
                torsoWidth = maxWidth;
            }
        }
        
        // Offset amount: 15% of actual torso block width
        const offsetAmount = torsoWidth * 0.15;
        
        // Apply offset based on which side (left or right)
        if (partName.startsWith('left')) {
            // Move all left limb parts further left
            position.add(rightDirection.clone().multiplyScalar(-offsetAmount));
        } else if (partName.startsWith('right')) {
            // Move all right limb parts further right
            position.add(rightDirection.clone().multiplyScalar(offsetAmount));
        }
    }

    /**
     * Apply transform to a body part group (world to local conversion).
     *
     * `weight` below 1 blends from whatever the group already holds (normally
     * this frame's animated pose) toward the given transform, which is how a
     * pose override fades in and out without a snap.
     */
    private applyTransform(
        group: THREE.Group,
        worldPosition: THREE.Vector3,
        worldRotation: THREE.Quaternion,
        weight: number = 1
    ): void {
        // Convert world position to local space
        const localPos = this.root.worldToLocal(worldPosition.clone());

        // Convert world rotation to local space (correction already applied by caller)
        const parentWorldQuat = new THREE.Quaternion();
        this.root.getWorldQuaternion(parentWorldQuat);
        const localQuat = worldRotation.clone().premultiply(parentWorldQuat.invert());

        if (weight >= 1) {
            group.position.copy(localPos);
            group.quaternion.copy(localQuat);
            return;
        }
        group.position.lerp(localPos, weight);
        group.quaternion.slerp(localQuat, weight);
    }

    /**
     * Skeleton bone-name candidates per body-part group name, across the naming
     * conventions the engine supports (Mixamo, simple, Unreal Manny).
     */
    private static readonly GROUP_BONE_NAMES: Record<string, string[]> = {
        // Head - Mixamo, simple, Unreal Manny
        head: ['mixamorigHead', 'Head', 'head', 'head_bone', 'Head_Bone'],
        // Neck - Mixamo, simple, Unreal Manny (neck_01)
        neck: ['mixamorigNeck', 'Neck', 'neck', 'neck_bone', 'Neck_Bone', 'neck_01', 'Neck_01'],
        // Torso/Spine - Mixamo, simple, Unreal Manny (spine_01, spine_02, spine_03)
        torso: ['mixamorigSpine', 'Spine', 'spine', 'spine_bone', 'Spine_Bone', 'mixamorigSpine1', 'Spine1', 'spine_01', 'spine_02', 'spine_03', 'Spine_01', 'Spine_02', 'Spine_03'],
        // Left Upper Arm - Mixamo, simple, Unreal Manny (upperarm_l)
        leftUpperArm: ['mixamorigLeftArm', 'LeftArm', 'left_arm', 'Left_Arm', 'Arm_L', 'arm_l', 'upperarm_l', 'UpperArm_L'],
        // Left Forearm - Mixamo, simple, Unreal Manny (lowerarm_l)
        leftForearm: ['mixamorigLeftForeArm', 'LeftForeArm', 'LeftForearm', 'left_forearm', 'Left_Forearm', 'ForeArm_L', 'forearm_l', 'lowerarm_l', 'LowerArm_L'],
        // Left Hand - Mixamo, simple, Unreal Manny (hand_l)
        leftHand: ['mixamorigLeftHand', 'LeftHand', 'left_hand', 'Left_Hand', 'Hand_L', 'hand_l'],
        // Right Upper Arm - Mixamo, simple, Unreal Manny (upperarm_r)
        rightUpperArm: ['mixamorigRightArm', 'RightArm', 'right_arm', 'Right_Arm', 'Arm_R', 'arm_r', 'upperarm_r', 'UpperArm_R'],
        // Right Forearm - Mixamo, simple, Unreal Manny (lowerarm_r)
        rightForearm: ['mixamorigRightForeArm', 'RightForeArm', 'RightForearm', 'right_forearm', 'Right_Forearm', 'ForeArm_R', 'forearm_r', 'lowerarm_r', 'LowerArm_R'],
        // Right Hand - Mixamo, simple, Unreal Manny (hand_r)
        rightHand: ['mixamorigRightHand', 'RightHand', 'right_hand', 'Right_Hand', 'Hand_R', 'hand_r'],
        // Left Thigh - Mixamo, simple, Unreal Manny (thigh_l)
        leftThigh: ['mixamorigLeftUpLeg', 'LeftUpLeg', 'LeftThigh', 'left_thigh', 'Left_Thigh', 'Thigh_L', 'thigh_l', 'LeftLeg', 'left_leg'],
        // Left Shin - Mixamo, simple, Unreal Manny (calf_l)
        leftShin: ['mixamorigLeftLeg', 'LeftLeg', 'LeftShin', 'left_shin', 'Left_Shin', 'Shin_L', 'shin_l', 'LeftLowerLeg', 'left_lower_leg', 'calf_l', 'Calf_L'],
        // Left Foot - Mixamo, simple, Unreal Manny (foot_l)
        leftFoot: ['mixamorigLeftToeBase', 'LeftToeBase', 'LeftFoot', 'left_foot', 'Left_Foot', 'Foot_L', 'foot_l', 'mixamorigLeftFoot'],
        // Right Thigh - Mixamo, simple, Unreal Manny (thigh_r)
        rightThigh: ['mixamorigRightUpLeg', 'RightUpLeg', 'RightThigh', 'right_thigh', 'Right_Thigh', 'Thigh_R', 'thigh_r', 'RightLeg', 'right_leg'],
        // Right Shin - Mixamo, simple, Unreal Manny (calf_r)
        rightShin: ['mixamorigRightLeg', 'RightLeg', 'RightShin', 'right_shin', 'Right_Shin', 'Shin_R', 'shin_r', 'RightLowerLeg', 'right_lower_leg', 'calf_r', 'Calf_R'],
        // Right Foot - Mixamo, simple, Unreal Manny (foot_r)
        rightFoot: ['mixamorigRightToeBase', 'RightToeBase', 'RightFoot', 'right_foot', 'Right_Foot', 'Foot_R', 'foot_r', 'mixamorigRightFoot']
    };

    /** Skeleton bone-name candidates for a body-part group name ('leftShin' ->
     *  ['mixamorigLeftLeg', ...]), falling back to the name itself for groups a
     *  factory added. Also used to resolve manual stance offsets to the right bone. */
    static boneNamesForPart(partName: string): string[] {
        return BlockCharacterRenderer.GROUP_BONE_NAMES[partName] || [partName];
    }

    /**
     * Find bones by name in a skeleton (tries exact match first, then case-insensitive partial match)
     */
    private static findBonesInSkeleton(skeleton: THREE.Object3D, boneNames: string[]): THREE.Bone[] {
        const foundBones: THREE.Bone[] = [];
        const boneMap = new Map<string, THREE.Bone>();
        const allBones: THREE.Bone[] = [];

        // Build bone map and list
        skeleton.traverse((child) => {
            const bone = child as THREE.Bone;
            if (bone.isBone) {
                boneMap.set(bone.name, bone);
                allBones.push(bone);
            }
        });

        // Try exact matches first
        for (const boneName of boneNames) {
            const bone = boneMap.get(boneName);
            if (bone && !foundBones.includes(bone)) {
                foundBones.push(bone);
            }
        }

        // If no exact matches, try case-insensitive partial matches
        if (foundBones.length === 0) {
            const lowerBoneNames = boneNames.map(name => name.toLowerCase());
            for (const bone of allBones) {
                const lowerBoneName = bone.name.toLowerCase();
                for (const searchName of lowerBoneNames) {
                    // Check if bone name contains the search name or vice versa
                    if (lowerBoneName.includes(searchName) || searchName.includes(lowerBoneName)) {
                        if (!foundBones.includes(bone)) {
                            foundBones.push(bone);
                        }
                    }
                }
            }
        }

        return foundBones;
    }

    /**
     * Set coordinate system correction quaternion (for models with armature rotation)
     */
    setCoordinateCorrection(correction: THREE.Quaternion): void {
        this.coordinateCorrection = correction.clone();
    }

    /**
     * Set the model's forward direction in local space.
     * Default is (0,0,-1) for standard Three.js convention.
     * Use (0,0,1) for models that face +Z (e.g., UE/NPC models using atan2(x,z) movement).
     */
    setModelForward(forward: THREE.Vector3): void {
        this.modelForward.copy(forward);
    }
    
    /**
     * Set an attachment override for a body part.
     * 
     * When set, the body part will be positioned relative to the target object
     * AFTER the normal skeleton-driven update runs. This is useful for attaching
     * hands to gun grips without reparenting (which can cause physics issues).
     * 
     * @param bodyPartName - Name of the body part (e.g., 'rightHand', 'leftHand')
     * @param target - The object to attach to (e.g., weapon mesh)
     * @param localPosition - Position offset relative to target
     * @param localRotation - Rotation offset relative to target
     */
    setAttachmentOverride(
        bodyPartName: string,
        target: THREE.Object3D,
        localPosition?: THREE.Vector3,
        localRotation?: THREE.Euler
    ): void {
        this.attachmentOverrides.set(bodyPartName, {
            target,
            localPosition: localPosition?.clone() || new THREE.Vector3(),
            localRotation: localRotation?.clone() || new THREE.Euler()
        });
        console.log(`🔧 BlockCharacterRenderer: Set attachment override for '${bodyPartName}'`);
    }

    /**
     * Set attachment override for an entire arm chain (upperArm → forearm → hand).
     * 
     * The arm will form a straight line from the shoulder to the target attachment point.
     * Each bone segment is positioned along this line proportionally.
     * 
     * @param side - 'left' or 'right'
     * @param target - The object to attach hand to (e.g., weapon grip)
     * @param localPosition - Position offset relative to target for hand placement
     * @param handRotation - Rotation for the hand at the grip
     * @param options - Opt into the exact target height and hand centre. Call
     * refreshArmAttachments after final grounding when moving the target with the posed body.
     */
    setArmAttachmentOverride(
        side: 'left' | 'right',
        target: THREE.Object3D,
        localPosition?: THREE.Vector3,
        handRotation?: THREE.Euler,
        options?: { followTargetHeight?: boolean },
    ): void {
        const upperArmName = `${side}UpperArm`;
        const forearmName = `${side}Forearm`;
        const handName = `${side}Hand`;

        // Store arm chain override info
        this.attachmentOverrides.set(`${side}ArmChain`, {
            target,
            localPosition: localPosition?.clone() || new THREE.Vector3(),
            localRotation: handRotation?.clone() || new THREE.Euler(),
            followTargetHeight: options?.followTargetHeight ?? false,
        });

        // Mark individual parts as part of arm chain (they'll be handled specially)
        this.attachmentOverrides.set(upperArmName, {
            target,
            localPosition: new THREE.Vector3(),
            localRotation: new THREE.Euler()
        });
        this.attachmentOverrides.set(forearmName, {
            target,
            localPosition: new THREE.Vector3(),
            localRotation: new THREE.Euler()
        });
        this.attachmentOverrides.set(handName, {
            target,
            localPosition: localPosition?.clone() || new THREE.Vector3(),
            localRotation: handRotation?.clone() || new THREE.Euler()
        });

        console.log(`🔧 BlockCharacterRenderer: Set arm chain override for '${side}' arm`);
    }

    /**
     * Clear attachment override for an entire arm chain
     */
    clearArmAttachmentOverride(side: 'left' | 'right'): void {
        this.attachmentShoulders.delete(side);
        this.attachmentOverrides.delete(`${side}ArmChain`);
        this.attachmentOverrides.delete(`${side}UpperArm`);
        this.attachmentOverrides.delete(`${side}Forearm`);
        this.attachmentOverrides.delete(`${side}Hand`);
        console.log(`🔧 BlockCharacterRenderer: Cleared arm chain override for '${side}' arm`);
    }

    /**
     * Clear an attachment override for a body part.
     * The body part will resume following skeleton animations normally.
     * 
     * @param bodyPartName - Name of the body part to clear override for
     */
    clearAttachmentOverride(bodyPartName: string): void {
        if (this.attachmentOverrides.delete(bodyPartName)) {
            console.log(`🔧 BlockCharacterRenderer: Cleared attachment override for '${bodyPartName}'`);
        }
    }

    /**
     * Clear all attachment overrides
     */
    clearAllAttachmentOverrides(): void {
        this.attachmentShoulders.clear();
        this.attachmentOverrides.clear();
        console.log(`🔧 BlockCharacterRenderer: Cleared all attachment overrides`);
    }

    /**
     * Apply attachment overrides after normal skeleton update.
     * Body parts with overrides get repositioned to follow their target objects.
     * Arm chains are handled specially - positioned in a straight line from shoulder to grip.
     */
    private applyAttachmentOverrides(): void {
        // First, handle arm chains (these override individual arm parts)
        if (this.attachmentOverrides.has('rightArmChain')) {
            this.applyArmChainOverride('right');
        }
        if (this.attachmentOverrides.has('leftArmChain')) {
            this.applyArmChainOverride('left');
        }

        // Then handle individual overrides (skip arm parts if they're part of a chain)
        this.attachmentOverrides.forEach((override, bodyPartName) => {
            // Skip arm chain markers and individual arm parts handled by chains
            if (bodyPartName.endsWith('ArmChain')) return;
            if (this.attachmentOverrides.has('rightArmChain') && 
                (bodyPartName === 'rightUpperArm' || bodyPartName === 'rightForearm' || bodyPartName === 'rightHand')) return;
            if (this.attachmentOverrides.has('leftArmChain') && 
                (bodyPartName === 'leftUpperArm' || bodyPartName === 'leftForearm' || bodyPartName === 'leftHand')) return;

            const group = this.root.getObjectByName(bodyPartName) as THREE.Group;
            if (!group || !override.target) return;

            // Get target world position/rotation
            override.target.updateMatrixWorld(true);
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            override.target.getWorldPosition(worldPos);
            override.target.getWorldQuaternion(worldQuat);

            // Apply local offset in target's coordinate space
            const offset = override.localPosition.clone().applyQuaternion(worldQuat);
            worldPos.add(offset);

            // Apply local rotation
            const localQuat = new THREE.Quaternion().setFromEuler(override.localRotation);
            worldQuat.multiply(localQuat);

            // Convert to local space and apply
            this.applyTransform(group, worldPos, worldQuat);
        });
    }

    /** Shoulder snapshots stay in block-root space so final feet alignment carries them too. */
    private readonly attachmentShoulders = new Map<'left' | 'right', THREE.Vector3>();

    /** Posed shoulder in world space, including the block body's final grounding shift. */
    getArmAttachmentShoulder(side: 'left' | 'right', target: THREE.Vector3): boolean {
        const local = this.attachmentShoulders.get(side);
        if (!local) return this.getArmStartWorldPosition(side, target);
        target.copy(local);
        this.root.localToWorld(target);
        return true;
    }

    /** Refresh exact-height weapon grips after their owner follows the completed body pose. */
    refreshArmAttachments(): void {
        for (const side of ['right', 'left'] as const) {
            if (this.attachmentOverrides.get(`${side}ArmChain`)?.followTargetHeight) {
                this.applyArmChainOverride(side, true);
            }
        }
    }

    private applyArmChainOverride(side: 'left' | 'right', afterGrounding = false): void {
        const chainOverride = this.attachmentOverrides.get(`${side}ArmChain`);
        if (!chainOverride || !chainOverride.target) return;

        const armStartPos = new THREE.Vector3();
        if (afterGrounding) {
            if (!this.getArmAttachmentShoulder(side, armStartPos)) return;
        } else {
            if (!this.getArmStartWorldPosition(side, armStartPos)) return;
            let local = this.attachmentShoulders.get(side);
            if (!local) { local = new THREE.Vector3(); this.attachmentShoulders.set(side, local); }
            local.copy(armStartPos);
            this.root.worldToLocal(local);
        }

        // Get grip (hand target) world position
        chainOverride.target.updateMatrixWorld(true);
        const gripPos = new THREE.Vector3();
        const gripQuat = new THREE.Quaternion();
        chainOverride.target.getWorldPosition(gripPos);
        chainOverride.target.getWorldQuaternion(gripQuat);

        // Apply local offset to get actual hand position
        const handOffset = chainOverride.localPosition.clone().applyQuaternion(gripQuat);
        const handPos = gripPos.clone().add(handOffset);

        // Keep the legacy shoulder-plane hold unless the owner refreshes an exact
        // grip target after grounding (ranged NPCs). Existing player/custom holds retain it.
        const gripHeightOffset = -0.08;
        if (!chainOverride.followTargetHeight) handPos.y = armStartPos.y + gripHeightOffset;

        // Hand gets the grip rotation (from weapon)
        const handQuat = gripQuat.clone();
        handQuat.multiply(new THREE.Quaternion().setFromEuler(chainOverride.localRotation));

        this.poseArmChain(side, armStartPos, handPos, handQuat, 1, chainOverride.followTargetHeight ?? false);
    }

    /**
     * World position an arm starts from: the upper-arm bone (NOT the
     * shoulder/clavicle), nudged outward from the spine so the chain leaves the
     * body instead of cutting through it. Returns false when the rig has no
     * upper-arm bone.
     */
    private getArmStartWorldPosition(side: 'left' | 'right', target: THREE.Vector3): boolean {
        const upperArmBoneNames = side === 'left'
            ? ['mixamorigLeftArm', 'LeftArm', 'left_arm', 'Left_Arm', 'Arm_L', 'arm_l', 'upperarm_l', 'UpperArm_L']
            : ['mixamorigRightArm', 'RightArm', 'right_arm', 'Right_Arm', 'Arm_R', 'arm_r', 'upperarm_r', 'UpperArm_R'];

        const upperArmBone = this.findBoneByNames(upperArmBoneNames);
        if (!upperArmBone) {
            console.warn(`BlockCharacterRenderer: Cannot find ${side} upper arm bone for arm chain`);
            return false;
        }

        // Use getBoneWorldPosition which applies Mixamo blend overrides when active.
        // Without this, the arm chain uses raw skeleton bone positions (possibly T-pose)
        // instead of the blended animation position, causing arm/weapon vertical mismatch.
        this.getBoneWorldPosition(upperArmBone, target);

        // Offset arm start point away from body center
        // Find spine/torso center to calculate outward direction
        const spineBone = this.findBoneByNames(['mixamorigSpine', 'Spine', 'spine', 'spine_01', 'Spine_01', 'spine_02']);
        if (spineBone) {
            const spinePos = new THREE.Vector3();
            this.getBoneWorldPosition(spineBone, spinePos);

            // Direction from spine to upper arm (outward from body)
            const outwardDir = new THREE.Vector3().subVectors(target, spinePos);
            outwardDir.y = 0; // Keep horizontal only
            outwardDir.normalize();

            // Offset by ~0.1 units outward from body
            const ARM_START_OFFSET = 0.1;
            target.add(outwardDir.multiplyScalar(ARM_START_OFFSET));
        }

        return true;
    }

    /**
     * Lay one arm out in a straight line from the shoulder to a world point and
     * write its three groups. Shared by the weapon-grip arm chain and the pose
     * override's single-hand reach — only this side is touched, so the other arm
     * keeps following the animation.
     */
    private poseArmChain(
        side: 'left' | 'right',
        armStartPos: THREE.Vector3,
        handPos: THREE.Vector3,
        handQuat: THREE.Quaternion,
        weight: number,
        exactHandPosition = false,
    ): void {
        const upperArmGroup = this.root.getObjectByName(`${side}UpperArm`) as THREE.Group;
        const forearmGroup = this.root.getObjectByName(`${side}Forearm`) as THREE.Group;
        const handGroup = this.root.getObjectByName(`${side}Hand`) as THREE.Group;

        if (!upperArmGroup || !forearmGroup || !handGroup) return;

        // Direction from upper arm start to hand
        const armDirection = new THREE.Vector3().subVectors(handPos, armStartPos).normalize();

        // Position each segment along the arm line (from upper arm bone to hand)
        // Proportions along the arm: upperArm at start, forearm in middle, hand at end
        const upperArmT = exactHandPosition ? 0.25 : 0.15;
        const forearmT = exactHandPosition ? 0.75 : 0.50;
        const handT = exactHandPosition ? 1 : 0.90;

        const upperArmPos = new THREE.Vector3().lerpVectors(armStartPos, handPos, upperArmT);
        const forearmPos = new THREE.Vector3().lerpVectors(armStartPos, handPos, forearmT);
        const handFinalPos = new THREE.Vector3().lerpVectors(armStartPos, handPos, handT);

        // Build rotation to point along arm direction
        // Y-axis = arm direction (bone typically extends along Y)
        const worldUp = new THREE.Vector3(0, 1, 0);
        let armRight = new THREE.Vector3().crossVectors(armDirection, worldUp);
        
        // Handle case where arm is pointing straight up/down
        if (armRight.lengthSq() < 0.01) {
            const characterQuat = new THREE.Quaternion();
            this.animatedSkeleton.getWorldQuaternion(characterQuat);
            const charForward = this.modelForward.clone().applyQuaternion(characterQuat);
            armRight = new THREE.Vector3().crossVectors(armDirection, charForward).normalize();
        } else {
            armRight.normalize();
        }
        
        const armUp = new THREE.Vector3().crossVectors(armRight, armDirection).normalize();
        
        // Build rotation matrix: arm extends along Y-axis
        const armRotMatrix = new THREE.Matrix4().makeBasis(armRight, armDirection, armUp);
        const armQuat = new THREE.Quaternion().setFromRotationMatrix(armRotMatrix);

        // Apply to upper arm and forearm (same rotation - straight line)
        this.applyTransform(upperArmGroup, upperArmPos, armQuat, weight);
        this.applyTransform(forearmGroup, forearmPos, armQuat, weight);

        // Hand keeps the caller's orientation (the weapon grip, or the pose's reach)
        this.applyTransform(handGroup, handFinalPos, handQuat, weight);
    }

    /**
     * Detach a body part from the animation system.
     * 
     * When detached, the body part will NOT be updated by the skeleton animation.
     * This is useful for weapons that need to keep hands fixed (e.g., guns).
     * 
     * The body part remains in the scene graph but its transform is controlled
     * externally (by whatever called this method).
     * 
     * @param bodyPartName - Name of the body part (e.g., 'leftHand', 'rightHand')
     */
    detachFromAnimation(bodyPartName: string): void {
        this.detachedBodyParts.add(bodyPartName);
        console.log(`🔧 BlockCharacterRenderer: Detached '${bodyPartName}' from animation`);
    }

    /**
     * Reattach a body part to the animation system.
     * 
     * The body part will resume following skeleton animations.
     * 
     * @param bodyPartName - Name of the body part to reattach
     */
    reattachToAnimation(bodyPartName: string): void {
        this.detachedBodyParts.delete(bodyPartName);
        console.log(`🔧 BlockCharacterRenderer: Reattached '${bodyPartName}' to animation`);
    }

    /**
     * Check if a body part is detached from animation
     */
    isDetachedFromAnimation(bodyPartName: string): boolean {
        return this.detachedBodyParts.has(bodyPartName);
    }

    /**
     * Get all detached body part names
     */
    getDetachedBodyParts(): string[] {
        return Array.from(this.detachedBodyParts);
    }

    /**
     * Install a held pose: named body parts held at absolute offsets from a base
     * pose captured ONCE, written after the animation every frame.
     *
     * This is the whole reason the low-level `detachFromAnimation` pair should
     * not be used to pose a character by hand. A detached part stops being
     * driven at all, so the caller inherits the animation's job — and the pose
     * ends up fighting it: offsets composed onto the previous frame drift into
     * an ever-deeper lean, a changed silhouette makes the feet-alignment sink
     * the body, and an arm posed one bone at a time leaves its partner dangling.
     * Here the base pose is fixed at install, so the same offset always produces
     * the same pose; `preserveRootHeight` pins the height (see
     * `resolvePoseOverrideRootY`); and `armTarget` reaches with exactly one arm.
     *
     * Parts are never detached — the animation still poses them each frame and
     * the override simply writes over the ones it owns — so releasing the pose
     * hands every part straight back with nothing left frozen.
     *
     * The `state` object is kept BY REFERENCE: mutate its fields to animate the
     * pose (fade `weight`, move the hand target). Calling this again restores
     * the previous pose first and re-captures the base pose.
     */
    setPoseOverride(state: BlockPoseOverrideState): void {
        this.clearPoseOverride();
        this.poseOverride = state;
    }

    /** True while a pose override is installed. */
    hasPoseOverride(): boolean {
        return this.poseOverride !== null;
    }

    /**
     * Release the held pose: every captured part goes back to the transform it
     * had when the pose was installed, and the animation owns it again from the
     * next `update()`.
     */
    clearPoseOverride(): void {
        if (!this.poseOverride) return;
        this.restoreCapturedParts(this.poseSnapshot);
        this.restoreCapturedParts(this.poseArmSnapshot);
        this.poseSnapshot = null;
        this.poseArmSnapshot = null;
        this.poseRootOffsetY = null;
        this.poseOverride = null;
    }

    /**
     * The root Y to use this frame while a pose override holds the character's
     * height, or null when the caller's ordinary feet-alignment should run.
     * `groundY` is the world height the feet-align would put the lowest block at.
     *
     * A lean or a raised arm changes the posed bounding box, so a feet-align
     * would shift the whole body to put the new lowest point back on the ground
     * — which reads as the character sinking (or growing) the moment it is
     * posed. Capturing the root's height above `groundY` once and re-asserting
     * it keeps a seated character exactly where it sat, while still following
     * the ground if it moves.
     */
    resolvePoseOverrideRootY(groundY: number): number | null {
        if (!this.poseOverride?.preserveRootHeight) return null;
        this.poseRootOffsetY ??= this.root.position.y - groundY;
        return groundY + this.poseRootOffsetY;
    }

    /**
     * Write the held pose over this frame's animated pose. Every target is
     * derived from the captured base pose, so running this twice on the same
     * frame — or every frame for a minute — produces the same transforms.
     */
    private applyPoseOverride(state: BlockPoseOverrideState): void {
        const snapshot = (this.poseSnapshot ??= this.capturePoseSnapshot(state));
        const weight = THREE.MathUtils.clamp(state.weight, 0, 1);
        if (weight <= 0) return;

        const targetPos = new THREE.Vector3();
        const targetQuat = new THREE.Quaternion();
        snapshot.forEach((captured, partName) => {
            const offset = state.parts.get(partName);
            targetPos.copy(captured.position);
            targetQuat.copy(captured.quaternion);
            if (offset) {
                targetPos.add(offset.position);
                targetQuat.premultiply(offset.rotation);
            }
            // A part with no live animated pose has nothing to blend against —
            // lerping toward the target from its own last value would creep.
            const partWeight = captured.animated ? weight : 1;
            captured.group.position.lerp(targetPos, partWeight);
            captured.group.quaternion.slerp(targetQuat, partWeight);
        });

        if (state.armTarget) {
            this.applyPoseArmTarget(state.armTarget, weight);
        }
    }

    /** Reach one arm to its world target, capturing it first so release can undo it. */
    private applyPoseArmTarget(armTarget: BlockPoseArmTarget, weight: number): void {
        const armStart = new THREE.Vector3();
        if (!this.getArmStartWorldPosition(armTarget.side, armStart)) return;

        const captured = (this.poseArmSnapshot ??= new Map<string, CapturedPart>());
        for (const suffix of ['UpperArm', 'Forearm', 'Hand']) {
            this.capturePart(captured, `${armTarget.side}${suffix}`);
        }

        this.poseArmChain(armTarget.side, armStart, armTarget.position, armTarget.rotation, weight);
    }

    /** Base pose for everything the override owns, all read on the same frame. */
    private capturePoseSnapshot(state: BlockPoseOverrideState): Map<string, CapturedPart> {
        const snapshot = new Map<string, CapturedPart>();
        state.parts.forEach((_offset, partName) => this.capturePart(snapshot, partName));
        if (state.preserveFeet) {
            for (const partName of FOOT_PART_NAMES) this.capturePart(snapshot, partName);
        }
        return snapshot;
    }

    /** Record one body part's current transform, unless it is already recorded. */
    private capturePart(snapshot: Map<string, CapturedPart>, partName: string): void {
        if (snapshot.has(partName)) return;
        const group = this.root.getObjectByName(partName);
        if (!(group instanceof THREE.Group)) {
            console.warn(`BlockCharacterRenderer: pose override names unknown body part '${partName}'`);
            return;
        }
        snapshot.set(partName, {
            group,
            position: group.position.clone(),
            quaternion: group.quaternion.clone(),
            animated: this.isAnimationDriven(partName),
        });
    }

    /** Whether the per-frame skeleton update re-poses this body part group. */
    private isAnimationDriven(partName: string): boolean {
        return !this.detachedBodyParts.has(partName)
            && this.bodyPartBindings.some(binding => binding.group.name === partName);
    }

    /** Put captured body parts back exactly as they were. */
    private restoreCapturedParts(snapshot: Map<string, CapturedPart> | null): void {
        if (!snapshot) return;
        snapshot.forEach(captured => {
            captured.group.position.copy(captured.position);
            captured.group.quaternion.copy(captured.quaternion);
        });
    }

    /**
     * Dispose of renderer resources
     */
    dispose(): void {
        // Release the held pose before the hierarchy goes away, so a handle that
        // outlives the renderer cannot restore parts that no longer exist.
        this.clearPoseOverride();
        // Remove all meshes from scene if needed by parent
        this.root.clear();
        this.bodyPartBindings = [];
        this.boneMap.clear();
        this.ankles.length = 0;
        this.detachedBodyParts.clear();
        this.attachmentOverrides.clear();
        // Drop the mesh-set bookkeeping too: the root no longer holds any of it,
        // and a stale "applied" set would block disposeMeshSet() on the caller's
        // own sets. Inactive sets are the caller's to dispose (they were never
        // in the scene graph).
        const empty: BlockMeshSet = { parts: new Map(), extraGroups: [] };
        this.originalMeshSet = empty;
        this.appliedMeshSet = empty;
        this.warnedUnboundParts.clear();
    }
}

/**
 * Internal binding between a body part group and skeleton bones
 */
interface BodyPartBinding {
    group: THREE.Group;
    boneName: string;
    bones: THREE.Bone[];
}

/**
 * Attachment override - makes a body part follow an external object (e.g., gun grip)
 */
interface AttachmentOverride {
    target: THREE.Object3D;
    localPosition: THREE.Vector3;
    localRotation: THREE.Euler;
    followTargetHeight?: boolean;
}
