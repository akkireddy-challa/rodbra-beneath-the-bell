/**
 * DungeonDoor — one data-driven door leaf from `worldProfileData.doors[]`.
 *
 * Owns a kinematic-position rigid body, a cuboid collider, the leaf visual
 * (authored asset re-centred and fitted under a pivot when `def.assetId` is
 * set — see `wrapSpawnedLeaf` — engine box mesh otherwise), an
 * `InteractableComponent` for the locked-door prompt, and — while it actually
 * blocks the way — a navmesh obstacle provider. `DoorSystem` builds one per
 * `DoorDefinition`, feeds it candidate positions each frame via
 * `updateProximity()`, and mirrors `onStateChanged` over the network.
 *
 * The kinematic recipe (body/collider construction, a pre-step callback that
 * pushes `setNextKinematicTranslation` every frame — including at rest, so the
 * body never drifts from the pose — and the dispose ordering) follows
 * `engine/Door.ts`. It is copied rather than shared: `Door` is a template-facing
 * class with its own frozen options surface, and published games construct it
 * directly, so it cannot grow the dungeon behaviour without breaking them.
 *
 * Three animations, all eased over `DOOR_ANIM_MS`:
 *   - `slide`    — travels along door-local +X by `width * 0.95`.
 *   - `hinge`    — swings `maxOpenAngleDeg` (legacy default 100°) about the vertical edge at door-local
 *                  (-width/2, 0, 0); position AND rotation are recomputed from
 *                  the pivot each frame.
 *   - `dissolve` — shrinks in place to 2% scale; the collider is disabled once
 *                  the leaf is past halfway (and re-enabled on the way back).
 *
 * Locking: a `'locked'` door blocks pathing (nav obstacle) and ignores
 * proximity until the player unlocks it with the matching key from the shared
 * `Keyring`, or template/agent code calls `setLocked(false)` /
 * `DoorSystem.unlockDoor()`. `open()`/`close()` are the scripted path and
 * deliberately bypass the lock.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { DoorDefinition, EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import {
    registerObstacleProvider,
    unregisterObstacleProvider,
    type ObstacleProvider,
    type ObstacleShape,
} from 'engine/VoxelNavMesh.js';
import { InGameNotification } from 'engine/InGameNotification.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';
import type { Keyring } from 'engine/doors/Keyring.js';

export type DungeonDoorState = 'closed' | 'opening' | 'open' | 'closing';

export interface DungeonDoorEvents {
    /** Fired once on entering every state — including animation completion. */
    onStateChanged: (state: DungeonDoorState) => void;
}

/** Proximity radius (m) that auto-opens an unlocked door, when the door doesn't override it. */
export const DEFAULT_DOOR_AUTO_OPEN_RADIUS = 2.5;
/** Duration of a full open or close, in milliseconds. */
export const DOOR_ANIM_MS = 700;
/** How long an unlocked door stays open after the last body leaves its radius. */
export const DOOR_CLOSE_DELAY_MS = 1500;

/** Legacy swing angle retained when a published door omits `maxOpenAngleDeg`. */
export const DEFAULT_HINGE_OPEN_ANGLE_DEG = 100;
/** Fraction of the door width a slide door travels (a sliver stays in the frame). */
const SLIDE_TRAVEL_FRACTION = 0.95;
/** Uniform scale a dissolve door shrinks to (never 0 — a zero-scale matrix is degenerate). */
const DISSOLVE_MIN_SCALE = 0.02;
/** Eased progress past which a dissolve door stops colliding. */
const DISSOLVE_COLLIDER_OFF_AT = 0.5;
/** Interact sensor radius (m) for the locked-door prompt. */
const DOOR_INTERACT_RADIUS = 3.0;
/** Fallback box leaf tint when `def.color` is omitted. */
const DEFAULT_DOOR_COLOR = '#6a4a2a';
/** Extra depth (m) added each side of the nav obstacle so agents don't clip the frame. */
const NAV_OBSTACLE_DEPTH_PADDING = 0.2;
/** Below this (m) a leaf bounding-box axis is treated as degenerate and the fit is skipped. */
const MIN_LEAF_BBOX_SIZE = 0.001;
/** How long the unlock toast stays up. */
const UNLOCK_NOTIFICATION_MS = 2500;

const DOOR_UP_AXIS = new THREE.Vector3(0, 1, 0);
/** Read-only unit scale — copied from, never mutated. */
const LEAF_UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/** Message sink for the unlock toast. Injected in tests; production uses the shared HUD toast. */
export type DoorNotify = (message: string) => void;

