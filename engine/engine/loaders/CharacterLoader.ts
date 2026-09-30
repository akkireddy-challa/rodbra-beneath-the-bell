import * as THREE from 'three';
import { BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';
import type { BlockFootPose, BlockMeshSet } from 'engine/BlockCharacterRenderer.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { registerPhysicsBody } from 'engine/PhysicsBodyRegistry.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import type { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { type ArmGrip, resolveArmBones, solveArmGrip } from 'engine/loaders/ArmGripIK.js';
import { fitRangedWeaponToArmReach } from 'engine/weapons/RangedWeaponGrip.js';
import { type LegBones, solveLegIK, solveLegIKMap } from 'engine/loaders/LegIK.js';
import {
    authoredFootLift,
    authoredHipsSway,
    captureRigBindPose,
    ClipBoneReader,
    retargetedWorldRotation,
    SkinnedRetargetSpace,
    type ClipRestCorrection,
    type RigBindPose,
} from 'engine/loaders/SkinnedRigRetarget.js';
import { convertBlockPartMaterial } from 'engine/npc/customization/blockPartCaches.js';
import type { RenderSyncPosition } from 'engine/renderSyncPosition.js';
import { PoseBuffer, PoseTransition, type AnimationPose } from 'engine/animation/PoseTransition.js';
import { SkinnedGrounding } from 'engine/loaders/SkinnedGrounding.js';
import { ContinuousQuaternionBlend } from 'engine/animation/ContinuousQuaternionBlend.js';
import { BlockGrounding } from 'engine/loaders/BlockGrounding.js';
import { authoredHipsHeight } from 'engine/loaders/AuthoredHipsHeight.js';
import { computeCharacterBodyBox } from 'engine/character/CharacterBodyBounds.js';

/**
 * CharacterLoader - Base class for loading and managing animated block characters
 *
 * This class encapsulates the common logic for:
 * - Loading character models (skeleton + animations)
 * - Positioning skeleton so feet are at origin
 * - Creating block character overlay
 * - Managing block character updates to follow skeleton
 * - Physics body creation and management
 *
 * Used by both PlayerLoader (for player character) and NpcController (for AI NPCs)
 */
export class CharacterLoader {
    protected engine: EngineLike;
    protected blockCharacterRenderer: BlockCharacterRenderer | null = null;

    /**
     * Slerp that checks quaternion hemisphere to prevent "long way around" interpolation.
     * When dot(a, b) < 0 the quaternions are in opposite hemispheres and slerp would take
     * the longer 270°+ path instead of the shorter <90° path, causing visible spinning.
     */
    private static hemisphereSlerp(
        target: THREE.Quaternion,
        a: THREE.Quaternion,
        b: THREE.Quaternion,
        t: number
    ): THREE.Quaternion {
        if (a.dot(b) < 0) {
            CharacterLoader._flipped.set(-b.x, -b.y, -b.z, -b.w);
            return target.slerpQuaternions(a, CharacterLoader._flipped, t);
        }
        return target.slerpQuaternions(a, b, t);
    }

    protected characterGroup: THREE.Group | null = null;
    /**
     * Root of the loaded glTF character (skeleton + skinned mesh). Set only when
     * the character renders as a real skinned mesh instead of the block
     * character; the per-frame Mixamo blend is applied to this skeleton so GPU
     * skinning deforms the visible mesh. Null for the block-character path.
     */
    protected skinnedSkeletonRoot: THREE.Object3D | null = null;
    /**
     * The skinned rig's bind pose (from its skin's inverse bind matrices),
     * captured in setSkinnedSkeletonRoot. Null for the block path or a rig with
     * no skinned mesh. See SkinnedRigRetarget.ts.
     */
    private skinnedBind: RigBindPose | null = null;
    /**
     * The skinned rig's retarget corrections: one per clip skeleton (applied as
     * its bones are read, so every player lands in the same space before any
     * blend) and one for the rig (applied once in applyPoseRotations). Both are
     * empty for canonical clips on a canonical rig (forged GLB, `.vxl`). Null
     * without a skinned bind. See SkinnedRetargetSpace.
     */
    private skinnedRetarget: SkinnedRetargetSpace | null = null;
    /** Two players are read side by side in a crossfade or a body-mask blend. */
    private readonly clipReadA = new ClipBoneReader();
    private readonly clipReadB = new ClipBoneReader();
    /** The skinned rig's foot/toe joints (the plant reads their world Y) — resolved once, not 12 lookups a frame. */
    private skinnedFootBones: THREE.Object3D[] = [];
    private readonly skinnedBoneMap = new Map<string, THREE.Bone>();
    /** Stable character-local fallback, never the previous retargeted output. */
    private readonly skinnedFallbackPose: AnimationPose = new Map();
    /** The skinned rig's hips bone and its bind LOCAL position, which the authored sway is added to. */
    private skinnedHips: THREE.Object3D | null = null;
    private readonly skinnedHipsBindLocal = new THREE.Vector3();
    /**
     * Pose-map pool. Every blend* function writes into `poseOut`, reusing one
     * vector/quaternion pair per bone from `posePool` for the loader's lifetime,
     * and returns `poseOut` itself. The map is consumed the same frame (the block
     * renderer's overrides are cleared after update(); applyPoseRotations reads
     * it once) and never retained, so the ~65 bones × 2 allocations a frame per
     * character — the dominant garbage of a skinned crowd — go away.
     */
    private readonly posePool = new Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>();
    private readonly poseOut = new Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>();
    private readonly locomotionPose = new PoseBuffer();
    private readonly actionTransition = new PoseTransition();
    private readonly trackRotationBlend = new ContinuousQuaternionBlend();
    private readonly locomotionRotationBlend = new ContinuousQuaternionBlend();
    private previousTrackAKey = '';
    private previousTrackAFading = false;
    private locomotionHandoffRevision = 0;
    private blendedFootLift = 0;
    private readonly blockFootPose: BlockFootPose = {
        grounded: true, bound: false, authoredFootLift: null, characterHeight: 1.75, deltaSeconds: 1 / 60, restRotations: null,
    };
    private blockRestSource: ReadonlyMap<string, THREE.Quaternion> | null = null;
    private readonly blockRestRotations = new Map<string, THREE.Quaternion>();
    private skinnedGrounding: SkinnedGrounding | null = null;
    private blockGrounding: BlockGrounding | null = null;
    private blockDimensionsMeasured = false;
    /**
     * Rig bone name → the clip-skeleton bone name it resolved to. The alias and
     * substring rules in resolveMixamoBone are per-bone string work that never
     * changes for a loader; remembering the answer makes a lookup a Map.get.
     */
    private readonly mixamoNameMemo = new Map<string, string>();
    /**
     * The pose updateSkinnedCharacter just computed, handed to the
     * updateBlockCharacter call that always follows it (NpcController.poseCharacterInner).
     * computeBlendedPose walks both skeletons and allocates per bone; for a
     * skinned NPC it ran twice per pose, and the second run was 14% of a
     * 500-townsfolk frame. Consumed once, then cleared, so a block-only NPC or
     * a stale frame never reads a pose it did not compute.
     */
    private blendedPoseForBlock: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> | null = null;
    /**
     * Active weapon-grip IK targets for the skinned render path, keyed by side.
     * When set, updateSkinnedCharacter poses that arm's bone chain so the hand
     * reaches the grip (see ArmGripIK). Empty for the block-character path,
     * which grips via BlockCharacterRenderer.setArmAttachmentOverride instead.
     */
    private skinnedArmGrips = new Map<'left' | 'right', ArmGrip>();
    protected calculatedCapsuleHeight: number = 1.75;
    protected calculatedCapsuleRadius: number = 0.3;
    protected blockFeetOffset: number = 0;
    protected targetGravityScale: number = 3.57; // Default gravity scale (35 / 9.81)
    protected animController: CharacterAnimationController | null = null;
    /**
     * When true, the block-character Lambert conversion hands out per-loader
     * CLONES of the shared-cache materials instead of the cache-owned ones.
     * The PLAYER's loader opts in (set in PlayerLoader's constructor): shipped
     * game code is invited to mutate the player's visible materials in place
     * (PlayerController.traverseVisibleCharacter docs), which would poison the
     * shared cache every NPC block character reuses. NPC and network-character
     * paths keep the shared materials — their mutation paths (tintBodyPart,
     * damage flash) clone first.
     */
    protected cloneSharedBlockMaterials: boolean = false;


    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    setAnimationController(controller: CharacterAnimationController): void {
        this.animController = controller;
    }
    
    /**
     * Set capsule dimensions manually (for animals/custom characters)
     * Call this BEFORE createPhysicsBody()
     */
    setCapsuleDimensions(height: number, radius: number): void {
        this.calculatedCapsuleHeight = height;
        this.calculatedCapsuleRadius = radius;
    }
    
    /**
     * Set feet offset manually (for animals/custom characters)
     * This is the Y distance from character origin to bottom of feet
     * Usually negative (feet are below origin)
     */
    setFeetOffset(offset: number): void {
        this.blockFeetOffset = offset;
    }

    /**
     * The capsule's TRUE vertical half-extent: distance from the capsule centre
     * to its lowest/highest point = cylinderHalfHeight + radius = max(height/2,
     * radius). Equals height/2 for normal (tall) capsules, but for a short/fat
     * capsule (radius > height/2 — e.g. an elongated animal whose radius is
     * derived from its length) the hemispheres dominate and the true half-extent
     * is `radius`. Using height/2 there would leave the visual floating by
     * `radius - height/2` once the capsule settles on the ground.
     */
    private capsuleHalfExtent(): number {
        return Math.max(this.calculatedCapsuleHeight / 2, this.calculatedCapsuleRadius);
    }

    /**
     * Compute bounding box excluding user-attached objects (weapons, etc.)
     *
     * This is critical for calculating ground positions - attached weapons should NOT
     * affect the character's feet position calculation. When a long weapon swings
     * downward, its tip might go below the character's feet, but we shouldn't use
     * that as the "feet" position.
     *
     * @param root - The root object to compute bounds for
     * @returns Bounding box excluding attached objects
     */
    protected computeBoundingBoxExcludingAttachments(root: THREE.Object3D): THREE.Box3 {
        return computeCharacterBodyBox(root, new THREE.Box3());
    }

    /**
     * Position skeleton so feet are at local y=0 (same as PlayerLoader:235)
     * MUST be called BEFORE creating block character
     */
    adjustSkeletonPosition(skeleton: THREE.Object3D): void {
        // Temporarily set skeleton at world origin to measure its local bounding box
        skeleton.position.set(0, 0, 0);
        skeleton.updateMatrixWorld(true);

        const skeletonBox = new THREE.Box3().setFromObject(skeleton);
        const minY = skeletonBox.min.y;

        // Adjust skeleton position so feet are at origin
        skeleton.position.y = -minY;
        skeleton.updateMatrixWorld(true);
    }

    /**
     * Create and setup block character
     * - Creates block character from skeleton using factory
     * - Adds to scene at world origin with identity transform
     * - Calculates capsule dimensions from block character
     */
    createBlockCharacter(
        skeleton: THREE.Object3D,
        factory: IBlockCharacterFactory,
        armatureRotation?: THREE.Quaternion | null,
        modelForward?: THREE.Vector3,
        // When false, the block character is still built (it is reused as the
        // hidden pose source) but its factory dimensions do NOT override the
        // capsule size. Callers that have already measured the capsule from a
        // custom/authoritative asset pass false so the default block-character
        // proportions don't squash the custom character. Defaults to true to
        // preserve the existing block-character sizing behaviour.
        sizeCapsuleFromBlock: boolean = true
    ): void {
        // Create block character renderer using factory
        this.blockCharacterRenderer = BlockCharacterRenderer.create(skeleton, factory);
        this.blockGrounding = new BlockGrounding(this.blockCharacterRenderer, skeleton);
        this.blockDimensionsMeasured = false;

        // Auto-detect armature rotation if not provided
        if (armatureRotation === undefined) {
            armatureRotation = CharacterLoader.detectArmatureRotation(skeleton);
        }

        // Apply armature rotation correction if needed
        if (armatureRotation) {
            const euler = new THREE.Euler().setFromQuaternion(armatureRotation);
            // If armature has ~90 degree X rotation, set correction in renderer
            if (Math.abs(euler.x - Math.PI / 2) < 0.1) {
                const correctionQuat = new THREE.Quaternion();
                correctionQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
                this.blockCharacterRenderer.setCoordinateCorrection(correctionQuat);
            }
        }

        // Set model forward direction if provided
        if (modelForward) {
            this.blockCharacterRenderer.setModelForward(modelForward);
        }

        // Add block character to scene (separate from character group, same as PlayerLoader:162-173)
        const blockRoot = this.blockCharacterRenderer.getRoot();
        if (this.engine.scene) {
            this.engine.scene.add(blockRoot);
        } else {
            console.warn(`⚠️ [CharacterLoader] engine.scene is null — block character not added to scene (character will be invisible)`);
        }

        // CRITICAL: Block character uses world space with identity transform (same as PlayerLoader:169-171)
        blockRoot.position.set(0, 0, 0);
        blockRoot.rotation.set(0, 0, 0);
        blockRoot.scale.set(1, 1, 1);

        // Layer 1 + shared cache-owned materials — see applyBlockPartMaterial().
        blockRoot.traverse((child: THREE.Object3D) => this.applyBlockPartMaterial(child));

        // Calculate capsule dimensions from block character — unless the caller
        // has already sized the capsule from a custom/authoritative asset, in
        // which case the default block-character proportions must not override
        // (and squash) the custom character's measured dimensions.
        if (sizeCapsuleFromBlock) {
            const dimensions = factory.getCharacterDimensions();
            this.calculatedCapsuleHeight = dimensions.height * 1.05; // 5% extra to ensure head is covered for hit detection
            const maxHorizontal = Math.max(dimensions.width, dimensions.depth);
            this.calculatedCapsuleRadius = (maxHorizontal / 2) * 1.1;
            this.calculatedCapsuleRadius = Math.max(0.2, Math.min(this.calculatedCapsuleRadius, 0.8));
        }

        // Calculate block feet offset (same as PlayerLoader:158)
        // Validate the bounding box - if empty/infinite, the factory didn't populate the characterGroup
        if (!this.recomputeBlockFeetOffset()) {
            console.error(`[CharacterLoader] ❌ FATAL: Block character has invalid bounding box.
This means createBlockCharacter() didn't add any meshes to the provided characterGroup.

The factory function must POPULATE the provided group like this:

  function createBlockCharacter(characterGroup: THREE.Group): void {
    const partGroup = characterGroup.getObjectByName('head') as THREE.Group;
    partGroup.add(mesh);  // Adds to PROVIDED group
  }

Check your character factory implementation.`);
            throw new Error('Block character factory failed to populate characterGroup. See console for details.');
        }
    }

    /**
     * Give one block-character object the engine's standard treatment: layer 1
     * (excluded from collider-editor raycasting) and the shared cache-owned
     * material. Applied to the meshes a factory produced — at creation, and
     * again to every mesh set built later (see `redressBlockCharacter`).
     *
     * Untagged parts become MeshLambert so characters respond to local lighting
     * (like terrain does) instead of environment maps; parts tagged with
     * CHARACTER_PART_CLASS (a gold buckle, a glass lens) become the tuned
     * classed material at the resolved MaterialQuality. Teardown paths must skip
     * __sharedLodCache materials; mutation paths (tint/flash/damage) clone
     * first; the player path (cloneSharedBlockMaterials) gets per-player clones
     * so in-place mutation cannot poison the shared cache.
     *
     * @internal
     */
    applyBlockPartMaterial(child: THREE.Object3D): void {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        child.layers.set(1);
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const newMaterials = materials.map(mat =>
            convertBlockPartMaterial(mat, this.cloneSharedBlockMaterials));
        mesh.material = Array.isArray(mesh.material) ? newMaterials : newMaterials[0]!;
    }

    /**
     * Measure the offset from the block root's position down to the feet, which
     * `updateBlockCharacter()` uses to plant the character on the ground. Uses
     * the filtered bounding box so weapons and other attachments don't count as
     * feet.
     *
     * At creation this validates/measures the factory. Later humanoid outfit
     * changes adjust only sole thickness, never the current animated knee tuck.
     * Returns false for empty/infinite bounds (the factory supplied no body).
     *
     * @internal
     */
    recomputeBlockFeetOffset(): boolean {
        const blockRoot = this.blockCharacterRenderer?.getRoot();
        if (!blockRoot) return false;
        blockRoot.updateMatrixWorld(true);
        const blockBox = this.computeBoundingBoxExcludingAttachments(blockRoot);
        if (blockBox.isEmpty() || !Number.isFinite(blockBox.min.y)) return false;
        const soleChange = this.blockGrounding?.measureSoles() ?? 0;
        // A wardrobe change can happen mid-stride. Do not turn that frame's
        // knee tuck or grounded renderer offset into a new physics reference.
        if (this.blockGrounding?.hips && this.blockDimensionsMeasured) this.blockFeetOffset -= soleChange;
        else this.blockFeetOffset = blockBox.min.y - blockRoot.position.y;
        this.blockDimensionsMeasured = true;
        return isFinite(this.blockFeetOffset) && !blockBox.isEmpty();
    }

    /**
     * Detect armature rotation from a skeleton hierarchy.
     * Looks for the armature node (parent of root bone) and returns its quaternion.
     * Used to correct coordinate systems (e.g., Blender Z-up → Three.js Y-up 90° X rotation).
     */
    static detectArmatureRotation(skeleton: THREE.Object3D): THREE.Quaternion | null {
        let armatureRotation: THREE.Quaternion | null = null;
        skeleton.traverse((child: THREE.Object3D) => {
            if (child.name.toLowerCase().includes('armature') ||
                child.name.toLowerCase().includes('deform') ||
                // A bone whose parent is not itself a bone IS the armature node.
                // Probed via `.type` (as the sibling check above does) rather than
                // `instanceof`, which breaks across duplicated three.js copies.
                (child.type === 'Bone' && child.parent && child.parent.type !== 'Bone')) {
                const armatureNode = (child.type === 'Bone') ? child.parent : child;
                if (armatureNode) {
                    armatureRotation = armatureNode.quaternion.clone();
                }
            }
        });
        return armatureRotation;
    }

    /**
     * Pose blocks from the blended skeleton. Authored hip height places the body;
     * leg-only clearance handles rotating shoes without moving the torso. Bound
     * or incomplete/non-humanoid rigs retain filtered bounding-box placement.
     */
    updateBlockCharacter(characterWorldPos: THREE.Vector3): void {
        if (!this.blockCharacterRenderer || !this.characterGroup) {
            return;
        }

        // Position the block root horizontally BEFORE posing: applyTransform() bakes each part's world
        // position relative to the root's current matrix, so the root must already sit at the character.
        // Block NPCs get this free (posed every frame); a skinned NPC's proxy is posed once at death
        // from a stale spawn-point root, and posing-then-moving double-applied the walk offset (corpse
        // landed ~20 m away). Setting xz first makes a single cold call land correctly.
        const blockRoot = this.blockCharacterRenderer.getRoot();
        const actualGroundY = characterWorldPos.y + this.blockFeetOffset;
        const heldRootY = this.blockCharacterRenderer.resolvePoseOverrideRootY(actualGroundY);
        blockRoot.position.x = characterWorldPos.x;
        blockRoot.position.z = characterWorldPos.z;
        // Parts are posed in world space. Reusing yesterday's Y offset made
        // the root drift kilometres while part-local translations cancelled it.
        // Unbound animal factories are local geometry and keep their own root.
        if (this.blockGrounding?.hips && heldRootY === null) blockRoot.position.y = 0;
        // NOT updating world matrices here: BlockCharacterRenderer.update() below
        // opens with `root.updateMatrixWorld(true)` on this exact object, and
        // nothing in between touches this hierarchy (the bone-override calls act
        // on the SKELETON). A forced recursion is dirty-flag-ignoring and walks
        // every descendant, so the duplicate was a measurable share of a pose
        // that costs ~1.8 ms per NPC.

        // Reuse the pose the skinned pass computed a moment ago when there was one.
        const blended = this.blendedPoseForBlock ?? this.computeBlendedPose();
        this.blendedPoseForBlock = null;
        const source = this.animController?.getTrackAMixamoPlayer() ?? this.animController?.getTrackBMixamoPlayer();
        this.blockFootPose.grounded = this.animController?.getPoseGrounded() ?? true;
        this.blockFootPose.bound = !!this.animController?.getFootIkTargets();
        this.blockFootPose.authoredFootLift = blended ? this.blendedFootLift : null;
        this.blockFootPose.characterHeight = this.calculatedCapsuleHeight;
        this.blockFootPose.deltaSeconds = this.animController?.getPoseDeltaSeconds() ?? 1 / 60;
        // A skinned rig's pose is composed in ONE rest whichever players went into
        // it (SkinnedRetargetSpace), already keyed by this rig's bone names. The
        // block-only path reads a single player's bones as they are.
        const composedRest = blended && source && this.skinnedRetarget?.hasReference()
            ? this.skinnedRetarget.getReferenceRest() : null;
        const rest = blended && !composedRest ? source?.getRestRotations() ?? null : null;
        if (rest !== this.blockRestSource) {
            this.blockRestSource = rest;
            this.blockRestRotations.clear();
            // The composed pose uses the original rig's names, which can differ
            // from the source (Manny / mixamorig2). Resolve rest with the same
            // aliases as the pose, never subtract the target rig's bind from it.
            if (rest && source) for (const name of this.getStandardBoneMap()?.keys() ?? []) {
                if (!/foot/i.test(name)) continue;
                const sourceBone = CharacterLoader.resolveMixamoBone(name, source.getBoneMap());
                const rotation = sourceBone && rest.get(sourceBone.name);
                if (rotation) this.blockRestRotations.set(name, rotation);
            }
        }
        this.blockFootPose.restRotations = composedRest ?? (rest ? this.blockRestRotations : null);
        if (blended) {
            this.applyLegIkToMap(blended);
            this.blockCharacterRenderer.setBoneTransformOverrides(blended);
            this.blockCharacterRenderer.update(this.blockFootPose);
            this.blockCharacterRenderer.setBoneTransformOverrides(null);
        } else {
            // No Mixamo/action override — the standard mixer drives the GLTF
            // skeleton directly. Pose the manual stance offsets onto its bones;
            // update() refreshes the skeleton's world matrices, so Three's FK
            // carries them (and the hierarchy) into the render.
            const restore = this.applyManualBoneOffsets(this.getStandardBoneMap() ?? new Map());
            this.applyLegIk();
            this.blockCharacterRenderer.update(this.blockFootPose);
            this.restoreManualBoneOffsets(restore);
        }

        // Place the body in Y last. Posed bounds are only a fallback, never the
        // normal humanoid support reference: rotating a shoe would move the torso.
        blockRoot.updateMatrixWorld(true);

        // …unless a pose override holds the height. A leaning or reaching pose moves the posed
        // bounding box, so aligning its new lowest point to the ground shifts the whole body —
        // a seated NPC told to lean toward the bar visibly sinks into the stool. The override
        // captured the height it wants on install; re-assert it and skip the align.
        if (heldRootY !== null) {
            blockRoot.position.y = heldRootY;
            return;
        }

        const authored = authoredHipsHeight(blended, source, this.characterGroup, this.blockGrounding?.hips?.name, this.composedHipsRest(source));
        const shift = !this.blockFootPose.bound ? this.blockGrounding?.shift(actualGroundY, authored) : null;
        blockRoot.position.y += shift ?? actualGroundY - this.computeBoundingBoxExcludingAttachments(blockRoot).min.y;
        blockRoot.updateMatrixWorld(true);
        if (shift != null && this.blockFootPose.grounded) this.blockGrounding?.clearFeet(actualGroundY);
    }

    /**
     * Select & compute this frame's blended bone pose from the active Mixamo
     * tracks. Returns a Map<boneName,{world position, world rotation}> keyed by
     * standard skeleton bone names, or null when no Mixamo/action override is
     * active (the standard mixer drives directly). Shared by the block-character
     * and skinned-mesh render paths.
     *
     * Track A (base): trackAMixamoPlayer locomotion override.
     * Track B (override): trackBMixamoPlayer / action layer, blended per-body-part.
     */
    protected computeBlendedPose(): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> | null {
        const pose = this.evaluateBlendedPose();
        if (!pose) { this.actionTransition.reset(); this.blendedFootLift = 0; return null; }
        const a = this.animController?.getTrackAMixamoPlayer();
        const b = this.animController?.getTrackBMixamoPlayer();
        const fading = this.animController?.getFadingOutTrackAPlayer();
        const aKey = `${a?.getSkeletonRoot()?.uuid ?? ''}:${a?.getPlayRevision() ?? 0}`;
        // Normal A crossfades already have a continuous outgoing clip. If a
        // second transition interrupts one, that clip alone is NOT the pose
        // last shown; snapshot the displayed composite for this handoff too.
        if (aKey !== this.previousTrackAKey && this.previousTrackAFading) this.locomotionHandoffRevision++;
        this.previousTrackAKey = aKey;
        this.previousTrackAFading = !!fading;
        const blend = this.animController?.getCustomAnimationBodyBlend();
        const aProgress = THREE.MathUtils.smoothstep(this.animController?.getFadingOutCrossfadeProgress() ?? 1, 0, 1);
        const aLift = fading ? THREE.MathUtils.lerp(authoredFootLift(fading.getAuthoredFootLift()),
            authoredFootLift(a?.getAuthoredFootLift() ?? null), aProgress) : authoredFootLift(a?.getAuthoredFootLift() ?? null);
        const bWeight = (b?.getBlendWeight() ?? 0) * (blend?.lowerBody ?? 1);
        const lift = THREE.MathUtils.lerp(aLift, authoredFootLift(b?.getAuthoredFootLift() ?? null), bWeight);
        const key = `${b?.getSkeletonRoot()?.uuid ?? this.animController?.getActionSkeletonRoot()?.uuid ?? ''}:` +
            `${b?.getPlayRevision() ?? 0}:${blend?.upperBody ?? 1}:${blend?.lowerBody ?? 1}:${this.locomotionHandoffRevision}`;
        this.blendedFootLift = this.actionTransition.apply(pose, key, this.characterGroup,
            this.animController?.getPoseDeltaSeconds() ?? 1 / 60, lift,
            b ? Math.min(.10, b.getDuration() / Math.max(.1, Math.abs(b.getSpeed())) * .18) : .10);
        const layers = this.animController?.getProceduralPoseLayers();
        const manual = this.animController?.getManualBoneOffsets();
        if (layers && (layers.size || manual?.size)) {
            const bones = this.getStandardBoneMap();
            if (bones) {
                const resolve = (name: string) => CharacterLoader.findKeyForPart(name, pose);
                if (manual?.size) layers.applyLocalRotations(pose, bones, manual, 1, resolve);
                layers.apply(pose, bones, resolve);
            }
        }
        return pose;
    }

    private evaluateBlendedPose(): AnimationPose | null {
        const trackAMixamo = this.animController?.getTrackAMixamoPlayer?.() ?? null;
        const trackBMixamo = this.animController?.getTrackBMixamoPlayer?.() ?? null;
        const actionBoneMap = this.animController?.getActionBoneMap?.();
        const trackBlend = this.animController?.getCustomAnimationBodyBlend?.() ?? undefined;
        const hasTrackB = !!(trackBMixamo || actionBoneMap);
        // Resolve A completely before layering B. Each operation writes poseOut,
        // so the intermediate needs its own buffer, not a reference to poseOut.
        const fadingA = this.animController?.getFadingOutTrackAPlayer?.();
        const resolvedA = hasTrackB && trackAMixamo && fadingA
            ? this.locomotionPose.copy(this.blendTwoMixamoPlayers(fadingA, trackAMixamo,
                THREE.MathUtils.smoothstep(this.animController?.getFadingOutCrossfadeProgress() ?? 1, 0, 1)))
            : undefined;

        if (hasTrackB && trackBlend) {
            // Two-track blend with per-body-part weights. While Track B (the
            // custom anim, e.g. an attack) fades in/out, scale the body-part
            // weights by its blend weight so the override resolves to Track A
            // on completion instead of snapping.
            const trackBWeight = trackBMixamo?.getBlendWeight() ?? 1;
            const effectiveBlend = trackBWeight === 1
                ? trackBlend
                : { upperBody: trackBlend.upperBody * trackBWeight, lowerBody: trackBlend.lowerBody * trackBWeight };
            return this.blendTwoTracks(trackAMixamo, trackBMixamo, actionBoneMap ?? null, effectiveBlend, resolvedA);
        }
        if (trackBMixamo) {
            // Track B (Mixamo) takes over uniformly. If Track A is also live,
            // blend Track A → Track B by Track B's weight so the fade-out
            // resolves cleanly to the locomotion pose.
            const blendWeight = trackBMixamo.getBlendWeight();
            return trackAMixamo
                ? this.blendTwoTracks(trackAMixamo, trackBMixamo, actionBoneMap ?? null, { upperBody: blendWeight, lowerBody: blendWeight }, resolvedA)
                : this.blendBoneTransforms(trackBMixamo, blendWeight);
        }
        if (trackAMixamo) {
            // Only Track A Mixamo (locomotion override, no Track B)
            const fadingOutPlayer = this.animController?.getFadingOutTrackAPlayer?.() ?? null;
            if (fadingOutPlayer) {
                // Crossfading between two Mixamo players (e.g. idle→walk), smoothstep eased
                const rawProgress = this.animController?.getFadingOutCrossfadeProgress?.() ?? 1;
                const crossfadeProgress = rawProgress * rawProgress * (3 - 2 * rawProgress);
                return this.blendTwoMixamoPlayers(fadingOutPlayer, trackAMixamo, crossfadeProgress);
            }
            // A is the complete base pose, including a clamped airborne jump.
            // Its handoff already uses the outgoing A clip above. Never fade
            // it into the visible rig (last frame's retargeted OUTPUT).
            return this.blendBoneTransforms(trackAMixamo, 1);
        }
        if (actionBoneMap) {
            // Track B via action layer (no Mixamo), uniform blend
            const actionBlend = trackBlend ?? this.animController!.getActionBlend();
            return this.blendActionBoneTransforms(actionBoneMap, actionBlend);
        }
        return null;
    }

    // Foot/toe bones used to plant the skinned mesh on the ground. Covers both
    // rig conventions (UE5 Manny + Mixamo) so grounding is skeleton-agnostic; the
    // lowest of whichever bones exist is used.
    /** Bones whose lowest world Y is the planted foot, across the rig namings the engine meets. */
    static readonly FOOT_BONE_NAMES: readonly string[] = [
        'foot_l', 'foot_r', 'ball_l', 'ball_r',                                                    // UE5 (Manny)
        'mixamorigLeftFoot', 'mixamorigRightFoot', 'mixamorigLeftToeBase', 'mixamorigRightToeBase', // Mixamo
        'mixamorig2LeftFoot', 'mixamorig2RightFoot', 'mixamorig2LeftToeBase', 'mixamorig2RightToeBase', // Mixamo gen 2
    ];
    private static readonly _scratchVec = new THREE.Vector3();
    private static readonly _scratchQuat = new THREE.Quaternion();
    private static readonly _parentWorldQuat = new THREE.Quaternion();

    /**
     * Skinned-mesh render path: drive the real glTF skeleton from the same
     * per-frame Mixamo blend the block character uses, so GPU skinning deforms
     * the visible mesh. No-op unless setSkinnedSkeletonRoot() was called.
     *
     * Rotation retarget: we apply the animation's WORLD rotations to the bones
     * but keep each bone's bind-pose local position, so the mesh keeps its own
     * proportions (limb lengths) instead of stretching to the animation rig's.
     * A rig whose bind orientations differ from the clip skeleton's rest gets a
     * constant per-bone correction (SkinnedRigRetarget.ts); a canonical rig
     * (forged GLB, `.vxl`) has none and is applied as-is. Clip skeletons that
     * rest differently from one another are brought into one space as they are
     * read, so the correction is exact for whichever clip is playing.
     *
     * Hips travel: a rotation-only retarget keeps every bone at its bind
     * position, so a clip's authored hips sway and weight shift — the part of an
     * idle or an attack that reads as balance — surface as the FEET sliding
     * the other way. The block path applies positions and shows the sway; here
     * the ground-plane offset of the blended hips from the clip skeleton's rest
     * hips is added to the rig's hips bind position (SkinnedRigRetarget.
     * authoredHipsSway). Locomotion filtering removes net linear travel but preserves cyclic sway,
     * so weight shifts remain visible on both paths.
     *
     * Foot IK (a snowboard's bindings) is solved on the pose map before it is
     * applied, the same call the block path makes — the skinned path used to
     * skip it, leaving a skinned rider's feet off the board.
     *
     * Vertical: SkinnedGrounding follows the authored pelvis above a calibrated
     * rest height. Standing locomotion gets bounded visual damping; contact and
     * clearance corrections affect only the legs. Physics steps are never smoothed and
     * terrain normals never pitch the root. Incomplete rigs keep exact planting.
     *
     * @param characterWorldPos world position of the player group (ground reference)
     */
    updateSkinnedCharacter(characterWorldPos: THREE.Vector3): void {
        const root = this.skinnedSkeletonRoot;
        if (!root) return;
        const blended = this.computeBlendedPose();
        this.blendedPoseForBlock = blended;
        const hasGrips = this.skinnedArmGrips.size > 0;
        if (!blended && !hasGrips) { this.skinnedGrounding?.reset(); return; }

        const source = this.animController?.getTrackAMixamoPlayer?.()
            ?? this.animController?.getTrackBMixamoPlayer?.()
            ?? null;
        if (blended) {
            this.applyLegIkToMap(blended);
            CharacterLoader.applyPoseRotations(root, blended, this.resolveSkinnedRetargetDeltas(source));
            this.applySkinnedHipsSway(root, blended, source);
        }
        root.parent?.updateWorldMatrix(true, false);
        root.updateMatrixWorld(true);

        this.skinnedGrounding?.place(characterWorldPos.y + this.blockFeetOffset, this.blendedFootLift,
            Math.max(.3, this.calculatedCapsuleHeight), blended ? this.animController : null, this.engine.physicsWorld,
            this.characterGroup ?? root, authoredHipsHeight(blended, source, this.characterGroup ?? root, this.skinnedHips?.name,
                this.composedHipsRest(source))?.offset ?? null);

        // Pose gripping arms onto their weapon grips LAST: after the animation
        // pose (so each shoulder sits where the animation put it) and after the
        // ground shift above (so the hands land on the grip in final world
        // space, not a position the foot-plant then moves out from under). Only
        // the gripping arm's bone chain is overridden (see ArmGripIK).
        if (hasGrips) this.applySkinnedArmGrips(root);
    }

    private static readonly _rootPosA = new THREE.Vector3();
    private static readonly _rootPosB = new THREE.Vector3();
    private static readonly _blendedRootPos = new THREE.Vector3();
    private static readonly _flipped = new THREE.Quaternion();
    private static readonly _offsetA = new THREE.Vector3();
    private static readonly _offsetB = new THREE.Vector3();
    private static readonly _swayWorld = new THREE.Vector3();
    private static readonly _restHipsWorld = new THREE.Vector3();
    private static readonly _rootQuat = new THREE.Quaternion();
    private static readonly _parentScale = new THREE.Vector3();

    /**
     * Where the composed pose's hips rest, relative to a clip skeleton's root: on
     * a skinned rig every player is read in one reference rest (beginClipRead),
     * so that reference's — not the rest of whichever player happens to be the
     * pose source, which changes mid-crossfade. The block path reads one player.
     */
    private composedHipsRest(
        source: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null | undefined,
    ): THREE.Vector3 | null {
        return this.skinnedRetarget?.getReferenceHipsRest() ?? source?.getRestHipsOffset() ?? null;
    }

    /**
     * Move the rig's hips by the clip's authored ground-plane travel (see the
     * updateSkinnedCharacter doc). The reference is the clip skeleton's rest hips
     * placed at the character's current position and facing — NOT the clip
     * skeleton's own root, which a root-motion clip shifts back by its travel
     * (the body would then lunge twice). No-op without hips on either side.
     */
    private applySkinnedHipsSway(
        root: THREE.Object3D,
        blended: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>,
        source: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null,
    ): void {
        const hips = this.skinnedHips;
        const restOffset = this.composedHipsRest(source);
        if (!hips || !hips.parent || !restOffset) return;
        const entry = blended.get(hips.name);
        if (!entry) return;

        root.getWorldPosition(CharacterLoader._restHipsWorld);
        root.getWorldQuaternion(CharacterLoader._rootQuat);
        CharacterLoader._restHipsWorld.add(CharacterLoader._swayWorld.copy(restOffset).applyQuaternion(CharacterLoader._rootQuat));
        authoredHipsSway(entry.position, CharacterLoader._restHipsWorld, CharacterLoader._swayWorld);

        // World offset → the hips' parent frame (its rotation and scale undone).
        hips.parent.updateWorldMatrix(true, false);
        hips.parent.getWorldQuaternion(CharacterLoader._parentWorldQuat).invert();
        hips.parent.getWorldScale(CharacterLoader._parentScale);
        CharacterLoader._swayWorld.applyQuaternion(CharacterLoader._parentWorldQuat);
        CharacterLoader._swayWorld.divide(CharacterLoader._parentScale);
        hips.position.copy(this.skinnedHipsBindLocal).add(CharacterLoader._swayWorld);
        hips.updateMatrix();
    }

    /**
     * Pose a skeleton from a world-rotation map keyed by bone name, preserving
     * each bone's bind-pose local position (so limb lengths / proportions are
     * kept — no stretching to the source rig). Processed root→leaf so each child
     * reads its parent's freshly-updated world matrix. Bones absent from the map
     * keep their bind pose and follow their animated parent (twists, metacarpals).
     *
     * `retargetDeltas` (SkinnedRigRetarget.buildRetargetDeltas) corrects bones
     * whose bind orientation differs from the clip skeleton's rest; bones
     * without an entry take the clip rotation unchanged.
     */
    static applyPoseRotations(
        root: THREE.Object3D,
        pose: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>,
        retargetDeltas: ReadonlyMap<string, THREE.Quaternion> | null = null,
    ): void {
        root.traverse((obj) => {
            if (!(obj as THREE.Bone).isBone) return;
            const entry = pose.get(obj.name);
            if (!entry) return;
            const parent = obj.parent;
            if (!parent) return;
            parent.updateWorldMatrix(true, false);
            parent.getWorldQuaternion(CharacterLoader._parentWorldQuat);
            const delta = retargetDeltas?.get(obj.name);
            const worldRot = delta
                ? retargetedWorldRotation(entry.rotation, delta, CharacterLoader._scratchQuat)
                : entry.rotation;
            // local rotation that yields the desired world rotation; position
            // (bone length) stays at bind.
            obj.quaternion.copy(CharacterLoader._parentWorldQuat.invert().multiply(worldRot));
            obj.updateMatrix();
        });
    }

    /**
     * Create physics capsule body for character
     * Position is where feet should be (ground level)
     */
    createPhysicsBody(
        position: THREE.Vector3,
        physicsWorld: PhysicsWorld,
        gravity: number = -35.0,
        collisionGroup: number = CollisionGroup.PLAYER,
        collisionMask: number = CollisionMask.PLAYER
    ): RAPIER.RigidBody {
        const radius = this.calculatedCapsuleRadius;
        const height = this.calculatedCapsuleHeight;
        const isAnimal = (collisionGroup & CollisionGroup.ANIMAL) !== 0; // Check if ANIMAL bit is set

        // Capsule center sits at ground + the capsule's true vertical half-extent
        // (cylinderHalfHeight + radius = max(height/2, radius)). For a short/fat
        // capsule (radius > height/2, e.g. an elongated animal) this is `radius`,
        // not height/2 — using height/2 would start it penetrating the ground.
        // Add small offset to prevent initial ground penetration with Rapier
        const spawnOffset = isAnimal ? 0.01 : 0.05;
        const physicsY = position.y + Math.max(height / 2, radius) + spawnOffset;
        // Rapier capsule halfHeight is the half-height of the cylinder part (not including hemispheres)
        const halfHeight = Math.max(0, (height - 2 * radius) / 2);

        // Kept for callers that read it; the motor uses this as its gravity magnitude.
        this.targetGravityScale = gravity / -9.81;

        // 2D-physics lane: the same kinematic capsule, on the Rapier 2D world behind
        // the facade. Everything below this branch is 3D Rapier, which a 2D-only
        // bundle does not ship — so the branch comes BEFORE getRapier().
        if (isPlaneLockedPhysics(physicsWorld)) {
            const body2D = physicsWorld.createCharacterCapsule({
                x: position.x, y: physicsY, z: position.z, radius, halfHeight, collisionGroup, collisionMask, friction: 0.4,
            }) as unknown as RAPIER.RigidBody;
            registerPhysicsBody(body2D, isAnimal ? 'animal' : 'player');
            return body2D;
        }

        const RAPIER = getRapier();

        // ALL characters — player, NPC, animal — are kinematicPositionBased and
        // driven by a Rapier KinematicCharacterController (collide-and-slide): the
        // motor computes a collision-clamped movement and applies it EXACTLY via
        // setNextKinematicTranslation. Position-based (not velocity-based) is
        // required for correctness: the controller's movement is guaranteed not to
        // penetrate, and setNextKinematicTranslation lands on exactly that point.
        // A velocity-based body instead integrates the velocity over the fixed-60Hz
        // substep, which at higher render rates moves FURTHER than the clamped
        // movement and punches the capsule down through the thin (hollow-underneath)
        // trimesh ground — the cause of characters sinking waist-deep into the
        // floor. Characters are deliberately OUT of the dynamic solver:
        //   - no CCD (a kinematic body can't go runaway-Inf and corrupt the BVH),
        //   - no forces / no momentum (can't be catapulted by penetration recovery),
        //   - they never shove or launch dynamic bodies (push is a capped motor impulse).
        // Gravity is applied by the motor each frame (gated until terrain is ready,
        // like the old gravityScale=0).
        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(position.x, physicsY, position.z);

        const body = physicsWorld.createRigidBody(bodyDesc);
        
        // Lock rotation on all axes (we control rotation manually)
        body.lockRotations(true, true);
        
        // Create capsule collider
        // Rapier format: lower 16 bits = membership, upper 16 bits = filter (what it collides with)
        const collisionGroups = (collisionMask << 16) | collisionGroup;
        
        const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
            .setFriction(0.4)
            .setRestitution(0.0) // No bouncing
            .setCollisionGroups(collisionGroups);
        
        physicsWorld.createCollider(colliderDesc, body);
        registerPhysicsBody(body, isAnimal ? 'animal' : 'player');

        return body;
    }

    /**
     * Enable gravity on a physics body.
     * Call this after terrain is fully loaded to prevent falling through unloaded terrain.
     */
    enableGravity(body: RAPIER.RigidBody): void {
        body.setGravityScale(this.targetGravityScale, true);
    }

    /**
     * Get the target gravity scale that will be applied when enableGravity is called.
     */
    getTargetGravityScale(): number {
        return this.targetGravityScale;
    }

    /**
     * Sync character group position with physics body
     * Character Y = physics center Y - halfHeight - blockFeetOffset
     *
     * The blockFeetOffset is negative (feet below character origin), so we subtract it
     * to raise the character group, ensuring block feet end up at capsule bottom.
     *
     * `positionOverride` (same body-center space as `translation()`) lets callers
     * sync from the motor's per-render-frame target instead of the substep-
     * quantized body position — see IPlayerMovement.getRenderPosition.
     */
    syncCharacterWithPhysics(
        characterGroup: THREE.Group,
        physicsBody: RAPIER.RigidBody,
        positionOverride?: RenderSyncPosition
    ): void {
        const origin = positionOverride ?? physicsBody.translation();

        // Physics body origin is at capsule center, but character group origin is
        // at feet. Position the group so the (block) feet align with the capsule
        // bottom (same as Game.ts:302). Since blockFeetOffset is negative,
        // subtracting it raises the character. Kinematic (animals) and dynamic
        // bodies use the identical mapping.
        const capsuleBottom = origin.y - this.capsuleHalfExtent();
        const characterY = capsuleBottom - this.blockFeetOffset;

        characterGroup.position.set(origin.x, characterY, origin.z);
    }

    /**
     * Get the block character renderer
     */
    getBlockCharacterRenderer(): BlockCharacterRenderer | null {
        return this.blockCharacterRenderer;
    }

    /**
     * Get calculated capsule height
     */
    getCapsuleHeight(): number {
        return this.calculatedCapsuleHeight;
    }

    /**
     * Get calculated capsule radius
     */
    getCapsuleRadius(): number {
        return this.calculatedCapsuleRadius;
    }

    /** Where the block body's feet sit relative to the character root — the ground reference every pose plants to. */
    getBlockFeetOffset(): number {
        return this.blockFeetOffset;
    }

    /**
     * Rigid-body translation Y for a desired character-group (feet) world Y.
     * Inverse of syncCharacterWithPhysics: feetWorldY = capsuleBottom - blockFeetOffset.
     */
    getPhysicsCenterYForFeet(feetWorldY: number): number {
        return feetWorldY + this.capsuleHalfExtent() + this.blockFeetOffset;
    }

    /** Character (feet) world Y from rigid-body translation Y */
    getFeetWorldYFromPhysicsTranslation(translationY: number): number {
        return translationY - this.capsuleHalfExtent() - this.blockFeetOffset;
    }

    /**
     * Set character group reference (needed for updateBlockCharacter)
     */
    setCharacterGroup(group: THREE.Group): void {
        this.characterGroup = group;
    }

    /**
     * Enable the skinned-mesh render path: drive this glTF skeleton from the
     * Mixamo animation blend each frame (see updateSkinnedCharacter).
     */
    setSkinnedSkeletonRoot(root: THREE.Object3D): void {
        this.actionTransition.reset();
        this.trackRotationBlend.reset();
        this.locomotionRotationBlend.reset();
        this.previousTrackAKey = '';
        this.previousTrackAFading = false;
        this.blendedPoseForBlock = null;
        this.mixamoNameMemo.clear();
        this.blockRestSource = null;
        this.blockRestRotations.clear();
        this.blockFootPose.restRotations = null;
        this.boneBlendCurve = null;
        this.skinnedArmBones.clear();
        this.skinnedSkeletonRoot = root;
        this.skinnedBoneMap.clear();
        root.traverse(o => { if ((o as THREE.Bone).isBone) this.skinnedBoneMap.set(o.name, o as THREE.Bone); });
        this.skinnedFallbackPose.clear();
        this.characterGroup?.updateWorldMatrix(true, true);
        root.updateWorldMatrix(true, true);
        const inverseFrame = (this.characterGroup?.matrixWorld.clone() ?? new THREE.Matrix4()).invert();
        const inverseRotation = (this.characterGroup?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()).invert();
        for (const [name, bone] of this.skinnedBoneMap) this.skinnedFallbackPose.set(name, {
            position: bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseFrame),
            rotation: bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverseRotation),
        });
        this.skinnedBind = captureRigBindPose(root);
        this.skinnedRetarget = this.skinnedBind ? new SkinnedRetargetSpace(this.skinnedBind.rotations) : null;
        this.skinnedFootBones = [];
        for (const name of CharacterLoader.FOOT_BONE_NAMES) {
            const bone = root.getObjectByName(name);
            if (bone) this.skinnedFootBones.push(bone);
        }
        // Hips: the bone the authored sway moves. Its local position is read
        // now, before updateSkinnedCharacter ever writes it — call this with the
        // rig at rest (the loaders do; the grounding sample restores what it posed).
        let hips: THREE.Object3D | null = null;
        root.traverse((o) => {
            if (hips || !(o as THREE.Bone).isBone) return;
            const lower = o.name.toLowerCase();
            if (lower.includes('hips') || lower.includes('pelvis')) hips = o;
        });
        this.skinnedHips = hips;
        if (hips) this.skinnedHipsBindLocal.copy((hips as THREE.Object3D).position);
        this.skinnedGrounding = new SkinnedGrounding(root, hips, this.skinnedFootBones);
    }

    /**
     * The rig's corrections from the composed pose's space to its own bind (see
     * SkinnedRetargetSpace). `source` sets that space if no clip skeleton has
     * been read yet. Null while none has — the pose is then applied uncorrected
     * for that frame, which is exact for a canonical rig.
     */
    private resolveSkinnedRetargetDeltas(
        source: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null,
    ): ReadonlyMap<string, THREE.Quaternion> | null {
        const space = this.skinnedRetarget;
        if (!space) return null;
        this.clipRestCorrection(source);
        return space.hasReference() ? space.getRigDeltas() : null;
    }

    /**
     * What brings one clip player into the composed pose's space, whatever rest
     * pose and hips height its own skeleton has (SkinnedRetargetSpace). Null on
     * the block path and for a skeleton that matches the reference — every
     * engine clip — so the ordinary case costs one WeakMap lookup per player.
     */
    private clipRestCorrection(
        player: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null | undefined,
    ): ClipRestCorrection | null {
        const space = this.skinnedRetarget;
        if (!space || !player) return null;
        const known = space.getClipCorrection(player);
        if (known !== undefined) return known;
        const first = !space.hasReference();
        const sourceBones = player.getBoneMap();
        const correction = space.addClip(player, player.getRestRotations(), player.getRestHipsOffset(), this.skinnedBoneMap.keys(),
            (rigBone) => CharacterLoader.resolveMixamoBone(rigBone, sourceBones)?.name ?? null);
        if (first && space.getRigDeltas().size > 0) {
            console.log(`CharacterLoader: skinned rig bind differs from the clip skeleton on ${space.getRigDeltas().size} bones — retargeting`);
        }
        // Once per clip, not per character: a crowd loads the same clip hundreds of times.
        const label = player.getAnimationName();
        if (correction && !CharacterLoader.reportedRestClips.has(label)) {
            CharacterLoader.reportedRestClips.add(label);
            console.log(`CharacterLoader: clip "${label}" rests differently from the reference clip `
                + `(${correction.rotations?.size ?? 0} bone rotations${correction.hipsShift ? ', hips position' : ''}) — correcting for its own rest pose`);
        }
        return correction;
    }
    private static readonly reportedRestClips = new Set<string>();

    /** Aim `reader` at one clip player for this frame, so its bones read in the composed pose's space. */
    private beginClipRead(
        reader: ClipBoneReader,
        player: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null | undefined,
    ): ClipBoneReader {
        const correction = this.clipRestCorrection(player);
        if (!correction?.hipsShift) return reader.begin(correction, null);
        // The shift is in the clip skeleton root's frame, which follows the character.
        const frame = player?.getSkeletonRoot() ?? this.characterGroup;
        return reader.begin(correction, frame ? frame.getWorldQuaternion(CharacterLoader._rootQuat) : null);
    }

    /**
     * The real skinned glTF skeleton root (null outside skinned-render mode).
     * Bone lookups for attachments must search inside this root: the character
     * group also holds invisible full-skeleton clones with identical bone
     * names (action layer, Mixamo track skeletons), and a group-wide search
     * can land on one of those — making attached objects invisible.
     */
    getSkinnedSkeletonRoot(): THREE.Object3D | null {
        return this.skinnedSkeletonRoot;
    }

    /**
     * Register a weapon-grip IK target for one arm of the skinned character.
     * The arm's bone chain is posed each frame so the hand reaches
     * `target`'s world transform + `offset`, with the hand oriented by
     * `rotation`. Mirrors BlockCharacterRenderer.setArmAttachmentOverride for
     * the skinned render path. No-op references are kept until cleared.
     */
    setSkinnedArmGrip(
        side: 'left' | 'right',
        target: THREE.Object3D,
        offset: THREE.Vector3,
        rotation: THREE.Euler,
    ): void {
        this.skinnedArmGrips.set(side, { target, offset: offset.clone(), rotation: rotation.clone() });
        this.skinnedArmBones.delete(side); // force re-resolve against current skeleton
    }

    /** Clear a previously set skinned arm grip. */
    clearSkinnedArmGrip(side: 'left' | 'right'): void {
        this.skinnedArmGrips.delete(side);
        this.skinnedArmBones.delete(side);
    }

    // Resolved arm bones per side, cached across frames (re-resolved when a grip
    // is (re)set, since the skeleton can be swapped on character change).
    private skinnedArmBones = new Map<'left' | 'right', ReturnType<typeof resolveArmBones>>();

    /** Pose every gripping arm onto its weapon grip. */
    private applySkinnedArmGrips(root: THREE.Object3D): void {
        fitRangedWeaponToArmReach(root, this.skinnedArmGrips);
        for (const [side, grip] of this.skinnedArmGrips) {
            let bones = this.skinnedArmBones.get(side);
            if (bones === undefined) {
                bones = resolveArmBones(root, side);
                this.skinnedArmBones.set(side, bones);
                if (!bones) {
                    console.warn(`CharacterLoader: could not resolve ${side} arm bones (upperArm/forearm/hand) for weapon grip — check rig bone names`);
                }
            }
            if (!bones) continue;
            solveArmGrip(root, side, bones, grip);
        }
    }

    /**
     * Access the block character renderer's internal boneMap. The renderer
     * doesn't expose it publicly, so we reach in via a typed cast at one place
     * instead of repeating the cast at every blend site.
     */
    private getStandardBoneMap(): Map<string, THREE.Bone> | null {
        if (this.blockCharacterRenderer) {
            const map = (this.blockCharacterRenderer as unknown as { boneMap?: Map<string, THREE.Bone> }).boneMap;
            if (map) return map;
        }
        // Skinned path with no block renderer: build a name→bone map straight
        // from the glTF skeleton so the blend functions work identically.
        if (this.skinnedSkeletonRoot) {
            return this.skinnedBoneMap.size > 0 ? this.skinnedBoneMap : null;
        }
        return null;
    }

    /**
     * Start a fresh frame's pose map (see `posePool`): the output map is emptied
     * and returned; `poseSlot` fills it bone by bone with pooled storage.
     */
    private beginPose(): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        this.poseOut.clear();
        return this.poseOut;
    }

    /** The pooled entry for `name`, registered in this frame's output map. */
    private poseSlot(name: string): { position: THREE.Vector3; rotation: THREE.Quaternion } {
        let entry = this.posePool.get(name);
        if (!entry) {
            entry = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
            this.posePool.set(name, entry);
        }
        this.poseOut.set(name, entry);
        return entry;
    }

    /**
     * Blend standard skeleton with a single Mixamo player (uniform weight).
     * Used when only one track has a Mixamo player and no per-body-part split.
     */
    protected blendBoneTransforms(
        mixamoPlayer: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer,
        blendWeight: number
    ): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        const blendedTransforms = this.beginPose();
        this.trackRotationBlend.begin(`single:${mixamoPlayer.getSkeletonRoot()?.uuid}:${mixamoPlayer.getPlayRevision()}`);

        const mixamoBoneMap = mixamoPlayer.getBoneMap();

        if (this.characterGroup) {
            this.characterGroup.updateMatrixWorld(true);
        }
        const mixamoSkeleton = mixamoPlayer.getSkeletonRoot();
        if (mixamoSkeleton) {
            mixamoSkeleton.updateMatrixWorld(true);
        }

        const standardBoneMap = this.getStandardBoneMap();
        if (!standardBoneMap) return blendedTransforms;
        const read = this.beginClipRead(this.clipReadA, mixamoPlayer);

        const standardPos = new THREE.Vector3();
        const standardRot = new THREE.Quaternion();
        const mixamoPos = new THREE.Vector3();
        const mixamoRot = new THREE.Quaternion();
        for (const [boneName, standardBone] of standardBoneMap) {
            const mixamoBone = this.findMixamoBone(boneName, mixamoBoneMap);

            if (mixamoBone) {
                if (blendWeight < 1) this.readStandardTransform(standardBone, standardPos, standardRot);

                mixamoBone.updateMatrixWorld(true);
                read.position(mixamoBone, mixamoPos);
                read.rotation(mixamoBone, boneName, mixamoRot);

                const slot = this.poseSlot(boneName);
                if (blendWeight >= 1) { slot.position.copy(mixamoPos); slot.rotation.copy(mixamoRot); continue; }
                slot.position.lerpVectors(standardPos, mixamoPos, blendWeight);
                this.trackRotationBlend.sample(boneName, slot.rotation, standardRot, mixamoRot, blendWeight);
            }
        }

        return blendedTransforms;
    }

    /**
     * Apply movement-system stance offsets (a held posture like a snowboard
     * crouch) to the Mixamo skeleton's LOCAL bone rotations before the world
     * pose is read, so Three's forward-kinematics carries them — and the
     * hierarchy — through to the visible character with no manual FK. Returns
     * the originals so the skeleton is left exactly as the mixer set it.
     */
    private applyManualBoneOffsets(
        boneMap: Map<string, THREE.Bone>,
    ): Array<{ bone: THREE.Bone; orig: THREE.Quaternion }> {
        const offsets = this.animController?.getManualBoneOffsets?.();
        if (!offsets || offsets.size === 0) return [];
        const restore: Array<{ bone: THREE.Bone; orig: THREE.Quaternion }> = [];
        for (const [part, offset] of offsets) {
            const bone = CharacterLoader.findBoneForPart(part, boneMap);
            if (bone) {
                restore.push({ bone, orig: bone.quaternion.clone() });
                bone.quaternion.multiply(offset);
            }
        }
        return restore;
    }

    private restoreManualBoneOffsets(restore: Array<{ bone: THREE.Bone; orig: THREE.Quaternion }>): void {
        for (const { bone, orig } of restore) bone.quaternion.copy(orig);
    }

    private static findBoneForPart(part: string, boneMap: Map<string, THREE.Bone>): THREE.Bone | null {
        const candidates = BlockCharacterRenderer.boneNamesForPart(part);
        for (const name of candidates) {
            const bone = boneMap.get(name);
            if (bone) return bone;
        }
        const lower = candidates.map((n) => n.toLowerCase());
        for (const [bn, b] of boneMap) {
            if (lower.includes(bn.toLowerCase())) return b;
        }
        return null;
    }

    /** Plant both feet at the movement system's foot IK targets (e.g. bolted to
     *  a snowboard), knees solving to reach them. Runs after the body pose so
     *  the hips sit correctly; only the leg bones are overridden, so the feet
     *  stay on the board however the upper body twists. */
    private applyLegIk(): void {
        const targets = this.animController?.getFootIkTargets?.();
        if (!targets) return;
        const boneMap = this.getStandardBoneMap();
        if (!boneMap) return;
        const left = this.resolveLeg('left', boneMap);
        const right = this.resolveLeg('right', boneMap);
        if (left) solveLegIK(targets.facing, left, targets.left);
        if (right) solveLegIK(targets.facing, right, targets.right);
    }

    private resolveLeg(side: 'left' | 'right', boneMap: Map<string, THREE.Bone>): LegBones | null {
        const thigh = CharacterLoader.findBoneForPart(`${side}Thigh`, boneMap);
        const shin = CharacterLoader.findBoneForPart(`${side}Shin`, boneMap);
        const foot = CharacterLoader.findBoneForPart(`${side}Foot`, boneMap);
        return thigh && shin && foot ? { thigh, shin, foot } : null;
    }

    /** Plant both feet on the board within the world-space pose MAP (the Mixamo/
     *  action override render path — what this character actually uses). */
    private applyLegIkToMap(map: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>): void {
        const targets = this.animController?.getFootIkTargets?.();
        if (!targets) return;
        const lk = this.resolveLegMapKeys(map, 'left');
        const rk = this.resolveLegMapKeys(map, 'right');
        if (lk) solveLegIKMap(map, lk, targets.facing, targets.left);
        if (rk) solveLegIKMap(map, rk, targets.facing, targets.right);
    }

    private resolveLegMapKeys(
        map: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>,
        side: 'left' | 'right',
    ): { thigh: string; shin: string; foot: string } | null {
        const thigh = CharacterLoader.findKeyForPart(`${side}Thigh`, map);
        const shin = CharacterLoader.findKeyForPart(`${side}Shin`, map);
        const foot = CharacterLoader.findKeyForPart(`${side}Foot`, map);
        return thigh && shin && foot ? { thigh, shin, foot } : null;
    }

    private static findKeyForPart(
        part: string,
        map: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>,
    ): string | null {
        const candidates = BlockCharacterRenderer.boneNamesForPart(part);
        for (const name of candidates) if (map.has(name)) return name;
        const lower = candidates.map((n) => n.toLowerCase());
        for (const k of map.keys()) if (lower.includes(k.toLowerCase())) return k;
        return null;
    }

    /**
     * Blend two Mixamo players during a crossfade transition (e.g. idle→walk).
     * @param outgoing - The player being faded out
     * @param incoming - The new player being faded in
     * @param progress - 0 = 100% outgoing, 1 = 100% incoming
     */
    protected blendTwoMixamoPlayers(
        outgoing: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer,
        incoming: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer,
        progress: number
    ): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        const blendedTransforms = this.beginPose();

        this.locomotionRotationBlend.begin(`${outgoing.getSkeletonRoot()?.uuid}:${outgoing.getPlayRevision()}:${incoming.getSkeletonRoot()?.uuid}:${incoming.getPlayRevision()}`);

        const outBoneMap = outgoing.getBoneMap();
        const inBoneMap = incoming.getBoneMap();

        const outSkeleton = outgoing.getSkeletonRoot();
        const inSkeleton = incoming.getSkeletonRoot();
        if (outSkeleton) outSkeleton.updateMatrixWorld(true);
        if (inSkeleton) inSkeleton.updateMatrixWorld(true);

        const standardBoneMap = this.getStandardBoneMap();
        if (!standardBoneMap) return blendedTransforms;
        // Each side in the composed pose's space BEFORE the blend: the two clips
        // need not rest alike, and no single correction afterwards fits both.
        const readOut = this.beginClipRead(this.clipReadA, outgoing);
        const readIn = this.beginClipRead(this.clipReadB, incoming);

        const outPos = new THREE.Vector3();
        const outRot = new THREE.Quaternion();
        const inPos = new THREE.Vector3();
        const inRot = new THREE.Quaternion();

        for (const [boneName] of standardBoneMap) {
            const outBone = this.findMixamoBone(boneName, outBoneMap);
            const inBone = this.findMixamoBone(boneName, inBoneMap);

            if (outBone && inBone) {
                readOut.position(outBone, outPos);
                readOut.rotation(outBone, boneName, outRot);
                readIn.position(inBone, inPos);
                readIn.rotation(inBone, boneName, inRot);

                const slot = this.poseSlot(boneName);
                slot.position.lerpVectors(outPos, inPos, progress);
                this.locomotionRotationBlend.sample(boneName, slot.rotation, outRot, inRot, progress);
            } else if (inBone) {
                // Only incoming has this bone — use it directly
                const slot = this.poseSlot(boneName);
                readIn.position(inBone, slot.position);
                readIn.rotation(inBone, boneName, slot.rotation);
            }
        }

        return blendedTransforms;
    }

    /**
     * Two-track blender: blends Track A and Track B per-body-part.
     *
     * Track A source: trackAMixamo skeleton if set, otherwise the standard skeleton.
     * Track B source: trackBMixamo skeleton if set, otherwise the action layer bones.
     *
     * Per-bone weight = lerp(trackBlend.lowerBody, trackBlend.upperBody, t)
     *   where t comes from getBoneBlendCurve(): hips=0, spine ramps 1/N..N/N,
     *   arms/head=1, legs=0. So weight 0 = 100% Track A, 1 = 100% Track B,
     *   and bones along the spine smoothly graduate between the two.
     *
     * Uses offset-based blending around blendedRootPos (the root bone lerped
     * at its own curve weight, which is 0 → trackBlend.lowerBody). Each bone
     * is then placed at blendedRootPos + lerp(offsetFromRootA, offsetFromRootB,
     * boneWeight), so source skeletons with different proportions don't cause
     * vertical disconnects — the assembly is glued to whichever track owns
     * the hips.
     */
    protected blendTwoTracks(
        trackAMixamo: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null,
        trackBMixamo: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null,
        trackBActionBoneMap: Map<string, THREE.Bone> | null,
        trackBlend: { upperBody: number; lowerBody: number },
        resolvedA?: AnimationPose,
    ): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        const blendedTransforms = this.beginPose();
        this.trackRotationBlend.begin(`${trackAMixamo?.getSkeletonRoot()?.uuid}:${trackAMixamo?.getPlayRevision()}:${trackBMixamo?.getSkeletonRoot()?.uuid}:${trackBMixamo?.getPlayRevision()}:${this.animController?.getActionSkeletonRoot()?.uuid}`);
        const standardBoneMap = this.getStandardBoneMap();
        if (!standardBoneMap) return blendedTransforms;

        // Prepare sources
        if (this.characterGroup) {
            this.characterGroup.updateMatrixWorld(true);
        }
        const trackABoneMap = trackAMixamo?.getBoneMap() ?? null;
        const trackBBoneMap = trackBMixamo?.getBoneMap() ?? null;
        // An action clip need not rest like the locomotion under it.
        const readA = this.beginClipRead(this.clipReadA, trackAMixamo);
        const readB = this.beginClipRead(this.clipReadB, trackBMixamo);
        // Bones each track's clip poses. Bones outside a track's set are at the
        // Mixamo skeleton's bind pose — blending toward them at high weight
        // leaks T-pose. Treat each track as "no contribution" for any bone it
        // doesn't pose so the other track (or the only-posing side) dominates
        // instead. A joint the clip holds still BETWEEN animated joints is posed
        // (getPosedBoneNames): handing it to the other track would kink the chain.
        const animatedA: ReadonlySet<string> = trackAMixamo ? trackAMixamo.getPosedBoneNames() : new Set<string>();
        const animatedB: ReadonlySet<string> = trackBMixamo ? trackBMixamo.getPosedBoneNames() : new Set<string>();

        if (trackAMixamo) {
            const root = trackAMixamo.getSkeletonRoot();
            if (root) root.updateMatrixWorld(true);
        }
        if (trackBMixamo) {
            const root = trackBMixamo.getSkeletonRoot();
            if (root) root.updateMatrixWorld(true);
        }
        if (trackBActionBoneMap) {
            const actionRoot = this.animController?.getActionSkeletonRoot?.();
            if (actionRoot && this.characterGroup) {
                actionRoot.position.copy(this.characterGroup.position);
                actionRoot.rotation.copy(this.characterGroup.rotation);
                actionRoot.scale.copy(this.characterGroup.scale);
                actionRoot.updateMatrixWorld(true);
            }
        }

        const posA = new THREE.Vector3();
        const rotA = new THREE.Quaternion();
        const posB = new THREE.Vector3();
        const rotB = new THREE.Quaternion();

        // Offset-based blending: find root positions for both tracks
        let rootPosA: THREE.Vector3 | null = null;
        let rootPosB: THREE.Vector3 | null = null;
        let blendedRootPos: THREE.Vector3 | null = null;

        let rootBone: THREE.Bone | null = null;
        for (const [, bone] of standardBoneMap) {
            if (!bone.parent || !standardBoneMap.has(bone.parent.name)) {
                rootBone = bone;
                break;
            }
        }

        if (rootBone) {
            rootPosA = this.getTrackBonePos(rootBone, trackABoneMap, readA, null, CharacterLoader._rootPosA);
            const rootA = resolvedA?.get(rootBone.name);
            if (rootA) rootPosA = CharacterLoader._rootPosA.copy(rootA.position);
            rootPosB = this.getTrackBonePos(rootBone, trackBBoneMap, readB, trackBActionBoneMap, CharacterLoader._rootPosB);
            if (rootPosA && rootPosB) {
                const rootWeight = this.getBoneBlendWeight(rootBone.name, trackBlend);
                blendedRootPos = CharacterLoader._blendedRootPos.lerpVectors(rootPosA, rootPosB, rootWeight);
            }
        }

        const useOffsetBlend = !!(rootPosA && rootPosB && blendedRootPos);

        for (const [boneName, standardBone] of standardBoneMap) {
            // Get Track A bone transform
            const inA = this.getTrackBoneTransform(boneName, standardBone, trackABoneMap, readA, null, posA, rotA);
            const boneA = resolvedA?.get(boneName);
            if (boneA) { posA.copy(boneA.position); rotA.copy(boneA.rotation); }
            // Get Track B bone transform
            const inB = this.getTrackBoneTransform(boneName, standardBone, trackBBoneMap, readB, trackBActionBoneMap, posB, rotB);

            // A joint NEITHER track's skeleton has (a face joint, a twist bone) gets
            // no entry, exactly as on a single track: it keeps its bind rotation
            // under its posed parent. Blending the two stand-in rest poses instead
            // pinned it to its REST orientation in the world while its parent turned.
            if (inA || inB || boneA) {
                const bodyWeight = this.getBoneBlendWeight(boneName, trackBlend);
                // Resolve the Mixamo bone names to check track coverage. If a
                // track's clip doesn't animate this bone, clamp toward the
                // other side so the bind-pose'd Mixamo bone doesn't leak in.
                const trackABoneName = trackABoneMap ? (this.findMixamoBone(boneName, trackABoneMap)?.name ?? boneName) : boneName;
                const trackBBoneName = trackBBoneMap ? (this.findMixamoBone(boneName, trackBBoneMap)?.name ?? boneName) : boneName;
                const aHasBone = animatedA.size === 0 || animatedA.has(trackABoneName);
                const bHasBone = animatedB.size === 0 || animatedB.has(trackBBoneName);
                let weight: number;
                if (aHasBone && bHasBone) weight = bodyWeight;
                else if (aHasBone) weight = 0;       // only A animates → use A
                else if (bHasBone) weight = 1;       // only B animates → use B
                else weight = bodyWeight;             // neither animates (bind on both) — use raw blend

                const slot = this.poseSlot(boneName);
                if (useOffsetBlend) {
                    // lerp(rootA + (posA-rootA), rootB + (posB-rootB)) with the root
                    // blended by its own weight: the bone's offset from its root
                    // blends, then rides the blended root.
                    CharacterLoader._offsetA.subVectors(posA, rootPosA!);
                    CharacterLoader._offsetB.subVectors(posB, rootPosB!);
                    slot.position.lerpVectors(CharacterLoader._offsetA, CharacterLoader._offsetB, weight).add(blendedRootPos!);
                } else {
                    slot.position.lerpVectors(posA, posB, weight);
                }
                this.trackRotationBlend.sample(boneName, slot.rotation, rotA, rotB, weight);
            }
        }

        return blendedTransforms;
    }

    /**
     * Get world position of a bone from a Mixamo bone map (or standard bone as fallback).
     */
    private getTrackBonePos(
        standardBone: THREE.Bone,
        mixamoBoneMap: Map<string, THREE.Bone> | null,
        read: ClipBoneReader,
        actionBoneMap: Map<string, THREE.Bone> | null,
        pos: THREE.Vector3,
    ): THREE.Vector3 | null {
        if (mixamoBoneMap) {
            const bone = this.findMixamoBone(standardBone.name, mixamoBoneMap);
            if (bone) { bone.updateMatrixWorld(true); return read.position(bone, pos); }
        }
        if (actionBoneMap) {
            const bone = actionBoneMap.get(standardBone.name);
            if (bone) { bone.updateMatrixWorld(true); bone.getWorldPosition(pos); return pos; }
        }
        this.readStandardTransform(standardBone, pos, CharacterLoader._scratchQuat);
        return pos;
    }

    /**
     * Get bone transform from a track source. Tries Mixamo map first, then action
     * layer, then falls back to the standard skeleton. `read` is aimed at the
     * Mixamo player (see beginClipRead); the other two sources are read as they are.
     *
     * Always writes `outPos`/`outRot`. Returns whether they are the track's OWN:
     * false when a clip or action skeleton was given but lacks this bone, so the
     * values are only the standard skeleton standing in. With neither given the
     * standard skeleton IS the track, and the answer is true.
     */
    private getTrackBoneTransform(
        boneName: string,
        standardBone: THREE.Bone,
        mixamoBoneMap: Map<string, THREE.Bone> | null,
        read: ClipBoneReader,
        actionBoneMap: Map<string, THREE.Bone> | null,
        outPos: THREE.Vector3,
        outRot: THREE.Quaternion
    ): boolean {
        if (mixamoBoneMap) {
            const bone = this.findMixamoBone(boneName, mixamoBoneMap);
            if (bone) {
                bone.updateMatrixWorld(true);
                read.position(bone, outPos);
                read.rotation(bone, boneName, outRot);
                return true;
            }
        }
        if (actionBoneMap) {
            const bone = actionBoneMap.get(boneName);
            if (bone) {
                bone.updateMatrixWorld(true);
                bone.getWorldPosition(outPos);
                bone.getWorldQuaternion(outRot);
                return true;
            }
        }
        // Fall back to standard skeleton
        this.readStandardTransform(standardBone, outPos, outRot);
        return !mixamoBoneMap && !actionBoneMap;
    }

    private readStandardTransform(bone: THREE.Bone, position: THREE.Vector3, rotation: THREE.Quaternion): void {
        const rest = this.skinnedFallbackPose.get(bone.name);
        if (!rest) { bone.getWorldPosition(position); bone.getWorldQuaternion(rotation); return; }
        position.copy(rest.position);
        rotation.copy(rest.rotation);
        if (this.characterGroup) {
            this.characterGroup.updateWorldMatrix(true, false);
            position.applyMatrix4(this.characterGroup.matrixWorld);
            rotation.premultiply(this.characterGroup.getWorldQuaternion(CharacterLoader._parentWorldQuat));
        }
        // The shared pose map is SOURCE space. Remove the target bind delta
        // here because applyPoseRotations applies it exactly once afterwards.
        const source = this.animController?.getTrackAMixamoPlayer() ?? this.animController?.getTrackBMixamoPlayer() ?? null;
        const delta = this.resolveSkinnedRetargetDeltas(source)?.get(bone.name);
        if (delta) rotation.multiply(CharacterLoader._parentWorldQuat.copy(delta).invert());
    }

    /**
     * Blend locomotion (main skeleton) with action animation (cloned skeleton)
     * using separate weights for upper and lower body.
     */
    protected blendActionBoneTransforms(
        actionBoneMap: Map<string, THREE.Bone>,
        blend: { upperBody: number; lowerBody: number }
    ): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        const blendedTransforms = this.beginPose();

        if (this.characterGroup) {
            this.characterGroup.updateMatrixWorld(true);
        }

        // Sync action skeleton position with main character so bone world transforms match
        const actionRoot = this.animController?.getActionSkeletonRoot?.();
        if (actionRoot && this.characterGroup) {
            actionRoot.position.copy(this.characterGroup.position);
            actionRoot.rotation.copy(this.characterGroup.rotation);
            actionRoot.scale.copy(this.characterGroup.scale);
            actionRoot.updateMatrixWorld(true);
        }

        const standardBoneMap = this.getStandardBoneMap();
        if (!standardBoneMap) return blendedTransforms;

        const standardPos = new THREE.Vector3();
        const standardRot = new THREE.Quaternion();
        const actionPos = new THREE.Vector3();
        const actionRot = new THREE.Quaternion();

        for (const [boneName, standardBone] of standardBoneMap) {
            standardBone.updateMatrixWorld(true);
            standardBone.getWorldPosition(standardPos);
            standardBone.getWorldQuaternion(standardRot);

            const weight = this.getBoneBlendWeight(boneName, blend);

            // Action skeleton is a clone of the main skeleton, so bone names match directly.
            const actionBone = actionBoneMap.get(boneName);

            if (actionBone && weight > 0) {
                actionBone.updateMatrixWorld(true);
                actionBone.getWorldPosition(actionPos);
                actionBone.getWorldQuaternion(actionRot);

                const slot = this.poseSlot(boneName);
                slot.position.lerpVectors(standardPos, actionPos, weight);
                CharacterLoader.hemisphereSlerp(slot.rotation, standardRot, actionRot, weight);
            } else {
                const slot = this.poseSlot(boneName);
                slot.position.copy(standardPos);
                slot.rotation.copy(standardRot);
            }
        }

        return blendedTransforms;
    }

    /**
     * Per-bone blend weight along the spine. 0 = lower-body weight (legs,
     * hips), 1 = upper-body weight (arms, head). Spine bones ramp smoothly
     * between the two so the transition between (run legs) and (swing arms)
     * doesn't visibly kink at one joint. Built lazily from the skeleton.
     */
    private boneBlendCurve: Map<string, number> | null = null;

    /**
     * Build per-bone weight curve:
     * - Hips/root: 0 (legs dominate via lowerBody)
     * - Spine chain: ramps 1/N → N/N (N = spine length), so the topmost
     *   spine bone is fully upperBody and intermediate spines smoothly
     *   interpolate. This is what makes "run legs + swing arms" look like
     *   one body instead of two halves bolted together.
     * - Spine subtree above the chain (neck, head, shoulders, arms): 1.
     * - Non-spine subtrees of root (legs, feet): 0.
     */
    private getBoneBlendCurve(): Map<string, number> {
        if (this.boneBlendCurve) return this.boneBlendCurve;

        const curve = new Map<string, number>();
        this.boneBlendCurve = curve;

        const boneMap = this.getStandardBoneMap();
        if (!boneMap || boneMap.size === 0) return curve;

        let rootBone: THREE.Bone | null = null;
        for (const [, bone] of boneMap) {
            if (!bone.parent || !boneMap.has(bone.parent.name)) {
                rootBone = bone;
                break;
            }
        }
        if (!rootBone) return curve;

        const isSpine = (b: THREE.Object3D) => (b as THREE.Bone).isBone && b.name.toLowerCase().includes('spine');

        const spineChain: THREE.Bone[] = [];
        let next: THREE.Bone | null = (rootBone.children.find(isSpine) as THREE.Bone | undefined) ?? null;
        while (next) {
            spineChain.push(next);
            next = (next.children.find(isSpine) as THREE.Bone | undefined) ?? null;
        }

        curve.set(rootBone.name, 0);

        const denom = Math.max(1, spineChain.length);
        for (let i = 0; i < spineChain.length; i++) {
            curve.set(spineChain[i]!.name, (i + 1) / denom);
        }

        if (spineChain.length > 0) {
            const top = spineChain[spineChain.length - 1]!;
            const markUpper = (obj: THREE.Object3D) => {
                if ((obj as THREE.Bone).isBone && !curve.has(obj.name)) {
                    curve.set(obj.name, 1);
                }
                for (const child of obj.children) markUpper(child);
            };
            for (const child of top.children) markUpper(child);
        }

        const markLower = (obj: THREE.Object3D) => {
            if ((obj as THREE.Bone).isBone && !curve.has(obj.name)) {
                curve.set(obj.name, 0);
            }
            for (const child of obj.children) markLower(child);
        };
        for (const child of rootBone.children) {
            if (isSpine(child)) continue;
            markLower(child);
        }

        return curve;
    }

    /**
     * Compute the effective blend weight for a bone:
     *   0 → trackBlend.lowerBody, 1 → trackBlend.upperBody, in between → lerp.
     */
    private getBoneBlendWeight(
        boneName: string,
        blend: { upperBody: number; lowerBody: number }
    ): number {
        const t = this.getBoneBlendCurve().get(boneName) ?? 0;
        return blend.lowerBody + (blend.upperBody - blend.lowerBody) * t;
    }

    private static readonly BONE_MAPPINGS: Record<string, string[]> = {
        // Core skeleton
        'pelvis': ['mixamorig2Hips', 'mixamorigHips', 'Hips'],
        'spine_01': ['mixamorig2Spine', 'mixamorigSpine', 'Spine'],
        'spine_02': ['mixamorig2Spine1', 'mixamorigSpine1', 'Spine1'],
        'spine_03': ['mixamorig2Spine2', 'mixamorigSpine2', 'Spine2'],
        'neck_01': ['mixamorig2Neck', 'mixamorigNeck', 'Neck'],
        'head': ['mixamorig2Head', 'mixamorigHead', 'Head'],
        'clavicle_l': ['mixamorig2LeftShoulder', 'mixamorigLeftShoulder', 'LeftShoulder'],
        'clavicle_r': ['mixamorig2RightShoulder', 'mixamorigRightShoulder', 'RightShoulder'],
        'upperarm_l': ['mixamorig2LeftArm', 'mixamorigLeftArm', 'LeftArm'],
        'upperarm_r': ['mixamorig2RightArm', 'mixamorigRightArm', 'RightArm'],
        'lowerarm_l': ['mixamorig2LeftForeArm', 'mixamorigLeftForeArm', 'LeftForeArm'],
        'lowerarm_r': ['mixamorig2RightForeArm', 'mixamorigRightForeArm', 'RightForeArm'],
        'hand_l': ['mixamorig2LeftHand', 'mixamorigLeftHand', 'LeftHand'],
        'hand_r': ['mixamorig2RightHand', 'mixamorigRightHand', 'RightHand'],
        'thigh_l': ['mixamorig2LeftUpLeg', 'mixamorigLeftUpLeg', 'LeftUpLeg'],
        'thigh_r': ['mixamorig2RightUpLeg', 'mixamorigRightUpLeg', 'RightUpLeg'],
        'calf_l': ['mixamorig2LeftLeg', 'mixamorigLeftLeg', 'LeftLeg'],
        'calf_r': ['mixamorig2RightLeg', 'mixamorigRightLeg', 'RightLeg'],
        'foot_l': ['mixamorig2LeftFoot', 'mixamorigLeftFoot', 'LeftFoot'],
        'foot_r': ['mixamorig2RightFoot', 'mixamorigRightFoot', 'RightFoot'],
        // Toes
        'ball_l': ['mixamorig2LeftToeBase', 'mixamorigLeftToeBase', 'LeftToeBase'],
        'ball_r': ['mixamorig2RightToeBase', 'mixamorigRightToeBase', 'RightToeBase'],
        // Left hand fingers
        'thumb_01_l': ['mixamorig2LeftHandThumb1', 'mixamorigLeftHandThumb1', 'LeftHandThumb1'],
        'thumb_02_l': ['mixamorig2LeftHandThumb2', 'mixamorigLeftHandThumb2', 'LeftHandThumb2'],
        'thumb_03_l': ['mixamorig2LeftHandThumb3', 'mixamorigLeftHandThumb3', 'LeftHandThumb3'],
        'index_01_l': ['mixamorig2LeftHandIndex1', 'mixamorigLeftHandIndex1', 'LeftHandIndex1'],
        'index_02_l': ['mixamorig2LeftHandIndex2', 'mixamorigLeftHandIndex2', 'LeftHandIndex2'],
        'index_03_l': ['mixamorig2LeftHandIndex3', 'mixamorigLeftHandIndex3', 'LeftHandIndex3'],
        'middle_01_l': ['mixamorig2LeftHandMiddle1', 'mixamorigLeftHandMiddle1', 'LeftHandMiddle1'],
        'middle_02_l': ['mixamorig2LeftHandMiddle2', 'mixamorigLeftHandMiddle2', 'LeftHandMiddle2'],
        'middle_03_l': ['mixamorig2LeftHandMiddle3', 'mixamorigLeftHandMiddle3', 'LeftHandMiddle3'],
        'ring_01_l': ['mixamorig2LeftHandRing1', 'mixamorigLeftHandRing1', 'LeftHandRing1'],
        'ring_02_l': ['mixamorig2LeftHandRing2', 'mixamorigLeftHandRing2', 'LeftHandRing2'],
        'ring_03_l': ['mixamorig2LeftHandRing3', 'mixamorigLeftHandRing3', 'LeftHandRing3'],
        'pinky_01_l': ['mixamorig2LeftHandPinky1', 'mixamorigLeftHandPinky1', 'LeftHandPinky1'],
        'pinky_02_l': ['mixamorig2LeftHandPinky2', 'mixamorigLeftHandPinky2', 'LeftHandPinky2'],
        'pinky_03_l': ['mixamorig2LeftHandPinky3', 'mixamorigLeftHandPinky3', 'LeftHandPinky3'],
        // Right hand fingers
        'thumb_01_r': ['mixamorig2RightHandThumb1', 'mixamorigRightHandThumb1', 'RightHandThumb1'],
        'thumb_02_r': ['mixamorig2RightHandThumb2', 'mixamorigRightHandThumb2', 'RightHandThumb2'],
        'thumb_03_r': ['mixamorig2RightHandThumb3', 'mixamorigRightHandThumb3', 'RightHandThumb3'],
        'index_01_r': ['mixamorig2RightHandIndex1', 'mixamorigRightHandIndex1', 'RightHandIndex1'],
        'index_02_r': ['mixamorig2RightHandIndex2', 'mixamorigRightHandIndex2', 'RightHandIndex2'],
        'index_03_r': ['mixamorig2RightHandIndex3', 'mixamorigRightHandIndex3', 'RightHandIndex3'],
        'middle_01_r': ['mixamorig2RightHandMiddle1', 'mixamorigRightHandMiddle1', 'RightHandMiddle1'],
        'middle_02_r': ['mixamorig2RightHandMiddle2', 'mixamorigRightHandMiddle2', 'RightHandMiddle2'],
        'middle_03_r': ['mixamorig2RightHandMiddle3', 'mixamorigRightHandMiddle3', 'RightHandMiddle3'],
        'ring_01_r': ['mixamorig2RightHandRing1', 'mixamorigRightHandRing1', 'RightHandRing1'],
        'ring_02_r': ['mixamorig2RightHandRing2', 'mixamorigRightHandRing2', 'RightHandRing2'],
        'ring_03_r': ['mixamorig2RightHandRing3', 'mixamorigRightHandRing3', 'RightHandRing3'],
        'pinky_01_r': ['mixamorig2RightHandPinky1', 'mixamorigRightHandPinky1', 'RightHandPinky1'],
        'pinky_02_r': ['mixamorig2RightHandPinky2', 'mixamorigRightHandPinky2', 'RightHandPinky2'],
        'pinky_03_r': ['mixamorig2RightHandPinky3', 'mixamorigRightHandPinky3', 'RightHandPinky3'],
    };

    /**
     * Reverse alias map: maps every known bone name (lowercased) to all its
     * alternative names in original case. Built lazily from BONE_MAPPINGS.
     * Handles UE4 <-> Mixamo AND mixamorig <-> mixamorig2 cross-lookups.
     */
    private static _boneAliasMap: Map<string, string[]> | null = null;
    private static getBoneAliasMap(): Map<string, string[]> {
        if (!CharacterLoader._boneAliasMap) {
            const map = new Map<string, string[]>();
            for (const [key, values] of Object.entries(CharacterLoader.BONE_MAPPINGS)) {
                const allNames = [key, ...values];
                for (const name of allNames) {
                    map.set(name.toLowerCase(), allNames.filter(n => n !== name));
                }
            }
            CharacterLoader._boneAliasMap = map;
        }
        return CharacterLoader._boneAliasMap;
    }

    protected findMixamoBone(
        standardBoneName: string,
        mixamoBoneMap: Map<string, THREE.Bone>
    ): THREE.Bone | null {
        const remembered = this.mixamoNameMemo.get(standardBoneName);
        if (remembered !== undefined) {
            const bone = mixamoBoneMap.get(remembered);
            if (bone) return bone;
        }
        const bone = CharacterLoader.resolveMixamoBone(standardBoneName, mixamoBoneMap);
        if (bone) this.mixamoNameMemo.set(standardBoneName, bone.name);
        return bone;
    }

    /**
     * The bone a Mixamo clip drives for one of the character's own bones —
     * exact name, then the alias table (UE4 <-> Mixamo, mixamorig <-> mixamorig2),
     * then a substring match. Static and public because the crowd bake
     * (VxlCrowdVariant) must retarget with exactly the rule the articulated
     * path uses, or the two tiers pose differently at the ring boundary.
     */
    static resolveMixamoBone(
        standardBoneName: string,
        mixamoBoneMap: Map<string, THREE.Bone>
    ): THREE.Bone | null {
        // 1. Exact match
        if (mixamoBoneMap.has(standardBoneName)) {
            return mixamoBoneMap.get(standardBoneName)!;
        }

        // 2. Alias map — handles UE4<->Mixamo and mixamorig<->mixamorig2
        const lowerName = standardBoneName.toLowerCase();
        const aliases = CharacterLoader.getBoneAliasMap().get(lowerName);
        if (aliases) {
            for (const alias of aliases) {
                if (mixamoBoneMap.has(alias)) {
                    return mixamoBoneMap.get(alias)!;
                }
            }
        }

        // 3. Fuzzy substring match (last resort)
        for (const [mixamoName, bone] of mixamoBoneMap) {
            if (mixamoName.toLowerCase().includes(lowerName) ||
                lowerName.includes(mixamoName.toLowerCase())) {
                return bone;
            }
        }

        return null;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.blockCharacterRenderer) {
            this.blockCharacterRenderer.dispose();
            this.blockCharacterRenderer = null;
        }
        this.posePool.clear();
        this.poseOut.clear();
        this.skinnedFallbackPose.clear();
        this.actionTransition.reset();
        this.trackRotationBlend.reset();
        this.locomotionRotationBlend.reset();
        this.mixamoNameMemo.clear();
        this.skinnedFootBones = [];
        this.skinnedHips = null;
        this.skinnedGrounding = null;
        this.blockGrounding = null;
        this.blendedPoseForBlock = null;
    }
}

