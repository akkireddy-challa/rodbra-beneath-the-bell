export const DEFAULT_PHYSICS = {
    gravity: -30,
    terminalVelocity: 53.0,
    jumpHeight: 3.0,
    airControlMultiplier: 0.5,
    groundFriction: 0.9,
    airFriction: 0.98,
    walkSpeed: 2.0,
    runSpeed: 5.0,
    /** Max step height walked over silently (no hop) */
    walkStepHeight: 0.25,
    /** Max step height auto-hopped over (requires small velocity boost) */
    hopStepHeight: 0.5,
    /** Interpolation speed for step climbing (units/sec) */
    stepClimbSpeed: 8.0,
};

export const CAPSULE = {
    height: 1.75,
    radius: 0.3,
};
