import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type { EngineLike } from 'types/game.js';

export type KinematicPlatformLoopMode = 'loop' | 'pingpong' | 'once';
export type KinematicPlatformTrigger = 'proximity' | 'key' | 'always';

export interface KinematicPlatformKeyBindings {
    /** Key code (e.g. 'KeyE') that drives the platform forward along its waypoints while held. */
    up: string | null;
    /** Key code that drives the platform backward while held. */
    down: string | null;
    /** Key code that toggles auto-drive (press once to start, press again to stop). */
    toggle: string | null;
}

/**
 * Pendulum swing mode: the body becomes a BOB hanging `armLength` below
 * `waypoints[0]` (the PIVOT), swinging in a vertical plane. Angle over time is
 * `amplitude·sin(2π·t/period + phase)`; the bob tilts with the arm. Classic
 * swinging blades / logs / wrecking balls. Mutually exclusive with
 * `angularSpeed` (both drive the body rotation).
 */
export interface KinematicPlatformPendulum {
    /** Distance from the pivot (waypoints[0]) to the bob centre, metres. */
    armLength: number;
    /** Full swing period in seconds (one left-right-left cycle). */
    periodS: number;
    /** Peak deflection from straight-down, degrees. */
    amplitudeDeg: number;
    /** World yaw (deg) of the swing direction: the bob displaces along (sin, 0, cos) of this. */
    swingYawDeg: number;
    /** Phase offset in degrees — stagger multiple pendulums. */
    phaseDeg: number;
}

export interface KinematicPlatformOptions {
    /** Ordered world-space waypoints the platform travels between. Must have at least 2 entries — or exactly 1 for a stationary spinner (`angularSpeed !== 0`) or a pendulum pivot (`pendulum` set). */
    waypoints: THREE.Vector3[];
    /** Travel speed in meters/second. */
    speed: number;
    /** Continuous rotation about the vertical (Y) axis in radians/second (sign sets direction, 0 = no spin). Riders are carried around by the engine's movement motor. */
    angularSpeed: number;
    /** How the platform behaves when it reaches the end of the waypoint list. */
    loop: KinematicPlatformLoopMode;
    /** What makes the platform move. `'always'` runs the loop continuously, `'proximity'` requires the player to be within `proximityRadius`, `'key'` drives it from keyboard input. */
    trigger: KinematicPlatformTrigger;
    /** Key bindings used when `trigger === 'key'`. Ignored otherwise. */
    keyBindings: KinematicPlatformKeyBindings;
    /** Radius in meters within which the player activates the platform when `trigger === 'proximity'`. */
    proximityRadius: number;
    /** Platform dimensions in meters when no `mesh` override is provided. */
    size: THREE.Vector3;
    /** Optional mesh override. When present, the collider is sized from its bounding box. The mesh's local origin is treated as the platform center. */
    mesh: THREE.Object3D | null;
    /**
     * Collider/default-mesh shape. 'box' (default) for platforms and blocks;
     * 'cylinder' lies along local X (rolling logs, blade bars — length =
     * size.x, radius = max(size.y, size.z)/2); 'sphere' for boulders (radius =
     * size.x/2). Ignored when a `mesh` override provides its own visuals (the
     * collider still uses the shape).
     */
    shape?: 'box' | 'cylinder' | 'sphere';
    /** Pause (seconds) at each end of the waypoint run before reversing/looping — crusher telegraphs, piston rests. Default 0. */
    dwellS?: number;
    /** Speed for the BACKWARD leg of a pingpong (toward waypoints[0]). Lets a crusher slam fast (speed) and rise slow (returnSpeed). Defaults to `speed`. */
    returnSpeed?: number;
    /** Pendulum swing mode — see KinematicPlatformPendulum. waypoints[0] is the pivot. */
    pendulum?: KinematicPlatformPendulum | null;
    /**
     * Conveyor belt: the body stays parked but characters STANDING on it are
     * transported at this horizontal velocity (m/s) by the engine's rider
     * carry. Jumping off inherits the belt velocity.
     */
    surfaceVelocity?: { x: number; z: number } | null;
    /**
     * Display name for the creator's editor (becomes mesh.name). Auto-derived
     * from the platform kind when omitted — a selected mechanism must never
     * read as "Unnamed".
     */
    name?: string;
    /**
     * Extra editor-facing metadata merged into mesh.userData (shown in the
     * editor's object inspector): the world-forger feature it came from, the
     * challenge type, where its parameters live, etc.
     */
    editorData?: Record<string, unknown> | null;
}

