/** Standalone, deterministic foliage inspection; scripts/preview-foliage.mjs. */
import * as THREE from 'three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { WebGPURenderer } from 'three/webgpu';
import { FoliageSystem } from 'engine/FoliageSystem.js';
import { VoxelFoliageSystem } from 'engine/VoxelFoliageSystem.js';
import { TerrainTypeRegistry, FoliageType } from 'engine/TerrainTypes.js';
import type { HeightmapSystem } from 'engine/HeightmapSystem.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';
import { createForgedFoliagePreview } from './ForgedFoliagePreview.js';
import { checkFoliageChunkLifecycle } from './FoliageRuntimeChecks.js';
import type { GroundDetailSystem } from 'engine/vxlscene/GroundDetailSystem.js';
import { setActiveRendererType } from 'engine/RendererType.js';

interface PreviewOptions { seed: number; time: number; wind: number; mode: string; view: string; playing: boolean }
declare global {
    interface Window { foliagePreview: { set: (options: Partial<PreviewOptions>) => void; metrics: () => object; validate: () => object } }
}

async function start(): Promise<void> {
    const gpu = new URLSearchParams(location.search).get('backend') === 'webgpu';
    setActiveRendererType(gpu ? 'webgpu' : 'webgl');
    const renderer = gpu ? new WebGPURenderer({ antialias: true }) : new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (renderer instanceof WebGPURenderer) await renderer.init();
    renderer.setSize(1440, 900); renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    document.getElementById('stage')!.appendChild(renderer.domElement);
    const options: PreviewOptions = { seed: 73, time: 2, wind: 0.28, mode: 'final', view: 'design', playing: false };
    const panels: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; system: FoliageSystem | VoxelFoliageSystem | GroundDetailSystem; size: number }[] = [];
    let cpuRenderMs = 0;

    function rebuild(): void {
        for (const { scene, system } of panels) {
            system.dispose();
            scene.traverse(object => {
                if (object instanceof THREE.Mesh) {
                    object.geometry.dispose();
                    (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose());
                }
            });
        }
        panels.length = 0;
        for (const style of [0, 1, 2]) {
            const voxel = style === 1, forged = style === 2;
            const size = voxel ? 8 : 16;
            const scene = new THREE.Scene(); scene.background = new THREE.Color(0xbccdd0);
            scene.add(new THREE.HemisphereLight(0xd3e8f2, 0x68754c, 2.0));
            const sun = new THREE.DirectionalLight(0xffedcd, 3.2);
            sun.position.set(-8, 12, 5); sun.castShadow = true;
            sun.shadow.mapSize.set(2048, 2048);
            sun.shadow.camera.left = -14; sun.shadow.camera.right = 14;
            sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
            sun.shadow.normalBias = 0.015; scene.add(sun);
            const heightAt = (x: number, z: number): number => forged ? 0 : 0.13 * Math.sin(x * 0.9) * Math.cos(z * 0.65);
            const typeAt = (x: number, z: number): number => Math.abs(x - 0.5 * Math.sin(z * 0.5)) < size * 0.06 ? 0 : 1;
            const registry = new TerrainTypeRegistry();
            registry.registerType(1, { name: 'Meadow', foliageType: FoliageType.FIELD, canPlaceTrees: true, canPlaceRocks: true });
            const terrain = new THREE.PlaneGeometry(size, size, 64, 64); terrain.rotateX(-Math.PI / 2);
            const p = terrain.getAttribute('position');
            const colors: number[] = [];
            for (let i = 0; i < p.count; i++) {
                p.setY(i, heightAt(p.getX(i), p.getZ(i)) - 0.005);
                const color = new THREE.Color(typeAt(p.getX(i), p.getZ(i)) ? 0x536738 : 0x9f8865);
                colors.push(color.r, color.g, color.b);
            }
            terrain.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); terrain.computeVertexNormals();
            const ground = new THREE.Mesh(terrain, new THREE.MeshLambertMaterial({ vertexColors: true })); ground.receiveShadow = true; scene.add(ground);
            const provider = { getHeightAt: heightAt, getTerrainTypeAt: typeAt };
            let system: FoliageSystem | VoxelFoliageSystem | GroundDetailSystem;
            if (forged) {
                system = createForgedFoliagePreview(scene, options.seed);
            } else if (voxel) {
                system = new VoxelFoliageSystem(scene, size, size, options.seed, registry, provider as unknown as TerrainHeightProvider,
                    { terrainVoxelSize: 0.25, getTerrainHeight: heightAt });
                const surfaces = [];
                for (let x = -size / 2; x < size / 2; x += 0.25) for (let z = -size / 2; z < size / 2; z += 0.25) {
                    surfaces.push({ worldX: x, worldY: heightAt(x, z), worldZ: z, blockType: typeAt(x, z) });
                }
                system.generateFoliageForChunk('0,0', surfaces, scene, type => type);
            } else {
                system = new FoliageSystem(scene, size, size, 1, options.seed, registry, provider as unknown as HeightmapSystem);
                system.initializeFoliageTexture(); system.generateFoliage();
            }
            const camera = new THREE.PerspectiveCamera(43, 480 / 800, 0.05, 120);
            panels.push({ scene, camera, system, size });
        }
    }

    function render(): void {
        const started = performance.now();
        renderer.setScissorTest(false); renderer.setViewport(0, 0, 1440, 900); renderer.clear();
        renderer.setScissorTest(true); renderer.info.reset();
        panels.forEach(({ scene, camera, system, size }, i) => {
            const distance = options.view === 'near' ? 0.23 : options.view === 'far' ? 1.8 : 0.8;
            camera.position.set(size * distance * 0.75, size * distance * 0.52, size * distance);
            camera.lookAt(0, 0.12, 0);
            Object.assign(system.appearance, { time: options.time, windStrength: options.wind, debug: options.mode });
            renderer.setViewport(i * 480, gpu ? 100 : 0, 480, 800);
            renderer.setScissor(i * 480, gpu ? 100 : 0, 480, 800);
            renderer.render(scene, camera);
        });
        cpuRenderMs = performance.now() - started;
        const calls = renderer instanceof WebGPURenderer ? renderer.info.render.drawCalls : renderer.info.render.calls;
        document.getElementById('metrics')!.textContent = `${renderer.info.render.triangles.toLocaleString()} triangles · ${calls} draws · ${gpu ? 'WebGPU' : 'WebGL'} · no post effects`;
    }

    rebuild();
    window.foliagePreview = {
        set(patch): void { const changeSeed = patch.seed !== undefined && patch.seed !== options.seed; Object.assign(options, patch);
            for (const key of ['seed', 'time', 'wind', 'mode', 'view'] as const) (document.getElementById(key) as HTMLInputElement).value = String(options[key]);
            if (changeSeed) rebuild(); render(); },
        metrics: () => ({ ...options, cpuRenderMs, triangles: renderer.info.render.triangles,
            calls: renderer instanceof WebGPURenderer ? renderer.info.render.drawCalls : renderer.info.render.calls,
            geometries: renderer.info.memory.geometries, gpuFrameMs: null, postRenderTargets: 0 }),
        validate: checkFoliageChunkLifecycle,
    };
    for (const id of ['mode', 'view']) document.getElementById(id)!.addEventListener('change', event => window.foliagePreview.set({ [id]: (event.target as HTMLSelectElement).value }));
    for (const id of ['seed', 'wind', 'time']) document.getElementById(id)!.addEventListener('input', event => window.foliagePreview.set({ [id]: Number((event.target as HTMLInputElement).value) }));
    document.getElementById('play')!.addEventListener('change', event => { options.playing = (event.target as HTMLInputElement).checked; });
    let last = performance.now();
    renderer.setAnimationLoop(() => { const now = performance.now(); if (options.playing) options.time += (now - last) / 1000; last = now; render(); });
}
void start();
