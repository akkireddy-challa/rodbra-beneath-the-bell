import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';
import { PlatformVehicleRenderer } from 'engine/renderers/PlatformVehicleRenderer.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import {
    VehicleBodySway,
    DEFAULT_VEHICLE_BODY_SWAY,
    type VehicleBodySwayOptions,
} from 'engine/vehicle/VehicleBodySway.js';
import { downforceGravityScale } from 'engine/vehicle/VehicleDownforce.js';
import { SUSPENSION_MAX_TRAVEL_FRACTION, wheelGuardBox } from 'engine/vehicle/WheelGuards.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { DriverPickupProbe } from 'engine/DriverPickupProbe.js';
import type { VehicleControlsExtension } from 'types/vehicle-extension.js';
import { t } from 'engine/i18n/index.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { SensorIntersectionListener } from 'engine/physics/PhysicsWorld.js';
import { maxTipSafeDriveForce, type TipGeometry } from 'engine/physics/vehicleStability.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import type { IVehicleDrivingComponent } from 'engine/VehicleDrivingComponent.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { GROUND_TYPE, groundGrip } from 'engine/vxlscene/GroundTypes.js';
import { type ObstacleProvider, registerObstacleProvider, unregisterObstacleProvider } from 'engine/VoxelNavMesh.js';
import { type VehicleHandlingConfig, type ResolvedVehicleHandling, resolveVehicleHandling, handlingToAgentUnits, steeringSoftening, steeringSpeedFactor, resolveSteering, gateDriveForce, HANDLING_DEFAULTS, resolveThrottle, resolveBraking, THROTTLE_PARKING_BRAKE_EPSILON } from 'engine/vehicleHandling.js';
import { derivedClimbGrade, derivedStepHeight, type VehicleFootprint, type VehiclePassResult } from 'engine/vehicleTraversability.js';



/**
 * Default lateral (sideways) tyre grip multiplier — Rapier's own default, i.e.
 * "cancel the wheel's sideways velocity as hard as the friction circle allows".
 * See `WheelConfig.sideFrictionStiffness`.
 */
export const DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS = 1.0;

export interface WheelConfig {
    position: THREE.Vector3;
    radius: number;
    width: number;
    suspensionRestLength: number;
    suspensionStiffness: number;
    suspensionDamping: number;
    /**
     * Tyre force capacity, divided by 25 to get Rapier's `frictionSlip`. This
     * bounds the tyre's TOTAL impulse — forward and sideways share one friction
     * circle — so lowering it to break traction sideways also starves the drive
     * force. For a slide that still pulls, cut `sideFrictionStiffness` instead
     * and leave this alone.
     */
    friction: number;
    /**
     * Lateral grip multiplier, applied to the sideways tyre impulse only
     * (Rapier's `sideFrictionStiffness`). Default
     * `DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS` (1 = full bite).
     *
     * This is the drift/donut knob: because it scales the SIDE impulse before
     * the friction circle is evaluated, dropping it on the rear wheels lets the
     * back end step out while the wheels keep every newton of forward thrust.
     * ~0.15 gives a car that pivots on the spot under power; ~0.05 is ice.
     * Unlike `friction`, this value is never rewritten by the per-substep
     * terrain-grip pass, so a value set here or via
     * `setWheelSideFrictionStiffness()` stays put.
     */
    sideFrictionStiffness?: number;
    isDriven: boolean;
    isSteering: boolean;
    torqueRatio?: number;
    color?: number;
}

export function createWheelConfig(
    position: THREE.Vector3,
    options?: Partial<Omit<WheelConfig, 'position'>>
): WheelConfig {
    return {
        position: position.clone(),
        radius: options?.radius ?? 0.4,
        width: options?.width ?? 0.3,
        suspensionRestLength: options?.suspensionRestLength ?? 0.6,
        suspensionStiffness: options?.suspensionStiffness ?? 15,
        suspensionDamping: options?.suspensionDamping ?? 0.4,
        friction: options?.friction ?? 100,
        sideFrictionStiffness: options?.sideFrictionStiffness ?? DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS,
        isDriven: options?.isDriven ?? true,
        isSteering: options?.isSteering ?? false,
        torqueRatio: options?.torqueRatio ?? 1.0,
        color: options?.color
    };
}

/**
 * Default chassis restitution. Small but non-zero: enough that glancing hits on
 * trees, walls and other cars push the car back out instead of pinning it, without
 * turning the track into a pinball table.
 *
 * Applied with `CoefficientCombineRule.Max` so the full value reaches every
 * contact — props are typically restitution 0, and Rapier's default Average
 * rule would halve the pop-out against them.
 */
export const DEFAULT_CHASSIS_RESTITUTION = 0.35;

/**
 * Default chassis friction — deliberately slippery.
 *
 * All of a car's grip comes from the raycast wheels (`frictionSlip`), so the
 * chassis box's own friction does nothing useful: it only decides how readily
 * the body slides when it touches a wall, a prop, or ANOTHER CAR. At Rapier's
 * default 0.5 two chassis boxes pressed together interlock and stay locked
 * until enough engine force builds to tear them apart — the "cars are glued
 * together" bug. Slippery chassis let cars rub along each other and scrape past
 * walls the way an arcade racer should, and make the car-to-car recovery in
 * VehicleUnstuckSystem a rarely-needed backstop rather than the main mechanism.
 *
 * Applied with `CoefficientCombineRule.Min` so this value wins against grippy
 * obstacles (trees 0.5–0.7, rocks 0.8): under Rapier's default Average rule the
 * contact still came out at 0.33–0.48 and cars stuck to whatever they hit.
 * Note this also caps a raised `chassisFriction` override at the obstacle's own
 * friction — "catch and drag" tops out at what the wall would give a crate.
 */
export const DEFAULT_CHASSIS_FRICTION = 0.15;

export interface VehicleConfig {
    chassisSize: { width: number; height: number; length: number };
    mass: number;
    engineForce: number;
    /**
     * Steepest rise/run this vehicle may be routed up, overriding the value
     * derived from force-to-weight. Optional: assets normally have usable mass
     * and engineForce, and this interface is constructed by shipped game code,
     * so it may only gain optional members.
     */
    maxClimbGrade?: number;
    centerOfMassOffset: number;
    /**
     * Chassis bounciness on impact (0 = dead stop, 1 = perfectly elastic).
     * Default `DEFAULT_CHASSIS_RESTITUTION`. A little bounce keeps a car from
     * wedging against trees and walls; raise for arcade bumper-car feel.
     */
    chassisRestitution?: number;
    /**
     * Chassis sliding friction against walls, props and other cars (wheel grip
     * is unaffected — that comes from the raycast wheels). Default
     * `DEFAULT_CHASSIS_FRICTION`; raise it for cars that should catch and drag
     * on what they hit.
     */
    chassisFriction?: number;
    /**
     * Visual body lean (roll into corners, dive/squat under braking and power).
     * Rendered body only — never touches the rigid body. Omit for the default
     * feel, pass overrides to tune it, or `false` to render the body rigid.
     */
    bodySway?: false | Partial<VehicleBodySwayOptions>;
    wheels?: WheelConfig[];
    /** @deprecated Use wheels[] for per-wheel configuration */
    wheelRadius?: number;
    /** @deprecated Use wheels[] for per-wheel configuration */
    wheelWidth?: number;
    /** @deprecated Use wheels[] for per-wheel configuration */
    wheelPositions?: THREE.Vector3[];
    /** @deprecated Use wheels[] for per-wheel configuration */
    suspensionRestLength?: number;
    /** @deprecated Use wheels[] for per-wheel configuration */
    suspensionStiffness?: number;
    /** @deprecated Use wheels[] for per-wheel configuration */
    suspensionDamping?: number;
    /** @deprecated Use wheels[] for per-wheel configuration */
    friction?: number;
    position: THREE.Vector3;
    /** Initial yaw rotation in radians (default 0 = facing +Z). */
    spawnRotation?: number;
    chassisColor?: number;
    wheelColor?: number;
    renderer?: VehicleRenderer;
    /** Optional handling overrides (top speed, steering feel, acceleration). Any field
     *  omitted uses a size-scaled default. See engine/vehicleHandling.ts. */
    handling?: VehicleHandlingConfig;
    /** Disable the tip-over guard that clamps total drive force to what the
     *  chassis can take without flipping (see physics/vehicleStability.ts).
     *  Default false — the guard is on so any mass/engineForce combination
     *  stays drivable out of the box. Set true only for deliberately
     *  flip-prone stunt physics. */
    disableTipOverGuard?: boolean;
    /** Drop the per-wheel guard colliders that give the ray-cast wheels their
     *  sideways collision (see engine/vehicle/WheelGuards.ts). Default false —
     *  without them tyres clip through walls and through each other, since a
     *  ray-cast wheel is a downward ray with no shape. Set true only for a
     *  vehicle whose bodywork already encloses its wheels and which must fit
     *  through a gap measured off the body alone. */
    disableWheelGuards?: boolean;
}

export interface VehicleControls {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    brake: boolean;
    /**
     * Optional analog steering in [-1, 1] (+1 = full left, -1 = full right),
     * for proportional inputs — the touch steering pill, a gamepad stick, an AI
     * driver. When present and non-zero it overrides `left`/`right` and sets the
     * wheel POSITIONALLY (no ramp — the axis already carries the magnitude);
     * 0 or omitted falls back to the boolean keys and their ramp/return.
     */
    steer?: number;
    /**
     * Optional analog throttle in [-1, 1] (+1 = full forward, -1 = full
     * reverse), for AI/proportional controllers that need partial power. When
     * present it overrides `forward`/`backward`; when omitted the booleans are
     * used (the player input path is unchanged). Boolean throttle can only
     * bang-bang a vehicle's speed, which is why an AI driver could never hold a
     * slow cruise or stop smoothly.
     */
    throttle?: number;
    /**
     * Optional analog brake in [0, 1]. When present it overrides `brake`; when
     * omitted the boolean is used. Braking still wins over throttle.
     */
    brakeAmount?: number;
}

/**
 * Fired when a player/NPC/animal enters the vehicle's impact-sensor volume.
 * Direct body-vs-body collision between vehicle and ENEMY/ANIMAL is disabled at
 * the collision-layer level (see CollisionMask.VEHICLE) — the sensor trigger
 * surfaces the event so game code chooses the response (ragdoll, knockback,
 * apply impulse back to vehicle, play sound, deal damage, etc.).
 *
 * The vehicle itself takes **no** automatic action: subscribers are responsible
 * for any character ragdolling AND for any push-back impulse applied to the
 * chassis. Keeps Rapier automation out of the loop, as requested.
 */
export interface VehicleCharacterImpactEvent {
    /** The vehicle whose sensor was triggered. */
    vehicle: RapierVehicle;
    /** The other body that entered the sensor. */
    characterBody: RAPIER.RigidBody;
    /** `__type` tag from the other body's userData ('player' | 'npc' | 'animal'). */
    characterType: 'player' | 'npc' | 'animal';
    /** Magnitude of (vehicleLinvel - characterLinvel) projected onto XZ, in m/s. */
    relativeSpeed: number;
    /** Magnitude of vehicle linear velocity on XZ, in m/s. */
    vehicleSpeed: number;
    /** Approximate impact point (chassis center) in world space. */
    impactPoint: THREE.Vector3;
    /** Vehicle mass at impact (kg) — useful for impulse calculations. */
    mass: number;
}

export interface VehicleBodyPart {
    position: THREE.Vector3;
    size: { width: number; height: number; length: number };
    mass?: number;
}

/**
 * Per-wheel terrain information, updated each physics step.
 * Templates can read this to build terrain-dependent effects (dust, mud splashes, etc.)
 */
export interface WheelTerrainInfo {
    /** Whether this wheel is in contact with the ground */
    inContact: boolean;
    /** World position of the wheel contact point */
    contactPosition: THREE.Vector3;
    /** Block type ID at the contact point (0 = air/no contact) */
    blockType: number;
    /** Terrain type ID (from TerrainTypes registry, -1 = unknown) */
    terrainTypeId: number;
    /**
     * Ground-surface material at the contact point on a BAKED (.vwld) level —
     * a `GROUND_TYPE` byte (`engine/vxlscene/GroundTypes.ts`), 0 = untyped.
     * A separate field from `terrainTypeId` on purpose: that one carries voxel
     * TerrainTypes ids, and the two registries are different number spaces, so
     * merging them would make `terrainTypeId === 3` mean different surfaces on
     * different levels. Always 0 on procedural voxel terrain.
     */
    groundType: number;
    /** Surface grip at contact point (0-1, from terrain type) */
    grip: number;
    /** 
     * How much this wheel is slipping (0 = no slip, 1 = full spin).
     * High values during acceleration = wheel spinning on low-grip surface.
     * High values during braking = wheel locked/skidding.
     * Use this for effects: dirt spray intensity, tire smoke, skid marks, etc.
     */
    slip: number;
    /** Whether this is a driven wheel (receives engine force) */
    isDriven: boolean;
    /** Whether this is a steering wheel */
    isSteering: boolean;
}

/**
 * Structural view of the genre-specific terrain sources this file samples for
 * per-wheel grip. `EngineLike` knows nothing about genres, so the engine object
 * is narrowed to these shapes rather than to `any` — every hop stays optional
 * because a given genre may provide neither voxel terrain nor a baked level.
 */
interface VoxelWorldLike {
    getBlock(x: number, y: number, z: number): number;
    getVoxelSize?(): number;
}
interface VxlSceneTerrainLike {
    getGroundTypeAt(x: number, y: number, z: number): number;
}
interface WorldGeneratorLike {
    getVoxelTerrainSystem?(): { getVoxelWorld?(): VoxelWorldLike | null | undefined } | null | undefined;
    getVxlSceneTerrain?(): VxlSceneTerrainLike | null | undefined;
}
interface GenreModuleLike {
    worldGenerator?: WorldGeneratorLike | null;
    getWorldGenerator?(): WorldGeneratorLike | null | undefined;
}

/**
 * Every LIVE vehicle, regardless of which template, spawner or manager
 * constructed it — populated by the constructor, cleared by dispose(). Engine
 * systems that must see all vehicles without game cooperation (the weather
 * system's tyre spray + wet trails) discover them here; game code should keep
 * using its own references / the VehicleManager.
 */
const activeRapierVehicles = new Set<RapierVehicle>();

/** Read-only view of every live vehicle (see activeRapierVehicles). */
export function getActiveRapierVehicles(): ReadonlySet<RapierVehicle> {
    return activeRapierVehicles;
}

