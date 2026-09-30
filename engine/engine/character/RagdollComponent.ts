import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

/**
 * One articulated segment of a ragdoll. `nodes` are the source visual groups whose blocks make up
 * this body; `parent` names the segment it's jointed to (`null` for the root hub). A mesh under more
 * than one part's node is assigned to its nearest enclosing node.
 */
export interface RagdollPartSpec {
    name: string;
    parent: string | null;
    nodes: THREE.Object3D[];
    /** Joint to parent (default 'ball'). 'hinge' = single-axis limited revolute (elbows/knees);
     *  honoured only when `RagdollConfig.jointLimits` is on. */
    jointType?: 'ball' | 'hinge';
}

/** Tuning for a ragdoll collapse. Required fields + exported defaults (see game/CLAUDE.md). */
export interface RagdollConfig {
    /** Ms before the corpse is auto-disposed. <=0 = persist until dispose() (player restores on respawn). */
    corpseLifetimeMs: number;
    /** Hinge elbows/knees (vs free ball joints) so the skeleton stays articulated. On by default. */
    jointLimits: boolean;
    /** Let limbs collide with each other so the body heaps in a pile. On by default; turn off if jittery. */
    selfCollision: boolean;
    /** Optional hook to register each ragdoll body (e.g. with a body registry). */
    onBodyCreated: ((body: RAPIER.RigidBody) => void) | null;
}

export const DEFAULT_RAGDOLL_CONFIG: RagdollConfig = {
    corpseLifetimeMs: 15000,
    jointLimits: true,
    selfCollision: true,
    onBodyCreated: null,
};

/**
 * Skinned-character mode: instead of cloning blocks and removing the GLB, KEEP the visible skinned
 * mesh and drive its skeleton bones from the physics bodies. `resolveBone` maps a ragdoll part name
 * to the GLB bone it should drive (null to skip). Return null from getSkinnedRig() for block chars.
 */
export interface SkinnedRagdollRig {
    root: THREE.Object3D;
    resolveBone(partName: string): THREE.Object3D | null;
}

/** Controller-specific operations the ragdoll needs (mirrors ExplosionCallbacks). */
export interface RagdollCallbacks {
    getEngine(): EngineLike;
    getPhysicsWorld(): PhysicsWorld;
    getCharacter(): THREE.Object3D;
    getPhysicsBody(): RAPIER.RigidBody | null;
    /** Restore damage-flash materials before cloning the visible blocks. */
    restoreFlashImmediately(): void;
    /** Resolve the ragdoll skeleton from the current visible character (called at death). */
    collectParts(): RagdollPartSpec[];
    /** Once bodies exist: remove (NPC/animal) or hide (player) the original character + capsule. */
    onPostRagdoll(): void;
    /** Optional: for skinned GLB characters, the rig to drive instead of cloning blocks (null = block path). */
    getSkinnedRig?(): SkinnedRagdollRig | null;
}

interface BuiltPart {
    body: RAPIER.RigidBody;
    /** The body's cuboid collider — kept so self-collision can be dropped after settling. */
    collider: RAPIER.Collider;
    /** Scene-level group of cloned blocks, driven rigidly by `body`. Null in skinned mode. */
    cloneGroup: THREE.Group | null;
    /** World-space center the body started at. */
    center: THREE.Vector3;
    /**
     * Skinned mode: the GLB bone this body drives, and the bone's world rotation at spawn. Each frame
     * the bone gets a LOCAL rotation so its world rotation = bodyRotation · boneRest (bind-pose limb
     * length preserved, like the engine's updateSkinnedCharacter). Null when no bone maps to this part.
     */
    bone: THREE.Object3D | null;
    boneRest: THREE.Quaternion | null;
}

/** Root→leaf order so a driven bone's parent is updated before it each frame. */
const SKIN_DRIVE_ORDER = [
    'torso', 'head', 'leftUpperArm', 'rightUpperArm', 'leftThigh', 'rightThigh',
    'leftLowerArm', 'rightLowerArm', 'leftShin', 'rightShin',
];

