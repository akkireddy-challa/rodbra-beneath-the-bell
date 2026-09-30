import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { ICameraController, CameraMode } from 'engine/ICameraController.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { RaycastResult } from 'engine/physics/PhysicsWorld.js';

export class ThirdPersonCamera implements ICameraController {
	camera: THREE.PerspectiveCamera;
	target: THREE.Object3D;
	domElement: HTMLElement;
	engine: EngineLike;
	// Camera settings
	distance: number;
	minDistance: number;
	maxDistance: number;
	height: number;
	lookAtHeight: number;
	rotationSpeed: number;
	smoothness: number;
	// State
	spherical: THREE.Spherical;
	targetSpherical: THREE.Spherical;
	isMouseDown: boolean;
	mouseX: number;
	mouseY: number;
	enabled: boolean;
	offset: THREE.Vector3;
	lookAtPosition: THREE.Vector3;

	// Lateral shoulder offset applied after spherical offset — for over-the-shoulder
	// framing without having to patch the spherical math per-game.
	public shoulderOffsetRight: number = 0;
	public shoulderOffsetUp: number = 0;

	// Bound event handler references for proper cleanup
	private boundOnMouseDown: (event: MouseEvent) => void;
	private boundOnMouseUp: (event: MouseEvent) => void;
	private boundOnMouseMove: (event: MouseEvent) => void;
	private boundOnDocumentMouseMove: (event: MouseEvent) => void;
	private boundOnTouchStart: (event: TouchEvent) => void;
	private boundOnTouchEnd: (event: TouchEvent) => void;
	private boundOnTouchMove: (event: TouchEvent) => void;
	private boundOnWheel: (event: WheelEvent) => void;
	private boundOnContextMenu: (event: Event) => void;

	// camera y jitter smoothing (legacy anchor model — walking & non-chase games).
	private static readonly DEFAULT_FOLLOW_HALF_LIFE = 0.08;
	private anchor = new THREE.Vector3();
	private anchorInitialized = false;
	private followHalfLife = ThirdPersonCamera.DEFAULT_FOLLOW_HALF_LIFE; // seconds; tune 0.06–0.15
	private verticalDeadzone = 0.02; // meters; ignore tiny vertical jitter

	// Chase-damping mode (opt-in; used by the ski/snowboard chase cam). When set,
	// update() decomposes the follow into two filters: the "follow point" (player
	// position) is SmoothDamped in world space — vertical hard so terrain bumps
	// don't pump the frame, horizontal moderate so turning stays responsive — and
	// the ORBIT (elevation/distance) eases in angular space so pitch never jumps.
	// The camera = dampedFollowPoint + offset(smoothedOrbit). Filtering the orbit
	// in its own space (not the final world position) avoids distorting the arc
	// when the elevation changes, which otherwise reads as a sudden look-down.
	// null = legacy anchor model (every other game).
	private chaseDamping: { horizontal: number; vertical: number; orbit: number } | null = null;
	private followCenter = new THREE.Vector3();   // SmoothDamped "real" follow point
	private followVel = new THREE.Vector3();        // SmoothDamp velocity (follow point)
	private chaseInitialized = false;

	// Camera-collision raycast mask. Default hits terrain + environment props;
	// chase cams narrow this to terrain only so the camera never snaps in/out as
	// trees and rocks pass between it and the player.
	private static readonly DEFAULT_COLLISION_MASK = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT;
	private collisionMask: number = ThirdPersonCamera.DEFAULT_COLLISION_MASK;

	// Speed-driven FOV (chase cams). baseFov captures the camera's configured fov
	// the first time an offset is set; clearFovOffset eases back to it and releases.
	private baseFov: number | null = null;
	private targetFov: number | null = null;
	private fovSmoothHalfLife = 0.2; // seconds
	
	// Camera shake for weapon fire effects
	private shakeIntensity: number = 0;
	private shakeDecayRate: number = 12; // How fast shake decays per second
	private shakeThetaOffset: number = 0;
	private shakePhiOffset: number = 0;

	// Auto-follow camera (mobile follow, ski/vehicle chase cams)
	private autoFollowEnabled: boolean = false;
	private autoFollowSpeed: number = 2.0;
	private targetForwardDirection: THREE.Vector3 | null = null;
	/**
	 * External orbit drive: a gameplay system (ski chase cam, cinematics)
	 * owns the orbit completely. ALL manual rotation/zoom input and the
	 * auto-follow are ignored; targets arrive via driveOrbit().
	 */
	private externalOrbitDrive: boolean = false;
	/** Manual orbit pauses auto-follow until this timestamp (ms). */
	private manualOverrideUntilMs: number = 0;
	/** How long after the last manual orbit before auto-follow resumes. */
	private static readonly AUTO_FOLLOW_RESUME_DELAY_MS = 1200;
	/**
	 * Pitch-follow elevation = slope * CLEAR_FACTOR + BASE. The factor MUST
	 * exceed 1: behind a descending target is uphill terrain, and an orbit
	 * elevated less than the slope angle sits inside the hill — collision
	 * can only pin it against the surface at near-plane distance. Riding
	 * above the slope line keeps the run and the player framed (SSX style).
	 */
	private static readonly PITCH_SLOPE_CLEAR_FACTOR = 1.15;
	/** Extra elevation above the slope line (rad, ~8 degrees). */
	private static readonly PITCH_BASE_ELEVATION = 0.14;
	/** Pitch-follow polar clamp: from well above to slightly below horizon. */
	private static readonly PITCH_FOLLOW_MIN_PHI = 0.35;
	private static readonly PITCH_FOLLOW_MAX_PHI = Math.PI / 2 + 0.35;
	
