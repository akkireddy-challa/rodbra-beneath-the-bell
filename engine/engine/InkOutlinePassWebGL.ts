/**
 * WebGL (classic `EffectComposer`) twin of the ink outline in `InkOutlineNode.ts`.
 *
 * The WebGPU path reads depth + view normals straight from the scene pass's MRT.
 * Classic `RenderPass` produces neither, so this pass renders a cheap normal +
 * depth PRE-PASS itself: the scene re-drawn once with `MeshNormalMaterial` as an
 * override into an offscreen target whose `DepthTexture` captures depth. It then
 * runs the SAME edge detector as the TSL node — normal-discontinuity plus an
 * angle-robust depth curvature/slope ratio on linearized depth — and darkens the
 * composited colour along edges.
 *
 * Kept behaviourally parallel to `applyInkOutline`; see that file for the why of
 * each term. See `game/docs/renderer-backends.md` for the dual-path contract.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { InkOutlineParams } from 'engine/InkOutlineNode.js';

const VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FRAG = /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec3 lineColor;
    uniform float thickness;
    uniform float normalThreshold;
    uniform float depthThreshold;
    uniform float strength;
    varying vec2 vUv;

    // three's perspectiveDepthToViewZ (negative, view space). Makes the depth
    // derivatives geometric rather than warped by the perspective depth curve.
    float linZ(float d) {
        return (cameraNear * cameraFar) / ((cameraFar - cameraNear) * d - cameraFar);
    }
    // MeshNormalMaterial packs the VIEW normal into RGB as n*0.5+0.5.
    vec3 readN(vec2 uv) { return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0); }
    float readD(vec2 uv) { return texture2D(tDepth, uv).x; }

    void main() {
        vec4 col = texture2D(tDiffuse, vUv);
        vec2 texel = (1.0 / resolution) * thickness;
        vec2 dx = vec2(texel.x, 0.0);
        vec2 dy = vec2(0.0, texel.y);

        vec3 nC = readN(vUv);
        float normalEdge = 4.0
            - dot(nC, readN(vUv + dx)) - dot(nC, readN(vUv - dx))
            - dot(nC, readN(vUv + dy)) - dot(nC, readN(vUv - dy));

        float zC = linZ(readD(vUv));
        float zR = linZ(readD(vUv + dx));
        float zL = linZ(readD(vUv - dx));
        float zU = linZ(readD(vUv + dy));
        float zD = linZ(readD(vUv - dy));
        float curvature = abs(zL + zR - 2.0 * zC) + abs(zU + zD - 2.0 * zC);
        float slope = abs(zR - zL) + abs(zU - zD);
        float depthEdge = curvature / (slope + 0.05);

        float nMask = smoothstep(normalThreshold, normalThreshold + 0.1, normalEdge);
        float dMask = smoothstep(depthThreshold, depthThreshold * 2.0, depthEdge);
        float edge = max(nMask, dMask) * strength;

        gl_FragColor = vec4(mix(col.rgb, lineColor, edge), col.a);
    }
`;

/** The pass's own uniforms — held typed so `noUncheckedIndexedAccess` doesn't
 *  make every `material.uniforms[x]` possibly-undefined. */
interface InkUniforms {
    tDiffuse: { value: THREE.Texture | null };
    tNormal: { value: THREE.Texture };
    tDepth: { value: THREE.Texture | null };
    resolution: { value: THREE.Vector2 };
    cameraNear: { value: number };
    cameraFar: { value: number };
    lineColor: { value: THREE.Color };
    thickness: { value: number };
    normalThreshold: { value: number };
    depthThreshold: { value: number };
    strength: { value: number };
}

/** Classic-composer ink outline. Add to the `EffectComposer` like any `Pass`.
 *  The look is fixed at construction — `rebuildComposerPasses` recreates (and
 *  disposes) the pass whenever the config changes, so there is no setter. */
export class InkOutlinePassWebGL extends Pass {
    private readonly scene: THREE.Scene;
    private readonly camera: THREE.PerspectiveCamera;
    private readonly normalRT: THREE.WebGLRenderTarget;
    private readonly normalMaterial = new THREE.MeshNormalMaterial();
    private readonly material: THREE.ShaderMaterial;
    private readonly fsQuad: FullScreenQuad;
    private readonly u: InkUniforms;

    constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, params: InkOutlineParams) {
        super();
        this.scene = scene;
        this.camera = camera;

        const depthTexture = new THREE.DepthTexture(1, 1);
        depthTexture.type = THREE.UnsignedIntType;
        this.normalRT = new THREE.WebGLRenderTarget(1, 1, { depthTexture });

        this.u = {
            tDiffuse: { value: null },
            tNormal: { value: this.normalRT.texture },
            tDepth: { value: this.normalRT.depthTexture },
            resolution: { value: new THREE.Vector2(1, 1) },
            cameraNear: { value: camera.near },
            cameraFar: { value: camera.far },
            lineColor: { value: new THREE.Color(params.color) },
            thickness: { value: params.thickness },
            normalThreshold: { value: params.normalThreshold },
            depthThreshold: { value: params.depthThreshold },
            strength: { value: params.strength },
        };
        this.material = new THREE.ShaderMaterial({
            // Named interface → three's index-signature uniform bag. Same object
            // by reference, so mutating `this.u` drives the shader.
            uniforms: this.u as unknown as { [uniform: string]: THREE.IUniform },
            vertexShader: VERT,
            fragmentShader: FRAG,
        });
        this.fsQuad = new FullScreenQuad(this.material);
    }

    setSize(width: number, height: number): void {
        this.normalRT.setSize(width, height);
        this.u.resolution.value.set(width, height);
    }

    render(
        renderer: THREE.WebGLRenderer,
        writeBuffer: THREE.WebGLRenderTarget,
        readBuffer: THREE.WebGLRenderTarget,
    ): void {
        // 1. Normal + depth pre-pass: the whole scene once with a normal override.
        // The camera's own layer mask excludes the shadow-only meshes, so they
        // don't pollute the g-buffer. near/far may drift, so refresh them.
        const prevRT = renderer.getRenderTarget();
        const prevOverride = this.scene.overrideMaterial;
        this.scene.overrideMaterial = this.normalMaterial;
        renderer.setRenderTarget(this.normalRT);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        this.scene.overrideMaterial = prevOverride;

        // 2. Edge detect over the beauty (readBuffer) → writeBuffer / screen.
        this.u.tDiffuse.value = readBuffer.texture;
        this.u.cameraNear.value = this.camera.near;
        this.u.cameraFar.value = this.camera.far;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        if (this.clear) renderer.clear();
        this.fsQuad.render(renderer);
        renderer.setRenderTarget(prevRT);
    }

    dispose(): void {
        this.normalRT.dispose();
        this.normalMaterial.dispose();
        this.material.dispose();
        this.fsQuad.dispose();
    }
}
