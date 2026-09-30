/**
 * Pure feel math for the ski movement system. No engine state, no
 * allocation in hot paths — everything here is unit-tested in isolation.
 */

import * as THREE from 'three';

/**
 * Horizontal acceleration from gravity on a slope with unit normal `n`.
 * For slope angle t: magnitude is g*sin(t)*cos(t), direction is the
 * horizontalized downhill. Both fall out of a = g * n.y * (n.x, 0, n.z).
 */
export function downhillAcceleration(
	n: THREE.Vector3,
	gravity: number,
	slopeAccelFactor: number,
	out: THREE.Vector3,
): THREE.Vector3 {
	return out.set(
		gravity * slopeAccelFactor * n.y * n.x,
		0,
		gravity * slopeAccelFactor * n.y * n.z,
	);
}

/**
 * Horizontal drag for one step: snow (linear viscous) + air (quadratic).
 * The effective decay rate is snowK + airK*speed; it is applied as an
 * exponential keep so the velocity is unconditionally stable at any dt — it
 * asymptotes toward zero and never flips sign or overshoots. Top speed is the
 * balance point against downhillAcceleration, so it emerges from the slope,
 * not from a hard cap.
 */
export function applyDrag(
	vx: number,
	vz: number,
	airK: number,
	snowK: number,
	dt: number,
): { x: number; z: number } {
	const speed = Math.hypot(vx, vz);
	if (speed < 1e-9) return { x: 0, z: 0 };
	const keep = Math.exp(-(snowK + airK * speed) * dt);
	return { x: vx * keep, z: vz * keep };
}

/**
 * Steady-state speed where driving accel aGravity (m/s^2, = g*sin(t)*cos(t))
 * balances drag snowK*v + airK*v^2. Closed-form positive root. Used by tests
 * (and optionally a HUD); the live sim reaches it through applyDrag, not this.
 */
export function terminalSpeed(aGravity: number, airK: number, snowK: number): number {
	if (aGravity <= 0) return 0;
	if (airK < 1e-12) return aGravity / Math.max(snowK, 1e-9);
	return (-snowK + Math.sqrt(snowK * snowK + 4 * airK * aGravity)) / (2 * airK);
}

/**
 * Vertical displacement (m) that keeps a grounded body ON the ground plane
 * while it moves horizontally by (vx, vz)*dt: dy = -(n.x*vx + n.z*vz)/n.y*dt.
 * Only the DESCENDING component is returned (uphill motion climbs via the
 * KCC's collide-and-slide on its own; forcing +y would launch the body).
 *
 * Why explicit: a grounded skier's vertical is otherwise left to the KCC's
 * fixed snap-to-ground distance, which is tuned for walking — at 30+ m/s on
 * a steep slope one frame's descent (speed*dt*tan(slope), worse on frame
 * drops) exceeds it, the snap misses, and the run turns into rhythmic
 * bouncing. Following the measured plane is speed- and framerate-proof;
 * overshooting downward is safe because collide-and-slide clamps at the
 * surface.
 */
export function groundFollowDy(
	n: THREE.Vector3,
	vx: number,
	vz: number,
	deltaTime: number,
): number {
	const planeDy = -((n.x * vx + n.z * vz) / Math.max(n.y, 0.2)) * deltaTime;
	return Math.min(0, planeDy);
}

/**
 * Convex-rollover separation test. followDescent = metres the feet must drop
 * THIS FRAME to stay on the surface ahead (>= 0). freeFallDescent = metres
 * gravity actually pulls them down this frame (>= 0). The ground can only
 * push, never pull, so when staying glued would require dropping FASTER than
 * free-fall (momentum carrying you over a convex roll), contact is lost.
 * stickMargin keeps micro-bumps glued (arcadey feel = small margin).
 */
export function wouldSeparate(
	followDescent: number,
	freeFallDescent: number,
	stickMargin: number,
): boolean {
	return followDescent > freeFallDescent + stickMargin;
}

