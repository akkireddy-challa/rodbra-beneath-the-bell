import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { IPlayerAttack, AttackActionHandler } from 'engine/IPlayerAttack.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import type { Projectile } from 'engine/Projectile.js';
import type { IWeaponMagazine } from 'engine/IWeaponMagazine.js';
import { WeaponMagazineComponent } from 'engine/WeaponMagazineComponent.js';
import { ShootableComponent } from 'engine/ShootableComponent.js';
import { createRangedProjectileConfig } from 'engine/weapons/RangedProjectileConfig.js';
import {
    createRangedWeaponMesh, makeRangedWeaponVisualOnly, type RangedWeaponTypeId,
} from 'engine/RangedWeaponRegistry.js';
import type { RangedWeaponPreset } from 'engine/RangedWeaponTypes.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import { calculateCameraAimPoint, RETICLE_VERTICAL_FRACTION } from 'engine/weapons/CameraAim.js';
import { fireWeaponShot } from 'engine/weapons/WeaponVolley.js';
import { DEFAULT_VIEW_PUNCH_OPTIONS, type ViewPunchTarget } from 'engine/FirstPersonCamera.js';
import type { ViewModelLayer } from 'engine/ViewModelLayer.js';
import { createPose } from 'engine/viewmodel/PoseCurve.js';
import { RigInputReader } from 'engine/viewmodel/RigInput.js';
import {
    DEFAULT_VIEW_MODEL_RIG_OPTIONS, ViewModelRig, type ViewModelRigOptions,
} from 'engine/viewmodel/ViewModelRig.js';
import {
    DEFAULT_RECOIL_PROFILE, RECOIL_PROFILES, type RecoilClass, type RecoilProfile,
} from 'engine/viewmodel/RecoilProfiles.js';
import { DEFAULT_MUZZLE_FLASH_OPTIONS, MuzzleFlash, type MuzzleFlashOptions } from 'engine/viewmodel/MuzzleFlash.js';
import { DEFAULT_SHELL_EJECTION_OPTIONS, ShellEjector, type ShellEjectionOptions } from 'engine/viewmodel/ShellEjector.js';
import { clampWeaponPartMaterialsToDirect } from 'engine/WeaponPartMaterial.js';

/**
 * First-person guns: a proper view model, driven by the shared rig.
 *
 * WHY THIS EXISTS RATHER THAN A FIRST-PERSON BRANCH IN RangedWeaponSystem.
 * That system parents the weapon to the PLAYER ROOT, and CameraManager hides
 * the player root in first person — so an equipped gun has never actually been
 * visible in first person, and the first-person offsets in that file were being
 * applied to an invisible mesh. There is no working behaviour to preserve, and
 * PlayerController holds exactly one IPlayerAttack, so the two are siblings:
 * RangedWeaponSystem owns third-person and top-down, this owns first person.
 * The genuinely shared part — where the crosshair is pointing — is factored out
 * into weapons/CameraAim.ts and used by both.
 *
 * What this adds on top of that shared stack is the part a view model needs and
 * a body-parented weapon cannot have: the weapon lives in the view-model layer
 * (its own scene, its own depth buffer, its own field of view), the rig gives it
 * sway, bob and recoil, and firing kicks the camera by an amount the WEAPON
 * decides — see RecoilProfile.recenter.
 *
 * Everything else is reused, not reimplemented: ShootableComponent for firing
 * and projectile spawning, WeaponMagazineComponent for ammo and reloads, the
 * engine HUD for the ammo counter and reticle, RangedWeaponRegistry for meshes
 * and presets.
 */

/** Aim-down-sights configuration. */
export interface FirstPersonAdsOptions {
    /** Degrees the WORLD camera narrows by at full aim. */
    fovNarrowDegrees: number;
    /**
     * Look-sensitivity multiplier at full aim, or null to match the zoom.
     *
     * Null computes the tangent-matched ratio, which keeps a centimetre of
     * mouse movement covering the same on-screen distance at both zoom levels.
     * That is what anyone with shooter muscle memory expects; a flat 0.5 feels
     * wrong for reasons players cannot name.
     */
    sensitivityScale: number | null;
    /** Hide the crosshair once the sights are up. */
    hideReticle: boolean;
    /** Bind the right mouse button to aim. */
    bindRightMouse: boolean;
    /** Extra keys that aim while held. */
    desktopKeys: string[];
}

