import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { ICameraController, CameraMode } from 'engine/ICameraController.js';
import { Spring1 } from 'engine/viewmodel/Spring.js';

/** How a weapon's kick is felt in the view. See applyViewPunch. */
export interface ViewPunchOptions {
    /**
     * Fraction of the kick that springs back, 0..1.
     *
     * 1 = purely cosmetic; the player's aim is provably unchanged by firing.
     * Below 1 the remainder becomes a real aim change to fight. This is a
     * per-weapon gameplay dial, carried on the weapon's recoil profile.
     */
    recenter: number;
    /** Spring frequency, rad/s. */
    omega: number;
    /**
     * Damping ratio. Critically damped by default: an underdamped view punch
     * makes the aim oscillate after every shot, which is a gameplay bug rather
     * than a look.
     */
    damping: number;
}

export const DEFAULT_VIEW_PUNCH_OPTIONS: ViewPunchOptions = {
    recenter: 1,
    omega: 26,
    damping: 1,
};

/**
 * Anything that can receive a weapon's view punch.
 *
 * Declared so weapon systems can duck-type the active camera controller — a
 * game may be driving a vehicle camera or a custom controller, and firing must
 * not throw just because the camera is not this one.
 */
export interface ViewPunchTarget {
    applyViewPunch(pitchRad: number, yawRad: number, options?: ViewPunchOptions): void;
}

/**
 * First-person camera controller.
 * Camera is positioned at the player's eye level and rotates with mouse movement.
 */
export class FirstPersonCamera implements ICameraController {
    camera: THREE.PerspectiveCamera;
    target: THREE.Object3D;
    domElement: HTMLElement;
    engine: EngineLike;
    
    enabled: boolean = true;
    
    private eyeHeight: number = 1.6;
    private rotationSpeed: number = 0.003;
    
    private yaw: number = 0;
    private pitch: number = 0;
    private targetYaw: number = 0;
    private targetPitch: number = 0;
    
    private isMouseDown: boolean = false;
    private mouseX: number = 0;
    private mouseY: number = 0;
    
    private pointerLocked: boolean = false;
    private pointerLockSupported: boolean = false;
    private editorModeCamera: boolean = false;
    
    private shakeIntensity: number = 0;
    private shakeDecayRate: number = 12;
    private shakeYawOffset: number = 0;
    private shakePitchOffset: number = 0;

    // Weapon view punch. Springs to zero, and is applied in the same additive
    // post-smoothing slot as shake — see applyViewPunch.
    private readonly punchPitch = new Spring1(DEFAULT_VIEW_PUNCH_OPTIONS.omega, DEFAULT_VIEW_PUNCH_OPTIONS.damping);
    private readonly punchYaw = new Spring1(DEFAULT_VIEW_PUNCH_OPTIONS.omega, DEFAULT_VIEW_PUNCH_OPTIONS.damping);

    // Aim-down-sights FOV, mirroring ThirdPersonCamera's offset mechanism.
    private baseFov: number | null = null;
    private targetFov: number | null = null;
    private readonly fovSmoothHalfLife: number = 0.06;

    /** Multiplier on look sensitivity. 1 = unchanged; ADS narrows it. */
    private lookSensitivityScale: number = 1;
    
    private headBobEnabled: boolean = true;
    private headBobAmplitude: number = 0.035;
    private headBobSwayAmplitude: number = 0.02;
    private headBobFrequency: number = 10.0;
    private headBobPhase: number = 0;
    private headBobVerticalOffset: number = 0;
    private headBobHorizontalOffset: number = 0;
    private lastTargetPosition: THREE.Vector3 = new THREE.Vector3();
    private movementSpeed: number = 0;
    
    private boundOnMouseDown: (event: MouseEvent) => void;
    private boundOnMouseUp: (event: MouseEvent) => void;
    private boundOnMouseMove: (event: MouseEvent) => void;
    private boundOnDocumentMouseMove: (event: MouseEvent) => void;
    private boundOnTouchStart: (event: TouchEvent) => void;
    private boundOnTouchEnd: (event: TouchEvent) => void;
    private boundOnTouchMove: (event: TouchEvent) => void;
    private boundOnContextMenu: (event: Event) => void;
    
    public disableBuiltInTouchControls: boolean = false;
    
