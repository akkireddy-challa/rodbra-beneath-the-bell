import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { pass, mrt, renderOutput, output, normalView, uniform, float, vec2, vec3, vec4, metalness, roughness, smoothstep } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { resolveWeatherUrlOverride, weatherWantsSsr, resolveReflectionLook } from 'engine/weather/WeatherSystem.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { getActiveBackend } from 'engine/RendererType.js';
import { applyInkOutline, DEFAULT_INK_OUTLINE, type InkOutlineParams } from 'engine/InkOutlineNode.js';
import { applyPosterize, DEFAULT_POSTERIZE, POSTERIZE_SHADER, type PosterizeParams } from 'engine/PosterizeNode.js';
import { InkOutlinePassWebGL } from 'engine/InkOutlinePassWebGL.js';
import { applyColorGrade, resolveColorGrading, resolveVignette, COLOR_GRADE_FRAGMENT, COLOR_GRADE_VERTEX } from 'engine/ColorGradeNode.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { GameEngine } from 'engine/GameEngine.js';
import type { InkOutlineConfig, PosterizeConfig, RenderConfig } from 'types/game.js';
import { viewModelPassRequired } from 'engine/GameEngineViewModel.js';

/**
 * GameEnginePostFx — assembly of the engine's post-processing chain.
 *
 * A FRIEND MODULE, the same seam VoxelObjectPristineOps/VoxelObjectColliderOps
 * use: GameEngine.ts sits at the repo's 2000-line ESLint cap, so this belongs
 * to the class conceptually but lives here and reaches private state through
 * TypeScript's sanctioned element-access escape hatch (`eng['composer']` —
 * typed, not `any`). Post-effect CONFIG setters stay on the class; only the
 * rebuild lives here.
 *
 * Import-cycle note: GameEngine.ts imports this function. The cycle is safe
 * because the GameEngine binding is only used in type position and inside the
 * function body (call time), never at module evaluation — do NOT add
 * module-level or class-extends usage of GameEngine here.
 */

/** Byte-for-byte the predicate in GameEngine.ts. Copied rather than imported:
 *  a VALUE import from GameEngine would run at module evaluation and make the
 *  cycle above real. (WebGpuSplatMesh.ts carries its own copy for the same
 *  reason.) */
const isWebGpuRenderer = (r: unknown): boolean =>
    (r as { isWebGPURenderer?: boolean } | null)?.isWebGPURenderer === true;

/**
 * WebGL comic passes live here rather than on GameEngine (which is at the 2000-
 * line cap): the classic composer clears its pass list on every rebuild without
 * disposing, and the ink pass owns render targets, so we track and dispose them
 * across rebuilds. Recreated per rebuild — rebuilds are rare (config changes).
 */
let webglInkOutlinePass: InkOutlinePassWebGL | null = null;

/** Whether the current chain was built WITH the grade/vignette pass, so a
 *  runtime setter knows if flipping `enabled` needs a rebuild. */
let builtWithColorGrade = false;

/** MSAA sample count for the composer's scene target when the canvas itself
 *  was created with `antialias` (three clamps it to the device's MAX_SAMPLES). */
const COMPOSER_MSAA_SAMPLES = 4;

/**
 * An EffectComposer whose ping-pong targets are multisampled.
 *
 * The default composer targets carry no MSAA, so switching ANY post effect on
 * silently dropped the canvas's antialiasing — the scene is rasterized into the
 * composer's target, not the canvas. Mirroring the canvas's own `antialias`
 * choice keeps low tiers (created without it) from paying for samples they
 * never had. The same trade three's MSAA post-processing example makes: both
 * targets carry the samples, and each fullscreen pass resolves on write.
 */
function createMsaaComposer(renderer: THREE.WebGLRenderer): EffectComposer {
    const size = renderer.getSize(new THREE.Vector2());
    const samples = renderer.getContext().getContextAttributes()?.antialias === true ? COMPOSER_MSAA_SAMPLES : 0;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    target.texture.name = 'EffectComposer.rt1';
    const composer = new EffectComposer(renderer, target);
    // A supplied target is taken as already device-sized; re-size so the
    // renderer's pixel ratio is applied exactly like the default constructor.
    composer.setSize(size.x, size.y);
    return composer;
}