/**
 * The looks one character can wear — a wardrobe over a single
 * `CharacterLoader`'s block renderer.
 *
 * A look ("outfit", "variant") is a set of MESHES swapped into that renderer's
 * bone-bound body-part groups, never a second character: the groups — and so
 * the bindings and the transforms the last pose wrote — never move. Index 0 is
 * always the set the character was built with. See
 * game/agent-docs/character-outfits.md.
 *
 * PlayerLoader and NpcController expose this through their public variant
 * methods; they differ only in the guards they add (player loaded / NPC alive)
 * and the name they log under.
 */
export class BlockCharacterWardrobe {
    private readonly variants = new Map<number, BlockMeshSet>();
    private activeIndex = 0;
    private warnedHiddenBody = false;

    /**
     * @param loader - Owner of the one block renderer every look is worn by.
     * @param logPrefix - Bracketed owner name for console messages, e.g. `'[PlayerLoader]'`.
     * @param hiddenBodyNote - Why a change of clothes has no visible effect right
     *   now (the block body is only a hidden pose source behind a skinned mesh),
     *   or null while the blocks are what you see. Warned about once.
     */
    constructor(
        private readonly loader: CharacterLoader,
        private readonly logPrefix: string,
        private readonly hiddenBodyNote: () => string | null,
    ) {}

