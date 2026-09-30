import * as THREE from 'three';
import type { EngineLike, FitWorldRegion, FitWorldInset } from 'types/game.js';
import type { ICameraController, CameraMode } from 'engine/ICameraController.js';
import { computeOrthoFrustumForRegion, type ViewportInsetsPx } from 'engine/CameraFit.js';

/**
 * Configuration for the top-down "fit whole world" mode. When active the camera
 * becomes a fixed orthographic view sized so the entire `sizeX × sizeZ` world is
 * visible with no empty borders, centered on the world and looking straight down.
 */
export interface TopDownFitWorldOptions {
	/** World extent along X (e.g. worldProfileData.groundWorldSizeX), in meters. */
	sizeX: number;
	/** World extent along Z (e.g. worldProfileData.groundWorldSizeZ), in meters. */
	sizeZ: number;
	/** World center X the camera looks down on. */
	centerX: number;
	/** World center Z the camera looks down on. */
	centerZ: number;
	/** Fit margin: 1.0 = world edges touch the map region exactly; >1 adds padding. */
	margin: number;
	/** Overhead altitude of the orthographic camera (kept above world geometry). */
	height: number;
	/**
	 * Viewport edges reserved for in-game UI. The map fits and centers in the
	 * remaining area; reserved edges show background behind the (overlaid) UI.
	 * Empty `{}` (default) fits the whole viewport.
	 */
	region: FitWorldRegion;
	/**
	 * Margin background. A straight-down view only shows the skybox as margins
	 * around the map, so it's replaced with a solid color. A hex color (e.g.
	 * match the ground for a seamless look), `'auto'` (default — sky/fog color),
	 * or `'keep'` (don't touch the skybox).
	 */
	background: string;
}

export const DEFAULT_TOPDOWN_FIT_WORLD_OPTIONS: TopDownFitWorldOptions = {
	sizeX: 64,
	sizeZ: 64,
	centerX: 0,
	centerZ: 0,
	margin: 1.0,
	height: 200,
	region: {},
	background: 'auto',
};

export class TopDownCamera implements ICameraController {
	camera: THREE.PerspectiveCamera;
	target: THREE.Object3D;
	domElement: HTMLElement;
	engine: EngineLike;
	
	enabled: boolean = true;
	
	private height: number = 10;
	private minHeight: number = 5;
	private maxHeight: number = 50;
	private targetHeight: number = 10;

	// "Fit whole world" mode. When set, the engine renders through `orthoCamera`
	// (a fixed overhead orthographic view) instead of the perspective `camera`.
	private orthoCamera: THREE.OrthographicCamera;
	private fitWorld: TopDownFitWorldOptions | null = null;
	private fitWorldBgApplied: boolean = false;
	
	private lookAheadDistance: number = 0;
	private lookAheadDirection: THREE.Vector3 = new THREE.Vector3(0, 0, -1);
	
	private smoothness: number = 0.1;
	private followHalfLife: number = 0.08;
	
	private anchor: THREE.Vector3 = new THREE.Vector3();
	private anchorInitialized: boolean = false;

	// ─── Instant pan (player-driven camera scrolling) ───────────────────
	// A world-space XZ offset added to the (smoothed) follow anchor with NO
	// smoothing of its own, so player panning responds 1:1 on the very next
	// frame while the underlying follow keeps its own easing. This is the
	// intended way to let a player scroll/grab the view (e.g. a top-down
	// turn-based game): drag-to-pan via beginPan()/panTo()/endPan(), discrete
	// nudges via panBy(). Never moves the follow target, so it composes with a
	// live follow as a rigid shift on top.
	private panOffset: THREE.Vector3 = new THREE.Vector3();
	private panLimitMinX: number = -Infinity;
	private panLimitMaxX: number = Infinity;
	private panLimitMinZ: number = -Infinity;
	private panLimitMaxZ: number = Infinity;
	// Ground plane the drag-to-pan raycast projects onto (default y = 0).
	private panPlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	private panRaycaster: THREE.Raycaster = new THREE.Raycaster();
	// World point grabbed at beginPan(); panTo() keeps it under the cursor.
	private panGrabPoint: THREE.Vector3 | null = null;

