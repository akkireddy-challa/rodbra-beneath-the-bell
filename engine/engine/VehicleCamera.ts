import * as THREE from 'three';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * VehicleCamera provides a specialized camera controller for driving vehicles
 * Features smooth following of vehicle direction with inertia and proper distance
 *
 * Terrain handling (see `resolveChasePoint`): the chase point must never end up
 * inside the world. When the ground behind the car would swallow it — a steep
 * hill right behind is the usual case — the camera CLIMBS: same distance to the
 * car, steeper angle, until it has a clear line to the car again. That keeps the
 * car, the way it points and the way out on screen, which a camera buried in the
 * slope does not. Only when NO angle is clear (a tunnel, a garage) does it slide
 * in toward the car instead. The resolve runs on the target AND on the smoothed
 * position, because the smoothing lerp is a straight line and can cut a corner
 * through a hill even when both ends are clear — that second pass is what makes
 * "never underground" a guarantee rather than a tendency. Descending — driving
 * downhill or falling after a jump — lifts the camera so the drop reads on
 * screen.
 */
export class VehicleCamera {
    /**
     * Layers treated as solid world. Baked (`.vwld`) levels register their ENTIRE
     * world — road, hills, tunnels — on ENVIRONMENT (see VxlSceneTerrainSystem /
     * VxlChunkedTerrainSystem); only the legacy procedural voxel world uses
     * TERRAIN. Probing TERRAIN alone therefore hit NOTHING on every baked level,
     * which is exactly where the camera was found sitting inside a ridge. Rival
     * cars (VEHICLE), props (DYNAMIC_PROP) and debris are on other groups, so
     * widening to these two cannot let a passing car shove the view.
     */
    private static readonly WORLD_MASK = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT;

    /**
     * Pitch increments (radians) tried above the resting angle when the world
     * blocks the chase point — roughly +9°, +17°, +29°, +43°, +57°, +74°. Coarse
     * on purpose: this runs only on blocked frames, and the smoothing hides the
     * quantisation.
     */
    private static readonly LIFT_STEPS = [0.15, 0.3, 0.5, 0.75, 1.0, 1.3];

    /** Steepest chase angle (~77°). Beyond this it is a top-down shot and `lookAt` starts to roll. */
    private static readonly MAX_LIFT_PITCH = 1.35;

    /**
     * Frames the view must stay blocked before the camera moves for it (~80 ms).
     *
     * Without this, every fence post, tree and start-arch beam that sweeps
     * through the line for two frames throws the camera metres into the air and
     * drops it back — measured at 3.6 m in a single frame. Terrain the car has
     * driven into stays blocked for as long as the car is there, so the grace
     * costs it nothing: the camera lags its target by far more than 80 ms anyway,
     * so it is still outside the hill when the response kicks in.
     */
    private static readonly OBSTRUCTION_GRACE_FRAMES = 5;

    /**
     * Portrait widening. A three.js `fov` is the VERTICAL angle, so the width of
     * the view is whatever the aspect ratio leaves over: the same camera that
     * shows ~100° across a phone held sideways shows ~30° held upright. Driving
     * needs the sides — the kerb you are about to clip, the car coming up beside
     * you — so on a tall viewport the chase point moves back and the fov opens
     * up, both of which buy horizontal coverage.
     *
     * Ramped, not switched: full effect at `PORTRAIT_ASPECT_FULL` (a phone in
     * portrait) fading to nothing at `PORTRAIT_ASPECT_NONE` (square), so a
     * tablet gets part of it and no aspect produces a jump the player can see.
     * Landscape is untouched — that framing is the one being kept.
     */
    private static readonly PORTRAIT_ASPECT_FULL = 0.6;
    private static readonly PORTRAIT_ASPECT_NONE = 1.0;
    /**
     * Fraction added to the chase distance at full portrait — 0.5 puts an 8 m
     * chase camera 12 m back. Unlike the fov, this keeps paying: the width of
     * the view grows with the distance to it, and the car shrinks only slowly
     * (the fov is opening at the same time, which is what costs car size).
     */
    private static readonly PORTRAIT_DISTANCE_GAIN = 0.5;
    /**
     * Degrees added to the vertical fov at full portrait. Most of what a tall
     * screen gives back comes from here rather than from the distance: at a
     * phone's 0.46 aspect this is worth ~7° across, and it stops paying much
     * past +12 (a further +3° buys 0.4 m of width and shrinks the car again).
     */
    private static readonly PORTRAIT_FOV_GAIN_DEG = 12;

