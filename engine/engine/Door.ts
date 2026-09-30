/**
 * Door — kinematic sliding door with optional keycard lock.
 *
 * Owns a kinematic-position rigid body, a cuboid collider, a simple box mesh,
 * and an `InteractableComponent`. The body slides between a closed and an
 * open position along a door-local axis; the InteractableComponent dispatches
 * the player's E-key to `toggle()` (no-op when locked).
 *
 * Pair with `KeycardReader` for keycard-gated unlocking, or call
 * `setLocked()` directly from template code.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

export interface DoorOptions {
    /** World-space center of the door when closed. */
    position: THREE.Vector3;
    /** Yaw rotation in radians around the Y axis. Default 0. */
    rotation: number;
    /** Door width (door-local X) in meters. */
    width: number;
    /** Door height (door-local Y) in meters. */
    height: number;
    /** Door thickness (door-local Z) in meters. */
    thickness: number;
    /** Distance (m) the door travels when opening. */
    slideDistance: number;
    /** Door-local axis the door slides along when opening. */
    slideAxis: 'x' | 'y' | 'z';
    /** How long a full open or close takes. */
    slideDurationMs: number;
    /** Keycard id that unlocks this door. `null` means the door starts unlocked. */
    requiresKeycardId: string | null;
    /** Fired the moment the door starts opening. */
    onOpen: (() => void) | null;
    /** Fired the moment the door starts closing. */
    onClose: (() => void) | null;
}

export const DEFAULT_DOOR_OPTIONS: DoorOptions = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: 0,
    width: 2,
    height: 3,
    thickness: 0.2,
    slideDistance: 2,
    slideAxis: 'x',
    slideDurationMs: 800,
    requiresKeycardId: null,
    onOpen: null,
    onClose: null,
};

type DoorState = 'closed' | 'opening' | 'open' | 'closing';

export class Door implements Interactable {
    private readonly engine: EngineLike;
    private readonly mesh: THREE.Mesh;
    private readonly body: RAPIER.RigidBody;
    private readonly collider: RAPIER.Collider;
    private readonly interactable: InteractableComponent;
    private readonly closedPos: THREE.Vector3;
    private readonly openPos: THREE.Vector3;
    private readonly slideDurationMs: number;
    private readonly requiredKeycardId: string | null;
    private readonly onOpenCb: (() => void) | null;
    private readonly onCloseCb: (() => void) | null;
    private readonly preStepCallback: (dt: number) => void;

    private state: DoorState = 'closed';
    private animProgress: number = 0;
    private locked: boolean;
    private _disposed: boolean = false;

