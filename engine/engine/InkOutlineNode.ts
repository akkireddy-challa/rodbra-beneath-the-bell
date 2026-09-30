/**
 * Scene-wide black "ink" outline (WebGPU / TSL post-process) — the load-bearing
 * ingredient of the Borderlands look on voxels.
 *
 * A full-screen edge detector over the scene pass's DEPTH and view-space NORMAL
 * buffers (both already produced by the MRT in `GameEnginePostFx`). Where either
 * discontinues — an object's silhouette against what's behind it, or a crease
 * between two differently-facing faces — the beauty image is darkened toward the
 * outline colour. Because it reads the g-buffer and rewrites the composited
 * colour node, it is pure post-process: no material or shader-cache involvement
 * (unlike the cel lighting model), so it reliably runs.
 *
 * The classic-composer twin is `InkOutlinePassWebGL.ts`, which runs the same
 * edge detector over a normal + depth pre-pass it renders itself — see
 * `game/docs/renderer-backends.md` for the dual-path contract.
 *
 * three ships an untyped node/TSL surface, so — as in `StylizedOceanMaterial` —
 * nodes are carried as the branded `Node<T>` type and loosely-typed inputs are
 * reached through a narrow structural view.
 */
import * as THREE from 'three';
import {
    screenUV, screenSize, vec2, vec3, vec4, float, dot, abs, max, smoothstep, mix,
    perspectiveDepthToViewZ,
} from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';

type FloatNode = Node<'float'>;
type Vec2Node = Node<'vec2'>;
type Vec3Node = Node<'vec3'>;
type Vec4Node = Node<'vec4'>;

/** A g-buffer texture node — the pass outputs from `scenePass.getTextureNode()`.
 *  Only `.sample(uv)` is needed here; typed narrowly since three ships no node
 *  `.d.ts` and the pass's return type doesn't unify cleanly. */
interface SampleableTexture {
    sample(uv: Vec2Node): Vec4Node;
}

/** Resolved look of the ink outline (see `InkOutlineConfig` in types/game.ts). */
export interface InkOutlineParams {
    color: THREE.Color;
    /** Edge-sample offset in pixels. */
    thickness: number;
    /** Normal-edge trigger on summed (1 − dot) over 4 taps, range 0..8. */
    normalThreshold: number;
    /**
     * Depth-edge trigger, dimensionless. It compares the SECOND derivative of
     * linearized (view-space) depth to the FIRST: a smooth surface — even one seen
     * at a grazing angle — is locally linear, so the ratio is ~0, while a true
     * silhouette (a depth step) spikes it. Angle-robust, unlike a raw depth delta.
     */
    depthThreshold: number;
    /** Line opacity 0..1. */
    strength: number;
    /** Camera near plane (for depth linearization). */
    near: number;
    /** Camera far plane (for depth linearization). */
    far: number;
}

/** Balanced default look: a thin, opaque black line. (near/far are per-camera and
 *  always supplied by the caller — the placeholders here are never used.) */
export const DEFAULT_INK_OUTLINE: Omit<InkOutlineParams, 'near' | 'far'> = {
    color: new THREE.Color(0x000000),
    thickness: 1.5,
    normalThreshold: 0.6,
    depthThreshold: 0.5,
    strength: 1.0,
};

/**
 * Darken `sceneColor` along depth/normal edges. Returns a new colour node; the
 * caller assigns it back into the pipeline's `result`.
 *
 * A 4-tap axis cross (±x, ±y at `thickness` pixels) drives two independent edge
 * signals — normal discontinuity (interior creases + silhouettes against the
 * skybox, whose dome writes its own normals) and depth discontinuity (silhouettes
 * where normals happen to align across a depth gap). Each is thresholded with a
 * soft ramp and the stronger wins, so a line reads once rather than doubling up.
 */
export function applyInkOutline(
    sceneColor: Vec4Node,
    depthTex: SampleableTexture,
    normalTex: SampleableTexture,
    params: InkOutlineParams,
): Vec4Node {
    const uv = screenUV;
    // Per-axis UV step for a `thickness`-pixel offset.
    const step: Vec2Node = vec2(1).div(screenSize).mul(params.thickness);
    const dx: Vec2Node = vec2(step.x, 0);
    const dy: Vec2Node = vec2(0, step.y);

    const sampleN = (at: Vec2Node): Vec3Node => normalTex.sample(at).xyz;
    const sampleD = (at: Vec2Node): FloatNode => depthTex.sample(at).r;

    const nC = sampleN(uv);
    const nR = sampleN(uv.add(dx));
    const nL = sampleN(uv.sub(dx));
    const nU = sampleN(uv.add(dy));
    const nD = sampleN(uv.sub(dy));
    // 4 − Σ dot(center, neighbour): 0 when all identical, up to 8 at a hard crease.
    const normalEdge: FloatNode = float(4)
        .sub(dot(nC, nR)).sub(dot(nC, nL)).sub(dot(nC, nU)).sub(dot(nC, nD));

    // Linearize depth to view space so the derivatives below are geometric, not
    // warped by the perspective depth curve.
    const near = float(params.near);
    const far = float(params.far);
    const linZ = (at: Vec2Node): FloatNode => perspectiveDepthToViewZ(sampleD(at), near, far);
    const zC = linZ(uv);
    const zR = linZ(uv.add(dx));
    const zL = linZ(uv.sub(dx));
    const zU = linZ(uv.add(dy));
    const zD = linZ(uv.sub(dy));
    // Second derivative (curvature) vs first (slope), per axis. A locally-linear
    // surface — flat ground even at a grazing angle — has curvature ≈ 0 whatever
    // its slope, so the ratio stays low; a depth step spikes the curvature. EPS
    // both guards the divide and floors the response on near-flat-facing surfaces
    // (slope ≈ 0), where curvature is also ≈ 0.
    const EPS = float(0.05);
    const curvature: FloatNode = abs(zL.add(zR).sub(zC.mul(2)))
        .add(abs(zU.add(zD).sub(zC.mul(2))));
    const slope: FloatNode = abs(zR.sub(zL)).add(abs(zU.sub(zD)));
    const depthEdge: FloatNode = curvature.div(slope.add(EPS));

    const nMask = smoothstep(params.normalThreshold, params.normalThreshold + 0.1, normalEdge);
    const dMask = smoothstep(params.depthThreshold, params.depthThreshold * 2, depthEdge);
    const edge: FloatNode = max(nMask, dMask).mul(params.strength);

    const line = vec3(params.color.r, params.color.g, params.color.b);
    return vec4(mix(sceneColor.rgb, line, edge), sceneColor.a);
}