    /**
     * Speed dolly, applied at EVERY aspect. A wide lens reads as fast: the road
     * edges sweep past quicker for the same m/s, which is where the sensation of
     * speed actually comes from. But a wider lens also shrinks the car, and a
     * distant car feels slower, cancelling the effect out.
     *
     * So this is a dolly zoom, not a zoom: the fov opens by
     * `SPEED_FOV_GAIN_DEG` and the whole chase rig — distance behind AND height
     * above — comes in by the ratio of the half-angle tangents, which is exactly
     * the factor that holds the car's on-screen size and the camera's angle
     * where they were. The player keeps the framing and gains the periphery.
     *
     * The ratio is computed from the game's OWN fov rather than baked in, so a
     * game that configures something other than 60° gets the same compensation.
     */
    private static readonly SPEED_FOV_GAIN_DEG = 8;

    private camera: THREE.PerspectiveCamera;
    private target: THREE.Object3D;
    private domElement: HTMLElement;
    private engine: any;

    // Camera settings for vehicle driving
    private distance: number = 8; // Further back than walking camera
    private height: number = 4; // Higher up for better view
    private lookAtHeight: number = 1.5; // Where to look on the vehicle
    
    // Smooth following parameters
    private followSpeed: number = 0.03; // How fast camera follows vehicle direction (lower = more inertia)
    private positionSmoothness: number = 0.08; // How smoothly camera position follows

    /** How fast the look-at point eases toward its target (lower = lazier aim). */
    private lookSmoothness: number = 0.12;
    /**
     * Steering softening. A yaw error at/above this (radians) turns the camera at
     * the full `followSpeed`; smaller errors are scaled down toward
     * `yawMinResponse` so trimming the wheel mid-straight doesn't swing the view.
     * The camera still converges — this damps small corrections, never blocks them.
     */
    private yawSoftZone: number = 0.3;
    private yawMinResponse: number = 0.25;

    /** Minimum metres between the camera and the ground directly below it. */
    private groundClearance: number = 1.0;
    /** Extra height at full descent speed — exaggerates drops and jumps. */
    private descentBoostMax: number = 3.0;
    /** Descent rate (m/s) that earns the full boost. */
    private descentSpeedRef: number = 10;
    /** How fast the descent boost eases in/out. */
    private descentSmoothness: number = 0.06;
    /** Gap kept in front of whatever the pull-in ray hit (> camera near plane). */
    private collisionBuffer: number = 0.35;

    // Current camera state
    private currentYaw: number = 0; // Current camera yaw angle
    private targetYaw: number = 0; // Target yaw angle based on vehicle
    private cameraPosition: THREE.Vector3 = new THREE.Vector3();
    private targetPosition: THREE.Vector3 = new THREE.Vector3();
    private lookAtPosition: THREE.Vector3 = new THREE.Vector3();

    // Derived follow state (see update)
    private smoothedFallSpeed: number = 0;
    private descentBoost: number = 0;
    private prevTargetY: number | null = null;
    /** Ground height under the camera; rises instantly, falls smoothly. */
    private smoothedGroundY: number | null = null;
    /** True while the CAR has no ground beneath it — see `resolveChasePoint`. */
    private rigUnderWorld: boolean = false;
    /** Consecutive frames the resting chase point has been blocked by the world. */
    private blockedFrames: number = 0;
    private lookAtInitialized: boolean = false;
    /** 0 = landscape framing, 1 = full portrait widening. See PORTRAIT_ASPECT_FULL. */
    private portraitFactor: number = 0;
    /** The fov this camera found, restored whenever the widening is not in effect. */
    private baseFov: number | null = null;

    // Scratch vectors — update() runs every frame, so it must not allocate.
    private readonly _vehiclePos = new THREE.Vector3();
    private readonly _vehicleDir = new THREE.Vector3();
    private readonly _rayFrom = new THREE.Vector3();
    private readonly _rayDir = new THREE.Vector3();
    private readonly _desiredLookAt = new THREE.Vector3();
    /** Aim point on the car — the origin every line-of-sight test starts from. */
    private readonly _pivot = new THREE.Vector3();
    /** Where the camera wants to be, before the world gets a say. */
    private readonly _desired = new THREE.Vector3();
    private readonly _losDir = new THREE.Vector3();
    /** Distance to what last blocked the view, filled by `isBlocked`. */
    private _blockDistance: number = 0;
    
    // Mouse control for manual adjustment
    private mouseSensitivity: number = 0.002;
    private mouseX: number = 0;
    private isMouseDown: boolean = false;
    