    constructor(engine: EngineLike, options: DoorOptions) {
        if (!engine.physicsWorld) {
            throw new Error('Door requires an initialized physicsWorld on the engine.');
        }
        if (!engine.scene) {
            throw new Error('Door requires an initialized scene on the engine.');
        }

        this.engine = engine;
        this.closedPos = options.position.clone();
        this.openPos = this.closedPos.clone().add(
            Door.computeSlideOffset(options.rotation, options.slideAxis, options.slideDistance),
        );
        this.slideDurationMs = Math.max(1, options.slideDurationMs);
        this.onOpenCb = options.onOpen;
        this.onCloseCb = options.onClose;
        this.requiredKeycardId = options.requiresKeycardId;
        this.locked = this.requiredKeycardId !== null;

        this.mesh = Door.buildMesh(options.width, options.height, options.thickness);
        this.mesh.position.copy(this.closedPos);
        this.mesh.rotation.y = options.rotation;
        engine.scene.add(this.mesh);

        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(this.closedPos.x, this.closedPos.y, this.closedPos.z)
            .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), options.rotation));
        this.body = engine.physicsWorld.createRigidBody(bodyDesc);

        const colDesc = RAPIER.ColliderDesc.cuboid(options.width * 0.5, options.height * 0.5, options.thickness * 0.5)
            .setFriction(0.8)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        this.collider = engine.physicsWorld.createCollider(colDesc, this.body);

        this.interactable = new InteractableComponent(engine.physicsWorld, {
            interactable: this,
            object3D: this.mesh,
            radius: 3.0,
        });

        this.preStepCallback = (dt: number) => this.step(dt);
        engine.physicsWorld.registerPreStepCallback(this.preStepCallback);
    }

    private static computeSlideOffset(rotation: number, axis: 'x' | 'y' | 'z', distance: number): THREE.Vector3 {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        if (axis === 'y') return new THREE.Vector3(0, distance, 0);
        if (axis === 'x') return new THREE.Vector3(cos * distance, 0, -sin * distance);
        return new THREE.Vector3(sin * distance, 0, cos * distance);
    }

    private static buildMesh(width: number, height: number, thickness: number): THREE.Mesh {
        const geom = new THREE.BoxGeometry(width, height, thickness);
        const mat = createClassedPartMaterial('wood', { color: 0x6a4a2a });
        return new THREE.Mesh(geom, mat);
    }

    private step(dtSeconds: number): void {
        if (this._disposed) return;
        if (this.state !== 'opening' && this.state !== 'closing') {
            const target = this.state === 'open' ? this.openPos : this.closedPos;
            this.body.setNextKinematicTranslation({ x: target.x, y: target.y, z: target.z });
            return;
        }

        this.animProgress = Math.min(1, this.animProgress + (dtSeconds * 1000) / this.slideDurationMs);
        const from = this.state === 'opening' ? this.closedPos : this.openPos;
        const to = this.state === 'opening' ? this.openPos : this.closedPos;
        const pos = from.clone().lerp(to, this.animProgress);

        this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
        this.mesh.position.copy(pos);

        if (this.animProgress >= 1) {
            this.state = this.state === 'opening' ? 'open' : 'closed';
            this.animProgress = 0;
        }
    }

    /** Begin opening. No-op if locked, already open, or already opening. */
    open(): void {
        if (this.locked || this.state === 'open' || this.state === 'opening') return;
        // If currently closing, resume from the current animProgress in reverse so motion is continuous.
        this.animProgress = this.state === 'closing' ? 1 - this.animProgress : 0;
        this.state = 'opening';
        this.onOpenCb?.();
    }

    /** Begin closing. No-op if already closed or already closing. */
    close(): void {
        if (this.state === 'closed' || this.state === 'closing') return;
        this.animProgress = this.state === 'opening' ? 1 - this.animProgress : 0;
        this.state = 'closing';
        this.onCloseCb?.();
    }

    /** Toggle open/closed. Respects lock state. */
    toggle(): void {
        if (this.state === 'open' || this.state === 'opening') this.close();
        else this.open();
    }

    isOpen(): boolean {
        return this.state === 'open' || this.state === 'opening';
    }

    setLocked(locked: boolean): void {
        this.locked = locked;
    }

    isLocked(): boolean {
        return this.locked;
    }

    /**
     * The keycard id this door requires (as set via `requiresKeycardId` at construction),
     * or `null` if the door started unlocked. Useful for paired `KeycardReader` setup
     * and for editor/inspector tools — not used by Door's own logic.
     */
    getRequiredKeycardId(): string | null {
        return this.requiredKeycardId;
    }

    // ---- Interactable ----

    onInteractStart(): boolean {
        if (this.locked) return false;
        this.toggle();
        return true;
    }

    getInteractStartDisplayName(): string {
        if (this.locked) return 'locked';
        return this.isOpen() ? 'close door' : 'open door';
    }

    isActionable(): boolean {
        return !this.locked;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        const physicsWorld = this.engine.physicsWorld;
        if (physicsWorld) {
            physicsWorld.unregisterPreStepCallback(this.preStepCallback);
        }
        this.interactable.dispose();
        if (physicsWorld) {
            if (this.collider.isValid()) physicsWorld.removeCollider(this.collider);
            if (this.body.isValid()) physicsWorld.removeRigidBody(this.body);
        }
        this.engine.scene?.remove(this.mesh);
        this.mesh.geometry.dispose();
        const mat = this.mesh.material;
        if (Array.isArray(mat)) {
            for (const m of mat) m.dispose();
        } else {
            mat.dispose();
        }
    }
}