/**
 * Collapses a block character into a limp jointed physics ragdoll on death — an alternative to
 * BlockExplosionComponent's debris burst. ragdoll() builds bodies + joints and clones the blocks;
 * syncRagdoll() copies transforms each frame; dispose() tears down (joints → bodies → meshes).
 *
 * Stability: a single NaN body halts ALL physics, so every body gets a flat inertia override + the
 * `__type:'ragdoll'` tag (pre-step safety net clamps it to the debris velocity cap). Rest jitter is
 * tamed by a tight limb-mass ratio, soft CCD + high damping, and dropping self-collision once the
 * pile forms so Rapier auto-sleeps it naturally.
 */
export class RagdollComponent {
    private config: RagdollConfig;
    private callbacks: RagdollCallbacks;

    private parts: Map<string, BuiltPart> = new Map();
    private joints: RAPIER.ImpulseJoint[] = [];
    private active = false;
    private disposeTime = 0;

    // Drop self-collision once the pile forms: limb-vs-limb contacts are the main rest-jitter source,
    // so removing them lets the body settle under gravity + damping and auto-sleep (no forced freeze).
    private spawnMs = 0;
    private selfCollisionDropped = false;
    /** Drop self-collision this long after spawn (collapse is done by ~1.5s). */
    private static readonly SELF_COLLISION_DROP_MS = 1800;
    /** Collider half-extents as a fraction of the visible block, so flush limbs don't self-penetrate
     *  at spawn (the spawn-fling source). */
    private static readonly COLLIDER_SCALE = 0.78;

    // Skinned mode: drive the GLB skeleton from the bodies (set in ragdoll() from getSkinnedRig).
    private rig: SkinnedRagdollRig | null = null;
    private skinnedChar: THREE.Object3D | null = null;
    /** Name of the hub part (parentless — torso), whose bone is anchored to its body each frame. */
    private hubName: string | null = null;

    // Reusable temps for the per-frame sync.
    private syncVec: THREE.Vector3 = new THREE.Vector3();
    private anchorVec: THREE.Vector3 = new THREE.Vector3();
    private boneQuatA: THREE.Quaternion = new THREE.Quaternion();
    private boneQuatB: THREE.Quaternion = new THREE.Quaternion();

    constructor(config: RagdollConfig, callbacks: RagdollCallbacks) {
        this.config = config;
        this.callbacks = callbacks;
    }

    hasRagdoll(): boolean {
        return this.active;
    }

    /**
     * World-space state of the hub (torso) body — used by temporary ragdolls
     * (ski crash bail) to keep cameras following the tumble and to detect
     * when the body has come to rest. Null when no ragdoll is active.
     */
    getHubState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null {
        if (!this.active || !this.hubName) return null;
        const hub = this.parts.get(this.hubName);
        if (!hub) return null;
        const t = hub.body.translation();
        const v = hub.body.linvel();
        return {
            position: { x: t.x, y: t.y, z: t.z },
            velocity: { x: v.x, y: v.y, z: v.z },
            speed: Math.hypot(v.x, v.y, v.z),
        };
    }

    setCorpseLifetimeMs(ms: number): void {
        this.config.corpseLifetimeMs = ms;
        if (this.active) {
            this.disposeTime = ms > 0 ? Date.now() + ms : 0;
        }
    }

