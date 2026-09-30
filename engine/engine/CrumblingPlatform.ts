import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type { EngineLike } from 'types/game.js';

export interface CrumblingPlatformOptions {
    /** World-space slab center (top surface sits at center.y + size.y/2). */
    center: THREE.Vector3;
    /** Slab dimensions in meters. */
    size: THREE.Vector3;
    /** Seconds after a player stands on it until it breaks away. */
    breakAfterS: number;
    /** Seconds after breaking until it re-forms. */
    respawnAfterS: number;
    /** Slab color. */
    color: number;
    /** Player feet position (ground position), or null when unavailable. */
    getPlayerFeet: () => THREE.Vector3 | null;
    /** Display name for the creator's editor (mesh.name). Default 'CrumblingPlatform'. */
    name?: string;
    /** Extra editor-facing metadata merged into mesh.userData (feature/source/edit hints). */
    editorData?: Record<string, unknown> | null;
}

export const DEFAULT_CRUMBLING_PLATFORM_OPTIONS: Omit<CrumblingPlatformOptions, 'center' | 'getPlayerFeet'> = {
    size: new THREE.Vector3(2.9, 0.5, 2.9),
    breakAfterS: 0.7,
    respawnAfterS: 3,
    color: 0x9c7b4a,
};

type CrumbleState = 'solid' | 'armed' | 'broken';

/** Editable-param plumbing shared with KinematicPlatform — see its docs. */


/**
 * CrumblingPlatform — a static slab that breaks away shortly after a player
 * stands on it and re-forms a few seconds later. The classic platformer
 * "ground that breaks once you step on it".
 *
 * While armed it shudders (visual warning); when broken, both the mesh and the
 * collider are gone, so the player falls through. Call `update(deltaTime)` each
 * frame and `dispose()` on teardown.
 */
export class CrumblingPlatform {
    private readonly engine: EngineLike;
    private readonly opts: CrumblingPlatformOptions;
    private readonly mesh: THREE.Mesh;
    private readonly body: RAPIER.RigidBody;
    private collider: RAPIER.Collider | null = null;
    private state: CrumbleState = 'solid';
    private timer = 0;

    constructor(engine: EngineLike, options: CrumblingPlatformOptions) {
        if (!engine.physicsWorld) {
            throw new Error('CrumblingPlatform requires an initialized physicsWorld on the engine.');
        }
        this.engine = engine;
        this.opts = options;

        const geom = new THREE.BoxGeometry(options.size.x, options.size.y, options.size.z);
        const mat = createClassedPartMaterial('stone', { color: new THREE.Color(options.color).getHex() });
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.mesh.position.copy(options.center);
        // Self-describing for the creator's editor (never "Unnamed").
        this.mesh.name = options.name ?? 'CrumblingPlatform';
        const editorData = { ...(options.editorData ?? {}) };
        const persistPaths = editorData['__persistPaths'];
        delete editorData['__persistPaths'];
        Object.assign(this.mesh.userData, {
            mechanism: 'CrumblingPlatform',
            source: 'engine:CrumblingPlatform',
            breakAfterS: options.breakAfterS,
            respawnAfterS: options.respawnAfterS,
            ...editorData,
        });
        // Live-edit contract for the editor (see KinematicPlatform for the shape).
        Object.defineProperty(this.mesh.userData, '__editable', {
            value: {
                breakAfterS: { min: 0.1, max: 10, step: 0.1 },
                respawnAfterS: { min: 0.5, max: 60, step: 0.5 },
            },
            enumerable: false, configurable: true,
        });
        Object.defineProperty(this.mesh.userData, '__mechanism', { value: this, enumerable: false, configurable: true });
        if (persistPaths) {
            Object.defineProperty(this.mesh.userData, '__persistPaths', { value: persistPaths, enumerable: false, configurable: true });
        }
        engine.scene?.add(this.mesh);

        const RAPIER = getRapier();
        this.body = engine.physicsWorld.createRigidBody(
            RAPIER.RigidBodyDesc.fixed().setTranslation(options.center.x, options.center.y, options.center.z),
        );
        this.createCollider();
    }

    private createCollider(): void {
        const RAPIER = getRapier();
        const desc = RAPIER.ColliderDesc.cuboid(this.opts.size.x / 2, this.opts.size.y / 2, this.opts.size.z / 2)
            .setFriction(1.0)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        this.collider = this.engine.physicsWorld!.createCollider(desc, this.body);
    }

    private playerOnTop(): boolean {
        const feet = this.opts.getPlayerFeet();
        if (!feet) return false;
        const c = this.opts.center;
        const top = c.y + this.opts.size.y / 2;
        return Math.abs(feet.x - c.x) <= this.opts.size.x / 2 + 0.35
            && Math.abs(feet.z - c.z) <= this.opts.size.z / 2 + 0.35
            && feet.y >= top - 0.3 && feet.y <= top + 0.6;
    }

    /**
     * Apply a live edit from the editor's object inspector (see
     * KinematicPlatform.applyEditableParam). Timers read opts live, so the
     * next crumble cycle uses the new values immediately.
     */
    applyEditableParam(key: string, value: number): boolean {
        if (!Number.isFinite(value)) return false;
        const spec = (this.mesh.userData['__editable'] as Record<string, { min: number; max: number }> | undefined)?.[key];
        if (!spec) return false;
        const v = Math.min(spec.max, Math.max(spec.min, value));
        if (key === 'breakAfterS') this.opts.breakAfterS = v;
        else if (key === 'respawnAfterS') this.opts.respawnAfterS = v;
        else return false;
        this.mesh.userData[key] = v;
        return true;
    }

    update(deltaTime: number): void {
        if (this.state === 'solid') {
            if (this.playerOnTop()) {
                this.state = 'armed';
                this.timer = 0;
            }
            return;
        }
        this.timer += deltaTime;
        if (this.state === 'armed') {
            // Shudder as the warning tell.
            const s = Math.sin(this.timer * 55) * 0.05;
            this.mesh.position.set(this.opts.center.x + s, this.opts.center.y, this.opts.center.z - s);
            if (this.timer >= this.opts.breakAfterS) {
                this.state = 'broken';
                this.timer = 0;
                this.mesh.visible = false;
                this.mesh.position.copy(this.opts.center);
                if (this.collider) {
                    this.engine.physicsWorld!.removeCollider(this.collider);
                    this.collider = null;
                }
            }
        } else if (this.state === 'broken' && this.timer >= this.opts.respawnAfterS) {
            this.state = 'solid';
            this.timer = 0;
            this.mesh.visible = true;
            this.createCollider();
        }
    }

    dispose(): void {
        this.engine.scene?.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
        this.engine.physicsWorld?.removeRigidBody(this.body);
    }
}