export interface FirstPersonWeaponOptions {
    /** Weapon to equip on construction (RangedWeaponRegistry id). */
    weaponType: RangedWeaponTypeId;
    /** Aim-down-sights behaviour, or null to disable aiming entirely. */
    ads: FirstPersonAdsOptions | null;
    /** Muzzle flash, or null for none. */
    muzzleFlash: MuzzleFlashOptions | null;
    /** Shell ejection, or null for none. */
    shellEjection: ShellEjectionOptions | null;
    /** Drive the HUD crosshair from the weapon's real accuracy. */
    dynamicCrosshair: boolean;
    /** Ammo source. Null builds a standard magazine from the weapon preset. */
    magazine: IWeaponMagazine | null;
    /** Recoil override. Null picks a profile from the preset's handling. */
    recoil: RecoilProfile | null;
    /** Rig overrides (sway, bob, poses). */
    rig: Partial<ViewModelRigOptions>;
    /** Seeds recoil scatter, so replays and multiplayer peers agree. */
    recoilSeed: number;
}

export const DEFAULT_FIRST_PERSON_ADS_OPTIONS: FirstPersonAdsOptions = {
    fovNarrowDegrees: 18,
    sensitivityScale: null,
    hideReticle: true,
    bindRightMouse: true,
    desktopKeys: [],
};

export const DEFAULT_FIRST_PERSON_WEAPON_OPTIONS: FirstPersonWeaponOptions = {
    weaponType: 'assault_rifle',
    ads: DEFAULT_FIRST_PERSON_ADS_OPTIONS,
    muzzleFlash: DEFAULT_MUZZLE_FLASH_OPTIONS,
    shellEjection: DEFAULT_SHELL_EJECTION_OPTIONS,
    dynamicCrosshair: true,
    magazine: null,
    recoil: null,
    rig: {},
    recoilSeed: 1,
};

/** Where the weapon rests in camera space when nothing is happening. */
const HIP_POSE = createPose(0.17, -0.17, -0.30, 0.02, -0.05, 0.02);

/**
 * View models are drawn smaller than life. A shipped assault-rifle mesh is
 * ~0.9m long; at arm's length that fills half the screen, which is why every
 * shooter scales its view model down rather than modelling it twice.
 */
const VIEW_MODEL_SCALE = 0.55;

/** Half-life for smoothing the crosshair, seconds — animates instead of jittering. */
const CROSSHAIR_HALF_LIFE = 0.05;

/** Longest press still treated as a shot when the pointer isn't locked. */
const TAP_MAX_DURATION_MS = 300;

/** How much less the WEAPON's own field of view narrows than the world's. */
const VIEW_MODEL_FOV_NARROW_FRACTION = 0.22;

/**
 * Nominal vertical field of view, in degrees — the sights pose's reference
 * geometry, and the fallback when the active camera cannot be asked for its own.
 */
const NOMINAL_FOV_DEGREES = 75;

/** Ammo counter id, matching RangedWeaponSystem's so themes style one thing. */
const AMMO_COUNTER_ID = 'weapon-ammo';

/** Where casings leave a weapon that names no port of its own: beside the muzzle. */
const DEFAULT_EJECT_PORT_OFFSET = new THREE.Vector3(0.02, 0, 0.10);

const _aimPoint = new THREE.Vector3();
const _ejectPoint = new THREE.Vector3();
const _muzzlePoint = new THREE.Vector3();

/**
 * The camera-controller members this system drives, all optional.
 *
 * Duck-typed rather than depending on FirstPersonCamera: a game may be running
 * a vehicle camera or a custom controller, and firing, aiming or landing must
 * degrade quietly instead of throwing because the active camera is not this one.
 */