    /** The look currently worn (0 = the original). */
    getActiveIndex(): number {
        return this.activeIndex;
    }

    /** Whether a look is registered under this index. Index 0 always is. */
    has(index: number): boolean {
        return index === 0 || this.variants.has(index);
    }

    /** Pre-build a look under an index so it can be worn later. */
    load(index: number, factory: IBlockCharacterFactory): boolean {
        if (index === 0) {
            console.warn(`${this.logPrefix} Cannot load variant at index 0 - that is reserved for the original character`);
            return false;
        }
        if (this.variants.has(index)) {
            console.warn(`${this.logPrefix} Variant ${index} already exists - disposing old one`);
            this.dispose(index);
        }

        const meshSet = this.build(factory);
        if (!meshSet) return false;

        this.variants.set(index, meshSet);
        console.log(`${this.logPrefix} Loaded block character variant ${index}`);
        return true;
    }

    /** Wear a pre-built look (0 = the original). */
    activate(index: number): boolean {
        if (index === this.activeIndex) return true;

        const renderer = this.loader.getBlockCharacterRenderer();
        if (!renderer) {
            console.warn(`${this.logPrefix} Cannot switch variant - no block character`);
            return false;
        }

        const meshSet = index === 0 ? renderer.getOriginalMeshSet() : this.variants.get(index);
        if (!meshSet) {
            console.warn(`${this.logPrefix} Variant ${index} not found`);
            return false;
        }

        this.wear(renderer, meshSet);
        this.activeIndex = index;
        console.log(`${this.logPrefix} Switched to block character variant ${index}`);
        return true;
    }

