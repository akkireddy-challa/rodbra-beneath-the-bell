import type { Vehicle } from 'engine/Vehicle.js';

/**
 * Key input state passed to extension callbacks
 */
export interface VehicleKeyState {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    ascend: boolean;   // Space key
    descend: boolean;  // Ctrl/Shift key
    action: boolean;   // F key
}

/**
 * Extension interface for custom vehicle controls.
 * Set on a Vehicle via vehicle.setControlsExtension(extension).
 * 
 * Available Vehicle methods for physics (typical car mass ~1500):
 *   applyImpulse(x, y, z)       - Instant force. Jump: (0, mass*5, 0). Boost: (0, 0, mass*3)
 *   applyLocalImpulse(x, y, z)  - Same but relative to vehicle facing
 *   applyForce(x, y, z)         - Continuous force (call each frame)
 *   applyTorque(x, y, z)        - Rotational force. Flip recovery: ~5000
 * 
 * Available Vehicle methods for state:
 *   isGrounded(), getSpeed(), getMass()
 *   getLinearVelocity(), getUpDirection(), getForwardDirection()
 */
export interface VehicleControlsExtension {
    /** Called when Space is pressed. Return true to override default brake. */
    onAscendPressed?: (vehicle: Vehicle, deltaTime: number) => boolean;

    /** Called when Ctrl/Shift is pressed. */
    onDescendPressed?: (vehicle: Vehicle, deltaTime: number) => boolean;

    /** Called when F is pressed. */
    onActionPressed?: (vehicle: Vehicle, deltaTime: number) => boolean;

    /** Called every frame while driving. */
    onUpdate?: (vehicle: Vehicle, deltaTime: number, keys: VehicleKeyState) => void;

    /** Called when player enters/exits the vehicle. */
    onEnterVehicle?: (vehicle: Vehicle) => void;
    onExitVehicle?: (vehicle: Vehicle) => void;

    // UI labels for mobile controls
    ascendDisplayName?: string;   // Default: "Brake"
    descendDisplayName?: string;
    actionDisplayName?: string;

    // Input behavior: 'tap' (single press) or 'continuous' (held)
    ascendBehavior?: 'tap' | 'continuous';
    descendBehavior?: 'tap' | 'continuous';
    actionBehavior?: 'tap' | 'continuous';

    // Show buttons on mobile
    showAscend?: boolean;   // Default: true
    showDescend?: boolean;  // Default: false
    showAction?: boolean;   // Default: false
}