export const DEFAULT_KINEMATIC_PLATFORM_OPTIONS: KinematicPlatformOptions = {
    waypoints: [],
    speed: 2,
    angularSpeed: 0,
    loop: 'pingpong',
    trigger: 'always',
    keyBindings: { up: null, down: null, toggle: null },
    proximityRadius: 3,
    size: new THREE.Vector3(2, 0.25, 2),
    mesh: null,
};

/**
 * KinematicPlatform — a kinematic rigid body that travels along waypoints,
 * spins about the vertical axis, swings as a pendulum, or carries as a
 * conveyor belt.
 *
 * This is THE mechanism for every physical moving platform/hazard: elevators,
 * lifts, moving platforms, sliding doors, horizontal pushers/pistons
 * (waypoints + `dwellS`), vertical crushers/stompers (vertical waypoints +
 * fast `speed`, slow `returnSpeed`, `dwellS`), spinners/carousels/fire bars
 * (`angularSpeed`, single waypoint), swinging blades/wrecking balls
 * (`pendulum`), rolling logs/boulders (`shape: 'cylinder' | 'sphere'`), and
 * conveyor belts (`surfaceVelocity`). The engine's movement motor carries any
 * character STANDING on a kinematic body, and any kinematic body sweeping
 * INTO a character physically pushes it — so hazards built from this class
 * work with zero game-side physics code. Do NOT move the rider yourself, and
 * never build a moving hazard as a visual-only mesh with a distance check.
 *
 * Call `update(deltaTime)` once per frame from your genre module's update loop, and
 * `dispose()` when the platform is destroyed.
 */
export class KinematicPlatform {
    private readonly engine: EngineLike;
    private readonly body: RAPIER.RigidBody;
    private readonly mesh: THREE.Object3D;
    private readonly waypoints: THREE.Vector3[];
    private speed: number;
    private angularSpeed: number;
    private angle: number = 0;
    private readonly loop: KinematicPlatformLoopMode;
    private readonly trigger: KinematicPlatformTrigger;
    private readonly keyBindings: KinematicPlatformKeyBindings;
    private readonly proximityRadius: number;

    private currentIndex: number = 0;
    private nextIndex: number = 1;
    private segmentProgress: number = 0;
    private forward: boolean = true;
    private finished: boolean = false;
    private autoDrive: boolean = true;
    private keyUpHeld: boolean = false;
    private keyDownHeld: boolean = false;
    private dwellTimer: number = 0;
    private dwellS: number;
    private returnSpeed: number;
    private readonly pendulum: KinematicPlatformPendulum | null; // fields mutable via applyEditableParam
    private readonly conveyorVel: { x: number; z: number } | null;
    private pendTime: number = 0;
    private readonly pendAxis: THREE.Vector3 = new THREE.Vector3();
    private readonly pendQuat: THREE.Quaternion = new THREE.Quaternion();

    private readonly keyDownListener: (e: KeyboardEvent) => void;
    private readonly keyUpListener: (e: KeyboardEvent) => void;
    private readonly worldPos: THREE.Vector3 = new THREE.Vector3();

