/**
 * Configuration for the arcade ski movement system (engine/ski/).
 * All values are plain JSON-friendly data (numbers/booleans) so the same
 * shape works in code and in world.json `worldProfileData.playerMovement.ski`.
 * Units are human-scale: m/s, m/s^2, degrees/second, seconds.
 */

export interface SkiConfig {
	/** Gravity magnitude used for slope acceleration and air fall (m/s^2). */
	gravity: number;
	/** Maximum downward fall speed in air (m/s). */
	terminalVelocity: number;
	/** Multiplier on gravity-driven slope acceleration. */
	slopeAccelFactor: number;
	/** Velocity-proportional drag while riding normally (1/s). */
	baseDrag: number;
	/** Drag while tucking (forward held at speed) (1/s). */
	tuckDrag: number;
	/** Deceleration while braking (backward held) (m/s^2). */
	brakeDecel: number;
	/** Speed cap while riding normally (m/s). */
	maxSpeed: number;
	/** Speed cap while tucking (m/s). */
	tuckMaxSpeed: number;
	/** Skate-push acceleration when forward held below skatePushMaxSpeed (m/s^2). */
	skatePushAccel: number;
	/** Skate push applies below this speed (m/s). */
	skatePushMaxSpeed: number;
	/** Carve turn rate at low speed (deg/s). */
	turnRateLowDeg: number;
	/** Carve turn rate at maxSpeed (deg/s). */
	turnRateHighDeg: number;
	/** Steering hold-ramp: seconds of holding a turn before it reaches the full
	 *  turn rate (a tap turns gently, a hold builds up). */
	turnRampSec: number;
	/** Turn rate at the instant a turn key is tapped, as a fraction of the full
	 *  rate (0..1). Lower = gentler taps. */
	turnTapFactor: number;
	/** How fast sideways velocity converts into heading direction (1/s).
	 *  Legacy single rate; kept for back-compat. The live carve now uses the
	 *  speed-scaled gripRateLow..gripRateHigh pair below. */
	gripRate: number;
	/** Carve grip at rest (1/s) - firm, so low-speed carves bite. */
	gripRateLow: number;
	/** Carve grip at maxSpeed (1/s) - loose, so fast carves wash out and drift. */
	gripRateHigh: number;
	/** Quadratic air-drag coefficient (1/m). Top speed emerges from this plus
	 *  snow drag balancing slope gravity, not from a hard cap. */
	airDragK: number;
	/** Linear snow-drag coefficient (1/s). */
	snowDragK: number;
	/** Tuck multiplies BOTH drag coefficients by this (<1 = faster tuck),
	 *  replacing the old tuck speed-cap swap. */
	tuckDragScale: number;
	/** Small forward push while tucking (W held at speed) (m/s^2) — a little kick
	 *  on top of the reduced drag. */
	tuckPushAccel: number;
	/** Snowboard crouch (tuck pose): how far the hips sink at full crouch (m).
	 *  Feet stay pinned by the IK, so the knees bend to take up the drop. */
	crouchDropMax: number;
	/** Deeper hip sink while the jump button is HELD (m) — the jump fires on
	 *  release, springing back up. */
	jumpChargeDrop: number;
	/** Snowboard crouch: forward torso bend at full crouch (deg). Negative bends
	 *  the back the other way. */
	crouchTorsoPitchDeg: number;
	/** Crouch ease in/out time constant (s) — how quickly the tuck pose blends. */
	crouchRampSec: number;
	/** Hard safety clamp on horizontal speed (m/s); a backstop, never the
	 *  everyday feel limiter (drag is). */
	maxSpeedClamp: number;
	/** Convex-rollover stick margin (m): smaller = pops off terrain more readily. */
	liftoffStickMargin: number;
	/** Ballistic liftoff: the board keeps its real vertical inertia and leaves the
	 *  ground when the surface falls away faster than gravity can hold it — flying
	 *  off bumps/rollers/lips WITHOUT any synthesized pop (snow is never bouncy; it
	 *  only goes up if it was already going up). false = legacy glued behavior. */
	ballisticLiftoff: boolean;
	/** Glitch safety clamp on launch vertical speed (m/s) so an anomalous normal /
	 *  depenetration spike can't fling the rider. NOT a feel knob — physics bounds
	 *  the real launch height; this only guards numerical spikes. */
	launchVyMax: number;
	/** Smoothing time (s) for the crest-detection normal — short (1-2 frames) so a
	 *  crest isn't lagged by the slope-acceleration normal smoothing. */
	launchNormalSmoothTime: number;
	/** Foot-probe reach ahead/behind the capsule along heading (m); ~skiLength/2.
	 *  Lets a ledge under one foot still read as grounded. */
	footProbeReach: number;
	/** Coyote distance (m): skate-push + jump stay available when ground is within
	 *  this of any foot point, so a ledge can never fully trap the player. */
	coyoteGroundDistance: number;
	/** Grip rate while braking (1/s). */
	brakeGripRate: number;
	/** Fraction of redirected sideways speed lost per carve (0..1). */
	carveSpeedBleed: number;
	/** Speed-loss fraction when fully sideways to momentum — a hard skid scrubs
	 *  speed. Scales from carveSpeedBleed (clean carve) to this (full skid). */
	carveSkidBleed: number;
	/** Ground-normal smoothing time constant (s). */
	normalSmoothTime: number;
	/** Jump take-off vertical speed (m/s). */
	jumpSpeed: number;
	/** Heading steer rate while airborne (deg/s). */
	airSteerRateDeg: number;
	/** Horizontal drag while airborne (1/s). */
	airDrag: number;
	/** Trick spin rate while airborne with action held (deg/s). */
	spinRateDeg: number;
	/** Landing assist window: damp trick rotation when ground is this close (s). */
	landingAssistTime: number;
	/**
	 * On the first frame, if the surface is within this distance below the
	 * feet, snap the player straight down onto it instead of free-falling.
	 * World spawn points sit a small clearance above the ground (so nothing
	 * spawns embedded); a skier would otherwise drop that gap as a dead pause
	 * before the slope engages. 0 disables (intentional air-drop starts).
	 */
	spawnSettleMaxDrop: number;
	/** Landing with more residual spin than this costs speed (deg). */
	badLandingAngleDeg: number;
	/** Fraction of speed kept on a bad landing (0..1). */
	badLandingSpeedKeep: number;
	/** Maximum visual roll lean into a carve (deg). */
	carveLeanMaxDeg: number;
	/** Show procedural ski equipment on the character. */
	showEquipment: boolean;
	/** Show poles (skis only; ignored for snowboard). */
	showPoles: boolean;
	/**
	 * Equipment the engine renders and stances for. The AI agent picks this
	 * explicitly per game: 'ski' (two forward skis, upright glide) or
	 * 'snowboard' (one sideways board, bolted sideways stance).
	 */
	equipmentStyle: 'ski' | 'snowboard';
	/** Snowboard lead foot: 'regular' (left forward) or 'goofy' (right forward). */
	stance: 'regular' | 'goofy';
	/** Snowboard: board + lower-body yaw off the travel heading (deg). */
	boardYawDeg: number;
	/** Snowboard: how far the torso winds back toward heading from the hips (deg). */
	torsoWindDeg: number;
	/** Snowboard/ski: knee bend for the spring stance (deg). */
	kneeBendDeg: number;
	/** Snowboard: half the foot spread for the wide bolted stance (m). */
	stanceHalfWidth: number;
	/** Ski length (m). */
	skiLength: number;
	/** Ski width (m). */
	skiWidth: number;
	/** Pole length (m). */
	poleLength: number;
	/** Ski color (hex). */
	skiColor: number;
	/** Pole color (hex). */
	poleColor: number;
	/** Drive ThirdPersonCamera auto-follow while skiing. */
	cameraAutoFollow: boolean;
	/**
	 * Camera chase responsiveness (1/s): the follow covers ~63% of the
	 * remaining yaw/pitch per 1/value seconds. Higher = tighter SSX-style
	 * tracking through carves.
	 */
	cameraFollowResponse: number;
	/** Orbit distance at rest (m); grows with speed. */
	cameraDistance: number;
	/** Fraction added to the distance at tuck max speed (0.35 = +35%). */
	cameraDistanceSpeedGain: number;
	/** Camera elevation on flat ground (deg above horizontal). */
	cameraElevationBaseDeg: number;
	/** Extra elevation per degree of slope — steeper hill, higher camera. */
	cameraElevationSlopeFactor: number;
	/** Elevation ceiling (deg). */
	cameraElevationMaxDeg: number;
	/** Chase-cam VERTICAL SmoothDamp time while grounded (s). Large so terrain
	 *  bumps are filtered out — the real camera floats over them while still
	 *  tracking the overall descent. The core bump-bob fix. */
	cameraGroundSmoothTime: number;
	/** Chase-cam HORIZONTAL (X/Z) SmoothDamp time (s). Kept short so turning and
	 *  ground-tracking stay responsive while vertical is damped hard. */
	cameraHorizontalSmoothTime: number;
	/** Chase-cam ORBIT easing half-life (s) — how gently elevation and distance
	 *  change. Higher = the pitch never jumps (no sudden look-down at speed). */
	cameraOrbitSmoothTime: number;
	/** Chase-cam VERTICAL SmoothDamp time while airborne (s) — small so the
	 *  camera tracks the jump arc instead of floating away from it. */
	cameraAirSmoothTime: number;
	/** Extra FOV (deg) added at tuck max speed for a sense of speed (0 disables). */
	cameraFovSpeedGainDeg: number;
	/** Fixed camera elevation while airborne (deg) — frames the landing below;
	 *  overrides the slope formula, which reads flat/stale in the air. */
	cameraAirElevationDeg: number;
	/** Fraction of base distance added while airborne (pull back over a jump). */
	cameraAirDistanceGain: number;
	/** Camera elevation during a crash tumble (deg). */
	cameraWipeoutElevationDeg: number;
	/** Fraction of base distance added during a crash tumble (watch from afar). */
	cameraWipeoutDistanceGain: number;
	/** SmoothDamp time (all axes) during a crash tumble (s) — loose and floaty so
	 *  the camera drifts after the body rather than tracking it rigidly. */
	cameraWipeoutSmoothTime: number;
	/** Let the chase cam collide with environment props (trees/rocks). false =
	 *  terrain-only collision, so weaving through trees never snaps the camera. */
	cameraCollideEnvironment: boolean;
	/** Camera-shake intensity per m/s of speed lost in a non-crash obstacle bump
	 *  (the "impact kick"). 0 disables. Hard crashes also kick on bail. */
	cameraImpactKickScale: number;
	/** Airtime (s) before the camera switches to "airborne" framing. Short hops
	 *  below this keep grounded framing (the follow-point damping absorbs them) so
	 *  frequent ballistic hops don't strobe the camera. */
	cameraAirEnterSec: number;
	/** After landing, hold airborne framing this long (s) so a hop-land-hop
	 *  sequence doesn't flicker the camera mode. */
	cameraAirExitTailSec: number;
	/**
	 * Fraction of obstacle-blocked velocity reflected back (0 = absorb,
	 * 1 = full bounce). Blocked velocity is BLED, never stored — pressing
	 * against a tree must not bank speed that releases when you turn away.
	 */
	obstacleBounciness: number;
	/** Horizontal speed lost in ONE frame that triggers a crash bail (m/s). */
	crashSpeedLoss: number;
	/** Minimum pre-impact speed for a crash bail (slow bumps never bail). */
	crashMinSpeed: number;
	/** Bounciness of the tumbling bail body. */
	bailRestitution: number;
	/** Bail ends when the body stays below this speed... */
	bailRecoverySpeed: number;
	/** ...for this long (s). */
	bailRecoveryDelaySec: number;
	/** Hard cap on a bail (s) so the player is never stuck tumbling. */
	bailMaxDurationSec: number;
}

