import type * as THREE from 'three';

/**
 * The plain `{x, y, z}` shape shared by a RAPIER `translation()` and a
 * `THREE.Vector3`, so callers can pass either without converting.
 */
export interface RenderSyncPosition {
	x: number;
	y: number;
	z: number;
}

/**
 * Max distance (per axis, meters) the motor's per-render-frame target may sit
 * from the physics body before the visual sync distrusts it. A teleport or
 * respawn moves the body while movement updates are idle, leaving the render
 * position stale; beyond this the body wins.
 */
export const RENDER_SYNC_MAX_DIVERGENCE = 2;

/**
 * Pick the position to sync a character visual from: the movement system's
 * per-RENDER-frame kinematic target when it is close enough to the body, else
 * the body translation. The body only advances on fixed 60Hz physics substeps,
 * so a visual synced from `body.translation()` stalls on 0-substep frames and
 * double-jumps after catch-up frames — judder at a rock-steady 60 fps. The
 * render target is the same collision-clamped position the body will step to.
 *
 * `smooth` takes the result of an optional `getRenderPosition?.()` directly:
 * motors that don't offer one fall back to the body.
 */
export function resolveRenderSyncPosition(
	smooth: THREE.Vector3 | null | undefined,
	body: RenderSyncPosition,
): RenderSyncPosition {
	if (!smooth) return body;
	const diverged = Math.abs(smooth.x - body.x) >= RENDER_SYNC_MAX_DIVERGENCE
		|| Math.abs(smooth.y - body.y) >= RENDER_SYNC_MAX_DIVERGENCE
		|| Math.abs(smooth.z - body.z) >= RENDER_SYNC_MAX_DIVERGENCE;
	return diverged ? body : smooth;
}
