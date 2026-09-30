import { applyWebGPUSwizzleFix, unchainWgslSwizzles } from 'engine/WebGPUSwizzleFix.js';

/**
 * Chrome 153's Metal shader compiler rejects `a.xy.x`. The rewrite has to turn
 * every such chain into the single swizzle it already means, and must not touch
 * anything that is not one — a wrong rewrite here is a silently different image
 * on every WebGPU game.
 */
describe('unchainWgslSwizzles', () => {
    it('collapses the two chains three actually emits', () => {
        // getAlphaHashThreshold: `nodeVar3.xy.x`; the DFG lookup: `nodeVar34.xy.y`.
        expect(unchainWgslSwizzles('( ( 17.0 * nodeVar3.xy.x ) + ( 0.1 * nodeVar3.xy.y ) )'))
            .toBe('( ( 17.0 * nodeVar3.x ) + ( 0.1 * nodeVar3.y ) )');
    });

    it('maps the outer lane through the inner swizzle, not positionally', () => {
        expect(unchainWgslSwizzles('a.zw.x')).toBe('a.z');
        expect(unchainWgslSwizzles('a.zw.y')).toBe('a.w');
        expect(unchainWgslSwizzles('a.yx.x')).toBe('a.y');
        expect(unchainWgslSwizzles('a.zw.yx')).toBe('a.wz');
        expect(unchainWgslSwizzles('c.rgb.g')).toBe('c.g');
        expect(unchainWgslSwizzles('c.rgb.x')).toBe('c.r');
    });

    it('keeps collapsing until nothing is chained', () => {
        expect(unchainWgslSwizzles('v.xyzw.xyz.xy.x')).toBe('v.x');
    });

    it('leaves a single swizzle, a member access and a float literal alone', () => {
        const untouched = [
            'v_positionView.xyz',
            'DiffuseColor.w = 1.0;',
            'object.nodeUniform3 * vec3<f32>( nodeVarying5, 1.0 )',
            'clamp( nodeVar0, 0.000001, 1.0 )',
            'render.cameraViewMatrix',
        ];
        for (const line of untouched) expect(unchainWgslSwizzles(line)).toBe(line);
    });

    it('leaves an out-of-range chain for the compiler to report', () => {
        expect(unchainWgslSwizzles('a.xy.z')).toBe('a.xy.z');
    });
});

describe('applyWebGPUSwizzleFix', () => {
    function device() {
        const seen: string[] = [];
        return {
            seen,
            createShaderModule(d: { code: string }) { seen.push(d.code); return { code: d.code }; },
        };
    }

    it('rewrites the code of every module the device compiles, once installed', () => {
        const dev = device();
        const renderer = { backend: { device: dev } };

        expect(applyWebGPUSwizzleFix(renderer)).toBe(true);
        dev.createShaderModule({ code: 'fn f() { let a = b.xy.x; }' });

        expect(dev.seen).toEqual(['fn f() { let a = b.x; }']);
    });

    it('installs once', () => {
        const dev = device();
        const renderer = { backend: { device: dev } };
        applyWebGPUSwizzleFix(renderer);
        const first = dev.createShaderModule;
        applyWebGPUSwizzleFix(renderer);
        expect(dev.createShaderModule).toBe(first);
    });

    it('does nothing on a renderer with no device — the WebGL2 fallback backend', () => {
        expect(applyWebGPUSwizzleFix({ backend: {} })).toBe(false);
        expect(applyWebGPUSwizzleFix(null)).toBe(false);
    });
});