/**
 * Chase-camera elevation (deg above horizontal) for a given surface slope:
 * base + slope * factor, clamped to [base, max]. The factor MUST exceed 1 —
 * behind a descending skier is uphill terrain, so any elevation below the
 * slope angle puts the camera inside the hill. Scaling beyond the slope
 * makes the camera ride visibly higher on steep pitches (SSX framing).
 */
export function skiCameraElevationDeg(
	slopeDeg: number,
	baseDeg: number,
	slopeFactor: number,
	maxDeg: number,
): number {
	const e = baseDeg + Math.max(0, slopeDeg) * slopeFactor;
	return Math.min(maxDeg, Math.max(baseDeg, e));
}

/** Speed at/below which the full low-speed carve rate applies (m/s). */
const CARVE_LOW_SPEED_END = 5;

/** Speed-adaptive carve rate: agile below 5 m/s, stable at maxSpeed. */
export function turnRateDegFor(
	speed: number,
	cfg: { turnRateLowDeg: number; turnRateHighDeg: number; maxSpeed: number },
): number {
	const lowEnd = Math.min(CARVE_LOW_SPEED_END, cfg.maxSpeed);
	if (speed <= lowEnd) return cfg.turnRateLowDeg;
	if (speed >= cfg.maxSpeed) return cfg.turnRateHighDeg;
	const t = (speed - lowEnd) / (cfg.maxSpeed - lowEnd);
	return cfg.turnRateLowDeg + (cfg.turnRateHighDeg - cfg.turnRateLowDeg) * t;
}

/**
 * Speed-scaled carve grip: firm (gripRateLow) at rest so low-speed carves
 * bite, loosening to gripRateHigh at maxSpeed so fast carves wash out and
 * drift instead of railing. Linear between, clamped past maxSpeed.
 */
export function gripRateFor(
	speed: number,
	cfg: { gripRateLow: number; gripRateHigh: number; maxSpeed: number },
): number {
	if (speed <= 0) return cfg.gripRateLow;
	if (speed >= cfg.maxSpeed) return cfg.gripRateHigh;
	const t = speed / cfg.maxSpeed;
	return cfg.gripRateLow + (cfg.gripRateHigh - cfg.gripRateLow) * t;
}

/**
 * Carve: decay the velocity component perpendicular to the heading and
 * convert the decayed amount (minus bleed) into along-heading speed.
 * Heading yaw uses the gameplay convention: forward = (sin yaw, 0, cos yaw).
 *
 * The bleed scales with how sideways the board is to its own momentum: a clean
 * carve (momentum along the heading) keeps speed at `speedBleed`, while a hard
 * skid (momentum across the heading) scrubs at `skidBleed`. `skid = |perp| /
 * total` (0..1) interpolates between them. `skidBleed` defaults to `speedBleed`
 * (no extra scrub) so existing callers are unchanged.
 */
export function carveVelocity(
	velX: number,
	velZ: number,
	headingYaw: number,
	gripRate: number,
	speedBleed: number,
	dt: number,
	skidBleed: number = speedBleed,
): { x: number; z: number } {
	const hx = Math.sin(headingYaw);
	const hz = Math.cos(headingYaw);
	const along = velX * hx + velZ * hz;
	const perpX = velX - along * hx;
	const perpZ = velZ - along * hz;
	const perpLen = Math.hypot(perpX, perpZ);
	if (perpLen < 1e-9) return { x: velX, z: velZ };
	const total = Math.hypot(velX, velZ);
	const skid = total > 1e-9 ? Math.min(1, perpLen / total) : 0;
	const bleed = speedBleed + (skidBleed - speedBleed) * skid;
	const keep = Math.exp(-gripRate * dt);
	const decayed = perpLen * (1 - keep);
	const alongNew = along + decayed * (1 - bleed) * (along >= 0 ? 1 : -1);
	const scale = keep;
	return {
		x: alongNew * hx + perpX * scale,
		z: alongNew * hz + perpZ * scale,
	};
}