export class RapierVehicle implements Interactable, ChunkManagedObject {
    private engine: EngineLike;
    private chassisMesh!: THREE.Object3D;
    private wheelMeshes: THREE.Mesh[];
    private vehicleController: RAPIER.DynamicRayCastVehicleController | null = null;
    private chassisBody: RAPIER.RigidBody | null = null;
    private chassisCollider: RAPIER.Collider | null = null;
    private interactableComponent: InteractableComponent | null = null;
    private navmeshObstacleProvider: ObstacleProvider | null = null;
    /** Handles of the per-wheel guard colliders (see createWheelGuards). Kept so
     *  redistributeMass() can skip them. The body total is normalised to
     *  config.mass either way, but letting the guards into the body-part pool
     *  would hand them a volume share of it — pulling mass off the real
     *  bodywork and out to the axles, against the deliberately low COM. */
    private wheelGuardHandles: Set<number> = new Set();
    /** Sensor (trigger) collider attached to chassisBody for character-impact events. */
    private impactSensorCollider: RAPIER.Collider | null = null;
    /** Cached collider handle of the impact sensor for fast filtering inside the sensor listener. */
    private impactSensorHandle: number = -1;
    /** Subscribers to character-impact events. */
    private impactListeners = new Set<(event: VehicleCharacterImpactEvent) => void>();
    /** PLAYER-group sensor standing in for the (disabled) player capsule while driving. */
    private driverPickupProbe: DriverPickupProbe | null = null;
    /** Listener handle registered with PhysicsWorld.addSensorListener (kept so dispose can remove it). */
    private sensorListener: SensorIntersectionListener | null = null;
    private config: VehicleConfig;
    private wheelConfigs: WheelConfig[];
    private renderer: VehicleRenderer;
    // --- Render interpolation state (fixed-timestep judder fix) ---
    // The chassis body only advances on whole FIXED_TIMESTEP physics substeps,
    // but the mesh (and the chase camera that follows it) reads it every render
    // frame. Reading the raw substep-quantized pose aliases into 0×/2× motion
    // bursts whenever the render clock drifts against the 60 Hz physics clock →
    // visible twitch that gets worse as the frame rate drops. We snapshot the
    // chassis pose after every substep into a prev/cur pair and render the mesh
    // interpolated between them by PhysicsWorld.getInterpolationAlpha(). Mirrors
    // the player's getRenderPosition() smoothing, which dynamic vehicles never
    // had. See captureInterpolationState() and visualUpdate().
    private prevChassisPos = new THREE.Vector3();
    private curChassisPos = new THREE.Vector3();
    private prevChassisQuat = new THREE.Quaternion();
    private curChassisQuat = new THREE.Quaternion();
    private interpInitialized = false;
    /** Squared per-substep chassis displacement above which motion is treated as a teleport, not interpolated (3 m ≈ 180 m/s). */
    private static readonly TELEPORT_JUMP_SQ = 3 * 3;
    private isPlayerDriving: boolean = false;
    private currentDriver: unknown = null;
    private isTwoWheeled: boolean = false;
    private additionalMass: number = 0;
    private controlsExtension: VehicleControlsExtension | null = null;
    // Set true once this vehicle has been permanently disabled (its physics went
    // bad, or updateVehicle threw). A disabled vehicle no-ops every per-frame
    // update and has its body removed from the world, so one broken car can never
    // cascade into a world-wide WASM panic or flood the console. See disableVehicle().
    private disabled = false;
    
    // Per-wheel terrain detection
    private wheelTerrainInfo: WheelTerrainInfo[] = [];
    private baseFrictionSlip: number[] = [];
    /** Static wheel-layout geometry for the tip-over guard (set in createVehicle). */
    private tipGeometry: TipGeometry | null = null;
    /**
     * Chassis-local AABB of every COLLISION collider on the body: the flat
     * frame slab plus every box added through addBodyPhysics(). This, not
     * `config.chassisSize`, is how tall and wide the vehicle actually is —
     * `chassisSize.height` is the 0.15 m platform slab on every asset vehicle,
     * while the real roof (added afterwards as body parts) can be 1.3 m up.
     * Seeded in createPhysicsBody(); see getFootprint().
     */
    private localBodyBounds: {
        minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
    } | null = null;
    /** One-shot log flag: warn the first time the guard clamps meaningfully. */
    private tipClampLogged = false;

    private engineForce = 0;
    private steering = 0;

    // Visual-only body lean + the clock it integrates against. Created lazily so
    // a vehicle with `bodySway: false` never allocates one.
    private bodySway: VehicleBodySway | null = null;
    private lastVisualMs: number | null = null;
    private readonly _swayQuat = new THREE.Quaternion();
    private readonly _swayForward = new THREE.Vector3();
    /** Scratch quaternion for the per-wheel steer/spin rotations in visualUpdate(). */
    private readonly _wheelQuat = new THREE.Quaternion();
    // Unit axes, shared by the body-sway and wheel-rotation maths. Never mutated.
    private readonly _axisX = new THREE.Vector3(1, 0, 0);
    private readonly _axisY = new THREE.Vector3(0, 1, 0);
    private readonly _axisZ = new THREE.Vector3(0, 0, 1);
    /** Stands the wheel cylinder (Y-axis by default) up on its axle. Constant — shared by every wheel. */
    private static readonly WHEEL_CYLINDER_ALIGN = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    private brakingForce = 0;

    /**
     * Parking brake ("handbrake"). Every vehicle spawns with it engaged, so a
     * driverless car parked on a hill stays put instead of rolling away on its
     * own. It releases automatically on the first drive input — player gas or
     * reverse, or an AI throttle — and re-engages when the driver leaves the
     * vehicle. While engaged the wheels are braked at MAX_BRAKING_FORCE and
     * sub-PARKING_BRAKE_HOLD_SPEED creep is cancelled so the body truly rests
     * (and can sleep); a real shove stays physical — the car skids on locked
     * wheels rather than standing rigid.
     */
    private parkingBrakeEngaged = true;

    private targetLeanAngle = 0;
    private currentLeanAngle = 0;

    private readonly MAX_ENGINE_FORCE: number;
    private readonly MAX_BRAKING_FORCE = 100;
    /** Below this horizontal speed (m/s) the engaged parking brake holds statically. */
    private readonly PARKING_BRAKE_HOLD_SPEED = 0.5;
    // Handling is resolved per-vehicle from optional overrides + size-scaled defaults. See engine/vehicleHandling.ts.
    private handlingOverrides: VehicleHandlingConfig = {};
    private resolvedHandling: ResolvedVehicleHandling | null = null;
    /** Lazily-cached size relative to the default car (1 = default, 0.25 = quarter-scale). */
    private cachedSizeFactor: number | null = null;
    private readonly STABILIZATION_STRENGTH = 50.0;
    private readonly MAX_LEAN_ANGLE = 0.6;
    private readonly LEAN_SPEED = 12.0;
    private readonly TURN_SPEED = 3.0;
    
    // Pluggable AI driving component
    private drivingComponent: IVehicleDrivingComponent | null = null;

    // Chunk-based hibernation
    private _isHibernating: boolean = false;
    
    // Physics hold state (managed by DynamicObjectManager when colliders aren't ready)
    private _physicsHeld: boolean = false;
    private _savedSpawnPosition: THREE.Vector3 | null = null;
    private _originalGravityScale: number = 1.0;
    /**
     * The body's gravity scale with no airborne boost applied. Captured once at
     * creation and never reassigned, unlike `_originalGravityScale` which the
     * hold/hibernate paths re-capture around their own temporary changes.
     */
    private _baseGravityScale: number = 1.0;
    /** Last gravity scale we wrote; null means "re-assert on the next frame". */
    private appliedGravityScale: number | null = null;
    // DEFAULT: always-active (engine safe default, matching NPCs/animals). Keeps
    // the vehicle simulating and its ground chunk's colliders enabled regardless
    // of camera frustum, so AI-driven vehicles (e.g. racing opponents) never
    // freeze or sink when off-screen. GAME CODE may call setAlwaysActive(false)
    // to hibernate non-critical vehicles. See docs/spawning-system.md.
    private _alwaysActive: boolean = true;

    constructor(engine: EngineLike, config: VehicleConfig) {
        activeRapierVehicles.add(this);
        this.engine = engine;
        this.config = config;
        this.handlingOverrides = config.handling ?? {};
        this.wheelMeshes = [];
        this.wheelConfigs = this.resolveWheelConfigs(config);
        this.MAX_ENGINE_FORCE = config.engineForce;

        console.log(`RapierVehicle: Engine force set to ${this.MAX_ENGINE_FORCE.toFixed(0)}N (force-to-weight: ${(config.engineForce / config.mass).toFixed(2)} N/kg)`);

        this.isTwoWheeled = this.wheelConfigs.length === 2;
        
        const drivenCount = this.wheelConfigs.filter(w => w.isDriven).length;
        const steeringCount = this.wheelConfigs.filter(w => w.isSteering).length;
        console.log(`RapierVehicle: Created ${this.wheelConfigs.length}-wheel vehicle (${drivenCount}WD, ${steeringCount} steering), stabilization: ${this.isTwoWheeled ? 'ENABLED' : 'disabled'}`);

        this.renderer = config.renderer || new PlatformVehicleRenderer();

        this.createChassis();
        this.createVehicle();
        this.createWheelGuards();
    }

    private resolveWheelConfigs(config: VehicleConfig): WheelConfig[] {
        if (config.wheels && config.wheels.length > 0) {
            console.log(`RapierVehicle: Using per-wheel configuration (${config.wheels.length} wheels)`);
            return config.wheels.map(w => ({ ...w, position: w.position.clone() }));
        }

        if (!config.wheelPositions || config.wheelPositions.length === 0) {
            throw new Error('RapierVehicle: No wheel configuration provided (need wheels[] or wheelPositions[])');
        }

        console.log(`RapierVehicle: Converting legacy global wheel settings to per-wheel config`);

        return config.wheelPositions.map((pos, i) => {
            const isFrontWheel = i < 2;
            return {
                position: pos.clone(),
                radius: config.wheelRadius ?? 0.4,
                width: config.wheelWidth ?? 0.3,
                suspensionRestLength: config.suspensionRestLength ?? 0.6,
                suspensionStiffness: config.suspensionStiffness ?? 15,
                suspensionDamping: config.suspensionDamping ?? 0.4,
                friction: config.friction ?? 100,
                isDriven: true,
                isSteering: isFrontWheel,
                torqueRatio: 1.0,
                color: config.wheelColor
            };
        });
    }

    private getChassisQuaternion(): THREE.Quaternion {
        const rot = this.chassisBody!.rotation();
        return new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    }

