import { createSkinDiffusionKernel } from 'engine/hero/SkinDiffusionKernel.js';

test('profile conserves each channel, is symmetric and retains a narrow core', () => {
    const taps = createSkinDiffusionKernel();
    expect(taps).toHaveLength(25);
    expect(taps[0]!.offset).toBe(0);
    for (let c = 0; c < 3; c++) {
        expect(taps.reduce((s, t) => s + t.weight[c]!, 0)).toBeCloseTo(1, 12);
        expect(taps[0]!.weight[c]).toBeGreaterThan(0.5);
        for (const t of taps) {
            expect(t.weight[c]).toBeGreaterThanOrEqual(0);
            const opposite = taps.find(p => Math.abs(p.offset + t.offset) < 1e-10)!;
            expect(t.weight[c]).toBeCloseTo(opposite.weight[c]!, 12);
        }
    }
    const variance = [0, 1, 2].map(c => taps.reduce((sum, t) => sum + t.offset ** 2 * t.weight[c]!, 0));
    expect(variance[0]).toBeGreaterThan(variance[1]!);
    expect(variance[1]).toBeGreaterThan(variance[2]!);
});

test('zero scattering is exactly the identity kernel and profiles reject invalid units', () => {
    const taps = createSkinDiffusionKernel([1, 1, 1], [0, 0, 0]);
    expect(taps[0]!.weight).toEqual([1, 1, 1]);
    expect(taps.slice(1).every(t => t.weight.every(v => v === 0))).toBe(true);
    expect(() => createSkinDiffusionKernel([0, 1, 1])).toThrow();
    expect(() => createSkinDiffusionKernel([1, 1, 1], [1, 1, 1], 24)).toThrow();
});
