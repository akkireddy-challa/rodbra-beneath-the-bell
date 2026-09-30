import * as THREE from 'three';
import { scatterAimPoints, DEFAULT_PELLET_SPREAD_RAD } from 'engine/weapons/PelletSpread.js';

/**
 * A shotgun's pattern, as numbers: the centre pellet is always exact, every
 * other pellet stays inside the cone, and a seeded source reproduces the same
 * pattern — which is what lets a volley replay or replicate.
 */

const muzzle = new THREE.Vector3(0, 1, 0);
const aim = new THREE.Vector3(0, 1, 20);

/** Angle between the line of fire and the line to a pellet's aim point. */
function angleOf(point: THREE.Vector3): number {
    const a = aim.clone().sub(muzzle).normalize();
    const b = point.clone().sub(muzzle).normalize();
    return Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
}

function seeded(seed: number): () => number {
    let s = seed;
    return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

describe('scatterAimPoints', () => {
    it('returns exactly the requested number of pellets, centre first', () => {
        const points = scatterAimPoints(muzzle, aim, 8, DEFAULT_PELLET_SPREAD_RAD, seeded(1));
        expect(points.length).toBe(8);
        expect(points[0]!.distanceTo(aim)).toBe(0);
    });

    it('keeps every pellet inside the cone', () => {
        const spread = 0.08;
        const points = scatterAimPoints(muzzle, aim, 64, spread, seeded(7));
        for (const p of points) expect(angleOf(p)).toBeLessThanOrEqual(spread + 1e-9);
    });

    it('actually spreads — pellets are not all on the aim point', () => {
        const points = scatterAimPoints(muzzle, aim, 8, DEFAULT_PELLET_SPREAD_RAD, seeded(3));
        const spreadOut = points.slice(1).filter((p) => angleOf(p) > 0.005).length;
        expect(spreadOut).toBeGreaterThan(4);
    });

    it('is deterministic for a seed', () => {
        const a = scatterAimPoints(muzzle, aim, 8, 0.08, seeded(42)).map((p) => p.toArray());
        const b = scatterAimPoints(muzzle, aim, 8, 0.08, seeded(42)).map((p) => p.toArray());
        expect(a).toEqual(b);
    });

    it('collapses to the aim point with zero spread', () => {
        for (const p of scatterAimPoints(muzzle, aim, 6, 0, seeded(1))) {
            expect(p.distanceTo(aim)).toBe(0);
        }
    });

    it('never produces NaN when the aim point sits on the muzzle', () => {
        const points = scatterAimPoints(muzzle, muzzle.clone(), 6, 0.08, seeded(1));
        expect(points.length).toBe(6);
        for (const p of points) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    });

    it('handles a vertical line of fire without a degenerate basis', () => {
        const up = new THREE.Vector3(0, 30, 0);
        const points = scatterAimPoints(new THREE.Vector3(), up, 12, 0.1, seeded(5));
        for (const p of points) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    });

    it('treats a count below one as a single pellet', () => {
        expect(scatterAimPoints(muzzle, aim, 0, 0.08, seeded(1)).length).toBe(1);
    });
});