	// Default pitch: 30 degrees from vertical = -60 degrees = -PI/3
	// This puts camera slightly behind the player, not directly above
	private pitchAngle: number = -Math.PI / 3; // -60 degrees
	private minPitchAngle: number = -Math.PI / 2; // -90 degrees (straight down)
	private maxPitchAngle: number = -Math.PI / 6; // -30 degrees
	private targetPitchAngle: number = -Math.PI / 3;
	
	private yawAngle: number = 0;
	private targetYawAngle: number = 0;
	
	// Rotation is disabled by default - camera follows player without rotating
	// Templates can enable rotation via setRotationEnabled(true)
	private rotationEnabled: boolean = false;
	
	private isMouseDown: boolean = false;
	private mouseX: number = 0;
	private mouseY: number = 0;
	private rotationSpeed: number = 0.003;
	
	private pointerLocked: boolean = false;
	private pointerLockSupported: boolean = false;
	private editorModeCamera: boolean = false;
	
	private shakeIntensity: number = 0;
	private shakeDecayRate: number = 12;
	private shakeXOffset: number = 0;
	private shakeZOffset: number = 0;
	
	private boundOnMouseDown: (event: MouseEvent) => void;
	private boundOnMouseUp: (event: MouseEvent) => void;
	private boundOnMouseMove: (event: MouseEvent) => void;
	private boundOnDocumentMouseMove: (event: MouseEvent) => void;
	private boundOnTouchStart: (event: TouchEvent) => void;
	private boundOnTouchEnd: (event: TouchEvent) => void;
	private boundOnTouchMove: (event: TouchEvent) => void;
	private boundOnWheel: (event: WheelEvent) => void;
	private boundOnContextMenu: (event: Event) => void;
	
	constructor(
		camera: THREE.PerspectiveCamera,
		target: THREE.Object3D,
		domElement: HTMLElement,
		engine: EngineLike
	) {
		this.camera = camera;
		this.target = target;
		this.domElement = domElement;
		this.engine = engine;

		// Owned orthographic camera for fit-world mode. Frustum/position are set
		// by updateFitWorldCamera() once a world size is supplied. Match the
		// perspective camera's render layers so it sees the same content.
		this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
		this.orthoCamera.layers.enable(0);
		this.orthoCamera.layers.enable(1);
		this.orthoCamera.layers.enable(2);

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
	
	private setupEventListeners(): void {
		this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.addEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.addEventListener('touchstart', this.boundOnTouchStart);
		this.domElement.addEventListener('touchend', this.boundOnTouchEnd);
		this.domElement.addEventListener('touchmove', this.boundOnTouchMove);
		this.domElement.addEventListener('wheel', this.boundOnWheel);
		this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
		document.addEventListener('mousemove', this.boundOnDocumentMouseMove);
	}
	
	private shouldProcessInput(): boolean {
		if (document.pointerLockElement) return true;
		if (this.engine && !this.engine.isWindowFocused) return false;
		if (this.engine && this.engine.editorManager && this.engine.editorManager.isEditorMode) return false;
		return true;
	}

	/** Shared gate for rotation input: enabled, rotation allowed, and input not blocked. */
	private canRotate(): boolean {
		return this.enabled && this.rotationEnabled && this.shouldProcessInput();
	}

	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	private clampPitch(angle: number): number {
		return this.clamp(angle, this.minPitchAngle, this.maxPitchAngle);
	}

	private clampHeight(height: number): number {
		return this.clamp(height, this.minHeight, this.maxHeight);
	}

	/** Apply a yaw/pitch look delta (in radians) to the camera targets, clamping pitch. */
	private applyLookDelta(yawDelta: number, pitchDelta: number): void {
		this.targetYawAngle -= yawDelta;
		this.targetPitchAngle = this.clampPitch(this.targetPitchAngle + pitchDelta * 0.5);
	}

	private onMouseDown(event: MouseEvent): void {
		if (!this.canRotate()) return;
		if (!this.editorModeCamera && (this.pointerLocked || this.pointerLockSupported)) return;
		if (event.button === 0) {
			this.isMouseDown = true;
			this.mouseX = event.clientX;
			this.mouseY = event.clientY;
			this.domElement.style.cursor = 'grabbing';
		}
	}

	private onMouseUp(event: MouseEvent): void {
		if (!this.rotationEnabled) return;
		if (!this.editorModeCamera && (this.pointerLocked || this.pointerLockSupported)) return;
		if (event.button === 0) {
			this.isMouseDown = false;
			this.domElement.style.cursor = 'grab';
		}
	}

	private onMouseMove(event: MouseEvent): void {
		if (!this.canRotate()) return;
		if (this.pointerLocked) return;
		if (!this.isMouseDown) return;

		const deltaX = event.clientX - this.mouseX;
		const deltaY = event.clientY - this.mouseY;
		this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);

		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	private onDocumentMouseMove(event: MouseEvent): void {
		if (!this.pointerLocked) return;
		if (!this.canRotate()) return;

		const deltaX = event.movementX || 0;
		const deltaY = event.movementY || 0;
		this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);
	}

