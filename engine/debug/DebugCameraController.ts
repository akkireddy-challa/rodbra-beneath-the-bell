// Type checking enabled
import * as THREE from 'three';

// Maps keyboard codes to the movement-key flags on `this.keys`.
const MOVEMENT_KEYS: Record<string, string> = {
    KeyW: 'forward',
    KeyS: 'backward',
    KeyA: 'left',
    KeyD: 'right',
    KeyQ: 'up',
    KeyE: 'down'
};

/**
 * Debug camera controller for free movement in editor mode
 * Similar to Unity Scene View camera with WASD+QE movement and mouse look
 */
export class DebugCameraController {
    [key: string]: any;
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
        this.camera = camera;
        this.domElement = domElement;
        
        // Camera settings
        this.moveSpeed = 10.0;
        this.fastMoveMultiplier = 4.0;  // Hold Shift to fly faster across large levels
        this.mouseSensitivity = 0.004;
        this.dampingFactor = 0.1;
        
        // Camera state
        this.isActive = false;
        this._enabled = true;  // Can be disabled temporarily (e.g., when TransformControls is dragging)
        this._shouldIgnoreInput = null;  // Optional callback to check if input should be ignored
        // Optional callback: returns true when a terrain/voxel edit sub-mode is
        // using Shift+WASD (e.g. nudging selected voxels), so the camera defers
        // its Shift "fly faster" modifier to it instead of also flying.
        this._shiftReservedForEditing = null;
        this.position = new THREE.Vector3();
        this.targetPosition = new THREE.Vector3();
        
        // Use spherical coordinates like the game camera
        this.spherical = new THREE.Spherical();
        this.targetSpherical = new THREE.Spherical();
        
        // Input state
        this.keys = {
            forward: false,    // W
            backward: false,   // S
            left: false,       // A
            right: false,      // D
            up: false,         // Q
            down: false,       // E
            fast: false        // Shift (fly faster)
        };
        
        this.mouse = {
            x: 0,
            y: 0,
            deltaX: 0,
            deltaY: 0,
            isDown: false
        };
        
        // Movement vectors
        this.moveDirection = new THREE.Vector3();
        this.forward = new THREE.Vector3();
        this.right = new THREE.Vector3();
        this.up = new THREE.Vector3(0, 1, 0);
        
        // Invisible target for third-person style movement
        this.target = new THREE.Vector3();
        this.targetDistance = 5.0;
        this.minDistance = 1.0;
        this.maxDistance = 50.0;
        