let sharedNotification: InGameNotification | null = null;

/** One HUD toast instance for every door — each `InGameNotification` owns a DOM container. */
export const DEFAULT_DOOR_NOTIFY: DoorNotify = (message: string) => {
    if (!sharedNotification) sharedNotification = new InGameNotification();
    sharedNotification.show(message, UNLOCK_NOTIFICATION_MS);
};

/** Cubic smoothstep — eases the linear animation clock into the pose. */
function smoothstep(t: number): number {
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
}

export class DungeonDoor implements Interactable {
    readonly id: string;

    private readonly engine: EngineLike;
    private readonly def: DoorDefinition;
    private readonly keyring: Keyring;
    private readonly events: DungeonDoorEvents;
    private readonly notify: DoorNotify;

    private readonly body: RAPIER.RigidBody;
    private readonly collider: RAPIER.Collider;
    private readonly interactable: InteractableComponent;
    private readonly preStepCallback: (dt: number) => void;

    /** World-space door centre when closed. */
    private readonly closedPos: THREE.Vector3;
    /** Door orientation (yaw only) when closed. */
    private readonly baseQuat: THREE.Quaternion;
    /** Door-local +X in world space — the slide direction. */
    private readonly slideAxisWorld: THREE.Vector3;
    /** World-space hinge pivot: the vertical edge at door-local (-width/2, 0, 0). */
    private readonly hingePivot: THREE.Vector3;
    private readonly slideDistance: number;
    private readonly hingeOpenAngleRad: number;
    private readonly autoOpenRadius: number;

    /** What the animation drives: the asset's pivot wrapper, or the fallback box mesh. Null until an async spawn lands. */
    private leaf: THREE.Object3D | null = null;
    /** The leaf's resting (per-axis) scale; dissolve multiplies it instead of clobbering it. */
    private readonly leafBaseScale = new THREE.Vector3(1, 1, 1);
    private fallbackMesh: THREE.Mesh | null = null;
    /** Pivot holding a spawned asset — see `wrapSpawnedLeaf`. We own it; `spawnedAsset.dispose()` only removes its child. */
    private leafWrapper: THREE.Object3D | null = null;
    private spawnedAsset: SpawnedAsset | null = null;

    private navProvider: ObstacleProvider | null = null;

    private state: DungeonDoorState = 'closed';
    /**
     * Elapsed time (ms) of the animation currently running, 0..DOOR_ANIM_MS.
     * Accumulated in milliseconds and divided once — summing a per-frame
     * `dt / DOOR_ANIM_MS` fraction instead leaves the door a rounding error
     * short of open after exactly DOOR_ANIM_MS of frames.
     */
    private animElapsedMs = 0;
    /** Remaining auto-close countdown (ms), or null when no close is pending. */
    private closeDelayRemainingMs: number | null = null;
    private locked: boolean;
    /**
     * The animation currently running was started by a remote peer. Its
     * completion is that peer's transition, not ours, so it must not fire
     * `onStateChanged` — otherwise every peer echoes the opening back.
     * Any locally initiated transition clears it.
     */
    private remoteDriven = false;
    private colliderEnabled = true;
    private disposed = false;

    // Per-frame scratch — the pose is recomputed every step, so allocating here would churn.
    private readonly scratchPos = new THREE.Vector3();
    private readonly scratchQuat = new THREE.Quaternion();
    private readonly scratchRot = new THREE.Quaternion();