    /**
     * Collapse into a ragdoll. `hubVelocity` (world-space m/s) is the killing blow's knockback on the
     * torso (the damage source derives it from the hitter). Omit for a gravity-only collapse.
     *
     * @returns whether a ragdoll was actually built. It reports failure because
     *   the caller marks the character as ragdolled — which stops its AI — and a
     *   silent bail here left NPCs standing frozen where they died, with the
     *   death effects firing around a body that never fell.
     */
    ragdoll(hubVelocity?: THREE.Vector3): boolean {
        if (this.active) return false;
        const engine = this.callbacks.getEngine();
        const physicsWorld = this.callbacks.getPhysicsWorld();
        if (!engine || !engine.scene || !physicsWorld) {
            console.warn('[Ragdoll] no engine/scene/physics world — cannot collapse');
            return false;
        }
        if (isPlaneLockedPhysics(physicsWorld)) {
            // Limbs are 3D dynamic bodies and joints; the 2D lane has neither (and
            // a 2D-only bundle has no rapier3d to build them with). Callers fall
            // back to the death animation.
            console.warn('[Ragdoll] 2D physics lane — ragdoll collapse is 3D-only, skipping');
            return false;
        }

        this.callbacks.restoreFlashImmediately();

        const specs = this.callbacks.collectParts();
        if (specs.length === 0) {
            // Almost always a character with no block-character renderer to
            // decompose, so there is nothing to build limbs from.
            console.warn('[Ragdoll] collectParts() returned no parts — nothing to collapse');
            return false;
        }

        // Skinned characters drive the GLB skeleton instead of cloning blocks (see SkinnedRagdollRig).
        this.rig = this.callbacks.getSkinnedRig?.() ?? null;

        // ...but only if its bones actually resolve.
        //
        // Choosing the skinned path suppresses the cloned-block corpse entirely,
        // on the assumption that the GLB will be driven instead. When the rig
        // resolves NO bones — a character whose skeleton does not use any of the
        // canonical names — `driveSkinnedRig` silently drives nothing, and the
        // result is the worst of both: the mesh stands frozen exactly where it
        // died while the limb bodies fall invisibly beneath it, then the whole
        // thing vanishes when the corpse timer expires. Fall back to the visible
        // block corpse instead.
        if (this.rig) {
            const resolvable = specs.some((spec) => this.rig?.resolveBone(spec.name));
            if (!resolvable) {
                console.warn(
                    '[Ragdoll] skinned rig resolved no bones — falling back to the block corpse. '
                    + 'The character\'s skeleton uses none of the canonical bone names.',
                );
                this.rig = null;
            }
        }

        const character = this.callbacks.getCharacter();
        character.updateMatrixWorld(true);

        // Seed velocity from the capsule so a ragdoll that died mid-stride keeps some momentum.
        const capsule = this.callbacks.getPhysicsBody();
        const baseVel = capsule ? capsule.linvel() : { x: 0, y: 0, z: 0 };

        const partMeshes = this.assignMeshesToParts(specs);

        // Build one dynamic body per part.
        for (const spec of specs) {
            const meshes = partMeshes.get(spec.name);
            if (!meshes || meshes.length === 0) continue;

            const box = new THREE.Box3();
            for (const mesh of meshes) box.expandByObject(mesh);
            if (box.isEmpty()) continue;

            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const MIN_HALF = 0.04;
            const hx = Math.max(size.x / 2, MIN_HALF);
            const hy = Math.max(size.y / 2, MIN_HALF);
            const hz = Math.max(size.z / 2, MIN_HALF);

            // Block path renders cloned blocks; skinned path renders the GLB driven by bones instead.
            let cloneGroup: THREE.Group | null = null;
            if (!this.rig) {
                cloneGroup = this.cloneBlocks(meshes, center);
                engine.scene.add(cloneGroup);
            }
            const bone = this.rig ? this.rig.resolveBone(spec.name) : null;
            const boneRest = bone ? bone.getWorldQuaternion(new THREE.Quaternion()) : null;

            const body = this.createLimbBody(physicsWorld, center, hx, hy, hz, baseVel);
            this.config.onBodyCreated?.(body);

            this.parts.set(spec.name, { body, collider: body.collider(0), cloneGroup, center, bone, boneRest });
        }

        if (this.parts.size === 0) {
            // Parts were described but none produced a body — an empty or
            // degenerate bounding box for every limb.
            console.warn('[Ragdoll] no limb bodies could be built from the collected parts');
            return false;
        }

        // Hinge axis = the character's world right axis at death, so elbows/knees fold fore-aft.
        // Bodies are created at identity rotation, so this world vector is also each joint's local axis.
        const charQuat = new THREE.Quaternion();
        character.getWorldQuaternion(charQuat);
        const hingeAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(charQuat);
        if (hingeAxis.lengthSq() < 1e-6) hingeAxis.set(1, 0, 0);
        hingeAxis.normalize();

        // Articulate. Anchors are the midpoint between paired segment centers, expressed local
        // (bodies at identity → localAnchor = worldAnchor − bodyCenter).
        for (const spec of specs) {
            if (!spec.parent) continue;
            const child = this.parts.get(spec.name);
            const parent = this.parts.get(spec.parent);
            if (!child || !parent) continue;

            const anchor = new THREE.Vector3().addVectors(child.center, parent.center).multiplyScalar(0.5);
            const a1 = new THREE.Vector3().subVectors(anchor, child.center);
            const a2 = new THREE.Vector3().subVectors(anchor, parent.center);

            let jointData: RAPIER.JointData;
            if (this.config.jointLimits && spec.jointType === 'hinge') {
                // 1-DOF hinge with a flex limit; reads far more skeletal than a free ball joint.
                jointData = RAPIER.JointData.revolute(
                    { x: a1.x, y: a1.y, z: a1.z },
                    { x: a2.x, y: a2.y, z: a2.z },
                    { x: hingeAxis.x, y: hingeAxis.y, z: hingeAxis.z },
                );
                jointData.limitsEnabled = true;
                jointData.limits = [-0.3, 2.4]; // radians: ~-17° give to ~138° flex
            } else {
                jointData = RAPIER.JointData.spherical(
                    { x: a1.x, y: a1.y, z: a1.z },
                    { x: a2.x, y: a2.y, z: a2.z },
                );
            }

            const joint = physicsWorld.createImpulseJoint(jointData, child.body, parent.body);
            // Directly-jointed neighbours must not collide (they'd jitter at the joint); non-adjacent
            // parts still collide so the body heaps. No-op when self-collision is off.
            if (this.config.selfCollision) joint.setContactsEnabled(false);
            this.joints.push(joint);
        }

        this.seedImpulses(specs, hubVelocity);

        // Track the hub (parentless torso) in EVERY mode — getHubState() reads
        // it for temporary ragdolls (ski crash bail) to follow and detect rest.
        this.hubName = specs.find((s) => s.parent === null)?.name ?? null;

        // Skinned mode: keep a handle to the GLB (for dispose); the hub bone is
        // anchored to its body each frame so the corpse follows the falling torso.
        if (this.rig) {
            this.skinnedChar = character;
        }

        this.callbacks.onPostRagdoll();

        this.active = true;
        this.selfCollisionDropped = false;
        this.spawnMs = Date.now();
        this.disposeTime = this.config.corpseLifetimeMs > 0
            ? Date.now() + this.config.corpseLifetimeMs
            : 0;
        return true;
    }

