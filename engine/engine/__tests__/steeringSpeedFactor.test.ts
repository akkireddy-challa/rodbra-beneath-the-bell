import { steeringSpeedFactor, resolveVehicleHandling, HANDLING_DEFAULTS } from 'engine/vehicleHandling.js';

/**
 * Regression guard for the 2026-07-26 "AI cars understeer off every track" bug:
 * setAIControls softened steering by RAW speed with no floor, so the 2026-07-24
 * top-speed raise (12 -> 28 m/s default, 34 on racing presets) silently crushed
 * AI steering authority below what any circuit corner needs, while the player
 * path (updateControls) kept its minSteerAtSpeed floor and stayed fine.
 */
describe('steeringSpeedFactor', () => {
    const h = resolveVehicleHandling(undefined, 1);

    it('leaves full authority at standstill', () => {
        expect(steeringSpeedFactor(0, 1, h)).toBe(1);
    });

    it('applies the minSteerAtSpeed floor at the new default top speed', () => {
        // Unfloored, 28 m/s leaves 1/(1+28*0.15) ~= 0.19 — the broken value.
        const unfloored = 1 / (1 + 28 * h.steerSpeedFalloff);
        expect(unfloored).toBeLessThan(h.minSteerAtSpeed); // the regression scenario is real
        expect(steeringSpeedFactor(28, 1, h)).toBe(h.minSteerAtSpeed);
    });

    it('keeps the floor for small (kart-sized) vehicles at racing-preset speeds', () => {
        // Kart from the repro game: footprint 2.82m -> sizeFactor ~0.83, topSpeed 34.
        expect(steeringSpeedFactor(34, 0.83, h)).toBe(h.minSteerAtSpeed);
    });

    it('normalizes speed by vehicle size so small cars soften over their own speed range', () => {
        // Same absolute speed softens a small car MORE than a big one (before the floor).
        const gentle = { steerSpeedFalloff: HANDLING_DEFAULTS.steerSpeedFalloff, minSteerAtSpeed: 0 };
        expect(steeringSpeedFactor(10, 0.5, gentle)).toBeLessThan(steeringSpeedFactor(10, 1, gentle));
    });

    it('clamps degenerate size factors instead of dividing by ~zero', () => {
        expect(steeringSpeedFactor(10, 0, h)).toBeGreaterThanOrEqual(h.minSteerAtSpeed);
        expect(Number.isFinite(steeringSpeedFactor(10, 0, h))).toBe(true);
    });
});