    // Bound event handlers
    private boundOnMouseDown: (event: MouseEvent) => void;
    private boundOnMouseUp: (event: MouseEvent) => void;
    private boundOnMouseMove: (event: MouseEvent) => void;
    private boundOnContextMenu: (event: Event) => void;
    
    // Enabled state for editor mode integration
    private enabled: boolean = true;

    constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: any = null, sizeScale: number = 1) {
        this.camera = camera;
        this.target = target;
        this.domElement = domElement;
        this.engine = engine;

        // Smaller vehicles get a closer/lower chase camera; sizeScale 1 = default.
        this.distance *= sizeScale;
        this.height *= sizeScale;
        this.lookAtHeight *= sizeScale;
        // Clearance and drop-boost are distances too — a kart wants a smaller
        // lift than a truck, or the boost dwarfs the vehicle.
        this.groundClearance *= sizeScale;
        this.descentBoostMax *= sizeScale;

        // Initialize camera position behind the vehicle
        this.initializeCameraPosition();

        // Bind event handlers
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnContextMenu = (e: Event) => e.preventDefault();

        this.setupEventListeners();
        
        console.log('VehicleCamera: Created and initialized for target:', target.name || 'vehicle');
    }

    setDistance(distance: number): void {
        this.distance = distance;
    }

    setHeight(height: number): void {
        this.height = height;
    }

    setLookAtHeight(height: number): void {
        this.lookAtHeight = height;
    }

    setFollowSpeed(speed: number): void {
        this.followSpeed = speed;
    }

    setPositionSmoothness(smoothness: number): void {
        this.positionSmoothness = smoothness;
    }

    /** How fast the aim point eases toward its target (lower = lazier). */
    setLookSmoothness(smoothness: number): void {
        this.lookSmoothness = smoothness;
    }

    /** Minimum metres the camera keeps above the ground below it. */
    setGroundClearance(clearance: number): void {
        this.groundClearance = clearance;
    }

    /**
     * Extra height (metres) at full descent speed, and the descent rate (m/s)
     * that earns it. Pass 0 to disable the drop exaggeration entirely.
     */
    setDescentBoost(maxHeight: number, speedRef: number = this.descentSpeedRef): void {
        this.descentBoostMax = maxHeight;
        this.descentSpeedRef = Math.max(0.001, speedRef);
    }

    /**
     * Steering softening: yaw errors at/above `softZone` radians turn the camera
     * at full speed, smaller ones are scaled toward `minResponse` (0-1).
     */
    setSteeringSoftening(softZone: number, minResponse: number): void {
        this.yawSoftZone = Math.max(1e-4, softZone);
        this.yawMinResponse = THREE.MathUtils.clamp(minResponse, 0, 1);
    }

    /** The configured chase distance, before the dolly and the portrait widening. */
    getDistance(): number {
        return this.distance;
    }

    /**
     * Chase distance for the framing actually on screen: the configured distance,
     * pulled in by the speed dolly, then pushed back out as the viewport turns
     * tall. Every chase-geometry calculation goes through this rather than
     * `distance`, so `setDistance` keeps meaning what it says and repeated
     * resizes cannot compound.
     */
    private chaseDistance(): number {
        return this.distance
            * (1 + VehicleCamera.PORTRAIT_DISTANCE_GAIN * this.portraitFactor)
            * this.speedDolly();
    }

    /**
     * How much the rig comes in to pay for the widened fov (< 1). Applied to the
     * height above the aim point as well as the distance behind it — pulling in
     * on one axis alone would tilt the camera down into a steeper shot rather
     * than move it along its own view line. See SPEED_FOV_GAIN_DEG.
     */
    private speedDolly(): number {
        const base = this.baseFov ?? this.camera.fov;
        const widened = base + VehicleCamera.SPEED_FOV_GAIN_DEG;
        return Math.tan(THREE.MathUtils.degToRad(base) / 2)
            / Math.tan(THREE.MathUtils.degToRad(widened) / 2);
    }

    /** Height above the aim point, dollied to match. `descentBoost` is an absolute lift and rides on top. */
    private chaseRise(): number {
        return (this.height - this.lookAtHeight) * this.speedDolly() + this.descentBoost;
    }

    /**
     * Re-read the viewport shape and set the fov to match. Runs every frame: the
     * aspect changes when the device rotates or the window resizes, and
     * `GameEngine.onWindowResize` owns `aspect` but not `fov`.
     */
    private syncFraming(): void {
        const { PORTRAIT_ASPECT_FULL: full, PORTRAIT_ASPECT_NONE: none } = VehicleCamera;
        const aspect = this.camera.aspect;
        this.portraitFactor = Number.isFinite(aspect) && aspect > 0
            ? THREE.MathUtils.clamp((none - aspect) / (none - full), 0, 1)
            : 0;

        // Latch the game's own fov the first time through, so restoring it later
        // gives back the value the game chose rather than a widened one. Every
        // widening below is measured from this, never from the live fov.
        if (this.baseFov === null) this.baseFov = this.camera.fov;

        const fov = this.baseFov
            + VehicleCamera.SPEED_FOV_GAIN_DEG
            + VehicleCamera.PORTRAIT_FOV_GAIN_DEG * this.portraitFactor;
        if (Math.abs(this.camera.fov - fov) > 1e-4) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
    }

    /**
     * Hand the fov back as it was found. The chase camera is disposed when the
     * player leaves the vehicle, and the on-foot camera reads the fov it
     * inherits as its own baseline — leaving a widened one behind would make
     * the widening permanent, growing every time the player drives.
     */
    private restoreFov(): void {
        if (this.baseFov === null) return;
        if (Math.abs(this.camera.fov - this.baseFov) > 1e-4) {
            this.camera.fov = this.baseFov;
            this.camera.updateProjectionMatrix();
        }
        this.baseFov = null;
    }

    getHeight(): number {
        return this.height;
    }

    private initializeCameraPosition(): void {
        // Ensure the target's world matrix is up-to-date before reading position/direction.
        // During vehicle switching the chassis object may not have been rendered yet this frame.
        this.target.updateWorldMatrix(true, false);

        // Get vehicle's current rotation
        const vehicleDirection = new THREE.Vector3();
        this.target.getWorldDirection(vehicleDirection);

        // Calculate initial yaw from vehicle direction
        this.currentYaw = Math.atan2(vehicleDirection.x, vehicleDirection.z);
        this.targetYaw = this.currentYaw;

        // Reset follow state — a fresh vehicle must not inherit the previous
        // one's fall speed, boost or ground sample.
        this.smoothedFallSpeed = 0;
        this.descentBoost = 0;
        this.prevTargetY = null;
        this.smoothedGroundY = null;
        this.rigUnderWorld = false;
        this.blockedFrames = 0;
        this.lookAtInitialized = false;

        // Snap camera directly to the correct position behind the vehicle
        // (no lerp — avoids starting at origin and slowly drifting out).
        // The snap ignores the world, so entering a vehicle facing up a slope (or
        // respawning against a bank) would place the camera INSIDE the hill on
        // frame one. Seed the floor and resolve straight away — a snap has no
        // transient to ride out, so it skips the obstruction grace period.
        const vehiclePos = new THREE.Vector3();
        this.target.getWorldPosition(vehiclePos);
        this._pivot.set(vehiclePos.x, vehiclePos.y + this.lookAtHeight, vehiclePos.z);

        this.syncFraming();
        const chaseDistance = this.chaseDistance();
        const rise = this.chaseRise();
        const radius = Math.hypot(chaseDistance, rise);
        const restingPitch = Math.atan2(rise, chaseDistance);

        this.updateRigUnderWorld(vehiclePos);
        this.chasePointAt(this._pivot, radius, restingPitch, this._desired);
        this.updateGroundFloor(this._desired, 0);
        const pitch = Math.min(
            VehicleCamera.MAX_LIFT_PITCH,
            Math.max(restingPitch, this.pitchForClearance(this._pivot.y, radius)),
        );
        this.resolveChasePoint(this._pivot, radius, pitch, this.cameraPosition);
        this.applyGroundClearance(this.cameraPosition);
        this.camera.position.copy(this.cameraPosition);
    }

    private setupEventListeners(): void {
        // Optional: Allow some mouse control for camera adjustment while driving
        this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
        this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
        this.domElement.addEventListener('mousemove', this.boundOnMouseMove);
        this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
    }

    private onMouseDown(event: MouseEvent): void {
        if (event.button === 0) { // Left mouse button
            this.isMouseDown = true;
            this.mouseX = event.clientX;
            this.domElement.style.cursor = 'grabbing';
        }
    }

    private onMouseUp(event: MouseEvent): void {
        if (event.button === 0) {
            this.isMouseDown = false;
            this.domElement.style.cursor = 'grab';
        }
    }

    private onMouseMove(event: MouseEvent): void {
        if (!this.isMouseDown) return;

        const deltaX = event.clientX - this.mouseX;

        // Allow small manual camera adjustments while driving
        this.currentYaw += deltaX * this.mouseSensitivity * 0.5; // Reduced sensitivity for driving

        this.mouseX = event.clientX;
    }

    /**
     * Enable or disable the camera (for editor mode integration)
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.isMouseDown = false;
            this.domElement.style.cursor = 'default';
            // Whoever takes the camera over (the debug free-fly cam) gets it with
            // the game's own fov. `update` re-latches and re-widens on re-enable.
            this.restoreFov();
        }
    }

    public update(deltaTime: number): void {
        if (!this.enabled) return;

        if (!this.target) {
            console.warn('VehicleCamera: No target to follow');
            return;
        }

        // Set the fov first: the dolly that pays for it, and everything else
        // below, is derived from the fov actually in effect this frame.
        this.syncFraming();

        // Get vehicle's current direction
        this.target.getWorldDirection(this._vehicleDir);

        // Calculate target yaw from vehicle direction
        this.targetYaw = Math.atan2(this._vehicleDir.x, this._vehicleDir.z);

        // Frame-rate independent smooth interpolation towards vehicle direction with
        // inertia (exponential decay: factor = 1 - exp(-rate * deltaTime)). The rate
        // is scaled down for SMALL yaw errors so trimming the wheel on a straight
        // doesn't whip the view around — the car turns first, the camera follows.
        const yawDiff = this.normalizeAngle(this.targetYaw - this.currentYaw);
        const softness = THREE.MathUtils.clamp(Math.abs(yawDiff) / this.yawSoftZone, 0, 1);
        const yawRate = this.followSpeed * (this.yawMinResponse + (1 - this.yawMinResponse) * softness);
        const yawBlendFactor = 1 - Math.exp(-yawRate * 60 * deltaTime);
        this.currentYaw += yawDiff * yawBlendFactor;
        this.currentYaw = this.normalizeAngle(this.currentYaw);

        // Update camera position and look-at (passing deltaTime for frame-rate independence)
        this.updateCameraPosition(deltaTime);
        this.updateLookAt(deltaTime);
    }

    /**
     * Track how fast the vehicle is dropping and convert it into extra camera
     * height. Covers driving downhill AND falling after a jump — both read as
     * "going down", and lifting the camera is what sells the drop.
     */
    private updateDescentBoost(vehicleY: number, deltaTime: number): void {
        if (deltaTime > 1e-4) {
            const rawFallSpeed = this.prevTargetY === null
                ? 0
                : (vehicleY - this.prevTargetY) / deltaTime;
            // Filter the per-frame delta hard: suspension jitter is not a descent.
            const fallBlend = 1 - Math.exp(-8 * deltaTime);
            this.smoothedFallSpeed += (rawFallSpeed - this.smoothedFallSpeed) * fallBlend;
        }
        this.prevTargetY = vehicleY;

        const descent = Math.max(0, -this.smoothedFallSpeed);
        const targetBoost = this.descentBoostMax
            * THREE.MathUtils.clamp(descent / this.descentSpeedRef, 0, 1);
        const boostBlend = 1 - Math.exp(-this.descentSmoothness * 60 * deltaTime);
        this.descentBoost += (targetBoost - this.descentBoost) * boostBlend;
    }

    /** Metres a ground probe reaches. */
    private static readonly GROUND_PROBE_REACH = 250;

    /**
     * Does the CAR have ground beneath it? Everything else keys off this: a car
     * with ground under it is in the world, wherever the camera has drifted to.
     * No physics world (yet) counts as "under the world" — nothing can be
     * concluded from rays that cannot be cast.
     */
    private updateRigUnderWorld(vehiclePos: THREE.Vector3): void {
        const physicsWorld = this.engine?.physicsWorld;
        if (!physicsWorld?.raycast) {
            this.rigUnderWorld = true;
            return;
        }
        this._rayFrom.copy(vehiclePos);
        this._rayDir.set(0, -1, 0);
        const hit = physicsWorld.raycast(
            this._rayFrom, this._rayDir, VehicleCamera.GROUND_PROBE_REACH, VehicleCamera.WORLD_MASK,
        );
        this.rigUnderWorld = !hit?.hasHit;
    }

    /**
     * Ground height under `point`, or null when there is nothing below it (or no
     * physics world).
     *
     * The probe starts AT the point and looks down — never from a fixed height
     * above it. A probe that starts overhead reports the roof of a tunnel or the
     * deck of a bridge as "ground" and the clamp then shoves the camera up
     * through it, which is worse than the problem it solves.
     */
    private sampleGroundY(point: THREE.Vector3): number | null {
        const physicsWorld = this.engine?.physicsWorld;
        if (!physicsWorld?.raycast) return null;

        const reach = VehicleCamera.GROUND_PROBE_REACH;

        // 1. The normal case — the surface the camera is flying over.
        this._rayFrom.copy(point);
        this._rayDir.set(0, -1, 0);
        const below = physicsWorld.raycast(this._rayFrom, this._rayDir, reach, VehicleCamera.WORLD_MASK);
        if (below?.hasHit) return below.hitPoint.y;

        // 2. Nothing below the camera, but the car is still in the world: the
        //    camera is merely out over a drop — a jump, a bridge, the edge of the
        //    map — so there is no new floor to report and the last one keeps
        //    holding.
        if (!this.rigUnderWorld) return null;

        // 3. Neither has ground below: the whole rig is under the world. Only then
        //    does the surface ABOVE count as the floor to climb back to — a
        //    downward ray can never see it, so without this the clamp goes blind
        //    exactly when it is needed most.
        this._rayFrom.copy(point);
        this._rayDir.set(0, 1, 0);
        const above = physicsWorld.raycast(this._rayFrom, this._rayDir, reach, VehicleCamera.WORLD_MASK);
        return above?.hasHit ? above.hitPoint.y : null;
    }

    /**
     * Track the ground under `point` in `smoothedGroundY`: rises take effect at
     * once (clipping into a bank is never acceptable), falls ease out so cresting
     * a ridge doesn't drop the camera like a stone. A frame whose probe finds
     * nothing KEEPS the last floor — switching the clamp off on a missed sample is
     * what used to let the camera sink and stay sunk.
     */
    private updateGroundFloor(point: THREE.Vector3, deltaTime: number): void {
        const groundY = this.sampleGroundY(point);
        if (groundY === null) return;
        if (this.smoothedGroundY === null || groundY > this.smoothedGroundY) {
            this.smoothedGroundY = groundY;
        } else {
            const groundBlend = 1 - Math.exp(-3 * deltaTime);
            this.smoothedGroundY += (groundY - this.smoothedGroundY) * groundBlend;
        }
    }

    /** Lift `point` to the last known floor plus clearance. No floor known = no clamp. */
    private applyGroundClearance(point: THREE.Vector3): void {
        if (this.smoothedGroundY === null) return;
        const minY = this.smoothedGroundY + this.groundClearance;
        if (point.y < minY) point.y = minY;
    }

    /** Write the chase point at `pitch` radians above the aim point into `out`. */
    private chasePointAt(pivot: THREE.Vector3, radius: number, pitch: number, out: THREE.Vector3): void {
        const flat = Math.cos(pitch) * radius;
        out.set(
            pivot.x - Math.sin(this.currentYaw) * flat,
            pivot.y + Math.sin(pitch) * radius,
            pivot.z - Math.cos(this.currentYaw) * flat,
        );
    }

    /**
     * Lowest pitch that keeps `groundClearance` between the camera and the last
     * known floor, or 0 when the resting angle already clears it.
     *
     * Clearance is an ANGLE here, never a shove straight up. Raising the pitch
     * keeps the car exactly as far away (the framing the game asked for) and
     * swings the camera horizontally CLOSER to it — driving downhill that means
     * lower ground, so the clamp converges. Shoving the point up instead samples
     * the floor further up the slope behind, lifts again, and walks the camera
     * off into the sky: measured at 27 m above the car and 30 m behind it on a
     * sustained 1.5:1 descent.
     */
    private pitchForClearance(pivotY: number, radius: number): number {
        if (this.smoothedGroundY === null || radius < 1e-4) return 0;
        const rise = this.smoothedGroundY + this.groundClearance - pivotY;
        if (rise <= 0) return 0;
        return Math.asin(Math.min(1, rise / radius));
    }

    /**
     * Has the resting chase point been blocked long enough to move the camera for
     * it? Counts consecutive blocked frames (see `OBSTRUCTION_GRACE_FRAMES`) so a
     * post or an arch sweeping through the line for a couple of frames is ignored
     * while a hill the car drove into is not.
     */
    private updateObstruction(pivot: THREE.Vector3, desired: THREE.Vector3): boolean {
        // A hit at zero distance means the pivot is inside a collider, and a car
        // under the world has no clear line anywhere — see `resolveChasePoint`.
        const blocked = !this.rigUnderWorld
            && this.isBlocked(pivot, desired)
            && this._blockDistance > 1e-3;
        this.blockedFrames = blocked ? this.blockedFrames + 1 : 0;
        return this.blockedFrames >= VehicleCamera.OBSTRUCTION_GRACE_FRAMES;
    }

    /**
     * Is the straight line from `pivot` (a point on the car) to `point` blocked by
     * the world? Fills `_losDir` (unit) and `_blockDistance` so the caller can
     * slide back along the same ray. No physics world means nothing blocks.
     */
    private isBlocked(pivot: THREE.Vector3, point: THREE.Vector3): boolean {
        const physicsWorld = this.engine?.physicsWorld;
        if (!physicsWorld?.raycast) return false;

        this._losDir.subVectors(point, pivot);
        const distance = this._losDir.length();
        this._blockDistance = distance;
        if (distance < 1e-4) return false;
        this._losDir.divideScalar(distance);

        const hit = physicsWorld.raycast(pivot, this._losDir, distance, VehicleCamera.WORLD_MASK);
        if (!hit?.hasHit) return false;
        this._blockDistance = hit.hitDistance;
        return true;
    }

    /**
     * Write into `out` a chase point the world does not block, starting from the
     * one at `startPitch`.
     *
     * If the line from the car to that point is clear, it is the answer. If it is
     * not, the point is RAISED — same distance to the car, steeper angle, in
     * steps, until the line clears. A steep hill right behind the car therefore
     * pushes the camera UP the slope rather than into it, and the player keeps
     * seeing the car and where its nose points. Pulling in toward the car instead
     * keeps the same low angle and can still end up inside the hill, so it is the
     * LAST resort here — used only when even the steepest angle is blocked
     * (inside a tunnel, under a low roof), where sliding in along the resting line
     * lands in open space on the car's side by construction.
     */
    private resolveChasePoint(pivot: THREE.Vector3, radius: number, startPitch: number, out: THREE.Vector3): void {
        this.chasePointAt(pivot, radius, startPitch, out);
        if (!this.engine?.physicsWorld?.raycast) return;
        // With the car itself under the world (fallen through a hole, off the edge
        // of the map) every clear line from it is ALSO under the world, so this
        // would happily confirm a buried camera. The ground clamp is the only
        // authority worth listening to there — leave the point alone.
        if (this.rigUnderWorld) return;
        if (!this.isBlocked(pivot, out)) return;
        // A hit at zero distance means the pivot is inside a collider (spawned in
        // a wall, tunnelled through a barrier). Sliding "back to open space" from
        // there lands on the car itself, so leave the point alone as well.
        if (this._blockDistance <= 1e-3) return;

        for (const step of VehicleCamera.LIFT_STEPS) {
            const pitch = Math.min(startPitch + step, VehicleCamera.MAX_LIFT_PITCH);
            this.chasePointAt(pivot, radius, pitch, out);
            if (!this.isBlocked(pivot, out)) return;
            if (pitch >= VehicleCamera.MAX_LIFT_PITCH) break;
        }

        // Nothing overhead is clear either — slide in along the resting line.
        this.chasePointAt(pivot, radius, startPitch, out);
        this.pullInIfBlocked(pivot, out);
    }

    /**
     * When the world blocks the view of the car from `point`, move `point` in
     * along that same line to just short of what it hit — open space on the car's
     * side by construction. Used as the last resort of `resolveChasePoint`, and on
     * the SMOOTHED position, whose straight-line lerp can cut a corner through a
     * hill even when both ends of it are clear.
     */
    private pullInIfBlocked(pivot: THREE.Vector3, point: THREE.Vector3): void {
        if (this.rigUnderWorld) return;
        if (!this.isBlocked(pivot, point)) return;
        if (this._blockDistance <= 1e-3) return;
        const allowed = Math.max(0, this._blockDistance - this.collisionBuffer);
        point.copy(pivot).addScaledVector(this._losDir, allowed);
    }

    private normalizeAngle(angle: number): number {
        // Normalize angle to [-π, π] range
        while (angle > Math.PI) angle -= 2 * Math.PI;
        while (angle < -Math.PI) angle += 2 * Math.PI;
        return angle;
    }

    private updateCameraPosition(deltaTime: number): void {
        // Get vehicle position
        const vehiclePos = this._vehiclePos;
        this.target.getWorldPosition(vehiclePos);

        this.updateDescentBoost(vehiclePos.y, deltaTime);
        this.updateRigUnderWorld(vehiclePos);
        this._pivot.set(vehiclePos.x, vehiclePos.y + this.lookAtHeight, vehiclePos.z);

        // The chase point as a distance and an angle from the aim point on the
        // car: `distance` behind it, `height` above it, plus the descent boost so
        // drops and jumps open the view up. Only the ANGLE ever changes below —
        // keeping the radius fixed is what stops the camera drifting away from the
        // car while it works around the terrain.
        const chaseDistance = this.chaseDistance();
        const rise = this.chaseRise();
        const radius = Math.hypot(chaseDistance, rise);
        const restingPitch = Math.atan2(rise, chaseDistance);
        const pitch = Math.min(
            VehicleCamera.MAX_LIFT_PITCH,
            Math.max(restingPitch, this.pitchForClearance(this._pivot.y, radius)),
        );
        this.chasePointAt(this._pivot, radius, pitch, this._desired);

        // Climb over — or, failing that, pull in past — whatever the world puts
        // between the car and that point.
        const obstructed = this.updateObstruction(this._pivot, this._desired);
        if (obstructed) {
            this.resolveChasePoint(this._pivot, radius, pitch, this.targetPosition);
        } else {
            this.targetPosition.copy(this._desired);
        }

        // Re-read the floor UNDER THE POINT WE PICKED, not under the one we asked
        // for: a climb ends up over different ground, and next frame's clearance
        // angle is only as good as the floor it is derived from.
        this.updateGroundFloor(this.targetPosition, deltaTime);

        // Frame-rate independent smooth camera position movement
        const positionBlendFactor = 1 - Math.exp(-this.positionSmoothness * 60 * deltaTime);
        this.cameraPosition.lerp(this.targetPosition, positionBlendFactor);

        // Final guarantee: never underground, on the position actually rendered.
        // Two passes, in this order:
        //   1. The floor, because the smoothing can lag behind fast-rising ground.
        //      It clamps on the LAST KNOWN ground, not only on a fresh sample — a
        //      missed probe (a hole in the collider, off the edge of the map) that
        //      switched the clamp off is what used to make being underground STICK.
        //   2. The line to the car, which gets the last word: the lerp above
        //      travels in a straight line and can pass through a hill even when
        //      both ends are clear, and no vertical clamp can see that.
        this.applyGroundClearance(this.cameraPosition);
        if (obstructed) this.pullInIfBlocked(this._pivot, this.cameraPosition);

        this.camera.position.copy(this.cameraPosition);
    }

    private updateLookAt(deltaTime: number): void {
        // Look at a point slightly ahead of the vehicle. The "ahead" offset uses the
        // SMOOTHED camera yaw, not the vehicle's live heading: aiming off the live
        // heading swung the view the instant the wheel moved, which is what made
        // small corrections feel like the camera was snapping around.
        const vehiclePos = this._vehiclePos;
        this.target.getWorldPosition(vehiclePos);

        this._desiredLookAt.set(
            vehiclePos.x + Math.sin(this.currentYaw) * 2,
            vehiclePos.y + this.lookAtHeight,
            vehiclePos.z + Math.cos(this.currentYaw) * 2,
        );

        // Ease the aim point itself so bumps, kerbs and steering trim don't jitter
        // the view; on the first frame adopt it outright (no swing in from origin).
        if (!this.lookAtInitialized) {
            this.lookAtPosition.copy(this._desiredLookAt);
            this.lookAtInitialized = true;
        } else {
            const lookBlend = 1 - Math.exp(-this.lookSmoothness * 60 * deltaTime);
            this.lookAtPosition.lerp(this._desiredLookAt, lookBlend);
        }

        this.camera.lookAt(this.lookAtPosition);
    }

    /**
     * Set new target vehicle
     */
    public setTarget(newTarget: THREE.Object3D): void {
        this.target = newTarget;
        this.initializeCameraPosition();
    }

    /**
     * Get current target
     */
    public getTarget(): THREE.Object3D {
        return this.target;
    }

    /**
     * Adjust camera settings for different driving scenarios
     */
    public setCameraSettings(distance?: number, height?: number, followSpeed?: number): void {
        if (distance !== undefined) this.distance = distance;
        if (height !== undefined) this.height = height;
        if (followSpeed !== undefined) this.followSpeed = followSpeed;
    }

    /**
     * Get forward vector for movement calculations (not used in vehicle mode)
     */
    public getForwardVector(): THREE.Vector3 {
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        return forward;
    }

    /**
     * Get right vector for movement calculations (not used in vehicle mode)
     */
    public getRightVector(): THREE.Vector3 {
        const forward = this.getForwardVector();
        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
        right.normalize();
        return right;
    }

    /**
     * Get the camera instance
     * @returns The Three.js PerspectiveCamera
     */
    public getCamera(): THREE.PerspectiveCamera {
        return this.camera;
    }

    /**
     * Clean up event listeners
     */
    public dispose(): void {
        this.restoreFov();
        this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
        this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
        this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
        this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
    }
}
