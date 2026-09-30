import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { IPlayerAttack, AttackActionHandler } from 'engine/IPlayerAttack.js';
import type { WeaponPreset } from 'engine/WeaponRegistry.js';
import { createWeaponMesh, makeWeaponVisualOnly, WeaponType, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import { gatherMeleeSweepCandidates, gatherMeleeBodyHits } from 'engine/MeleeSweepTargets.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import type { ViewModelLayer } from 'engine/ViewModelLayer.js';
import { DEFAULT_VIEW_MODEL_RIG_OPTIONS, ViewModelRig, type ViewModelRigOptions } from 'engine/viewmodel/ViewModelRig.js';
import {
    createSwingCurve, evaluatePoseCurve, resetPose, zeroPose,
    type PoseCurve, type ViewModelPose,
} from 'engine/viewmodel/PoseCurve.js';
import { RigInputReader } from 'engine/viewmodel/RigInput.js';
import { clampWeaponPartMaterialsToDirect } from 'engine/WeaponPartMaterial.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * First-person melee combat — NO skeleton, NO animation clips.
 *
 * The classic FPS technique: the weapon is a camera-attached VIEW MODEL and
 * every motion (idle sway, movement bob, swing arcs, recovery) is a procedural
 * transform curve evaluated per frame. A skeletal swing animation would not
 * read correctly this close to the camera anyway — view models are authored
 * as screen-space motion, which is exactly what the parametric curves produce.
 *
 * Because nothing here touches CharacterAnimationController, this system works
 * with headless players (`hasPlayerCharacter: false`) — the standard setup for
 * first-person games — where WeaponMeleeSystem's animation-driven swings
 * cannot run at all.
 *
 * Hit detection mirrors WeaponMeleeSystem's contract so the same enemies die
 * the same way: a camera-forward sweep segment tested against IDamageable
 * body capsules (gatherMeleeBodyHits) plus a raycast against damageable /
 * dynamic-body candidates, then impulse + onMeleeHit + impact VFX.
 *
 * Inputs: left click (instant while pointer-locked, tap otherwise), the Enter
 * action key, and the mobile action button — same bindings as WeaponMeleeSystem.
 */

export interface FirstPersonMeleeOptions {
    /** Weapon to equip (WeaponRegistry id — built-in or custom). */
    weaponType: WeaponTypeId;
    /** Multiplier on the weapon preset's attackRange for first-person reach. */
    reachScale: number;
    /** Full swing duration in seconds (windup + strike + recover). */
    swingDuration: number;
    /**
     * Overrides for the view-model rig (sway, bob, idle motion).
     *
     * Optional because this options object is part of a shipped engine API that
     * published games already construct as an object literal; a required field
     * would fail to compile against their frozen template code.
     */
    rig?: Partial<ViewModelRigOptions>;
}

export const DEFAULT_FIRST_PERSON_MELEE_OPTIONS: FirstPersonMeleeOptions = {
    weaponType: WeaponType.SWORD,
    reachScale: 1.0,
    swingDuration: 0.38,
};

/** Longest press still treated as an attack tap when the pointer isn't locked
 *  (unlocked first-person drags the camera with the same button). */
const TAP_MAX_DURATION_MS = 300;

/** Swing phase boundaries as fractions of swingDuration. */
const WINDUP_END = 0.18;
const STRIKE_END = 0.62;
/** Hit checks run only inside the strike window. */
const HIT_WINDOW_START = 0.22;

/** Resting pose of the view model relative to the camera (right-handed grip,
 *  lower-right of the screen, blade tilted up-forward). Weapon meshes from
 *  WeaponRegistry are authored grip-at-origin, blade along +Y. */
const VIEW_POSITION = new THREE.Vector3(0.30, -0.32, -0.55);
const VIEW_ROTATION = new THREE.Euler(-0.95, 0.18, 0.12);

const _tmpVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _sweepFrom = new THREE.Vector3();
const _sweepTo = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _forceDir = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();

type SwingPattern = 'slash' | 'backslash' | 'chop';
const SWING_SEQUENCE: SwingPattern[] = ['slash', 'backslash', 'chop'];

/** Per-pattern peak offsets applied on top of the resting pose. `windup` is the
 *  pull-back pose, `strike` the follow-through pose; the curve travels
 *  0 → windup → strike → 0. */
const SWING_POSES: Record<SwingPattern, {
    windup: { rot: THREE.Vector3; pos: THREE.Vector3 };
    strike: { rot: THREE.Vector3; pos: THREE.Vector3 };
}> = {
    slash: {
        windup: { rot: new THREE.Vector3(-0.25, 0.55, 0.30), pos: new THREE.Vector3(0.14, 0.06, 0.08) },
        strike: { rot: new THREE.Vector3(-0.15, -1.05, -0.55), pos: new THREE.Vector3(-0.34, -0.06, -0.22) },
    },
    backslash: {
        windup: { rot: new THREE.Vector3(-0.25, -0.75, -0.35), pos: new THREE.Vector3(-0.20, 0.04, 0.08) },
        strike: { rot: new THREE.Vector3(-0.15, 0.75, 0.45), pos: new THREE.Vector3(0.22, -0.06, -0.22) },
    },
    chop: {
        windup: { rot: new THREE.Vector3(0.75, 0.10, 0.05), pos: new THREE.Vector3(0.04, 0.16, 0.10) },
        strike: { rot: new THREE.Vector3(-1.15, -0.10, -0.10), pos: new THREE.Vector3(-0.04, -0.24, -0.26) },
    },
};

export class FirstPersonMeleeSystem implements IPlayerAttack {
    private readonly engine: EngineLike;
    private readonly options: FirstPersonMeleeOptions;
    private controller: PlayerController | null = null;

    // View model
    private readonly viewContainer: THREE.Group;
    private weaponMesh: THREE.Group | null = null;
    private weaponPreset: WeaponPreset | null = null;

    // Procedural animation state
    private swingT = -1; // -1 = idle, else 0..1 progress
    private swingPatternIndex = 0;
    private activePattern: SwingPattern = 'slash';
    private readonly hitThisSwing = new Set<unknown>();

    // Input state
    private attackPressed = false;
    private mouseDownTime = 0;
    private mobileControls: unknown = null;
    private boundOnMouseDown: ((e: MouseEvent) => void) | null = null;
    private boundOnMouseUp: ((e: MouseEvent) => void) | null = null;

    private attackVFX: AttackVFX | null = null;
    private disposed = false;
    // Unregister for the before-render camera-follow hook (fallback path only).
    private unregisterFollow: (() => void) | null = null;
    private readonly viewModelLayer: ViewModelLayer | null;
    private readonly rig: ViewModelRig;
    /** SWING_POSES rebuilt as curves — identical numbers, one shared evaluator. */
    private readonly swingCurves: Record<SwingPattern, PoseCurve>;
    private readonly swingOffset: ViewModelPose = zeroPose();
    private readonly rigInput = new RigInputReader();

    constructor(engine: EngineLike, options: FirstPersonMeleeOptions) {
        this.engine = engine;
        this.options = options;

        this.viewContainer = new THREE.Group();
        this.viewContainer.name = 'FirstPersonMeleeViewModel';

        if (engine.scene) this.attackVFX = new AttackVFX(engine.scene);

        // Preferred home: the engine's view-model layer, a separate scene drawn
        // after the world with its depth buffer cleared. That is what stops the
        // sword from being sliced open by a wall the player backs into, and what
        // keeps it out of the world's fog and depth of field. Its camera never
        // moves, so objects live in camera-local space and there is no follow
        // step at all.
        this.viewModelLayer = engine.getViewModelLayer?.() ?? null;
        if (this.viewModelLayer) {
            this.viewModelLayer.attach(this.viewContainer);
        } else if (engine.scene) {
            // Fallback for engine builds without the layer (and for jest): keep
            // the old main-scene container, glued to the camera at its FINAL
            // per-frame transform via the before-render hook — NOT in update(),
            // which runs early, before the camera controller has repositioned
            // the camera, and leaves the weapon a frame behind it.
            engine.scene.add(this.viewContainer);
            this.unregisterFollow = engine.registerBeforeRender?.(() => this.followCamera()) ?? null;
        } else {
            console.warn('FirstPersonMeleeSystem: no scene available — view model will not render');
        }

        // Sway, bob and idle motion. The rest pose is the same VIEW_POSITION /
        // VIEW_ROTATION the weapon has always sat at, so re-hosting does not
        // move it; the swing arcs below are added on top of whatever the rig
        // produces.
        this.rig = new ViewModelRig({
            ...DEFAULT_VIEW_MODEL_RIG_OPTIONS,
            restPose: {
                position: VIEW_POSITION.clone(),
                rotation: new THREE.Vector3(VIEW_ROTATION.x, VIEW_ROTATION.y, VIEW_ROTATION.z),
            },
            ...(options.rig ?? {}),
        });

        this.swingCurves = {
            slash: this.buildSwingCurve('slash'),
            backslash: this.buildSwingCurve('backslash'),
            chop: this.buildSwingCurve('chop'),
        };

        this.equipWeapon(options.weaponType);
    }

    /** One SWING_POSES entry as a keyed curve. Values and phase boundaries are
     *  unchanged, so the arcs are frame-for-frame what they have always been. */
    private buildSwingCurve(pattern: SwingPattern): PoseCurve {
        const poses = SWING_POSES[pattern];
        return createSwingCurve(
            { position: poses.windup.pos, rotation: poses.windup.rot },
            { position: poses.strike.pos, rotation: poses.strike.rot },
            WINDUP_END,
            STRIKE_END,
        );
    }

    /** Equip a weapon view model by WeaponRegistry id (replaces the current one). */
    equipWeapon(weaponType: WeaponTypeId): void {
        this.unequipWeapon();

        const { mesh, preset } = createWeaponMesh(weaponType);
        // The view-model scene has key/fill lights but no environment map.
        // Resolve reflective weapon parts to the same readable tier as FPS guns.
        clampWeaponPartMaterialsToDirect(mesh);
        // Visual-only: keeps the view model out of physics AND out of the melee
        // sweep volumes (isVisualOnly / noPhysics are excluded by the sweep
        // helpers), so a swing can never hit the player's own sword.
        makeWeaponVisualOnly(mesh);
        mesh.traverse((child) => {
            const m = child as THREE.Mesh;
            if (m.isMesh) {
                m.frustumCulled = false;
                m.renderOrder = 999;
            }
        });
        mesh.frustumCulled = false;
        mesh.position.copy(VIEW_POSITION);
        mesh.rotation.copy(VIEW_ROTATION);

        this.viewContainer.add(mesh);
        this.weaponMesh = mesh;
        this.weaponPreset = preset;
        console.log(`🗡️ FirstPersonMeleeSystem: equipped ${preset.name} (view model, procedural swings)`);
    }

    unequipWeapon(): void {
        if (!this.weaponMesh) return;
        this.viewContainer.remove(this.weaponMesh);
        this.weaponMesh.traverse((child) => {
            const m = child as THREE.Mesh;
            if (m.isMesh) {
                m.geometry?.dispose();
                const materials = Array.isArray(m.material) ? m.material : [m.material];
                materials.forEach(material => material.dispose());
            }
        });
        this.weaponMesh = null;
        this.weaponPreset = null;
    }

    getWeaponPreset(): WeaponPreset | null {
        return this.weaponPreset;
    }

    // ── IPlayerAttack ─────────────────────────────────────────────────────────

    setController(controller: PlayerController): void {
        this.controller = controller;
    }

    setupEventListeners(): void {
        this.boundOnMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            // Pointer-locked first person: the click cannot be a camera drag,
            // so attack instantly (standard FPS feel).
            if (document.pointerLockElement) {
                this.attackPressed = true;
            } else {
                this.mouseDownTime = Date.now();
            }
        };
        this.boundOnMouseUp = (e: MouseEvent) => {
            if (e.button !== 0 || this.mouseDownTime === 0) return;
            const duration = Date.now() - this.mouseDownTime;
            this.mouseDownTime = 0;
            // Unlocked pointer shares the button with camera dragging — only a
            // quick tap counts as an attack (mirrors WeaponMeleeSystem).
            if (duration <= TAP_MAX_DURATION_MS) {
                this.attackPressed = true;
            }
        };
        document.addEventListener('mousedown', this.boundOnMouseDown);
        document.addEventListener('mouseup', this.boundOnMouseUp);
    }

    removeEventListeners(): void {
        if (this.boundOnMouseDown) document.removeEventListener('mousedown', this.boundOnMouseDown);
        if (this.boundOnMouseUp) document.removeEventListener('mouseup', this.boundOnMouseUp);
        this.boundOnMouseDown = null;
        this.boundOnMouseUp = null;
    }

    setMobileControls(mobileControls: unknown): void {
        this.mobileControls = mobileControls;
    }

    getActionHandler(): AttackActionHandler {
        return {
            actionType: 'melee',
            handler: () => this.triggerSwing(),
        };
    }

    /** Start a swing (no-op while one is in progress). Public so game code can
     *  drive attacks from custom inputs. */
    triggerSwing(): void {
        if (this.swingT >= 0 || !this.weaponPreset) return;
        this.activePattern = SWING_SEQUENCE[this.swingPatternIndex % SWING_SEQUENCE.length]!;
        this.swingPatternIndex++;
        this.swingT = 0;
        this.hitThisSwing.clear();
    }

    update(deltaTime: number): boolean {
        if (this.disposed) return false;

        // Camera-follow is ONLY for the fallback main-scene container. In the
        // view-model layer the camera never moves and objects are camera-local,
        // so following here would drag the weapon away from the eye. Within the
        // fallback, the before-render hook is preferred (it runs at the camera's
        // final per-frame transform); this is the last resort for engine builds
        // that have neither.
        if (!this.viewModelLayer && !this.unregisterFollow) this.followCamera();

        const playing = getGameStateManager().isState(GameState.PLAYING);
        // Consume buffered inputs outside gameplay so an editor-mode click
        // doesn't fire a queued swing the moment play starts.
        const mobileCtrl = this.mobileControls as { actionPressed?: boolean; resetActionPressed?: () => void } | null;
        if (!playing) {
            this.attackPressed = false;
            if (mobileCtrl?.actionPressed) mobileCtrl.resetActionPressed?.();
        } else {
            if (this.attackPressed) {
                this.attackPressed = false;
                this.triggerSwing();
            }
            if (mobileCtrl?.actionPressed) {
                mobileCtrl.resetActionPressed?.();
                this.triggerSwing();
            }
        }

        this.updateRig(deltaTime);
        this.updateSwing(deltaTime);

        // First-person melee never blocks movement — strafing through a swing
        // is core FPS feel.
        return false;
    }

    dispose(): void {
        this.disposed = true;
        this.unregisterFollow?.();
        this.unregisterFollow = null;
        this.removeEventListeners();
        this.unequipWeapon();
        if (this.attackVFX) {
            this.attackVFX.dispose();
            this.attackVFX = null;
        }
        if (this.viewModelLayer) {
            this.viewModelLayer.detach(this.viewContainer);
        } else if (this.engine.scene) {
            this.engine.scene.remove(this.viewContainer);
        }
        this.controller = null;
        this.mobileControls = null;
    }

    // ── View-model motion ─────────────────────────────────────────────────────

    private followCamera(): void {
        const camera = this.engine.camera;
        if (!camera) return;
        camera.getWorldPosition(_tmpVec);
        camera.getWorldQuaternion(_tmpQuat);
        this.viewContainer.position.copy(_tmpVec);
        this.viewContainer.quaternion.copy(_tmpQuat);
    }

    /**
     * Drive the shared view-model rig: look sway, stride-cadence bob, idle
     * breathing, landing punch. Everything that is not the swing itself.
     */
    private updateRig(deltaTime: number): void {
        this.rig.update(deltaTime, this.rigInput.read(this.controller, deltaTime, false));
    }

    /** Advance the swing curve, pose the weapon, and run strike-window hit checks. */
    private updateSwing(deltaTime: number): void {
        if (!this.weaponMesh) return;

        resetPose(this.swingOffset);

        if (this.swingT >= 0) {
            this.swingT += deltaTime / this.options.swingDuration;
            const t = this.swingT;

            if (t >= 1) {
                this.swingT = -1; // swing finished, weapon back at rest
            } else {
                evaluatePoseCurve(this.swingCurves[this.activePattern], t, this.swingOffset);
                if (t >= HIT_WINDOW_START && t < STRIKE_END) {
                    this.checkSwingHits();
                }
            }
        }

        // Rig first (rest + sway + bob), swing arc added on top. Additive euler
        // summation is what the hand-rolled version did too, so the arcs read
        // exactly as before — they just now sit on a weapon that also sways.
        const position = this.rig.getPosition();
        const rotation = this.rig.getRotation();
        this.weaponMesh.position.set(
            position.x + this.swingOffset.position.x,
            position.y + this.swingOffset.position.y,
            position.z + this.swingOffset.position.z,
        );
        this.weaponMesh.rotation.set(
            rotation.x + this.swingOffset.rotation.x,
            rotation.y + this.swingOffset.rotation.y,
            rotation.z + this.swingOffset.rotation.z,
        );
    }

    // ── Hit detection (camera-forward sweep) ──────────────────────────────────

    private checkSwingHits(): void {
        const camera = this.engine.camera;
        const scene = this.engine.scene;
        if (!camera || !scene || !this.weaponPreset) return;

        const reach = this.weaponPreset.attackRange * this.options.reachScale;
        camera.getWorldPosition(_sweepFrom);
        camera.getWorldDirection(_forward);
        _sweepTo.copy(_sweepFrom).addScaledVector(_forward, reach);

        const radius = Math.max(this.weaponPreset.bladeRadius * 2, 0.25);

        const hits: THREE.Intersection[] = [];
        // Character body-volume test — the authoritative path for NPCs/animals.
        hits.push(...gatherMeleeBodyHits(scene, _sweepFrom, _sweepTo, radius));
        // Mesh raycast for dynamic props (crates, barrels) and anything the
        // body-volume pass doesn't cover.
        const candidates = gatherMeleeSweepCandidates(scene, _sweepFrom, _sweepTo, radius);
        if (candidates.length > 0) {
            const raycaster = FirstPersonMeleeSystem._raycaster;
            raycaster.set(_sweepFrom, _forward);
            raycaster.near = 0;
            raycaster.far = reach;
            raycaster.params.Mesh = { threshold: radius };
            raycaster.camera = camera;
            raycaster.layers.set(0);
            raycaster.layers.enable(1);
            hits.push(...raycaster.intersectObjects(candidates, false));
        }
        if (hits.length === 0) return;

        this.processHits(hits);
    }

    /** Damage application — mirrors WeaponMeleeSystem.processWeaponHits so both
     *  melee systems affect the world identically. */
    private processHits(intersects: THREE.Intersection[]): void {
        const preset = this.weaponPreset;
        if (!preset) return;

        const hit = intersects
            .sort((a, b) => a.distance - b.distance)
            .find(h => {
                const ud = h.object.userData;
                if (!ud?.physicsBody) return false;
                const controller = ud.damageableController || ud.enemyController;
                return !(controller && this.hitThisSwing.has(controller));
            });
        if (!hit) return;

        const ud = hit.object.userData;
        const damageableController = ud.damageableController || ud.enemyController;
        const mass = (ud.mass as number | undefined) || 0;
        if (mass <= 0) return;

        if (damageableController) {
            this.hitThisSwing.add(damageableController);
        }

        // Knockback along the look direction with a slight lift.
        const camera = this.engine.camera;
        if (camera) camera.getWorldDirection(_forceDir); else _forceDir.set(0, 0, -1);
        _forceDir.y += 0.4;
        _forceDir.normalize();

        const rigidBody = ud.physicsBody as RAPIER.RigidBody;
        rigidBody.applyImpulseAtPoint(
            { x: _forceDir.x * preset.impactForce, y: _forceDir.y * preset.impactForce, z: _forceDir.z * preset.impactForce },
            { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            true,
        );

        if (this.attackVFX) {
            _impactNormal.copy(_forceDir).negate();
            this.attackVFX.createImpactEffect(hit.point, _impactNormal);
        }

        if (typeof damageableController?.onMeleeHit === 'function') {
            damageableController.onMeleeHit(_forceDir, preset.impulseStrength);
        }
    }

    private static readonly _raycaster = new THREE.Raycaster();
}