        // Event handlers
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onKeyUp = this.onKeyUp.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onContextMenu = this.onContextMenu.bind(this);
    }

    /**
     * Add all DOM event listeners. Listeners are only attached while active.
     */
    private addEventListeners() {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('keyup', this.onKeyUp);
        this.domElement.addEventListener('mousedown', this.onMouseDown);
        this.domElement.addEventListener('mouseup', this.onMouseUp);
        this.domElement.addEventListener('mousemove', this.onMouseMove);
        this.domElement.addEventListener('wheel', this.onWheel);
        this.domElement.addEventListener('contextmenu', this.onContextMenu);
    }

    /**
     * Remove all DOM event listeners. Safe to call when none are attached.
     */
    private removeEventListeners() {
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('keyup', this.onKeyUp);
        this.domElement.removeEventListener('mousedown', this.onMouseDown);
        this.domElement.removeEventListener('mouseup', this.onMouseUp);
        this.domElement.removeEventListener('mousemove', this.onMouseMove);
        this.domElement.removeEventListener('wheel', this.onWheel);
        this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    }

    /**
     * Reset all movement key flags (e.g. to avoid stuck movement when disabled).
     */
    private resetKeys() {
        Object.keys(this.keys).forEach(key => this.keys[key] = false);
    }

    /**
     * Activate debug camera controls
     */
    activate(fromCamera: THREE.PerspectiveCamera | null = null) {
        this.isActive = true;

        // Start from a clean listener set — activate() may be called repeatedly.
        this.removeEventListeners();

        // Copy current camera state if provided
        if (fromCamera) {
            this.position.copy(fromCamera.position);
            this.target.copy(fromCamera.position);
            
            // Calculate spherical coordinates from current camera position/rotation
            const direction = new THREE.Vector3();
            fromCamera.getWorldDirection(direction);
            direction.negate(); // Camera looks in negative Z, we want the direction TO the camera
            
            // Convert direction to spherical coordinates
            this.spherical.setFromVector3(direction.multiplyScalar(this.targetDistance));
            this.targetSpherical.copy(this.spherical);
            
            // Ensure proper phi range (0 to PI, where PI/2 is horizontal)
            this.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi));
            this.targetSpherical.phi = this.spherical.phi;
        } else {
            // Default position
            this.position.set(0, 5, 10);
            this.target.set(0, 0, 0);
            this.spherical.set(this.targetDistance, Math.PI / 2, 0);
            this.targetSpherical.copy(this.spherical);
        }
        
        this.targetPosition.copy(this.position);

        this.addEventListeners();
    }
    
    /**
     * Enable or disable camera controls temporarily
     * Used to prevent camera movement while TransformControls is dragging
     */
    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
        if (!enabled) {
            // Reset all movement keys to prevent stuck movement
            this.resetKeys();
            this.mouse.isDown = false;
        }
    }

    /**
     * Check if camera controls are enabled
     */
    isEnabled(): boolean {
        return this._enabled;
    }

    /**
     * Set a callback to check if input should be ignored
     * Used to prevent camera movement when TransformControls gizmo is active
     */
    setShouldIgnoreInput(callback: (() => boolean) | null): void {
        this._shouldIgnoreInput = callback;
    }

    /**
     * Set a callback that returns true while a terrain/voxel edit sub-mode is
     * using Shift+WASD, so the camera's Shift "fly faster" modifier defers to it
     * instead of also flying. When unset, Shift always means "fly faster".
     */
    setShiftReservedCallback(callback: (() => boolean) | null): void {
        this._shiftReservedForEditing = callback;
    }

    private isShiftReservedForEditing(): boolean {
        return this._shiftReservedForEditing ? this._shiftReservedForEditing() : false;
    }

    /**
     * Check if input should currently be ignored
     */
    private shouldIgnoreInput(): boolean {
        return this._shouldIgnoreInput ? this._shouldIgnoreInput() : false;
    }

    /**
     * Deactivate debug camera controls
     */
    deactivate() {
        if (!this.isActive) return;
        
        this.isActive = false;

        this.removeEventListeners();

        // Reset input state
        this.resetKeys();
        this.mouse.isDown = false;
    }
    
    /**
     * Focus camera on a specific object or position
     */
    focusOn(target: THREE.Object3D | THREE.Vector3, distance: number | null = null) {
        if (!this.isActive) return;
        
        const targetPos = new THREE.Vector3();
        let boundingBox = null;
        
        // Get target position and bounding box
        if (target instanceof THREE.Vector3) {
            targetPos.copy(target);
        } else if (target && target.position) {
            targetPos.copy(target.position);
            
            // Try to get bounding box for better camera positioning
            try {
                boundingBox = new THREE.Box3().setFromObject(target);
                if (!boundingBox.isEmpty()) {
                    // Use bounding box center as target
                    boundingBox.getCenter(targetPos);
                }
            } catch (error) {
                // Fallback to object position
            }
        } else if (target && target.getWorldPosition) {
            target.getWorldPosition(targetPos);
        } else {
            return;
        }
        
        // Calculate optimal camera distance and angle
        let optimalDistance = this.targetDistance;
        
        if (boundingBox && !boundingBox.isEmpty()) {
            // Calculate distance needed to fit the entire bounding box in view
            const size = boundingBox.getSize(new THREE.Vector3());
            const maxDimension = Math.max(size.x, size.y, size.z);
            
            // Calculate distance based on camera field of view
            const fov = this.camera.fov * Math.PI / 180; // Convert to radians
            const distance = (maxDimension / 2) / Math.tan(fov / 2);
            
            // Add some padding (50% extra distance for comfortable viewing)
            optimalDistance = Math.max(distance * 1.5, this.minDistance);
            optimalDistance = Math.min(optimalDistance, this.maxDistance);
        }
        
        // Set target position
        this.target.copy(targetPos);
        
        // Use provided distance or calculated optimal distance
        if (distance !== null) {
            this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, distance));
        } else {
            this.targetDistance = optimalDistance;
        }
        this.targetSpherical.radius = this.targetDistance;
        
        // Position camera at a nice angle (slightly above and to the side)
        this.targetSpherical.theta = Math.PI / 4; // 45 degrees around Y-axis
        this.targetSpherical.phi = Math.PI / 3; // 60 degrees from vertical (30 degrees above horizontal)
        
        // Calculate new camera position using spherical coordinates
        const offset = new THREE.Vector3();
        offset.setFromSpherical(this.targetSpherical);
        this.targetPosition.copy(targetPos).add(offset);
    }
    
    /**
     * Update camera position and rotation
     */
    update(deltaTime: number) {
        if (!this.isActive) return;

        // Handle movement input (only if enabled)
        if (this._enabled) {
            this.updateMovement(deltaTime);
        }
        
        // Apply damping to smooth movement and rotation
        this.position.lerp(this.targetPosition, this.dampingFactor);
        this.spherical.theta += (this.targetSpherical.theta - this.spherical.theta) * this.dampingFactor;
        this.spherical.phi += (this.targetSpherical.phi - this.spherical.phi) * this.dampingFactor;
        this.spherical.radius += (this.targetSpherical.radius - this.spherical.radius) * this.dampingFactor;
        
        // Calculate camera rotation from spherical coordinates
        const offset = new THREE.Vector3();
        offset.setFromSpherical(this.spherical);
        
        // Position camera and make it look at the target
        this.camera.position.copy(this.position);
        this.camera.lookAt(this.position.clone().add(offset.clone().negate()));
        
        // Update target to be in front of camera for movement
        this.target.copy(this.position).add(offset.clone().negate());
    }
    
    /**
     * Update movement based on input
     */
    updateMovement(deltaTime: number) {
        // Calculate movement direction
        this.moveDirection.set(0, 0, 0);
        
        // Derive the movement basis from the editor camera's OWN look state
        // (the spherical), NOT camera.getWorldDirection(). A running game can
        // re-stamp the shared camera's orientation every frame — e.g. a fixed /
        // locked gameplay camera that calls lookAt in its update, which runs
        // before this — so getWorldDirection() returns the game's facing, making
        // WASD move that way no matter where the editor is actually looking. The
        // spherical is the editor's own look direction and is immune to that.
        // (camera looks toward -offset, so forward = -setFromSpherical().)
        this.forward.setFromSpherical(this.spherical).negate().normalize();
        this.right.crossVectors(this.forward, this.up).normalize();
        
        // WASD movement (relative to camera rotation)
        if (this.keys.forward) {
            this.moveDirection.add(this.forward);
        }
        if (this.keys.backward) {
            this.moveDirection.sub(this.forward);
        }
        if (this.keys.left) {
            this.moveDirection.sub(this.right);
        }
        if (this.keys.right) {
            this.moveDirection.add(this.right);
        }
        
        // QE vertical movement
        if (this.keys.up) {
            this.moveDirection.add(this.up);
        }
        if (this.keys.down) {
            this.moveDirection.sub(this.up);
        }
        
        // Normalize and apply speed
        if (this.moveDirection.length() > 0) {
            this.moveDirection.normalize();
            const speed = this.moveSpeed * (this.keys.fast ? this.fastMoveMultiplier : 1);
            this.moveDirection.multiplyScalar(speed * deltaTime);
            this.targetPosition.add(this.moveDirection);
            
            // Update target to be in front of camera based on current look direction
            const lookOffset = new THREE.Vector3();
            lookOffset.setFromSpherical(this.targetSpherical);
            this.target.copy(this.targetPosition).add(lookOffset.clone().negate());
        }
    }
    
    /**
     * Keyboard event handlers
     */
    onKeyDown(event: KeyboardEvent) {
        if (!this.isActive || !this._enabled) return;

        // Shift = "fly faster" modifier. Track it on every keydown so either
        // press order (Shift-then-W or W-then-Shift) speeds up movement.
        this.keys.fast = event.shiftKey;
        if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return;

        // Defer Shift+WASD to a terrain/voxel edit sub-mode when it's actively
        // using those keys (e.g. nudging selected voxels); otherwise Shift+WASD
        // is just the camera flying fast.
        if (event.shiftKey && this.isShiftReservedForEditing()) return;

        const dir = MOVEMENT_KEYS[event.code];
        if (dir) this.keys[dir] = true;
    }

    onKeyUp(event: KeyboardEvent) {
        if (!this.isActive) return;

        // Releasing Shift drops back to normal speed (event.shiftKey is false on
        // the Shift keyup, and stays true when releasing W/A/S/D mid-sprint).
        this.keys.fast = event.shiftKey;

        const dir = MOVEMENT_KEYS[event.code];
        if (dir) this.keys[dir] = false;
    }
    
    /**
     * Mouse event handlers
     */
    onMouseDown(event: MouseEvent) {
        if (!this.isActive || !this._enabled) return;
        // Check if input should be ignored (e.g., TransformControls gizmo is being used)
        if (this.shouldIgnoreInput()) return;

        this.mouse.isDown = true;
        this.mouse.x = event.clientX;
        this.mouse.y = event.clientY;
        
        event.preventDefault();
    }
    
    onMouseUp(event: MouseEvent) {
        if (!this.isActive) return;
        
        this.mouse.isDown = false;
        event.preventDefault();
    }
    
    onMouseMove(event: MouseEvent) {
        if (!this.isActive || !this._enabled || !this.mouse.isDown) return;
        
        this.mouse.deltaX = event.clientX - this.mouse.x;
        this.mouse.deltaY = event.clientY - this.mouse.y;
        
        // Apply mouse sensitivity to spherical coordinates (like the game camera)
        this.targetSpherical.theta -= this.mouse.deltaX * this.mouseSensitivity;
        this.targetSpherical.phi -= this.mouse.deltaY * this.mouseSensitivity;
        
        // Clamp phi to prevent camera flipping (same as game camera)
        this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
        
        this.mouse.x = event.clientX;
        this.mouse.y = event.clientY;
        
        event.preventDefault();
    }
    
    onWheel(event: WheelEvent) {
        if (!this.isActive) return;
        
        // Adjust movement speed with wheel
        const speedMultiplier = event.deltaY > 0 ? 0.9 : 1.1;
        this.moveSpeed = Math.max(0.1, Math.min(100, this.moveSpeed * speedMultiplier));
        
        event.preventDefault();
    }
    
    onContextMenu(event: MouseEvent) {
    }
    
    /**
     * Get current camera state for saving/restoring
     */
    getCameraState(): { position: THREE.Vector3; spherical: THREE.Spherical; target: THREE.Vector3; distance: number } {
        return {
            position: this.position.clone(),
            spherical: this.spherical.clone(),
            target: this.target.clone(),
            distance: this.targetDistance
        };
    }
    
    /**
     * Set camera state
     */
    setCameraState(state: { position?: THREE.Vector3; spherical?: THREE.Spherical; target?: THREE.Vector3; distance?: number }) {
        if (state.position) this.targetPosition.copy(state.position);
        if (state.spherical) this.targetSpherical.copy(state.spherical);
        if (state.target) this.target.copy(state.target);
        if (state.distance) this.targetDistance = state.distance;
    }
    
    /**
     * Dispose of the debug camera controller
     */
    dispose() {
        this.deactivate();
    }
}
