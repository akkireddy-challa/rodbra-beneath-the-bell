import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { setGeometryReleaseSuspended } from 'engine/GeometryCpuRelease.js';
import { resolveWarmupMode, warmupPolicyFor } from 'engine/WarmupPolicy.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { rendererBackendReady } from 'engine/RendererType.js';
import { getLoadProgress } from 'engine/progress/LoadProgress.js';
import { t } from 'engine/i18n/index.js';
import { getNpcSkeletonSource } from 'engine/npc/core/NpcSkeletonSource.js';
import { getAssetUrlById } from 'types/game.js';

/**
 * GameEngineWarmup — level preloading and the GPU warmup.
 *
 * A FRIEND MODULE, the same seam GameEnginePostFx and GameEngineViewModel use:
 * GameEngine.ts sits at the repo's 2000-line ESLint cap, so this belongs to the
 * class conceptually but lives here and reaches private state through
 * TypeScript's sanctioned element-access escape hatch (`eng['sceneWarmedUp']` —
 * typed, not `any`). The warmup STATE stays declared on the class: animate()
 * reads `warmupCompileInFlight` every frame and loadGame() resets `preloadDone`.
 *
 * Import-cycle note: GameEngine.ts imports these functions. The cycle is safe
 * because the GameEngine binding here is type-only — do NOT add a value import
 * of GameEngine, and do not use it outside type position.
 *
 * The first frame a previously-hidden object is drawn, Three.js links its shader
 * program and uploads its geometry/textures to the GPU — a one-frame hitch
 * that's very noticeable on mobile (e.g. the player revealed by the UFO
 * beam-down, which is held at visible=false until the beam fires). These helpers
 * move that cost in front of the Play button. loadGame() calls preloadLevel()
 * once after the genre's load() resolves and before the GAME_LOADED message is
 * posted, so the Play button only appears once everything is hot. A
 * genre/template may instead call these itself (with explicit audio asset IDs)
 * earlier in its own load(); preloadLevel() is idempotent so the loadGame() call
 * then no-ops.
 */

/**
 * Size (px) of the throwaway target the GPU warmup composites INTO, so the warm
 * frame never reaches the canvas — see `runSceneWarmup`. It bounds nothing else:
 * a post chain renders the scene into its own full-size pass buffer whatever is
 * bound here, which is exactly what the warmup needs.
 */
const WARMUP_COMPOSITE_PX = 64;

/**
 * Within-warmup progress sink: `fraction` is 0..1 of the warmup itself.
 * The boot path maps it onto the `warmup` phase of the LoadProgress bar; the
 * level-switch path maps it onto the fade overlay's 0.9→1.0 band. Surfaces
 * that have no bar pass DEFAULT_WARMUP_PROGRESS (required-with-default, per
 * docs/engine-options-pattern.md).
 */
export type WarmupProgressFn = (fraction: number, label?: string) => void;
export const DEFAULT_WARMUP_PROGRESS: WarmupProgressFn = () => {};

/**
 * The band of the warmup the sliced pre-compile reports across. The warm
 * frame owns the rest — it is one uninterruptible render (its serial MRT
 * pipeline builds can't be split without upstream three.js work), so the bar
 * holds at the band's top under the "Finalizing..." label while the
 * compositor-driven `.hud-progress-bar--busy` shimmer keeps visible motion.
 */
const WARMUP_COMPILE_BAND_LO = 0.05;
const WARMUP_COMPILE_BAND_HI = 0.7;

/** How many compile slices to aim for — enough label ticks to read as alive. */
const WARMUP_TARGET_SLICES = 12;

/** Overall warmup fraction for `done` of `total` compile slices. */
function compileBandFraction(done: number, total: number): number {
    return WARMUP_COMPILE_BAND_LO + (WARMUP_COMPILE_BAND_HI - WARMUP_COMPILE_BAND_LO) * (done / total);
}

/**
 * Resolve after the browser has had a chance to PAINT: rAF fires just before
 * the next paint, the nested macrotask lands just after it. Used between
 * compile slices (on WebGL each slice links its programs synchronously, so
 * without this the bar text would never repaint) and before the warm frame
 * (commits the "Finalizing..." label and starts the shimmer animation on the
 * compositor before the main thread blocks). DOM-only — never renders, so it
 * is safe inside the warmupCompileInFlight gate.
 */
