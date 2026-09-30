import * as THREE from 'three';
import { SeededRandom } from 'engine/SeededRandom.js';
import { expApproach, Spring3 } from 'engine/viewmodel/Spring.js';
import {
    addScaledPose,
    copyPose,
    createPose,
    evaluatePoseCurve,
    mixPose,
    resetPose,
    zeroPose,
    type ViewModelPose,
} from 'engine/viewmodel/PoseCurve.js';
import {
    ACTION_CURVES,
    ACTION_DEFAULT_DURATIONS,
    ACTION_FADE_SECONDS,
    ADS_BLOCKING_ACTIONS,
    AIRBORNE_PITCH_MAX,
    AIRBORNE_PITCH_PER_VY,
    AIRBORNE_POSE,
    AIRBORNE_WEIGHT_HALF_LIFE,
    resolveBobGate,
    resolveSprintWeight,
    SPRINT_POSE,
    SPRINT_WEIGHT_HALF_LIFE,
    type ViewModelActionState,
    type ViewModelState,
} from 'engine/viewmodel/ViewModelStates.js';
import {
    DEFAULT_RECOIL_PROFILE,
    RECOIL_SHOT_CHAIN_TIMEOUT,
    resolveRecoilImpulse,
    type RecoilImpulse,
    type RecoilProfile,
} from 'engine/viewmodel/RecoilProfiles.js';

/**
 * The view model's motion, as pure maths.
 *
 * Everything a first-person weapon does between "it is drawn in front of the
 * camera" and "it feels like a weapon" lives here: it lags the player's look,
 * it bobs with their stride, it kicks when it fires, it settles into the sights
 * when they aim. No engine, scene, camera or weapon knowledge — the rig takes a
 * struct of per-frame state and produces one position/euler pair, which is what
 * makes all of it testable as numbers rather than as screenshots.
 *
 * The composition each frame is a single exclusive BASE pose plus a sum of
 * ADDITIVE contributions:
 *
 *   base = rest → sprint → airborne → sights → action curve
 *   out  = base + sway + bob + landing + recoil
 *
 * Additives are attenuated while aiming and during actions, but never all the
 * way to zero: a weapon that goes perfectly rigid reads as dead, and the moment
 * it does the illusion that a person is holding it collapses.
 *
 * Euler channels are summed rather than slerped. Every contribution here is a
 * small angle, and summation is exactly what the shipped melee view model
 * already does, so the melee arcs survive the move onto this rig unchanged.
 */

/** Matches the engine's own frame-delta clamp — one long stall must not fling. */
const MAX_DELTA = 0.1;

export interface SwayOptions {
    /** Low-pass half-life on the measured look rate, seconds. */
    inputHalfLife: number;
    /** Metres of lateral lag per rad/s of yaw. */
    positionPerYawRate: number;
    /** Metres of vertical lag per rad/s of pitch. */
    positionPerPitchRate: number;
    /** Metres the weapon pulls toward the camera per rad/s of |yaw|. */
    pullPerYawRate: number;
    /** Radians of yaw/pitch lag per rad/s of look. */
    rotationPerYawRate: number;
    rotationPerPitchRate: number;
    /** Radians of roll INTO the turn per rad/s of yaw. */
    rollPerYawRate: number;
    /** Metres of lateral lag per m/s of strafe. */
    positionPerStrafeSpeed: number;

    /** Clamps. Without these a flick throws the weapon clean off the screen. */
    positionMax: number;
    pullMax: number;
    rotationMax: number;
    rollMax: number;
    strafeMax: number;

    omega: number;
    damping: number;
}

export interface BobOptions {
    /** Strides per second at a standstill and at full running speed. */
    strideHzMin: number;
    strideHzMax: number;
    /** Figure-of-eight amplitudes, metres. */
    amplitudeX: number;
    amplitudeY: number;
    amplitudeZ: number;
    /** Extra downward dip on each footfall, metres. */
    footfallAmplitude: number;
    /** Rotation amplitudes, radians. */
    rollAmplitude: number;
    pitchAmplitude: number;
    yawAmplitude: number;
    /** Idle breathing amplitudes (metres / radians). */
    idlePositionX: number;
    idlePositionY: number;
    idleRoll: number;
    /** Landing spring response. */
    landingOmega: number;
    landingDamping: number;
    /** Downward speed (m/s) that counts as a full-strength landing. */
    landingFullImpactSpeed: number;
}