interface WeaponCameraController {
    getCamera?: () => THREE.PerspectiveCamera;
    applyViewPunch?: ViewPunchTarget['applyViewPunch'];
    setFovOffset?: (deltaDeg: number) => void;
    clearFovOffset?: () => void;
    setLookSensitivityScale?: (scale: number) => void;
}

/**
 * The look-sensitivity ratio that keeps a centimetre of mouse movement covering
 * the same on-screen distance at both zoom levels — the tangent match described
 * on FirstPersonAdsOptions.sensitivityScale.
 */
function tangentMatchedSensitivity(baseFovDegrees: number, narrowDegrees: number): number {
    return Math.tan(THREE.MathUtils.degToRad(baseFovDegrees - narrowDegrees) / 2)
        / Math.tan(THREE.MathUtils.degToRad(baseFovDegrees) / 2);
}

/** Visit every mesh under `root` — the cast-and-check every traverse here needs. */
function forEachMesh(root: THREE.Object3D, visit: (mesh: THREE.Mesh) => void): void {
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) visit(mesh);
    });
}

/** Map a preset's handling onto one of the recoil archetypes. */
function resolveRecoilClass(preset: RangedWeaponPreset): RecoilClass {
    const name = preset.name.toLowerCase();
    if (name.includes('laser') || name.includes('bow') || name.includes('crossbow')) return 'energy';
    const strength = preset.recoilStrength ?? 0.15;
    if (strength >= 0.25) return 'heavy';
    if (strength >= 0.12) return 'pistol';
    return 'rifle';
}

export class FirstPersonWeaponSystem implements IPlayerAttack {
    private readonly engine: EngineLike;
    private readonly physicsWorld: PhysicsWorld;
    private readonly options: FirstPersonWeaponOptions;
    private controller: PlayerController | null = null;

    private readonly layer: ViewModelLayer | null;
    private readonly root = new THREE.Group();
    /**
     * What the rig poses. The weapon mesh hangs beneath it carrying a fixed
     * 180-degree yaw, because weapon meshes are authored muzzle-along-+Z (the
     * gameplay forward convention, correct when the weapon is parented to a
     * player) while a camera looks down -Z. Without the flip the weapon is
     * aimed squarely at the viewer. Keeping the flip on its own node means
     * every pose in this file stays in plain camera-space terms.
     */
    private readonly poseNode = new THREE.Group();
    private weaponMesh: THREE.Group | null = null;
    private preset: RangedWeaponPreset | null = null;
    private weaponType: RangedWeaponTypeId | null = null;

    private readonly rig: ViewModelRig;
    private shootable: ShootableComponent | null = null;
    private magazine: IWeaponMagazine | null = null;
    private muzzleFlash: MuzzleFlash | null = null;
    private shellEjector: ShellEjector | null = null;

    /**
     * A stand-in for the weapon in WORLD space, in no scene at all.
     *
     * ShootableComponent spawns from `parentTransform.localToWorld(muzzleOffset)`,
     * and the weapon's real parent is the view-model scene, whose world matrix
     * means nothing to the world. Because the view-model camera is pinned to the
     * main camera's transform, camera-local coordinates transfer across exactly:
     * composing the main camera's world matrix with the weapon's local matrix
     * puts this proxy precisely where the weapon appears to be.
     */
    private readonly muzzleProxy = new THREE.Object3D();

    private triggerHeld = false;
    private queuedShot = false;
    private mouseDownTime = 0;
    private adsHeld = false;
    private mobileControls: unknown = null;
    private smoothedSpread = 0;
    /**
     * Projectiles this weapon has spawned.
     *
     * ShootableComponent creates a projectile and hands it back; ADVANCING it is
     * the caller's job. Spawning without tracking leaves every bullet frozen at
     * the muzzle forever — visible as tracers hanging in the air that never
     * travel, never collide and never produce an impact.
     */
    private projectiles: Projectile[] = [];
    private readonly rigInput = new RigInputReader();
    private ammoCounterCreated = false;
    private baseWorldFov: number | null = null;
    private disposed = false;

    /** Document listeners installed by setupEventListeners, for exact removal. */
    private documentListeners: [type: string, handler: EventListener][] = [];