    /**
     * One-call change of clothes: build a look from `factory` and put it on,
     * freeing the outgoing one unless the game can still swap back to it.
     */
    redress(factory: IBlockCharacterFactory): boolean {
        const renderer = this.loader.getBlockCharacterRenderer();
        if (!renderer) {
            console.warn(`${this.logPrefix} Cannot redress - no block character`);
            return false;
        }

        const meshSet = this.build(factory);
        if (!meshSet) return false;

        const previous = renderer.getAppliedMeshSet();
        this.wear(renderer, meshSet);
        // The outgoing look is unreachable unless it is a registered variant or
        // the original, both of which the game may still swap back to.
        if (previous !== renderer.getOriginalMeshSet() && !this.isRegistered(previous)) {
            renderer.disposeMeshSet(previous);
        }
        this.activeIndex = 0;
        return true;
    }

    /** Free one registered look. The original (index 0) is never disposed. */
    dispose(index: number): void {
        const meshSet = this.variants.get(index);
        if (index === 0 || !meshSet) return;

        const renderer = this.loader.getBlockCharacterRenderer();
        // A worn set cannot be freed — put the original back on first.
        if (this.activeIndex === index && renderer) {
            this.wear(renderer, renderer.getOriginalMeshSet());
            this.activeIndex = 0;
        }
        renderer?.disposeMeshSet(meshSet);
        this.variants.delete(index);
    }