export interface AdsOptions {
    /** Seconds to reach the sights, and to leave them. */
    inSeconds: number;
    outSeconds: number;
    /** How much of each additive SURVIVES at full ADS (0..1). Never 0. */
    swayScale: number;
    bobScale: number;
    landingScale: number;
    recoilScale: number;
    cameraPunchScale: number;
}

export interface AccuracyOptions {
    /** Spread with a stationary, grounded, hip-fired weapon. */
    base: number;
    /** Added at full movement speed. */
    movement: number;
    /** Added while airborne. */
    airborne: number;
    /** Subtracted at full ADS. */
    adsBonus: number;
    /** Ceiling on accumulated firing bloom. */
    bloomMax: number;
    /** Seconds after a shot before bloom starts decaying. */
    bloomHoldSeconds: number;
    /** Half-life of bloom decay, seconds. */
    bloomHalfLife: number;
}

export interface ViewModelRigOptions {
    /** Where the weapon sits when nothing is happening. */
    restPose: ViewModelPose;
    /** Where it sits at full ADS. Absolute, not an offset from rest. */
    sightsPose: ViewModelPose;
    /** Offsets from rest. */
    sprintPose: ViewModelPose;
    airbornePose: ViewModelPose;

    sway: SwayOptions;
    bob: BobOptions;
    ads: AdsOptions;
    accuracy: AccuracyOptions;
    recoil: RecoilProfile;

    /** Seeds the per-shot recoil scatter so replays and peers agree. */
    seed: number;
}

export const DEFAULT_SWAY_OPTIONS: SwayOptions = {
    inputHalfLife: 0.030,
    positionPerYawRate: 0.014,
    positionPerPitchRate: 0.010,
    pullPerYawRate: 0.008,
    rotationPerYawRate: 0.055,
    rotationPerPitchRate: 0.040,
    rollPerYawRate: 0.030,
    positionPerStrafeSpeed: 0.010,
    positionMax: 0.045,
    pullMax: 0.020,
    rotationMax: 0.16,
    rollMax: 0.10,
    strafeMax: 0.020,
    omega: 18,
    // Slightly underdamped: the small settle-wiggle after a turn is most of
    // what sells the weapon as a heavy object rather than a sprite.
    damping: 0.85,
};

export const DEFAULT_BOB_OPTIONS: BobOptions = {
    // 1.7 to 2.9 footfalls per second — real walking and running cadence, which
    // is why the result reads as steps rather than as a wobble.
    strideHzMin: 0.85,
    strideHzMax: 1.45,
    amplitudeX: 0.013,
    amplitudeY: 0.008,
    amplitudeZ: 0.004,
    footfallAmplitude: 0.006,
    rollAmplitude: 0.035,
    pitchAmplitude: 0.018,
    yawAmplitude: 0.022,
    idlePositionX: 0.0016,
    idlePositionY: 0.0022,
    idleRoll: 0.0060,
    landingOmega: 20,
    landingDamping: 1.0,
    landingFullImpactSpeed: 12,
};

export const DEFAULT_ADS_OPTIONS: AdsOptions = {
    // Leaving the sights is faster than entering them. A slow un-aim reads as
    // the game holding the player hostage; every shooter worth copying does this.
    inSeconds: 0.18,
    outSeconds: 0.14,
    swayScale: 0.25,
    bobScale: 0.15,
    landingScale: 0.50,
    recoilScale: 0.65,
    cameraPunchScale: 0.75,
};