    /** Fired for every projectile this weapon spawns. */
    onProjectileCreated: ((projectile: Projectile) => void) | null = null;

    constructor(engine: EngineLike, physicsWorld: PhysicsWorld, options: FirstPersonWeaponOptions) {
        this.engine = engine;
        this.physicsWorld = physicsWorld;
        this.options = options;

        this.root.name = 'FirstPersonWeaponViewModel';
        this.poseNode.name = 'FirstPersonWeaponPose';
        this.root.add(this.poseNode);
        this.layer = engine.getViewModelLayer?.() ?? null;
        if (this.layer) {
            this.layer.attach(this.root);
        } else {
            console.warn('FirstPersonWeaponSystem: no view-model layer — the weapon will not render');
        }

        this.rig = new ViewModelRig({
            ...DEFAULT_VIEW_MODEL_RIG_OPTIONS,
            restPose: HIP_POSE,
            recoil: options.recoil ?? DEFAULT_RECOIL_PROFILE,
            seed: options.recoilSeed,
            ...options.rig,
        });

        if (options.muzzleFlash) {
            // Borrows the layer's permanent flash light, so the view-model
            // scene's light set never changes and nothing recompiles.
            this.muzzleFlash = new MuzzleFlash(options.muzzleFlash, this.layer?.flashLight ?? null);
            this.muzzleFlash.attachTo(this.poseNode, _muzzlePoint.set(0, 0, 0));
        }
        if (options.shellEjection) {
            this.shellEjector = new ShellEjector(options.shellEjection);
            // On the view root, not the weapon: a shell that has left the gun
            // must stop inheriting the gun's recoil and sway.
            this.shellEjector.attachTo(this.root);
        }

        this.equipWeapon(options.weaponType);
    }

    // ── Weapon ────────────────────────────────────────────────────────────────

    equipWeapon(weaponType: RangedWeaponTypeId): void {
        this.unequipWeapon();

        const { mesh, preset } = createRangedWeaponMesh(weaponType);
        mesh.name = `FirstPersonWeapon_${weaponType}`;
        // The view-model layer is its own scene with no `scene.environment`
        // (deliberately world-independent, lit for legibility), so an
        // environment-tier class material has nothing to reflect and renders
        // metals dark and flat. Rebuild those parts at the Phong tier — a
        // readable travelling highlight under the layer's key/fill rig.
        clampWeaponPartMaterialsToDirect(mesh);
        // Keeps it out of physics and out of every sweep volume, so a weapon can
        // never be hit by its own owner's attacks.
        makeRangedWeaponVisualOnly(mesh);
        // A view model is always in front of the camera by construction, and
        // culling it against the view-model camera's frustum only risks it
        // popping out at the edges of a wide screen.
        forEachMesh(mesh, (child) => { child.frustumCulled = false; });
        mesh.frustumCulled = false;

        // Gameplay-forward (+Z) to camera-forward (-Z).
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(VIEW_MODEL_SCALE);
        this.poseNode.add(mesh);
        this.weaponMesh = mesh;
        this.preset = preset;
        this.weaponType = weaponType;

        this.rig.setRestPose(HIP_POSE);
        this.rig.setSightsPose(this.buildSightsPose(preset));
        this.rig.setBobScale(preset.viewBobScale ?? 1);
        if (!this.options.recoil) this.rig.setRecoilProfile(RECOIL_PROFILES[resolveRecoilClass(preset)]);

        this.shootable = new ShootableComponent(
            preset.muzzleOffset.clone(),
            preset.fireRate,
            createRangedProjectileConfig(preset),
        );

        if (this.options.magazine) {
            this.magazine = this.options.magazine;
            // The caller configured the capacity; keep it and take only the
            // preset's reload timing.
            this.magazine.reset(this.magazine.getMagazineSize(), preset.reloadDuration);
        } else {
            this.magazine = new WeaponMagazineComponent({
                magazineSize: preset.magazineSize,
                reloadDuration: preset.reloadDuration ?? 1500,
                autoReload: preset.autoReload ?? true,
                reloadEnabled: preset.reloadEnabled ?? true,
            });
        }

        this.aimMuzzleFlash(preset);
        this.rig.startAction('equip');
        this.refreshAmmoCounter();
        this.hud()?.showReticle();
    }