    constructor(
        engine: EngineLike,
        def: DoorDefinition,
        keyring: Keyring,
        events: DungeonDoorEvents,
        notify: DoorNotify = DEFAULT_DOOR_NOTIFY,
    ) {
        if (!engine.physicsWorld) {
            throw new Error('DungeonDoor requires an initialized physicsWorld on the engine.');
        }

        this.id = def.id;
        this.engine = engine;
        this.def = def;
        this.keyring = keyring;
        this.events = events;
        this.notify = notify;
        this.locked = def.kind === 'locked';
        this.autoOpenRadius = def.autoOpenRadius ?? DEFAULT_DOOR_AUTO_OPEN_RADIUS;

        this.closedPos = new THREE.Vector3(def.position.x, def.position.y, def.position.z);
        this.baseQuat = new THREE.Quaternion().setFromAxisAngle(DOOR_UP_AXIS, def.rotationY);
        this.slideAxisWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(this.baseQuat);
        this.slideDistance = def.width * SLIDE_TRAVEL_FRACTION;
        this.hingeOpenAngleRad = ((def.maxOpenAngleDeg ?? DEFAULT_HINGE_OPEN_ANGLE_DEG) * Math.PI) / 180;
        this.hingePivot = this.closedPos
            .clone()
            .add(new THREE.Vector3(-def.width * 0.5, 0, 0).applyQuaternion(this.baseQuat));

        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(this.closedPos.x, this.closedPos.y, this.closedPos.z)
            .setRotation(this.baseQuat);
        this.body = engine.physicsWorld.createRigidBody(bodyDesc);

        const colDesc = RAPIER.ColliderDesc.cuboid(def.width * 0.5, def.height * 0.5, def.thickness * 0.5)
            .setFriction(0.8)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        this.collider = engine.physicsWorld.createCollider(colDesc, this.body);

        this.buildLeaf();

        // The sensor is anchored to a standalone Object3D at the closed pose:
        // the leaf may still be loading, and the prompt should sit at the
        // doorway even after the leaf has swung away.
        const sensorAnchor = new THREE.Object3D();
        sensorAnchor.position.copy(this.closedPos);
        this.interactable = new InteractableComponent(engine.physicsWorld, {
            interactable: this,
            object3D: sensorAnchor,
            radius: DOOR_INTERACT_RADIUS,
        });

        this.preStepCallback = (dt: number) => this.step(dt);
        engine.physicsWorld.registerPreStepCallback(this.preStepCallback);

        this.syncNavObstacle();
    }

    // ---- visual ----------------------------------------------------------

    private buildLeaf(): void {
        const def = this.def;
        if (def.assetId && this.engine.spawnAsset) {
            this.engine.spawnAsset(def.assetId, {
                position: { x: this.closedPos.x, y: this.closedPos.y, z: this.closedPos.z },
                rotation: { x: 0, y: def.rotationY, z: 0 },
                name: `door_${def.id}`,
                // The door owns a kinematic body of its own; a second static
                // collider from the spawner would wall the doorway shut.
                collision: false,
            }).then(
                (spawned) => {
                    if (this.disposed) {
                        // Disposed while the load was in flight — tear down what just landed.
                        spawned?.dispose();
                        return;
                    }
                    if (spawned) {
                        this.spawnedAsset = spawned;
                        this.wrapSpawnedLeaf(spawned.object);
                        return;
                    }
                    // A resolved-but-null spawn (bad/missing asset id) must not
                    // leave an invisible door in the dungeon.
                    console.warn(`[DungeonDoor] spawnAsset returned null for door '${def.id}' (asset '${def.assetId}') — falling back to the box leaf`);
                    this.buildFallbackLeaf();
                },
                (err: unknown) => {
                    if (this.disposed) return;
                    console.warn(`[DungeonDoor] spawnAsset failed for door '${def.id}' (asset '${def.assetId}') — falling back to the box leaf:`, err);
                    this.buildFallbackLeaf();
                },
            );
            return;
        }

        this.buildFallbackLeaf();
    }

    private buildFallbackLeaf(): void {
        const def = this.def;
        const geometry = new THREE.BoxGeometry(def.width, def.height, def.thickness);
        const material = createClassedPartMaterial('wood', {
            color: new THREE.Color(def.color ?? DEFAULT_DOOR_COLOR).getHex(),
        });
        const mesh = new THREE.Mesh(geometry, material);
        this.fallbackMesh = mesh;
        this.engine.getWorldGroup().add(mesh);
        // BoxGeometry is centre-origin and already built at the authored
        // width/height/thickness — nothing to re-centre or re-fit.
        this.adoptLeaf(mesh, LEAF_UNIT_SCALE);
    }

