import * as THREE from 'three';
import { computeCharacterBodyBox } from 'engine/character/CharacterBodyBounds.js';

/**
 * Broad-phase candidate selection for melee sweep raycasts.
 *
 * Melee hit detection (WeaponMeleeSystem, UnarmedMeleeSystem, melee NPC
 * behaviors) used to raycast `scene.children` recursively every swing frame.
 * That intersects multi-million-triangle terrain meshes and every SkinnedMesh
 * in the scene — and Three.js raycasts skinned meshes by applying bone
 * transforms per vertex on the CPU, which produced multi-hundred-ms frame
 * stalls whenever several NPCs swung at once.
 *
 * The narrow phase stays mesh-accurate: these helpers only pick WHICH objects
 * are worth raycasting. A melee swing can only affect meshes that follow the
 * IDamageable hit-detection contract (see IDamageable.ts) — a damageable /
 * enemy controller in userData, or a dynamic (mass > 0) physics body. Static
 * geometry (terrain chunks, buildings) carries a physics body but zero mass
 * and is discarded by every consumer after the raycast, so it is never worth
 * intersecting.
 */

/** Extra slack (m) added to every bounding test. Covers skinned meshes whose
 *  bind-pose bounding sphere drifts from the animated pose. */
export const MELEE_SWEEP_BOUNDS_MARGIN = 1.0;

const _center = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** Clamp a segment parameter to the segment itself (0 = start, 1 = end). */
function clamp01(t: number): number {
    return Math.min(1, Math.max(0, t));
}

/** Squared distance from point `p` to segment `a`→`b`. */
function pointToSegmentDistanceSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
    _ab.subVectors(b, a);
    _ap.subVectors(p, a);
    const abLenSq = _ab.lengthSq();
    const t = abLenSq > 0 ? clamp01(_ap.dot(_ab) / abLenSq) : 0;
    // closest point = a + ab * t; reuse _ap as (p - closest)
    _ap.subVectors(p, _ab.multiplyScalar(t).add(a));
    return _ap.lengthSq();
}

/** Broad-phase: does the segment `from`→`to` pass within `reach` of `pos`? */
export function segmentPassesNear(
    from: THREE.Vector3,
    to: THREE.Vector3,
    pos: THREE.Vector3,
    reach: number,
): boolean {
    return pointToSegmentDistanceSq(pos, from, to) <= reach * reach;
}

/**
 * Collect the meshes a melee sweep along segment `from`→`to` could actually
 * affect: meshes following the IDamageable userData contract (damageable /
 * enemy controller, or dynamic physics body) whose world bounding sphere
 * passes within `radius` (+ margin) of the segment.
 *
 * Returns leaf meshes — raycast them with `intersectObjects(candidates, false)`
 * for results identical to the old full-scene raycast for every hit the melee
 * systems act on.
 */
export function gatherMeleeSweepCandidates(
    scene: THREE.Scene,
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
): THREE.Object3D[] {
    const candidates: THREE.Object3D[] = [];
    scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const ud = mesh.userData;
        const damageable = ud.damageableController || ud.enemyController;
        const dynamicBody = ud.physicsBody && ((ud.mass as number | undefined) ?? 0) > 0;
        if (!damageable && !dynamicBody) return;

        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const bounds = mesh.geometry.boundingSphere!;
        _center.copy(bounds.center).applyMatrix4(mesh.matrixWorld);
        const reach = bounds.radius * mesh.matrixWorld.getMaxScaleOnAxis() + radius + MELEE_SWEEP_BOUNDS_MARGIN;
        if (pointToSegmentDistanceSq(_center, from, to) <= reach * reach) {
            candidates.push(mesh);
        }
    });
    return candidates;
}

const _segP = new THREE.Vector3();
const _segQ = new THREE.Vector3();
const _segD1 = new THREE.Vector3();
const _segD2 = new THREE.Vector3();
const _segR = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _capCenter = new THREE.Vector3();
const _bodyBox = new THREE.Box3();
const _bodySize = new THREE.Vector3();

/** Extra reach (m) added around the visible body so glancing swings still land. */
export const MELEE_BODY_HIT_MARGIN = 0.15;