export const DEFAULT_ACCURACY_OPTIONS: AccuracyOptions = {
    base: 0.05,
    movement: 0.45,
    airborne: 0.30,
    adsBonus: 0.35,
    bloomMax: 0.60,
    // Without a hold, full-auto fire decays as fast as it accumulates and the
    // crosshair never opens.
    bloomHoldSeconds: 0.08,
    bloomHalfLife: 0.18,
};

export const DEFAULT_VIEW_MODEL_RIG_OPTIONS: ViewModelRigOptions = {
    restPose: createPose(0.30, -0.32, -0.55, -0.95, 0.18, 0.12),
    sightsPose: createPose(0, -0.038, -0.36, 0, 0, 0),
    sprintPose: SPRINT_POSE,
    airbornePose: AIRBORNE_POSE,
    sway: DEFAULT_SWAY_OPTIONS,
    bob: DEFAULT_BOB_OPTIONS,
    ads: DEFAULT_ADS_OPTIONS,
    accuracy: DEFAULT_ACCURACY_OPTIONS,
    recoil: DEFAULT_RECOIL_PROFILE,
    seed: 1,
};

/** Per-frame state the rig derives all of its motion from. */
export interface RigFrameInput {
    /** Absolute look angles, radians. */
    yaw: number;
    pitch: number;
    /** Horizontal speed, m/s. */
    speed: number;
    /** The movement system's nominal speed, used to normalise `speed`. */
    referenceSpeed: number;
    /** View-space lateral velocity, m/s. Positive = strafing right. */
    lateralVelocity: number;
    /** World vertical velocity, m/s. */
    verticalVelocity: number;
    grounded: boolean;
    /** Whether the aim control is held. Blocking states are handled internally. */
    adsHeld: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clampSym = (v: number, limit: number): number => clamp(v, -limit, limit);

/** Wrap an angle delta into (−π, π] so crossing the seam is not a huge rate. */
function wrapPi(angle: number): number {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

/** Zero slope at both ends, so blending is continuous in value AND velocity. */
const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Add one additive contribution — a position spring and its paired rotation
 * spring — onto the composed pose. Reading the springs directly rather than
 * through a scratch pose keeps the per-frame path allocation-free.
 */
function addScaledSprings(
    out: ViewModelPose, position: Spring3, rotation: Spring3, scale: number,
): void {
    out.position.x += position.getX() * scale;
    out.position.y += position.getY() * scale;
    out.position.z += position.getZ() * scale;
    out.rotation.x += rotation.getX() * scale;
    out.rotation.y += rotation.getY() * scale;
    out.rotation.z += rotation.getZ() * scale;
}

export class ViewModelRig {
    private readonly options: ViewModelRigOptions;
    private readonly random: SeededRandom;

    /**
     * Poses and the recoil profile are OWNED COPIES, never the caller's objects.
     * The defaults above are module-level singletons shared by every rig in the
     * process, so mutating them through setRestPose or setRecoilProfile would
     * silently retune every other weapon in the game.
     */
    private readonly restPose: ViewModelPose = zeroPose();
    private readonly sightsPose: ViewModelPose = zeroPose();
    private readonly sprintPose: ViewModelPose = zeroPose();
    private readonly airbornePose: ViewModelPose = zeroPose();
    private recoil: RecoilProfile;

    // Output
    private readonly pose: ViewModelPose = zeroPose();
    private readonly euler = new THREE.Euler();

    // Scratch, reused every frame so the rig never allocates.
    private readonly scratchPose: ViewModelPose = zeroPose();
    private readonly additive: ViewModelPose = zeroPose();

    // Look sway
    private previousYaw: number | null = null;
    private previousPitch: number | null = null;
    private smoothedYawRate = 0;
    private smoothedPitchRate = 0;
    private readonly swayPosition: Spring3;
    private readonly swayRotation: Spring3;

    // Bob
    /** Per-weapon multiplier on movement bob; a heavy two-hander bobs less. */
    private bobScale = 1;
    private bobPhase = 0;
    private idleTime = 0;
    private bobPhaseIsMoving = false;
    private readonly landPosition: Spring3;
    private readonly landRotation: Spring3;
    private wasGrounded = true;
    private lastAirborneVerticalVelocity = 0;
    private pendingLandingImpact = 0;

    // Recoil
    private readonly recoilPosition: Spring3;
    private readonly recoilRotation: Spring3;
    private shotIndex = 0;
    private timeSinceShot = Number.POSITIVE_INFINITY;

    // Locomotion weights
    private sprintWeight = 0;
    private airborneWeight = 0;

    // Actions
    private actionState: ViewModelActionState | null = null;
    private actionElapsed = 0;
    private actionDuration = 0;
    private actionActive = false;
    private actionWeight = 0;

    // ADS
    private adsProgress = 0;
    private adsBlend = 0;

    // Accuracy
    private fireBloom = 0;
    private accuracy = 0;

    constructor(options: ViewModelRigOptions = DEFAULT_VIEW_MODEL_RIG_OPTIONS) {
        this.options = options;
        this.random = new SeededRandom(options.seed);

        copyPose(this.restPose, options.restPose);
        copyPose(this.sightsPose, options.sightsPose);
        copyPose(this.sprintPose, options.sprintPose);
        copyPose(this.airbornePose, options.airbornePose);
        this.recoil = { ...options.recoil };

        const { sway, bob } = options;
        this.swayPosition = new Spring3(sway.omega, sway.damping);
        this.swayRotation = new Spring3(sway.omega, sway.damping);
        this.landPosition = new Spring3(bob.landingOmega, bob.landingDamping);
        this.landRotation = new Spring3(bob.landingOmega, bob.landingDamping);
        this.recoilPosition = new Spring3(this.recoil.positionOmega, this.recoil.damping);
        this.recoilRotation = new Spring3(this.recoil.rotationOmega, this.recoil.damping);

        copyPose(this.pose, this.restPose);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    getPosition(): THREE.Vector3 { return this.pose.position; }
    getRotation(): THREE.Vector3 { return this.pose.rotation; }
    getAdsBlend(): number { return this.adsBlend; }
    getAccuracy(): number { return this.accuracy; }
    getShotIndex(): number { return this.shotIndex; }
    getRecoilProfile(): RecoilProfile { return this.recoil; }

    /** The dominant state right now, for HUD or animation consumers. */
    getState(): ViewModelState {
        if (this.actionState !== null && this.actionWeight > 0.5) return this.actionState;
        if (this.airborneWeight > 0.5) return 'airborne';
        if (this.sprintWeight > 0.5) return 'sprint';
        return this.bobPhaseIsMoving ? 'walk' : 'idle';
    }

    /** Every spring has returned to rest and no action is running. */
    isSettled(): boolean {
        return this.swayPosition.isAtRest() && this.swayRotation.isAtRest()
            && this.landPosition.isAtRest() && this.landRotation.isAtRest()
            && this.recoilPosition.isAtRest() && this.recoilRotation.isAtRest()
            && this.actionWeight === 0;
    }

    // ── Drive ─────────────────────────────────────────────────────────────────

    /**
     * Fire one shot: kick the view-model springs, advance the burst pattern, and
     * open the crosshair.
     *
     * Returns the resolved impulse so the caller can forward the camera punch —
     * the rig deliberately does not reach for the camera itself, which is what
     * keeps it free of engine dependencies and testable.
     */
    addRecoilShot(): RecoilImpulse {
        if (this.timeSinceShot > RECOIL_SHOT_CHAIN_TIMEOUT) this.shotIndex = 0;

        const profile = this.recoil;
        const impulse = resolveRecoilImpulse(profile, this.shotIndex, () => this.random.next());
        this.shotIndex++;
        this.timeSinceShot = 0;

        this.recoilPosition.addImpulsePeak(0, impulse.positionY, impulse.positionZ);
        this.recoilRotation.addImpulsePeak(impulse.rotationX, impulse.rotationY, impulse.rotationZ);
        this.fireBloom = Math.min(this.fireBloom + profile.bloomPerShot, this.options.accuracy.bloomMax);

        // The caller applies the camera punch, so attenuate it here rather than
        // leaving every call site to remember that aiming softens the kick.
        const punchScale = 1 - (1 - this.options.ads.cameraPunchScale) * this.adsBlend;
        return {
            ...impulse,
            cameraPitch: impulse.cameraPitch * punchScale,
            cameraYaw: impulse.cameraYaw * punchScale,
        };
    }

    /** Begin a timed action, replacing any action already running. */
    startAction(state: ViewModelActionState, durationSeconds?: number): void {
        this.actionState = state;
        this.actionDuration = Math.max(durationSeconds ?? ACTION_DEFAULT_DURATIONS[state], 1e-3);
        this.actionElapsed = 0;
        this.actionActive = true;
    }

    /**
     * Stop the running action where it stands. Its pose fades out over
     * ACTION_FADE_SECONDS rather than snapping, so an interrupted reload is
     * continuous.
     */
    cancelAction(): void {
        this.actionActive = false;
    }

    /** How far through the running action, 0..1. */
    getActionProgress(): number {
        if (this.actionState === null || this.actionDuration <= 0) return 0;
        return clamp(this.actionElapsed / this.actionDuration, 0, 1);
    }

    setRestPose(pose: ViewModelPose): void { copyPose(this.restPose, pose); }

    /** Scale movement bob for the equipped weapon. 1 = the rig's default. */
    setBobScale(scale: number): void { this.bobScale = Number.isFinite(scale) && scale >= 0 ? scale : 1; }
    setSightsPose(pose: ViewModelPose): void { copyPose(this.sightsPose, pose); }

    setRecoilProfile(profile: RecoilProfile): void {
        this.recoil = { ...profile };
        this.recoilPosition.setResponse(this.recoil.positionOmega, this.recoil.damping);
        this.recoilRotation.setResponse(this.recoil.rotationOmega, this.recoil.damping);
    }

    /** Drop all motion and return to the resting pose. */
    reset(): void {
        this.swayPosition.reset(); this.swayRotation.reset();
        this.landPosition.reset(); this.landRotation.reset();
        this.recoilPosition.reset(); this.recoilRotation.reset();
        this.previousYaw = null;
        this.previousPitch = null;
        this.smoothedYawRate = 0;
        this.smoothedPitchRate = 0;
        this.bobPhase = 0;
        this.idleTime = 0;
        this.sprintWeight = 0;
        this.airborneWeight = 0;
        this.actionState = null;
        this.actionActive = false;
        this.actionWeight = 0;
        this.adsProgress = 0;
        this.adsBlend = 0;
        this.fireBloom = 0;
        this.shotIndex = 0;
        this.timeSinceShot = Number.POSITIVE_INFINITY;
        this.random.reset();
        // The OWNED rest pose, not `options.restPose`: setRestPose may have
        // moved it since construction (equipping a weapon does exactly that),
        // and resetting must return to where the weapon rests now.
        copyPose(this.pose, this.restPose);
    }

    // ── Per-frame ─────────────────────────────────────────────────────────────

    update(deltaTime: number, input: RigFrameInput): void {
        const dt = clamp(deltaTime > 0 ? deltaTime : 0, 0, MAX_DELTA);
        if (dt === 0) return;

        const reference = input.referenceSpeed > 0 ? input.referenceSpeed : 1;
        const normalizedSpeed = clamp(input.speed / reference, 0, 1.4);

        this.timeSinceShot += dt;
        this.updateLocomotionWeights(dt, normalizedSpeed, input.grounded);
        this.updateAction(dt);
        this.updateAds(dt, input.adsHeld);
        this.updateGroundContact(input);
        this.updateSway(dt, input);
        this.updateBob(dt, normalizedSpeed);
        this.integrateImpulseSprings(dt);
        this.updateAccuracy(dt, normalizedSpeed, input.grounded);

        this.composePose(normalizedSpeed, input.verticalVelocity);
    }

    /** Landing and recoil both spring back to rest; nothing drives them but time. */
    private integrateImpulseSprings(dt: number): void {
        this.landPosition.integrate(dt);
        this.landRotation.integrate(dt);
        this.recoilPosition.integrate(dt);
        this.recoilRotation.integrate(dt);
    }

    /** Write the current pose onto a scene object. */
    applyTo(target: THREE.Object3D): void {
        target.position.copy(this.pose.position);
        this.euler.set(this.pose.rotation.x, this.pose.rotation.y, this.pose.rotation.z);
        target.rotation.copy(this.euler);
    }

    // ── Contributions ─────────────────────────────────────────────────────────

    private updateLocomotionWeights(dt: number, normalizedSpeed: number, grounded: boolean): void {
        const targetSprint = resolveSprintWeight(normalizedSpeed, grounded);
        this.sprintWeight = expApproach(this.sprintWeight, targetSprint, SPRINT_WEIGHT_HALF_LIFE, dt);
        this.airborneWeight = expApproach(
            this.airborneWeight, grounded ? 0 : 1, AIRBORNE_WEIGHT_HALF_LIFE, dt,
        );
    }

    private updateAction(dt: number): void {
        if (this.actionActive) {
            this.actionElapsed += dt;
            if (this.actionElapsed >= this.actionDuration) {
                this.actionElapsed = this.actionDuration;
                this.actionActive = false;
            }
        }
        // Linear fade both ways: an action cancelled two frames in leaves as
        // smoothly as one that ran to completion.
        const step = dt / ACTION_FADE_SECONDS;
        const target = this.actionActive ? 1 : 0;
        if (this.actionWeight < target) this.actionWeight = Math.min(this.actionWeight + step, target);
        else if (this.actionWeight > target) this.actionWeight = Math.max(this.actionWeight - step, target);
        if (this.actionWeight === 0 && !this.actionActive) this.actionState = null;
    }

    private updateAds(dt: number, held: boolean): void {
        const blockedByAction = this.actionState !== null
            && this.actionWeight > 0
            && ADS_BLOCKING_ACTIONS.has(this.actionState);
        // Holding the aim control through a reload engages the sights the moment
        // it finishes, rather than silently dropping the request.
        const engaged = held && !blockedByAction && this.sprintWeight <= 0.5;

        const { inSeconds, outSeconds } = this.options.ads;
        const rate = engaged ? dt / Math.max(inSeconds, 1e-3) : -dt / Math.max(outSeconds, 1e-3);
        this.adsProgress = clamp(this.adsProgress + rate, 0, 1);

        // ONE shaping function in both directions. Easing in with one curve and
        // out with a different one looks better on paper and jumps on screen:
        // reversing mid-transition would swap the mapping under a progress value
        // that has not changed, moving the weapon in a single frame.
        this.adsBlend = smootherstep(this.adsProgress);
    }

    private updateGroundContact(input: RigFrameInput): void {
        const { bob } = this.options;
        if (input.grounded && !this.wasGrounded) {
            const impact = clamp(
                Math.abs(this.lastAirborneVerticalVelocity) / Math.max(bob.landingFullImpactSpeed, 1e-3),
                0.15, 1,
            );
            this.landPosition.addImpulsePeak(0, -0.060 * impact, 0.015 * impact);
            this.landRotation.addImpulsePeak(0.100 * impact, 0, 0.040 * impact);
            this.pendingLandingImpact = impact;
        } else if (!input.grounded && this.wasGrounded) {
            // A smaller dip on takeoff, so jumps read at both ends.
            this.landPosition.addImpulsePeak(0, 0.024, -0.006);
            this.landRotation.addImpulsePeak(-0.040, 0, -0.016);
        }
        if (!input.grounded) this.lastAirborneVerticalVelocity = input.verticalVelocity;
        this.wasGrounded = input.grounded;
    }

    /**
     * Landing impact (0..1) recorded since the last call, then cleared.
     *
     * The weapon system forwards this to the camera as a view punch — the rig
     * itself never touches the camera.
     */
    consumeLandingImpact(): number {
        const impact = this.pendingLandingImpact;
        this.pendingLandingImpact = 0;
        return impact;
    }

    /**
     * Look sway — the weapon trails the player's own look and springs back.
     *
     * This is the contribution that does the most work. Bob is a loop the eye
     * filters out within seconds and recoil only exists while firing, but sway
     * responds to the player's input at the exact moment they make it, on every
     * frame they move the mouse. It is the difference between carrying a weapon
     * and having one painted on the screen.
     */
    private updateSway(dt: number, input: RigFrameInput): void {
        const { sway } = this.options;

        if (this.previousYaw === null || this.previousPitch === null) {
            this.previousYaw = input.yaw;
            this.previousPitch = input.pitch;
        }
        const yawRate = wrapPi(input.yaw - this.previousYaw) / dt;
        const pitchRate = wrapPi(input.pitch - this.previousPitch) / dt;
        this.previousYaw = input.yaw;
        this.previousPitch = input.pitch;

        // A 1000 Hz mouse delivers rate spikes that a raw spring target turns
        // into visible chatter, so the rate is low-passed before it is used.
        this.smoothedYawRate = expApproach(this.smoothedYawRate, yawRate, sway.inputHalfLife, dt);
        this.smoothedPitchRate = expApproach(this.smoothedPitchRate, pitchRate, sway.inputHalfLife, dt);

        const yr = this.smoothedYawRate;
        const pr = this.smoothedPitchRate;

        // The clamps are the load-bearing part. Proportional-only sway looks
        // correct at conversational mouse speeds and throws the weapon out of
        // frame the first time somebody flicks 180 degrees.
        const strafe = clampSym(-input.lateralVelocity * sway.positionPerStrafeSpeed, sway.strafeMax);
        const targetPosX = clampSym(-yr * sway.positionPerYawRate, sway.positionMax) + strafe;
        const targetPosY = clampSym(pr * sway.positionPerPitchRate, sway.positionMax);
        const targetPosZ = clamp(Math.abs(yr) * sway.pullPerYawRate, 0, sway.pullMax);

        const targetRotX = clampSym(-pr * sway.rotationPerPitchRate, sway.rotationMax);
        const targetRotY = clampSym(yr * sway.rotationPerYawRate, sway.rotationMax);
        const targetRotZ = clampSym(-yr * sway.rollPerYawRate, sway.rollMax);

        this.swayPosition.integrate(dt, targetPosX, targetPosY, targetPosZ);
        this.swayRotation.integrate(dt, targetRotX, targetRotY, targetRotZ);
    }

    /**
     * Movement bob, driven by measured speed rather than by an input flag — so
     * it keeps working under knockback, slides, conveyors and any custom
     * movement system a game installs.
     */
    private updateBob(dt: number, normalizedSpeed: number): void {
        const { bob } = this.options;
        const gate = resolveBobGate(normalizedSpeed);
        this.bobPhaseIsMoving = gate > 0.5;

        // Phase advances in STRIDES, not in seconds. Tying cadence to real
        // walking and running rates is why this reads as footsteps.
        const strideHz = bob.strideHzMin
            + (bob.strideHzMax - bob.strideHzMin) * clamp(normalizedSpeed, 0, 1.2);
        this.bobPhase += Math.PI * 2 * strideHz * dt * gate;
        // Bounded, so a long session cannot drift into float mush.
        if (this.bobPhase > Math.PI * 2) this.bobPhase %= Math.PI * 2;

        this.idleTime += dt;
    }

    private updateAccuracy(dt: number, normalizedSpeed: number, grounded: boolean): void {
        const { accuracy } = this.options;
        if (this.timeSinceShot > accuracy.bloomHoldSeconds) {
            this.fireBloom = expApproach(this.fireBloom, 0, accuracy.bloomHalfLife, dt);
        }
        this.accuracy = clamp(
            accuracy.base
            + clamp(normalizedSpeed, 0, 1) * accuracy.movement
            + (grounded ? 0 : accuracy.airborne)
            + this.fireBloom
            - this.adsBlend * accuracy.adsBonus,
            0, 1,
        );
    }

    // ── Composition ───────────────────────────────────────────────────────────

    private composePose(normalizedSpeed: number, verticalVelocity: number): void {
        const { restPose, sightsPose, sprintPose, airbornePose } = this;
        const { bob, ads } = this.options;
        const out = this.pose;

        // Base: rest, displaced by the locomotion states, blended toward the
        // sights, then handed to whatever action is running.
        copyPose(out, restPose);
        addScaledPose(out, sprintPose, this.sprintWeight);
        addScaledPose(out, airbornePose, this.airborneWeight);
        out.rotation.x += clampSym(verticalVelocity * AIRBORNE_PITCH_PER_VY, AIRBORNE_PITCH_MAX)
            * this.airborneWeight;

        if (this.adsBlend > 0) mixPose(out, sightsPose, this.adsBlend);

        if (this.actionState !== null && this.actionWeight > 0) {
            evaluatePoseCurve(ACTION_CURVES[this.actionState], this.getActionProgress(), this.scratchPose);
            addScaledPose(out, this.scratchPose, this.actionWeight);
        }

        // Additives. Each keeps a floor at full ADS — going rigid reads as dead.
        const actionDamp = 1 - 0.6 * this.actionWeight;
        const swayScale = (1 - (1 - ads.swayScale) * this.adsBlend) * actionDamp;
        const bobScale = (1 - (1 - ads.bobScale) * this.adsBlend) * actionDamp;
        const landScale = 1 - (1 - ads.landingScale) * this.adsBlend;
        const recoilScale = 1 - (1 - ads.recoilScale) * this.adsBlend;

        addScaledSprings(out, this.swayPosition, this.swayRotation, swayScale);

        this.evaluateBobPose(normalizedSpeed, bob, this.additive);
        addScaledPose(out, this.additive, bobScale);

        addScaledSprings(out, this.landPosition, this.landRotation, landScale);
        addScaledSprings(out, this.recoilPosition, this.recoilRotation, recoilScale);
    }

    /**
     * The bob offset for this frame: a true lemniscate for the gait, a separate
     * rectified channel for the footfalls, cross-faded against idle breathing.
     */
    private evaluateBobPose(normalizedSpeed: number, bob: BobOptions, out: ViewModelPose): void {
        resetPose(out);
        const gate = resolveBobGate(normalizedSpeed);

        if (gate > 0) {
            // Sublinear, so a slow walk still visibly moves the weapon.
            const amp = Math.pow(normalizedSpeed, 0.8) * gate * this.bobScale;
            const phase = this.bobPhase;
            const s1 = Math.sin(phase);
            const s2 = Math.sin(phase * 2);

            // (sin φ, sin 2φ) is the actual figure-of-eight the eye reads as a gait.
            out.position.x += s1 * bob.amplitudeX * amp;
            out.position.y += s2 * bob.amplitudeY * amp;
            out.position.z += Math.cos(phase) * bob.amplitudeZ * amp;
            // Impact split onto its own rectified channel so the shape of the
            // gait and the weight of each step tune independently.
            out.position.y -= Math.max(0, -s2) * bob.footfallAmplitude * amp;
            out.rotation.x += s2 * bob.pitchAmplitude * amp;
            out.rotation.y += s1 * bob.yawAmplitude * amp * 0.6;
            out.rotation.z += -s1 * bob.rollAmplitude * amp;
        }

        if (gate < 1) {
            // Incommensurate frequencies, so idle never visibly loops.
            const t = this.idleTime;
            const idle = 1 - gate;
            out.position.x += Math.sin(Math.PI * 2 * 0.37 * t) * bob.idlePositionX * idle;
            out.position.y += Math.sin(Math.PI * 2 * 0.55 * t) * bob.idlePositionY * idle;
            out.rotation.z += Math.sin(Math.PI * 2 * 0.29 * t) * bob.idleRoll * idle;
        }
    }
}
