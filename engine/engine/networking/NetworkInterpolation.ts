// Dead reckoning interpolation for remote (non-owned) network objects.
// Uses velocity-based extrapolation between network updates with smooth correction.
// Applies exponential moving average (EMA) on incoming targets and velocity to
// suppress network jitter. Tuned for 60Hz sync rate (one message per render frame).
//
// Rotation is ALWAYS quaternion-based (slerp). No euler/rotationY fallback.
import * as THREE from 'three';

// Reusable temporaries to avoid per-frame allocations
const _predictedPos = new THREE.Vector3();

export class NetworkInterpolation {
    // Smoothed target state (EMA-filtered from incoming network messages)
    private targetPosition: THREE.Vector3;
    private targetVelocity: THREE.Vector3 = new THREE.Vector3();
    private targetQuaternion: THREE.Quaternion;
    private targetSpeed: number = 0;
    private currentSpeed: number = 0;

    // Time tracking for extrapolation
    private timeSinceLastUpdate: number = 0;

    // Whether we've received at least one target (skip EMA for first message)
    private hasReceivedTarget: boolean = false;

    // Animation state passthrough (discrete, not interpolated)
    private animState: string | undefined;
    private attackId: string | undefined;
    private customAnimId: string | undefined;

    // Steering angle passthrough for vehicles
    private _steeringAngle: number = 0;

    /**
     * Per-frame blend factor toward the predicted target position.
     * Higher = snappier catch-up, lower = smoother but more lag.
     * At 60fps: t = 8 * 0.0167 ≈ 0.13 per frame → converges in ~15 frames (~250ms).
     * Default 8.0.
     */
    lerpFactor: number = 8.0;

    /**
     * Max extrapolation time in seconds. Caps velocity prediction to prevent
     * runaway when messages are delayed. At 60Hz sync, 200ms covers ~12
     * missed frames before capping.
     * Default 0.2.
     */
    maxExtrapolationTime: number = 0.2;

    /**
     * EMA smoothing factor for incoming network positions/velocity (0–1).
     * Lower = more smoothing (less jitter, more lag). Higher = less smoothing.
     * At 60Hz sync (1:1 with frame rate), each message is valuable — use a
     * higher alpha to track closely while still dampening network jitter.
     * Default 0.5.
     */
    targetSmoothing: number = 0.5;

    /**
     * Minimum position delta (squared) to accept a new target.
     * Targets closer than this are ignored to suppress micro-jitter at rest.
     * Default 0.0001 (0.01 units / ~1cm).
     */
    positionDeadZoneSq: number = 0.0001;

    constructor(initialPosition: THREE.Vector3, initialQuaternion: THREE.Quaternion) {
        this.targetPosition = initialPosition.clone();
        this.targetQuaternion = initialQuaternion.clone();
    }

    /** Push a new target state from a received network message. Resets extrapolation timer. */
    setTarget(
        position: THREE.Vector3,
        quaternion: THREE.Quaternion,
        speed: number,
        animState?: string,
        attackId?: string,
        customAnimId?: string,
        velocity?: THREE.Vector3,
        steeringAngle?: number,
    ): void {
        const alpha = this.targetSmoothing;

        if (!this.hasReceivedTarget) {
            // First message: snap directly, no smoothing
            this.targetPosition.copy(position);
            this.targetQuaternion.copy(quaternion);
            this.targetSpeed = speed;
            if (velocity) {
                this.targetVelocity.copy(velocity);
            }
            this.hasReceivedTarget = true;
        } else {
            // EMA-smooth position (only if delta exceeds dead zone)
            const dx = position.x - this.targetPosition.x;
            const dy = position.y - this.targetPosition.y;
            const dz = position.z - this.targetPosition.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq > this.positionDeadZoneSq) {
                this.targetPosition.lerp(position, alpha);
            }

            // EMA-smooth quaternion via slerp
            this.targetQuaternion.slerp(quaternion, alpha);

            // EMA-smooth speed
            this.targetSpeed += (speed - this.targetSpeed) * alpha;

            // EMA-smooth velocity
            if (velocity) {
                this.targetVelocity.lerp(velocity, alpha);
            } else {
                this.targetVelocity.multiplyScalar(1 - alpha);
            }
        }

        this.animState = animState;
        this.attackId = attackId;
        this.customAnimId = customAnimId;
        this.timeSinceLastUpdate = 0;

        if (steeringAngle !== undefined) {
            // EMA-smooth steering angle to match other smoothed values
            this._steeringAngle += (steeringAngle - this._steeringAngle) * alpha;
        }
    }

    /**
     * Advance interpolation with dead reckoning and write result to object3D.
     * Called every frame.
     *
     * Algorithm:
     * 1. Extrapolate predicted position from smoothed target + smoothed velocity * elapsed time
     * 2. Blend current object position toward predicted position (exponential smoothing)
     * 3. Slerp rotation toward target quaternion
     */
    update(deltaTime: number, object3D: THREE.Object3D): void {
        this.timeSinceLastUpdate += deltaTime;
        const t = Math.min(this.lerpFactor * deltaTime, 1.0);

        // 1. Compute predicted position using velocity extrapolation
        const extrapolationDt = Math.min(this.timeSinceLastUpdate, this.maxExtrapolationTime);
        _predictedPos.copy(this.targetPosition);
        if (this.targetVelocity.lengthSq() > 0.0001) {
            _predictedPos.addScaledVector(this.targetVelocity, extrapolationDt);
        }

        // 2. Blend toward predicted position
        object3D.position.lerp(_predictedPos, t);

        // 3. Rotation: always quaternion slerp — unambiguous, no euler edge cases
        object3D.quaternion.slerp(this.targetQuaternion, t);

        // 4. Speed blend
        this.currentSpeed += (this.targetSpeed - this.currentSpeed) * t;
    }

    /** Get the interpolated speed value (useful for animation blending) */
    getCurrentSpeed(): number {
        return this.currentSpeed;
    }

    /** Get the latest animation state (discrete passthrough, not interpolated) */
    getAnimState(): string | undefined {
        return this.animState;
    }

    /** Get the latest attack ID (discrete passthrough) */
    getAttackId(): string | undefined {
        return this.attackId;
    }

    /** Get the latest custom animation ID (discrete passthrough) */
    getCustomAnimId(): string | undefined {
        return this.customAnimId;
    }

    /** Get the latest steering angle in radians (vehicle wheel visuals) */
    getSteeringAngle(): number {
        return this._steeringAngle;
    }
}