    /**
     * Wrap an authored leaf asset in a pivot whose origin is the door centre.
     *
     * Baked assets are bottom-origin (x/z centred, y = 0 at the bottom — both
     * the forger's `normalizeArchetypeMesh` and the asset voxelizer normalize
     * to that frame), so an asset spawned straight at the door centre renders
     * half a door too high. The pivot fixes the frame, and scaling the pivot
     * per-axis to the door's width/height/thickness lets ONE authored archetype
     * per style fit every door in the dungeon.
     *
     * The pivot is what the animation drives; the asset keeps its own local
     * transform underneath it.
     */
    private wrapSpawnedLeaf(object: THREE.Object3D): void {
        const def = this.def;

        // Clear the pose spawnAsset applied — the pivot carries position and
        // yaw now, and leaving the yaw on the asset would apply it twice.
        // Detached first so the bounds below are measured in the asset's own
        // frame, whatever transform the world group happens to carry.
        object.removeFromParent();
        object.position.set(0, 0, 0);
        object.rotation.set(0, 0, 0);
        object.updateWorldMatrix(false, true);

        // Measured with the asset's own scale included, so `fit` compensates
        // for it as well.
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        const wrapper = new THREE.Object3D();
        wrapper.name = `door_${def.id}_pivot`;
        this.leafWrapper = wrapper;
        wrapper.add(object);
        this.engine.getWorldGroup().add(wrapper);

        // Centre the asset's bounds on the pivot. For the expected
        // bottom-origin asset this is exactly -bboxHeight/2 on Y, and it also
        // absorbs assets whose bounds aren't perfectly centred in X/Z.
        object.position.set(-center.x, -center.y, -center.z);

        const fit = LEAF_UNIT_SCALE.clone();
        if (size.x < MIN_LEAF_BBOX_SIZE || size.y < MIN_LEAF_BBOX_SIZE || size.z < MIN_LEAF_BBOX_SIZE) {
            console.warn(`[DungeonDoor] door '${def.id}' leaf asset '${def.assetId}' has a degenerate bounding box (${size.x}, ${size.y}, ${size.z}) — leaving it unscaled`);
        } else {
            fit.set(def.width / size.x, def.height / size.y, def.thickness / size.z);
        }

        this.adoptLeaf(wrapper, fit);
    }

    /**
     * Take ownership of the object the animation drives, and snap it to the
     * current pose. `baseScale` is the leaf's resting scale — unit for the box
     * fallback, the per-axis fit for a wrapped asset — which `applyPose`
     * multiplies by the dissolve factor.
     */
    private adoptLeaf(object: THREE.Object3D, baseScale: THREE.Vector3): void {
        this.leaf = object;
        this.leafBaseScale.copy(baseScale);
        this.applyPose();
    }

    // ---- per-frame -------------------------------------------------------

    private step(dtSeconds: number): void {
        if (this.disposed) return;
        const dtMs = dtSeconds * 1000;

        if (this.closeDelayRemainingMs !== null) {
            this.closeDelayRemainingMs -= dtMs;
            if (this.closeDelayRemainingMs <= 0) {
                this.closeDelayRemainingMs = null;
                this.close();
            }
        }

        if (this.state === 'opening' || this.state === 'closing') {
            this.animElapsedMs = Math.min(DOOR_ANIM_MS, this.animElapsedMs + dtMs);
            if (this.animElapsedMs >= DOOR_ANIM_MS) {
                const finished: DungeonDoorState = this.state === 'opening' ? 'open' : 'closed';
                this.animElapsedMs = 0;
                // A remote-driven animation completes silently — the peer that
                // started it owns the broadcast for the whole open/close.
                const fireEvent = !this.remoteDriven;
                this.remoteDriven = false;
                this.setState(finished, fireEvent);
            }
        }

        this.applyPose();
    }

    /** Progress 0..1 through the animation currently running. */
    private animProgress(): number {
        return this.animElapsedMs / DOOR_ANIM_MS;
    }

    /**
     * Reverse mid-animation: the leaf resumes from where it is instead of
     * snapping back to the start (Door.ts's `1 - animProgress`, in ms).
     */
    private reverseAnimClock(): void {
        this.animElapsedMs = DOOR_ANIM_MS - this.animElapsedMs;
    }

    /** Pose parameter 0 (closed) .. 1 (open) for the current state and progress. */
    private poseProgress(): number {
        switch (this.state) {
            case 'closed': return 0;
            case 'open': return 1;
            case 'opening': return this.animProgress();
            case 'closing': return 1 - this.animProgress();
        }
    }

