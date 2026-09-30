import * as THREE from 'three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { WebGPURenderer, PMREMGenerator as GpuPMREMGenerator } from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import { setActiveRendererType } from 'engine/RendererType.js';
import { buildWaterSurfaceMesh } from 'engine/WaterSurface.js';
import { createWaterMaterial } from 'engine/shaders/WaterMaterial.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { LIGHTING_PRESETS, resolveLightingConfig, type LightingPreset } from 'engine/LightingPresets.js';
import { installAmbientFloorLight, applyAmbientFloor } from 'engine/AmbientFloorLight.js';
import { applySunDirection } from 'engine/SunDirection.js';
import { addWaterRegression } from 'debug/VisualWaterChecks.js';
import { addVisualVillage } from 'debug/VisualVillage.js';

interface MeshData { positions: number[]; normals: number[]; colors: number[]; indices: number[] }
interface Fixtures { buildings: { style: string; mesh: MeshData; ruined: MeshData }[]; vehicles: { name: string; style: string; glb: number[] }[] }
interface Options { subject: string; before: boolean; near: boolean; time: number; playing: boolean }
interface Panel { scene: THREE.Scene; camera: THREE.PerspectiveCamera; label: string; frame: THREE.Box3; tick?: (time: number) => void; dispose?: () => void }
declare global {
    interface Window {
        visualFixtures: { before: Fixtures; after: Fixtures };
        visualWorkshop: { set: (patch: Partial<Options>) => Promise<void>; metrics: () => object; shaders: () => Promise<object>; profile: () => Promise<object>;
            waterProbes: () => { label: string; x: number; y: number }[] };
    }
}

function forgeMesh(data: MeshData): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    const colors = new Float32Array(data.colors.length), tint = new THREE.Color();
    for (let i = 0; i < colors.length; i += 3) {
        tint.setRGB(data.colors[i]!, data.colors[i + 1]!, data.colors[i + 2]!, THREE.SRGBColorSpace);
        colors[i] = tint.r; colors[i + 1] = tint.g; colors[i + 2] = tint.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.setIndex(data.indices);
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }));
}