    constructor(engine: EngineLike, options: KinematicPlatformOptions) {
        const single = options.waypoints.length === 1
            && (options.angularSpeed !== 0 || options.pendulum || options.surfaceVelocity);
        if (options.waypoints.length < 2 && !single) {
            throw new Error('KinematicPlatform requires at least 2 waypoints (or exactly 1 with angularSpeed for a spinner / pendulum for a swing / surfaceVelocity for a conveyor).');
        }
        if (options.pendulum && options.angularSpeed !== 0) {
            throw new Error('KinematicPlatform: pendulum and angularSpeed are mutually exclusive (both drive the body rotation).');
        }
        if (!engine.physicsWorld) {
            throw new Error('KinematicPlatform requires an initialized physicsWorld on the engine.');
        }

        this.engine = engine;
        this.waypoints = options.waypoints.map(v => v.clone());
        this.speed = options.speed;
        this.angularSpeed = options.angularSpeed;
        this.loop = options.loop;
        this.trigger = options.trigger;
        this.keyBindings = options.keyBindings;
        this.proximityRadius = options.proximityRadius;
        this.dwellS = options.dwellS ?? 0;
        this.returnSpeed = options.returnSpeed ?? options.speed;
        this.pendulum = options.pendulum ? { ...options.pendulum } : null;
        this.conveyorVel = options.surfaceVelocity ? { x: options.surfaceVelocity.x, z: options.surfaceVelocity.z } : null;

        // 'key' trigger starts stopped — user must press a key to move it.
        this.autoDrive = this.trigger !== 'key';

        const size = KinematicPlatform.resolveSize(options);
        const shape = options.shape ?? 'box';
        this.mesh = options.mesh ?? KinematicPlatform.buildDefaultMesh(size, shape);

        // Pendulum bobs start at their phase-0 swing position, not at the pivot.
        const start = this.pendulum ? this.bobPosition(0) : this.waypointAt(0);
        this.mesh.position.copy(start);
        engine.scene?.add(this.mesh);

        const RAPIER = getRapier();
        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(start.x, start.y, start.z);
        this.body = engine.physicsWorld.createRigidBody(bodyDesc);

        const colDesc = (
            shape === 'sphere' ? RAPIER.ColliderDesc.ball(size.x * 0.5)
            : shape === 'cylinder' ? RAPIER.ColliderDesc.cylinder(size.x * 0.5, Math.max(size.y, size.z) * 0.5)
                // Rapier cylinders stand along Y; lay it along local X (logs, blade bars).
                .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
            : RAPIER.ColliderDesc.cuboid(size.x * 0.5, size.y * 0.5, size.z * 0.5)
        )
            .setFriction(1.0)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        engine.physicsWorld.createCollider(colDesc, this.body);

        // Conveyor: the rider carry reads this off the body and transports
        // anyone standing on the (otherwise parked) belt.
        if (this.conveyorVel) {
            this.body.userData = { conveyorVel: this.conveyorVel };
        }

        // Self-describing for the creator's editor: a selected mechanism shows
        // its name, kind, and driving parameters instead of "Unnamed"/Scene.
        const kind = this.pendulum ? 'PendulumHazard'
            : options.surfaceVelocity ? 'ConveyorBelt'
            : this.angularSpeed !== 0 ? 'Spinner'
            : 'MovingPlatform';
        this.mesh.name = options.name ?? (this.mesh.name || kind);
        const editorData = { ...(options.editorData ?? {}) };
        // Internal editor plumbing rides in editorData under __-prefixed keys —
        // hoist those out so only human-facing values render in the panel.
        const persistPaths = editorData['__persistPaths'];
        delete editorData['__persistPaths'];
        Object.assign(this.mesh.userData, {
            mechanism: kind,
            source: 'engine:KinematicPlatform',
            speed: this.speed,
            loop: this.loop,
            trigger: this.trigger,
            waypointCount: this.waypoints.length,
            ...(this.angularSpeed !== 0 ? { angularSpeedRad: this.angularSpeed } : {}),
            ...(this.dwellS > 0 ? { dwellS: this.dwellS } : {}),
            ...(this.returnSpeed !== this.speed ? { returnSpeed: this.returnSpeed } : {}),
            ...(this.conveyorVel ? { conveyorVelX: this.conveyorVel.x, conveyorVelZ: this.conveyorVel.z } : {}),
            ...(this.pendulum ? {
                pendulumArmLength: this.pendulum.armLength,
                pendulumPeriodS: this.pendulum.periodS,
                pendulumAmplitudeDeg: this.pendulum.amplitudeDeg,
            } : {}),
            ...editorData,
        });
        // Live-edit contract for the editor's object inspector: which userData
        // keys are editable (with clamp ranges; `display: 'deg'`/`'degPerSec'`
        // means the value is stored in radians but presented in degrees), the
        // mechanism instance to apply edits to, and — for world-forger-built
        // mechanisms — where each parameter persists in world.json. All three
        // are non-enumerable: they are plumbing, not display values, and must
        // never be serialized or postMessaged.
        const editable: Record<string, { min: number; max: number; step: number; display?: 'degPerSec' }> = {
            speed: { min: 0, max: 20, step: 0.1 },
            angularSpeedRad: { min: -8, max: 8, step: 0.05, display: 'degPerSec' },
            dwellS: { min: 0, max: 10, step: 0.1 },
            returnSpeed: { min: 0, max: 20, step: 0.1 },
            ...(this.conveyorVel ? {
                conveyorVelX: { min: -10, max: 10, step: 0.1 },
                conveyorVelZ: { min: -10, max: 10, step: 0.1 },
            } : {}),
            ...(this.pendulum ? {
                pendulumArmLength: { min: 0.5, max: 12, step: 0.1 },
                pendulumPeriodS: { min: 0.3, max: 12, step: 0.1 },
                pendulumAmplitudeDeg: { min: 5, max: 85, step: 1 },
            } : {}),
        };
        Object.defineProperty(this.mesh.userData, '__editable', { value: editable, enumerable: false, configurable: true });
        Object.defineProperty(this.mesh.userData, '__mechanism', { value: this, enumerable: false, configurable: true });
        if (persistPaths) {
            Object.defineProperty(this.mesh.userData, '__persistPaths', { value: persistPaths, enumerable: false, configurable: true });
        }

        this.keyDownListener = (e: KeyboardEvent) => this.onKeyDown(e);
        this.keyUpListener = (e: KeyboardEvent) => this.onKeyUp(e);
        if (this.trigger === 'key') {
            document.addEventListener('keydown', this.keyDownListener);
            document.addEventListener('keyup', this.keyUpListener);
        }
    }