/**
 * Map terrain friction (block grip atlas, ~0.1 ice .. 1.0 grass, 0.5
 * default) to drag and grip multipliers. Neutral at 0.5.
 */
export function frictionMultipliers(friction: number): { drag: number; grip: number } {
	const f = Math.min(1, Math.max(0, friction));
	return {
		drag: 0.5 + f,            // 0.1 ice -> 0.6x drag, 1.0 grass -> 1.5x
		grip: 0.6 + 0.8 * f,      // 0.1 ice -> 0.68x grip, 1.0 grass -> 1.4x
	};
}

/**
 * Closest full-rotation rest angle for a trick spin (deg). Residual error is
 * always <= 180; an exact half spin ties toward the higher rotation
 * (Math.round semantics) — harmless for the landing-penalty comparison.
 */
export function nearestSpinRest(spinDeg: number): number {
	return Math.round(spinDeg / 360) * 360;
}

/** Residual rotation left if landing right now (deg, absolute). */
export function landingSpinErrorDeg(spinDeg: number): number {
	return Math.abs(spinDeg - nearestSpinRest(spinDeg));
}

/**
 * Signed vertical velocity (m/s) the feet must have to stay on the surface while
 * moving horizontally by (vx, vz): vy = -(n.x*vx + n.z*vz)/n.y. POSITIVE going up
 * a rise, NEGATIVE descending. Unlike groundFollowDy (which clamps to descent for
 * the glued path), this keeps the sign so a rising board can carry upward momentum
 * into a launch. n.y is floored so near-vertical walls don't blow up.
 */
export function surfaceFollowVy(n: THREE.Vector3, vx: number, vz: number): number {
	return -((n.x * vx + n.z * vz) / Math.max(n.y, 0.2));
}

/**
 * Inertia-based liftoff decision for a grounded snowboard (law of inertia: the
 * ground only stops penetration — it never adds upward speed and never pulls
 * down; only gravity pulls down).
 *
 * `actualVy` is the board's REAL vertical velocity (what the motor actually
 * achieved last frame), NOT a synthesized value. `followDescent` (>= 0) is the
 * metres the feet would have to drop THIS frame to keep following the surface
 * ahead (0 if the surface rises). The board can only fall at gravity, so it
 * leaves the surface when staying glued would require dropping faster than gravity
 * delivers from its current velocity:
 *   followDescent > freeFallDescent + margin,  freeFallDescent = max(0, (-actualVy + g*dt)*dt)
 *
 * On separation it CONTINUES WITH ITS ACTUAL VELOCITY (`actualVy - g*dt`), clamped
 * to [-terminalVelocity, launchVyMax]. There is no floor and no min-pop: the board
 * goes up ONLY if `actualVy` was already positive (it rode up a ramp). Going
 * straight over a little bump, `actualVy ≈ 0`, so the launch velocity is ≤ 0 — the
 * snow is never bouncy.
 */
export interface LiftoffInput {
	followDescent: number;
	actualVy: number;
	gravity: number;
	dt: number;
	stable: boolean;
	margin: number;
	launchVyMax: number;
	terminalVelocity: number;
}

export function evaluateLiftoff(a: LiftoffInput): { separate: boolean; launchVy: number } {
	if (!a.stable) return { separate: false, launchVy: 0 };
	const freeFallDescent = Math.max(0, (-a.actualVy + a.gravity * a.dt) * a.dt);
	if (a.followDescent > freeFallDescent + a.margin) {
		const vy = Math.max(-a.terminalVelocity, Math.min(a.launchVyMax, a.actualVy - a.gravity * a.dt));
		return { separate: true, launchVy: vy };
	}
	return { separate: false, launchVy: 0 };
}