    unequipWeapon(): void {
        if (this.weaponMesh) {
            this.poseNode.remove(this.weaponMesh);
            forEachMesh(this.weaponMesh, (child) => {
                child.geometry?.dispose();
                if (child.material instanceof THREE.Material) child.material.dispose();
            });
            this.weaponMesh = null;
        }
        // The muzzle flash deliberately SURVIVES an unequip: disposing it would
        // remove its light from the scene and pay the recompile again.
        this.preset = null;
        this.weaponType = null;
        this.shootable = null;
    }

    /**
     * Point the (permanently attached) flash at this weapon's muzzle.
     *
     * The flash and its light are built once in the constructor and never leave
     * the scene — see MuzzleFlash.attachTo for why re-attaching per equip is a
     * WebGPU shader-recompile stall.
     */
    private aimMuzzleFlash(preset: RangedWeaponPreset): void {
        if (!this.muzzleFlash || !this.weaponMesh) return;
        this.weaponMesh.updateMatrix();
        // Weapon-local to pose-node space, through the mesh's fixed convention
        // flip and view-model scale.
        _muzzlePoint.copy(preset.muzzleOffset).applyMatrix4(this.weaponMesh.matrix);
        this.muzzleFlash.setMuzzleOffset(_muzzlePoint);
        this.muzzleFlash.setColor(this.options.muzzleFlash?.color ?? preset.projectileColor ?? 0xffcc66);
    }

    /**
     * Where the weapon sits at full aim.
     *
     * Centred horizontally and lifted to the CROSSHAIR — which sits slightly
     * below screen centre — because the sights have to line up with the reticle
     * the player was just using, not with the geometric middle of the screen.
     */
    private buildSightsPose(preset: RangedWeaponPreset) {
        const sightDistance = preset.hands === 2 ? 0.36 : 0.28;
        // Angle from screen centre down to the reticle, at the nominal field of view.
        const theta = Math.atan(2 * (RETICLE_VERTICAL_FRACTION - 0.5)
            * Math.tan(THREE.MathUtils.degToRad(NOMINAL_FOV_DEGREES) / 2));
        return createPose(0, -0.038 - sightDistance * Math.tan(theta), -sightDistance, -theta, 0, 0);
    }

    getWeaponType(): RangedWeaponTypeId | null { return this.weaponType; }
    getWeaponPreset(): RangedWeaponPreset | null { return this.preset; }
    getRig(): ViewModelRig { return this.rig; }
    getMagazine(): IWeaponMagazine | null { return this.magazine; }
    isAimingDownSights(): boolean { return this.rig.getAdsBlend() > 0.5; }

    setMagazine(magazine: IWeaponMagazine | null): void {
        this.magazine = magazine;
        this.refreshAmmoCounter();
    }

    /** Play the inspect flourish. Opt-in; the engine binds no key to it. */
    playInspect(): void { this.rig.startAction('inspect'); }

    // ── Firing ────────────────────────────────────────────────────────────────

    setTriggerHeld(held: boolean): void { this.triggerHeld = held; }

    setAimDownSights(active: boolean): void { this.adsHeld = active; }

    reload(): void {
        if (!this.magazine || this.magazine.getIsReloading()) return;
        if (this.magazine.getCurrentAmmo() >= this.magazine.getMagazineSize()) return;
        this.magazine.startReload();
        this.rig.startAction('reload', this.magazine.getReloadDuration() / 1000);
    }