    /** Indexed access that skips the `T | undefined` narrowing from `noUncheckedIndexedAccess`. */
    private waypointAt(index: number): THREE.Vector3 {
        const wp = this.waypoints[index];
        if (!wp) throw new Error(`KinematicPlatform: waypoint index ${index} out of range.`);
        return wp;
    }

    private static resolveSize(options: KinematicPlatformOptions): THREE.Vector3 {
        if (!options.mesh) return options.size.clone();
        const box = new THREE.Box3().setFromObject(options.mesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        // Fall back to configured size along any axis where the mesh has no extent.
        if (size.x <= 0) size.x = options.size.x;
        if (size.y <= 0) size.y = options.size.y;
        if (size.z <= 0) size.z = options.size.z;
        return size;
    }

    private static buildDefaultMesh(size: THREE.Vector3, shape: 'box' | 'cylinder' | 'sphere'): THREE.Mesh {
        const mat = createClassedPartMaterial('metal', { color: 0x888888 });
        if (shape === 'sphere') return new THREE.Mesh(new THREE.SphereGeometry(size.x * 0.5, 20, 14), mat);
        if (shape === 'cylinder') {
            const geom = new THREE.CylinderGeometry(Math.max(size.y, size.z) * 0.5, Math.max(size.y, size.z) * 0.5, size.x, 16);
            geom.rotateZ(Math.PI / 2); // lie along local X, matching the collider
            return new THREE.Mesh(geom, mat);
        }
        return new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    }

    /** Pendulum bob centre for elapsed swing time `t` (waypoints[0] = pivot). */
    private bobPosition(t: number): THREE.Vector3 {
        const p = this.pendulum!;
        const pivot = this.waypointAt(0);
        const theta = (p.amplitudeDeg * Math.PI / 180) * Math.sin((2 * Math.PI * t) / Math.max(0.2, p.periodS) + p.phaseDeg * Math.PI / 180);
        const yaw = p.swingYawDeg * Math.PI / 180;
        const s = Math.sin(theta) * p.armLength;
        return new THREE.Vector3(
            pivot.x + Math.sin(yaw) * s,
            pivot.y - Math.cos(theta) * p.armLength,
            pivot.z + Math.cos(yaw) * s,
        );
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.code === this.keyBindings.up) this.keyUpHeld = true;
        else if (e.code === this.keyBindings.down) this.keyDownHeld = true;
        else if (e.code === this.keyBindings.toggle && !e.repeat) this.autoDrive = !this.autoDrive;
    }