async function start(): Promise<void> {
    const gpu = new URLSearchParams(location.search).get('backend') === 'webgpu';
    setActiveRendererType(gpu ? 'webgpu' : 'webgl');
    const renderer = gpu ? new WebGPURenderer({ antialias: true, trackTimestamp: true }) : new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (renderer instanceof WebGPURenderer) await renderer.init();
    renderer.setSize(1440, 1000); renderer.setPixelRatio(1); renderer.autoClear = false; renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
    document.getElementById('stage')!.appendChild(renderer.domElement);
    const room = new RoomEnvironment();
    const pmrem = renderer instanceof WebGPURenderer ? new GpuPMREMGenerator(renderer) : new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(room, 0.04); room.dispose();
    const options: Options = { subject: 'buildings', before: false, near: false, time: 2, playing: false };
    const panels: Panel[] = [];
    let renderMs = 0;

    function panel(label: string, size: number): Panel {
        const scene = new THREE.Scene(); scene.background = new THREE.Color('#aebbbd'); scene.environment = env.texture;
        scene.environmentIntensity = 0.55;
        scene.add(new THREE.HemisphereLight(0xc6dcf1, 0x655b43, 1.2));
        const sun = new THREE.DirectionalLight(0xffebcd, 3.2); sun.position.set(-size, size * 1.5, size * 0.8); sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -size; sun.shadow.camera.right = size;
        sun.shadow.camera.top = size; sun.shadow.camera.bottom = -size; sun.shadow.camera.far = size * 6;
        sun.shadow.normalBias = 0.03; scene.add(sun);
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(size * 3, size * 3), new THREE.MeshStandardMaterial({ color: 0x898779, roughness: 1 }));
        ground.rotation.x = -Math.PI / 2; ground.position.y = -0.025; ground.receiveShadow = true; scene.add(ground);
        const camera = new THREE.PerspectiveCamera(38, 1, 0.03, size * 30);
        const p: Panel = { scene, camera, label, frame: new THREE.Box3(new THREE.Vector3(-size / 2, 0, -size / 2), new THREE.Vector3(size / 2, size, size / 2)) };
        panels.push(p); return p;
    }

    function add(p: Panel, object: THREE.Object3D): void {
        object.traverse(child => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } });
        p.scene.add(object); p.frame.setFromObject(object);
    }

    async function rebuild(): Promise<void> {
        for (const p of panels) {
            p.dispose?.(); ExplosionVisual.disposeScene(p.scene);
            p.scene.traverse(child => { if (child instanceof THREE.Mesh) {
                child.geometry.dispose(); (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
                if (child instanceof THREE.InstancedMesh) child.dispose();
            } else if (child instanceof THREE.DirectionalLight) child.shadow.dispose(); });
        }
        panels.length = 0;
        const data = window.visualFixtures[options.before ? 'before' : 'after'];
        if (options.subject === 'village') {
            const p = panel('Combined scene · six buildings, six vehicles, six grass patches, coastal water and blast', 65);
            const floor = p.scene.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh; floor.visible = false;
            const loader = createGltfLoader();
            const vehicles = await Promise.all(data.vehicles.map(async v => (await loader.parseAsync(new Uint8Array(v.glb).buffer, '')).scene));
            const village = addVisualVillage(p.scene, forgeMesh(data.buildings[0]!.mesh), vehicles);
            p.tick = village.tick; p.dispose = village.dispose;
            p.frame.set(new THREE.Vector3(-43, 0, -30), new THREE.Vector3(43, 11, 44));
        } else if (options.subject === 'water-checks') {
            for (const [kind, label] of ['Negative seabed · Y = −5', '4 m channel · 1 km map', '0.8 m channel · smaller than a facet'].entries()) {
                const p = panel(label, 24);
                const floor = p.scene.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh; floor.visible = false;
                p.frame.copy(addWaterRegression(p.scene, kind));
            }
        } else if (options.subject === 'buildings' || options.subject === 'ruins') {
            for (const b of data.buildings) {
                const p = panel(b.style, 28); add(p, forgeMesh(options.subject === 'ruins' ? b.ruined : b.mesh));
            }
        } else if (options.subject === 'vehicles') {
            const loader = createGltfLoader();
            for (const v of data.vehicles) {
                const p = panel(`${v.name} · ${v.style}`, 6);
                const gltf = await loader.parseAsync(new Uint8Array(v.glb).buffer, ''); add(p, gltf.scene);
            }
        } else if (options.subject === 'explosions') {
            for (const style of ['voxel', 'low-poly'] as const) {
                const p = panel(`${style} explosion · no bloom`, 8);
                p.frame.set(new THREE.Vector3(-2.8, 0, -2.8), new THREE.Vector3(2.8, 4, 2.8));
                const visual = ExplosionVisual.acquire(p.scene, new THREE.Vector3(0, 0.35, 0), { radius: 4, color: 0xff5a12, style, seed: 73 });
                p.tick = time => visual.setProgress(time % 1);
            }
            const p = panel('Impact sparks · both backends', 2);
            p.frame.set(new THREE.Vector3(-1.5, 0, -1.5), new THREE.Vector3(1.5, 3, 1.5));
            const effects = new AttackVFX(p.scene);
            effects.createImpactEffect(new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(0, 1, 0));
            let previous = 0;
            p.tick = time => {
                const t = time % 0.48;
                if (t < previous) { effects.update(1); effects.createImpactEffect(new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(0, 1, 0)); previous = 0; }
                effects.update(t - previous); previous = t;
            };
            p.dispose = () => effects.dispose();
        } else if (options.subject === 'water') {
            for (const block of [true, false]) {
                const p = panel(block ? 'Block coastline · shallow foam' : 'Faceted coastline · depth colour', 60);
                const bed = (x: number, z: number): number => {
                    if (block) { x = Math.floor((x + 45) / 2) * 2 - 44; z = Math.floor((z + 45) / 2) * 2 - 44; }
                    const h = Math.max(-5, 6 - Math.hypot(x + 14, z) * 0.3 + Math.sin(z * 0.22) * 0.8);
                    return block ? Math.floor(h * 2) / 2 : h;
                };
                const terrain = new THREE.PlaneGeometry(90, 90, 90, 90); terrain.rotateX(-Math.PI / 2);
                const positions = terrain.getAttribute('position'), colors = new Float32Array(positions.count * 3), tint = new THREE.Color();
                for (let i = 0; i < positions.count; i++) {
                    const h = bed(positions.getX(i), positions.getZ(i)); positions.setY(i, h);
                    tint.set(h < 2.4 ? '#b9aa7b' : '#617840'); tint.toArray(colors, i * 3);
                }
                terrain.setAttribute('color', new THREE.BufferAttribute(colors, 3)); terrain.computeVertexNormals();
                let land: THREE.Mesh;
                if (block) {
                    terrain.dispose();
                    const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 1, 2), new THREE.MeshStandardMaterial({ roughness: 1 }), 45 * 45);
                    const dummy = new THREE.Object3D(); let index = 0;
                    for (let z = -44; z < 45; z += 2) for (let x = -44; x < 45; x += 2) {
                        const height = bed(x, z);
                        dummy.position.set(x, (height - 8) / 2, z); dummy.scale.set(1, height + 8, 1); dummy.updateMatrix();
                        blocks.setMatrixAt(index, dummy.matrix); blocks.setColorAt(index++, tint.set(height < 2.4 ? '#b9aa7b' : '#617840'));
                    }
                    land = blocks;
                } else land = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
                p.scene.add(land);
                // The standard ground would hide the underwater terrain.
                const floor = p.scene.children.find(child => child instanceof THREE.Mesh && child !== land) as THREE.Mesh;
                floor.visible = false;
                const water = buildWaterSurfaceMesh(1.5, { minX: -45, maxX: 45, minZ: -45, maxZ: 45 }, new THREE.Vector3(-1, 1.5, 0.8), bed);
                const material = createWaterMaterial(undefined, { bathymetry: true });
                (water.material as THREE.Material).dispose(); water.material = material.material;
                water.onBeforeRender = (): void => material.setTime(options.time);
                p.scene.add(water); p.frame.set(new THREE.Vector3(-35, -1, -25), new THREE.Vector3(25, 3, 25));
            }
        } else {
            for (const preset of Object.keys(LIGHTING_PRESETS) as LightingPreset[]) {
                const p = panel(preset, 30); const cfg = resolveLightingConfig({ preset })!;
                const building = forgeMesh(window.visualFixtures.after.buildings[0]!.mesh); add(p, building);
                const sun = p.scene.children.find(child => child instanceof THREE.DirectionalLight) as THREE.DirectionalLight;
                sun.color.set(cfg.sunColor!);
                const luminance = sun.color.r * 0.2126 + sun.color.g * 0.7152 + sun.color.b * 0.0722;
                sun.intensity = 5 / luminance * cfg.sunIntensity!; applySunDirection(sun, cfg); sun.position.multiplyScalar(35);
                p.scene.children.filter(child => child instanceof THREE.HemisphereLight).forEach(child => p.scene.remove(child));
                installAmbientFloorLight(p.scene); applyAmbientFloor(p.scene, cfg);
                p.scene.environmentIntensity = cfg.environmentIntensity!;
                const ground = p.scene.children.find(child => child instanceof THREE.Mesh && child !== building) as THREE.Mesh;
                ground.scale.setScalar(8);
                const fog = LIGHTING_PRESETS[preset].fog;
                p.scene.fog = new THREE.Fog(fog.color!, fog.near!, fog.far!); p.scene.background = new THREE.Color(fog.color!);
                // Repeated distant massing makes aerial separation visible.
                for (let i = 0; i < 4; i++) {
                    const distant = building.clone(); distant.position.set((i % 2 ? -1 : 1) * 16, 0, -30 - i * 30); p.scene.add(distant);
                }
            }
        }
        const columns = panels.length > 4 ? 3 : panels.length === 4 ? 2 : panels.length;
        const rows = Math.ceil(panels.length / columns), w = 1440 / columns, h = 900 / rows;
        document.getElementById('labels')!.replaceChildren(...panels.map((p, i) => {
            const label = document.createElement('span'); label.className = 'label'; label.textContent = p.label;
            label.style.left = `${i % columns * w + 16}px`; label.style.top = `${Math.floor(i / columns) * h + 114}px`; return label;
        }));
    }

    const center = new THREE.Vector3(), size = new THREE.Vector3();
    function render(): void {
        const started = performance.now();
        renderer.setScissorTest(false); renderer.setViewport(0, 0, 1440, 1000); renderer.clear(); renderer.setScissorTest(true); renderer.info.reset();
        const columns = panels.length > 4 ? 3 : panels.length === 4 ? 2 : panels.length;
        const rows = Math.ceil(panels.length / columns), w = 1440 / columns, h = 900 / rows;
        panels.forEach((p, i) => {
            p.tick?.(options.time); p.frame.getCenter(center); p.frame.getSize(size);
            const distance = Math.max(size.y, size.x * h / w, size.z) * (options.near ? 1.25 : 2.3);
            if (options.near && options.subject.includes('building')) center.y = Math.min(center.y, 3.5);
            p.camera.aspect = w / h; p.camera.updateProjectionMatrix();
            const view = options.subject === 'water-checks' ? new THREE.Vector3(0.03, 1, 0.08)
                : new THREE.Vector3(0.75, options.subject === 'water' ? 0.85 : 0.48, 1);
            p.camera.position.copy(center).addScaledVector(view.normalize(), distance);
            p.camera.lookAt(center);
            const x = i % columns * w, row = Math.floor(i / columns);
            const y = gpu ? 100 + row * h : 900 - (row + 1) * h;
            renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.render(p.scene, p.camera);
        });
        renderMs = performance.now() - started;
        document.getElementById('metrics')!.textContent = `${renderer.info.render.triangles.toLocaleString()} triangles · ${gpu ? 'WebGPU' : 'WebGL'} · no post effects`;
    }
    await rebuild();
    window.visualWorkshop = {
        async set(patch): Promise<void> {
            const changed = patch.subject !== undefined && patch.subject !== options.subject || patch.before !== undefined && patch.before !== options.before;
            Object.assign(options, patch);
            for (const id of ['before', 'near']) (document.getElementById(id) as HTMLInputElement).checked = options[id as 'before' | 'near'];
            (document.getElementById('subject') as HTMLSelectElement).value = options.subject;
            (document.getElementById('time') as HTMLInputElement).value = String(options.time);
            if (changed) await rebuild(); render();
        },
        metrics: () => ({ ...options, triangles: renderer.info.render.triangles,
            calls: renderer instanceof WebGPURenderer ? renderer.info.render.drawCalls : renderer.info.render.calls,
            geometries: renderer.info.memory.geometries, cpuRenderMs: renderMs, gpuMs: null }),
        shaders: async () => {
            const p = panels[0]!, water = p.scene.getObjectByName('WaterSurface');
            return renderer instanceof WebGPURenderer && water ? renderer.debug.getShaderAsync(p.scene, p.camera, water) : {};
        },
        waterProbes: () => options.subject !== 'water-checks' ? [] : panels.map((p, i) => {
            const point = new THREE.Vector3([4, 5, 2.4][i]!, 0, 0).project(p.camera);
            return { label: p.label, x: Math.round(i * 480 + (point.x + 1) * 240), y: Math.round(100 + (1 - point.y) * 450) };
        }),
        profile: async () => {
            renderer.setAnimationLoop(null);
            const cpu: number[] = [], gpuTimes: number[] = [];
            const timestampRenderer = renderer instanceof WebGPURenderer && renderer.hasFeature('timestamp-query') ? renderer : null;
            try {
                for (let i = 0; i < 45; i++) {
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                    render();
                    const duration = timestampRenderer ? await timestampRenderer.resolveTimestampsAsync() : undefined;
                    if (i >= 15) { cpu.push(renderMs); if (typeof duration === 'number') gpuTimes.push(duration); }
                }
                const stats = (values: number[]): object | null => {
                    if (!values.length) return null;
                    values.sort((a, b) => a - b);
                    return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * 0.95)] };
                };
                return { subject: options.subject, samples: cpu.length, cpuSubmissionMs: stats(cpu), gpuRenderMs: stats(gpuTimes), ...window.visualWorkshop.metrics() };
            } finally { previous = performance.now(); renderer.setAnimationLoop(animate); }
        },
    };
    document.getElementById('subject')!.addEventListener('change', event => { void window.visualWorkshop.set({ subject: (event.target as HTMLSelectElement).value }); });
    for (const id of ['before', 'near']) document.getElementById(id)!.addEventListener('change', event => { void window.visualWorkshop.set({ [id]: (event.target as HTMLInputElement).checked }); });
    document.getElementById('time')!.addEventListener('input', event => { options.time = Number((event.target as HTMLInputElement).value); });
    document.getElementById('play')!.addEventListener('change', event => { options.playing = (event.target as HTMLInputElement).checked; });
    let previous = performance.now();
    const animate = (): void => { const now = performance.now(); if (options.playing) options.time += (now - previous) / 1000; previous = now; render(); };
    renderer.setAnimationLoop(animate);
}
void start();
