// Type checking enabled
import * as THREE from 'three';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { getActiveBackend } from 'engine/RendererType.js';
import { ShaderChurnDetector } from 'engine/ShaderChurnDetector.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * One lightweight per-frame sample kept in a rolling ring buffer. `frameMs` is
 * wall-clock time between frames (catches GPU-bound stalls via the rAF gap);
 * `renderMs` is CPU time spent inside `renderer.render()` (catches WebGPU
 * synchronous pipeline compilation, which runs on the CPU during the draw).
 */
interface FrameSample {
    t: number;
    frameMs: number;
    renderMs: number;
    calls: number;
    tris: number;
}

/** Per-object-type contribution captured at a spike frame. */
interface SpikeBreakdownRow {
    fp: string;
    objects: number;
    drawCalls: number;
    triangles: number;
    instances: number;
}

/** Detailed snapshot captured when a frame spikes. */
interface SpikeSnapshot {
    t: number;
    frameMs: number;
    renderMs: number;
    reason: string;
    calls: number;
    tris: number;
    points: number;
    lines: number;
    callsDelta: number;
    trisDelta: number;
    geometries: number;
    textures: number;
    programs: number;
    /** Shader recompiles detected so far this game (see ShaderChurnDetector). */
    recompiles: number;
    lights: number;
    shadowMapEnabled: boolean;
    cameraPos: { x: number; y: number; z: number } | null;
    // Sum over the scene-traversal breakdown (cross-check against `calls`/`tris`).
    estDrawCalls: number;
    estTriangles: number;
    breakdown: SpikeBreakdownRow[];
}

export interface PerfStats {
    timestamp: number;
    fps: number;
    targetFps: number;
    frameTime: number;

    // renderer.info.render
    drawCalls: number;
    triangles: number;
    points: number;
    lines: number;

    // renderer.info.memory
    geometries: number;
    textures: number;

    // Shader programs
    shaderPrograms: number;
    /**
     * Programs deleted and compiled AGAIN during play, cumulative. Anything
     * above zero means an effect creates and disposes a material per spawn
     * and pays a synchronous compile on every respawn — pool it
     * (`engine/effects/EffectPool.ts`).
     */
    shaderRecompiles: number;

    // Scene graph (cached, updated every ~2s)
    sceneObjectCount: number;
    meshCount: number;
    lightCount: number;

    // Object type breakdown (cached, updated every ~2s)
    groupCount: number;
    spriteCount: number;
    lineObjectCount: number;
    pointsObjectCount: number;
    skinnedMeshCount: number;
    instancedMeshCount: number;

    // Unique resource instances (cached, updated every ~2s)
    uniqueGeometries: number;
    uniqueMaterials: number;

    // Physics
    rigidBodyCount: number;
    colliderCount: number;

    // Object fingerprint breakdown (cached, updated every ~2s)
    // Top object types by count, e.g. [["Mesh(BoxGeo,BasicMat)", 320], ...]
    topObjectTypes: [string, number][];
    // Delta since last scan: positive = added, negative = removed
    objectTypeDeltas: [string, number][];

    // Orphaned geometry breakdown — types that left the scene without dispose()
    orphanedGeoTypes: [string, number][];
    orphanedGeoTotal: number;

    // JS memory (Chrome only)
    jsHeapUsedMB: number | null;
    jsHeapTotalMB: number | null;
}

interface PerformanceMemory {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
}

/** Round to 1 decimal place for compact diagnostic output. */
function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Reused scratch vector for camera world-position reads during spike capture. */
const _perfVec = new THREE.Vector3();

/**
 * Collects WebGL, scene, and physics performance stats from the game engine
 * and emits them to the creator via postMessage.
 */
export class PerfStatsCollector {
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private physicsWorld: PhysicsWorld | null;
    private getTargetFps: () => number;

    private emitInterval: ReturnType<typeof setInterval> | null = null;

    // FPS tracking
    private frameCount = 0;
    private lastFpsTime = performance.now();
    private currentFps = 0;