    private onKeyUp(e: KeyboardEvent): void {
        if (e.code === this.keyBindings.up) this.keyUpHeld = false;
        else if (e.code === this.keyBindings.down) this.keyDownHeld = false;
    }

    /**
     * Apply a live edit from the editor's object inspector. `key` must be one
     * of the mesh's `userData.__editable` entries; the value is clamped to the
     * declared range. Returns true when applied. Purely runtime — persistence
     * (for world-forger mechanisms) is the editor's job via `__persistPaths`.
     */
    applyEditableParam(key: string, value: number): boolean {
        if (!Number.isFinite(value)) return false;
        const spec = (this.mesh.userData['__editable'] as Record<string, { min: number; max: number }> | undefined)?.[key];
        if (!spec) return false;
        const v = Math.min(spec.max, Math.max(spec.min, value));
        switch (key) {
            case 'speed': this.speed = v; break;
            case 'returnSpeed': this.returnSpeed = v; break;
            case 'dwellS': this.dwellS = v; break;
            case 'angularSpeedRad':
                if (this.pendulum) return false; // mutually exclusive with the swing
                this.angularSpeed = v;
                break;
            case 'conveyorVelX':
                if (!this.conveyorVel) return false;
                this.conveyorVel.x = v; // shared ref with body.userData — the rider carry sees it live
                break;
            case 'conveyorVelZ':
                if (!this.conveyorVel) return false;
                this.conveyorVel.z = v;
                break;
            case 'pendulumArmLength':
                if (!this.pendulum) return false;
                this.pendulum.armLength = v;
                break;
            case 'pendulumPeriodS':
                if (!this.pendulum) return false;
                this.pendulum.periodS = v;
                break;
            case 'pendulumAmplitudeDeg':
                if (!this.pendulum) return false;
                this.pendulum.amplitudeDeg = v;
                break;
            default:
                return false;
        }
        this.mesh.userData[key] = v; // keep the displayed value in sync
        return true;
    }