    constructor(
        camera: THREE.PerspectiveCamera,
        target: THREE.Object3D,
        domElement: HTMLElement,
        engine: EngineLike,
        options?: {
            eyeHeight?: number;
            rotationSpeed?: number;
            headBobEnabled?: boolean;
            headBobAmplitude?: number;
            headBobSwayAmplitude?: number;
            headBobFrequency?: number;
        }
    ) {
        this.camera = camera;
        this.target = target;
        this.domElement = domElement;
        this.engine = engine;
        
        if (options?.eyeHeight !== undefined) this.eyeHeight = options.eyeHeight;
        if (options?.rotationSpeed !== undefined) this.rotationSpeed = options.rotationSpeed;
        if (options?.headBobEnabled !== undefined) this.headBobEnabled = options.headBobEnabled;
        if (options?.headBobAmplitude !== undefined) this.headBobAmplitude = options.headBobAmplitude;
        if (options?.headBobSwayAmplitude !== undefined) this.headBobSwayAmplitude = options.headBobSwayAmplitude;
        if (options?.headBobFrequency !== undefined) this.headBobFrequency = options.headBobFrequency;
        
        this.target.getWorldPosition(this.lastTargetPosition);
        
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnDocumentMouseMove = this.onDocumentMouseMove.bind(this);
        this.boundOnTouchStart = this.onTouchStart.bind(this);
        this.boundOnTouchEnd = this.onTouchEnd.bind(this);
        this.boundOnTouchMove = this.onTouchMove.bind(this);
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
        this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
        document.addEventListener('mousemove', this.boundOnDocumentMouseMove);
    }
    
    private shouldProcessInput(): boolean {
        if (document.pointerLockElement) return true;
        if (this.engine && !this.engine.isWindowFocused) return false;
        if (this.engine && this.engine.editorManager && this.engine.editorManager.isEditorMode) return false;
        return true;
    }
    