    private freezeVelocities(): void {
        if (!this.chassisBody) return;
        this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    private createChassis(): void {
        if (!this.engine.scene) {
            throw new Error('Engine scene is not initialized');
        }

        this.chassisMesh = this.renderer.createChassisMesh(this.config, this.config.position);

        this.chassisMesh.userData = {
            isVehicle: true,
            vehicle: this,
        };

        this.engine.scene.add(this.chassisMesh);

        this.wheelMeshes = this.renderer.createWheelMeshes(this.config, this.config.position, this.wheelConfigs);
        this.wheelMeshes.forEach(wheel => {
            // Wheels are added directly to the scene (not parented to the
            // chassis), so they need their own exclusion tag for the Gaussian
            // Splat export to hide the whole vehicle (chassis carries isVehicle).
            wheel.userData.excludeFromSplatExport = true;
            this.engine.scene!.add(wheel);
        });

        this.createPhysicsBody();

        // Keep userData.interactable around for legacy callers that walk the
        // scene graph to find interactables (none currently shipped — kept for
        // compatibility). The actual [E] Enter prompt now flows through the
        // InteractableComponent sensor created below.
        this.chassisMesh.userData.interactable = this;

        // Auto-wire the [E] Enter prompt. Earlier RapierVehicle deliberately
        // skipped creating an InteractableComponent ("Rapier sensor bodies near
        // dynamic vehicle bodies cause solver interference" — see git blame),
        // and that left every spawned vehicle silently un-enterable, forcing
        // every per-game template (VillageTractor.ts and friends) to bolt on
        // its own InteractableComponent. That workaround proved the concern
        // was overstated: attaching a sensor collider (mass 0) AS A CHILD
        // collider of the chassis dynamic body causes no measurable solver
        // disturbance. Doing it here means any RapierVehicle is enterable by
        // default — no per-spawn boilerplate.
        //
        // Sensor radius: half the chassis's longest horizontal dimension plus
        // 1 m of approach slack. Small chassis (~2 m wide) → ~2 m sensor;
        // tractor / truck (~4 m long) → ~3 m sensor. Tunable by game code by
        // calling `disposeInteractable()` and creating a custom component, but
        // the default should fit 95 % of vehicles.
        if (this.engine.physicsWorld && this.chassisBody) {
            const { width, length } = this.config.chassisSize;
            this.interactableComponent = new InteractableComponent(this.engine.physicsWorld, {
                interactable: this,
                object3D: this.chassisMesh,
                radius: Math.max(width, length) / 2 + 1.0,
                physicsBody: this.chassisBody, // sensor collider attaches as a child of the chassis body — sensor follows the vehicle for free, no per-frame sync needed
            });
        }

        // Register as a rectangular navmesh obstacle so NPCs/animals route
        // around the chassis instead of walking into it. The live getter is
        // polled each `VoxelNavMesh.tick()`; if the chassis has shifted more
        // than one cell since the last paint, the navmesh repaints itself —
        // free auto-update for moving / pushed-around vehicles.
        //
        // Shape uses the half-extents of the chassis box (width × length,
        // ignoring Y — the navmesh is 2D) and the chassis body's live yaw.
        // No agent-radius inflation here; the navmesh's `findPath` already
        // inflates obstacles by the per-agent radius at query time.
        if (this.chassisBody) {
            const { width, length } = this.config.chassisSize;
            const halfW = width / 2;
            const halfD = length / 2;
            this.navmeshObstacleProvider = registerObstacleProvider(() => {
                if (!this.chassisBody || !this.chassisBody.isValid()) return null;
                const t = this.chassisBody.translation();
                const r = this.chassisBody.rotation();
                // Extract yaw from quaternion: yaw = atan2(2(wy + xz), 1 - 2(y² + x²))
                const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
                return {
                    kind: 'box',
                    x: t.x,
                    z: t.z,
                    halfW,
                    halfD,
                    yaw,
                };
            });
        }

        // Create the character-impact sensor. Direct body collision between
        // VEHICLE ↔ ENEMY/ANIMAL is disabled at the layer level (see
        // CollisionMask.VEHICLE) — characters now pass *through* the chassis
        // physically, but this sensor fires `onCharacterImpact` events so game
        // code can choose the response (ragdoll, knockback, alert, etc.).
        //
        // The sensor is sized to match the chassis cuboid exactly and is
        // attached AS A CHILD COLLIDER of the chassis body — it follows the
        // chassis rotation/translation for free. PLAYER is included in the
        // mask so games can also react to player-on-vehicle impacts, even
        // though PLAYER ↔ VEHICLE physical collision is preserved.
        if (this.engine.physicsWorld && this.chassisBody) {
            const RAPIER_MODULE = getRapier();
            const rapierWorld = this.engine.physicsWorld.getRapierWorld();
            const { width, height, length } = this.config.chassisSize;
            const sensorDesc = RAPIER_MODULE.ColliderDesc.cuboid(width / 2, height / 2, length / 2)
                .setSensor(true)
                .setMass(0)
                .setActiveEvents(RAPIER_MODULE.ActiveEvents.COLLISION_EVENTS)
                .setActiveCollisionTypes(RAPIER_MODULE.ActiveCollisionTypes.ALL)
                .setCollisionGroups(makeCollisionGroups(
                    CollisionGroup.TRIGGER,
                    CollisionGroup.PLAYER | CollisionGroup.ENEMY | CollisionGroup.ANIMAL,
                ));
            this.impactSensorCollider = rapierWorld.createCollider(sensorDesc, this.chassisBody);
            this.impactSensorHandle = this.impactSensorCollider.handle;

            this.sensorListener = {
                onIntersectionStart: (h1, h2) => this.handleImpactSensorEvent(h1, h2),
                onIntersectionEnd: () => { /* v1 only fires on enter */ },
            };
            this.engine.physicsWorld.addSensorListener(this.sensorListener);
        }
    }

    /**
     * Sensor-event dispatcher. Called by PhysicsWorld for every sensor-start
     * intersection drained from the event queue, so the first job is to filter
     * out events that aren't ours (cheap handle compare).
     */
    private handleImpactSensorEvent(h1: number, h2: number): void {
        if (this.impactSensorHandle < 0) return;
        if (h1 !== this.impactSensorHandle && h2 !== this.impactSensorHandle) return;
        if (!this.engine.physicsWorld || !this.chassisBody) return;
        // No subscribers — skip the work (unless the trailer timeline wants the event)
        if (this.impactListeners.size === 0 && !getGameEventLog().isActive()) return;

        const otherHandle = h1 === this.impactSensorHandle ? h2 : h1;
        const rapierWorld = this.engine.physicsWorld.getRapierWorld();
        const otherCollider = rapierWorld.getCollider(otherHandle);
        if (!otherCollider) return;
        const otherBody = otherCollider.parent();
        if (!otherBody) return;

        const data = this.engine.physicsWorld.getUserData(otherBody) as { __type?: string } | null;
        const t = data?.__type;
        if (t !== 'player' && t !== 'npc' && t !== 'animal') return;

        // Skip the player's own capsule while they're driving this vehicle; NPC/animal impacts still register.
        if (t === 'player' && this.engine.getVehicleManager?.()?.isPlayerInVehicle()) return;

        const vehicleVel = this.chassisBody.linvel();
        const otherVel = otherBody.linvel();
        const relativeSpeed = Math.hypot(vehicleVel.x - otherVel.x, vehicleVel.z - otherVel.z);
        const vehicleSpeed = Math.hypot(vehicleVel.x, vehicleVel.z);
        const cp = this.chassisBody.translation();

        const event: VehicleCharacterImpactEvent = {
            vehicle: this,
            characterBody: otherBody,
            characterType: t,
            relativeSpeed,
            vehicleSpeed,
            impactPoint: new THREE.Vector3(cp.x, cp.y, cp.z),
            mass: this.config.mass,
        };

        // Trailer timeline
        getGameEventLog().logEvent({
            type: 'vehicle-hits-character',
            position: event.impactPoint,
            actor: `vehicle-hits-${t}`,
            intensity: Math.min(1, 0.4 + relativeSpeed / 15),
        });

        // Snapshot to a local list so a listener can unsubscribe itself without
        // mutating the Set during iteration.
        const listeners = Array.from(this.impactListeners);
        for (const listener of listeners) listener(event);
    }

    /**
     * Subscribe to character-impact events. Returns a teardown function that
     * removes the subscription. Multiple subscribers are supported; each fires
     * independently for every intersection-start event matching the impact
     * sensor. Game code is responsible for any vehicle/character response.
     */
    public onCharacterImpact(callback: (event: VehicleCharacterImpactEvent) => void): () => void {
        this.impactListeners.add(callback);
        return () => { this.impactListeners.delete(callback); };
    }

    /** Fraction of the vehicle mass given to the upper body (visible shell);
     *  the rest stays on the low chassis "frame" slab to keep the COM low. */
    private static readonly UPPER_BODY_MASS_FRACTION = 0.1;

    /** How far below the chassis collider's geometric center the bulk (frame)
     *  mass is placed, as a fraction of the collider half-height. 0 = center,
     *  1 = bottom face. A high value keeps the center of mass near axle level so
     *  the car resists tipping in corners. The collision SHAPE is unchanged —
     *  only the mass distribution (COM + inertia) moves down. */
    private static readonly FRAME_COM_DROP_FRACTION = 0.7;

    /**
     * Assign the configured vehicle mass to the chassis body's colliders so the
     * total always equals `config.mass`, while keeping the center of mass LOW:
     *
     *  - The BULK (90%) goes on the low chassis slab — the thin "frame" collider
     *    that sits between the wheels (at the body origin, ~axle level).
     *  - Only a SMALL share (10%) is spread across the upper-body / shell parts,
     *    proportional to volume, so they don't raise the COM and tip the car in
     *    corners. This holds regardless of how many blocks the body has.
     *
     * Mass MUST live on the colliders (not the body's "additional mass"): Rapier
     * recomputes a body's mass from its colliders every step and, in this build,
     * that recompute wipes additional mass back to 0 — a 0-mass dynamic body
     * makes the ray-cast vehicle controller divide by zero → all-NaN chassis →
     * the `unreachable` panic in world.step(). Collider mass can't be wiped.
     *
     * Re-run whenever a collision collider is added (chassis slab, each body part).
     */
    private redistributeMass(): void {
        if (!this.chassisBody || !this.chassisCollider) return;
        const targetMass = (Number.isFinite(this.config.mass) && this.config.mass > 0) ? this.config.mass : 1000;

        // Upper-body parts = non-sensor colliders other than the chassis slab.
        const bodyParts: RAPIER.Collider[] = [];
        const count = this.chassisBody.numColliders();
        for (let i = 0; i < count; i++) {
            const c = this.chassisBody.collider(i);
            if (!c || c.isSensor()) continue;
            if (c.handle === this.chassisCollider.handle) continue;
            if (this.wheelGuardHandles.has(c.handle)) continue;
            bodyParts.push(c);
        }

        // Reserve only a small share for the upper body; the frame slab carries
        // the rest so the heavy mass stays low between the wheels.
        const upperShare = bodyParts.length > 0 ? targetMass * RapierVehicle.UPPER_BODY_MASS_FRACTION : 0;
        this.applyLowCenterOfMass(this.chassisCollider, targetMass - upperShare);

        if (bodyParts.length > 0) {
            const volumeOf = (c: RAPIER.Collider): number => {
                const he = c.halfExtents(); // cuboid half-extents; null for non-cuboid shapes
                if (!he) return 1e-4;
                return Math.max(1e-6, 8 * he.x * he.y * he.z);
            };
            const totalVolume = bodyParts.reduce((sum, c) => sum + volumeOf(c), 0);
            for (const c of bodyParts) {
                const share = totalVolume > 0 ? volumeOf(c) / totalVolume : 1 / bodyParts.length;
                c.setMass(upperShare * share);
            }
        }

        // Changing a collider's mass does NOT immediately update the parent
        // body — Rapier defers that to the next world.step() (see RigidBody
        // docs). But the ray-cast vehicle controller's updateVehicle() runs as a
        // PRE-step callback, i.e. BEFORE that step, so it would otherwise read a
        // stale invMass=0 (every collider was created with setMass(0)), divide
        // by zero, and feed NaN into world.step() → `unreachable` panic. Force
        // the body to pick up the new collider masses NOW so the controller sees
        // the real, finite mass on its very first update.
        this.chassisBody.recomputeMassPropertiesFromColliders();
    }

    /**
     * Put `mass` on the chassis frame collider with its center of mass pushed
     * LOW (toward the underbody) so the heavy frame sits near axle level and the
     * car resists tipping in corners. Only the mass distribution (COM + inertia)
     * is altered — the collision SHAPE is untouched.
     *
     * `setMass()` alone centers the mass at the collider's geometric center,
     * which for a full-height chassis cuboid puts 90% of the vehicle weight at
     * the vertical MIDDLE of the body — a high COM that flips the car. Here we
     * use `setMassProperties` to drop the COM and supply a matching solid-box
     * inertia.
     *
     * If the Rapier build rejects `setMassProperties`, we fall back to a plain
     * `setMass` (the previous, working behavior) so vehicle creation never
     * fails — worst case is simply a higher COM, not a crash.
     */
    private applyLowCenterOfMass(collider: RAPIER.Collider, mass: number): void {
        const he = collider.halfExtents();
        if (!he || !(mass > 0)) {
            collider.setMass(Math.max(0, mass));
            return;
        }
        const fullW = 2 * he.x, fullH = 2 * he.y, fullL = 2 * he.z;
        // Solid-box principal inertia about the center of mass (kg·m²).
        const ix = (mass / 12) * (fullH * fullH + fullL * fullL);
        const iy = (mass / 12) * (fullW * fullW + fullL * fullL);
        const iz = (mass / 12) * (fullW * fullW + fullH * fullH);
        // Drop the COM toward the underbody (negative Y, chassis-local).
        const comY = -he.y * RapierVehicle.FRAME_COM_DROP_FRACTION;
        try {
            collider.setMassProperties(
                mass,
                { x: 0, y: comY, z: 0 },
                { x: ix, y: iy, z: iz },
                { x: 0, y: 0, z: 0, w: 1 }
            );
        } catch (e) {
            console.warn('RapierVehicle: setMassProperties unavailable, falling back to setMass', e);
            collider.setMass(mass);
        }
    }

    /**
     * Apply the shared surface + collision-layer setup to a chassis-side collision
     * collider (the frame slab and every body part alike — they all rub against
     * walls, props and other cars, so they must slide identically).
     *
     * Mass is 0 here; the real mass is assigned by redistributeMass(), which
     * spreads config.mass across ALL non-sensor colliders proportional to volume.
     * Mass MUST live on the colliders, not on the body's "additional mass": Rapier
     * recomputes a body's mass from its colliders every step and (in this build)
     * that recompute wipes any additional mass back to 0, leaving a 0-mass dynamic
     * body — which makes the ray-cast vehicle controller divide by zero → all-NaN
     * chassis → a hard `unreachable` panic in world.step(). Collider mass can't be
     * wiped.
     *
     * Friction is deliberately slippery (see DEFAULT_CHASSIS_FRICTION — grip is a
     * wheel property; a grippy chassis only welds cars to each other) and
     * restitution deliberately non-zero: at the old 0.1 the chassis dead-stopped on
     * contact and readily wedged against props (nose pinned, wheels off the ground,
     * throttle doing nothing); rebounding a little lets most contacts resolve
     * themselves before VehicleStuckSystem has to step in.
     *
     * The combine rules are what make both of those stick. Rapier's default rule
     * AVERAGES the two colliders' values, which silently defeats them: against a
     * tree/prop (friction 0.5–0.8, restitution 0) the contact came out at ~0.33–0.48
     * friction and ~0.18 restitution — grippy enough to ratchet the nose up an
     * obstacle and hold it there by friction alone, with half the designed pop-out.
     * Min/Max have higher precedence than the other collider's default Average, so
     * the chassis's slipperiness and bounce apply to EVERY contact regardless of
     * what it hit.
     */
    private applyChassisSurface(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
        const RAPIER_MODULE = getRapier();
        return desc
            .setMass(0) // real mass assigned in redistributeMass()
            .setFriction(this.config.chassisFriction ?? DEFAULT_CHASSIS_FRICTION)
            .setRestitution(this.config.chassisRestitution ?? DEFAULT_CHASSIS_RESTITUTION)
            .setFrictionCombineRule(RAPIER_MODULE.CoefficientCombineRule.Min)
            .setRestitutionCombineRule(RAPIER_MODULE.CoefficientCombineRule.Max)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.VEHICLE, CollisionMask.VEHICLE));
    }

    private createPhysicsBody(): void {
        if (!this.engine.physicsWorld) {
            throw new Error('Physics world is not initialized');
        }

        const RAPIER_MODULE = getRapier();
        const rapierWorld = this.engine.physicsWorld.getRapierWorld();

        const { width, height, length } = this.config.chassisSize;

        const bodyDesc = RAPIER_MODULE.RigidBodyDesc.dynamic()
            .setTranslation(this.config.position.x, this.config.position.y, this.config.position.z)
            .setCanSleep(false)
            .setLinearDamping(0.1)
            .setAngularDamping(0.5);

        const yawRotation = this.config.spawnRotation ?? Math.PI;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRotation);
        bodyDesc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });

        this.chassisBody = rapierWorld.createRigidBody(bodyDesc);

        // The "frame" slab: the low collider that carries the bulk of the mass.
        // Surface, combine rules and collision layers are shared with the body
        // parts — see applyChassisSurface().
        const colliderDesc = this.applyChassisSurface(
            RAPIER_MODULE.ColliderDesc.cuboid(width / 2, height / 2, length / 2),
        );

        this.chassisCollider = rapierWorld.createCollider(colliderDesc, this.chassisBody);
        // The slab is centred on the body origin, so it seeds the local bounds
        // symmetrically. Body parts grow them from here.
        this.growLocalBodyBounds({ x: 0, y: 0, z: 0 }, { width, height, length });

        // Assign mass now (chassis-only vehicles get the full mass on the slab;
        // re-run after body parts are added so they take their share).
        this.redistributeMass();

        this.engine.physicsWorld.setUserData(this.chassisBody, {
            isVehicle: true,
            vehicle: this,
            __type: 'vehicle'
        });

        // Store spawn position and gravity scale for potential physics hold
        // (DynamicObjectManager will call holdPhysicsUntilReady() if colliders aren't ready)
        this._savedSpawnPosition = this.config.position.clone();
        this._originalGravityScale = this.chassisBody.gravityScale();
        this._baseGravityScale = this._originalGravityScale;

        console.log(`✅ RapierVehicle: Physics body created at (${this.config.position.x.toFixed(2)}, ${this.config.position.y.toFixed(2)}, ${this.config.position.z.toFixed(2)})`);
    }

    private createVehicle(): void {
        if (!this.engine.physicsWorld || !this.chassisBody) {
            throw new Error('Physics world or chassis body is not initialized');
        }

        console.log(`RapierVehicle: Creating DynamicRayCastVehicleController with ${this.wheelConfigs.length} wheels`);

        const rapierWorld = this.engine.physicsWorld.getRapierWorld();

        // Held in a local as well as the field so the per-wheel setup below needs
        // no non-null assertions inside its callback.
        const controller = rapierWorld.createVehicleController(this.chassisBody);
        this.vehicleController = controller;

        // Set axes: Y is up (1), Z is forward (2)
        // Rapier types have an asymmetric API: getter is `indexForwardAxis`, setter is `setIndexForwardAxis`
        controller.indexUpAxis = 1;
        controller.setIndexForwardAxis = 2;
        console.log(`RapierVehicle: Axes configured - up=${controller.indexUpAxis}, forward=${controller.indexForwardAxis}`);

        const down = { x: 0, y: -1, z: 0 };
        const axle = { x: -1, y: 0, z: 0 };

        this.wheelConfigs.forEach((wheelConfig, i) => {
            const pos = wheelConfig.position;
            console.log(`  Wheel ${i}: pos=(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}), r=${wheelConfig.radius.toFixed(2)}, steering=${wheelConfig.isSteering}, driven=${wheelConfig.isDriven}`);

            controller.addWheel(
                { x: pos.x, y: pos.y, z: pos.z },
                down,
                axle,
                wheelConfig.suspensionRestLength,
                wheelConfig.radius
            );

            // Tune suspension for realistic behavior
            // Stiffness: how hard the spring pushes (higher = stiffer, less compression)
            controller.setWheelSuspensionStiffness(i, wheelConfig.suspensionStiffness * 3);
            // Compression damping - resistance when compressing (hitting bumps)
            controller.setWheelSuspensionCompression(i, wheelConfig.suspensionDamping * 8);
            // Relaxation damping - resistance when extending (after bumps)
            controller.setWheelSuspensionRelaxation(i, wheelConfig.suspensionDamping * 10);
            // Max suspension travel (how far it can compress/extend from rest).
            // The wheel guards derive their ground clearance from this same
            // fraction — change it there, not here.
            controller.setWheelMaxSuspensionTravel(i, wheelConfig.suspensionRestLength * SUSPENSION_MAX_TRAVEL_FRACTION);
            // Max force - should support vehicle weight per wheel plus margin
            controller.setWheelMaxSuspensionForce(i, (this.config.mass * 10) / this.wheelConfigs.length * 2);
            // Friction slip - traction control (higher = more grip, risk of flip).
            // NOTE this bounds the tyre's COMBINED (forward + sideways) impulse.
            const frictionSlip = wheelConfig.friction / 25;
            controller.setWheelFrictionSlip(i, frictionSlip);
            this.baseFrictionSlip.push(frictionSlip);
            // Lateral grip, scaling the SIDE impulse only — the knob for drift
            // and donuts. See WheelConfig.sideFrictionStiffness.
            controller.setWheelSideFrictionStiffness(
                i, wheelConfig.sideFrictionStiffness ?? DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS,
            );

            // Initialize wheel terrain info
            this.wheelTerrainInfo.push({
                inContact: false,
                contactPosition: new THREE.Vector3(),
                blockType: 0,
                terrainTypeId: -1,
                groundType: 0,
                grip: 1.0,
                slip: 0,
                isDriven: wheelConfig.isDriven,
                isSteering: wheelConfig.isSteering
            });
        });

        // Tip-over guard geometry: axle extremes + the lowest possible contact
        // (suspension fully extended) as the no-contact fallback. COM is read
        // live each frame — it shifts when body parts are added.
        this.tipGeometry = {
            minWheelZ: Math.min(...this.wheelConfigs.map((w) => w.position.z)),
            maxWheelZ: Math.max(...this.wheelConfigs.map((w) => w.position.z)),
            staticContactY: Math.min(...this.wheelConfigs.map(
                (w) => w.position.y - w.suspensionRestLength - w.radius,
            )),
        };

        console.log(`✅ RapierVehicle: DynamicRayCastVehicleController created with ${this.wheelConfigs.length} wheels`);
    }

    /**
     * Give the ray-cast wheels a sideways collision shape.
     *
     * A wheel here is one downward ray — it finds the ground and carries the
     * suspension, but it is not a collider, so nothing stops a tyre passing
     * through a wall or through another car's tyre. The chassis slab and the
     * body boxes are both cut from the WHEEL-EXCLUDED body bounds (and shrunk
     * to 92–96 % of them), so every tyre stands proud of the collision set —
     * completely so on an `exposed` axle, where the fitment puts the whole
     * wheel outboard of the body. One massless box per wheel, parked inside the
     * tyre's own volume, closes that gap.
     *
     * The boxes are children of the chassis body, so they cost no extra body,
     * need no per-frame sync, and never collide with their own siblings. They
     * can't disturb the suspension either: the wheel rays exclude the chassis
     * body outright, and their filter only accepts TERRAIN / ENVIRONMENT /
     * DYNAMIC_PROP, which a VEHICLE-group guard is not. Geometry (and why it
     * can never touch the ground) is in engine/vehicle/WheelGuards.ts.
     */
    private createWheelGuards(): void {
        if (this.config.disableWheelGuards) return;
        if (!this.engine.physicsWorld || !this.chassisBody) return;

        const RAPIER_MODULE = getRapier();
        const rapierWorld = this.engine.physicsWorld.getRapierWorld();

        for (const wheel of this.wheelConfigs) {
            const guard = wheelGuardBox(wheel);
            if (!guard) {
                console.warn(`RapierVehicle: wheel at z=${wheel.position.z.toFixed(2)} has no usable radius/width — no wheel guard, its tyre will clip through walls`);
                continue;
            }
            // Same surface as the chassis: a guard is the tyre's outermost
            // shape, so it must slide off walls and other cars exactly like the
            // bodywork does rather than catching on them (see applyChassisSurface).
            const desc = this.applyChassisSurface(
                RAPIER_MODULE.ColliderDesc
                    .cuboid(guard.size.width / 2, guard.size.height / 2, guard.size.length / 2)
                    .setTranslation(guard.position.x, guard.position.y, guard.position.z),
            );
            this.wheelGuardHandles.add(rapierWorld.createCollider(desc, this.chassisBody).handle);
        }

        console.log(`RapierVehicle: ${this.wheelGuardHandles.size} wheel guard collider(s) created`);
    }

    public addBodyVisual(object: THREE.Object3D): void {
        if (this.chassisMesh) {
            this.chassisMesh.add(object);
        }
    }

    public addBodyPhysics(bodyPart: VehicleBodyPart): void {
        if (!this.engine.physicsWorld || !this.chassisBody) {
            console.error('RapierVehicle: Cannot add body physics - not initialized');
            return;
        }

        const { position, size, mass = 0 } = bodyPart;

        const RAPIER_MODULE = getRapier();
        const rapierWorld = this.engine.physicsWorld.getRapierWorld();

        // Same surface as the chassis slab: these upper-body boxes are what
        // actually touches another car's flank, so they must slide the same way
        // (Rapier's 0.5 default would re-introduce the car-to-car interlock the
        // slab avoids). See applyChassisSurface().
        const colliderDesc = this.applyChassisSurface(
            RAPIER_MODULE.ColliderDesc.cuboid(size.width / 2, size.height / 2, size.length / 2)
                .setTranslation(position.x, position.y, position.z),
        );

        rapierWorld.createCollider(colliderDesc, this.chassisBody);
        this.growLocalBodyBounds(position, size);

        this.additionalMass += mass;

        // Re-spread config.mass across all collision colliders (this new part now
        // takes its volume-proportional share), so the body total stays config.mass.
        this.redistributeMass();

        console.log(`RapierVehicle: Added body part at (${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}) size (${size.width.toFixed(2)}, ${size.height.toFixed(2)}, ${size.length.toFixed(2)})`);
    }

    public addBodyPhysicsBatch(bodyParts: VehicleBodyPart[]): void {
        for (const part of bodyParts) {
            this.addBodyPhysics(part);
        }
    }

    /**
     * Union one collision box into the chassis-local AABB behind getFootprint().
     * Every box on the body (slab and parts alike) is an axis-aligned cuboid in
     * the chassis frame — none is rotated — so a plain min/max union is exact,
     * not an approximation.
     */
    private growLocalBodyBounds(
        position: { x: number; y: number; z: number },
        size: { width: number; height: number; length: number },
    ): void {
        const hx = size.width / 2;
        const hy = size.height / 2;
        const hz = size.length / 2;
        const current = this.localBodyBounds;
        if (!current) {
            this.localBodyBounds = {
                minX: position.x - hx, maxX: position.x + hx,
                minY: position.y - hy, maxY: position.y + hy,
                minZ: position.z - hz, maxZ: position.z + hz,
            };
            return;
        }
        current.minX = Math.min(current.minX, position.x - hx);
        current.maxX = Math.max(current.maxX, position.x + hx);
        current.minY = Math.min(current.minY, position.y - hy);
        current.maxY = Math.max(current.maxY, position.y + hy);
        current.minZ = Math.min(current.minZ, position.z - hz);
        current.maxZ = Math.max(current.maxZ, position.z + hz);
    }

    public rebuildPhysicsMass(): void {
        console.log(`RapierVehicle: Mass is handled per-collider in Rapier - total mass: ${(this.config.mass + this.additionalMass).toFixed(0)}kg`);
    }

    public getChassisGroup(): THREE.Object3D {
        return this.chassisMesh;
    }

    public getPlatformConfig(): VehicleConfig {
        return this.config;
    }

    public getWheelConfigs(): WheelConfig[] {
        return this.wheelConfigs;
    }

    /**
     * Set engineForce/brakingForce from forward/backward/brake booleans using the
     * four-wheel throttle model (forward drives, backward reverses, brake wins over
     * throttle, releasing everything coasts). Shared by the player and AI control
     * paths; the two-wheel model (no reverse, backward brakes) is handled inline.
     */
    private applyThrottleAndBrake(controls: VehicleControls): void {
        const throttle = resolveThrottle(controls.throttle, controls.forward, controls.backward);
        const braking = resolveBraking(controls.brakeAmount, controls.brake);

        // First gas/reverse input releases the parking brake (player and AI
        // share this path). Steering or the brake alone never release it, and
        // neither does a speed controller sitting at zero throttle.
        if (Math.abs(throttle) > THROTTLE_PARKING_BRAKE_EPSILON) {
            this.parkingBrakeEngaged = false;
        }

        // Brake wins over throttle — unchanged from the boolean model.
        this.brakingForce = this.MAX_BRAKING_FORCE * braking;
        this.engineForce = braking > 0 ? 0 : this.MAX_ENGINE_FORCE * throttle;
    }

    public updateControls(controls: VehicleControls, deltaTime: number = 0.016): void {
        if (!this.isPlayerDriving) return;

        if (this.isTwoWheeled) {
            if (controls.forward) {
                // Two-wheel model has no reverse (backward brakes), so only
                // gas releases the parking brake here.
                this.parkingBrakeEngaged = false;
                this.engineForce = this.MAX_ENGINE_FORCE;
                this.brakingForce = 0;
            } else {
                this.engineForce = 0;
            }

            if (controls.brake || controls.backward) {
                this.brakingForce = this.MAX_BRAKING_FORCE;
                this.engineForce = 0;
            } else if (!controls.forward) {
                this.brakingForce = 0;
            }
        } else {
            this.applyThrottleAndBrake(controls);
        }

        // Steering softens with size-normalized speed (see engine/vehicleHandling.ts).
        // The ramp/return RATES use the raw softening; the reachable ANGLE uses the
        // floored factor, so a fast car keeps enough lock to corner.
        const speed = this.getSpeed();
        const sizeFactor = this.getSizeFactor();
        const h = this.getResolvedHandling();
        const softening = steeringSoftening(speed, sizeFactor, h.steerSpeedFalloff);
        const effectiveMaxSteering = h.maxSteerAngleRad * steeringSpeedFactor(speed, sizeFactor, h);

        const steeringDelta = h.steerSpeedRad * softening * deltaTime;
        const returnDelta = h.steerReturnSpeedRad * softening * deltaTime;

        // Analog inputs position the wheel, keys ramp it — see resolveSteering().
        this.steering = resolveSteering(
            controls.steer,
            controls.left,
            controls.right,
            this.steering,
            effectiveMaxSteering,
            steeringDelta,
            returnDelta,
        );

        // Re-clamp: effectiveMaxSteering shrinks as the car speeds up, so a lock
        // held from a slower moment has to be wound back in.
        this.steering = THREE.MathUtils.clamp(this.steering, -effectiveMaxSteering, effectiveMaxSteering);
    }

    /**
     * Inspect the chassis body for NaN/Infinity in any quantity that world.step()
     * integrates. Returns a list of "field=value" strings for every non-finite
     * quantity (empty when healthy). A single non-finite component makes Rapier
     * abort with `unreachable`, so we catch it pre-step and disable the vehicle.
     * A static body legitimately has mass 0 — that is finite — so no false positives.
     */
    private chassisNonFiniteFields(): string[] {
        const body = this.chassisBody;
        if (!body) return [];
        const t = body.translation();
        const r = body.rotation();
        const lv = body.linvel();
        const av = body.angvel();
        const mass = body.mass();

        const bad: string[] = [];
        const checkVec = (name: string, v: { x: number; y: number; z: number }): void => {
            if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
                bad.push(`${name}=(${v.x}, ${v.y}, ${v.z})`);
            }
        };
        checkVec('translation', t);
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z) || !Number.isFinite(r.w)) {
            bad.push(`rotation=(${r.x}, ${r.y}, ${r.z}, ${r.w})`);
        }
        checkVec('linvel', lv);
        checkVec('angvel', av);
        if (!Number.isFinite(mass)) bad.push(`mass=${mass}`);

        return bad;
    }

    /**
     * Permanently disable this vehicle: stop all per-frame updates and remove its
     * body from the physics world (deferred, so it's flushed safely before the
     * next step). This is the single internal safeguard — whether the cause is a
     * non-finite chassis or a thrown updateVehicle, one broken car is contained
     * here rather than cascading into a world-wide WASM panic or a console flood.
     * Logs exactly once. The vehicle's mesh is left in place, frozen at its last
     * pose. Idempotent.
     */
    private disableVehicle(reason: string, error?: unknown): void {
        if (this.disabled) return;
        this.disabled = true;

        // Warn (not error) so a single contained vehicle failure never auto-opens
        // the on-screen console panel. The vehicle is gone from physics either way.
        console.warn(`Vehicle disabled — ${reason}`, error ?? '');

        // Dispose of the body so world.step() never integrates a bad chassis. Use
        // quarantineBody (NOT removeRigidBody): if the chassis position went NaN,
        // a direct removal would traverse the broad phase with a NaN AABB and
        // corrupt it. quarantineBody sanitizes the chassis to finite first and
        // removes it one clean step later. Wrapped because the WASM calls inside
        // throw if the borrow is already poisoned — we must not add to the flood.
        try {
            if (this.vehicleController && this.engine.physicsWorld) {
                this.engine.physicsWorld.getRapierWorld().removeVehicleController(this.vehicleController);
            }
        } catch { /* borrow poisoned; PhysicsWorld will halt the step */ }
        this.vehicleController = null;

        try {
            if (this.chassisBody && this.engine.physicsWorld) {
                this.engine.physicsWorld.quarantineBody(this.chassisBody);
            }
        } catch { /* borrow poisoned; PhysicsWorld will halt the step */ }
        this.chassisBody = null;
        this.chassisCollider = null;
        // Guards went with the body; drop the handles so a recycled handle
        // can't later be mistaken for one of ours in redistributeMass().
        this.wheelGuardHandles.clear();
    }

    /**
     * Physics update - called during each physics substep (fixed timestep)
     * Handles vehicle controller update, forces, and stabilization
     */
    public physicsUpdate(dt: number): void {
        if (this.disabled) return;
        if (!this.vehicleController || !this.chassisBody || !this.engine.physicsWorld) return;

        // The PhysicsWorld safety net (quarantineNonFiniteBodies) may have removed
        // our chassis out from under us if it went non-finite while we weren't the
        // one driving the per-step check (e.g. while hibernating). Calling methods
        // on a removed body is undefined behaviour in rapier-compat — disable
        // cleanly. isValid() is safe to call on a removed body (returns false).
        if (!this.chassisBody.isValid()) {
            this.disableVehicle('chassis body removed (quarantined by PhysicsWorld safety net)');
            return;
        }

        // SAFEGUARD: bail out BEFORE touching rapier if the chassis went non-finite
        // last step. Stepping a NaN/Inf body makes world.step() abort with
        // `unreachable`, which poisons the WASM borrow world-wide. Disabling +
        // removing this one body now (a deferred removal, flushed before the next
        // step) keeps the rest of the simulation alive. See disableVehicle().
        const badFields = this.chassisNonFiniteFields();
        if (badFields.length > 0) {
            this.disableVehicle(`non-finite chassis pre-step: ${badFields.join('; ')}`);
            return;
        }

        if (this.isTwoWheeled && this.isPlayerDriving) {
            if (Math.random() < 0.005) {
                console.log('🏍️ 2-wheel stabilization ACTIVE');
            }
            this.updateMotorcyclePhysics(dt);
        }

        // accelerationScale tapers drive force; the speed caps cut drive in whichever
        // direction is already at its limit — see gateDriveForce for why this is the
        // SIGNED forward speed and not the velocity magnitude.
        const h = this.getResolvedHandling();
        const accelFactor = h.accelerationScale;
        const driveForce = gateDriveForce(this.engineForce, this.getForwardSpeed(), h);

        // TIP-OVER GUARD: wheel drive force acts at the ground contacts, BELOW
        // the center of mass, so the requested total is a pitch moment — a
        // light chassis with a strong engine wheelies straight over on W (and
        // endos on S) no matter what a game author picked. Clamp the TOTAL
        // applied drive force to a safe fraction of the static tip threshold
        // so every mass/engineForce combination stays drivable out of the box.
        // COM→contact height is measured live while grounded (suspension
        // state included); the fully-extended static estimate is the airborne
        // fallback. See physics/vehicleStability.ts for the model + margin.
        let driveScale = 1;
        if (driveForce !== 0 && this.tipGeometry && !this.config.disableTipOverGuard) {
            let requestedTotal = 0;
            for (let i = 0; i < this.wheelConfigs.length; i++) {
                const wc = this.wheelConfigs[i];
                if (!wc?.isDriven) continue;
                requestedTotal += Math.abs(driveForce) * (wc.torqueRatio ?? 1.0)
                    * (this.wheelTerrainInfo[i]?.grip ?? 1.0) * accelFactor;
            }
            if (requestedTotal > 0) {
                // Live COM→contact height: groundContactYLocal() is the ground
                // plane in the chassis frame, so COM minus it is the lever arm.
                const localCom = this.chassisBody.localCom();
                const comHeight = localCom.y - this.groundContactYLocal();
                const gravityY = Math.abs(this.engine.physicsWorld.getRapierWorld().gravity.y || -9.81);
                const maxTotal = maxTipSafeDriveForce(
                    this.config.mass, gravityY, comHeight, localCom.z, this.tipGeometry, driveForce > 0,
                );
                if (requestedTotal > maxTotal) {
                    driveScale = maxTotal / requestedTotal;
                    if (!this.tipClampLogged && driveScale < 0.7) {
                        this.tipClampLogged = true;
                        console.log(
                            `RapierVehicle: tip-over guard active — requested drive ${requestedTotal.toFixed(0)}N exceeds the `
                            + `stable limit ${maxTotal.toFixed(0)}N for this ${this.config.mass}kg chassis; force clamped. `
                            + `Lower engineForce/accelerationScale or raise mass to stay under the limit.`,
                        );
                    }
                }
            }
        }

        // Parking brake static hold: locked wheels stop a rolling car, but on a
        // slope the solver still lets a braked car creep downhill a few cm/s.
        // Cancel that creep (horizontal only — the car may still be settling
        // onto its suspension) without waking the body, so it reaches true rest
        // and Rapier can put it to sleep. Anything above the threshold is a
        // real shove — another car ramming the parked one — and stays fully
        // physical: the car skids on locked wheels instead of standing rigid.
        if (this.parkingBrakeEngaged) {
            const v = this.chassisBody.linvel();
            const horizontalSpeed = Math.hypot(v.x, v.z);
            if (horizontalSpeed > 1e-4 && horizontalSpeed < this.PARKING_BRAKE_HOLD_SPEED) {
                this.chassisBody.setLinvel({ x: 0, y: Math.min(0, v.y), z: 0 }, false);
                const av = this.chassisBody.angvel();
                if (Math.hypot(av.x, av.y, av.z) < this.PARKING_BRAKE_HOLD_SPEED) {
                    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, false);
                }
            }
        }

        // Brake demand is the same for every wheel: an engaged parking brake
        // floors it at MAX_BRAKING_FORCE, otherwise the driver's input is used.
        const appliedBrake = this.parkingBrakeEngaged
            ? Math.max(this.brakingForce, this.MAX_BRAKING_FORCE)
            : this.brakingForce;

        for (let i = 0; i < this.wheelConfigs.length; i++) {
            const wheelConfig = this.wheelConfigs[i];
            if (!wheelConfig) continue;

            // Use terrain grip from previous frame to scale forces.
            // Low grip = wheels spin, less effective traction and braking.
            const wheelGrip = this.wheelTerrainInfo[i]?.grip ?? 1.0;

            this.vehicleController.setWheelBrake(i, appliedBrake * wheelGrip);

            if (wheelConfig.isDriven) {
                const torqueRatio = wheelConfig.torqueRatio ?? 1.0;
                // Scale engine force by grip - on slippery surfaces, wheels can't
                // transfer as much force to the ground
                this.vehicleController.setWheelEngineForce(i, driveForce * torqueRatio * wheelGrip * accelFactor * driveScale);
            } else {
                this.vehicleController.setWheelEngineForce(i, 0);
            }

            if (!this.isTwoWheeled && wheelConfig.isSteering) {
                this.vehicleController.setWheelSteering(i, this.steering);
            } else {
                this.vehicleController.setWheelSteering(i, 0);
            }
        }

        // Wheel suspension raycasts must ONLY hit static-ground surfaces. If the
        // filter lets a wheel ray land on a character capsule (ENEMY / ANIMAL /
        // PLAYER), Rapier's vehicle controller treats that hit as ground and
        // loads the suspension spring at that point — a passing villager
        // becomes a launch pad and the chassis spins into the air. (This bug
        // was hidden as long as ENEMY/ANIMAL still collided with VEHICLE
        // directly — the solver shoved characters out of the ray cone before
        // the suspension could load up. After decoupling those layers it
        // surfaces immediately on every contact.)
        //
        // Encoding: lower 16 = query MEMBERSHIP, upper 16 = query FILTER. The
        // membership has to be VEHICLE so TERRAIN/ENVIRONMENT/DYNAMIC_PROP
        // colliders (whose own filter masks include the VEHICLE bit) accept
        // the hit. The previous code spread `noVehicleMask` over both halves,
        // which "worked" only because the filter half happened to include
        // every relevant group.
        const wheelRayHits = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP;
        const wheelRayGroups = makeCollisionGroups(CollisionGroup.VEHICLE, wheelRayHits);

        try {
            this.vehicleController.updateVehicle(dt, undefined, wheelRayGroups);
        } catch (e) {
            // updateVehicle throwing "recursive use" means an EARLIER hard panic
            // (panic=abort) already stuck a WASM borrow. Do NOT recreate the
            // controller — that touches the same poisoned phase and spreads the
            // stuck borrow world-wide. Disable this vehicle (a symptom, not the cause).
            this.disableVehicle('updateVehicle threw (WASM borrow already poisoned by an earlier panic)', e);
            return;
        }
        
        // Update per-wheel terrain info and adjust friction based on terrain grip
        this.updateWheelTerrainInfo();

        // Needs the contact flags updateWheelTerrainInfo() just refreshed.
        this.updateDownforce();
    }

    /**
     * Press the car into the road with aerodynamic load (see VehicleDownforce for
     * why a raycast vehicle has none of its own, and why the load is applied as a
     * gravity scale). Runs after the wheel contact flags are refreshed, so
     * "airborne" means what the suspension rays saw this very step.
     */
    private updateDownforce(): void {
        if (!this.chassisBody) return;

        // The hold and hibernate paths own gravityScale while they are active
        // (they park it at 0 and restore it themselves) — never fight them, and
        // re-assert our own value on the frame the vehicle comes back.
        if (this._physicsHeld || this._isHibernating) {
            this.appliedGravityScale = null;
            return;
        }

        const grounded = this.wheelTerrainInfo.some(info => info.inContact);

        // Horizontal speed only — a wing works on the air flowing past it, so a
        // car dropping down a cliff must not generate load from the fall itself.
        const v = this.chassisBody.linvel();
        const airspeed = Math.hypot(v.x, v.z);

        const scale = this._baseGravityScale
            * downforceGravityScale(airspeed, this.getResolvedHandling().downforceG, grounded);
        if (this.appliedGravityScale === null || Math.abs(scale - this.appliedGravityScale) > 1e-4) {
            this.appliedGravityScale = scale;
            this.chassisBody.setGravityScale(scale, true);
        }
    }

    /**
     * Update per-wheel terrain info by checking what block type is under each wheel.
     * Automatically adjusts wheel friction based on terrain grip.
     */
    private updateWheelTerrainInfo(): void {
        if (!this.vehicleController || !this.chassisBody) return;
        
        // Get voxel world for block lookups and the global texture atlas for friction/terrain type
        const genreModule = (this.engine as unknown as { genreModule?: GenreModuleLike }).genreModule;
        const worldGenerator = genreModule?.worldGenerator ?? genreModule?.getWorldGenerator?.();
        const voxelWorld = worldGenerator?.getVoxelTerrainSystem?.()?.getVoxelWorld?.();
        const textureAtlas = getVoxelTextureAtlas();
        // Baked (.vwld) levels have no VoxelWorld to sample blocks from — their surface
        // material lives in the level's ground mask instead. Without this the whole
        // grip path was skipped on a forged level and every wheel kept its 1.0 default,
        // so sand, grass and asphalt all drove identically.
        const vxlSceneTerrain = voxelWorld ? null : worldGenerator?.getVxlSceneTerrain?.();
        
        const cp = this.chassisBody.translation();
        const chassisOrigin = new THREE.Vector3(cp.x, cp.y, cp.z);
        const chassisQuat = this.getChassisQuaternion();

        for (let i = 0; i < this.wheelConfigs.length; i++) {
            const wheelConfig = this.wheelConfigs[i];
            const info = this.wheelTerrainInfo[i];
            if (!wheelConfig || !info) continue;
            
            const inContact = this.vehicleController.wheelIsInContact(i);
            info.inContact = inContact;
            
            if (!inContact) {
                info.blockType = 0;
                info.terrainTypeId = -1;
                info.grip = 1.0;
                continue;
            }
            
            // Wheel contact point, chassis-local then transformed to world space.
            // Written straight into `info.contactPosition` — that IS the output.
            const connectionPoint = this.vehicleController.wheelChassisConnectionPointCs(i);
            const suspensionLength = this.vehicleController.wheelSuspensionLength(i) ?? wheelConfig.suspensionRestLength;

            const contact = info.contactPosition
                .set(
                    connectionPoint?.x ?? wheelConfig.position.x,
                    (connectionPoint?.y ?? wheelConfig.position.y) - suspensionLength - wheelConfig.radius,
                    connectionPoint?.z ?? wheelConfig.position.z,
                )
                .applyQuaternion(chassisQuat)
                .add(chassisOrigin);

            // Look up block type at contact point.
            // Scan downward from the wheel to find the first solid voxel,
            // because the wheel sits on the smooth surface which may be above the voxel center.
            if (voxelWorld) {
                const voxelSize = voxelWorld.getVoxelSize?.() ?? 1.0;
                let blockId = 0;
                for (let dy = 0; dy <= 3; dy++) {
                    blockId = voxelWorld.getBlock(contact.x, contact.y - dy * voxelSize, contact.z);
                    if (blockId !== 0) break;
                }
                info.blockType = blockId;
                
                info.groundType = GROUND_TYPE.none;   // ground mask is a baked-level concept
                if (blockId !== 0) {
                    // getBlockTerrainType returns the terrain type ID
                    const terrainTypeId = textureAtlas.getBlockTerrainType(blockId);
                    info.terrainTypeId = terrainTypeId ?? -1;
                    info.grip = textureAtlas.getBlockGrip(blockId);
                } else {
                    info.terrainTypeId = -1;
                    info.grip = 1.0;
                }
            } else if (vxlSceneTerrain) {
                // Baked level: the ground mask carries one surface type per 0.5 m
                // column. `groundGrip` returns 1.0 for an untyped cell, so a level
                // baked without ground types drives exactly as it always has.
                const groundType = vxlSceneTerrain.getGroundTypeAt(contact.x, contact.y, contact.z);
                info.blockType = 0;
                info.terrainTypeId = -1;   // voxel TerrainTypes id — a baked level has none
                info.groundType = groundType;
                info.grip = groundGrip(groundType);
            }

            // Auto-adjust wheel friction based on terrain grip. grip is a
            // multiplier: 1.0 = full traction (default), 0.0 = ice — so terrain
            // without explicit grip data leaves the base friction untouched.
            const baseSlip = this.baseFrictionSlip[i] ?? 4.0;
            this.vehicleController.setWheelFrictionSlip(i, baseSlip * info.grip);
            
            // Calculate wheel slip (0 = perfect traction, 1 = full spin/skid).
            // Slip occurs when force applied to the wheel exceeds what the tire-surface
            // contact can deliver. Two factors:
            // 1. Surface grip: low grip = easier to spin (grass, ice)
            // 2. Force vs momentum: high force + low speed = wheelspin (burnout on asphalt)
            //    As speed increases, momentum helps transfer force → less slip
            // (This wheel is always in contact here — the airborne case returned above.)
            const torqueRatio = wheelConfig.isDriven ? (wheelConfig.torqueRatio ?? 1.0) : 0;
            const totalForce = Math.abs(this.engineForce) * torqueRatio + this.brakingForce;

            if (totalForce > 0) {
                // How fast the vehicle is moving (higher speed = better force transfer)
                const speed = Math.abs(this.vehicleController.currentVehicleSpeed());
                // At low speed, tires can't transfer as much force (no rolling momentum).
                // speedFactor: 0 at standstill → 1 at ~15 m/s (~54 km/h)
                const speedFactor = Math.min(1.0, speed / 15);

                // Maximum force the tire can transfer = base capacity * grip * (speed helps)
                // A stationary tire on asphalt can still transfer force, but much less than a rolling one
                const tireCapacity = this.config.mass * 10 * info.grip * (0.3 + 0.7 * speedFactor);

                // Slip = how much demand exceeds capacity
                const excessRatio = totalForce / Math.max(tireCapacity, 1);
                info.slip = Math.min(1.0, Math.max(0, excessRatio - 1.0) * 2);
                // Also add slip from low grip even at moderate force
                // (driving on ice at half throttle should still slip)
                info.slip = Math.min(1.0, info.slip + Math.max(0, (1 - info.grip) * 0.5) * (totalForce / this.MAX_ENGINE_FORCE));
            } else {
                info.slip = 0;
            }
        }
    }


    /**
     * Get terrain info for all wheels. Template code can use this for effects.
     */
    public getWheelTerrainInfo(): readonly WheelTerrainInfo[] {
        return this.wheelTerrainInfo;
    }
    
    /**
     * Set the friction slip for a specific wheel.
     * Higher values = more grip. Typical range: 1-10.
     * Use with getWheelTerrainInfo() to dynamically adjust per-wheel grip based on terrain.
     *
     * This is the tyre's TOTAL force budget: forward drive and sideways cornering
     * share one friction circle, so turning it down to make the back end slide
     * also robs the thrust that would carry the slide. To break lateral grip on
     * its own use `setWheelSideFrictionStiffness()`.
     *
     * Also note the per-substep terrain-grip pass rewrites this value from the
     * surface under the wheel (`baseFrictionSlip × grip`) at the END of every
     * substep, so a game-side override must be re-applied in a PRE-step callback
     * to survive multi-substep frames.
     *
     * @param wheelIndex - Wheel index (0-based)
     * @param frictionSlip - Friction slip value
     */
    public setWheelFrictionSlip(wheelIndex: number, frictionSlip: number): void {
        if (this.vehicleController && wheelIndex >= 0 && wheelIndex < this.wheelConfigs.length) {
            this.vehicleController.setWheelFrictionSlip(wheelIndex, frictionSlip);
        }
    }

    /**
     * Set how hard a wheel resists sliding SIDEWAYS, independently of its
     * forward grip (Rapier's per-wheel `sideFrictionStiffness`). 1 = stock full
     * bite, ~0.15 = a rear end that swings out under power, ~0.05 = ice.
     *
     * This is the knob for drift, donuts and power oversteer: it scales the
     * lateral tyre impulse BEFORE the friction circle is evaluated, so the wheel
     * keeps its full drive force while losing its cornering bite — unlike
     * `setWheelFrictionSlip()`, which caps both at once. Nothing in the engine
     * rewrites it per substep, so one call per state change is enough.
     *
     * @param wheelIndex - Wheel index (0-based)
     * @param stiffness - Lateral grip multiplier (0 = no sideways grip at all)
     */
    public setWheelSideFrictionStiffness(wheelIndex: number, stiffness: number): void {
        if (this.vehicleController && wheelIndex >= 0 && wheelIndex < this.wheelConfigs.length) {
            this.vehicleController.setWheelSideFrictionStiffness(wheelIndex, stiffness);
        }
    }

    /**
     * Current lateral grip multiplier of a wheel (see
     * `setWheelSideFrictionStiffness`). Returns the configured default when the
     * wheel index is out of range or the controller is gone.
     */
    public getWheelSideFrictionStiffness(wheelIndex: number): number {
        if (this.vehicleController && wheelIndex >= 0 && wheelIndex < this.wheelConfigs.length) {
            return this.vehicleController.wheelSideFrictionStiffness(wheelIndex)
                ?? DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS;
        }
        return this.wheelConfigs[wheelIndex]?.sideFrictionStiffness ?? DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS;
    }


    /**
     * Get the number of wheels on this vehicle.
     */
    public getWheelCount(): number {
        return this.wheelConfigs.length;
    }

    /**
     * Accumulated spin angle of one wheel, in radians, as the solver computed it.
     *
     * This is the REAL wheel rotation, not `speed / radius`. The two diverge
     * exactly where it is most visible: wheels spin faster than the car under
     * acceleration, lock under braking, and keep or lose spin independently of
     * travel while airborne. Anything reproducing wheel motion — a replay
     * ghost, a spectator view — has to read this rather than infer it.
     */
    public getWheelRotation(wheelIndex: number): number {
        return this.vehicleController?.wheelRotation(wheelIndex) ?? 0;
    }
    
    /**
     * Snapshot the chassis body pose after a physics substep so visualUpdate()
     * can render the mesh interpolated between the last two substeps. Called once
     * per substep from VehicleManager's post-step callback. See prevChassisPos.
     */
    public captureInterpolationState(): void {
        if (!this.chassisBody) return;
        const t = this.chassisBody.translation();
        const r = this.chassisBody.rotation();
        if (!this.interpInitialized) {
            // First sample: seed both endpoints so we don't interpolate from the
            // origin on the very first frame.
            this.prevChassisPos.set(t.x, t.y, t.z);
            this.curChassisPos.set(t.x, t.y, t.z);
            this.prevChassisQuat.set(r.x, r.y, r.z, r.w);
            this.curChassisQuat.set(r.x, r.y, r.z, r.w);
            this.interpInitialized = true;
            return;
        }
        // A single substep can't move the chassis more than a few metres at any
        // believable speed (60 m/s ≈ 1 m per 1/60 s substep). A larger jump means
        // the body was teleported — respawn, auto-right lift, out-of-world reset.
        // Interpolating across that would smear the mesh over the whole jump for
        // one frame, so reseed both endpoints to the new pose instead.
        const jumpSq =
            (t.x - this.curChassisPos.x) ** 2 +
            (t.y - this.curChassisPos.y) ** 2 +
            (t.z - this.curChassisPos.z) ** 2;
        if (jumpSq > RapierVehicle.TELEPORT_JUMP_SQ) {
            this.prevChassisPos.set(t.x, t.y, t.z);
            this.prevChassisQuat.set(r.x, r.y, r.z, r.w);
        } else {
            this.prevChassisPos.copy(this.curChassisPos);
            this.prevChassisQuat.copy(this.curChassisQuat);
        }
        this.curChassisPos.set(t.x, t.y, t.z);
        this.curChassisQuat.set(r.x, r.y, r.z, r.w);
    }

    /**
     * Visual update - called once per frame after physics
     * Syncs visual meshes to physics body positions
     */
    public visualUpdate(): void {
        if (!this.vehicleController || !this.chassisBody) return;

        // Render the chassis interpolated between the last two physics substeps
        // (fixed-timestep judder fix — see captureInterpolationState). Falls back
        // to the raw body pose until the first substep has been captured.
        if (this.interpInitialized && this.engine.physicsWorld) {
            const alpha = THREE.MathUtils.clamp(this.engine.physicsWorld.getInterpolationAlpha(), 0, 1);
            this.chassisMesh.position.lerpVectors(this.prevChassisPos, this.curChassisPos, alpha);
            this.chassisMesh.quaternion.slerpQuaternions(this.prevChassisQuat, this.curChassisQuat, alpha);
        } else {
            const pos = this.chassisBody.translation();
            const rot = this.chassisBody.rotation();
            this.chassisMesh.position.set(pos.x, pos.y, pos.z);
            this.chassisMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
        }

        for (let i = 0; i < this.wheelConfigs.length && i < this.wheelMeshes.length; i++) {
            const wheelMesh = this.wheelMeshes[i];
            const wheelConfig = this.wheelConfigs[i];
            if (!wheelMesh || !wheelConfig) continue;

            const connectionPoint = this.vehicleController.wheelChassisConnectionPointCs(i);
            const suspensionLength = this.vehicleController.wheelSuspensionLength(i) ?? wheelConfig.suspensionRestLength;
            const wheelRotation = this.vehicleController.wheelRotation(i) ?? 0;
            const wheelSteering = this.vehicleController.wheelSteering(i) ?? 0;

            wheelMesh.position
                .set(
                    connectionPoint?.x ?? wheelConfig.position.x,
                    (connectionPoint?.y ?? wheelConfig.position.y) - suspensionLength,
                    connectionPoint?.z ?? wheelConfig.position.z,
                )
                .applyQuaternion(this.chassisMesh.quaternion)
                .add(this.chassisMesh.position);

            // +wheelRotation: rolls the wheel FORWARD with travel. (Historically
            // this was −wheelRotation, i.e. backwards, but the stock wheels are
            // featureless cylinders so the direction was invisible; the forge's
            // detailed rims/tread exposed it — see VehicleWheelBuilder.)
            wheelMesh.quaternion.copy(this.chassisMesh.quaternion);
            wheelMesh.quaternion.multiply(this._wheelQuat.setFromAxisAngle(this._axisY, wheelSteering));
            wheelMesh.quaternion.multiply(this._wheelQuat.setFromAxisAngle(this._axisX, wheelRotation));
            wheelMesh.quaternion.multiply(RapierVehicle.WHEEL_CYLINDER_ALIGN);
        }

        // Body lean, applied LAST and to the visual chassis only. The wheel loop
        // above has already read `chassisMesh` at the exact physics pose, so the
        // tyres stay planted on the road while the body rolls above them — and the
        // rigid body itself is untouched, so handling is unaffected.
        this.applyBodySway();

        if (this.renderer.updateVisuals) {
            const v = this.chassisBody.linvel();
            this.renderer.updateVisuals(1 / 60, Math.hypot(v.x, v.y, v.z));
        }
    }

    /**
     * Lean the rendered body under cornering and braking/acceleration loads.
     *
     * `visualUpdate()` and its caller take no delta, so the frame time is measured
     * here rather than threading a new argument through the vehicle API.
     */
    private applyBodySway(): void {
        if (this.config.bodySway === false || !this.chassisBody) return;
        if (!this.bodySway) {
            this.bodySway = new VehicleBodySway({
                ...DEFAULT_VEHICLE_BODY_SWAY,
                ...(this.config.bodySway ?? {}),
            });
        }

        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const dt = this.lastVisualMs === null ? 1 / 60 : (nowMs - this.lastVisualMs) / 1000;
        this.lastVisualMs = nowMs;

        // Speed along the body's OWN forward axis (signed, so reversing leans the
        // other way) and the yaw rate it is turning at — together these give the
        // cornering and weight-transfer loads without differentiating a velocity.
        const v = this.chassisBody.linvel();
        const w = this.chassisBody.angvel();
        this._swayForward.set(0, 0, 1).applyQuaternion(this.chassisMesh.quaternion);
        const forwardSpeed = v.x * this._swayForward.x + v.y * this._swayForward.y + v.z * this._swayForward.z;

        const { rollRad, pitchRad } = this.bodySway.update(dt, { forwardSpeed, yawRate: w.y });

        // Body-local lean: post-multiply so roll is about the car's own forward
        // axis and pitch about its own right axis, whatever way it is facing.
        this._swayQuat.setFromAxisAngle(this._axisZ, rollRad);
        this.chassisMesh.quaternion.multiply(this._swayQuat);
        this._swayQuat.setFromAxisAngle(this._axisX, pitchRad);
        this.chassisMesh.quaternion.multiply(this._swayQuat);
    }

    /** Tune or disable the visual body lean at runtime (null = rigid body). */
    public setBodySway(options: Partial<VehicleBodySwayOptions> | null): void {
        if (options === null) {
            this.bodySway = null;
            this.config.bodySway = false;
            return;
        }
        this.config.bodySway = options;
        if (this.bodySway) this.bodySway.setOptions(options);
        else this.bodySway = new VehicleBodySway({ ...DEFAULT_VEHICLE_BODY_SWAY, ...options });
    }

    /**
     * Combined update - for backward compatibility
     * @deprecated Use physicsUpdate() and visualUpdate() separately
     */
    public update(): void {
        this.physicsUpdate(1/60);
        this.visualUpdate();
    }

    /** `dt` is the frame delta physicsUpdate() was called with. It must NOT be
     *  re-derived from `engine.clock`: that reader is destructive, so consuming
     *  it here stole the delta from GameEngine.animate() and starved the whole
     *  physics world whenever a two-wheeler was being ridden — and handed the
     *  lean controller the time since its own last call, not the frame time. */
    private updateMotorcyclePhysics(dt: number): void {
        if (!this.chassisBody) return;

        const deltaTime = Math.min(dt, 0.05);

        const quaternion = this.getChassisQuaternion();

        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
        const currentRoll = euler.z;
        const currentPitch = euler.x;

        if (this.steering !== 0) {
            this.targetLeanAngle = -this.steering * this.MAX_LEAN_ANGLE / this.getResolvedHandling().maxSteerAngleRad;
        } else {
            this.targetLeanAngle = 0;
        }

        const currentRollAbs = Math.abs(currentRoll);
        const maxSafeRoll = 0.7;

        if (currentRollAbs > maxSafeRoll) {
            this.targetLeanAngle = THREE.MathUtils.clamp(this.targetLeanAngle, -maxSafeRoll * 0.8, maxSafeRoll * 0.8);
        }

        const leanDelta = this.LEAN_SPEED * deltaTime;

        if (this.currentLeanAngle < this.targetLeanAngle) {
            this.currentLeanAngle = Math.min(this.currentLeanAngle + leanDelta, this.targetLeanAngle);
        } else {
            this.currentLeanAngle = Math.max(this.currentLeanAngle - leanDelta, this.targetLeanAngle);
        }

        const angVel = this.chassisBody.angvel();
        const worldAngVel = new THREE.Vector3(angVel.x, angVel.y, angVel.z);

        const invRotation = quaternion.clone().invert();
        const localAngVel = worldAngVel.clone().applyQuaternion(invRotation);

        const targetRoll = this.currentLeanAngle;
        const rollError = targetRoll - currentRoll;
        const pitchError = -currentPitch;

        const velocity = this.chassisBody.linvel();
        const speed = Math.hypot(velocity.x, velocity.y, velocity.z);

        let kpRoll = this.STABILIZATION_STRENGTH * 200.0;
        let kdRoll = 600.0;

        if (Math.abs(rollError) > 0.1) {
            kpRoll *= 1.2;
            kdRoll *= 0.8;
        }

        if (speed < 5.0) {
            kpRoll *= 2.0;
            kdRoll *= 2.0;
        }

        const kpPitch = this.STABILIZATION_STRENGTH * 200.0;
        const kdPitch = 600.0;

        const maxTorque = 25000.0;

        const rollTorqueVal = THREE.MathUtils.clamp((rollError * kpRoll) - (localAngVel.z * kdRoll), -maxTorque, maxTorque);
        const pitchTorqueVal = THREE.MathUtils.clamp((pitchError * kpPitch) - (localAngVel.x * kdPitch), -maxTorque, maxTorque);

        // Chassis-local (pitch, -, roll) torque rotated into world space.
        const stabilizationTorque = new THREE.Vector3(pitchTorqueVal, 0, rollTorqueVal).applyQuaternion(quaternion);

        let yawTorqueVal: number;
        if (this.steering !== 0) {
            const speedFactor = THREE.MathUtils.clamp(15.0 / (speed + 0.1), 0.5, 1.5);
            const turnSpeed = this.TURN_SPEED * 2.0 * speedFactor;
            const targetYawRate = this.steering * turnSpeed;
            const currentYawRate = worldAngVel.y;
            const kpYaw = 200.0;
            yawTorqueVal = (targetYawRate - currentYawRate) * kpYaw;
        } else {
            yawTorqueVal = -worldAngVel.y * 20.0;
        }

        yawTorqueVal = THREE.MathUtils.clamp(yawTorqueVal, -maxTorque, maxTorque);
        const turnTorque = new THREE.Vector3(0, yawTorqueVal, 0);

        const totalTorque = {
            x: stabilizationTorque.x + turnTorque.x,
            y: stabilizationTorque.y + turnTorque.y,
            z: stabilizationTorque.z + turnTorque.z
        };

        this.chassisBody.applyTorqueImpulse(totalTorque, true);

        if (Math.abs(currentRoll) > 0.6) {
            const uprightForce = -currentRoll * 50000.0;
            const recoveryTorque = new THREE.Vector3(0, 0, uprightForce).applyQuaternion(quaternion);
            this.chassisBody.applyTorqueImpulse({ x: recoveryTorque.x, y: recoveryTorque.y, z: recoveryTorque.z }, true);

            if (speed < 1.0 && Math.abs(currentRoll) > 0.7) {
                this.chassisBody.applyImpulse({ x: 0, y: this.config.mass * 0.2, z: 0 }, true);
            }
        }

        if (Math.random() < 0.016) {
            const rollDegrees = (currentRoll * 180 / Math.PI).toFixed(1);
            const targetLeanDegrees = (this.targetLeanAngle * 180 / Math.PI).toFixed(1);
            console.log(`🏍️ Motorcycle: roll=${rollDegrees}°, targetLean=${targetLeanDegrees}°, steering=${this.steering.toFixed(2)}`);
        }
    }

    public getPosition(): THREE.Vector3 {
        if (!this.chassisBody) return this.chassisMesh.position.clone();
        const pos = this.chassisBody.translation();
        return new THREE.Vector3(pos.x, pos.y, pos.z);
    }

    public getChassisObject(): THREE.Object3D {
        return this.chassisMesh;
    }

    /**
     * The ground plane in the CHASSIS-LOCAL frame: the Y at which the wheels
     * touch down, which is `-rideHeight` measured from the body origin.
     *
     * Live while grounded (each wheel's connection point − current suspension
     * length − radius, averaged over the wheels actually in contact), falling
     * back to the fully-extended static estimate while airborne. Never derive
     * this from wheelContactPoint(): right after spawn/teleport Rapier reports
     * wheels in contact with a stale ZEROED point, so worldCom.y − 0 made
     * "height" ≈ the body's world Y — on a map built at y≈13 that clamped a
     * 4000N tip-guard request to ~100N and the vehicle could barely crawl until
     * the first real contact came through.
     */
    private groundContactYLocal(): number {
        let contactSum = 0;
        let contactCount = 0;
        if (this.vehicleController) {
            for (let i = 0; i < this.wheelConfigs.length; i++) {
                const wc = this.wheelConfigs[i];
                if (!wc || !this.vehicleController.wheelIsInContact(i)) continue;
                const suspLen = this.vehicleController.wheelSuspensionLength(i);
                contactSum += wc.position.y - (suspLen ?? wc.suspensionRestLength) - wc.radius;
                contactCount++;
            }
        }
        if (contactCount > 0) return contactSum / contactCount;
        if (this.tipGeometry) return this.tipGeometry.staticContactY;
        // Pre-controller (constructor-time) fallback: the same static formula
        // tipGeometry caches. An empty wheel list cannot happen — the
        // constructor throws without one — but Math.min() of nothing is
        // Infinity, and a poisoned ride height is worse than a zero.
        if (this.wheelConfigs.length === 0) return 0;
        return Math.min(...this.wheelConfigs.map(
            (w) => w.position.y - w.suspensionRestLength - w.radius,
        ));
    }

    /**
     * The vehicle's real collision extents (m) — what a route planner must fit
     * through gaps and under overhangs.
     *
     * The union of every collision box on the body, NOT `config.chassisSize`:
     * on the asset path `chassisSize` is only the 0.15 m platform slab
     * (`VehiclePlatformBuilder.PLATFORM_HEIGHT`), and the car's actual body —
     * roof, cab, load bed, up to ~1.3 m tall — arrives afterwards as separate
     * colliders through addBodyPhysics(). A planner told the car is 0.15 m tall
     * routes it under any awning, balcony or eave it will actually hit.
     */
    getFootprint(): VehicleFootprint {
        const bounds = this.localBodyBounds;
        if (!bounds) {
            // No collision body was ever built (no physics world), so the
            // configured slab is genuinely all there is to report.
            const { width, height, length } = this.config.chassisSize;
            return { width, height, length };
        }
        return {
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
            length: bounds.maxZ - bounds.minZ,
        };
    }

    /**
     * Steepest rise/run this vehicle can climb. Derived from force-to-weight
     * unless the asset declares `maxClimbGrade`. Route planners should ask
     * rather than guess: the same level is drivable by a rally car and not by
     * a 1.5 N/kg compact.
     *
     * `MAX_ENGINE_FORCE` is a PER-DRIVEN-WHEEL figure — updateVehicle() feeds it
     * to every driven wheel individually (`setWheelEngineForce(i, driveForce *
     * torqueRatio * …)`) and the tip-over guard sums exactly this quantity over
     * the driven wheels. `derivedClimbGrade` models `tanθ ≈ force / (mass·g)`
     * and wants the TOTAL tractive force, so the sum is what goes in: handing it
     * one wheel's share made a 4WD car report a quarter of the hill it climbs.
     * Grip and `accelerationScale` are deliberately left out — they are live
     * terrain/handling state, and this is a static capability.
     */
    getMaxClimbGrade(): number {
        if (this.config.maxClimbGrade !== undefined) return this.config.maxClimbGrade;
        let totalDriveForce = 0;
        for (const wheel of this.wheelConfigs) {
            if (!wheel.isDriven) continue;
            totalDriveForce += this.MAX_ENGINE_FORCE * (wheel.torqueRatio ?? 1.0);
        }
        return derivedClimbGrade(totalDriveForce, this.config.mass);
    }

    /**
     * Tallest abrupt step (m) this vehicle can mount — a kerb, a ledge, a lip.
     *
     * Separate from `getMaxClimbGrade()` on purpose. Force-to-weight bounds how
     * steep a SLOPE the car can pull itself up; it says nothing about a
     * discontinuity, where the limit is whether the wheel can roll over the
     * edge at all. A 0.4 m wheel cannot mount a 0.34 m vertical face however
     * much power is behind it. Treating one number as both is what let a route
     * search send a car over a kerb it then wedged against.
     */
    getMaxStepHeight(): number {
        return derivedStepHeight(this.wheelConfigs[0]?.radius ?? 0.4);
    }

    /**
     * Can THIS vehicle drive the straight line between two XZ points?
     *
     * Fills in its own footprint, climb grade and ride height and calls
     * `PhysicsWorld.probeVehiclePath`. Planning-time only — see that method for
     * the cost and for the collider-availability caveat (probe only once the map
     * colliders are live and only within the physics radius, or a culled
     * building reads as clear road).
     *
     * FAILS CLOSED, indistinguishably from a real hit: with no physics world
     * this returns `{ passable: false, reason: 'obstacle', blockedAt: 0 }`,
     * exactly what a wall at the start of the segment returns. A caller that
     * must tell "blocked" from "could not ask" has to check for the physics
     * world itself.
     */
    probePath(fromX: number, fromZ: number, toX: number, toZ: number): VehiclePassResult {
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) {
            // Fail closed — an unqueryable world must not read as clear road.
            return { passable: false, blockedAt: 0, reason: 'obstacle', peakGrade: 0 };
        }
        const referenceY = this.getPosition().y;
        // Ride height must place the SWEPT FOOTPRINT BOX exactly where this
        // vehicle's body sits: the box centre is the local bounds' mid-height,
        // and the ground is at groundContactYLocal() in the same frame, so the
        // difference is the box centre's height above the road. The live
        // (suspension-loaded) contact is the right one to use — it is where the
        // car rides while driving, and it is the lower, more conservative of the
        // two, so a kerb or a low eave is not flown over. Deriving this from
        // `chassisSize` instead put the box in a band the chassis never occupies
        // (that height is the 0.15 m platform slab, see getFootprint()).
        const bounds = this.localBodyBounds;
        const boxCentreLocalY = bounds ? (bounds.minY + bounds.maxY) / 2 : 0;
        return physicsWorld.probeVehiclePath(
            new THREE.Vector3(fromX, referenceY, fromZ),
            new THREE.Vector3(toX, referenceY, toZ),
            {
                footprint: this.getFootprint(),
                maxClimbGrade: this.getMaxClimbGrade(),
                maxStepHeight: this.getMaxStepHeight(),
                rideHeight: boxCentreLocalY - this.groundContactYLocal(),
            },
        );
    }

    /** Size relative to the default car (1 = default, 0.25 = quarter-scale). Derived from chassis footprint ÷ reference. Cached once available. */
    public getSizeFactor(): number {
        if (this.cachedSizeFactor !== null) return this.cachedSizeFactor;
        const he = this.getChassisCollider()?.halfExtents();
        if (!he) return 1;
        const footprint = Math.max(he.x, he.z) * 2;
        this.cachedSizeFactor = footprint > 0 ? footprint / HANDLING_DEFAULTS.referenceFootprint : 1;
        return this.cachedSizeFactor;
    }

    /** Resolved handling (engine units, radians), cached and recomputed on setHandling. */
    private getResolvedHandling(): ResolvedVehicleHandling {
        if (this.resolvedHandling === null) {
            this.resolvedHandling = resolveVehicleHandling(this.handlingOverrides, this.getSizeFactor());
        }
        return this.resolvedHandling;
    }

    /** Current effective handling in agent units (degrees, m/s), every field populated. Use for read-modify-write tweaks. */
    public getHandling(): Required<VehicleHandlingConfig> {
        return handlingToAgentUnits(this.getResolvedHandling());
    }

    /** Override handling params at runtime (angles in degrees, speed in m/s). Merges with existing overrides; takes effect immediately. */
    public setHandling(overrides: VehicleHandlingConfig): void {
        Object.assign(this.handlingOverrides, overrides);
        this.resolvedHandling = null;
    }

    /** Drop all handling overrides — back to fully size-scaled defaults. */
    public resetHandling(): void {
        this.handlingOverrides = {};
        this.resolvedHandling = null;
    }

    public isNearPosition(position: THREE.Vector3, maxDistance: number = 3.0): boolean {
        return this.getPosition().distanceTo(position) <= maxDistance;
    }

    public canPlayerEnter(): boolean {
        return !this.isPlayerDriving && !this.disabled;
    }

    /**
     * INTERNAL: Sets vehicle-level driving state only.
     * Called by PlayerVehicleController - do not call directly from game code.
     * Use playerController.enterVehicle(vehicle) instead.
     * @internal
     */
    public enterVehicle_INTERNAL(player: unknown): boolean {
        if (!this.canPlayerEnter()) return false;

        console.log(`RapierVehicle: Player entering ${this.isTwoWheeled ? '2-wheel' : this.wheelConfigs.length + '-wheel'} vehicle`);

        this.isPlayerDriving = true;
        this.currentDriver = player;

        if (this.chassisBody) {
            const logOrientation = (label: string) => {
                const euler = new THREE.Euler().setFromQuaternion(this.getChassisQuaternion(), 'YXZ');
                const rad2deg = 180 / Math.PI;
                console.log(`RapierVehicle: ${label} - roll=${(euler.z * rad2deg).toFixed(1)}°, pitch=${(euler.x * rad2deg).toFixed(1)}°, yaw=${(euler.y * rad2deg).toFixed(1)}°`);
            };

            logOrientation('Initial orientation');
            this.correctVehicleOrientation();
            if (this.isTwoWheeled) {
                this.applyTwoWheelStabilizationOnEntry();
            }
            logOrientation('After corrections');
        }

        const playerObj = player as { position?: THREE.Vector3 };
        if (playerObj?.position) {
            playerObj.position.copy(this.getPosition());
            playerObj.position.y += 0.5;
        }

        if (this.chassisBody) {
            this.chassisBody.wakeUp();
            console.log('RapierVehicle: Activated physics body on entry');
        }

        // The player capsule is about to be disabled by PlayerVehicleController —
        // give the driver a PLAYER-group sensor on the chassis so collectibles
        // still auto-collect while seated.
        this.createDriverPickupProbe();

        return true;
    }

    /**
     * Attach the driver pickup probe to the chassis (see DriverPickupProbe).
     * Sized to the chassis box so long vehicles collect along their whole body.
     */
    private createDriverPickupProbe(): void {
        if (this.driverPickupProbe || !this.engine.physicsWorld || !this.chassisBody) return;

        const { width, height, length } = this.config.chassisSize;
        this.driverPickupProbe = new DriverPickupProbe(this.engine.physicsWorld, this.chassisBody, {
            x: width / 2,
            y: height / 2,
            z: length / 2,
        });
    }

    /** Remove the driver pickup probe (vehicle exited or disposed). No-op if absent. */
    private disposeDriverPickupProbe(): void {
        if (!this.driverPickupProbe) return;

        this.driverPickupProbe.dispose();
        this.driverPickupProbe = null;
    }

    private applyTwoWheelStabilizationOnEntry(): void {
        if (!this.chassisBody) return;

        console.log('RapierVehicle: Applying 2-wheel stabilization settings...');

        this.chassisBody.setAngularDamping(0.8);
        console.log('  ✓ Set angular damping to 0.8');

        this.freezeVelocities();

        console.log('✅ 2-wheel stabilization applied (active PID only)');
    }

    private correctVehicleOrientation(): void {
        if (!this.chassisBody || !this.chassisMesh) return;

        const quaternion = this.getChassisQuaternion();

        const upVector = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);

        // Chassis is upside-down or on its side when world-up rotates below this threshold.
        if (upVector.y < 0.5) {
            const pos = this.chassisBody.translation();
            const currentPos = new THREE.Vector3(pos.x, pos.y, pos.z);

            const halfHeight = this.config.chassisSize.height * 0.5;
            let correctedY = currentPos.y;

            if (this.engine.getWorldHeightAt) {
                const terrainHeight = this.engine.getWorldHeightAt(currentPos.x, currentPos.z);
                const minY = terrainHeight + halfHeight + 0.2;
                correctedY = Math.max(currentPos.y, minY);

                if (correctedY > currentPos.y) {
                    console.log(`RapierVehicle: Adjusting Y from ${currentPos.y.toFixed(2)} to ${correctedY.toFixed(2)} (ground: ${terrainHeight.toFixed(2)})`);
                }
            }

            const euler = new THREE.Euler().setFromQuaternion(quaternion);
            const yRotation = euler.y;

            const uprightQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yRotation, 0));

            this.chassisBody.setTranslation({ x: currentPos.x, y: correctedY, z: currentPos.z }, true);
            this.chassisBody.setRotation({ x: uprightQuaternion.x, y: uprightQuaternion.y, z: uprightQuaternion.z, w: uprightQuaternion.w }, true);
            this.freezeVelocities();

            this.chassisMesh.position.set(currentPos.x, correctedY, currentPos.z);
            this.chassisMesh.quaternion.copy(uprightQuaternion);

            console.log('RapierVehicle: Corrected orientation on entry (with ground check)');
        }
    }

    public exitVehicle(): unknown {
        if (!this.isPlayerDriving) return null;

        const driver = this.currentDriver;
        this.isPlayerDriving = false;
        this.currentDriver = null;

        // The real player capsule comes back on foot — drop its stand-in.
        this.disposeDriverPickupProbe();

        this.engineForce = 0;
        this.steering = 0;
        this.brakingForce = 0;
        // The driver leaving parks the car — it must hold on a hill until the
        // next driver actually throttles.
        this.parkingBrakeEngaged = true;

        const driverObj = driver as { position?: THREE.Vector3 };
        if (driverObj?.position) {
            const vehiclePosition = this.getPosition();
            const vehicleRotation = this.chassisMesh.rotation.y;

            const sideOffset = this.config.chassisSize.width * 0.8;
            driverObj.position.set(
                vehiclePosition.x + Math.cos(vehicleRotation + Math.PI / 2) * sideOffset,
                vehiclePosition.y + 0.5,
                vehiclePosition.z + Math.sin(vehicleRotation + Math.PI / 2) * sideOffset
            );

            console.log('Player exited vehicle at position:', driverObj.position);
        }

        return driver;
    }

    public isPlayerInVehicle(): boolean {
        return this.isPlayerDriving;
    }

    public getCurrentDriver(): unknown {
        return this.currentDriver;
    }

    public onInteractStart(): boolean {
        return this.canPlayerEnter();
    }

    public onInteractEnd(): void {}

    public getInteractStartDisplayName(): string {
        return t('game.interaction.enterVehicle');
    }

    public getInteractEndDisplayName(): string {
        return t('game.interaction.exitVehicle');
    }

    public applyImpulse(x: number, y: number, z: number): void {
        if (!this.chassisBody) return;
        this.chassisBody.applyImpulse({ x, y, z }, true);
        this.chassisBody.wakeUp();
    }

    public applyLocalImpulse(x: number, y: number, z: number): void {
        if (!this.chassisBody) return;

        const localImpulse = new THREE.Vector3(x, y, z).applyQuaternion(this.getChassisQuaternion());

        this.chassisBody.applyImpulse({ x: localImpulse.x, y: localImpulse.y, z: localImpulse.z }, true);
        this.chassisBody.wakeUp();
    }

    public applyForce(x: number, y: number, z: number): void {
        if (!this.chassisBody) return;
        this.chassisBody.addForce({ x, y, z }, true);
    }

    public applyTorque(x: number, y: number, z: number): void {
        if (!this.chassisBody) return;
        this.chassisBody.addTorque({ x, y, z }, true);
    }

    /**
     * Get the underlying Rapier rigid body for the vehicle chassis.
     * Use this to register collision callbacks via physicsWorld.registerCollisionCallback().
     */
    public getChassisBody(): RAPIER.RigidBody | null {
        return this.chassisBody;
    }

    /**
     * Apply AI driving controls to this vehicle.
     * Unlike updateControls(), this works on vehicles that are NOT player-driven.
     * Use for AI opponents, NPC traffic, scripted vehicles, etc.
     *
     * @param controls - forward/backward/left/right/brake booleans
     */
    public setAIControls(controls: VehicleControls): void {
        this.applyThrottleAndBrake(controls);

        // Same speed-softening model as the player path in updateControls():
        // size-normalized speed, floored at minSteerAtSpeed (see
        // steeringSpeedFactor for why the raw-speed no-floor version broke AI
        // cornering after the 2026-07-24 top-speed raise).
        const h = this.getResolvedHandling();
        const speedFactor = steeringSpeedFactor(this.getSpeed(), this.getSizeFactor(), h);

        if (controls.steer !== undefined) {
            // Analog steering: +1 = full left (same direction as `left`),
            // -1 = full right. Lets proportional controllers apply partial lock.
            const s = THREE.MathUtils.clamp(controls.steer, -1, 1);
            this.steering = s * h.maxSteerAngleRad * speedFactor;
        } else if (controls.left) {
            this.steering = h.maxSteerAngleRad * speedFactor;
        } else if (controls.right) {
            this.steering = -h.maxSteerAngleRad * speedFactor;
        } else {
            this.steering = 0;
        }
    }

    /**
     * Set a pluggable AI driving component. The component's update() is called
     * by updateAI(). Pass null to remove.
     */
    public setDrivingComponent(comp: IVehicleDrivingComponent | null): void {
        this.drivingComponent = comp;
        // Removing the AI driver parks the car, same as a player stepping out.
        if (!comp && !this.isPlayerDriving) {
            this.parkingBrakeEngaged = true;
        }
    }

    /**
     * Engage or release the parking brake by hand. Vehicles spawn with it
     * engaged and release it automatically on the first gas/reverse input
     * (player or AI); exiting the vehicle re-engages it. Override only when a
     * game genuinely wants a driverless car to roll (e.g. a scripted runaway).
     */
    public setParkingBrake(engaged: boolean): void {
        this.parkingBrakeEngaged = engaged;
    }

    public isParkingBrakeEngaged(): boolean {
        return this.parkingBrakeEngaged;
    }

    public getDrivingComponent(): IVehicleDrivingComponent | null {
        return this.drivingComponent;
    }

    /**
     * Tick the AI driving component. Call this each frame for AI-driven vehicles.
     * No-op if no driving component is set.
     */
    public updateAI(deltaTime: number): void {
        this.drivingComponent?.update(deltaTime, this);
    }

    public getLinearVelocity(): THREE.Vector3 {
        if (!this.chassisBody) return new THREE.Vector3();
        const velocity = this.chassisBody.linvel();
        return new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    }

    public getSpeed(): number {
        return this.getLinearVelocity().length();
    }

    /**
     * Speed along the car's OWN forward axis, signed: positive driving forwards,
     * negative reversing. Unlike getSpeed() this ignores sideways slide and
     * vertical motion, so it is the speed the throttle should be gated against.
     */
    public getForwardSpeed(): number {
        if (!this.chassisBody) return 0;
        return this.getLinearVelocity().dot(this.getForwardDirection());
    }

    /** Get the current steering angle in radians. */
    public getSteeringAngle(): number {
        return this.steering;
    }

    public getAngularVelocity(): THREE.Vector3 {
        if (!this.chassisBody) return new THREE.Vector3();
        const angVel = this.chassisBody.angvel();
        return new THREE.Vector3(angVel.x, angVel.y, angVel.z);
    }

    public isGrounded(): boolean {
        if (!this.vehicleController) return false;

        for (let i = 0; i < this.wheelConfigs.length; i++) {
            if (this.vehicleController.wheelIsInContact(i)) {
                return true;
            }
        }
        return false;
    }

    public getUpDirection(): THREE.Vector3 {
        if (!this.chassisBody) return new THREE.Vector3(0, 1, 0);
        return new THREE.Vector3(0, 1, 0).applyQuaternion(this.getChassisQuaternion());
    }

    public getForwardDirection(): THREE.Vector3 {
        if (!this.chassisBody) return new THREE.Vector3(0, 0, 1);
        return new THREE.Vector3(0, 0, 1).applyQuaternion(this.getChassisQuaternion());
    }

    public setYawRotation(radians: number): void {
        if (!this.chassisBody) return;

        const rotationQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), radians);

        this.chassisBody.setRotation({ x: rotationQuat.x, y: rotationQuat.y, z: rotationQuat.z, w: rotationQuat.w }, true);
        this.chassisMesh.quaternion.copy(rotationQuat);
    }

    /**
     * Place the vehicle at a position with zeroed velocities — respawn at a
     * checkpoint, reset to track, return to spawn. `heading` is a gameplay yaw
     * in radians (+Z forward); omit it to keep the current facing.
     *
     * This is the supported way to reposition a vehicle from game code. Moving
     * the chassis body directly skips the yaw-only rotation (a full checkpoint
     * quaternion can spawn the car pitched into the ground) and leaves the old
     * momentum, and the render interpolator only treats the jump as a teleport
     * rather than smearing motion across it because the displacement exceeds
     * TELEPORT_JUMP_SQ.
     */
    public teleportTo(position: { x: number; y: number; z: number }, heading?: number): void {
        if (!this.chassisBody) return;

        if (heading !== undefined) this.setYawRotation(heading);
        this.chassisBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
        this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.chassisMesh.position.set(position.x, position.y, position.z);
    }

    public getMass(): number {
        return this.config.mass + this.additionalMass;
    }

    public getChassisCollider(): RAPIER.Collider | null {
        return this.chassisCollider;
    }

    /**
     * Half extents of the box enclosing the chassis slab AND the wheel guards,
     * chassis-local and centred on the slab — the car's real horizontal
     * footprint, which on any vehicle with proud wheels is wider than the
     * chassis collider alone (an `exposed` axle puts the whole tyre outboard of
     * the bodywork). Car-to-car contact tests must measure THIS, or a pair
     * locked wheel-to-wheel reads as half a metre apart and never gets freed.
     *
     * The vertical extent stays the slab's: guards hang below it, they never
     * raise the car, and whether two cars are stacked is a question about their
     * bodies. Null when the chassis collider is gone (vehicle torn down).
     */
    public getCollisionHalfExtents(): { x: number; y: number; z: number } | null {
        if (!this.chassisCollider) return null;
        const { width, height, length } = this.config.chassisSize;
        let halfX = width / 2;
        let halfZ = length / 2;
        // Guards only exist when they weren't disabled; re-deriving them from
        // the wheel configs is cheaper than reading back the live colliders
        // (whose translations are world-space, not chassis-local).
        if (this.wheelGuardHandles.size > 0) {
            for (const wheel of this.wheelConfigs) {
                const guard = wheelGuardBox(wheel);
                if (!guard) continue;
                halfX = Math.max(halfX, Math.abs(guard.position.x) + guard.size.width / 2);
                halfZ = Math.max(halfZ, Math.abs(guard.position.z) + guard.size.length / 2);
            }
        }
        return { x: halfX, y: height / 2, z: halfZ };
    }

    public isDriverControlled(): boolean {
        return this.isPlayerDriving;
    }

    public getIsTwoWheeled(): boolean {
        return this.isTwoWheeled;
    }

    public getEngineForce(): number {
        return this.engineForce;
    }

    public getSteering(): number {
        return this.steering;
    }

    public getBrakingForce(): number {
        return this.brakingForce;
    }

    public getMaxEngineForce(): number {
        return this.MAX_ENGINE_FORCE;
    }

    public getMaxBrakingForce(): number {
        return this.MAX_BRAKING_FORCE;
    }

    public getMaxSteering(): number {
        return this.getResolvedHandling().maxSteerAngleRad;
    }

    public setControlsExtension(extension: VehicleControlsExtension | null): void {
        this.controlsExtension = extension;
    }

    public getControlsExtension(): VehicleControlsExtension | null {
        return this.controlsExtension;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ChunkManagedObject - Chunk-based hibernation for large worlds
    // ════════════════════════════════════════════════════════════════════════
    
    hibernate(): void {
        if (this._isHibernating) return;
        this._isHibernating = true;
        if (this.chassisBody) this.chassisBody.setEnabled(false);
        this.chassisMesh.visible = false;
        this.wheelMeshes.forEach(w => w.visible = false);
    }

    wake(): void {
        if (!this._isHibernating) return;
        this._isHibernating = false;
        if (this.chassisBody) {
            this.chassisBody.setEnabled(true);
            // Restore gravity when waking (may have been held with gravity=0)
            this.chassisBody.setGravityScale(this._originalGravityScale, true);
        }
        this.chassisMesh.visible = true;
        this.wheelMeshes.forEach(w => w.visible = true);
    }
    
    isHibernating(): boolean {
        return this._isHibernating;
    }
    
    /**
     * Set whether this vehicle should always remain active (never hibernate).
     * When active, the vehicle and the terrain chunks beneath it stay loaded
     * even when outside the camera view. Player-controlled vehicles are always
     * active (see `isAlwaysActive`) so they don't disappear when driving into
     * unloaded chunks.
     */
    setAlwaysActive(active: boolean): void {
        this._alwaysActive = active;
    }

    isAlwaysActive(): boolean {
        return this.isPlayerDriving || this._alwaysActive;
    }
    
    /**
     * Hold physics (disable gravity) until terrain colliders are ready.
     * Called by DynamicObjectManager when vehicle registers before colliders are active.
     */
    holdPhysicsUntilReady(): void {
        if (this._physicsHeld || !this.chassisBody) return;
        this._physicsHeld = true;
        
        // Disable gravity and freeze in place
        this._originalGravityScale = this.chassisBody.gravityScale();
        this.chassisBody.setGravityScale(0, true);
        this.freezeVelocities();
    }
    
    /**
     * Release physics (re-enable gravity) when terrain colliders are ready.
     * Called by DynamicObjectManager when colliders become queryable.
     */
    releasePhysics(): void {
        if (!this._physicsHeld || !this.chassisBody) return;
        this._physicsHeld = false;
        
        // Teleport back to spawn position (in case we drifted)
        if (this._savedSpawnPosition) {
            this.chassisBody.setTranslation({
                x: this._savedSpawnPosition.x,
                y: this._savedSpawnPosition.y,
                z: this._savedSpawnPosition.z
            }, true);
            this.freezeVelocities();
        }
        
        // Re-enable gravity
        this.chassisBody.setGravityScale(this._originalGravityScale, true);
    }

    public dispose(): void {
        // Registry removal FIRST — the physics-world guard below must not
        // leave a disposed vehicle discoverable.
        activeRapierVehicles.delete(this);
        if (!this.engine.physicsWorld) return;

        // Dispose auto-wired interaction sensor (must happen before chassisBody is removed
        // since the sensor collider is a child of chassisBody).
        if (this.interactableComponent) {
            this.interactableComponent.dispose();
            this.interactableComponent = null;
        }

        // Same for the driver pickup probe — a vehicle can be destroyed with the
        // player still seated, so exitVehicle() is not guaranteed to have run.
        this.disposeDriverPickupProbe();

        // Unregister navmesh box obstacle. Order doesn't strictly matter
        // (the provider's getter null-checks `chassisBody.isValid()` and bails),
        // but disposing it here also stops the next tick() from re-painting
        // a phantom obstacle at the last-known position.
        if (this.navmeshObstacleProvider) {
            unregisterObstacleProvider(this.navmeshObstacleProvider);
            this.navmeshObstacleProvider = null;
        }

        // Unregister the sensor listener BEFORE the chassis collider is destroyed
        // so we don't get a final spurious event for a stale handle.
        if (this.sensorListener) {
            this.engine.physicsWorld.removeSensorListener(this.sensorListener);
            this.sensorListener = null;
        }
        this.impactListeners.clear();
        // impactSensorCollider is removed automatically when chassisBody is removed below.
        this.impactSensorCollider = null;
        this.impactSensorHandle = -1;

        const rapierWorld = this.engine.physicsWorld.getRapierWorld();

        if (this.vehicleController) {
            rapierWorld.removeVehicleController(this.vehicleController);
            this.vehicleController = null;
        }

        // Route chassis collider/body removal through the DEFERRED PhysicsWorld
        // queue rather than the raw Rapier world. dispose() can legitimately be
        // called from a sensor/trigger handler (e.g. an onCharacterImpact
        // listener that destroys the vehicle on a hard hit) — that runs inside
        // world.step()'s tail, where an immediate raw removal would corrupt the
        // pipeline. Deferred removal is flushed safely in processPendingRemovals
        // before the next step. (Removing the chassis body also auto-removes its
        // child colliders, including the impact sensor.)
        if (this.chassisCollider && this.chassisCollider.isValid()) {
            this.engine.physicsWorld.removeCollider(this.chassisCollider);
        }

        if (this.chassisBody && this.chassisBody.isValid()) {
            this.engine.physicsWorld.removeRigidBody(this.chassisBody);
        }

        if (this.engine.scene) {
            this.engine.scene.remove(this.chassisMesh);
            this.wheelMeshes.forEach(wheel => {
                this.engine.scene!.remove(wheel);
            });
        }

        this.chassisBody = null;
        this.chassisCollider = null;
        this.wheelGuardHandles.clear();
    }
}