    /** Free every registered look. Part of the owner's teardown. */
    disposeAll(): void {
        // Snapshot the keys first: dispose() mutates the map.
        for (const index of Array.from(this.variants.keys())) {
            this.dispose(index);
        }
        this.variants.clear();
    }

    /** Put a set on and re-measure: a different silhouette can reach lower or higher than the last one. */
    private wear(renderer: BlockCharacterRenderer, meshSet: BlockMeshSet): void {
        renderer.applyMeshSet(meshSet);
        this.loader.recomputeBlockFeetOffset();
    }

    /** Whether a mesh set is still reachable through a variant index. */
    private isRegistered(meshSet: BlockMeshSet): boolean {
        for (const registered of this.variants.values()) {
            if (registered === meshSet) return true;
        }
        return false;
    }

    /**
     * Build a mesh set from a factory and give it the engine's standard layer
     * and material treatment, so a change of clothes lights exactly like the
     * look it replaces. Returns null (having said why) when the factory produced
     * nothing — applying an empty set would leave an invisible character.
     */
    private build(factory: IBlockCharacterFactory): BlockMeshSet | null {
        const renderer = this.loader.getBlockCharacterRenderer();
        if (!renderer) {
            console.warn(`${this.logPrefix} Cannot build block meshes - no block character`);
            return null;
        }

        if (!this.warnedHiddenBody) {
            const note = this.hiddenBodyNote();
            if (note) {
                this.warnedHiddenBody = true;
                console.warn(`${this.logPrefix} ${note}`);
            }
        }

        let meshCount = 0;
        try {
            const meshSet = renderer.buildMeshSet(factory);
            BlockCharacterRenderer.forEachMeshSetObject(meshSet, child => {
                if ((child as THREE.Mesh).isMesh) meshCount++;
                this.loader.applyBlockPartMaterial(child);
            });
            if (meshCount === 0) {
                console.error(`${this.logPrefix} Block character factory added no meshes to the provided characterGroup — keeping the current look.`);
                return null;
            }
            return meshSet;
        } catch (error) {
            console.error(`${this.logPrefix} Failed to build block character meshes:`, error);
            return null;
        }
    }
}