    /**
     * Apply a look delta in radians: yaw first, then pitch clamped to just
     * short of straight up/down. Shared by mouse-drag, pointer-lock, touch and
     * external (mobile look-stick) input.
     */
    private applyLookDelta(yawDelta: number, pitchDelta: number): void {
        this.targetYaw -= yawDelta * this.lookSensitivityScale;
        this.targetPitch -= pitchDelta * this.lookSensitivityScale;
        this.targetPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.targetPitch));
    }

    /**
     * Scale look sensitivity. 1 restores the configured speed.
     *
     * Aiming down sights narrows the FOV, and a player with any shooter muscle
     * memory expects the mouse to slow by the same factor — the tangent-matched
     * ratio tan(fovAds/2) / tan(fovBase/2), which keeps centimetres of mouse
     * movement mapped to the same on-screen distance at both zoom levels.
     */
    setLookSensitivityScale(scale: number): void {
        this.lookSensitivityScale = scale > 0 ? scale : 1;
    }

    getLookSensitivityScale(): number {
        return this.lookSensitivityScale;
    }

    /**
     * A transient kick to where the player is looking — the recoil of a weapon
     * felt in the view rather than only seen on the gun.
     *
     * Two channels, and the split is the whole design:
     *
     *  - The VISUAL kick is an additive offset that springs back to zero. It is
     *    applied after the yaw/pitch smoothing, in the same slot shake already
     *    occupies, so it cannot fight the smoothing or be eaten by it.
     *  - The PERMANENT share — `1 - recenter` of the kick — goes through
     *    applyLookDelta, which means it is a real aim change and is pitch-clamped
     *    like every other input.
     *
     * At `recenter: 1` the aim is provably untouched and the punch is pure
     * decoration; below it, sustained fire climbs and the player pulls down
     * against it. That is a per-weapon gameplay decision, so it arrives here
     * from the weapon's own recoil profile rather than being an engine constant.
     *
     * Positive `pitchRad` raises the view.
     */
    applyViewPunch(
        pitchRad: number,
        yawRad: number,
        options: ViewPunchOptions = DEFAULT_VIEW_PUNCH_OPTIONS,
    ): void {
        this.punchPitch.setResponse(options.omega, options.damping);
        this.punchYaw.setResponse(options.omega, options.damping);
        this.punchPitch.addImpulsePeak(pitchRad);
        this.punchYaw.addImpulsePeak(yawRad);

        const keep = 1 - Math.max(0, Math.min(1, options.recenter));
        if (keep > 0) this.applyLookDelta(-yawRad * keep, -pitchRad * keep);
    }

    /**
     * Narrow (positive `deltaDeg` widens) the FOV relative to the configured
     * base. The base is captured on the first call so it survives across frames.
     * Semantics match ThirdPersonCamera.setFovOffset, so anything that
     * duck-types one camera works with the other.
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
        if (this.baseFov !== null && this.targetFov === this.baseFov && Math.abs(next - this.baseFov) < 0.01) {
            this.camera.fov = this.baseFov;
            this.camera.updateProjectionMatrix();
            this.targetFov = null;
            this.baseFov = null;
        }
    }

    private onMouseDown(event: MouseEvent): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        if (!this.editorModeCamera && document.pointerLockElement) return;
        if (event.button === 0) {
            this.isMouseDown = true;
            this.mouseX = event.clientX;
            this.mouseY = event.clientY;
            this.domElement.style.cursor = 'grabbing';
        }
    }
    
    private onMouseUp(event: MouseEvent): void {
        if (!this.editorModeCamera && document.pointerLockElement) return;
        if (event.button === 0) {
            this.isMouseDown = false;
            this.domElement.style.cursor = 'grab';
        }
    }
    
    private onMouseMove(event: MouseEvent): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        if (document.pointerLockElement) return;
        if (!this.isMouseDown) return;
        
        const deltaX = event.clientX - this.mouseX;
        const deltaY = event.clientY - this.mouseY;
        this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;
    }

    private onDocumentMouseMove(event: MouseEvent): void {
        if (!document.pointerLockElement) return;
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;

        const deltaX = event.movementX || 0;
        const deltaY = event.movementY || 0;
        this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);
    }
    
    private onTouchStart(event: TouchEvent): void {
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
    
    private onTouchEnd(): void {
        this.isMouseDown = false;
    }
    
    private onTouchMove(event: TouchEvent): void {
        if (!this.enabled || !this.isMouseDown || event.touches.length !== 1 || !event.touches[0]) return;
        if (!this.shouldProcessInput()) return;
        if (this.disableBuiltInTouchControls) return;
        event.preventDefault();
        
        const deltaX = event.touches[0].clientX - this.mouseX;
        const deltaY = event.touches[0].clientY - this.mouseY;
        this.applyLookDelta(deltaX * this.rotationSpeed, deltaY * this.rotationSpeed);
        this.mouseX = event.touches[0].clientX;
        this.mouseY = event.touches[0].clientY;
    }

    applyExternalDelta(deltaX: number, deltaY: number): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;

        this.applyLookDelta(deltaX, deltaY);
    }
    
    update(deltaTime: number): void {
        if (!this.enabled || !this.target) return;
        
        const dt = Math.max(deltaTime || 0, 1/120);
        
        this.updateShake(dt);
        this.updateHeadBob(dt);
        this.updateFov(dt);
        this.punchPitch.integrate(dt);
        this.punchYaw.integrate(dt);

        const smoothHalfLife = 0.05;
        this.yaw = this.smoothTowards(this.yaw, this.targetYaw, smoothHalfLife, dt);
        this.pitch = this.smoothTowards(this.pitch, this.targetPitch, smoothHalfLife, dt);
        
        const targetWorld = new THREE.Vector3();
        this.target.getWorldPosition(targetWorld);
        
        const right = this.getRightVector();
        
        this.camera.position.set(
            targetWorld.x + right.x * this.headBobHorizontalOffset,
            targetWorld.y + this.eyeHeight + this.headBobVerticalOffset,
            targetWorld.z + right.z * this.headBobHorizontalOffset
        );
        
        // In first-person mode, player must rotate with camera.
        // +PI because camera forward at yaw=0 is -Z, but model forward at rotation.y=0 is +Z.
        // Without this, remote players see the character facing 180° backwards.
        // (Third-person doesn't need this because atan2(moveDir.x, moveDir.z) naturally produces yaw+PI.)
        this.target.rotation.y = this.yaw + Math.PI;
        
        // Shake and weapon punch are both ADDITIVE and both applied here, after
        // the smoothing — so neither can be swallowed by it, and neither
        // disturbs the yaw/pitch the player's input actually owns.
        const euler = new THREE.Euler(
            this.pitch + this.shakePitchOffset + this.punchPitch.getValue(),
            this.yaw + this.shakeYawOffset + this.punchYaw.getValue(),
            0,
            'YXZ'
        );
        this.camera.quaternion.setFromEuler(euler);
    }
    
    private updateHeadBob(deltaTime: number): void {
        if (!this.headBobEnabled) {
            this.headBobVerticalOffset = 0;
            this.headBobHorizontalOffset = 0;
            return;
        }
        
        const targetWorld = new THREE.Vector3();
        this.target.getWorldPosition(targetWorld);
        
        const dx = targetWorld.x - this.lastTargetPosition.x;
        const dz = targetWorld.z - this.lastTargetPosition.z;
        const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
        
        const currentSpeed = deltaTime > 0 ? horizontalDistance / deltaTime : 0;
        this.movementSpeed = this.movementSpeed * 0.8 + currentSpeed * 0.2;
        
        this.lastTargetPosition.copy(targetWorld);
        
        const speedThreshold = 0.5;
        if (this.movementSpeed > speedThreshold) {
            const speedFactor = Math.min(this.movementSpeed / 5.0, 1.0);
            this.headBobPhase += deltaTime * this.headBobFrequency * speedFactor;
            
            this.headBobVerticalOffset = Math.sin(this.headBobPhase * 2) * this.headBobAmplitude * speedFactor;
            this.headBobHorizontalOffset = Math.sin(this.headBobPhase) * this.headBobSwayAmplitude * speedFactor;
        } else {
            this.headBobVerticalOffset *= 0.9;
            this.headBobHorizontalOffset *= 0.9;
        }
    }
    
    private smoothTowards(current: number, target: number, halfLife: number, dt: number): number {
        const a = Math.pow(0.5, dt / Math.max(halfLife, 1e-4));
        return current * a + target * (1 - a);
    }
    
    private updateShake(deltaTime: number): void {
        if (this.shakeIntensity <= 0.001) {
            this.shakeYawOffset = 0;
            this.shakePitchOffset = 0;
            this.shakeIntensity = 0;
            return;
        }
        
        this.shakeYawOffset = (Math.random() - 0.5) * 2 * this.shakeIntensity;
        this.shakePitchOffset = this.shakePitchOffset * 0.8 + (Math.random() - 0.5) * this.shakeIntensity * 0.5;
        this.shakeIntensity *= Math.pow(0.5, deltaTime * this.shakeDecayRate);
    }
    
    getForwardVector(): THREE.Vector3 {
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(this.camera.quaternion);
        forward.y = 0;
        forward.normalize();
        return forward;
    }
    
    getRightVector(): THREE.Vector3 {
        const forward = this.getForwardVector();
        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
        right.normalize();
        return right;
    }
    
    getCamera(): THREE.PerspectiveCamera {
        return this.camera;
    }
    
    setTarget(newTarget: THREE.Object3D): void {
        this.target = newTarget;
        console.log('FirstPersonCamera: Target updated');
    }
    
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.isMouseDown = false;
            this.domElement.style.cursor = 'default';
        } else if (this.editorModeCamera || (!this.pointerLocked && !this.pointerLockSupported)) {
            this.domElement.style.cursor = 'grab';
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
        } else if (this.pointerLockSupported) {
            this.domElement.style.cursor = 'default';
        }
    }
    
    getHorizontalAngle(): number {
        return this.yaw;
    }
    
    getTargetHorizontalAngle(): number {
        return this.targetYaw;
    }

    getMode(): CameraMode {
        return 'first-person';
    }

    setHorizontalAngle(angle: number): void {
        this.yaw = angle;
        this.targetYaw = angle;
    }
    
    setVerticalAngle(angle: number): void {
        this.pitch = -angle;
        this.targetPitch = -angle;
    }
    
    getVerticalAngle(): number {
        return Math.PI / 2 - this.pitch;
    }
    
    getPitchAngle(): number {
        return -this.pitch;
    }
    
    setEyeHeight(height: number): void {
        this.eyeHeight = height;
    }
    
    getEyeHeight(): number {
        return this.eyeHeight;
    }
    
    setHeadBobEnabled(enabled: boolean): void {
        this.headBobEnabled = enabled;
    }
    
    setHeadBobAmplitude(amplitude: number): void {
        this.headBobAmplitude = amplitude;
    }
    
    setHeadBobSwayAmplitude(amplitude: number): void {
        this.headBobSwayAmplitude = amplitude;
    }
    
    setHeadBobFrequency(frequency: number): void {
        this.headBobFrequency = frequency;
    }
    
    applyShake(intensity: number = 0.03): void {
        this.shakeIntensity = Math.min(this.shakeIntensity + intensity, intensity * 3);
        this.shakePitchOffset = -intensity * 1.5;
    }
    
    dispose(): void {
        this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
        this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
        this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
        this.domElement.removeEventListener('touchstart', this.boundOnTouchStart);
        this.domElement.removeEventListener('touchend', this.boundOnTouchEnd);
        this.domElement.removeEventListener('touchmove', this.boundOnTouchMove);
        this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
        document.removeEventListener('mousemove', this.boundOnDocumentMouseMove);
    }
}