    // Cached scene counts (expensive to compute)
    private cachedSceneObjectCount = 0;
    private cachedMeshCount = 0;
    private cachedLightCount = 0;
    private cachedGroupCount = 0;
    private cachedSpriteCount = 0;
    private cachedLineObjectCount = 0;
    private cachedPointsObjectCount = 0;
    private cachedSkinnedMeshCount = 0;
    private cachedInstancedMeshCount = 0;
    private cachedUniqueGeometries = 0;
    private cachedUniqueMaterials = 0;
    private lastSceneScanTime = 0;
    private static readonly SCENE_SCAN_INTERVAL = 2000;

    // Object fingerprint tracking
    private cachedTopObjectTypes: [string, number][] = [];
    private cachedObjectTypeDeltas: [string, number][] = [];
    private previousTypeCounts: Map<string, number> = new Map();

    // Orphaned geometry tracking: geos that left the scene without dispose()
    // Maps geometry UUID → fingerprint for all geos currently in scene
    private prevSceneGeoMap: Map<string, string> = new Map();
    // Accumulated orphaned counts by fingerprint
    private orphanedGeoCounts: Map<string, number> = new Map();
    private prevAllocatedGeoCount = 0;
    private cachedOrphanedGeoTypes: [string, number][] = [];
    private cachedOrphanedGeoTotal = 0;

    // ── Spike recording (diagnostic) ──────────────────────────────────────
    // Per-frame ring buffer + detailed snapshots of spike frames, dumped to a
    // JSON file via window.__bmDumpPerf() or the F2 key. See recordFrameTiming.
    private frameRing: FrameSample[] = [];
    private static readonly FRAME_RING_MAX = 1800; // ~30s at 60fps
    private spikes: SpikeSnapshot[] = [];
    private static readonly SPIKE_MAX = 80;
    private prevCalls = 0;
    private prevTris = 0;
    private lastSpikeCaptureT = 0;
    /** Min gap between captured spikes (ms) so a sustained low-FPS run doesn't flood. */
    private static readonly SPIKE_CAPTURE_GAP_MS = 150;
    /**
     * A frame counts as a spike when it exceeds 1.4x the target frame time
     * (23.3ms at 60fps) — low enough to catch the "mostly 16.7 but frequently
     * 25-31ms" pattern (typically GC pauses or periodic per-frame work), which
     * the old fixed 40ms threshold silently ignored.
     */
    private spikeFrameMs(): number {
        return Math.max(22, (1000 / this.getTargetFps()) * 1.4);
    }
    private keyListenerAttached = false;

    // ── Shader churn detection ────────────────────────────────────────────
    // A program that is deleted and then compiled again mid-game is a hitch
    // on every respawn of whatever owns it. Fed every frame; warns on the
    // first recompile of each material type and every tenth after that.
    private readonly churn = new ShaderChurnDetector();
    private readonly churnWarnedCount = new Map<string, number>();

    constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, physicsWorld: PhysicsWorld | null, getTargetFps: () => number) {
        this.renderer = renderer;
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.getTargetFps = getTargetFps;
        this.installSpikeRecorderGlobals();
    }

    /**
     * Per-frame draw calls, backend-agnostic. WebGLRenderer reports them in
     * `info.render.calls` (auto-reset every frame). WebGPURenderer's `calls`
     * is a CUMULATIVE render-pass counter since app start — reading it as a
     * per-frame value fabricates an ever-growing "draw call leak" in dumps
     * (+frameCalls per frame, forever). The per-frame number lives in
     * `drawCalls` there, which WebGL's info object doesn't have.
     */
    private getFrameDrawCalls(): number {
        const render = this.renderer.info.render as { calls: number; drawCalls?: number };
        return render.drawCalls ?? render.calls;
    }

    /**
     * Per-frame diagnostic hook. Call from the animate loop AFTER render with the
     * measured wall-clock frame time and the CPU time spent inside renderer.render().
     * Records a rolling per-frame buffer and, when a frame spikes (slow frame or a
     * sudden jump in draw calls), captures a detailed per-object-type breakdown of
     * what is drawing — so the cause of a transient FPS drop can be analyzed offline.
     */
    recordFrameTiming(frameMs: number, renderMs: number, camera: THREE.Camera | null): void {
        const info = this.renderer.info;
        const calls = this.getFrameDrawCalls();
        const tris = info.render.triangles;
        const t = performance.now();

        this.frameRing.push({ t, frameMs: round1(frameMs), renderMs: round1(renderMs), calls, tris });
        if (this.frameRing.length > PerfStatsCollector.FRAME_RING_MAX) this.frameRing.shift();

        this.detectShaderChurn(t);

        const callsDelta = calls - this.prevCalls;
        const trisDelta = tris - this.prevTris;
        const slow = frameMs > this.spikeFrameMs();
        const callJump = this.prevCalls > 0 && calls > this.prevCalls * 1.5 && callsDelta > 400;
        const reason = slow && callJump ? 'slow+callJump' : slow ? 'slowFrame' : callJump ? 'callJump' : '';

        if (reason && (t - this.lastSpikeCaptureT) > PerfStatsCollector.SPIKE_CAPTURE_GAP_MS) {
            this.lastSpikeCaptureT = t;
            this.captureSpike(t, frameMs, renderMs, reason, calls, tris, callsDelta, trisDelta, camera);
        }
        this.prevCalls = calls;
        this.prevTris = tris;
    }

    /**
     * Feed the detector the backend's program bookkeeping for this frame and
     * warn about recompiles. WebGL lists its programs; WebGPU only counts them.
     */
    private detectShaderChurn(t: number): void {
        const info = this.renderer.info;
        let hits: readonly string[];
        if (info.programs) {
            hits = this.churn.observePrograms(info.programs, t);
        } else {
            const memory = info.memory as { programs?: number };
            hits = memory.programs === undefined ? [] : this.churn.observeProgramCount(memory.programs, t);
        }
        for (const name of hits) {
            const n = (this.churnWarnedCount.get(name) ?? 0) + 1;
            this.churnWarnedCount.set(name, n);
            if (n !== 1 && n % 10 !== 0) continue;
            console.warn(
                `[BM PERF] Shader churn: a ${name} program was deleted and compiled again during play ` +
                `(${n}× so far). Something creates and disposes a material or geometry per effect — ` +
                `keep effect meshes alive in an EffectPool (engine/effects/EffectPool.ts; ` +
                `agent-docs/performance-best-practices.md).`,
            );
        }
    }

    /** Build and store a detailed snapshot of the current spike frame. */
    private captureSpike(
        t: number, frameMs: number, renderMs: number, reason: string,
        calls: number, tris: number, callsDelta: number, trisDelta: number,
        camera: THREE.Camera | null,
    ): void {
        const info = this.renderer.info;
        const rows = new Map<string, SpikeBreakdownRow>();
        let estDrawCalls = 0;
        let estTriangles = 0;
        let lights = 0;

        // traverseVisible only walks objects whose visible-chain is true, i.e. the
        // set the renderer would consider. We further gate on camera layer so the
        // breakdown matches what actually rasterizes this frame.
        this.scene.traverseVisible((obj) => {
            if ((obj as THREE.Light).isLight) lights++;
            const mesh = obj as THREE.Mesh & { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; count?: number };
            if (!mesh.isMesh) return;
            if (camera && !camera.layers.test(obj.layers)) return;
            const geo = mesh.geometry as THREE.BufferGeometry | undefined;
            if (!geo) return;
            const indexCount = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0);
            const triPer = Math.floor(indexCount / 3);
            const instances = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
            // BatchedMesh draws one call per visible sub-mesh on WebGPU; approximate
            // with its render count when present, else 1.
            const drawCalls = mesh.isBatchedMesh ? (mesh.count ?? 1) : 1;
            const triangles = triPer * instances;
            const fp = PerfStatsCollector.fingerprint(obj);
            const row = rows.get(fp) ?? { fp, objects: 0, drawCalls: 0, triangles: 0, instances: 0 };
            row.objects++;
            row.drawCalls += drawCalls;
            row.triangles += triangles;
            row.instances += instances;
            rows.set(fp, row);
            estDrawCalls += drawCalls;
            estTriangles += triangles;
        });

        const breakdown = [...rows.values()].sort((a, b) => b.triangles - a.triangles).slice(0, 30);
        let cameraPos: { x: number; y: number; z: number } | null = null;
        if (camera) {
            const p = camera.getWorldPosition(_perfVec);
            cameraPos = { x: round1(p.x), y: round1(p.y), z: round1(p.z) };
        }

        this.spikes.push({
            t: Math.round(t), frameMs: round1(frameMs), renderMs: round1(renderMs), reason,
            calls, tris, points: info.render.points, lines: info.render.lines,
            callsDelta, trisDelta,
            geometries: info.memory.geometries, textures: info.memory.textures,
            programs: info.programs ? info.programs.length : 0,
            recompiles: this.churn.totalRecompiles,
            lights, shadowMapEnabled: this.renderer.shadowMap.enabled,
            cameraPos, estDrawCalls, estTriangles, breakdown,
        });
        if (this.spikes.length > PerfStatsCollector.SPIKE_MAX) this.spikes.shift();

        console.warn(
            `[BM PERF] spike #${this.spikes.length} (${reason}): ${round1(frameMs)}ms frame / ${round1(renderMs)}ms render, ` +
            `${calls} calls (Δ${callsDelta >= 0 ? '+' : ''}${callsDelta}), ${(tris / 1e6).toFixed(2)}M tris ` +
            `(Δ${trisDelta >= 0 ? '+' : ''}${trisDelta}). Run __bmDumpPerf() to export.`,
        );
    }

    /** Assemble the full diagnostic report (per-frame ring + spike snapshots). */
    buildPerfReport(): object {
        return {
            generatedAt: new Date().toISOString(),
            backend: getActiveBackend(this.renderer),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
            spikeCount: this.spikes.length,
            spikes: this.spikes,
            shaderRecompiles: this.churn.totalRecompiles,
            shaderChurn: this.churn.eventLog,
            frameRing: this.frameRing,
        };
    }

    /** Console-log the report and download it as JSON (lands in the Downloads folder). */
    dumpPerfReport(): object {
        const report = this.buildPerfReport();
        console.log('[BM PERF] report', report);
        try {
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bm-perf-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            console.log(`[BM PERF] downloaded ${a.download} (${this.spikes.length} spikes)`);
        } catch (err) {
            console.warn('[BM PERF] download failed; copy the logged report object above instead:', err);
        }
        return report;
    }

    private clearPerfRecording(): void {
        this.spikes = [];
        this.frameRing = [];
        console.log('[BM PERF] recording cleared');
    }

    /** Expose __bmDumpPerf()/__bmClearPerf() on window and bind F2 to dump. */
    private installSpikeRecorderGlobals(): void {
        if (typeof window === 'undefined') return;
        const w = window as unknown as { __bmDumpPerf?: () => object; __bmClearPerf?: () => void };
        w.__bmDumpPerf = () => this.dumpPerfReport();
        w.__bmClearPerf = () => this.clearPerfRecording();
        if (!this.keyListenerAttached) {
            window.addEventListener('keydown', (e) => {
                if (e.key === 'F2') { e.preventDefault(); this.dumpPerfReport(); }
            });
            this.keyListenerAttached = true;
        }
    }

    /**
     * Call once per rendered frame to track FPS.
     */
    recordFrame(): void {
        this.frameCount++;
        const now = performance.now();
        const elapsed = now - this.lastFpsTime;
        if (elapsed >= 500) {
            this.currentFps = Math.round((this.frameCount / elapsed) * 1000);
            this.frameCount = 0;
            this.lastFpsTime = now;
        }
    }

    /**
     * Collect all performance stats into a snapshot.
     */
    collect(): PerfStats {
        const info = this.renderer.info;
        const now = performance.now();

        // Update scene graph counts every ~2s
        if (now - this.lastSceneScanTime > PerfStatsCollector.SCENE_SCAN_INTERVAL) {
            this.scanScene();
            this.lastSceneScanTime = now;
        }

        // Physics stats
        let rigidBodyCount = 0;
        let colliderCount = 0;
        if (this.physicsWorld) {
            const physicsStats = this.physicsWorld.getStats();
            rigidBodyCount = physicsStats.rigidBodyCount;
            colliderCount = physicsStats.colliderCount;
        }

        // JS heap (Chrome only)
        let jsHeapUsedMB: number | null = null;
        let jsHeapTotalMB: number | null = null;
        const perfMemory = (performance as unknown as { memory?: PerformanceMemory }).memory;
        if (perfMemory) {
            jsHeapUsedMB = Math.round(perfMemory.usedJSHeapSize / 1048576);
            jsHeapTotalMB = Math.round(perfMemory.totalJSHeapSize / 1048576);
        }

        return {
            timestamp: now,
            fps: this.currentFps,
            targetFps: this.getTargetFps(),
            frameTime: this.currentFps > 0 ? Math.round(1000 / this.currentFps * 10) / 10 : 0,

            drawCalls: this.getFrameDrawCalls(),
            triangles: info.render.triangles,
            points: info.render.points,
            lines: info.render.lines,

            geometries: info.memory.geometries,
            textures: info.memory.textures,

            shaderPrograms: info.programs ? info.programs.length : 0,
            shaderRecompiles: this.churn.totalRecompiles,

            sceneObjectCount: this.cachedSceneObjectCount,
            meshCount: this.cachedMeshCount,
            lightCount: this.cachedLightCount,

            groupCount: this.cachedGroupCount,
            spriteCount: this.cachedSpriteCount,
            lineObjectCount: this.cachedLineObjectCount,
            pointsObjectCount: this.cachedPointsObjectCount,
            skinnedMeshCount: this.cachedSkinnedMeshCount,
            instancedMeshCount: this.cachedInstancedMeshCount,

            uniqueGeometries: this.cachedUniqueGeometries,
            uniqueMaterials: this.cachedUniqueMaterials,

            topObjectTypes: this.cachedTopObjectTypes,
            objectTypeDeltas: this.cachedObjectTypeDeltas,

            orphanedGeoTypes: this.cachedOrphanedGeoTypes,
            orphanedGeoTotal: this.cachedOrphanedGeoTotal,

            rigidBodyCount,
            colliderCount,

            jsHeapUsedMB,
            jsHeapTotalMB,
        };
    }

    /**
     * Start emitting stats to the creator at the given interval.
     */
    startEmitting(intervalMs = 500): void {
        this.stopEmitting();
        this.lastFpsTime = performance.now();
        this.frameCount = 0;
        this.emitInterval = setInterval(() => {
            const stats = this.collect();
            safePostMessageToCreator({ type: 'PERF_STATS', data: stats });
        }, intervalMs);
    }

    /**
     * Stop emitting stats.
     */
    stopEmitting(): void {
        if (this.emitInterval !== null) {
            clearInterval(this.emitInterval);
            this.emitInterval = null;
        }
    }

    /**
     * Update the physics world reference (e.g. after game reload).
     */
    setPhysicsWorld(physicsWorld: PhysicsWorld | null): void {
        this.physicsWorld = physicsWorld;
    }

    private scanScene(): void {
        let objects = 0;
        let meshes = 0;
        let lights = 0;
        let groups = 0;
        let sprites = 0;
        let lineObjects = 0;
        let pointsObjects = 0;
        let skinnedMeshes = 0;
        let instancedMeshes = 0;

        // Track unique geometry/material instances via identity sets
        const geoSet = new Set<THREE.BufferGeometry>();
        const matSet = new Set<THREE.Material>();

        // Fingerprint counts — classify each renderable by geo+mat type
        const typeCounts = new Map<string, number>();

        // Map geometry UUID → geo-only fingerprint for orphan detection
        const currentGeoMap = new Map<string, string>();

        this.scene.traverse((obj) => {
            objects++;

            if ((obj as THREE.InstancedMesh).isInstancedMesh) {
                instancedMeshes++;
                meshes++;
            } else if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
                skinnedMeshes++;
                meshes++;
            } else if ((obj as THREE.Mesh).isMesh) {
                meshes++;
            }

            if ((obj as THREE.Light).isLight) lights++;
            if ((obj as THREE.Group).isGroup) groups++;
            if ((obj as THREE.Sprite).isSprite) sprites++;
            if ((obj as THREE.Line).isLine) lineObjects++;
            if ((obj as THREE.Points).isPoints) pointsObjects++;

            // Collect unique geometry/material refs + fingerprints from renderables
            const asMesh = obj as THREE.Mesh;
            if (asMesh.isMesh || (obj as THREE.Line).isLine || (obj as THREE.Points).isPoints) {
                if (asMesh.geometry) {
                    geoSet.add(asMesh.geometry);
                    // Track geo UUID with its type fingerprint
                    if (!currentGeoMap.has(asMesh.geometry.uuid)) {
                        currentGeoMap.set(
                            asMesh.geometry.uuid,
                            PerfStatsCollector.geoFingerprint(asMesh.geometry)
                        );
                    }
                }
                if (asMesh.material) {
                    if (Array.isArray(asMesh.material)) {
                        for (const m of asMesh.material) matSet.add(m);
                    } else {
                        matSet.add(asMesh.material);
                    }
                }

                // Build fingerprint: "ObjType(GeoType,MatType)"
                const fp = PerfStatsCollector.fingerprint(obj);
                typeCounts.set(fp, (typeCounts.get(fp) ?? 0) + 1);
            }
        });

        this.cachedSceneObjectCount = objects;
        this.cachedMeshCount = meshes;
        this.cachedLightCount = lights;
        this.cachedGroupCount = groups;
        this.cachedSpriteCount = sprites;
        this.cachedLineObjectCount = lineObjects;
        this.cachedPointsObjectCount = pointsObjects;
        this.cachedSkinnedMeshCount = skinnedMeshes;
        this.cachedInstancedMeshCount = instancedMeshes;
        this.cachedUniqueGeometries = geoSet.size;
        this.cachedUniqueMaterials = matSet.size;

        // Top types by count (top 15)
        this.cachedTopObjectTypes = [...typeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15);

        // Compute deltas vs previous scan — only report non-zero changes
        const deltas: [string, number][] = [];
        // Check all current types for increases
        for (const [fp, count] of typeCounts) {
            const prev = this.previousTypeCounts.get(fp) ?? 0;
            const delta = count - prev;
            if (delta !== 0) deltas.push([fp, delta]);
        }
        // Check removed types (were in previous but not in current)
        for (const [fp, prev] of this.previousTypeCounts) {
            if (!typeCounts.has(fp)) {
                deltas.push([fp, -prev]);
            }
        }
        // Sort by absolute delta descending, keep top 10
        deltas.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        this.cachedObjectTypeDeltas = deltas.slice(0, 10);
        this.previousTypeCounts = typeCounts;

        // ── Orphan detection ──
        // Geos in the previous scan but NOT in the current scan were removed from scene.
        // If renderer.info.memory.geometries didn't decrease by the same amount, they're orphaned.
        const currentAllocated = this.renderer.info.memory.geometries;
        const removedFromScene: string[] = []; // fingerprints of geos that left
        for (const [uuid, fp] of this.prevSceneGeoMap) {
            if (!currentGeoMap.has(uuid)) {
                removedFromScene.push(fp);
            }
        }
        if (removedFromScene.length > 0) {
            // How many geos were actually disposed? (allocated count went down)
            const disposedCount = Math.max(0, this.prevAllocatedGeoCount - currentAllocated);
            // The rest were orphaned (removed from scene but not disposed)
            const orphanedCount = Math.max(0, removedFromScene.length - disposedCount);
            if (orphanedCount > 0) {
                // Attribute orphans to the fingerprints that left (proportionally, FIFO)
                // Simple approach: count all removed fingerprints, mark the first N as orphaned
                const fpCounts = new Map<string, number>();
                for (const fp of removedFromScene) {
                    fpCounts.set(fp, (fpCounts.get(fp) ?? 0) + 1);
                }
                // Scale counts proportionally to orphanedCount
                const totalRemoved = removedFromScene.length;
                for (const [fp, count] of fpCounts) {
                    const attributed = Math.round((count / totalRemoved) * orphanedCount);
                    if (attributed > 0) {
                        this.orphanedGeoCounts.set(
                            fp,
                            (this.orphanedGeoCounts.get(fp) ?? 0) + attributed
                        );
                    }
                }
            }
        }
        this.prevSceneGeoMap = currentGeoMap;
        this.prevAllocatedGeoCount = currentAllocated;

        // Build sorted orphan summary (top 10)
        this.cachedOrphanedGeoTypes = [...this.orphanedGeoCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        let total = 0;
        for (const [, c] of this.orphanedGeoCounts) total += c;
        this.cachedOrphanedGeoTotal = total;
    }

    /**
     * Build a human-readable fingerprint for a renderable object.
     * Format: "ObjType(GeoName,MatType)" e.g. "Mesh(BoxGeo,StdMat)"
     */
    private static fingerprint(obj: THREE.Object3D): string {
        // Object type
        let objType = 'Obj';
        if ((obj as THREE.InstancedMesh).isInstancedMesh) objType = 'IMesh';
        else if ((obj as THREE.SkinnedMesh).isSkinnedMesh) objType = 'Skinned';
        else if ((obj as THREE.Mesh).isMesh) objType = 'Mesh';
        else if ((obj as THREE.Line).isLine) objType = 'Line';
        else if ((obj as THREE.Points).isPoints) objType = 'Points';

        // Geometry name — use constructor name, strip "BufferGeometry" suffix for brevity
        const geo = (obj as THREE.Mesh).geometry;
        const geoName = geo ? PerfStatsCollector.geoFingerprint(geo) : '?';

        // Material type — abbreviate common names
        const mat = (obj as THREE.Mesh).material;
        let matName = '?';
        if (mat) {
            const m = Array.isArray(mat) ? mat[0] : mat;
            if (m) {
                matName = m.type || m.constructor.name;
                matName = matName
                    .replace('Material', 'Mat')
                    .replace('MeshStandard', 'Std')
                    .replace('MeshBasic', 'Basic')
                    .replace('MeshPhysical', 'Phys')
                    .replace('MeshPhong', 'Phong')
                    .replace('MeshLambert', 'Lambert')
                    .replace('LineBasic', 'LineMat')
                    .replace('PointsMat', 'PtsMat');
            }
        }

        return `${objType}(${geoName},${matName})`;
    }

    /**
     * Short fingerprint for a geometry (type only, no material).
     * Used for orphan tracking where the material is no longer accessible.
     */
    private static geoFingerprint(geo: THREE.BufferGeometry): string {
        let name = geo.type || geo.constructor.name;
        name = name
            .replace('BufferGeometry', 'Geo')
            .replace('Geometry', 'Geo');
        if (name === 'Geo') name = 'BufferGeo';
        return name;
    }

    /**
     * Reset orphaned geometry tracking.
     * Call on game reload to start fresh.
     */
    resetOrphanTracking(): void {
        this.orphanedGeoCounts.clear();
        this.prevSceneGeoMap.clear();
        this.prevAllocatedGeoCount = this.renderer.info.memory.geometries;
        this.cachedOrphanedGeoTypes = [];
        this.cachedOrphanedGeoTotal = 0;
    }

    /**
     * Reset shader churn tracking. Call on game reload: the old game's
     * programs go away legitimately and must not pair with the new game's.
     */
    resetChurnTracking(): void {
        this.churn.reset();
        this.churnWarnedCount.clear();
    }
}