export const DEFAULT_SKI_CONFIG: SkiConfig = {
	gravity: 15,
	terminalVelocity: 53,
	slopeAccelFactor: 1.35,
	baseDrag: 0.4,
	tuckDrag: 0.18,
	brakeDecel: 14,
	maxSpeed: 28,
	tuckMaxSpeed: 38,
	skatePushAccel: 5,
	skatePushMaxSpeed: 4,
	turnRateLowDeg: 190,
	turnRateHighDeg: 90,
	turnRampSec: 0.5,
	turnTapFactor: 0.3,
	gripRate: 5.5,
	gripRateLow: 7,
	gripRateHigh: 2.2,
	airDragK: 0.012,
	snowDragK: 0.22,
	tuckDragScale: 0.55,
	tuckPushAccel: 3,
	crouchDropMax: 0.1,
	jumpChargeDrop: 0.2,
	crouchTorsoPitchDeg: 16,
	crouchRampSec: 0.16,
	maxSpeedClamp: 33,
	liftoffStickMargin: 0.005,
	ballisticLiftoff: true,
	launchVyMax: 12,
	launchNormalSmoothTime: 0.03,
	footProbeReach: 0.85,
	coyoteGroundDistance: 0.6,
	brakeGripRate: 10,
	carveSpeedBleed: 0.15,
	carveSkidBleed: 0.6,
	normalSmoothTime: 0.12,
	jumpSpeed: 7.5,
	airSteerRateDeg: 70,
	airDrag: 0.02,
	spinRateDeg: 380,
	landingAssistTime: 0.3,
	spawnSettleMaxDrop: 3,
	badLandingAngleDeg: 50,
	badLandingSpeedKeep: 0.5,
	carveLeanMaxDeg: 18,
	showEquipment: true,
	showPoles: true,
	equipmentStyle: 'ski',
	stance: 'regular',
	boardYawDeg: 85,
	torsoWindDeg: 45,
	kneeBendDeg: 22,
	stanceHalfWidth: 0.16,
	skiLength: 1.7,
	skiWidth: 0.12,
	poleLength: 1.05,
	skiColor: 0xe04a3a,
	poleColor: 0x303438,
	cameraAutoFollow: true,
	cameraFollowResponse: 2.5,
	cameraDistance: 6,
	cameraDistanceSpeedGain: 0.35,
	cameraElevationBaseDeg: 12,
	cameraElevationSlopeFactor: 1.1,
	cameraElevationMaxDeg: 52,
	cameraGroundSmoothTime: 0.5,
	cameraHorizontalSmoothTime: 0.18,
	cameraOrbitSmoothTime: 0.3,
	cameraAirSmoothTime: 0.12,
	cameraFovSpeedGainDeg: 12,
	cameraAirElevationDeg: 32,
	cameraAirDistanceGain: 0.4,
	cameraWipeoutElevationDeg: 28,
	cameraWipeoutDistanceGain: 0.6,
	cameraWipeoutSmoothTime: 0.45,
	cameraCollideEnvironment: false,
	cameraImpactKickScale: 0.012,
	cameraAirEnterSec: 0.2,
	cameraAirExitTailSec: 0.15,
	obstacleBounciness: 0.3,
	crashSpeedLoss: 9,
	crashMinSpeed: 8,
	bailRestitution: 0.4,
	bailRecoverySpeed: 1.5,
	bailRecoveryDelaySec: 0.35,
	bailMaxDurationSec: 4,
};

/**
 * Merge overrides into defaults, accepting untrusted input (world.json).
 * Unknown keys are dropped; values whose typeof differs from the default's
 * are dropped. Returns a fresh object.
 */
export function mergeSkiConfig(partial?: Partial<SkiConfig> | Record<string, unknown>): SkiConfig {
	const out: SkiConfig = { ...DEFAULT_SKI_CONFIG };
	if (!partial) return out;
	const target = out as unknown as Record<string, number | boolean>;
	const defaults = DEFAULT_SKI_CONFIG as unknown as Record<string, number | boolean>;
	for (const [key, value] of Object.entries(partial)) {
		if (!(key in defaults)) continue;
		if (typeof value !== typeof defaults[key]) continue;
		if (typeof value === 'number' && !Number.isFinite(value)) continue;
		target[key] = value as number | boolean;
	}
	return out;
}
