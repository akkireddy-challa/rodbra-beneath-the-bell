import * as THREE from 'three';

/**
 * Vehicle (gameplay: local +Z forward) -> camera (local -Z forward) basis change.
 * The inter-convention bridge described in agent-docs/coordinate-system.md 2b --
 * the same job FirstPersonCamera does with `yaw + Math.PI`. Without it the
 * driver's-eye view stares out of the rear window. Not an asset-load flip;
 * do not "simplify" it away.
 */
const VEHICLE_TO_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/**
 * First-person vehicle camera that sits at a configurable driver's-eye offset
 * inside the vehicle chassis. Orientation is locked to the vehicle by default;
 * the player can free-look by dragging the mouse.
 *
 * Implements the same minimal interface as VehicleCamera so that
 * PlayerController can use it interchangeably.
 */
export class FirstPersonVehicleCamera {
	private camera: THREE.PerspectiveCamera;
	private target: THREE.Object3D;
	private domElement: HTMLElement;

	private enabled: boolean = true;

	// Driver's-eye offset relative to vehicle chassis origin
	private seatOffset: THREE.Vector3 = new THREE.Vector3(0, 1.2, 0.3);

	// Free-look state
	private freeLookYaw: number = 0;
	private freeLookPitch: number = 0;
	private freeLookActive: boolean = false;
	private freeLookReturnSpeed: number = 4;
	private mouseSensitivity: number = 0.002;
	private maxPitch: number = Math.PI / 3;

	private isMouseDown: boolean = false;
	private mouseX: number = 0;
	private mouseY: number = 0;

	private boundOnMouseDown: (event: MouseEvent) => void;
	private boundOnMouseUp: (event: MouseEvent) => void;
	private boundOnMouseMove: (event: MouseEvent) => void;
	private boundOnContextMenu: (event: Event) => void;

	constructor(
		camera: THREE.PerspectiveCamera,
		target: THREE.Object3D,
		domElement: HTMLElement,
		_engine: unknown = null
	) {
		this.camera = camera;
		this.target = target;
		this.domElement = domElement;

		this.boundOnMouseDown = this.onMouseDown.bind(this);
		this.boundOnMouseUp = this.onMouseUp.bind(this);
		this.boundOnMouseMove = this.onMouseMove.bind(this);
		this.boundOnContextMenu = (e: Event) => e.preventDefault();

		this.setupEventListeners();
		this.snapToTarget();
	}

	private setupEventListeners(): void {
		this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.addEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
	}

	private onMouseDown(event: MouseEvent): void {
		if (!this.enabled) return;
		if (event.button === 0) {
			this.isMouseDown = true;
			this.freeLookActive = true;
			this.mouseX = event.clientX;
			this.mouseY = event.clientY;
			this.domElement.style.cursor = 'grabbing';
		}
	}

	private onMouseUp(event: MouseEvent): void {
		if (event.button === 0) {
			this.isMouseDown = false;
			this.domElement.style.cursor = 'default';
		}
	}

	private onMouseMove(event: MouseEvent): void {
		if (!this.enabled || !this.isMouseDown) return;

		const deltaX = event.clientX - this.mouseX;
		const deltaY = event.clientY - this.mouseY;

		// Decrement to turn right on a right-drag (coordinate-system.md 3), matching FirstPersonCamera.
		this.freeLookYaw -= deltaX * this.mouseSensitivity;
		this.freeLookPitch -= deltaY * this.mouseSensitivity;
		this.freeLookPitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.freeLookPitch));

		this.mouseX = event.clientX;
		this.mouseY = event.clientY;
	}

	/** Snap camera to current target position immediately (no interpolation). */
	private snapToTarget(): void {
		this.target.updateWorldMatrix(true, false);
		this.updateCameraTransform();
	}

	public setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.isMouseDown = false;
			this.domElement.style.cursor = 'default';
		}
	}

	public update(deltaTime: number): void {
		if (!this.enabled || !this.target) return;

		// Return free-look to centre when mouse is released
		if (!this.isMouseDown && this.freeLookActive) {
			const decay = 1 - Math.exp(-this.freeLookReturnSpeed * deltaTime);
			this.freeLookYaw *= (1 - decay);
			this.freeLookPitch *= (1 - decay);
			if (Math.abs(this.freeLookYaw) < 0.001 && Math.abs(this.freeLookPitch) < 0.001) {
				this.freeLookYaw = 0;
				this.freeLookPitch = 0;
				this.freeLookActive = false;
			}
		}

		this.updateCameraTransform();
	}

	private updateCameraTransform(): void {
		// World-space seat position
		const worldPos = new THREE.Vector3();
		this.target.getWorldPosition(worldPos);

		const vehicleQuat = new THREE.Quaternion();
		this.target.getWorldQuaternion(vehicleQuat);

		// Offset from chassis origin in vehicle-local space
		const offset = this.seatOffset.clone().applyQuaternion(vehicleQuat);
		worldPos.add(offset);
		this.camera.position.copy(worldPos);

		// Build orientation: vehicle forward + free-look offsets
		const freeLookQuat = new THREE.Quaternion();
		const euler = new THREE.Euler(this.freeLookPitch, this.freeLookYaw, 0, 'YXZ');
		freeLookQuat.setFromEuler(euler);

		// Bridge to the camera basis BEFORE free-look, so pitch still tips the view
		// up on a positive angle and yaw stays in the driver's own frame.
		const finalQuat = vehicleQuat.clone().multiply(VEHICLE_TO_CAMERA).multiply(freeLookQuat);
		this.camera.quaternion.copy(finalQuat);
	}

	public setTarget(newTarget: THREE.Object3D): void {
		this.target = newTarget;
		this.snapToTarget();
	}

	public getTarget(): THREE.Object3D {
		return this.target;
	}

	/** Adjust the driver's-eye offset relative to the vehicle chassis. */
	public setSeatOffset(x: number, y: number, z: number): void {
		this.seatOffset.set(x, y, z);
	}

	public getForwardVector(): THREE.Vector3 {
		const forward = new THREE.Vector3();
		this.camera.getWorldDirection(forward);
		forward.y = 0;
		forward.normalize();
		return forward;
	}

	public getRightVector(): THREE.Vector3 {
		const forward = this.getForwardVector();
		const right = new THREE.Vector3();
		right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
		right.normalize();
		return right;
	}

	public getCamera(): THREE.PerspectiveCamera {
		return this.camera;
	}

	public dispose(): void {
		this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
		this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
		this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
		this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
	}
}