/** True when either half of the display-referred grade pass is switched on. */
function colorGradeWanted(cfg: RenderConfig | null): boolean {
    return cfg?.colorGrading?.enabled === true || cfg?.vignette?.enabled === true;
}

/**
 * Push the current `renderConfig.colorGrading` / `vignette` into the engine's
 * live uniforms, rebuilding the chain only when the pass must appear or go.
 * Called from `applyRenderConfig` and the runtime `setColorGrading` /
 * `setVignette` setters.
 */
export function syncColorGrade(eng: GameEngine): void {
    const cfg = eng['currentRenderConfig'];
    const state = eng['colorGrade'];
    state.setGrade(cfg?.colorGrading?.enabled === true ? resolveColorGrading(cfg.colorGrading) : null);
    state.setVignette(cfg?.vignette?.enabled === true ? resolveVignette(cfg.vignette) : null);
    if (colorGradeWanted(cfg) !== builtWithColorGrade) rebuildComposerPasses(eng);
}

/** Resolve a game's `inkOutline` config (+ camera near/far) into full params. */
function buildInkParams(cfg: InkOutlineConfig, camera: THREE.PerspectiveCamera): InkOutlineParams {
    return {
        color: cfg.color === undefined ? DEFAULT_INK_OUTLINE.color.clone() : new THREE.Color(cfg.color),
        thickness: cfg.thickness ?? DEFAULT_INK_OUTLINE.thickness,
        normalThreshold: cfg.normalThreshold ?? DEFAULT_INK_OUTLINE.normalThreshold,
        depthThreshold: cfg.depthThreshold ?? DEFAULT_INK_OUTLINE.depthThreshold,
        strength: cfg.strength ?? DEFAULT_INK_OUTLINE.strength,
        near: camera.near,
        far: camera.far,
    };
}

/** Resolve a game's `posterize` config into full params (both backends). */
function buildPosterizeParams(cfg: PosterizeConfig): PosterizeParams {
    return {
        levels: cfg.levels ?? DEFAULT_POSTERIZE.levels,
        strength: cfg.strength ?? DEFAULT_POSTERIZE.strength,
    };
}

/**
 * Rebuild the composer pass chain in canonical order:
 * RenderPass → GTAO → Bloom → DOF → Outline → Posterize → Ink → OutputPass
 * → (display-referred) ColorGrade.
 *
 * Called whenever any post-effect config changes (bloom, DOF, AO, or outline
 * creation). Disposes the composer entirely when no effect is active so the
 * renderer falls back to direct `renderer.render()`.
 *
 * OutputPass is the last HDR pass (only the display-referred grade follows it) — it reads renderer.toneMapping /
 * toneMappingExposure / outputColorSpace and writes the final encoded frame.
 * Without it the composer chain bypasses tone mapping entirely.
 */