    /** Fire once if the weapon is ready. Safe to call every frame. */
    triggerShoot(): void {
        if (!this.shootable || !this.preset || !this.controller) return;
        if (!getGameStateManager().isState(GameState.PLAYING)) return;
        if (this.magazine) {
            if (this.magazine.getIsReloading()) return;
            if (this.magazine.getCurrentAmmo() <= 0) {
                if (this.magazine.isAutoReloadEnabled()) this.reload();
                return;
            }
        }
        if (!this.shootable.canShoot()) return;

        this.syncMuzzleProxy();

        // One bullet, or a shotgun's pellet volley — shared with
        // RangedWeaponSystem so a weapon patterns the same in either.
        const spawned = fireWeaponShot(
            this.shootable, this.muzzleProxy, this.physicsWorld, this.engine,
            this.preset, this.resolveAimPoint(),
        );
        if (spawned.length === 0) return;

        this.magazine?.tryConsume();
        this.refreshAmmoCounter();
        for (const projectile of spawned) {
            this.projectiles.push(projectile);
            this.onProjectileCreated?.(projectile);
        }

        this.applyShotFeedback();
    }

    /** Everything a shot does that isn't the bullet: kick, flash, shell. */
    private applyShotFeedback(): void {
        const impulse = this.rig.addRecoilShot();
        this.punchCamera(impulse.cameraPitch, impulse.cameraYaw, this.rig.getRecoilProfile().recenter);

        this.muzzleFlash?.trigger();

        if (this.shellEjector && this.preset && this.weaponMesh && this.preset.ejectsShells !== false) {
            if (this.preset.ejectPort) _ejectPoint.copy(this.preset.ejectPort);
            else _ejectPoint.copy(this.preset.muzzleOffset).add(DEFAULT_EJECT_PORT_OFFSET);
            // Weapon-local to view space, so the shell starts exactly at the port.
            this.root.updateMatrixWorld(true);
            _ejectPoint.applyMatrix4(this.weaponMesh.matrixWorld);
            this.shellEjector.eject(_ejectPoint);
        }
    }

    /** The active camera controller, as the optional surface this system uses. */
    private cameraController(): WeaponCameraController | null {
        return (this.controller?.getCameraController() as WeaponCameraController | null) ?? null;
    }