    /** Assign each block mesh to the part owning its nearest enclosing node (deduped). */
    private assignMeshesToParts(specs: RagdollPartSpec[]): Map<string, THREE.Mesh[]> {
        const nodeToPart = new Map<THREE.Object3D, string>();
        for (const spec of specs) {
            for (const node of spec.nodes) nodeToPart.set(node, spec.name);
        }

        const meshSet = new Set<THREE.Mesh>();
        for (const spec of specs) {
            for (const node of spec.nodes) {
                node.traverse((o: THREE.Object3D) => {
                    if ((o as THREE.Mesh).isMesh) meshSet.add(o as THREE.Mesh);
                });
            }
        }

        const out = new Map<string, THREE.Mesh[]>();
        for (const spec of specs) out.set(spec.name, []);
        for (const mesh of meshSet) {
            let cur: THREE.Object3D | null = mesh;
            while (cur) {
                const owner = nodeToPart.get(cur);
                if (owner) { out.get(owner)!.push(mesh); break; }
                cur = cur.parent;
            }
        }
        return out;
    }

    /**
     * Clone meshes into a fresh scene group at `center`, keeping each clone's world transform so the
     * corpse reproduces the live pose on frame 0 then moves rigidly with its body. Geometry + material
     * are cloned so disposal never touches the live character.
     */
    private cloneBlocks(meshes: THREE.Mesh[], center: THREE.Vector3): THREE.Group {
        const group = new THREE.Group();
        group.position.copy(center);

        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        const ws = new THREE.Vector3();
        for (const mesh of meshes) {
            mesh.getWorldPosition(wp);
            mesh.getWorldQuaternion(wq);
            mesh.getWorldScale(ws);

            const material = Array.isArray(mesh.material)
                ? mesh.material.map((m) => m.clone())
                : mesh.material.clone();
            const clone = new THREE.Mesh(mesh.geometry.clone(), material);
            clone.position.copy(wp).sub(center);
            clone.quaternion.copy(wq);
            clone.scale.copy(ws);
            clone.castShadow = true;
            clone.receiveShadow = true;
            clone.layers.enable(1);
            group.add(clone);
        }
        return group;
    }