	private onTouchStart(event: TouchEvent): void {
		if (!this.canRotate()) return;
		if (event.touches.length === 1 && event.touches[0]) {
			event.preventDefault();
			this.isMouseDown = true;
			this.mouseX = event.touches[0].clientX;
			this.mouseY = event.touches[0].clientY;
		}
	}

	private onTouchEnd(_event: TouchEvent): void {
		this.isMouseDown = false;
	}

	private onTouchMove(event: TouchEvent): void {
		if (!this.canRotate()) return;
		if (!this.isMouseDown || event.touches.length !== 1 || !event.touches[0]) return;

		event.preventDefault();
		const deltaX = event.touches[0].clientX - this.mouseX;
		const deltaY = event.touches[0].clientY - this.mouseY;
		this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);

		this.mouseX = event.touches[0].clientX;
		this.mouseY = event.touches[0].clientY;
	}

	private onWheel(event: WheelEvent): void {
		if (!this.enabled) return;
		// Fit-world mode is a fixed full-map view — manual zoom is disabled.
		if (this.fitWorld) return;
		if (!this.shouldProcessInput()) return;
		event.preventDefault();

		const delta = event.deltaY * 0.01;
		this.targetHeight = this.clampHeight(this.targetHeight + delta);
	}

	/**
	 * Enable (or, with `null`, disable) the fit-whole-world orthographic mode.
	 * When enabling, the engine's active render camera is swapped to this
	 * controller's orthographic camera and post-processing passes are rebound.
	 */
	setFitWorld(
		options: (Partial<TopDownFitWorldOptions> & { sizeX: number; sizeZ: number }) | null,
	): void {
		if (options === null) {
			if (this.fitWorld) {
				this.fitWorld = null;
				if (this.enabled) {
					this.clearFitWorldBackground();
					this.engine.setRenderCamera(this.camera);
				}
			}
			return;
		}
		this.fitWorld = { ...DEFAULT_TOPDOWN_FIT_WORLD_OPTIONS, ...options };
		// Size the ortho frustum before swapping so the first rendered frame
		// (and the composer rebuild inside setRenderCamera) is already correct.
		this.updateFitWorldCamera();
		if (this.enabled) {
			this.engine.setRenderCamera(this.orthoCamera);
			this.applyFitWorldBackground();
		}
	}

	/** Replace the skybox with the configured solid margin background (no-op for
	 *  `'keep'`). The straight-down ortho view only shows skybox as margins. */
	private applyFitWorldBackground(): void {
		const fw = this.fitWorld;
		if (!fw || fw.background === 'keep') return;
		const color = fw.background === 'auto' ? this.engine.getSkyColorHex() : fw.background;
		this.engine.setSolidBackground(color);
		this.fitWorldBgApplied = true;
	}

	/** Restore the skybox if this controller replaced it. */
	private clearFitWorldBackground(): void {
		if (!this.fitWorldBgApplied) return;
		this.engine.setSolidBackground(null);
		this.fitWorldBgApplied = false;
	}

	/** Resolve one UI inset (px or fraction of `dimensionPx`) to CSS pixels. */
	private resolveInsetPx(inset: FitWorldInset | undefined, dimensionPx: number): number {
		if (!inset) return 0;
		if (inset.px != null) return Math.max(0, inset.px);
		if (inset.fraction != null) return Math.max(0, inset.fraction * dimensionPx);
		return 0;
	}

	/** Recompute the ortho frustum (for the current viewport) and overhead pose. */
	private updateFitWorldCamera(): void {
		const fw = this.fitWorld;
		if (!fw) return;
		// Match the renderer's drawing-buffer size (it sizes to window dimensions),
		// so the frustum maps correctly to on-screen pixels.
		const w = Math.max(1, window.innerWidth);
		const h = Math.max(1, window.innerHeight);
		const insetsPx: ViewportInsetsPx = {
			left: this.resolveInsetPx(fw.region.left, w),
			right: this.resolveInsetPx(fw.region.right, w),
			top: this.resolveInsetPx(fw.region.top, h),
			bottom: this.resolveInsetPx(fw.region.bottom, h),
		};
		const frustum = computeOrthoFrustumForRegion(fw.sizeX, fw.sizeZ, w, h, insetsPx, fw.margin);
		this.orthoCamera.left = frustum.left;
		this.orthoCamera.right = frustum.right;
		this.orthoCamera.top = frustum.top;
		this.orthoCamera.bottom = frustum.bottom;
		this.orthoCamera.position.set(fw.centerX, fw.height, fw.centerZ);
		// Looking straight down: pick an up vector that isn't parallel to the
		// view direction. up = -Z puts world -Z toward the top of the screen.
		this.orthoCamera.up.set(0, 0, -1);
		this.orthoCamera.lookAt(fw.centerX, 0, fw.centerZ);
		this.orthoCamera.updateProjectionMatrix();
	}

	update(deltaTime: number): void {
		if (!this.enabled) return;

		// Fit-world mode: drive the fixed orthographic camera and skip all the
		// player-following / pitch / zoom logic below.
		if (this.fitWorld) {
			this.updateFitWorldCamera();
			return;
		}

		if (!this.target) return;

		const targetWorld = new THREE.Vector3();
		this.target.getWorldPosition(targetWorld);
		
		if (!this.anchorInitialized) {
			this.anchor.copy(targetWorld);
			this.anchorInitialized = true;
		}
		
		const dt = Math.max(deltaTime || 0, 1/120);
		
		this.anchor.x = this.smoothTowards(this.anchor.x, targetWorld.x, this.followHalfLife, dt);
		this.anchor.y = this.smoothTowards(this.anchor.y, targetWorld.y, this.followHalfLife, dt);
		this.anchor.z = this.smoothTowards(this.anchor.z, targetWorld.z, this.followHalfLife, dt);
		
		this.height = this.smoothTowards(this.height, this.targetHeight, this.smoothness, dt);
		this.pitchAngle = this.smoothTowards(this.pitchAngle, this.targetPitchAngle, this.smoothness, dt);
		this.yawAngle = this.smoothTowards(this.yawAngle, this.targetYawAngle, this.smoothness, dt);
		
		this.updateShake(dt);

		this.applyCameraTransform();
	}

	/**
	 * Position the camera from the current (already-smoothed) anchor PLUS the
	 * instant pan offset, height, angles, look-ahead and shake. Split out of
	 * update() so a drag-to-pan gesture (panTo) can reposition the camera
	 * mid-frame and keep its own screen→ground raycasts consistent. Applies no
	 * smoothing — the pan offset takes effect immediately.
	 */
	private applyCameraTransform(): void {
		const focusX = this.anchor.x + this.panOffset.x;
		const focusY = this.anchor.y;
		const focusZ = this.anchor.z + this.panOffset.z;

		const horizontalDistance = Math.abs(this.height * Math.tan(this.pitchAngle + Math.PI / 2));

		const offsetX = Math.sin(this.yawAngle) * horizontalDistance + this.shakeXOffset;
		const offsetZ = Math.cos(this.yawAngle) * horizontalDistance + this.shakeZOffset;

		const lookAheadX = this.lookAheadDirection.x * this.lookAheadDistance;
		const lookAheadZ = this.lookAheadDirection.z * this.lookAheadDistance;

		this.camera.position.set(
			focusX + offsetX + lookAheadX,
			focusY + this.height,
			focusZ + offsetZ + lookAheadZ
		);

		const lookAtPoint = new THREE.Vector3(
			focusX + lookAheadX,
			focusY,
			focusZ + lookAheadZ
		);
		this.camera.lookAt(lookAtPoint);

		if (this.pitchAngle > this.minPitchAngle) {
			const euler = new THREE.Euler();
			euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
			euler.x = this.pitchAngle;
			this.camera.quaternion.setFromEuler(euler);
		}
	}
	
	private smoothTowards(current: number, target: number, halfLife: number, dt: number): number {
		const a = Math.pow(0.5, dt / Math.max(halfLife, 1e-4));
		return current * a + target * (1 - a);
	}
	
	private updateShake(deltaTime: number): void {
		if (this.shakeIntensity <= 0.001) {
			this.shakeXOffset = 0;
			this.shakeZOffset = 0;
			this.shakeIntensity = 0;
			return;
		}
		
		this.shakeXOffset = (Math.random() - 0.5) * 2 * this.shakeIntensity;
		this.shakeZOffset = (Math.random() - 0.5) * 2 * this.shakeIntensity;
		
		this.shakeIntensity *= Math.pow(0.5, deltaTime * this.shakeDecayRate);
	}
	
	getForwardVector(): THREE.Vector3 {
		// (-sin, 0, -cos) is already unit-length, so no normalize() needed.
		return new THREE.Vector3(-Math.sin(this.yawAngle), 0, -Math.cos(this.yawAngle));
	}
	
	getRightVector(): THREE.Vector3 {
		const forward = this.getForwardVector();
		const right = new THREE.Vector3();
		right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
		return right.normalize();
	}
	
	getCamera(): THREE.PerspectiveCamera {
		return this.camera;
	}
	
	setTarget(target: THREE.Object3D): void {
		this.target = target;
		console.log('TopDownCamera: Target updated');
	}
	
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.isMouseDown = false;
			this.domElement.style.cursor = 'default';
		} else {
			if (this.editorModeCamera || (!this.pointerLocked && !this.pointerLockSupported)) {
				this.domElement.style.cursor = 'grab';
			}
		}
		// Install/restore the orthographic render camera (and its solid margin
		// background) when leaving or re-entering top-down while fit-world mode is
		// configured, so the engine never stays stranded on the ortho camera or a
		// hidden skybox after a mode switch.
		if (this.fitWorld) {
			this.engine.setRenderCamera(enabled ? this.orthoCamera : this.camera);
			if (enabled) {
				this.applyFitWorldBackground();
			} else {
				this.clearFitWorldBackground();
			}
		}
	}
	
	setPointerLocked(locked: boolean): void {
		this.pointerLocked = locked;
		this.pointerLockSupported = true;
		
		if (locked) {
			this.isMouseDown = false;
		}
	}
	
	getPointerLocked(): boolean {
		return this.pointerLocked;
	}
	
	setEditorModeCamera(enabled: boolean): void {
		this.editorModeCamera = enabled;
		
		if (enabled) {
			this.pointerLocked = false;
			if (this.enabled) {
				this.domElement.style.cursor = 'grab';
			}
		} else {
			if (this.pointerLockSupported) {
				this.domElement.style.cursor = 'default';
			}
		}
	}

	applyExternalDelta(deltaX: number, deltaY: number): void {
		if (!this.canRotate()) return;
		this.applyLookDelta(deltaX, deltaY);
	}
	
	setRotationEnabled(enabled: boolean): void {
		this.rotationEnabled = enabled;
	}
	
	getRotationEnabled(): boolean {
		return this.rotationEnabled;
	}
	
	getHorizontalAngle(): number {
		return this.yawAngle;
	}

	getMode(): CameraMode {
		return 'top-down';
	}

	getVerticalAngle(): number {
		return this.pitchAngle + Math.PI;
	}
	
	getPitchAngle(): number {
		return this.pitchAngle + Math.PI / 2;
	}
	
	setHorizontalAngle(angle: number): void {
		this.yawAngle = angle;
		this.targetYawAngle = angle;
	}
	
	setVerticalAngle(angle: number): void {
		this.pitchAngle = this.clampPitch(angle - Math.PI);
		this.targetPitchAngle = this.pitchAngle;
	}
	
	applyShake(intensity: number = 0.5): void {
		this.shakeIntensity = Math.min(this.shakeIntensity + intensity, intensity * 3);
	}
	
	setHeight(height: number): void {
		this.height = this.clampHeight(height);
		this.targetHeight = this.height;
	}

	getHeight(): number {
		return this.height;
	}

	/**
	 * Set the camera's distance from the target (its zoom level). A top-down
	 * camera sits roughly overhead, so its distance from the player IS its
	 * altitude — this is an explicit alias of {@link setHeight}, provided so
	 * camera-tuning code (e.g. PlayerController.configureVehicleCamera) can use
	 * the same `distance` knob it uses for chase cameras. Clamped to the
	 * configured height range; call {@link setHeightRange} first to widen it.
	 */
	setDistance(distance: number): void {
		this.setHeight(distance);
	}

	/** Camera distance from the target (== altitude for an overhead camera). */
	getDistance(): number {
		return this.height;
	}
	
	setHeightRange(min: number, max: number): void {
		this.minHeight = min;
		this.maxHeight = max;
		this.height = this.clampHeight(this.height);
		this.targetHeight = this.clampHeight(this.targetHeight);
	}

	setPitchRange(min: number, max: number): void {
		this.minPitchAngle = min;
		this.maxPitchAngle = max;
		this.pitchAngle = this.clampPitch(this.pitchAngle);
		this.targetPitchAngle = this.clampPitch(this.targetPitchAngle);
	}
	
	setLookAhead(distance: number, direction?: THREE.Vector3): void {
		this.lookAheadDistance = distance;
		if (direction) {
			this.lookAheadDirection.copy(direction).normalize();
		}
	}

	// ─── Instant pan API ────────────────────────────────────────────────
	// Player-driven camera scrolling that bypasses follow-smoothing entirely,
	// so panning is immediate (no easing/lag) even though the follow itself is
	// smoothed. Use beginPan/panTo/endPan for grab-and-drag; panBy for
	// keyboard/edge scrolling. Pan never touches the follow target.

	/**
	 * Shift the camera view by a world-space XZ delta, instantly (no smoothing).
	 * Accumulates onto the current pan offset and is clamped to setPanLimits().
	 * Use for keyboard / edge-scroll panning.
	 */
	panBy(deltaX: number, deltaZ: number): void {
		this.setPanOffset(this.panOffset.x + deltaX, this.panOffset.z + deltaZ);
	}

	/**
	 * Set the absolute pan offset (world units) from the un-panned view,
	 * clamped to setPanLimits(). Applied instantly.
	 */
	setPanOffset(x: number, z: number): void {
		this.panOffset.x = this.clamp(x, this.panLimitMinX, this.panLimitMaxX);
		this.panOffset.z = this.clamp(z, this.panLimitMinZ, this.panLimitMaxZ);
	}

	/** Current pan offset (clone; world units). */
	getPanOffset(): THREE.Vector3 {
		return this.panOffset.clone();
	}

	/** Recenter: clear the pan offset and any in-progress grab. */
	resetPan(): void {
		this.panOffset.set(0, 0, 0);
		this.panGrabPoint = null;
	}

	/**
	 * Bound how far the view can pan from the un-panned position (world units
	 * on X/Z). Defaults to unbounded. Re-clamps the current offset immediately.
	 */
	setPanLimits(minX: number, maxX: number, minZ: number, maxZ: number): void {
		this.panLimitMinX = minX;
		this.panLimitMaxX = maxX;
		this.panLimitMinZ = minZ;
		this.panLimitMaxZ = maxZ;
		this.setPanOffset(this.panOffset.x, this.panOffset.z);
	}

	/** Height (world Y) of the ground plane drag-to-pan projects onto. Default 0. */
	setPanGroundHeight(y: number): void {
		this.panPlane.constant = -y;
	}

	/**
	 * Begin a grab-and-drag pan. Records the world point currently under the
	 * cursor (projected onto the pan ground plane). Pair with panTo()/endPan().
	 * `clientX/clientY` are pointer-event viewport coordinates (same space the
	 * camera's own DOM listeners use).
	 */
	beginPan(clientX: number, clientY: number): void {
		this.panGrabPoint = this.screenToPanPlane(clientX, clientY);
	}

	/**
	 * Continue a grab-and-drag pan started with beginPan(): instantly shift the
	 * view so the grabbed world point sits back under the cursor. Because the
	 * pan is applied with no smoothing and the camera is re-evaluated in place,
	 * the grabbed point tracks the cursor 1:1 with no feedback drift — unlike
	 * moving a smoothed follow target.
	 */
	panTo(clientX: number, clientY: number): void {
		if (!this.panGrabPoint) {
			// beginPan missed the plane (e.g. cursor over sky) — acquire now.
			this.panGrabPoint = this.screenToPanPlane(clientX, clientY);
			return;
		}
		const hit = this.screenToPanPlane(clientX, clientY);
		if (!hit) return;
		this.panBy(this.panGrabPoint.x - hit.x, this.panGrabPoint.z - hit.z);
		// Re-evaluate the camera now so a follow-up panTo in the same frame
		// raycasts against the updated pose (no over-pan).
		this.applyCameraTransform();
	}

	/** End a grab-and-drag pan started with beginPan(). */
	endPan(): void {
		this.panGrabPoint = null;
	}

	/** Project a viewport point onto the pan ground plane (world), or null if the ray misses. */
	private screenToPanPlane(clientX: number, clientY: number): THREE.Vector3 | null {
		const rect = this.domElement.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return null;
		const ndc = new THREE.Vector2(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		this.camera.updateMatrixWorld();
		this.panRaycaster.setFromCamera(ndc, this.camera);
		const hit = new THREE.Vector3();
		return this.panRaycaster.ray.intersectPlane(this.panPlane, hit) ? hit : null;
	}

	dispose(): void {
		// If we're still the active (ortho) render camera, hand control back to
		// the perspective camera (and restore the skybox) before tearing down.
		if (this.fitWorld && this.engine.camera === this.orthoCamera) {
			this.clearFitWorldBackground();
			this.engine.setRenderCamera(this.camera);
		}
		this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.removeEventListener('touchstart', this.boundOnTouchStart);
		this.domElement.removeEventListener('touchend', this.boundOnTouchEnd);
		this.domElement.removeEventListener('touchmove', this.boundOnTouchMove);
		this.domElement.removeEventListener('wheel', this.boundOnWheel);
		this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
		document.removeEventListener('mousemove', this.boundOnDocumentMouseMove);
	}
}
