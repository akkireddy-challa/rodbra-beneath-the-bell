/**
 * What a shot does to the weapon and to the view.
 *
 * Everything here is authored in the units a designer thinks in: how far the
 * weapon visibly kicks (metres, radians) and how much of that kick the player
 * has to correct for (a fraction). The springs convert those into velocities —
 * see Spring.addImpulsePeak — so retuning a weapon's stiffness never silently
 * resizes its kick.
 *
 * `recenter` is the one field that is a GAMEPLAY decision rather than a look,
 * and it is why this is a per-weapon table rather than an engine constant. At
 * 1.0 the view springs back exactly where it started and firing can never move
 * the player's aim — the right default for a bow, a laser, or any game that
 * does not want a skill floor. Below 1.0 a fraction of every kick sticks, so
 * sustained fire climbs and the player pulls down against it. Games set this
 * per weapon; the classes below are only starting points.
 *
 * Pure (no three.js / engine imports) so profiles can be reasoned about and
 * tested as numbers.
 */

/** Broad handling classes the built-in weapon presets map onto. */
export type RecoilClass = 'pistol' | 'rifle' | 'heavy' | 'energy';

export interface RecoilProfile {
    /** Peak upward travel of the view model, metres. */
    riseY: number;
    /** Peak travel toward the camera, metres. */
    kickZ: number;
    /** Peak view-model pitch kick, radians. */
    pitch: number;
    /** Peak view-model yaw kick, radians (sign alternates per shot). */
    yaw: number;
    /** Peak view-model roll kick, radians (sign alternates per shot). */
    roll: number;

    /** Spring frequency for the view model's position channel, rad/s. */
    positionOmega: number;
    /** Spring frequency for the view model's rotation channel, rad/s. */
    rotationOmega: number;
    /** Damping ratio for both channels. 1 = no overshoot. */
    damping: number;

    /** Transient pitch kick applied to the CAMERA, radians. Positive = view rises. */
    cameraPitch: number;
    /** Transient yaw kick applied to the camera, radians (sign alternates). */
    cameraYaw: number;
    /**
     * Fraction of the camera kick that springs back.
     *
     * 1 = purely cosmetic; the player's aim is provably unchanged by firing.
     * 0.65 = the Counter-Strike / Call of Duty feel: a 30-round burst climbs
     * roughly 7 degrees, which the player is expected to pull down against.
     */
    recenter: number;

    /** Crosshair bloom added per shot, 0..1. */
    bloomPerShot: number;
    /** Shots over which the kick ramps from reduced to full. */
    climbShots: number;
}

/**
 * Handling archetypes.
 *
 * The frequencies are chosen against fire rate rather than picked for feel in
 * isolation: a rifle at ω = 46 settles to 5% in about 125 ms, and the built-in
 * assault rifle fires every 125 ms, so a tapped shot reads clean while held
 * fire visibly stacks. That relationship is the mechanic, and it falls out of
 * the numbers instead of being special-cased.
 */
export const RECOIL_PROFILES: Record<RecoilClass, RecoilProfile> = {
    pistol: {
        riseY: 0.010, kickZ: 0.030,
        pitch: 0.075, yaw: 0.030, roll: 0.045,
        positionOmega: 34, rotationOmega: 40, damping: 1.0,
        cameraPitch: 0.016, cameraYaw: 0.006, recenter: 0.75,
        bloomPerShot: 0.09, climbShots: 6,
    },
    rifle: {
        riseY: 0.006, kickZ: 0.020,
        pitch: 0.045, yaw: 0.022, roll: 0.030,
        positionOmega: 40, rotationOmega: 46, damping: 1.0,
        cameraPitch: 0.012, cameraYaw: 0.005, recenter: 0.65,
        bloomPerShot: 0.06, climbShots: 6,
    },
    heavy: {
        riseY: 0.022, kickZ: 0.075,
        pitch: 0.150, yaw: 0.045, roll: 0.090,
        // Deliberately underdamped: a shotgun should rebound, not glide home.
        positionOmega: 22, rotationOmega: 26, damping: 0.8,
        cameraPitch: 0.035, cameraYaw: 0.010, recenter: 0.70,
        bloomPerShot: 0.12, climbShots: 3,
    },
    energy: {
        riseY: 0.002, kickZ: 0.008,
        pitch: 0.015, yaw: 0.008, roll: 0.012,
        positionOmega: 45, rotationOmega: 50, damping: 1.0,
        // Nothing about a laser or a bow should move where the player is aiming.
        cameraPitch: 0.004, cameraYaw: 0.002, recenter: 1.0,
        bloomPerShot: 0.03, climbShots: 1,
    },
};

export const DEFAULT_RECOIL_PROFILE: RecoilProfile = RECOIL_PROFILES.rifle;

/** Seconds without firing after which the climb ramp resets to the first shot. */
export const RECOIL_SHOT_CHAIN_TIMEOUT = 0.35;

/** A single shot's resolved kick, in peak displacement. */
export interface RecoilImpulse {
    positionY: number;
    positionZ: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    cameraPitch: number;
    cameraYaw: number;
}

/**
 * Resolve one shot's kick from a profile, a shot index within the burst, and a
 * unit-random source.
 *
 * The shape is the standard first-person-shooter recoil pattern and each part
 * earns its place: the climb ramp means the first shots of a burst are
 * controllable and sustained fire is not; alternating horizontal turns the
 * climb into a zig-zag a player can learn rather than a straight line they
 * merely compensate; and the per-shot jitter keeps a learned pattern from being
 * a perfect script.
 *
 * `random` must return 0..1. Pass a seeded source so replays and multiplayer
 * peers resolve identical kicks.
 */
export function resolveRecoilImpulse(
    profile: RecoilProfile,
    shotIndex: number,
    random: () => number,
): RecoilImpulse {
    const climb = profile.climbShots > 0
        ? Math.min(shotIndex / profile.climbShots, 1)
        : 1;
    const side = shotIndex % 2 === 0 ? 1 : -1;
    const jitter = (spread: number): number => 1 - spread + random() * spread * 2;

    return {
        positionY: profile.riseY,
        positionZ: profile.kickZ * jitter(0.10),
        rotationX: -profile.pitch * (0.7 + 0.5 * climb) * jitter(0.10),
        rotationY: profile.yaw * side * (0.4 + 0.6 * random()) * climb,
        rotationZ: profile.roll * side * (0.6 + 0.4 * random()),
        cameraPitch: profile.cameraPitch * (0.7 + 0.5 * climb) * jitter(0.15),
        cameraYaw: profile.cameraYaw * side * (0.4 + 0.6 * random()) * climb,
    };
}