	// Disable built-in touch handlers (when using external mobile controls)
	public disableBuiltInTouchControls: boolean = false;

	// Disable built-in mouse handlers (for templates that need custom mouse behavior)
	public disableBuiltInMouseControls: boolean = false;
	
	// Pointer lock mode (for PC gameplay)
	private pointerLocked: boolean = false;
	private pointerLockSupported: boolean = false;
	
	// Editor mode - when true, use click-and-drag instead of pointer lock
	private editorModeCamera: boolean = false;

	// Pre-allocated temp objects to avoid per-frame heap allocations
	private _tempTargetWorld = new THREE.Vector3();
	private _tempShakenSpherical = new THREE.Spherical();
	private _tempDesiredCameraPos = new THREE.Vector3();
	private _tempRayFrom = new THREE.Vector3();
	private _tempRayDirection = new THREE.Vector3();
	private _tempAdjustedOffset = new THREE.Vector3();
	private _tempToHit = new THREE.Vector3();
	private _tempSafeCameraPos = new THREE.Vector3();
	private _tempRayDirScaled = new THREE.Vector3();
	private _tempForward = new THREE.Vector3();
	private _tempRight = new THREE.Vector3();
	private _tempUp = new THREE.Vector3(0, 1, 0);
	private _tempShoulderNudge = new THREE.Vector3();
	private _tempShoulderUp = new THREE.Vector3();
	private _cameraRayResult: RaycastResult = {
		hasHit: false,
		hitPoint: new THREE.Vector3(),
		hitNormal: new THREE.Vector3(),
		hitDistance: Infinity,
		hitCollider: null,
		hitRigidBody: null
	};

	constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: any = null) {
		this.camera = camera;
		this.target = target;
		this.domElement = domElement;
		this.engine = engine;

		this.distance = 4; // Close camera for good view of player and splat
		this.minDistance = 1.5;
		this.maxDistance = 15;
		this.height = 3;
		this.lookAtHeight = 0.9;
		this.rotationSpeed = 0.006;
		this.smoothness = 0.1;

		this.spherical = new THREE.Spherical(this.distance, Math.PI / 2.3, 0);
		this.targetSpherical = new THREE.Spherical(this.distance, Math.PI / 2.3, 0);
		this.isMouseDown = false;
		this.mouseX = 0;
		this.mouseY = 0;
		this.enabled = true;
		this.offset = new THREE.Vector3();
		this.lookAtPosition = new THREE.Vector3();

		// Bind event handlers once to maintain consistent references
		this.boundOnMouseDown = this.onMouseDown.bind(this);
		this.boundOnMouseUp = this.onMouseUp.bind(this);
		this.boundOnMouseMove = this.onMouseMove.bind(this);
		this.boundOnDocumentMouseMove = this.onDocumentMouseMove.bind(this);
		this.boundOnTouchStart = this.onTouchStart.bind(this);
		this.boundOnTouchEnd = this.onTouchEnd.bind(this);
		this.boundOnTouchMove = this.onTouchMove.bind(this);
		this.boundOnWheel = this.onWheel.bind(this);
		this.boundOnContextMenu = (e: Event) => e.preventDefault();

		this.setupEventListeners();
		this.update(0);
	}

	setupEventListeners(): void {
		this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.addEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.addEventListener('touchstart', this.boundOnTouchStart);
		this.domElement.addEventListener('touchend', this.boundOnTouchEnd);
		this.domElement.addEventListener('touchmove', this.boundOnTouchMove);
		this.domElement.addEventListener('wheel', this.boundOnWheel);
		this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
		
		// Listen on document for pointer lock mouse events (pointer lock events go to document)
		document.addEventListener('mousemove', this.boundOnDocumentMouseMove);
	}

	shouldProcessInput(): boolean {
		// If pointer lock is active, always allow input - more reliable than window focus tracking
		if (document.pointerLockElement) return true;
		
		if (this.engine && !this.engine.isWindowFocused) return false;
		if (this.engine && this.engine.editorManager && this.engine.editorManager.isEditorMode) return false;
		return true;
	}

	onMouseDown(event: MouseEvent): void {
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.disableBuiltInMouseControls) return;
		// In pointer lock mode (non-editor), mouse down is handled differently (no drag needed)
		// In editor mode, use click-and-drag regardless of pointer lock support
		if (!this.editorModeCamera && (this.pointerLocked || this.pointerLockSupported)) return;
		if (event.button === 0) {
			this.isMouseDown = true;
			this.mouseX = event.clientX;
			this.mouseY = event.clientY;
			(this.domElement as HTMLElement).style.cursor = 'grabbing';
		}
	}

	onMouseUp(event: MouseEvent): void {
		// In pointer lock mode (non-editor), mouse up is not relevant for camera
		// In editor mode, use click-and-drag regardless of pointer lock support
		if (!this.editorModeCamera && (this.pointerLocked || this.pointerLockSupported)) return;
		if (event.button === 0) {
			this.isMouseDown = false;
			(this.domElement as HTMLElement).style.cursor = 'grab';
		}
	}

	onMouseMove(event: MouseEvent): void {
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.disableBuiltInMouseControls) return;
		
		// Pointer lock mode is handled by onDocumentMouseMove
		if (this.pointerLocked) return;
		
		// Fallback: click-and-drag mode
		if (this.externalOrbitDrive) return;
		if (!this.isMouseDown) return;
		const deltaX = event.clientX - this.mouseX;
		const deltaY = event.clientY - this.mouseY;
		this.targetSpherical.theta -= deltaX * this.rotationSpeed;
		this.targetSpherical.phi -= deltaY * this.rotationSpeed;
		this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
		if (deltaX !== 0 || deltaY !== 0) this.markManualOrbit();
	}
	
	/**
	 * Handle document-level mouse move for pointer lock mode
	 * Pointer lock events are dispatched to document, not the canvas element
	 */
	onDocumentMouseMove(event: MouseEvent): void {
		// Only process in pointer lock mode
		if (!this.pointerLocked) return;
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.disableBuiltInMouseControls) return;
		if (this.externalOrbitDrive) return;
		
		const deltaX = event.movementX || 0;
		const deltaY = event.movementY || 0;
		this.targetSpherical.theta -= deltaX * this.rotationSpeed;
		this.targetSpherical.phi -= deltaY * this.rotationSpeed;
		this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
		if (deltaX !== 0 || deltaY !== 0) this.markManualOrbit();
	}

	onTouchStart(event: TouchEvent): void {
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.disableBuiltInTouchControls) return;
		if (event.touches.length === 1 && event.touches[0]) {
			event.preventDefault();
			this.isMouseDown = true;
			this.mouseX = event.touches[0].clientX;
			this.mouseY = event.touches[0].clientY;
		}
	}

	onTouchEnd(_event: TouchEvent): void {
		this.isMouseDown = false;
	}

	onTouchMove(event: TouchEvent): void {
		if (!this.enabled || !this.isMouseDown || event.touches.length !== 1 || !event.touches[0]) return;
		if (!this.shouldProcessInput()) return;
		if (this.disableBuiltInTouchControls) return;
		if (this.externalOrbitDrive) return;
		event.preventDefault();
		const deltaX = event.touches[0].clientX - this.mouseX;
		const deltaY = event.touches[0].clientY - this.mouseY;
		this.targetSpherical.theta -= deltaX * this.rotationSpeed;
		this.targetSpherical.phi -= deltaY * this.rotationSpeed;
		this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
		this.mouseX = event.touches[0].clientX;
		this.mouseY = event.touches[0].clientY;
		if (deltaX !== 0 || deltaY !== 0) this.markManualOrbit();
	}

	onWheel(event: WheelEvent): void {
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.externalOrbitDrive) return;
		event.preventDefault();
		const delta = event.deltaY * 0.001;
		this.targetSpherical.radius = Math.max(
			this.minDistance,
			Math.min(this.maxDistance, this.targetSpherical.radius + delta)
		);
	}

	/**
	 * Apply external camera delta (e.g., from mobile controls)
	 * @param deltaX Horizontal delta (positive = right)
	 * @param deltaY Vertical delta (positive = down)
	 */
	applyExternalDelta(deltaX: number, deltaY: number): void {
		if (!this.enabled) return;
		if (!this.shouldProcessInput()) return;
		if (this.externalOrbitDrive) return;

		// Apply deltas directly to target spherical coordinates
		this.targetSpherical.theta -= deltaX;
		this.targetSpherical.phi -= deltaY;

		// Clamp phi to prevent camera from flipping
		this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
		if (deltaX !== 0 || deltaY !== 0) this.markManualOrbit();
	}

	setAutoFollow(enabled: boolean, speed?: number): void {
		this.autoFollowEnabled = enabled;
		if (speed !== undefined) {
			this.autoFollowSpeed = speed;
		}
	}

	setExternalOrbitDrive(enabled: boolean): void {
		this.externalOrbitDrive = enabled;
	}

	/**
	 * Drive the orbit targets directly (external chase-cam systems). The
	 * camera's internal spherical smoothing still polishes the motion, so
	 * the driver can set raw targets every frame. The driver is responsible
	 * for theta CONTINUITY (accumulate via wrapped deltas — the internal
	 * smoothing does not wrap angles). `snap` also sets the live spherical
	 * for hard cuts (run start, teleports).
	 */
	driveOrbit(theta: number, phi: number, radius?: number, snap: boolean = false): void {
		this.targetSpherical.theta = theta;
		this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
		if (radius !== undefined) {
			this.targetSpherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, radius));
		}
		if (snap) {
			this.spherical.theta = this.targetSpherical.theta;
			this.spherical.phi = this.targetSpherical.phi;
			if (radius !== undefined) this.spherical.radius = this.targetSpherical.radius;
			// Chase-damping mode: hard-cut the real camera onto the rig next frame.
			this.chaseInitialized = false;
		}
	}

	setTargetForwardDirection(direction: THREE.Vector3 | null): void {
		this.targetForwardDirection = direction;
	}

	/** Pause auto-follow while the user is orbiting (and shortly after). */
	private markManualOrbit(): void {
		this.manualOverrideUntilMs = performance.now() + ThirdPersonCamera.AUTO_FOLLOW_RESUME_DELAY_MS;
	}

	private applyAutoFollow(deltaTime: number): void {
		if (this.externalOrbitDrive) return;
		if (!this.autoFollowEnabled || !this.targetForwardDirection) return;
		if (performance.now() < this.manualOverrideUntilMs) return;

		const targetDir = this.targetForwardDirection.clone().normalize();
		if (targetDir.lengthSq() < 0.01) return;

		// Exponential chase (critically-damped feel, no fixed-rate lag):
		// `autoFollowSpeed` is the responsiveness in 1/s — the camera covers
		// ~63% of the remaining angle per 1/speed seconds. Large values
		// behave like the old "snap" semantics.
		const k = 1 - Math.exp(-this.autoFollowSpeed * deltaTime);

		// Camera sits BEHIND the player (+PI = opposite the forward direction).
		const targetTheta = Math.atan2(targetDir.x, targetDir.z) + Math.PI;
		let angleDiff = targetTheta - this.targetSpherical.theta;
		while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
		while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
		this.targetSpherical.theta += angleDiff * k;

		// Pitch-follow: when the target direction points meaningfully up or
		// downhill (a skier descending, a vehicle on a grade), raise the
		// orbit ABOVE the slope line behind the target — see the
		// PITCH_SLOPE_CLEAR_FACTOR note. Horizontal followers (dir.y = 0)
		// are untouched.
		if (Math.abs(targetDir.y) > 0.05) {
			const slope = Math.asin(THREE.MathUtils.clamp(-targetDir.y, -0.95, 0.95));
			const elevation = slope * ThirdPersonCamera.PITCH_SLOPE_CLEAR_FACTOR
				+ ThirdPersonCamera.PITCH_BASE_ELEVATION;
			const targetPhi = THREE.MathUtils.clamp(
				Math.PI / 2 - elevation,
				ThirdPersonCamera.PITCH_FOLLOW_MIN_PHI,
				ThirdPersonCamera.PITCH_FOLLOW_MAX_PHI);
			this.targetSpherical.phi += (targetPhi - this.targetSpherical.phi) * k;
		}
	}

	update(deltaTime: number): void {
		if (!this.enabled || !this.target) return;
		
		const targetWorld = this._tempTargetWorld;
		this.target.getWorldPosition(targetWorld);

		const dt = Math.max(deltaTime || 0, 1/120); // guard against 0 in first call

		// Chase-damping mode (ski/snowboard chase cam): build a rigid "virtual" rig
		// and SmoothDamp the real camera toward it. Bypasses the anchor model.
		if (this.chaseDamping) {
			this.updateChaseDamped(targetWorld, dt);
			return;
		}

		if (!this.anchorInitialized) {
			this.anchor.copy(targetWorld);
			this.anchorInitialized = true;
		}

		// kill Y jitter from animation
		let targetY = targetWorld.y;
		if (Math.abs(targetY - this.anchor.y) < this.verticalDeadzone) {
			targetY = this.anchor.y;
		}

		const hl = this.followHalfLife;

		this.anchor.x = this.smoothTowards(this.anchor.x, targetWorld.x, hl, dt);
		this.anchor.y = this.smoothTowards(this.anchor.y, targetY,       hl, dt);
		this.anchor.z = this.smoothTowards(this.anchor.z, targetWorld.z, hl, dt);
		
		this.applyAutoFollow(dt);
		
		// Update camera shake
		this.updateShake(dt);

		// Ease the FOV toward any chase-cam target.
		this.updateFov(dt);
		
		// Frame-rate independent spherical coordinate smoothing
		// Convert smoothness to work with deltaTime (smoothness of 0.1 at 60fps = half-life ~0.1s)
		const sphericalHalfLife = 0.1; // seconds
		this.spherical.theta  = this.smoothTowards(this.spherical.theta,  this.targetSpherical.theta,  sphericalHalfLife, dt);
		this.spherical.phi    = this.smoothTowards(this.spherical.phi,    this.targetSpherical.phi,    sphericalHalfLife, dt);
		this.spherical.radius = this.smoothTowards(this.spherical.radius, this.targetSpherical.radius, sphericalHalfLife, dt);
		
		// Apply shake offsets to a temporary spherical for position calculation
		const shakenSpherical = this._tempShakenSpherical;
		shakenSpherical.set(
			this.spherical.radius,
			this.spherical.phi + this.shakePhiOffset,
			this.spherical.theta + this.shakeThetaOffset
		);
		this.offset.setFromSpherical(shakenSpherical);
		
		// Raycast from player to camera to detect walls
		const adjustedOffset = this.checkCameraCollision(this.anchor, this.offset);

		this.camera.position.copy(this.anchor).add(adjustedOffset);

		this.lookAtPosition.set(this.anchor.x, this.anchor.y + this.lookAtHeight, this.anchor.z);

		// Apply lateral (screen-right/up) shoulder offset so over-the-shoulder framing
		// is a property of the camera, not something every template has to hand-code.
		// The nudge shifts both camera and lookAt by the same vector so the crosshair
		// still points along the camera's forward axis.
		if (this.shoulderOffsetRight !== 0 || this.shoulderOffsetUp !== 0) {
			const forward = this._tempForward.subVectors(this.lookAtPosition, this.camera.position).normalize();
			const right = this._tempRight.crossVectors(forward, this._tempUp.set(0, 1, 0)).normalize();
			const up = this._tempShoulderUp.crossVectors(right, forward).normalize();
			const nudge = this._tempShoulderNudge
				.set(0, 0, 0)
				.addScaledVector(right, this.shoulderOffsetRight)
				.addScaledVector(up, this.shoulderOffsetUp);
			this.camera.position.add(nudge);
			this.lookAtPosition.add(nudge);
		}

		this.camera.lookAt(this.lookAtPosition);
	}

	/**
	 * Set a lateral (screen-right) and vertical (screen-up) shoulder offset.
	 * Use to achieve over-the-shoulder third-person framing — e.g. for aiming,
	 * mining, or combat — without patching the camera math per template.
	 */
	setShoulderOffset(right: number, up: number): void {
		this.shoulderOffsetRight = right;
		this.shoulderOffsetUp = up;
	}

	private checkCameraCollision(playerPos: THREE.Vector3, desiredOffset: THREE.Vector3): THREE.Vector3 {
		if (!this.engine || !this.engine.physicsWorld) {
			return desiredOffset;
		}
		
		const physicsWorld = this.engine.physicsWorld;
		
		const desiredCameraPos = this._tempDesiredCameraPos.copy(playerPos).add(desiredOffset);

		const rayFromWorld = this._tempRayFrom.set(playerPos.x, playerPos.y + this.lookAtHeight, playerPos.z);
		const rayToWorld = desiredCameraPos;

		const rayDirection = this._tempRayDirection.subVectors(rayToWorld, rayFromWorld).normalize();
		const maxDistance = rayFromWorld.distanceTo(rayToWorld);

		// Only test against the configured static mask (terrain ± environment).
		// Without this filter the ray origin sits inside the player's own capsule,
		// Rapier reports it as the closest hit (toi=0), the isFixed() check skips it,
		// and the real wall/floor behind is never tested. Chase cams narrow the
		// mask to terrain only so trees/rocks never snap the camera.
		const result = physicsWorld.raycast(rayFromWorld, rayDirection, maxDistance, this.collisionMask, this._cameraRayResult);

		const adjustedOffset = this._tempAdjustedOffset.copy(desiredOffset);

		if (result.hasHit && result.hitRigidBody) {
			const isStatic = result.hitRigidBody.isFixed();
			const hitPos = result.hitPoint;

			if (isStatic) {
				const toHit = this._tempToHit.subVectors(hitPos, rayFromWorld);
				const hitDistanceAlongRay = toHit.dot(rayDirection);

				// Buffer must exceed the camera near plane: a 0.1 m gap lets
				// the near plane clip through the obstruction (see-through
				// walls / "inside the hill" on slopes).
				const buffer = 0.35;
				const safeDistance = Math.max(0.2, hitDistanceAlongRay - buffer);

				const safeCameraPos = this._tempSafeCameraPos.copy(rayFromWorld);
				const rayDirectionScaled = this._tempRayDirScaled.copy(rayDirection).multiplyScalar(safeDistance);
				safeCameraPos.add(rayDirectionScaled);

				adjustedOffset.subVectors(safeCameraPos, playerPos);
			}
		}

		return adjustedOffset;
	}
	
	private smoothTowards(current: number, target: number, halfLife: number, dt: number): number {
		// Exponential decay with half-life; stable across variable dt
		const a = Math.pow(0.5, dt / Math.max(halfLife, 1e-4));
		return current * a + target * (1 - a);
	}

	/**
	 * Enable chase-damping mode (virtual rig + SmoothDamped real camera) with
	 * per-axis time constants in seconds: `horizontal` (X/Z follow), `vertical`
	 * (Y — damp hard to kill terrain-bump bob), `aim` (look-at). Pass null to
	 * restore the legacy anchor follow model.
	 */
	setChaseDamping(opts: { horizontal: number; vertical: number; orbit: number } | null): void {
		this.chaseDamping = opts;
		if (opts === null) {
			this.chaseInitialized = false;
			this.followVel.set(0, 0, 0);
			// Re-seed the anchor next frame so the legacy model resumes cleanly.
			this.anchorInitialized = false;
		}
	}

	/**
	 * Whether the camera-collision raycast hits environment props (trees, rocks).
	 * Disable on chase cams so weaving through trees never snaps the camera
	 * between its true position and a pulled-in position behind a trunk. Terrain
	 * (the hill itself) is always collided against so the camera can't clip into
	 * the slope. Default (true) restores terrain + environment.
	 */
	setCollideWithEnvironment(enabled: boolean): void {
		this.collisionMask = enabled
			? (CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT)
			: CollisionGroup.TERRAIN;
	}

	/**
	 * Chase-damping update (decomposed). The "follow point" SmoothDamps toward the
	 * player in world space (vertical hard = bump rejection, horizontal moderate =
	 * responsive turning); the ORBIT (elevation/distance) eases in angular space so
	 * pitch never jumps. Camera = dampedFollowPoint + offset(smoothedOrbit), and
	 * we look directly at the damped point. Yaw arrives pre-eased from the driver,
	 * so theta tracks the target directly.
	 */
	private updateChaseDamped(targetWorld: THREE.Vector3, dt: number): void {
		this.updateShake(dt);
		this.updateFov(dt);

		const damp = this.chaseDamping!;

		if (!this.chaseInitialized) {
			// First chase frame (or after a snap): hard-cut onto the player + orbit.
			this.followCenter.copy(targetWorld);
			this.followVel.set(0, 0, 0);
			this.spherical.radius = this.targetSpherical.radius;
			this.spherical.phi = this.targetSpherical.phi;
			this.spherical.theta = this.targetSpherical.theta;
			this.chaseInitialized = true;
		} else {
			// Follow point: per-axis SmoothDamp (tracks the descent with bounded lag,
			// no overshoot). Vertical damped hard so terrain bumps are filtered out.
			this.followCenter.x = ThirdPersonCamera.smoothDamp(this.followCenter.x, targetWorld.x, this.followVel, 'x', damp.horizontal, dt);
			this.followCenter.y = ThirdPersonCamera.smoothDamp(this.followCenter.y, targetWorld.y, this.followVel, 'y', damp.vertical, dt);
			this.followCenter.z = ThirdPersonCamera.smoothDamp(this.followCenter.z, targetWorld.z, this.followVel, 'z', damp.horizontal, dt);
			// Orbit eases in angular space so elevation/distance never jump. Yaw is
			// already eased by the driver, so theta tracks the target directly.
			this.spherical.phi = this.smoothTowards(this.spherical.phi, this.targetSpherical.phi, damp.orbit, dt);
			this.spherical.radius = this.smoothTowards(this.spherical.radius, this.targetSpherical.radius, damp.orbit, dt);
			this.spherical.theta = this.targetSpherical.theta;
		}

		// Offset from the smoothed orbit (+ shake), collided against the mask.
		const sph = this._tempShakenSpherical;
		const phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi + this.shakePhiOffset));
		sph.set(this.spherical.radius, phi, this.spherical.theta + this.shakeThetaOffset);
		this.offset.setFromSpherical(sph);

		const adjustedOffset = this.checkCameraCollision(this.followCenter, this.offset);
		this.camera.position.copy(this.followCenter).add(adjustedOffset);

		this.lookAtPosition.set(
			this.followCenter.x, this.followCenter.y + this.lookAtHeight, this.followCenter.z,
		);

		// Over-the-shoulder offset shifts both camera and look by the same vector.
		if (this.shoulderOffsetRight !== 0 || this.shoulderOffsetUp !== 0) {
			const forward = this._tempForward.subVectors(this.lookAtPosition, this.camera.position).normalize();
			const right = this._tempRight.crossVectors(forward, this._tempUp.set(0, 1, 0)).normalize();
			const up = this._tempShoulderUp.crossVectors(right, forward).normalize();
			const nudge = this._tempShoulderNudge.set(0, 0, 0)
				.addScaledVector(right, this.shoulderOffsetRight)
				.addScaledVector(up, this.shoulderOffsetUp);
			this.camera.position.add(nudge);
			this.lookAtPosition.add(nudge);
		}

		this.camera.lookAt(this.lookAtPosition);
	}

	/**
	 * Critically-damped spring (Unity SmoothDamp), framerate-independent. Eases a
	 * scalar toward target, integrating the per-axis velocity stored in `vel`. No
	 * overshoot; tracks a moving target (a descending player) with bounded lag.
	 */
	private static smoothDamp(
		current: number, target: number, vel: THREE.Vector3, axis: 'x' | 'y' | 'z', smoothTime: number, dt: number,
	): number {
		const t = Math.max(1e-4, smoothTime);
		const omega = 2 / t;
		const x = omega * dt;
		const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
		const change = current - target;
		const temp = (vel[axis] + omega * change) * dt;
		vel[axis] = (vel[axis] - omega * temp) * exp;
		return target + (change + temp) * exp;
	}

	/**
	 * Widen the FOV by `deltaDeg` above the camera's configured base FOV. The base
	 * is captured on the first call so it survives across frames; the live fov
	 * eases toward base+delta. Use for a speed sensation on chase cams.
	 */
	setFovOffset(deltaDeg: number): void {
		if (this.baseFov === null) this.baseFov = this.camera.fov;
		this.targetFov = this.baseFov + deltaDeg;
	}

	/** Ease the FOV back to the captured base and release it. No-op if never offset. */
	clearFovOffset(): void {
		if (this.baseFov === null) {
			this.targetFov = null;
			return;
		}
		this.targetFov = this.baseFov;
	}

	private updateFov(dt: number): void {
		if (this.targetFov === null) return;
		const current = this.camera.fov;
		const next = this.smoothTowards(current, this.targetFov, this.fovSmoothHalfLife, dt);
		if (Math.abs(next - current) > 1e-4) {
			this.camera.fov = next;
			this.camera.updateProjectionMatrix();
		}
		// Once eased essentially back to base, snap exactly and release.
		if (this.baseFov !== null && this.targetFov === this.baseFov && Math.abs(next - this.baseFov) < 0.01) {
			this.camera.fov = this.baseFov;
			this.camera.updateProjectionMatrix();
			this.targetFov = null;
			this.baseFov = null;
		}
	}
	
	/** Returns a shared internal vector — copy it if you need to store it across frames. */
	getForwardVector(): THREE.Vector3 {
		this.camera.getWorldDirection(this._tempForward);
		this._tempForward.y = 0;
		this._tempForward.normalize();
		return this._tempForward;
	}

	/** Returns a shared internal vector — copy it if you need to store it across frames. */
	getRightVector(): THREE.Vector3 {
		this.camera.getWorldDirection(this._tempForward);
		this._tempForward.y = 0;
		this._tempForward.normalize();
		this._tempUp.set(0, 1, 0);
		this._tempRight.crossVectors(this._tempForward, this._tempUp);
		this._tempRight.normalize();
		return this._tempRight;
	}

	setTarget(newTarget: THREE.Object3D): void {
		this.target = newTarget;
	}

	/** Hard cut after a teleport or spectator target switch; never travel across the map. */
	resetFollow(): void {
		this.anchorInitialized = false;
		this.chaseInitialized = false;
		this.followVel.set(0, 0, 0);
		this.spherical.copy(this.targetSpherical);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.isMouseDown = false;
			(this.domElement as HTMLElement).style.cursor = 'default';
		} else {
			// In editor mode, use grab cursor for click-and-drag
			// Otherwise, don't set grab cursor if pointer lock is used (overlay handles UI feedback)
			if (this.editorModeCamera || (!this.pointerLocked && !this.pointerLockSupported)) {
				(this.domElement as HTMLElement).style.cursor = 'grab';
			}
		}
	}
	
	/**
	 * Set pointer lock mode
	 * When enabled, mouse movement directly controls camera (no click required)
	 * @param locked Whether pointer lock is active
	 */
	setPointerLocked(locked: boolean): void {
		this.pointerLocked = locked;
		// Once pointer lock is used, we know it's supported - disable grab cursors
		this.pointerLockSupported = true;
		
		if (locked) {
			// Clear mouse down state - not needed in pointer lock mode
			this.isMouseDown = false;
		}
		// Don't change cursor - pointer lock overlay handles UI feedback
	}
	
	/**
	 * Set editor mode for camera controls
	 * When enabled, uses click-and-drag controls instead of pointer lock
	 * @param enabled Whether editor mode is active
	 */
	setEditorModeCamera(enabled: boolean): void {
		this.editorModeCamera = enabled;
		
		if (enabled) {
			// Reset to non-pointer-lock mode
			this.pointerLocked = false;
			// Set grab cursor for click-and-drag mode
			if (this.enabled) {
				(this.domElement as HTMLElement).style.cursor = 'grab';
			}
		} else {
			// When leaving editor mode, the cursor will be managed by pointer lock overlay
			if (this.pointerLockSupported) {
				(this.domElement as HTMLElement).style.cursor = 'default';
			}
		}
	}

	/**
	 * Set mobile preview mode — disables all built-in mouse/touch camera
	 * controls so MobileControls handles everything via its own
	 * mouse-to-touch emulation layer.
	 */
	setMobilePreviewMode(enabled: boolean): void {
		this.disableBuiltInMouseControls = enabled;
		this.disableBuiltInTouchControls = enabled;
		if (enabled) {
			this.pointerLocked = false;
			this.isMouseDown = false;
		}
	}

	/**
	 * Set combat mode - adjusts camera to put player lower on screen
	 * When enabled, player appears in bottom third of screen with reticle at center
	 * @param enabled Whether combat/aiming mode is active
	 */
	setCombatMode(enabled: boolean): void {
		if (enabled) {
			// Raise lookAt point so player appears lower on screen
			// Camera looks at a point above the player, putting player in lower portion
			this.lookAtHeight = 2.0;
			// Pull camera back a bit for better view
			this.distance = 5;
			this.spherical.radius = 5;
			this.targetSpherical.radius = 5;
		} else {
			// Reset to default
			this.lookAtHeight = 0.9;
			this.distance = 4;
			this.spherical.radius = 4;
			this.targetSpherical.radius = 4;
		}
	}
	
	/**
	 * Get whether pointer lock mode is active
	 */
	getPointerLocked(): boolean {
		return this.pointerLocked;
	}

	/**
	 * Get the camera instance
	 * @returns The Three.js PerspectiveCamera
	 */
	getCamera(): THREE.PerspectiveCamera {
		return this.camera;
	}
	
	/**
	 * Get the horizontal angle (theta) of the camera
	 * Used for ranged weapon camera-locked rotation
	 * @returns The horizontal angle in radians
	 */
	getHorizontalAngle(): number {
		return this.spherical.theta;
	}
	
	/**
	 * Get the target horizontal angle (for smooth camera following)
	 */
	getTargetHorizontalAngle(): number {
		return this.targetSpherical.theta;
	}

	getMode(): CameraMode {
		return 'third-person';
	}

	setHorizontalAngle(angle: number): void {
		this.spherical.theta = angle;
		this.targetSpherical.theta = angle;
	}
	
	setVerticalAngle(angle: number): void {
		this.spherical.phi = angle;
		this.targetSpherical.phi = angle;
	}
	
	/**
	 * Get the vertical/pitch angle of the camera
	 * phi = PI/2 means horizontal, < PI/2 is looking up, > PI/2 is looking down
	 * @returns The pitch angle in radians (0 = straight up, PI/2 = horizontal, PI = straight down)
	 */
	getVerticalAngle(): number {
		return this.spherical.phi;
	}
	
	/**
	 * Get the pitch angle relative to horizontal
	 * @returns Pitch in radians: positive = looking down, negative = looking up
	 */
	getPitchAngle(): number {
		// phi of PI/2 = horizontal (0 pitch)
		// phi < PI/2 = looking up (negative pitch)
		// phi > PI/2 = looking down (positive pitch)
		return this.spherical.phi - Math.PI / 2;
	}
	
	/**
	 * Apply a camera shake effect (e.g., for weapon fire)
	 * @param intensity Shake intensity (0.03 is conservative, 0.1+ is aggressive)
	 */
	applyShake(intensity: number = 0.03): void {
		// Add to existing shake (allows rapid fire to accumulate slightly)
		this.shakeIntensity = Math.min(this.shakeIntensity + intensity, intensity * 3);
		
		// Apply immediate upward kick (recoil feel) - phi decrease = look up
		this.shakePhiOffset = -intensity * 1.5;
	}
	
	/**
	 * Update shake offsets based on current intensity
	 * Called each frame in update()
	 */
	private updateShake(deltaTime: number): void {
		if (this.shakeIntensity <= 0.001) {
			this.shakeThetaOffset = 0;
			this.shakePhiOffset = 0;
			this.shakeIntensity = 0;
			return;
		}
		
		// Generate random shake offsets based on current intensity
		// Horizontal shake is random, vertical recovers from initial kick
		this.shakeThetaOffset = (Math.random() - 0.5) * 2 * this.shakeIntensity;
		// Blend current phi offset toward zero with some random jitter
		this.shakePhiOffset = this.shakePhiOffset * 0.8 + (Math.random() - 0.5) * this.shakeIntensity * 0.5;
		
		// Decay shake intensity over time
		this.shakeIntensity *= Math.pow(0.5, deltaTime * this.shakeDecayRate);
	}

	dispose(): void {
		// Remove event listeners using the same bound references that were added
		this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.removeEventListener('touchstart', this.boundOnTouchStart);
		this.domElement.removeEventListener('touchend', this.boundOnTouchEnd);
		this.domElement.removeEventListener('touchmove', this.boundOnTouchMove);
		this.domElement.removeEventListener('wheel', this.boundOnWheel);
		this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
		
		// Remove document-level listener for pointer lock
		document.removeEventListener('mousemove', this.boundOnDocumentMouseMove);
	}
}