export function rebuildComposerPasses(eng: GameEngine): void {
    const renderer = eng['renderer'];
    const scene = eng['scene'];
    const camera = eng['camera'];
    if (!renderer || !scene || !camera) return;

    const isWebGpu = isWebGpuRenderer(renderer);

    const aoConfig = eng['currentAoConfig'];
    const dofConfig = eng['currentDofConfig'];
    const bloomConfig = eng['bloomConfig'];

    // Wet-weather screen-space reflections: the wet road writes its reflectivity
    // into a `metalrough` MRT channel and the SSR node reflects the actual scene into
    // puddles. URL-merged so `?weather=rain` test drives get the full pipeline.
    //
    // Gated on the real BACKEND (`getActiveBackend`), not on the renderer class — the
    // class flag is true on the WebGL2 fallback too, so "WebGPU only" silently included
    // every iOS device, where a raymarched screen-space pass plus a third MRT
    // attachment at the device pixel ratio is what a phone has least of. That is a
    // level whose weather says `reflections: "ssr"` crashing on iPhone and nowhere
    // else. `WeatherSystem` already gates its compute rain this way — the SSR pass,
    // configured by the same weather block, was the one that did not.
    //
    // Also off below the top rung outright: a phone that DOES have WebGPU (Android) can
    // build the pass, and still should not pay for it.
    //
    // The backend check is a CORRECTNESS gate, not a quality one — the WebGL2 fallback
    // cannot run the pass at all — so it stays ahead of the tier and is not something a
    // player pinning a rung can defeat.
    const quality = activeQualityPolicy().live.postFx;
    const weatherConfig = resolveWeatherUrlOverride(eng['currentWeatherConfig']);
    const ssrOn = getActiveBackend(renderer) === 'webgpu'
        && quality.ssr
        && weatherWantsSsr(weatherConfig);

    // The tier's allowances never turn an effect ON — every one of these still needs its
    // per-game config to ask for it. Only the rescue rung clears them, so for every device
    // that reaches this code today these three read exactly as they did.
    const aoOn = aoConfig?.enabled === true && quality.ao;
    // Depth-of-field is a focal-length effect with no orthographic analogue;
    // disable it whenever the active render camera is orthographic (e.g. the
    // top-down "fit whole world" mode).
    const dofOn = dofConfig?.enabled === true && quality.dof && camera instanceof THREE.PerspectiveCamera;
    const bloomOn = bloomConfig?.enabled === true && quality.bloom;
    const outlineOn = eng['outlineEnabled'];
    // Scene-wide ink outline — read straight from the cached render config (no
    // dedicated GameEngine field/setter needed; the load sequence rebuilds the
    // pipeline via applyAoConfig/applyDofConfig after renderConfig is stored).
    const inkCfg = eng['currentRenderConfig']?.inkOutline;
    const inkOutlineOn = inkCfg?.enabled === true;
    const posterizeCfg = eng['currentRenderConfig']?.posterize;
    const posterizeOn = posterizeCfg?.enabled === true;
    const colorGradeOn = colorGradeWanted(eng['currentRenderConfig']);
    builtWithColorGrade = colorGradeOn;

    // On WebGPU the view model IS a post-chain node, so it can require the
    // pipeline all by itself. On classic WebGL it is a canvas overlay drawn
    // after the composer, so it must NOT force a composer into existence: even
    // with MSAA targets (createMsaaComposer) a composer is two extra full-screen
    // HDR buffers a game with no post effects has no reason to pay for.
    const viewModel = eng['viewModelLayer'];
    const viewModelOn = isWebGpu && viewModelPassRequired(eng);

    const needsPostFx = bloomOn || aoOn || dofOn || outlineOn || ssrOn || inkOutlineOn || posterizeOn || colorGradeOn;
    const needsBloomPipeline = isWebGpu && (needsPostFx || viewModelOn);
    const needsComposer = !isWebGpu && needsPostFx;

    // Tear down any stale post-FX pipelines before reconstructing.
    if (eng['bloomPipeline']) {
        eng['bloomPipeline'].dispose();
        eng['bloomPipeline'] = null;
        eng['bloomNode'] = null;
    }
    if (!needsComposer && eng['composer']) {
        eng['composer'].dispose();
        eng['composer'] = null;
    }
    // The composer clears its pass list without disposing; drop the ink pass's
    // render targets before it's rebuilt (or abandoned on a WebGPU swap).
    if (webglInkOutlinePass) {
        webglInkOutlinePass.dispose();
        webglInkOutlinePass = null;
    }

    if (needsBloomPipeline) {
        // WebGPU path: compose AO / bloom / DOF / outline as TSL nodes feeding
        // a RenderPipeline.  MRT is set up unconditionally (output +
        // normal) so AO can opt in without a separate pass.
        const scenePass = pass(scene, camera);
        // The metalrough channel exists only while SSR is on. It reads the
        // STANDARD per-pixel metalness/roughness — the wet road raises its
        // metalness in puddles, which is both its look and its SSR mask, so no
        // material-level MRT is involved (a material mrtNode would also hijack
        // the color-attachment-less shadow pass into an empty output struct).
        // These extra attachments keep the MRT default (no blending): every
        // fragment writes them outright.
        //
        // Tempting but WRONG: marking them `MaterialBlending` so transparent
        // weather VFX would only perturb them in proportion to their opacity.
        // They carry DATA, not colour, so their alpha channel is not the
        // material's opacity — under alpha blending the OPAQUE scene's own
        // writes get scaled away too, the road never registers as reflective
        // and reflections all but vanish. (Tried on r185, reverted.) Keeping
        // transparent VFX off large areas of screen is the workable lever;
        // see VehicleWetFX's `vaporEnabled`.
        scenePass.setMRT(mrt({
            output,
            normal: normalView,
            ...(ssrOn ? { metalrough: vec2(metalness, roughness) } : {}),
        }));

        // result is intentionally typed permissively: TSL composition mixes
        // TextureNode, OperatorNode, BloomNode, DepthOfFieldNode, etc. The
        // common surface (mul/add) lives on Node, but the return types from
        // dof()/bloom() don't unify cleanly with TextureNode.
        const sceneColor = scenePass.getTextureNode('output');
        let result: ReturnType<typeof sceneColor.mul> = sceneColor as unknown as ReturnType<typeof sceneColor.mul>;

        if (aoOn) {
            const sceneNormal = scenePass.getTextureNode('normal');
            const sceneDepth = scenePass.getTextureNode('depth');
            const aoPass = ao(sceneDepth, sceneNormal, camera);
            aoPass.radius.value = aoConfig!.radius ?? 0.5;
            aoPass.scale.value = aoConfig!.scale ?? 1.0;
            // Modulate scene color by AO factor; intensity blends AO toward 1.
            // The GTAO node renders occlusion into the RED channel of its
            // target only — on the WebGL2 backend sampling G/B returns 0, so
            // multiplying by the raw vec4 texture crushes green/blue to
            // (1 - intensity) and tints the whole frame red. Splat the single
            // channel across rgb and leave alpha untouched.
            const intensity = aoConfig!.intensity ?? 1.0;
            const occlusion = aoPass.getTextureNode().r;
            const aoFactor = occlusion.mul(intensity).add(1.0 - intensity);
            result = result.mul(vec4(vec3(aoFactor), 1.0));
        }

        if (ssrOn) {
            const sceneDepth = scenePass.getTextureNode('depth');
            const sceneNormal = scenePass.getTextureNode('normal');
            const metalRough = scenePass.getTextureNode('metalrough');
            // SSR mask = participation flag × smoothness. The flag is "has any
            // metalness at all" (wet puddles carry a small metalness for
            // exactly this; Lambert grass/sky write 0). Strength then follows
            // smoothness — NOT raw metalness, because per-material env damping
            // doesn't exist in the node pipeline, so puddles must stay
            // near-zero metalness to avoid becoming full-strength env mirrors.
            // Roughness alone can't be the flag: non-PBR materials leave that
            // channel at 0, which reads as "mirror" and SSRs the whole scene.
            // The ramp must CONTAIN the wet film's whole roughness range,
            // never clip it: the film's roughness carries a world-space noise
            // variation, so a ramp that ends inside that range turns the noise
            // into a binary on/off switch — reflections then appear and vanish
            // at fixed map positions (measured: mask 0.000 at 20 of 24 road
            // samples). Film ≈ 0.5 ± 0.09 sits mid-ramp here, so the noise
            // modulates reflection STRENGTH; puddles (~0.15) still reflect
            // near-sharp at the top of the ramp.
            // The metalness gate sits FAR below the wet film's own 0.12: rain
            // and mist are transparent geometry in this same pass, so they
            // blend their zero metalness into the channel and drag the road's
            // value down wherever they cover it (thick spray behind a car can
            // remove 80–90%). Gating at 0.02 made reflections vanish the
            // instant tyre spray appeared. Dilution only ever pulls values
            // DOWN toward zero, so a low gate cannot create false positives —
            // surfaces that write a true zero (grass, sky, unlit props) stay
            // excluded.
            const ssrMask = smoothstep(0.002, 0.012, metalRough.r)
                .mul(smoothstep(0.78, 0.12, metalRough.g));
            // Roughness is pinned to 0 ("fully smooth") because SSRNode's own
            // isotropic blur is replaced by the anisotropic smear below. Its
            // docs say a null roughnessNode means exactly that, but the null
            // path throws (`float(null)` reads `.isNode`), so say it with a
            // node: the blur LOD is r²·mips, so r=0 samples mip 0 and the
            // result stays the sharp buffer this wants. Costs one idle blur
            // pass — the price of not crashing.
            //
            // SSRNode types `normalNode` as Node<vec3>, but it calls `.sample()`
            // on that input for the reflected-ray lookup — it needs the MRT
            // normal TEXTURE, not a vec3. Handing it `sceneNormal.xyz` to
            // satisfy the annotation type-checks and then dies inside the node.
            // Dials go in the OPTIONS OBJECT, not positional args: three r185
            // exports `ssr(colorNode, depthNode, normalNode, options)` and
            // destructures `{ metalnessNode, roughnessNode, camera, ... }` out
            // of it (see three/examples/jsm/tsl/display/SSRNode.js). The
            // six-positional form belongs to a pre-r185 three and fails to
            // type-check here with TS2554.
            const ssrPass = ssr(sceneColor, sceneDepth, sceneNormal as unknown as Node<'vec3'>, {
                metalnessNode: ssrMask,
                roughnessNode: float(0),
                camera,
            });
            // Meter-scale tuning: how far along the view ray a reflection may
            // travel, and how thick a depth sample counts as a hit (kerb-height
            // tolerance keeps rays from slipping through thin track geometry).
            // Look dials the GAME authors (weatherConfig) — read here because
            // the pipeline is rebuilt whenever the weather config changes.
            const look = resolveReflectionLook(weatherConfig);
            ssrPass.maxDistance.value = look.distance;
            ssrPass.thickness.value = 0.3;
            // Full resolution: at half-res the reflection loses most of its
            // definition to upsampling before the vertical streak blur even
            // runs, which is a large part of why it read as barely-there.
            ssrPass.resolutionScale = 1.0;
            // `screenEdgeFade` (0.2 UV units) is left at its default: it fades
            // hits approaching a screen border, which is the one SSR artifact
            // the smear below cannot hide. Set to 0 for the hard cutoff.

            // Wet asphalt is NOT a mirror — two properties make the look:
            // 1. ANISOTROPY: micro-bumps smear reflections along the vertical,
            //    so a brake light reads as a streak, never a dot. A vertical-
            //    only gaussian (direction vec2(0, n)) provides the smear and
            //    swallows half-res SSR shimmer as a bonus.
            // 2. LUMINANCE SELECTIVITY: reflectance is a few percent, so only
            //    BRIGHT sources rise above the asphalt's own shading — lights
            //    and highlights streak clearly, midtones barely lift, dark
            //    reflections are left to the material's wet darkening.
            const streaked = gaussianBlur(ssrPass.getTextureNode(), vec2(0, look.streak), 6).rgb;
            const lum = streaked.r.mul(0.2126).add(streaked.g.mul(0.7152)).add(streaked.b.mul(0.0722));
            // The BASE term is what decides whether a wet road reads as wet.
            // It multiplies everything that is not a blazing highlight — car
            // bodies, kerbs, scenery — so a small value (0.12 here once) makes
            // the reflection technically present and visually absent. Keep it
            // high enough to see, with the highlight term stacking on top so
            // lights and bright paint still streak hardest.
            const highlight = smoothstep(0.15, 0.9, lum);
            const shaped = streaked.mul(highlight.mul(look.highlight).add(look.strength));
            // Additive over the beauty pass (AFTER the AO multiply: reflections
            // are specular energy and must not inherit AO darkening).
            result = result.add(shaped);

            // `?ssrdebug=1` shows the RAW screen-space-reflection buffer alone
            // (amplified) instead of the beauty image. The only reliable way to
            // see WHERE and WHEN SSR actually produces something — judging it
            // through the composited frame has repeatedly misled diagnosis.
            if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ssrdebug')) {
                result = ssrPass.rgb.mul(6) as unknown as typeof result;
            }
        }

        if (bloomOn) {
            const bloomNode = bloom(
                result,
                bloomConfig!.strength,
                bloomConfig!.radius,
                bloomConfig!.threshold,
            );
            eng['bloomNode'] = bloomNode;
            result = result.add(bloomNode);
        }

        if (dofOn) {
            const viewZ = scenePass.getViewZNode();
            const focusU = uniform(dofConfig!.focus ?? 15);
            // BokehPass aperture is the inverse of focal length scale; TSL dof
            // takes focalLength + bokehScale separately. Map roughly.
            const focalU = uniform((dofConfig!.aperture ?? 0.0003) * 100000);
            const bokehU = uniform((dofConfig!.maxblur ?? 0.005) * 200);
            result = dof(result, viewZ, focusU, focalU, bokehU) as unknown as typeof result;
        }

        if (outlineOn) {
            const outlineNode = outline(scene, camera, {
                selectedObjects: eng['outlineSelectedObjects'],
                edgeThickness: uniform(2.5),
                edgeGlow: uniform(1.0),
            });
            const visibleColor = uniform(new THREE.Color(0x00ffff));
            const hiddenColor = uniform(new THREE.Color(0x00ffff));
            const edges = outlineNode.visibleEdge.mul(visibleColor)
                .add(outlineNode.hiddenEdge.mul(hiddenColor)).mul(10.0);
            result = result.add(edges);
        }

        // Posterize the BEAUTY (after bloom/DOF) into flat tonal bands.
        if (posterizeOn) {
            result = applyPosterize(
                result as unknown as Parameters<typeof applyPosterize>[0],
                buildPosterizeParams(posterizeCfg!),
            ) as unknown as typeof result;
        }

        // Ink the outline LAST — over the posterized/bloomed image, like inking
        // over flat colours. Applied after posterize on purpose: a black line run
        // through the posterizer would snap to its darkest band centre (a mid
        // grey, since band centres never reach 0) and read grey, not black —
        // worst where lines cross already-dark ground (shadow/AO near the player).
        if (inkOutlineOn) {
            const sceneDepth = scenePass.getTextureNode('depth');
            const sceneNormal = scenePass.getTextureNode('normal');
            // near/far drive depth linearization (perspective assumed — the ortho
            // "fit whole world" mode falls back to normal edges, still fine).
            result = applyInkOutline(
                result as unknown as Parameters<typeof applyInkOutline>[0],
                sceneDepth as unknown as Parameters<typeof applyInkOutline>[1],
                sceneNormal as unknown as Parameters<typeof applyInkOutline>[2],
                buildInkParams(inkCfg!, camera as THREE.PerspectiveCamera),
            ) as unknown as typeof result;
        }

        // The first-person view model composites LAST — after AO, SSR, bloom,
        // DOF and outline, but before renderOutput's tone mapping. So the weapon
        // is graded exactly like the world while no screen-space effect can
        // touch it: no depth-of-field blur driven by the world depth behind it,
        // no ambient occlusion darkening it with world normals.
        //
        // This is also what gives it its own depth space. A PassNode renders
        // into its own RenderTarget with its own DepthTexture, so "the weapon
        // cannot clip into a wall" is structural here rather than a trick.
        //
        // WHY THIS IS NOT A SECOND renderer.render() TO THE CANVAS: on the
        // unified renderer, render() is routed through an intermediate HDR
        // target whenever tone mapping is enabled — which it always is (see
        // GameEngine.applyRenderConfig; there is no 'none' tone mapping). The
        // pipeline path never populates that target, so drawing into it would
        // load black, and clearDepth() alone blits the whole thing over the
        // canvas. The result is a black screen with a floating weapon.
        if (viewModelOn && viewModel) {
            const vmPass = pass(viewModel.scene, viewModel.camera);
            // Explicit coverage mask: the pass clears to an opaque colour, so
            // `output`'s own alpha says nothing about what was drawn. Extra MRT
            // attachments clear to zero and are written unblended — the same
            // property the SSR metalrough channel above relies on — so this
            // reads 1 exactly where the view model rasterised.
            vmPass.setMRT(mrt({ output, viewModelCoverage: vec4(1) }));
            const vmColor = vmPass.getTextureNode('output');
            const vmCoverage = vmPass.getTextureNode('viewModelCoverage');
            result = vmCoverage.r.mix(result, vmColor) as unknown as typeof result;
        }

        const pipeline = new RenderPipeline(renderer as unknown as ConstructorParameters<typeof RenderPipeline>[0]);
        if (colorGradeOn) {
            // Grade the DISPLAYED image: tone map + sRGB-encode here (renderOutput
            // reads the renderer's settings through the pipeline context) instead
            // of letting the pipeline do it after our last node. Last in the
            // chain, so the view model is graded and vignetted like the world.
            pipeline.outputColorTransform = false;
            result = applyColorGrade(
                renderOutput(result) as unknown as Parameters<typeof applyColorGrade>[0],
                eng['colorGrade'],
            ) as unknown as typeof result;
        }
        pipeline.outputNode = result;
        eng['bloomPipeline'] = pipeline;
        return;
    }

    if (!needsComposer) return;

    if (!eng['composer']) {
        eng['composer'] = createMsaaComposer(renderer);
    } else {
        // Reset the pass list — we'll re-add everything in canonical order.
        eng['composer'].passes.length = 0;
    }

    eng['composer'].addPass(new RenderPass(scene, camera));

    if (aoConfig?.enabled === true) {
        if (!eng['gtaoPass']) {
            eng['gtaoPass'] = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
        }
        eng['gtaoPass'].blendIntensity = aoConfig.intensity ?? 1.0;
        eng['gtaoPass'].updateGtaoMaterial({
            radius: aoConfig.radius ?? 0.5,
            scale: aoConfig.scale ?? 1.0,
        });
        eng['composer'].addPass(eng['gtaoPass']);
    }

    if (bloomConfig?.enabled === true) {
        if (!eng['bloomPass']) {
            eng['bloomPass'] = new UnrealBloomPass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                bloomConfig.strength,
                bloomConfig.radius,
                bloomConfig.threshold,
            );
        } else {
            eng['bloomPass'].strength = bloomConfig.strength;
            eng['bloomPass'].radius = bloomConfig.radius;
            eng['bloomPass'].threshold = bloomConfig.threshold;
        }
        eng['composer'].addPass(eng['bloomPass']);
    }

    if (dofOn) {
        // dofOn implies currentDofConfig.enabled === true, so it's non-null here.
        const cfg = dofConfig!;
        if (!eng['bokehPass']) {
            eng['bokehPass'] = new BokehPass(scene, camera, {
                focus: cfg.focus ?? 15,
                aperture: cfg.aperture ?? 0.0003,
                maxblur: cfg.maxblur ?? 0.005,
            });
        } else {
            const uniforms = eng['bokehPass'].uniforms as Record<string, { value: number } | undefined>;
            if (uniforms.focus) uniforms.focus.value = cfg.focus ?? 15;
            if (uniforms.aperture) uniforms.aperture.value = cfg.aperture ?? 0.0003;
            if (uniforms.maxblur) uniforms.maxblur.value = cfg.maxblur ?? 0.005;
        }
        eng['composer'].addPass(eng['bokehPass']);
    }

    if (eng['outlinePass']) {
        eng['composer'].addPass(eng['outlinePass']);
    }

    // Comic look (WebGL twins of the TSL nodes), mirroring the WebGPU order:
    // posterize the beauty, then ink the outline LAST so black lines never get
    // re-quantized to grey (see the WebGPU pipeline's same ordering).
    if (posterizeOn) {
        const posterizePass = new ShaderPass(POSTERIZE_SHADER);
        // ShaderPass CLONES the shader's uniform bag, so the look is set on the
        // pass's own copy. Typed from the shader itself rather than as an indexed
        // record, so the fields aren't possibly-undefined under
        // `noUncheckedIndexedAccess` (same trick as `InkUniforms` in the ink pass).
        const pu = posterizePass.uniforms as unknown as typeof POSTERIZE_SHADER.uniforms;
        const pp = buildPosterizeParams(posterizeCfg!);
        pu.levels.value = pp.levels;
        pu.strength.value = pp.strength;
        eng['composer'].addPass(posterizePass);
    }
    if (inkOutlineOn && camera instanceof THREE.PerspectiveCamera) {
        webglInkOutlinePass = new InkOutlinePassWebGL(scene, camera, buildInkParams(inkCfg!, camera));
        webglInkOutlinePass.setSize(window.innerWidth, window.innerHeight);
        eng['composer'].addPass(webglInkOutlinePass);
    }

    eng['composer'].addPass(new OutputPass());

    // Display-referred grade + vignette AFTER OutputPass (matching WebGPU). Built
    // from a ShaderMaterial so ShaderPass shares — not clones — the engine's
    // live uniform bag, which is what lets the runtime setters skip a rebuild.
    if (colorGradeOn) {
        eng['composer'].addPass(new ShaderPass(new THREE.ShaderMaterial({
            uniforms: eng['colorGrade'].glUniforms,
            vertexShader: COLOR_GRADE_VERTEX,
            fragmentShader: COLOR_GRADE_FRAGMENT,
        })));
    }
}