    private createLimbBody(
        physicsWorld: PhysicsWorld,
        center: THREE.Vector3,
        hx: number,
        hy: number,
        hz: number,
        baseVel: { x: number; y: number; z: number },
    ): RAPIER.RigidBody {
        // High damping bleeds residual energy so a settled corpse reaches the auto-sleep threshold.
        // Soft (not hard) CCD avoids jitter on a self-colliding pile; the velocity cap prevents tunnelling.
        //
        // Hard CCD was TRIED for the "corpse sinks through the floor" bug and made no
        // difference — measured in game, limbs still went from y 1.13 to −3.94 in a
        // second — so the cause is not tunnelling and hard CCD only costs jitter here.
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(center.x, center.y, center.z)
            .setLinearDamping(0.6)
            .setAngularDamping(2.0)
            .setCcdEnabled(false)
            .setSoftCcdPrediction(0.2);
        const body = physicsWorld.createRigidBody(bodyDesc);

        // Mass scales with volume but is kept to a tight ≤3:1 ratio (large ratios between jointed
        // bodies are a documented solver-instability source). Inertia is overridden flat (debris trick)
        // so a corner impact can't amplify into a NaN spin.
        const volume = (2 * hx) * (2 * hy) * (2 * hz);
        const mass = Math.min(6, Math.max(2, volume * 400));

        // With self-collision on, add RAGDOLL to this body's collide-with mask.
        const mask = this.config.selfCollision
            ? (CollisionMask.RAGDOLL | CollisionGroup.RAGDOLL)
            : CollisionMask.RAGDOLL;
        // Colliders are shrunk inside the visible blocks: in the death pose limb blocks sit flush, and
        // at full size + self-collision the solver reads that as deep penetration and flings them apart
        // at spawn. Smaller colliders leave a gap so there's nothing to depenetrate.
        const s = RagdollComponent.COLLIDER_SCALE;
        const colliderDesc = RAPIER.ColliderDesc.cuboid(hx * s, hy * s, hz * s)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.RAGDOLL, mask))
            .setMassProperties(
                mass,
                { x: 0, y: 0, z: 0 },
                { x: 0.2, y: 0.2, z: 0.2 },
                { x: 0, y: 0, z: 0, w: 1 },
            )
            .setFriction(0.8)
            .setRestitution(0.0)
            // Thin contact skin: a small resting gap so stacked limbs don't oscillate in/out of penetration.
            .setContactSkin(0.012);
        physicsWorld.createCollider(colliderDesc, body);

        // Tag for the pre-step safety net's tight debris velocity cap.
        physicsWorld.setUserData(body, { __type: 'ragdoll' });

        body.setLinvel({ x: baseVel.x, y: baseVel.y, z: baseVel.z }, true);
        return body;
    }

    /** Apply the killing blow's knockback to the hub and give every segment a tiny tumble. */
    private seedImpulses(specs: RagdollPartSpec[], hubVelocity?: THREE.Vector3): void {
        const hubName = specs.find((s) => s.parent === null)?.name;
        if (hubName && hubVelocity) {
            const hub = this.parts.get(hubName);
            if (hub) {
                // hubVelocity is a desired Δv (m/s); convert to an impulse via mass. The safety net
                // caps ragdoll bodies, so an absurd value can never run away.
                const m = hub.body.mass() || 1;
                hub.body.applyImpulse(
                    { x: hubVelocity.x * m, y: hubVelocity.y * m, z: hubVelocity.z * m },
                    true,
                );
            }
        }
        // Tiny tumble just breaks the rigid T-pose symmetry; gravity + joints do the real work.
        // (Large seeded spin amplifies into chaotic flinging with self-collision on.)
        for (const part of this.parts.values()) {
            part.body.setAngvel(
                {
                    x: (Math.random() - 0.5) * 0.8,
                    y: (Math.random() - 0.5) * 0.8,
                    z: (Math.random() - 0.5) * 0.8,
                },
                true,
            );
        }
    }

    /**
     * Whether this ragdoll is driving a skinned GLB rather than cloned blocks.
     *
     * Owners need this in `onPostRagdoll` to decide whether the original mesh is
     * the corpse (keep it) or has been replaced by cloned blocks (remove it).
     * `renderSkinned` alone is not enough: the rig is dropped when it resolves
     * no bones.
     */
    usesSkinnedRig(): boolean {
        return this.rig !== null;
    }

    /** Per-frame: copy each body's transform onto its clone group; auto-dispose at end of lifetime. */
    syncRagdoll(): void {
        if (!this.active) return;

        if (this.disposeTime > 0 && Date.now() > this.disposeTime) {
            this.dispose(this.callbacks.getPhysicsWorld());
            return;
        }

        if (this.rig) {
            this.driveSkinnedRig();
        } else {
            for (const part of this.parts.values()) {
                if (!part.cloneGroup) continue;
                const t = part.body.translation();
                const r = part.body.rotation();
                part.cloneGroup.position.set(t.x, t.y, t.z);
                part.cloneGroup.quaternion.set(r.x, r.y, r.z, r.w);
            }
        }

        // Once piled, drop self-collision so the remaining limb-vs-limb jitter dies and the body
        // auto-sleeps. No-op when self-collision was off; limbs still collide with terrain/props.
        if (this.config.selfCollision && !this.selfCollisionDropped
            && Date.now() - this.spawnMs > RagdollComponent.SELF_COLLISION_DROP_MS) {
            for (const part of this.parts.values()) {
                part.collider.setCollisionGroups(makeCollisionGroups(CollisionGroup.RAGDOLL, CollisionMask.RAGDOLL));
            }
            this.selfCollisionDropped = true;
        }
    }

    /**
     * Skinned mode: drive the GLB skeleton exactly like the engine's updateSkinnedCharacter — set each
     * mapped bone's LOCAL rotation so its world rotation = bodyRotation · boneRest (bind-pose limb
     * lengths kept), then SHIFT the whole skeleton root so the hub (torso) bone sits on the hub body.
     * The hub body has a collider resting on terrain, so the anchored skeleton rides the falling torso
     * instead of sinking; limbs follow via their rotations. No bone POSITIONS are driven and the bind
     * is untouched, so the skinned mesh deforms correctly.
     */
    private driveSkinnedRig(): void {
        const root = this.rig?.root;
        if (!root) return;

        // 1. Per-bone local rotation from the body's world rotation.
        for (const name of SKIN_DRIVE_ORDER) {
            const part = this.parts.get(name);
            if (!part || !part.bone || !part.boneRest) continue;
            const r = part.body.rotation();
            this.boneQuatA.set(r.x, r.y, r.z, r.w).multiply(part.boneRest); // target world rotation
            const parent = part.bone.parent;
            if (parent) {
                parent.getWorldQuaternion(this.boneQuatB);
                part.bone.quaternion.copy(this.boneQuatB.invert().multiply(this.boneQuatA));
            } else {
                part.bone.quaternion.copy(this.boneQuatA);
            }
            part.bone.updateWorldMatrix(false, true);
        }

        // 2. Anchor: shift the root so the hub bone lands on the hub body (same trick as the engine's
        //    foot-plant — translate the skeleton root by the delta to a target world position).
        const hub = this.hubName ? this.parts.get(this.hubName) : null;
        if (hub && hub.bone) {
            root.updateMatrixWorld(true);
            const b = hub.body.translation();
            this.anchorVec.set(b.x, b.y, b.z);       // hub body, world
            hub.bone.getWorldPosition(this.syncVec); // hub bone, world
            // root.position lives in its parent's frame (the character node is yawed/scaled as the NPC
            // walked). Convert BOTH world points into that frame before differencing — otherwise a
            // rotated parent sends the world delta the wrong way and the anchor feedback diverges,
            // launching the corpse off to infinity.
            const parent = root.parent;
            if (parent) {
                parent.updateWorldMatrix(true, false);
                parent.worldToLocal(this.anchorVec);
                parent.worldToLocal(this.syncVec);
            }
            root.position.add(this.anchorVec.sub(this.syncVec));
            root.updateMatrixWorld(true);
        }
    }

    /** Tear down: joints first (so the solver never touches a freed body), then bodies, then meshes. */
    dispose(physicsWorld: PhysicsWorld): void {
        for (const joint of this.joints) {
            physicsWorld.removeImpulseJoint(joint);
        }
        this.joints = [];

        for (const part of this.parts.values()) {
            physicsWorld.removeRigidBody(part.body);
            if (!part.cloneGroup) continue;
            if (part.cloneGroup.parent) part.cloneGroup.parent.remove(part.cloneGroup);
            part.cloneGroup.traverse((o: THREE.Object3D) => {
                const mesh = o as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.geometry.dispose();
                if (Array.isArray(mesh.material)) {
                    mesh.material.forEach((m) => m.dispose());
                } else {
                    mesh.material.dispose();
                }
            });
        }
        // Skinned mode: the GLB was kept visible AS the corpse — remove it now (block path removed it at death).
        if (this.rig && this.skinnedChar?.parent) {
            this.skinnedChar.parent.remove(this.skinnedChar);
        }
        this.parts.clear();
        this.rig = null;
        this.skinnedChar = null;
        this.active = false;
        this.disposeTime = 0;
        this.selfCollisionDropped = false;
    }
}

