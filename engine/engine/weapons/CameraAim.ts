import * as THREE from 'three';
import { CollisionMask } from 'engine/CollisionLayers.js';

/**
 * Where a camera-aimed weapon is pointing — the shared answer for every camera
 * mode that puts a crosshair on the screen.
 *
 * Extracted from RangedWeaponSystem so the first-person weapon system can reuse
 * it verbatim instead of growing a second, subtly different copy. The reticle
 * fraction in particular had already been duplicated into the HUD stylesheet
 * with a comment asking the two to be kept in sync; aiming down sights makes it
 * a third consumer, so it lives here now and the others import it.
 */

/**
 * How far the camera-aim ray reaches, in metres.
 */
export const CAMERA_AIM_MAX_DISTANCE = 300;

/**
 * How far past the player the camera-aim ray starts, in metres. Keeps scenery
 * between the camera and the shooter — the wall a chase camera is pressed into,
 * the hillside behind them — from being mistaken for what the reticle is over.
 * Small enough that first person, where the ray starts at the eye, can still
 * resolve a target at arm's length.
 */
export const CAMERA_AIM_RAY_START_MARGIN = 0.5;

/**
 * Where the crosshair sits, as a fraction of viewport height from the top.
 *
 * The crosshair is AUTHORITATIVE: the aim ray is cast through this exact point,
 * not through the camera's implicit centre. The HUD draws the reticle slightly
 * below centre (standard over-the-shoulder framing — the player body sits low
 * in the frame), and when aiming used the camera centre anyway, every bullet
 * landed ~2% of the viewport ABOVE the crosshair: ~27cm high at 9m, worse with
 * range.
 *
 * `hud/hudBaseStyles.ts` positions the reticle from the same number, and the
 * aim-down-sights pose is built from it too — a weapon's iron sights have to
 * line up with the crosshair the player was just using, not with screen centre.
 */
export const RETICLE_VERTICAL_FRACTION = 0.52;

/** The one physics capability camera aiming needs. */
export interface AimRaycaster {
    raycast(
        origin: THREE.Vector3,
        direction: THREE.Vector3,
        maxDistance: number,
        collisionMask: number,
    ): { hasHit: boolean; hitPoint: THREE.Vector3 } | null;
}

/** Fallback convergence distance when the reticle is over open sky, in metres. */
export const OPEN_SKY_CONVERGENCE_DISTANCE = 20;

const _cameraWorldPos = new THREE.Vector3();
const _cameraForward = new THREE.Vector3();
const _cameraToPlayer = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();

/**
 * The point a camera-aimed shot should converge on.
 *
 * Aims at the first thing the camera ray actually MEETS, rather than at a point
 * a fixed distance along it. A third-person camera sits above and behind the
 * player, so a point 20m along its ray floats in the air: measured on a real
 * rig it landed 4.7m up, and with the muzzle ~1m off the floor every shot left
 * the barrel climbing ~15 degrees and sailed over the heads of NPCs standing on
 * the ground. Nothing was ever hit, which from the chair reads as "the gun
 * doesn't fire". Raycasting makes the reticle honest: you hit what it covers.
 *
 * Two details this depends on:
 *  - PROJECTILE is the mask because it is exactly what a bullet can hit —
 *    terrain, environment, NPCs, animals, props — and it excludes PLAYER, so
 *    the shooter's own body under the reticle is never the aim point.
 *  - The ray starts PAST the player. A chase camera is routinely pushed inside
 *    terrain or a wall, and a ray from there hits at ~0m, collapsing the aim
 *    onto the camera and firing into the dirt at the player's feet. Distance is
 *    measured as the player's projection ALONG the view ray, not the straight
 *    line to them: in first person the camera is inside the player, where the
 *    straight distance (eye height) would push the start metres ahead and skip
 *    anything at close quarters. The projection is ~0 there and the full
 *    camera-to-player gap in third person.
 *
 * @param target optional destination vector; a new one is allocated if omitted.
 */
export function calculateCameraAimPoint(
    camera: THREE.PerspectiveCamera,
    player: THREE.Object3D,
    physicsWorld: AimRaycaster | null,
    target?: THREE.Vector3,
): THREE.Vector3 {
    const out = target ?? new THREE.Vector3();

    camera.updateMatrixWorld(true);
    camera.getWorldPosition(_cameraWorldPos);

    // Through the CROSSHAIR, not the camera centre: NDC y for a point drawn at
    // RETICLE_VERTICAL_FRACTION of viewport height (css top fraction f maps to
    // ndc y = 1 - 2f).
    _cameraForward
        .set(0, 1 - 2 * RETICLE_VERTICAL_FRACTION, 0.5)
        .unproject(camera)
        .sub(_cameraWorldPos)
        .normalize();

    player.getWorldPosition(_cameraToPlayer);
    _cameraToPlayer.sub(_cameraWorldPos);
    const playerAlongRay = Math.max(0, _cameraToPlayer.dot(_cameraForward));
    const rayStartDistance = playerAlongRay + CAMERA_AIM_RAY_START_MARGIN;
    _rayOrigin.copy(_cameraWorldPos).addScaledVector(_cameraForward, rayStartDistance);

    const aimHit = physicsWorld?.raycast(
        _rayOrigin,
        _cameraForward,
        CAMERA_AIM_MAX_DISTANCE - rayStartDistance,
        CollisionMask.PROJECTILE,
    );
    if (aimHit?.hasHit) return out.copy(aimHit.hitPoint);

    // Nothing under the reticle (open sky): fall back to a fixed convergence
    // point so shots still travel where the camera is looking.
    return out.copy(_cameraWorldPos).addScaledVector(_cameraForward, OPEN_SKY_CONVERGENCE_DISTANCE);
}