    /** Advance the platform along its waypoints / spin / swing. Call once per frame. */
    update(deltaTime: number): void {
        // Pendulum mode replaces waypoint travel entirely: the bob swings below
        // the pivot (waypoints[0]) and tilts with the arm. The queued kinematic
        // pose is what lets the movement motor push characters the blade
        // sweeps through.
        if (this.pendulum) {
            if (this.trigger === 'proximity' && !this.isPlayerInRange()) {
                const t = this.body.translation();
                this.body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
                return;
            }
            this.pendTime += deltaTime;
            const p = this.pendulum;
            const theta = (p.amplitudeDeg * Math.PI / 180)
                * Math.sin((2 * Math.PI * this.pendTime) / Math.max(0.2, p.periodS) + p.phaseDeg * Math.PI / 180);
            const bob = this.bobPosition(this.pendTime);
            const yaw = p.swingYawDeg * Math.PI / 180;
            // Tilt about the horizontal axis perpendicular to the swing plane
            // (sign chosen so the tilt matches the bob's displacement direction).
            this.pendAxis.set(-Math.cos(yaw), 0, Math.sin(yaw));
            this.pendQuat.setFromAxisAngle(this.pendAxis, theta);
            this.body.setNextKinematicTranslation({ x: bob.x, y: bob.y, z: bob.z });
            this.body.setNextKinematicRotation({ x: this.pendQuat.x, y: this.pendQuat.y, z: this.pendQuat.z, w: this.pendQuat.w });
            this.mesh.position.copy(bob);
            this.mesh.quaternion.copy(this.pendQuat);
            return;
        }

        // Spin about Y is independent of waypoint travel. The queued kinematic
        // rotation is what lets the movement motor measure the pose delta and
        // carry riders around.
        if (this.angularSpeed !== 0) {
            this.angle += this.angularSpeed * deltaTime;
            const half = this.angle * 0.5;
            this.body.setNextKinematicRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
            this.mesh.rotation.y = this.angle;
        }

        // End-of-run dwell (crusher telegraph, piston rest) holds the body.
        if (this.dwellTimer > 0) {
            this.dwellTimer -= deltaTime;
            const t = this.body.translation();
            this.body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
            return;
        }

        const drive = this.waypoints.length >= 2 ? this.computeDrive() : 0;
        if (drive === 0) {
            const t = this.body.translation();
            this.body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
            return;
        }

        // Normalize: platform always moves progress 0 → 1 along the current segment.
        // If the caller wants the opposite direction, flip the segment orientation.
        const wantForward = drive > 0;
        if (wantForward !== this.forward) this.flipDirection();

        const segmentLength = this.waypointAt(this.currentIndex).distanceTo(this.waypointAt(this.nextIndex));
        if (segmentLength === 0) {
            this.advanceSegment();
            return;
        }

        // A crusher slams forward at `speed` and recovers at `returnSpeed`.
        const legSpeed = this.forward ? this.speed : this.returnSpeed;
        this.segmentProgress += (legSpeed * deltaTime) / segmentLength;
        while (this.segmentProgress >= 1 && !this.finished && this.dwellTimer <= 0) {
            this.segmentProgress -= 1;
            this.advanceSegment();
        }
        if (this.finished || this.dwellTimer > 0) this.segmentProgress = 0;

        const from = this.waypointAt(this.currentIndex);
        const to = this.waypointAt(this.nextIndex);
        this.worldPos.lerpVectors(from, to, this.segmentProgress);

        this.body.setNextKinematicTranslation({ x: this.worldPos.x, y: this.worldPos.y, z: this.worldPos.z });
        this.mesh.position.copy(this.worldPos);
    }

    /** Returns +1 (forward), -1 (backward), or 0 (stopped) for this frame. */
    private computeDrive(): number {
        if (this.finished) return 0;

        if (this.trigger === 'key') {
            if (this.keyUpHeld) return 1;
            if (this.keyDownHeld) return -1;
            return this.autoDrive ? (this.forward ? 1 : -1) : 0;
        }

        if (this.trigger === 'proximity' && !this.isPlayerInRange()) return 0;

        return this.forward ? 1 : -1;
    }

    private isPlayerInRange(): boolean {
        const player = this.engine.genreModule?.getCurrentPlayer?.();
        const pos: THREE.Vector3 | undefined = player?.position;
        if (!pos) return false;
        const t = this.body.translation();
        const dx = pos.x - t.x;
        const dy = pos.y - t.y;
        const dz = pos.z - t.z;
        return dx * dx + dy * dy + dz * dz <= this.proximityRadius * this.proximityRadius;
    }

    /** Swap current/next and flip progress so the platform now moves the opposite way. */
    private flipDirection(): void {
        const prev = this.currentIndex;
        this.currentIndex = this.nextIndex;
        this.nextIndex = prev;
        this.segmentProgress = 1 - this.segmentProgress;
        this.forward = !this.forward;
    }

    private advanceSegment(): void {
        this.currentIndex = this.nextIndex;
        const last = this.waypoints.length - 1;
        const atEnd = this.forward ? this.currentIndex >= last : this.currentIndex <= 0;

        if (atEnd) {
            if (this.loop === 'loop') {
                this.currentIndex = this.forward ? 0 : last;
            } else if (this.loop === 'pingpong') {
                this.forward = !this.forward;
            } else {
                this.finished = true;
                return;
            }
            if (this.dwellS > 0) this.dwellTimer = this.dwellS;
        }

        this.nextIndex = this.currentIndex + (this.forward ? 1 : -1);
    }

    dispose(): void {
        if (this.trigger === 'key') {
            document.removeEventListener('keydown', this.keyDownListener);
            document.removeEventListener('keyup', this.keyUpListener);
        }
        this.engine.scene?.remove(this.mesh);
        this.engine.physicsWorld?.removeRigidBody(this.body);
    }
}
