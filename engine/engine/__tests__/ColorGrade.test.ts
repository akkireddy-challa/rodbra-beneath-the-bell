import {
    ColorGradeState,
    DEFAULT_COLOR_GRADING,
    DEFAULT_VIGNETTE,
    resolveColorGrading,
    resolveVignette,
} from 'engine/ColorGradeNode.js';

describe('resolveColorGrading', () => {
    it('is the identity grade when nothing is set', () => {
        expect(resolveColorGrading({ enabled: true })).toEqual(DEFAULT_COLOR_GRADING);
        expect(resolveColorGrading(null)).toEqual(DEFAULT_COLOR_GRADING);
    });

    it('keeps set fields and clamps out-of-range ones', () => {
        const p = resolveColorGrading({ enabled: true, saturation: 9, contrast: 1.2, temperature: -4, gamma: [0, 1, 20] });
        expect(p.saturation).toBe(3);
        expect(p.contrast).toBe(1.2);
        expect(p.temperature).toBe(-1);
        expect(p.gamma).toEqual([0.1, 1, 5]);
    });
});

describe('resolveVignette', () => {
    it('fills defaults and clamps intensity', () => {
        expect(resolveVignette({ enabled: true })).toEqual(DEFAULT_VIGNETTE);
        expect(resolveVignette({ enabled: true, intensity: 2 }).intensity).toBe(1);
    });
});

describe('ColorGradeState', () => {
    it('writes the same values to the TSL and GLSL uniforms', () => {
        const s = new ColorGradeState();
        s.setGrade(resolveColorGrading({ enabled: true, saturation: 0, temperature: 1 }));
        expect(s.saturation.value).toBe(0);
        expect(s.glUniforms.saturation.value).toBe(0);
        expect(s.glUniforms.whiteBalance.value.x).toBeCloseTo(1.2);
        expect(s.whiteBalance.value.z).toBeCloseTo(0.8);
    });

    it('writes the identity grade and a zero vignette when disabled', () => {
        const s = new ColorGradeState();
        s.setGrade(resolveColorGrading({ enabled: true, contrast: 2 }));
        s.setVignette(resolveVignette({ enabled: true, intensity: 0.8 }));
        s.setGrade(null);
        s.setVignette(null);
        expect(s.contrast.value).toBe(1);
        expect(s.glUniforms.vignetteIntensity.value).toBe(0);
    });

    it('keeps the vignette colour in display (sRGB) values', () => {
        const s = new ColorGradeState();
        s.setVignette(resolveVignette({ enabled: true, color: '#808080' }));
        expect(s.glUniforms.vignetteColor.value.r).toBeCloseTo(128 / 255, 2);
    });
});