/**
 * Build a torso knockback velocity (m/s) for `ragdoll()` from a hit `direction` and `speed`. The
 * direction is flattened to horizontal with a small upward lift so the body rises a little.
 */
export function ragdollKnockback(direction: THREE.Vector3, speed: number): THREE.Vector3 {
    const v = new THREE.Vector3(direction.x, 0, direction.z);
    if (v.lengthSq() < 1e-6) v.set(0, 0, 1);
    v.normalize().multiplyScalar(speed);
    v.y = speed * 0.4;
    return v;
}

/**
 * Build the humanoid ragdoll skeleton (~10 bodies) from a BlockCharacterRenderer's 15 named groups.
 * Small parts merge into their neighbour (neck→torso, hand→forearm, foot→shin). Pass `getBodyPart`.
 */
export function buildHumanoidRagdollParts(
    getBodyPart: (name: string) => THREE.Object3D | null,
): RagdollPartSpec[] {
    const resolve = (names: string[]): THREE.Object3D[] =>
        names.map((n) => getBodyPart(n)).filter((o): o is THREE.Object3D => o !== null);

    // Shoulders/hips/neck stay ball joints; elbows/knees are hinges (when jointLimits is on).
    const layout: { name: string; parent: string | null; groups: string[]; jointType?: 'ball' | 'hinge' }[] = [
        { name: 'torso', parent: null, groups: ['torso', 'neck'] },
        { name: 'head', parent: 'torso', groups: ['head'] },
        { name: 'leftUpperArm', parent: 'torso', groups: ['leftUpperArm'] },
        { name: 'leftLowerArm', parent: 'leftUpperArm', groups: ['leftForearm', 'leftHand'], jointType: 'hinge' },
        { name: 'rightUpperArm', parent: 'torso', groups: ['rightUpperArm'] },
        { name: 'rightLowerArm', parent: 'rightUpperArm', groups: ['rightForearm', 'rightHand'], jointType: 'hinge' },
        { name: 'leftThigh', parent: 'torso', groups: ['leftThigh'] },
        { name: 'leftShin', parent: 'leftThigh', groups: ['leftShin', 'leftFoot'], jointType: 'hinge' },
        { name: 'rightThigh', parent: 'torso', groups: ['rightThigh'] },
        { name: 'rightShin', parent: 'rightThigh', groups: ['rightShin', 'rightFoot'], jointType: 'hinge' },
    ];

    return layout
        .map((l) => ({ name: l.name, parent: l.parent, nodes: resolve(l.groups), jointType: l.jointType }))
        .filter((p) => p.nodes.length > 0);
}

/**
 * Build the animal ragdoll skeleton from the named block-animal parts (AnimalBody hub + head/tail/
 * legs/wings). Missing parts are skipped; returns [] if there's no body hub.
 */
export function buildAnimalRagdollParts(characterRoot: THREE.Object3D): RagdollPartSpec[] {
    const byName = new Map<string, THREE.Object3D>();
    characterRoot.traverse((o: THREE.Object3D) => {
        if (o.name && !byName.has(o.name)) byName.set(o.name, o);
    });

    const body = byName.get('AnimalBody');
    if (!body) return [];

    const specs: RagdollPartSpec[] = [{ name: 'AnimalBody', parent: null, nodes: [body] }];
    const limbs = ['AnimalHead', 'AnimalTail', 'FrontLeftLeg', 'FrontRightLeg', 'BackLeftLeg', 'BackRightLeg', 'LeftWing', 'RightWing'];
    for (const name of limbs) {
        const node = byName.get(name);
        if (node) specs.push({ name, parent: 'AnimalBody', nodes: [node] });
    }
    return specs;
}
