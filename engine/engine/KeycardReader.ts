/**
 * KeycardReader — a small E-key panel that unlocks a paired `Door` (or any
 * lockable target) when the player is carrying a matching keycard id.
 *
 * The reader owns its panel mesh, a fixed rigid body, a cuboid collider,
 * and an `InteractableComponent`. Pair with `Door` by wiring `onUnlock` to
 * call `door.setLocked(false)`.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

export interface KeycardReaderOptions {
    /** World-space center of the reader panel. */
    position: THREE.Vector3;
    /** Yaw rotation in radians around the Y axis. Default 0. */
    rotation: number;
    /** Id that must match the player's currently-carried item to unlock. */
    keycardId: string;
    /** Callback returning the id of whatever the player is currently carrying, or `null` if nothing. */
    getPlayerCarriedItemId: () => string | null;
    /** Fired when the player presses E while carrying the matching keycard. */
    onUnlock: (() => void) | null;
    /** Fired when the player presses E without a matching keycard. Use for traps / fake-door cues. */
    onWrongCard: (() => void) | null;
}

export const DEFAULT_KEYCARD_READER_OPTIONS: KeycardReaderOptions = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: 0,
    keycardId: '',
    getPlayerCarriedItemId: () => null,
    onUnlock: null,
    onWrongCard: null,
};

const PANEL_WIDTH = 0.4;
const PANEL_HEIGHT = 0.6;
const PANEL_THICKNESS = 0.1;

export class KeycardReader implements Interactable {
    private readonly engine: EngineLike;
    private readonly mesh: THREE.Mesh;
    private readonly body: RAPIER.RigidBody;
    private readonly collider: RAPIER.Collider;
    private readonly interactable: InteractableComponent;
    private readonly keycardId: string;
    private readonly getPlayerCarriedItemId: () => string | null;
    private readonly onUnlockCb: (() => void) | null;
    private readonly onWrongCardCb: (() => void) | null;

    private _disposed: boolean = false;

    constructor(engine: EngineLike, options: KeycardReaderOptions) {
        if (!engine.physicsWorld) {
            throw new Error('KeycardReader requires an initialized physicsWorld on the engine.');
        }
        if (!engine.scene) {
            throw new Error('KeycardReader requires an initialized scene on the engine.');
        }

        this.engine = engine;
        this.keycardId = options.keycardId;
        this.getPlayerCarriedItemId = options.getPlayerCarriedItemId;
        this.onUnlockCb = options.onUnlock;
        this.onWrongCardCb = options.onWrongCard;

        this.mesh = KeycardReader.buildMesh();
        this.mesh.position.copy(options.position);
        this.mesh.rotation.y = options.rotation;
        engine.scene.add(this.mesh);

        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(options.position.x, options.position.y, options.position.z)
            .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), options.rotation));
        this.body = engine.physicsWorld.createRigidBody(bodyDesc);

        const colDesc = RAPIER.ColliderDesc.cuboid(PANEL_WIDTH * 0.5, PANEL_HEIGHT * 0.5, PANEL_THICKNESS * 0.5)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        this.collider = engine.physicsWorld.createCollider(colDesc, this.body);

        this.interactable = new InteractableComponent(engine.physicsWorld, {
            interactable: this,
            object3D: this.mesh,
            radius: 2.5,
        });
    }

    private static buildMesh(): THREE.Mesh {
        const geom = new THREE.BoxGeometry(PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS);
        const mat = createClassedPartMaterial('metal', { color: 0x222244 });
        mat.emissive.setHex(0x110022); // authored faint powered-panel glow, kept as a postscript
        return new THREE.Mesh(geom, mat);
    }

    // ---- Interactable ----

    onInteractStart(): boolean {
        const carried = this.getPlayerCarriedItemId();
        if (carried === this.keycardId) {
            this.onUnlockCb?.();
            return true;
        }
        this.onWrongCardCb?.();
        return false;
    }

    getInteractStartDisplayName(): string {
        const carried = this.getPlayerCarriedItemId();
        if (carried === this.keycardId) return 'use keycard reader';
        if (carried !== null) return 'wrong keycard';
        return 'needs a keycard';
    }

    isActionable(): boolean {
        const carried = this.getPlayerCarriedItemId();
        if (carried === this.keycardId) return true;
        // Without a matching keycard, the press is only meaningful when the
        // template wired up a wrong-card response (e.g. a trap or hint cue).
        return this.onWrongCardCb !== null;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        this.interactable.dispose();
        if (this.engine.physicsWorld) {
            if (this.collider.isValid()) this.engine.physicsWorld.removeCollider(this.collider);
            if (this.body.isValid()) this.engine.physicsWorld.removeRigidBody(this.body);
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
