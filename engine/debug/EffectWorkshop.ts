import * as THREE from 'three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { WebGPURenderer } from 'three/webgpu';
import { setActiveRendererType } from 'engine/RendererType.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { EXPLOSION_PRESETS, type ExplosionPreset } from 'engine/effects/ExplosionPresets.js';
import { BurstVisual, DEFAULT_BURST_OPTIONS } from 'engine/effects/BurstVisual.js';
import { BURST_PRESETS, type BurstPreset } from 'engine/effects/BurstPresets.js';
import { LightningVisual, DEFAULT_LIGHTNING_OPTIONS, LIGHTNING_PRESETS, type LightningPreset } from 'engine/effects/LightningVisual.js';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS } from 'engine/effects/VisualEffects.js';
import { AttackVFX, IMPACT_EFFECT_PRESETS } from 'engine/AttackVFX.js';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';
import type { VFXStyle, VFXQuality } from 'engine/effects/VFXUtils.js';
import { EXTRA_CATALOG, FIRE_BURSTS, populateWorkshopScene } from 'debug/EffectWorkshopScenes.js';
import { benchmarkEffect } from 'debug/EffectWorkshopBenchmark.js';

interface Options {
    family: keyof typeof CATALOG;
    view: string;
    style: VFXStyle;
    quality: VFXQuality;
    camera: 'near' | 'design' | 'far';
    debug: 'all' | 'structure' | 'glow' | 'smoke';
    seed: number;
    amount: number;
    variance: number;
    time: number;
    playing: boolean;
    night: boolean;
    occluder: boolean;
}
interface Panel { scene: THREE.Scene; camera: THREE.PerspectiveCamera; name: string; tick: (time: number) => void; dispose: () => void }
const CATALOG = { explosions: Object.keys(EXPLOSION_PRESETS), ...EXTRA_CATALOG,
    bursts: Object.keys(BURST_PRESETS).filter(preset => !FIRE_BURSTS.includes(preset)),
    lightning: Object.keys(LIGHTNING_PRESETS).filter(preset => !EXTRA_CATALOG.beams.includes(preset)),
    impacts: Object.keys(IMPACT_EFFECT_PRESETS), stress: ['stress'] };
const PAGE_SIZE = 8;
declare global { interface Window { effectWorkshop: { set: (patch: Partial<Options>) => void; catalog: typeof CATALOG;
    metrics: () => object; profile: () => Promise<object>; benchmark: () => Promise<object>; dispose: () => void } } }