    private applyPose(): void {
        const t = smoothstep(this.poseProgress());
        const pos = this.scratchPos;
        const quat = this.scratchQuat;
        let scale = 1;

        if (this.def.animation === 'hinge') {
            this.scratchRot.setFromAxisAngle(DOOR_UP_AXIS, this.hingeOpenAngleRad * t);
            pos.copy(this.closedPos).sub(this.hingePivot).applyQuaternion(this.scratchRot).add(this.hingePivot);
            quat.copy(this.scratchRot).multiply(this.baseQuat);
        } else if (this.def.animation === 'dissolve') {
            pos.copy(this.closedPos);
            quat.copy(this.baseQuat);
            scale = 1 + (DISSOLVE_MIN_SCALE - 1) * t;
        } else {
            pos.copy(this.slideAxisWorld).multiplyScalar(this.slideDistance * t).add(this.closedPos);
            quat.copy(this.baseQuat);
        }

        // Pushed every frame, at rest included — a kinematic body that stops
        // receiving a target drifts out of sync with the pose it is drawn at.
        this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
        this.body.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });

        if (this.leaf) {
            this.leaf.position.copy(pos);
            this.leaf.quaternion.copy(quat);
            this.leaf.scale.copy(this.leafBaseScale).multiplyScalar(scale);
        }

        // A dissolving leaf stops colliding once it is mostly gone; every other
        // animation moves the collider with the body instead of switching it off.
        const shouldCollide = this.def.animation !== 'dissolve' || t < DISSOLVE_COLLIDER_OFF_AT;
        if (shouldCollide !== this.colliderEnabled) {
            this.colliderEnabled = shouldCollide;
            this.collider.setEnabled(shouldCollide);
        }
    }

    // ---- state -----------------------------------------------------------

    private setState(next: DungeonDoorState, fireEvent: boolean): void {
        if (this.state === next) return;
        this.state = next;
        this.syncNavObstacle();
        if (fireEvent) this.events.onStateChanged(next);
    }

    /** Begin opening. Scripted path — bypasses the lock. No-op when already open or opening. */
    open(): void {
        if (this.disposed || this.state === 'open' || this.state === 'opening') return;
        if (this.state === 'closing') this.reverseAnimClock();
        else this.animElapsedMs = 0;
        this.closeDelayRemainingMs = null;
        this.remoteDriven = false;
        this.setState('opening', true);
    }

    /** Begin closing. Scripted path — bypasses the lock. No-op when already closed or closing. */
    close(): void {
        if (this.disposed || this.state === 'closed' || this.state === 'closing') return;
        if (this.state === 'opening') this.reverseAnimClock();
        else this.animElapsedMs = 0;
        this.closeDelayRemainingMs = null;
        this.remoteDriven = false;
        this.setState('closing', true);
    }

    getState(): DungeonDoorState {
        return this.state;
    }

    setLocked(locked: boolean): void {
        if (this.disposed || this.locked === locked) return;
        this.locked = locked;
        this.syncNavObstacle();
    }

    isLocked(): boolean {
        return this.locked;
    }

    /**
     * Apply a state authored by another peer. Runs the same transitions as the
     * local API but fires no event, so the change isn't re-broadcast — and the
     * animation it starts also completes silently, since that completion still
     * belongs to the peer that authored the open/close.
     */
    applyRemoteState(state: DungeonDoorState): void {
        if (this.disposed || this.state === state) return;
        if (state === 'opening' && this.state === 'closing') this.reverseAnimClock();
        else if (state === 'closing' && this.state === 'opening') this.reverseAnimClock();
        else this.animElapsedMs = 0;
        this.closeDelayRemainingMs = null;
        // A snapped-to rest state has no animation left to complete silently.
        this.remoteDriven = state === 'opening' || state === 'closing';
        this.setState(state, false);
        this.applyPose();
    }

    // ---- proximity -------------------------------------------------------

    /**
     * Called each frame by `DoorSystem` with the positions allowed to trigger
     * this door (player + nearby NPCs).
     *
     * Only the opening half is gated on the lock: a locked door never opens for
     * anyone, but it must still be able to close. A door locked while open (a
     * script re-locking it, or the level resetting) would otherwise stay open —
     * and therefore passable, and not a nav obstacle — for the rest of the run.
     */
    updateProximity(positions: ReadonlyArray<{ x: number; y: number; z: number }>): void {
        if (this.disposed) return;

        let someoneNear = false;
        if (!this.locked) {
            for (const p of positions) {
                if (this.isWithinRadius(p)) {
                    someoneNear = true;
                    break;
                }
            }
        }

        if (someoneNear) {
            this.closeDelayRemainingMs = null;
            if (this.state === 'closed' || this.state === 'closing') this.open();
            return;
        }

        if ((this.state === 'open' || this.state === 'opening') && this.closeDelayRemainingMs === null) {
            this.closeDelayRemainingMs = DOOR_CLOSE_DELAY_MS;
        }
    }

    private isWithinRadius(p: { x: number; y: number; z: number }): boolean {
        // XZ distance plus a floor test: on a multi-storey dungeon the body
        // standing directly above the door must not trigger it.
        if (Math.abs(p.y - this.closedPos.y) >= this.def.height) return false;
        const dx = p.x - this.closedPos.x;
        const dz = p.z - this.closedPos.z;
        return dx * dx + dz * dz <= this.autoOpenRadius * this.autoOpenRadius;
    }

    // ---- navigation ------------------------------------------------------

    /**
     * A door only blocks pathing while locked AND shut. An unlocked closed door
     * is passable by construction: NPCs walk into its radius and it opens for
     * them, so marking it blocked would route them the long way around.
     */
    private shouldBlockNavigation(): boolean {
        return !this.disposed && this.locked && this.state === 'closed';
    }

    private getObstacleShape(): ObstacleShape | null {
        if (!this.shouldBlockNavigation()) return null;
        return {
            kind: 'box',
            x: this.closedPos.x,
            z: this.closedPos.z,
            halfW: this.def.width * 0.5,
            halfD: this.def.thickness * 0.5 + NAV_OBSTACLE_DEPTH_PADDING,
            yaw: this.def.rotationY,
            // Blocks only the floor layer the door stands on, not the storeys above it.
            y: this.closedPos.y,
        };
    }

    /**
     * Add or drop the obstacle as the door's blocking state changes. The
     * provider is registered only while the door blocks: a provider whose
     * `getShape()` returns null is evicted by the navmesh and never re-attached,
     * so a door that re-locks needs a fresh registration.
     */
    private syncNavObstacle(): void {
        const shouldBlock = this.shouldBlockNavigation();
        if (shouldBlock && !this.navProvider) {
            this.navProvider = registerObstacleProvider(() => this.getObstacleShape());
        } else if (!shouldBlock && this.navProvider) {
            unregisterObstacleProvider(this.navProvider);
            this.navProvider = null;
        }
    }

    // ---- Interactable ----------------------------------------------------

    private hasRequiredKey(): boolean {
        return this.def.keyId !== undefined && this.keyring.has(this.def.keyId);
    }

    onInteractStart(): boolean {
        if (this.disposed || !this.locked || !this.hasRequiredKey()) return false;
        this.setLocked(false);
        this.open();
        this.notify(`Unlocked with ${this.def.keyId}`);
        return true;
    }

    getInteractStartDisplayName(): string {
        if (!this.locked) return 'open door';
        if (!this.def.keyId) return 'locked';
        return this.hasRequiredKey() ? 'unlock' : `locked - requires ${this.def.keyId}`;
    }

    /**
     * Only a locked door has anything to say. An unlocked one auto-opens on
     * approach, so a prompt on it would offer the player nothing (and a manual
     * close would be undone by their own proximity the next frame).
     */
    interactionEnabled(): boolean {
        return this.locked;
    }

    /**
     * Drives the [E] glyph on the prompt, and gates the mobile interact button
     * (see `InteractionController`) — so it must be true whenever the press
     * does something, i.e. when the player holds the key.
     */
    isActionable(): boolean {
        return !this.locked || this.hasRequiredKey();
    }

    // ---- lifecycle -------------------------------------------------------

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        const physicsWorld = this.engine.physicsWorld;
        physicsWorld?.unregisterPreStepCallback(this.preStepCallback);

        this.closeDelayRemainingMs = null;

        if (this.navProvider) {
            unregisterObstacleProvider(this.navProvider);
            this.navProvider = null;
        }

        this.interactable.dispose();

        if (physicsWorld) {
            if (this.collider.isValid()) physicsWorld.removeCollider(this.collider);
            if (this.body.isValid()) physicsWorld.removeRigidBody(this.body);
        }

        if (this.fallbackMesh) {
            this.fallbackMesh.parent?.remove(this.fallbackMesh);
            this.fallbackMesh.geometry.dispose();
            const material = this.fallbackMesh.material;
            if (Array.isArray(material)) {
                for (const m of material) m.dispose();
            } else {
                material.dispose();
            }
            this.fallbackMesh = null;
        }

        // Order matters: the asset's own dispose() detaches it from the pivot,
        // then the pivot — which is ours, not the spawner's — leaves the scene.
        if (this.spawnedAsset) {
            this.spawnedAsset.dispose();
            this.spawnedAsset = null;
        }
        if (this.leafWrapper) {
            this.leafWrapper.parent?.remove(this.leafWrapper);
            this.leafWrapper = null;
        }

        this.leaf = null;
    }
}
