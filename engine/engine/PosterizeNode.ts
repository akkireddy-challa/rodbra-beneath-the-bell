/**
 * Final-image posterize (WebGPU / TSL post-process) — the tonal half of the
 * comic / "Borderlands" look, the companion to the ink outline.
 *
 * Where per-material cel banding failed on voxels (flat faces already read as one
 * tone, and the distance-fade LOD rebuilds materials so a custom lighting model
 * never survives to draw), this quantizes the COMPOSITED image instead: one
 * post-process node, no material surgery, applies uniformly to terrain, objects
 * and everything else. It flattens continuous shading into a handful of tonal
 * bands, which is what reads as "cel" at the image level.
 *
 * Hue-preserving by construction: only the LUMINANCE is quantized and the colour
 * is rescaled to it, so a red stays red and only its brightness snaps to a band.
 * The quantization happens in a bounded Reinhard domain (`x/(1+x)`) so bright HDR
 * values — bloom, emissive — occupy their own top bands instead of all clipping
 * into one.
 *
 * The classic-composer twin is {@link POSTERIZE_SHADER} at the bottom of this
 * file (see `game/docs/renderer-backends.md` for the dual-path contract). three
 * ships an untyped node/TSL surface, so nodes are carried as the branded
 * `Node<T>` type (as in `InkOutlineNode`).
 */
import { dot, vec3, vec4, float, mix } from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';

type Vec4Node = Node<'vec4'>;

/** Rec. 709 luma weights — the perceived-brightness axis we quantize. */
const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** Resolved look of the posterize pass (see `PosterizeConfig` in types/game.ts). */
export interface PosterizeParams {
    /** Number of flat tonal bands. 3–6 reads comic; higher dissolves toward smooth. */
    levels: number;
    /** Blend 0..1 between the original image and the fully-posterized one. */
    strength: number;
}

/** Balanced default: five bands at full strength. */
export const DEFAULT_POSTERIZE: PosterizeParams = { levels: 5, strength: 1.0 };

/**
 * Quantize `sceneColor`'s luminance into `levels` flat bands, preserving hue.
 * Returns a new colour node for the caller to assign back into the pipeline.
 *
 * Band CENTRES are used — `(floor(v·L) + 0.5) / L` — so the quantized perceptual
 * value never reaches 0 or 1, which keeps the Reinhard inversion `b/(1−b)` finite
 * at the top band and stops the darkest band crushing to pure black.
 */
export function applyPosterize(sceneColor: Vec4Node, params: PosterizeParams): Vec4Node {
    const levels = Math.max(2, Math.round(params.levels));
    const rgb = sceneColor.rgb;
    // Guard against a zero luminance (black) before dividing back through it.
    const lum = dot(rgb, LUMA).max(1e-4);
    // Bounded perceptual axis: linear HDR → (0,1), quantize, → back to HDR.
    const v = lum.div(lum.add(1));
    const band = v.mul(levels).floor().add(0.5).div(levels);
    const lumQ = band.div(float(1).sub(band));
    const posterized = rgb.mul(lumQ.div(lum));
    return vec4(mix(rgb, posterized, params.strength), sceneColor.a);
}

/**
 * WebGL (classic) twin of {@link applyPosterize} — the identical hue-preserving
 * luminance quantize, as a `ShaderPass` shader over the composited colour
 * (`tDiffuse`). Kept line-for-line parallel with the TSL version above; the
 * pipeline builds a `ShaderPass(POSTERIZE_SHADER)` on the WebGL branch.
 */
export const POSTERIZE_SHADER = {
    uniforms: {
        tDiffuse: { value: null as unknown },
        levels: { value: DEFAULT_POSTERIZE.levels },
        strength: { value: DEFAULT_POSTERIZE.strength },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float levels;
        uniform float strength;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            float lum = max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
            float v = lum / (lum + 1.0);                       // bounded perceptual axis
            float band = (floor(v * levels) + 0.5) / levels;   // band centre in (0,1)
            float lumQ = band / (1.0 - band);                  // back to HDR
            vec3 posterized = c.rgb * (lumQ / lum);
            gl_FragColor = vec4(mix(c.rgb, posterized, strength), c.a);
        }
    `,
};