async function start(): Promise<void> {
    const gpu = new URLSearchParams(location.search).get('backend') === 'webgpu';
    setActiveRendererType(gpu ? 'webgpu' : 'webgl');
    const renderer = gpu ? new WebGPURenderer({ antialias: true, trackTimestamp: true }) : new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (renderer instanceof WebGPURenderer) await renderer.init();
    renderer.setSize(1440, 900); renderer.setPixelRatio(1); renderer.autoClear = false; renderer.info.autoReset = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
    document.getElementById('stage')!.appendChild(renderer.domElement);
    document.querySelector('h1')!.textContent = `Effects workshop · ${Object.entries(CATALOG).filter(([family]) => family !== 'stress').reduce((sum, [, presets]) => sum + presets.length, 0)} effects`;
    const options: Options = { family: 'explosions', view: 'page:1', style: 'low-poly', quality: 'high', camera: 'design', debug: 'all',
        seed: 73, amount: 1, variance: 0.7, time: 0.28, playing: false, night: false, occluder: false };
    const panels: Panel[] = [];
    let submissionMs = 0, updateMs = 0, disposed = false;

    function clear(): void {
        for (const p of panels) {
            p.dispose(); ExplosionVisual.disposeScene(p.scene); ShaderKeepAlive.for(p.scene).dispose();
            p.scene.traverse(child => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                child.geometry.dispose(); (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
            } });
        }
        panels.length = 0;
    }
    function panel(name: string): Panel {
        const scene = new THREE.Scene(); scene.background = new THREE.Color(options.night ? 0x151b28 : 0xa7afb6);
        scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x746450, options.night ? 0.5 : 2));
        const light = new THREE.DirectionalLight(0xffeed8, options.night ? 0.7 : 3); light.position.set(-4, 6, 3); scene.add(light);
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: options.night ? 0x242832 : 0x828a8e }));
        ground.rotation.x = -Math.PI / 2; ground.position.y = -0.04; scene.add(ground);
        const grid = new THREE.GridHelper(16, 16, 0x697078, 0x747b84); scene.add(grid);
        if (options.occluder) {
            const block = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 0.5), new THREE.MeshLambertMaterial({ color: 0x525b65 }));
            block.position.set(0, 1.5, 1); scene.add(block);
        }
        const camera = new THREE.PerspectiveCamera(38, 1, 0.03, 300);
        const framing = name === 'volcanic' || name === 'sonic' || name === 'shockwave' ? 1.35 : 1;
        const distance = framing * (options.family === 'stress' ? 1.7 : 1) * (options.camera === 'near' ? 0.72 : options.camera === 'far' ? 1.75 : 1)
            * (options.family === 'impacts' ? 0.38 : options.family === 'bursts' ? 0.6 : 1);
        camera.position.set(6 * distance, 4.7 * distance, 9 * distance);
        camera.lookAt(0, options.family === 'impacts' ? 0.6 : name === 'volcanic' ? 1.8 : 1.1, 0);
        const p: Panel = { scene, camera, name, tick: () => {}, dispose: () => {} }; panels.push(p); return p;
    }
    function rebuild(): void {
        clear();
        const legacy = ['weapons', 'environment', 'telegraphs'].includes(options.family);
        for (const id of ['style', 'quality', 'amount', 'variance']) {
            const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
            control.disabled = id === 'style' || id === 'quality' ? legacy || options.family === 'impacts'
                : id === 'variance' ? legacy : ['weapons', 'telegraphs'].includes(options.family) || options.view === 'boat-wake';
            control.title = control.disabled ? 'This existing system uses its own authored settings.' : '';
        }
        const debug = document.getElementById('debug') as HTMLSelectElement;
        const supportsLayers = ['explosions', 'fire', 'bursts', 'lightning', 'beams', 'transitions'].includes(options.family);
        for (const entry of debug.options) entry.disabled = entry.value !== 'all' && (!supportsLayers || (entry.value === 'smoke' && !['explosions', 'fire'].includes(options.family)));
        if ([...debug.options].find(entry => entry.value === options.debug)?.disabled) options.debug = 'all';
        debug.value = options.debug;
        const presets = CATALOG[options.family], pages = Math.ceil(presets.length / PAGE_SIZE);
        const view = document.getElementById('view') as HTMLSelectElement;
        view.replaceChildren(...Array.from({ length: pages }, (_, i) => new Option(`Page ${i + 1} / ${pages} · ${presets.length} presets`, `page:${i}`)),
            ...presets.map(name => new Option(name, name)));
        if (![...view.options].some(item => item.value === options.view)) options.view = 'page:0';
        view.value = options.view;
        const page = Number(options.view.slice(5));
        const visible = options.view.startsWith('page:') ? presets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : [options.view];
        const position = new THREE.Vector3(0, 0.08, 0);
        if (options.family === 'explosions') for (const preset of visible as ExplosionPreset[]) {
            const p = panel(preset);
            const layers = options.debug === 'structure' ? { flash: 0, sparks: 0, ring: 0 }
                : options.debug === 'glow' ? { fire: 0, smoke: 0, debris: 0 }
                : options.debug === 'smoke' ? { flash: 0, sparks: 0, ring: 0, fire: 0, debris: 0 } : {};
            const visual = ExplosionVisual.acquire(p.scene, position, { ...options, preset, radius: 2.8, color: EXPLOSION_PRESETS[preset].color, layers });
            p.tick = time => visual.setProgress(time);
        }
        if (options.family === 'bursts' || options.family === 'fire') for (const preset of visible.filter(name => Object.prototype.hasOwnProperty.call(BURST_PRESETS, name)) as BurstPreset[]) {
            const p = panel(preset), visual = new BurstVisual(p.scene, options.style);
            visual.rearm(position, { ...DEFAULT_BURST_OPTIONS, ...options, preset, radius: 1.4, color: BURST_PRESETS[preset].color,
                layers: { particles: options.debug !== 'glow', ring: options.debug !== 'structure' } });
            p.tick = time => visual.setProgress(time); p.dispose = () => visual.dispose();
        }
        if (options.family === 'lightning') for (const preset of visible as LightningPreset[]) {
            const p = panel(preset), visual = new LightningVisual(p.scene, options.style);
            const points = preset === 'chain' ? [new THREE.Vector3(-2.6, 3.5, 0), new THREE.Vector3(0, 0.7, 0), new THREE.Vector3(2.5, 2.5, 0)]
                : [new THREE.Vector3(-2, 4.5, 0), new THREE.Vector3(1.4, 0.3, 0)];
            visual.rearm(points, { ...DEFAULT_LIGHTNING_OPTIONS, ...LIGHTNING_PRESETS[preset], ...options, preset,
                layers: { core: options.debug !== 'glow', glow: options.debug !== 'structure', endpoints: options.debug !== 'structure' } });
            p.tick = time => visual.setProgress(time); p.dispose = () => visual.dispose();
        }
        if (options.family === 'impacts') for (const name of visible as (keyof typeof IMPACT_EFFECT_PRESETS)[]) {
            const config = IMPACT_EFFECT_PRESETS[name];
            const p = panel(name), system = new AttackVFX(p.scene, { ...config, seed: options.seed, variance: options.variance, particleCount: Math.round(config.particleCount * options.amount) });
            let age = 0;
            const spawn = () => system.createImpactEffect(new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(0.5, 1, 0)); spawn();
            p.tick = time => { if (time < age) { system.update(10); spawn(); age = 0; } system.update((time - age) * config.duration); age = time; };
            p.dispose = () => system.dispose();
        }
        if (Object.prototype.hasOwnProperty.call(EXTRA_CATALOG, options.family)) for (const name of visible) {
            if (options.family === 'fire' && FIRE_BURSTS.includes(name)) continue;
            populateWorkshopScene(options.family, name, panel(name), options, renderer instanceof WebGPURenderer ? renderer : null);
        }
        if (options.family === 'stress') {
            const p = panel('48 concurrent effects · pooled playback');
            const system = new VisualEffects(p.scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, style: options.style, quality: options.quality });
            let frame = 0, previous = Infinity;
            const positions = Array.from({ length: 48 }, (_, i) => new THREE.Vector3((i % 8 - 3.5) * 1.7, 0.1, (Math.floor(i / 8) - 2.5) * 1.7));
            const targets = new Map<number, THREE.Mesh>();
            for (let i = 7; i < 48; i += 8) {
                const target = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.55), new THREE.MeshLambertMaterial({ color: 0x7cabbf }));
                target.position.copy(positions[i]!).y = 0.45; p.scene.add(target); targets.set(i, target);
            }
            const explosions = Object.keys(EXPLOSION_PRESETS) as ExplosionPreset[];
            const bursts = Object.keys(BURST_PRESETS) as BurstPreset[];
            const bolts = Object.keys(LIGHTNING_PRESETS) as LightningPreset[];
            p.tick = time => {
                if (time < previous) {
                    system.clear(); frame = 0;
                    for (let i = 0; i < 48; i++) {
                        const at = positions[i]!.set((i % 8 - 3.5) * 1.7, 0.1, (Math.floor(i / 8) - 2.5) * 1.7);
                        const common = { amount: options.amount, variance: options.variance, seed: options.seed + i, duration: 4 };
                        switch (i % 8) {
                            case 0: system.explosion(explosions[i % explosions.length]!, at, { ...common, radius: 0.65 }); break;
                            case 1: system.burst(bursts[i % bursts.length]!, at, { ...common, radius: 0.45 }); break;
                            case 2: system.lightning([at, at.clone().add(new THREE.Vector3(0.5, 2, 0))], { ...common, preset: bolts[i % bolts.length]!, width: 0.02 }); break;
                            case 3: system.fire('campfire', at, { ...common, radius: 0.4 }); break;
                            case 4: system.shield('dome', at, { ...common, radius: 0.6 }); break;
                            case 5: system.surface('wet-splash', at, { ...common, radius: 0.6 }); break;
                            case 6: system.trail('magic-trail', at, { ...common, width: 0.08 }); break;
                            case 7: { const target = targets.get(i)!; target.visible = true; system.transition('dissolve', target, common); break; }
                        }
                    }
                }
                const next = Math.floor(time * 240);
                while (frame < next) {
                    frame++;
                    for (let i = 6; i < 48; i += 8) positions[i]!.x = 4.25 + Math.sin(frame / 24) * 0.55;
                    system.update(1 / 60);
                }
                previous = time;
            };
            p.dispose = () => system.dispose();
        }
        panels.sort((a, b) => visible.indexOf(a.name) - visible.indexOf(b.name));
        const cols = columns();
        const rows = Math.ceil(panels.length / cols);
        document.getElementById('labels')!.replaceChildren(...panels.map((p, i) => {
            const label = document.createElement('span'); label.className = 'label'; label.textContent = p.name;
            label.style.left = `${(i % cols) * 1440 / cols + 14}px`; label.style.top = `${Math.floor(i / cols) * 900 / rows + 126}px`; return label;
        }));
    }
    function columns(): number { return panels.length <= 2 ? panels.length : panels.length > 6 ? 4 : 3; }
    function render(): void {
        const cols = columns(), rows = Math.ceil(panels.length / cols);
        renderer.info.reset(); const start = performance.now(); updateMs = 0;
        renderer.setScissorTest(false); renderer.setViewport(0, 0, 1440, 900); renderer.setClearColor(0x181818); renderer.clear();
        renderer.setScissorTest(true);
        panels.forEach((p, i) => {
            const w = 1440 / cols, h = 900 / rows, x = i % cols * w, row = Math.floor(i / cols);
            const y = gpu ? row * h : 900 - (row + 1) * h;
            p.camera.aspect = w / h; p.camera.updateProjectionMatrix();
            const updateStart = performance.now(); p.tick(options.time); updateMs += performance.now() - updateStart;
            renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.clear(); renderer.render(p.scene, p.camera);
        });
        renderer.setScissorTest(false); submissionMs = performance.now() - start;
        document.getElementById('metrics')!.textContent = `${gpu ? 'WebGPU' : 'WebGL'} · no post · ${drawCalls()} draws · ${renderer.info.render.triangles.toLocaleString()} triangles · ${submissionMs.toFixed(1)} ms CPU submit`;
    }
    function set(patch: Partial<Options>): void {
        const needsRebuild = Object.keys(patch).some(key => key !== 'time' && key !== 'playing');
        if (patch.family && patch.family !== options.family && patch.view === undefined) options.view = 'page:0';
        Object.assign(options, patch);
        if (needsRebuild) rebuild();
        for (const [key, value] of Object.entries(options)) {
            const control = document.getElementById(key) as HTMLInputElement | HTMLSelectElement;
            if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
            else control.value = String(value);
        }
        render();
    }
    for (const id of ['family', 'view', 'style', 'quality', 'camera', 'debug', 'seed', 'amount', 'variance', 'time', 'playing', 'night', 'occluder']) {
        const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
        input.addEventListener('input', () => set({ [id]: input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked
            : ['seed', 'amount', 'variance', 'time'].includes(id) ? Number(input.value) : input.value }));
    }
    let previous = performance.now();
    renderer.setAnimationLoop(() => {
        const now = performance.now(); if (options.playing) { options.time = (options.time + (now - previous) / 2500) % 1; render(); } previous = now;
    });
    const drawCalls = () => renderer instanceof WebGPURenderer ? renderer.info.render.drawCalls : renderer.info.render.calls;
    const instanceMetrics = () => {
        let visibleInstances = 0, instanceBufferBytes = 0;
        for (const p of panels) {
            p.scene.traverse(child => { if (child instanceof THREE.InstancedMesh) {
                instanceBufferBytes += child.instanceMatrix.array.byteLength + (child.instanceColor?.array.byteLength ?? 0);
            } });
            p.scene.traverseVisible(child => { if (child instanceof THREE.InstancedMesh) visibleInstances += child.count; });
        }
        return { visibleInstances, instanceBufferBytes };
    };
    const metrics = () => ({ ...instanceMetrics(), ...options, backend: gpu ? 'webgpu' : 'webgl', viewport: [1440, 900], dpr: 1,
        draws: drawCalls(), triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, renderTargets: 0, cpuSubmissionMs: submissionMs, cpuUpdateMs: updateMs });
    rebuild(); render();
    window.effectWorkshop = { set, metrics, catalog: CATALOG,
        benchmark: () => {
            options.playing = false;
            return benchmarkEffect(renderer, time => { options.time = time; render(); }, metrics,
                options.family === 'environment' && (options.view === 'rain' || options.view.startsWith('page:')));
        },
        profile: async () => {
            const samples: number[] = [], gpuSamples: number[] = [];
            const startTime = options.time;
            const timestampRenderer = renderer instanceof WebGPURenderer && renderer.hasFeature('timestamp-query') ? renderer : null;
            for (let i = 0; i < 45; i++) {
                options.time = Math.min(0.99, startTime + i / 240);
                render();
                const gpuDuration = timestampRenderer ? await timestampRenderer.resolveTimestampsAsync() : undefined;
                await new Promise(requestAnimationFrame);
                if (i >= 15) { samples.push(submissionMs); if (typeof gpuDuration === 'number') gpuSamples.push(gpuDuration); }
            }
            return { ...metrics(), samples: samples.length,
                cpuSubmissionMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
                gpuMs: gpuSamples.length ? gpuSamples.reduce((a, b) => a + b, 0) / gpuSamples.length : null };

        },
        dispose: () => { if (disposed) return; disposed = true; renderer.setAnimationLoop(null); clear(); renderer.dispose(); },
    };
}
void start().catch(error => { document.getElementById('metrics')!.textContent = String(error); console.error(error); });
