import * as THREE from 'three';
import { findValidatedSpawnPosition } from 'engine/npc/core/findValidatedSpawnPosition.js';

describe('findValidatedSpawnPosition', () => {
    it('does not attempt coords outside a 10-metre cap around explicit requested coords on a 100m world', () => {
        // World is 100m → maxRadius = clamp(min(100,100)*0.1, 3, 20) = 10.
        // Validator rejects every attempt so we observe ALL drift positions tried.
        // The radius applies before voxel-centre snapping, which can add up to one
        // voxel diagonal (~√2 m) of quantisation overshoot — assert ≤ 12 to cover it.
        const calls: Array<{ x: number; z: number }> = [];
        const validator = (x: number, z: number) => {
            calls.push({ x, z });
            return null;
        };

        findValidatedSpawnPosition(100, 100, 0, 0, validator);

        expect(calls.length).toBeGreaterThan(1);
        for (const c of calls) {
            const dx = c.x - 0.5;
            const dz = c.z - 0.5;
            expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(12);
        }
    });

    it('uses worldwide random sampling when no explicit coords are passed (legacy wave-spawn behaviour)', () => {
        // No spawnX/Z → all retries should sample uniformly across a 200×200 world,
        // not cluster within a 10m cap around any specific point.
        const calls: Array<{ x: number; z: number }> = [];
        const validator = (x: number, z: number) => {
            calls.push({ x, z });
            return null;
        };

        findValidatedSpawnPosition(200, 200, undefined, undefined, validator);

        // Coordinate range must exceed any per-point drift cap (≤20m). For 10 uniform
        // draws across ±100 the expected x-range is far wider than 40 — assert ≥50 as
        // a generous-but-still-discriminating threshold.
        const xs = calls.map(c => c.x);
        const zs = calls.map(c => c.z);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(50);
        expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(50);
    });

    it('clamps an explicit coord that lies outside the world to the nearest in-bounds voxel before searching', () => {
        // On a 64m world (half = 32), every voxel centre lives in [-31.5, 31.5].
        // A caller asking for x=100 is plainly outside; we should snap to the edge
        // in the requested direction so the search still happens inside the world
        // rather than wasting all 10 attempts on coords no terrain will validate.
        const calls: Array<{ x: number; z: number }> = [];
        const validator = (x: number, z: number) => {
            calls.push({ x, z });
            return null;
        };

        findValidatedSpawnPosition(64, 64, 100, -100, validator);

        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
            expect(c.x).toBeGreaterThanOrEqual(-31.5);
            expect(c.x).toBeLessThanOrEqual(31.5);
            expect(c.z).toBeGreaterThanOrEqual(-31.5);
            expect(c.z).toBeLessThanOrEqual(31.5);
        }
        // First attempt must be the clamped requested point, not a random one.
        expect(calls[0]).toEqual({ x: 31.5, z: -31.5 });
    });

    it('does NOT clamp an in-level coord on a corner-origin (baked .vwld) world', () => {
        // Baked levels are corner-origin: valid coords live in [0, size], not the
        // centred [-size/2, size/2]. With origin 0 a request at (336, 509) on a 768m
        // level is well inside the map and must be used as-is. (Without the origin it
        // would clamp to z≈383.5 — the "all NPCs in one corner" bug.)
        let callCount = 0;
        const validator = (x: number, z: number) => {
            callCount++;
            return new THREE.Vector3(x, 7, z);
        };

        const result = findValidatedSpawnPosition(768, 768, 336, 509, validator, 0, 0);

        expect(callCount).toBe(1);
        expect(result!.x).toBe(336.5);
        expect(result!.z).toBe(509.5);
    });

    it('clamps to the corner-origin range [0, size] when origin is 0', () => {
        // A request beyond the far edge clamps to size-0.5; a negative request to 0.5.
        const calls: Array<{ x: number; z: number }> = [];
        const validator = (x: number, z: number) => {
            calls.push({ x, z });
            return null;
        };

        findValidatedSpawnPosition(64, 64, 100, -100, validator, 0, 0);

        for (const c of calls) {
            expect(c.x).toBeGreaterThanOrEqual(0.5);
            expect(c.x).toBeLessThanOrEqual(63.5);
            expect(c.z).toBeGreaterThanOrEqual(0.5);
            expect(c.z).toBeLessThanOrEqual(63.5);
        }
        expect(calls[0]).toEqual({ x: 63.5, z: 0.5 });
    });

    it('defaults to a centred world when no origin is passed (procedural unchanged)', () => {
        // Regression guard: omitting origin reproduces the centred [-W/2, W/2] clamp.
        const calls: Array<{ x: number; z: number }> = [];
        const validator = (x: number, z: number) => {
            calls.push({ x, z });
            return null;
        };

        findValidatedSpawnPosition(64, 64, 100, -100, validator);

        expect(calls[0]).toEqual({ x: 31.5, z: -31.5 });
    });

    it('returns the snapped requested coord on the first attempt when the validator accepts', () => {
        let callCount = 0;
        const validator = (x: number, z: number) => {
            callCount++;
            return new THREE.Vector3(x, 5, z);
        };

        const result = findValidatedSpawnPosition(100, 100, 10.3, 20.7, validator);

        expect(callCount).toBe(1);
        expect(result).not.toBeNull();
        expect(result!.x).toBe(10.5);
        expect(result!.z).toBe(20.5);
        expect(result!.y).toBe(5);
    });
});