function nextPaint(): Promise<void> {
    return new Promise(resolve => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

/** Yield to the event loop for `ms`, for the poll loops below. */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

function isRenderable(node: THREE.Object3D): boolean {
    return (node as THREE.Mesh).isMesh === true
        || (node as THREE.Points).isPoints === true
        || (node as THREE.Line).isLine === true
        || (node as THREE.Sprite).isSprite === true;
}

/**
 * Split the scene into up to ~targetSlices groups of roots with roughly equal
 * renderable counts, for a sliced `compileAsync(root, camera, scene)` loop.
 * Passing the scene as the third argument keeps pipeline cache keys identical
 * to a whole-scene compile (the renderer takes lights/fog/environment from the
 * target scene), so slicing changes only WHEN pipelines are built, not which.
 *
 * One expansion level: a top-level child owning far more than its share (the
 * common "one world root holds everything" shape) is replaced by its own
 * children — but only when the node itself draws nothing, so no material is
 * lost by descending past it. Deliberately dumb beyond that; slice balance
 * only affects label granularity, not correctness.
 */
function collectCompileSliceRoots(scene: THREE.Scene, targetSlices = WARMUP_TARGET_SLICES): THREE.Object3D[][] {
    const weigh = (root: THREE.Object3D): number => {
        let n = 0;
        root.traverse(node => { if (isRenderable(node)) n++; });
        return n;
    };
    const top = scene.children.map(child => ({ obj: child, weight: weigh(child) }));
    const total = top.reduce((sum, e) => sum + e.weight, 0);
    if (total === 0) return [];
    const budget = total / targetSlices;
    const entries: Array<{ obj: THREE.Object3D; weight: number }> = [];
    for (const e of top) {
        if (e.weight === 0) continue;
        if (e.weight > budget * 2 && !isRenderable(e.obj) && e.obj.children.length > 1) {
            for (const child of e.obj.children) {
                const w = weigh(child);
                if (w > 0) entries.push({ obj: child, weight: w });
            }
        } else {
            entries.push(e);
        }
    }
    // Greedy sequential packing (keeps scene order, so slices compile in a
    // stable, roughly locality-preserving order).
    const slices: THREE.Object3D[][] = [];
    let bucket: THREE.Object3D[] = [];
    let bucketWeight = 0;
    for (const e of entries) {
        bucket.push(e.obj);
        bucketWeight += e.weight;
        if (bucketWeight >= budget) {
            slices.push(bucket);
            bucket = [];
            bucketWeight = 0;
        }
    }
    if (bucket.length > 0) slices.push(bucket);
    return slices;
}

/**
 * Run `cb` once the scene-wide GPU warmup render (preloadLevel → warmUpScene)
 * has completed — i.e. once every scene object's geometry/textures have been
 * uploaded to the GPU. Runs immediately if the warmup already happened. Used by
 * systems that release CPU-side buffer copies after upload (e.g.
 * VxlSceneRenderer.releaseCpuGeometry). Never fires if the warmup render
 * failed, so buffers are only released once they demonstrably reached the GPU.
 */
export function addSceneWarmedUpCallback(eng: GameEngine, cb: () => void): void {
    if (eng['sceneWarmedUp']) {
        cb();
        return;
    }
    eng['sceneWarmedUpCallbacks'].push(cb);
}

/**
 * Default level preload: warm the shared NPC skeleton, decode declared
 * audio, and GPU-warm the player character + current scene. Idempotent —
 * safe to call from loadGame() and from a genre's load(). Never throws;
 * a preload failure must not block the Play button.
 */
export async function runLevelPreload(eng: GameEngine, opts?: { audioAssetIds?: string[] }): Promise<void> {
    if (eng['preloadDone']) return;
    eng.quality.resetSampling();
    eng['preloadDone'] = true;
    try {
        getLoadProgress().beginPhase('assets', t('game.loading.assets'));
        await runNpcSkeletonPreload(eng);
        if (opts?.audioAssetIds?.length) {
            await runAudioPreload(eng, opts.audioAssetIds);
        }
        await preloadAudioFromWorld(eng);
        // GPU warmup last — the scene is fully populated by now. The scene
        // itself is warmed wholesale (runSceneWarmup un-culls it); what has to
        // be passed IN is anything currently hidden — the player or a custom
        // character rig held at visible=false for an intro (e.g. the UFO
        // beam-down). Both renderers skip invisible subtrees, so without
        // this the whole character's shaders + textures compile on the
        // single reveal frame (the 1–2s mobile hitch).
        // collectHiddenSceneRoots() finds them; runSceneWarmup() temporarily
        // reveals them for the pass and restores afterwards.
        getLoadProgress().beginPhase('warmup', t('game.loading.warmup'));
        // setPhaseFraction is monotonic, so the warmup's within-phase reports
        // can only move the bar forward from the 90% the phase starts at.
        await runSceneWarmup(eng, collectHiddenSceneRoots(eng),
            (fraction, label) => getLoadProgress().setPhaseFraction(fraction, label));
    } catch (err) {
        console.warn('[GameEngine] preloadLevel failed (continuing to Play):', err);
    } finally {
        // The warmup outcome does NOT gate this, in any of its three forms —
        // switched off by policy, run-and-failed, or thrown out of entirely.
        //
        // Off-by-policy was already handled, because letting a diagnostic mode cost
        // MORE memory than the behaviour it exists to diagnose makes the bisect read
        // the wrong answer. Failure was not, and it is the worse case: mobile's
        // default (`light`) DRAWS a frame, so the old `!warmupDrawsAFrame()` escape
        // never covered it, and a warm frame that threw left every terrain batch
        // holding its full CPU-side copy for the life of the level — on the platform
        // with the least memory to spare, in exactly the circumstances (a phone
        // struggling with the warm frame) that provoke the throw.
        //
        // Arming regardless is safe, and for the same reason in every form:
        // `releaseCpuGeometry` only ARMS a per-batch after-DRAW release, so nothing is
        // freed until that batch has demonstrably reached the GPU on a real frame.
        // That per-batch guard is what protects correctness; the warmup outcome never
        // did — it only decided whether the release was ever attempted.
        eng['sceneWarmedUp'] = true;
        const callbacks = eng['sceneWarmedUpCallbacks'];
        eng['sceneWarmedUpCallbacks'] = [];
        for (const cb of callbacks) {
            try { cb(); } catch (err) { console.warn('[GameEngine] onSceneWarmedUp callback failed:', err); }
        }
    }
}

/**
 * GPU-warm whatever is in the scene RIGHT NOW, hidden subtrees included.
 * The level-switch path (LevelManager.loadLevel) calls this while the
 * transition fade is still up.
 *
 * preloadLevel() only ever runs once per loadGame(), so without this every
 * level built by loadLevel() would be cold: its materials link their shader
 * programs on the first gameplay frame that draws them, which reads as a
 * stall every few seconds through the opening lap as new object types enter
 * the frustum. It is invisible in testing because the browser's on-disk
 * program cache makes every RELOAD fast — only a player's first-ever visit
 * pays it. Worst for a game that boots an empty world and loads its real
 * level later: the boot warmup then compiles nothing but the skybox.
 *
 * Deliberately does NOT set `sceneWarmedUp` or flush onSceneWarmedUp
 * callbacks — those arm one-shot CPU-side buffer release, which is keyed to
 * the boot warmup and must not re-run per level switch.
 */
export async function runLoadedSceneWarmup(eng: GameEngine, onProgress: WarmupProgressFn): Promise<void> {
    eng.quality.resetSampling();
    try {
        await runSceneWarmup(eng, collectHiddenSceneRoots(eng), onProgress);
    } catch (err) {
        console.warn('[GameEngine] level warmup failed (continuing):', err);
    }
    // Uncapped render timing is useful diagnostics, but loading must never lower quality.
    // Only the monitor's warmed-up gameplay windows may spend the adaptation budget.
    const renderer = eng['renderer'];
    if (renderer) await eng.quality.runProbe(renderer);
}

/**
 * GPU-warm the (normally hidden) player character so its shader program is
 * linked and its textures/geometry are uploaded before the beam-down reveal.
 * No-op when there's no player object.
 */
export async function runPlayerCharacterPreload(eng: GameEngine): Promise<void> {
    await runSceneWarmup(eng, collectPlayerWarmupObjects(eng), DEFAULT_WARMUP_PROGRESS);
}

/**
 * Warm the shared humanoid skeleton GLB that every NPC clones, so the first
 * spawnNpc() doesn't stall on its fetch+parse. No-op when no NPCs are
 * registered; instant for genres whose player already supplies the rig
 * (getSkeletonGLTF() returns the player GLTF immediately). Works with no
 * PlayerLoader at all — the NpcSkeletonSource owns the shared rig.
 */
export async function runNpcSkeletonPreload(eng: GameEngine): Promise<void> {
    // Gate on REGISTERED TYPES, not on the registry existing. `npcRegistry` is
    // constructed unconditionally, so the old `!npcRegistry` check never fired and
    // every game — a car racer with no humanoids included — downloaded the shared rig
    // and waited up to 4s for it. Measured on a racing game: 412ms of a 1.72s pre-menu
    // load, for a character it never spawns.
    //
    // A game that registers NPCs LATER than this still works: `NpcSkeletonSource`
    // loads lazily on first use, so skipping the preload costs that game the fetch at
    // spawn time rather than losing it. Preloading for every game to cover that case
    // charged the cost to everyone instead.
    const registry = eng['npcRegistry'];
    if (!registry || registry.getManagerCount() === 0) return;
    const source = getNpcSkeletonSource(eng);
    source.ensureLoaded();
    const deadline = performance.now() + 4000;
    while (!source.getSkeletonGLTF() && performance.now() < deadline) {
        await delay(50);
    }
}

/**
 * Decode audio buffers up front so the first playSound()/playMusic() doesn't
 * stall on fetch + decodeAudioData(). Accepts world.json asset IDs (resolved
 * via getAssetUrlById) or raw URLs.
 */
export async function runAudioPreload(eng: GameEngine, idsOrUrls: string[]): Promise<void> {
    const player = eng['audioPlayer'];
    if (!player || idsOrUrls.length === 0) return;
    const urls = new Set(
        idsOrUrls.map(s => getAssetUrlById(eng['currentGameData'], s) ?? s),
    );
    await Promise.all([...urls].map(u => player.preload(u)));
}

/**
 * GPU warmup: build every shader program / render pipeline the level needs
 * and upload its geometry + textures, so nothing compiles on a gameplay
 * frame. Restores all mutated flags afterwards. Resolves true only when the
 * warmup render actually ran — post-warmup work (CPU-buffer release via
 * onSceneWarmedUp) keys off it.
 *
 * TWO THINGS MAKE THIS WORK ON WEBGPU, and both were wrong before. WebGPU
 * is the default renderer, so getting either wrong means the warmup builds
 * pipelines the game never uses and the level compiles as it is played: a
 * hitch every second or so for as long as new object types keep entering
 * the frustum. It is invisible in testing because the browser's on-disk
 * pipeline cache makes every RELOAD fast — only a player's first-ever visit
 * pays it, which is exactly how it was reported.
 *
 * 1. FRUSTUM CULLING IS OFF FOR THE WHOLE SCENE. WebGL's `compile()` walks
 *    the scene and compiles every material it finds, but the WebGPU
 *    `compileAsync()` builds a render LIST first, and `_projectObject()`
 *    frustum-culls while it does. Warming from the spawn point therefore
 *    covered only what the start line happens to see. Everything the
 *    circuit hides behind a corner stayed cold.
 * 2. THE WARM FRAME GOES THROUGH THE REAL RENDER PATH (renderActiveFrame),
 *    not a bare `renderer.render()` — see that method for why the render
 *    target's format is part of the pipeline cache key.
 *
 * The frame renders at the LIVE size. Shrinking the renderer for it looked
 * free — a pipeline is never keyed by size — but resizing mid-warmup made
 * BloomNode resize its mip chain out from under its own updateBefore hook
 * ("Cannot read properties of undefined (reading 'invSize')"), and cost
 * rather than saved time on the frames that followed. One un-culled frame
 * under the fade is the cheaper trade.
 */
export async function runSceneWarmup(eng: GameEngine, reveal: THREE.Object3D[], onProgress: WarmupProgressFn): Promise<boolean> {
    // Serialize concurrent warmups. The level-switch warmup and the
    // post-rebuild warmup (EnvironmentObjectSystem.reloadForLevel) CAN
    // overlap: onLevelDidLoad fires the race re-setup async, and its env
    // rebuild interleaves with loadLevel's own tail. Two warmups in
    // flight would race the warmupCompileInFlight release — the first
    // finally{} drops the render hold while the second is still
    // mid-compileAsync, handing animate() a pending pipeline (the
    // permanent-black-canvas trap the flag exists to prevent).
    const run = eng['warmupChain'].then(async () => {
        eng.quality.resetSampling();
        try {
            return await warmUpSceneNow(eng, reveal, onProgress);
        } finally {
            eng.quality.resetSampling();
        }
    });
    eng['warmupChain'] = run.then(() => undefined, () => undefined);
    return run;
}

async function warmUpSceneNow(eng: GameEngine, reveal: THREE.Object3D[], onProgress: WarmupProgressFn): Promise<boolean> {
    const renderer = eng['renderer'];
    const scene = eng['scene'];
    const camera = eng['camera'];
    if (!renderer || !scene || !camera) return false;
    if (!(await waitForRendererReady(eng))) return false;

    // How much of the warmup this device runs. The whole routine is ONE
    // uninterruptible burst of main-thread and GPU work, and the steps that make it
    // thorough are what make it big — an un-culled pass draws the entire level, not
    // a viewport of it. A desktop absorbs that behind the fade; a phone can be
    // terminated for it. See WarmupPolicy.ts for the ladder and the `?warmup=`
    // override that lets a published build be bisected on the device.
    const mode = resolveWarmupMode(activeQualityPolicy().deferred.warmup);
    const policy = warmupPolicyFor(mode);
    if (!policy.frame) {
        console.log(`[GameEngine] GPU warmup: skipped (mode=${mode})`);
        return false;
    }
    // First tick the moment the warmup really starts — the bar moving at all
    // is what separates "working" from "frozen" for the 5-30s this can take.
    onProgress(0.02);

    const savedVisible: Array<{ obj: THREE.Object3D; visible: boolean }> = [];
    // Only nodes that WERE culled are recorded, so restoring is always `= true`.
    const savedCulled: THREE.Object3D[] = [];
    const uncull = (root: THREE.Object3D): void => {
        root.traverse(node => {
            if (!node.frustumCulled) return;
            savedCulled.push(node);
            node.frustumCulled = false;
        });
    };
    // Force the whole subtree visible: the root unconditionally (it is the one
    // the caller wants warmed), descendants only where they were hidden.
    const forceVisible = (root: THREE.Object3D): void => {
        root.traverse(node => {
            if (node !== root && node.visible) return;
            savedVisible.push({ obj: node, visible: node.visible });
            node.visible = true;
        });
    };
    for (const root of reveal) forceVisible(root);
    // The scene-wide un-cull is the single most expensive switch here: it is the
    // difference between warming one viewport and drawing every object, LOD and
    // shadow caster in the level in one frame.
    if (policy.uncullScene) uncull(scene);
    // Reveal roots are normally IN the scene (already handled above), but a
    // rig held outside it until its intro plays is not — walk them too. The
    // `frustumCulled` guard in uncull() keeps the shared nodes single-entry.
    // These stay un-culled in EVERY rendering mode: they are a handful of nodes
    // (the player rig held hidden for an intro), and warming them is the original
    // reason the warmup exists — cheap, and the reveal is pointless without it.
    for (const root of reveal) uncull(root);

    // EMPTY instanced buckets are invisible to everything below: a count-0
    // InstancedMesh never enters the render list, so neither compileAsync
    // nor the warm frame builds its pipeline. Env objects build one such
    // bucket per non-start LOD level plus a count-0 shadow-only mesh
    // (fragment pools likewise), and per-frame culling packs instances into
    // them as the player MOVES — so their pipelines compile one by one on
    // gameplay frames instead. On a first-ever visit (no on-disk pipeline
    // cache) that is hundreds of synchronous driver compiles spread over
    // the first minute of play; a reload hides it completely, which is why
    // it never showed in testing. Draw ONE instance of every empty bucket
    // during the warmup — matrix zero, so it rasterizes no fragments.
    const emptyInstanced: THREE.InstancedMesh[] = [];
    const collectEmptyInstanced = (root: THREE.Object3D): void => {
        root.traverse(node => {
            if (node instanceof THREE.InstancedMesh && node.count === 0 && node.instanceMatrix.count > 0) {
                emptyInstanced.push(node);
            }
        });
    };
    if (policy.revealEmptyInstanced) {
        collectEmptyInstanced(scene);
        for (const root of reveal) collectEmptyInstanced(root);
    }
    /**
     * (Re-)apply both scene mutations the warm pass depends on. Game updates
     * keep running between the compile awaits below (only the renderer is
     * gated): instance culling re-zeroes the empty buckets every frame, and an
     * intro script can re-hide a reveal root. Both halves are idempotent — the
     * count===0 guard absorbs duplicate collection (scene + reveal roots) and
     * repeat application, and every savedVisible entry was forced visible above.
     */
    const reapplyWarmupOverrides = (): void => {
        for (const mesh of emptyInstanced) { if (mesh.count === 0) mesh.count = 1; }
        for (const s of savedVisible) s.obj.visible = true;
    };
    reapplyWarmupOverrides();

    const prevTarget = renderer.getRenderTarget();
    // The final composite draws here rather than the canvas, so the warm
    // frame never reaches the screen. A post chain renders the SCENE into
    // its own pass-node buffer regardless of what is bound, so the pipelines
    // that matter — every material in the level — are still built against
    // the real target format; only the one output-quad pipeline is built
    // against this stand-in. With no post chain the scene IS the canvas
    // pass, so binding a target here would defeat the point and it renders
    // to the canvas instead (covered by the loading screen / level fade).
    const offscreen = (eng['bloomPipeline'] || eng['composer'])
        ? new THREE.WebGLRenderTarget(WARMUP_COMPOSITE_PX, WARMUP_COMPOSITE_PX)
        : null;
    let rendered = false;
    // This draw must NOT satisfy the "drawn, therefore uploaded" signal that
    // frees CPU-side geometry: it runs before the level's real passes exist,
    // so it uploads less than they consume. Releasing on it freed the
    // terrain's `normal` before any shadow-receiving pass had used it, and
    // `shadow.normalBias` then offset the shadow lookup along a 0-byte
    // buffer — the racing surface shadow-tested against itself and rendered
    // solid black. See GeometryCpuRelease's `releaseSuspended`.
    setGeometryReleaseSuspended(true);
    // Hold the animate() loop off the renderer for the whole warmup —
    // compileAsync's pending pipelines must never meet a live render (see
    // warmupCompileInFlight). The warm frame below is then the only render
    // running.
    eng['warmupCompileInFlight'] = true;
    const startedAt = performance.now();
    // KNOWN LIMIT — compileAsync compiles against the renderer's CURRENT
    // target + renderer-level MRT. With a post chain that is the
    // single-target HDR framebuffer, so its parallel compiles are
    // throwaway variants; the MRT pipelines the game really draws with
    // (the scene renders into the pass node's multi-target buffer, and
    // pipelines are keyed by target formats) are built serially by the
    // warm frame below — measured ~2.5-5s cold for a full circuit, under
    // the fade, which is the accepted trade. Pointing compileAsync at the
    // live pass's own render target + MRT node was tried and builds the
    // right variants in parallel, but it shares mutable render-context
    // state with the live pass and its benefit over the warm frame was
    // never isolated (the A/B was confounded) — if reattempted, compile
    // against a THROWAWAY target cloned to the pass's formats/samples,
    // never the live pass's target.
    try {
        // Shader modules are cached by SOURCE, independent of the render
        // target, so this prewarms the expensive WGSL translation for the
        // whole (now un-culled) scene — and does it off the main thread
        // where the backend supports async pipeline creation. Only WebGPU
        // has that thread: with a WebGL backend (every iOS browser — they
        // are all WebKit) the call links every program on the main thread
        // and only the POLLING is async, so it is a blocking burst there.
        //
        // Sliced per subtree instead of one compileAsync(scene, camera):
        // passing the scene as the third argument keeps every pipeline cache
        // key identical to the whole-scene call, and slicing gives the
        // progress bar N real ticks — plus a paint between slices, which is
        // the only way the label ever updates on a WebGL backend. All the
        // awaits stay inside this try, so warmupCompileInFlight (set above,
        // cleared in the finally) gates the render loop across every slice
        // exactly as it gated the single call.
        if (policy.compile) {
            const slices = collectCompileSliceRoots(scene);
            for (const [i, slice] of slices.entries()) {
                // Undo what game updates did during the previous slice's
                // await — synchronously, right before this slice builds its
                // render list.
                reapplyWarmupOverrides();
                for (const root of slice) {
                    await renderer.compileAsync(root, camera, scene);
                }
                onProgress(
                    compileBandFraction(i + 1, slices.length),
                    t('game.loading.shaders', { done: i + 1, total: slices.length }),
                );
                await nextPaint();
            }
        }
        // The warm frame is one uninterruptible burst — commit its label (and
        // let the busy shimmer reach the compositor) before it blocks.
        onProgress(WARMUP_COMPILE_BAND_HI, t('game.loading.finalize'));
        await nextPaint();
        // The awaits above held the render, but animate() kept running game
        // updates — and updateInstanceCulling repacks bucket counts every
        // frame, zeroing the empty-bucket reveal. Re-apply now: from here to
        // the render below is synchronous, so nothing can zero them again
        // before the warm frame draws.
        reapplyWarmupOverrides();
        // Then one real frame: builds the pipelines against the formats the
        // game draws with, and uploads the geometry/textures too.
        renderer.setRenderTarget(offscreen);
        eng['renderActiveFrame']();
        rendered = true;
        onProgress(1);
    } catch (err) {
        console.warn('[GameEngine] warmUpScene failed:', err);
    } finally {
        setGeometryReleaseSuspended(false);
        renderer.setRenderTarget(prevTarget);
        offscreen?.dispose();
        for (const obj of savedCulled) obj.frustumCulled = true;
        for (const s of savedVisible) s.obj.visible = s.visible;
        // Only undo OUR reveal (count still 1). A bucket the culling repack
        // gave a real count to mid-warmup belongs to the game now.
        for (const mesh of emptyInstanced) { if (mesh.count === 1) mesh.count = 0; }
        eng['warmupCompileInFlight'] = false;
    }
    if (rendered) {
        console.log(`[GameEngine] GPU warmup: ${Math.round(performance.now() - startedAt)}ms (mode=${mode})`);
    }
    return rendered;
}

function collectPlayerWarmupObjects(eng: GameEngine): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const playerObj = eng['playerController']?.getPlayerObject?.() ?? null;
    if (playerObj) out.push(playerObj);
    const blockRoot = eng['playerLoader']?.getBlockCharacterRenderer()?.getRoot() ?? null;
    if (blockRoot && blockRoot !== playerObj) out.push(blockRoot);
    return out;
}

/**
 * Top-level hidden nodes in the scene (a node with visible=false whose
 * parent is still visible). These are the subtrees Three.js compile() skips
 * (it walks with traverseVisible), so a game that holds its player or a
 * custom character rig at visible=false for an intro — like the UFO
 * beam-down — would otherwise pay the full shader-compile + upload cost on
 * the reveal frame. runSceneWarmup() reveals these for the warmup pass.
 */
function collectHiddenSceneRoots(eng: GameEngine): THREE.Object3D[] {
    const roots: THREE.Object3D[] = [];
    const scene = eng['scene'];
    if (!scene) return roots;
    scene.traverse(obj => {
        if (!obj.visible && (obj.parent?.visible ?? true)) {
            roots.push(obj);
        }
    });
    return roots;
}

async function preloadAudioFromWorld(eng: GameEngine): Promise<void> {
    const gameData = eng['currentGameData'];
    const assets = gameData?.assets;
    const player = eng['audioPlayer'];
    if (!assets || !player) return;
    const audioExt = /\.(mp3|ogg|wav|opus|m4a|aac|flac)(\?|#|$)/i;
    const urls = new Set<string>();
    for (const a of assets) {
        const url = getAssetUrlById(gameData, a.id);
        if (url && audioExt.test(url)) urls.add(url);
    }
    if (urls.size === 0) return;
    await Promise.all([...urls].map(u => player.preload(u)));
}

async function waitForRendererReady(eng: GameEngine, timeoutMs = 3000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (!rendererBackendReady(eng['renderer'])) {
        if (performance.now() > deadline) return false;
        await delay(30);
    }
    return true;
}