/** Squared distance between segments p1→q1 and p2→q2 (Ericson, Real-Time Collision Detection). */
function segmentSegmentDistanceSq(
    p1: THREE.Vector3, q1: THREE.Vector3,
    p2: THREE.Vector3, q2: THREE.Vector3,
): number {
    const d1 = _segD1.subVectors(q1, p1); // direction of segment 1
    const d2 = _segD2.subVectors(q2, p2); // direction of segment 2
    const r = _segR.subVectors(p1, p2);
    const a = d1.dot(d1);
    const e = d2.dot(d2);
    const f = d2.dot(r);
    let s: number, t: number;
    const EPS = 1e-9;
    if (a <= EPS && e <= EPS) { s = 0; t = 0; }
    else if (a <= EPS) { s = 0; t = clamp01(f / e); }
    else {
        const c = d1.dot(r);
        if (e <= EPS) { t = 0; s = clamp01(-c / a); }
        else {
            const b = d1.dot(d2);
            const denom = a * e - b * b;
            s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }
    _segP.copy(p1).addScaledVector(d1, s);
    _segQ.copy(p2).addScaledVector(d2, t);
    return _segP.distanceToSquared(_segQ);
}

/**
 * Character melee hits along segment `from`→`to`, tested against a body-covering volume.
 *
 * Mesh raycasting is unreliable for skinned (Asset Forger) characters — the GLB raycasts
 * expensively and its block proxy can be mis-aligned. Instead we build an upright capsule
 * that ENCLOSES the visible mesh's world bounding box (`npcHitRoot`), enlarged by
 * `MELEE_BODY_HIT_MARGIN`, so the hit volume tracks the actual graphics and is slightly
 * generous — swings that visually connect register. Falls back to the stored physics
 * capsule (`capsuleRadius`/`capsuleHalfHeight`, centred on the live body translation) when
 * the body AABB is unavailable. Each candidate is a tagged mesh (see
 * NpcController.storePhysicsBodyInMeshes). Returns Intersection-shaped records (object +
 * point + distance) so they drop into processWeaponHits alongside ray hits; dedup by body.
 */
export function gatherMeleeBodyHits(
    scene: THREE.Scene,
    from: THREE.Vector3,
    to: THREE.Vector3,
    bladeRadius: number,
): THREE.Intersection[] {
    const hits: THREE.Intersection[] = [];
    const seen = new Set<unknown>();
    scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const ud = mesh.userData;
        const damageable = ud.damageableController || ud.enemyController;
        const body = ud.physicsBody as { translation(): { x: number; y: number; z: number } } | undefined;
        if (!damageable || !body || seen.has(body)) return;
        seen.add(body);

        const hitRoot = ud.npcHitRoot as THREE.Object3D | null | undefined;
        let radius: number;
        if (hitRoot) computeCharacterBodyBox(hitRoot, _bodyBox);
        else _bodyBox.makeEmpty();
        if (!_bodyBox.isEmpty()) {
            // Primary: enclose the actual rendered body (minus held weapons), slightly enlarged.
            _bodyBox.getCenter(_capCenter);
            _bodyBox.getSize(_bodySize);
            radius = Math.max(_bodySize.x, _bodySize.z) / 2 + bladeRadius + MELEE_BODY_HIT_MARGIN;
            const halfSpine = Math.max(0, _bodySize.y / 2 - radius + MELEE_BODY_HIT_MARGIN);
            _capA.set(_capCenter.x, _capCenter.y - halfSpine, _capCenter.z);
            _capB.set(_capCenter.x, _capCenter.y + halfSpine, _capCenter.z);
        } else {
            // Fallback: the stored physics capsule, centred on the live body translation.
            const r = ud.capsuleRadius as number | undefined;
            const hh = ud.capsuleHalfHeight as number | undefined;
            if (r === undefined || hh === undefined) return;
            const c = body.translation();
            _capCenter.set(c.x, c.y, c.z);
            _capA.set(c.x, c.y - hh, c.z);
            _capB.set(c.x, c.y + hh, c.z);
            radius = r + bladeRadius;
        }

        if (segmentSegmentDistanceSq(from, to, _capA, _capB) <= radius * radius) {
            hits.push({
                distance: _capCenter.distanceTo(from),
                point: _capCenter.clone(),
                object: mesh,
            } as unknown as THREE.Intersection);
        }
    });
    return hits;
}

const _hcA = new THREE.Vector3();
const _hcB = new THREE.Vector3();

/**
 * True if segment `from`→`to` passes within `radius` of an upright capsule whose spine runs
 * `center.y ± halfSpine`. Shared by every melee path that tests a single known character
 * capsule (e.g. an NPC's sword sweep against the player). Pass `radius` already including the
 * blade girth and any forgiveness margin.
 */
export function segmentHitsCapsule(
    from: THREE.Vector3,
    to: THREE.Vector3,
    center: THREE.Vector3,
    halfSpine: number,
    radius: number,
): boolean {
    _hcA.set(center.x, center.y - halfSpine, center.z);
    _hcB.set(center.x, center.y + halfSpine, center.z);
    return segmentSegmentDistanceSq(from, to, _hcA, _hcB) <= radius * radius;
}