    /** Kick the view, if the active camera can take one. */
    private punchCamera(pitchRad: number, yawRad: number, recenter: number): void {
        const camera = this.cameraController();
        // `typeof`, not an optional call: the member is duck-typed off an
        // unknown controller, and a non-function value under this name would
        // throw rather than be skipped.
        if (!camera || typeof camera.applyViewPunch !== 'function') return;
        camera.applyViewPunch(pitchRad, yawRad, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter });
    }

    private resolveAimPoint(): THREE.Vector3 | null {
        const camera = this.cameraController()?.getCamera?.();
        const player = this.controller?.player;
        if (!camera || !player) return null;
        return calculateCameraAimPoint(camera, player, this.physicsWorld, _aimPoint);
    }

    /**
     * Put the muzzle proxy where the weapon appears to be, in world space.
     * See the field's own note for why this composition is exact.
     */
    private syncMuzzleProxy(): void {
        const mainCamera = this.engine.camera;
        if (!mainCamera || !this.weaponMesh) return;
        mainCamera.updateMatrixWorld(true);
        // root sits at the view-model scene's origin, so the weapon's matrixWorld
        // within that scene IS its camera-local transform.
        this.root.updateMatrixWorld(true);
        this.muzzleProxy.matrix.multiplyMatrices(mainCamera.matrixWorld, this.weaponMesh.matrixWorld);
        this.muzzleProxy.matrix.decompose(
            this.muzzleProxy.position, this.muzzleProxy.quaternion, this.muzzleProxy.scale,
        );
        this.muzzleProxy.updateMatrixWorld(true);
    }

    // ── IPlayerAttack ─────────────────────────────────────────────────────────

    setController(controller: PlayerController): void { this.controller = controller; }
    setMobileControls(mobileControls: unknown): void { this.mobileControls = mobileControls; }

    getActionHandler(): AttackActionHandler {
        return { actionType: 'shoot', handler: () => { this.queuedShot = true; } };
    }

    setupEventListeners(): void {
        // Registered through one helper so every handler is guaranteed to be
        // removed again — the bound reference is remembered at the same moment
        // it is installed, rather than in a parallel set of fields to keep in
        // step with this list.
        const on = <E extends Event>(type: string, handler: (event: E) => void): void => {
            document.addEventListener(type, handler as EventListener);
            this.documentListeners.push([type, handler as EventListener]);
        };

        on<MouseEvent>('mousedown', (event) => {
            if (event.button === 0) {
                this.mouseDownTime = performance.now();
                // While pointer-locked a click is unambiguously a shot; unlocked,
                // the same button drags the camera, so only a short tap counts.
                if (document.pointerLockElement) { this.triggerHeld = true; this.queuedShot = true; }
            } else if (event.button === 2 && this.options.ads?.bindRightMouse) {
                this.adsHeld = true;
            }
        });
        on<MouseEvent>('mouseup', (event) => {
            if (event.button === 0) {
                if (!document.pointerLockElement
                    && performance.now() - this.mouseDownTime < TAP_MAX_DURATION_MS) {
                    this.queuedShot = true;
                }
                this.triggerHeld = false;
            } else if (event.button === 2 && this.options.ads?.bindRightMouse) {
                this.adsHeld = false;
            }
        });
        on<KeyboardEvent>('keydown', (event) => {
            if (event.code === 'KeyR') this.reload();
            if (this.options.ads?.desktopKeys.includes(event.code)) this.adsHeld = true;
        });
        on<KeyboardEvent>('keyup', (event) => {
            if (this.options.ads?.desktopKeys.includes(event.code)) this.adsHeld = false;
        });
        // Right-drag aiming is useless if the browser menu opens over it.
        on<Event>('contextmenu', (event) => {
            if (this.options.ads?.bindRightMouse) event.preventDefault();
        });
    }

    removeEventListeners(): void {
        for (const [type, handler] of this.documentListeners) {
            document.removeEventListener(type, handler);
        }
        this.documentListeners = [];
    }

    update(deltaTime: number): boolean {
        if (this.disposed) return false;

        const playing = getGameStateManager().isState(GameState.PLAYING);
        const mobile = this.mobileControls as { actionPressed?: boolean; resetActionPressed?: () => void } | null;
        if (!playing) {
            // Drop buffered input so an editor-mode click cannot fire the
            // instant play starts.
            this.queuedShot = false;
            this.triggerHeld = false;
            if (mobile?.actionPressed) mobile.resetActionPressed?.();
        } else {
            if (mobile?.actionPressed) { mobile.resetActionPressed?.(); this.queuedShot = true; }
            if (this.queuedShot || this.triggerHeld) {
                this.queuedShot = false;
                this.triggerShoot();
            }
        }

        this.magazine?.update();
        this.updateProjectiles(deltaTime);
        this.updateRig(deltaTime);
        this.applyAds();
        this.muzzleFlash?.update(deltaTime);
        this.shellEjector?.update(deltaTime);

        this.rig.applyTo(this.poseNode);
        this.updateCrosshair(deltaTime);
        this.refreshAmmoCounter();

        // Shooting never blocks movement — strafing while firing is core to the
        // feel of every first-person shooter worth the name.
        return false;
    }

    /** Advance every live bullet and retire the ones that are done. */
    private updateProjectiles(deltaTime: number): void {
        if (this.projectiles.length === 0) return;
        this.projectiles = this.projectiles.filter((projectile) => {
            projectile.update(deltaTime);
            if (projectile.isExpired()) {
                projectile.dispose();
                return false;
            }
            return true;
        });
    }

    /**
     * Live projectiles, for NPC collision checks — the same contract
     * RangedWeaponSystem exposes, so game code works against either system.
     */
    getProjectiles(): Projectile[] {
        return this.projectiles;
    }

    /** Retire one projectile early (e.g. a game-side hit resolved it). */
    removeProjectile(projectile: Projectile): void {
        const index = this.projectiles.indexOf(projectile);
        if (index === -1) return;
        projectile.dispose();
        this.projectiles.splice(index, 1);
    }

    private updateRig(deltaTime: number): void {
        this.rig.update(deltaTime, this.rigInput.read(
            this.controller, deltaTime, this.options.ads !== null && this.adsHeld,
        ));

        // Landings kick the view as well as the weapon. Fully recentring:
        // landing must never move where you are aiming.
        const landing = this.rig.consumeLandingImpact();
        if (landing > 0) this.punchCamera(-0.35 * landing, 0, 1);
    }

    /**
     * Push the aim blend out to the camera and the HUD.
     *
     * Driven straight from the rig's blend with no extra smoothing of its own:
     * a second half-life here would desynchronise the field of view from the
     * weapon's pose, and the pair drifting apart is exactly what makes a bad
     * aim-down-sights feel like mush.
     */
    private applyAds(): void {
        const ads = this.options.ads;
        if (!ads) return;
        const camera = this.cameraController();
        if (!camera) return;

        const blend = this.rig.getAdsBlend();

        if (this.baseWorldFov === null) {
            this.baseWorldFov = camera.getCamera?.()?.fov ?? NOMINAL_FOV_DEGREES;
        }
        if (blend > 0) camera.setFovOffset?.(-ads.fovNarrowDegrees * blend);
        else camera.clearFovOffset?.();

        // The weapon narrows far less than the world, so it does not balloon as
        // the world zooms past it.
        this.layer?.setFovOffset(ads.fovNarrowDegrees * VIEW_MODEL_FOV_NARROW_FRACTION * blend);

        const full = ads.sensitivityScale
            ?? tangentMatchedSensitivity(this.baseWorldFov, ads.fovNarrowDegrees);
        camera.setLookSensitivityScale?.(1 + (full - 1) * blend);

        if (ads.hideReticle) {
            if (blend > 0.6) this.hud()?.hideReticle();
            else this.hud()?.showReticle();
        }
    }

    private updateCrosshair(deltaTime: number): void {
        if (!this.options.dynamicCrosshair) return;
        const hud = this.hud();
        if (!hud?.setReticleSpread) return;
        const target = this.rig.getAccuracy();
        const blend = 1 - Math.pow(2, -deltaTime / CROSSHAIR_HALF_LIFE);
        this.smoothedSpread += (target - this.smoothedSpread) * blend;
        hud.setReticleSpread(this.smoothedSpread);
    }

    /** The HUD, which lives on the controller rather than on the engine. */
    private hud(): IGameHUD | null {
        return this.controller?.hud ?? null;
    }

    private refreshAmmoCounter(): void {
        const hud = this.hud();
        const magazine = this.magazine;
        if (!hud || !magazine) return;

        // Created on first use, and formatted from live magazine state so the
        // counter keeps reading correctly through a reload without the weapon
        // having to push an update for every tick of it.
        // An infinite magazine (size 0) reports Infinity, which a numeric HUD
        // counter cannot tween; show the symbol and feed it a finite value.
        const ammo = magazine.getCurrentAmmo();
        const displayAmmo = Number.isFinite(ammo) ? ammo : 0;
        if (!this.ammoCounterCreated) {
            hud.createCounter(AMMO_COUNTER_ID, {
                anchor: 'bottom-right',
                initialValue: displayAmmo,
                format: (value: number) => {
                    // Equipping a different weapon replaces the default magazine.
                    // The HUD formatter survives that swap and must read the new one.
                    const state = (this.magazine ?? magazine).getAmmoState();
                    if (state.max === 0) return '∞';
                    return state.isReloading
                        ? `${value}/${state.max} RELOADING`
                        : `${value}/${state.max}`;
                },
            });
            this.ammoCounterCreated = true;
        }
        hud.updateCounter(AMMO_COUNTER_ID, displayAmmo);
    }

    dispose(): void {
        this.disposed = true;
        this.removeEventListeners();
        this.unequipWeapon();
        for (const projectile of this.projectiles) projectile.dispose();
        this.projectiles = [];
        this.muzzleFlash?.dispose();
        this.muzzleFlash = null;
        this.shellEjector?.dispose();
        this.shellEjector = null;
        this.layer?.detach(this.root);
        // Hand the camera back exactly as it was found.
        const camera = this.cameraController();
        camera?.clearFovOffset?.();
        camera?.setLookSensitivityScale?.(1);
        this.controller = null;
        this.mobileControls = null;
    }
}
