/** Standalone inspection surface, bundled by scripts/preview-weapons.mjs. */
import * as THREE from 'three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { WebGPURenderer } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createWeaponMesh, WeaponType } from 'engine/WeaponRegistry.js';
import { createRangedWeaponMesh, RangedWeaponType } from 'engine/RangedWeaponRegistry.js';
import { setMaterialQuality, type MaterialQuality } from 'engine/MaterialQuality.js';
import { clampWeaponPartMaterialsToDirect } from 'engine/WeaponPartMaterial.js';

type Mode = 'materials' | 'silhouette' | 'normals' | 'wireframe' | 'anchors';
interface PreviewOptions { id: string; mode: Mode; quality: MaterialQuality; view: 'near' | 'design' | 'far'; angle: number; firstPerson: boolean }
interface PreviewMetrics { triangles: number; calls: number; geometries: number; cpuRenderMs: number; backend: string }
declare global {
    interface Window {
        weaponPreview: { set: (patch: Partial<PreviewOptions>) => void; metrics: () => PreviewMetrics };
    }
}

async function start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const gpu = params.get('backend') === 'webgpu';
    const renderer = gpu ? new WebGPURenderer({ antialias: true }) : new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (renderer instanceof WebGPURenderer) await renderer.init();
    renderer.setPixelRatio(1);
    renderer.setSize(1440, 960);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.autoClear = false;
    document.getElementById('stage')!.appendChild(renderer.domElement);
    const pmrem = gpu ? null : new THREE.PMREMGenerator(renderer as WebGLRenderer);
    const room = new RoomEnvironment();
    const environment = pmrem?.fromScene(room, 0.04) ?? null;
    room.dispose();
    const scenes: { scene: THREE.Scene; camera: THREE.PerspectiveCamera }[] = [];
    const options: PreviewOptions = { id: 'sword', mode: 'materials', quality: 'medium', view: 'design', angle: 0.28, firstPerson: false };
    let cpuRenderMs = 0;
    const drawCalls = (): number => renderer instanceof WebGPURenderer ? renderer.info.render.drawCalls : renderer.info.render.calls;

    function render(): void {
        const startTime = performance.now();
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, 1440, 960);
        renderer.setClearColor(0x181818);
        renderer.clear();
        renderer.setScissorTest(true);
        const cols = options.id.startsWith('all-') ? 6 : 2;
        const rows = Math.ceil(scenes.length / cols);
        const width = 1440 / cols, height = 860 / rows;
        renderer.info.reset();
        renderer.info.autoReset = false;
        scenes.forEach(({ scene, camera }, i) => {
            const x = (i % cols) * width;
            // WebGPU's canvas viewport origin is top-left; WebGL's is bottom-left.
            const y = gpu ? 100 + Math.floor(i / cols) * height : 960 - 100 - (Math.floor(i / cols) + 1) * height;
            renderer.setViewport(x, y, width, height);
            renderer.setScissor(x, y, width, height);
            renderer.render(scene, camera);
        });
        cpuRenderMs = performance.now() - startTime;
        document.getElementById('metrics')!.textContent = `${renderer.info.render.triangles.toLocaleString()} triangles · ${drawCalls()} draws · ${options.quality} materials · ${gpu ? 'WebGPU' : 'WebGL'} · no post effects`;
    }

    function rebuild(): void {
        for (const { scene } of scenes) scene.traverse(child => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                (Array.isArray(child.material) ? child.material : [child.material]).forEach((material: THREE.Material) => material.dispose());
            }
        });
        scenes.length = 0;
        setMaterialQuality(options.quality);
        const ids = options.id === 'all-melee' ? Object.values(WeaponType) : options.id === 'all-ranged' ? Object.values(RangedWeaponType) : [options.id];
        const entries = ids.flatMap(id => [{ id, lowpoly: false }, { id, lowpoly: true }]);
        const cols = options.id.startsWith('all-') ? 6 : 2;
        const rows = Math.ceil(entries.length / cols);
        const labels = document.getElementById('labels')!;
        labels.replaceChildren();
        labels.className = cols === 6 ? 'catalog' : 'pair';
        entries.forEach(({ id, lowpoly }) => {
            const type = lowpoly ? `${id}_lowpoly` : id;
            const ranged = Object.values(RangedWeaponType).some(value => value === id);
            const result = ranged ? createRangedWeaponMesh(type) : createWeaponMesh(type);
            const root = result.mesh;
            root.position.set(0, 0, 0);
            if (options.firstPerson) clampWeaponPartMaterialsToDirect(root);
            root.traverse(child => {
                if (!(child instanceof THREE.Mesh)) return;
                if (options.mode === 'materials' || options.mode === 'anchors') return;
                const previous: THREE.Material = child.material as THREE.Material;
                child.material = options.mode === 'normals' ? new THREE.MeshNormalMaterial()
                    : new THREE.MeshBasicMaterial({ color: options.mode === 'wireframe' ? 0xa0dab9 : 0xcbcbcb, wireframe: options.mode === 'wireframe' });
                previous.dispose();
            });
            if (options.mode === 'anchors') {
                const anchors: THREE.Vector3[] = 'config' in result ? [result.config.hiltOffset, result.config.tipOffset]
                    : [result.preset.muzzleOffset, ...(result.foregrip ? [result.foregrip] : [])];
                for (const point of anchors) {
                    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(ranged ? 0.012 : 0.035), new THREE.MeshBasicMaterial({ color: 0xe0218a, depthTest: false }));
                    marker.position.copy(point); root.add(marker);
                }
            }
            const bounds = new THREE.Box3().setFromObject(root);
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            root.position.sub(center);
            const pivot = new THREE.Group(); pivot.add(root);
            const aspect = (1440 / cols) / (860 / rows);
            const fit = Math.max(size.y, (size.z + size.x) / aspect);
            const distance = fit * (options.view === 'near' ? 1.65 : options.view === 'far' ? 4.3 : 2.3);
            const camera = new THREE.PerspectiveCamera(35, aspect, 0.001, 100);
            // Ranged shows the side and open bore; melee shows the broad blade and its thickness.
            camera.position.set(Math.cos(options.angle) * distance, distance * 0.22, Math.sin(options.angle) * distance);
            camera.lookAt(0, 0, 0);
            const scene = new THREE.Scene();
            scene.environment = options.firstPerson ? null : environment?.texture ?? null;
            scene.add(pivot, new THREE.HemisphereLight(0xdce9ff, 0x70513c, 0.8));
            const key = new THREE.DirectionalLight(0xffeddb, 2); key.position.set(3, 5, 2); scene.add(key);
            const fill = new THREE.DirectionalLight(0xb3d7ff, 0.8); fill.position.set(-3, 2, -2); scene.add(fill);
            scenes.push({ scene, camera });
            const label = document.createElement('div'); label.textContent = `${id.replace(/_/g, ' ')} / ${lowpoly ? 'LOWPOLY' : 'BLOCK'}`; labels.appendChild(label);
        });
        (document.getElementById('weapon') as HTMLSelectElement).value = options.id;
        for (const key of ['mode', 'quality', 'view'] as const) (document.getElementById(key) as HTMLSelectElement).value = options[key];
        (document.getElementById('angle') as HTMLInputElement).value = String(options.angle);
        (document.getElementById('first-person') as HTMLInputElement).checked = options.firstPerson;
        render();
    }
    window.weaponPreview = {
        set(patch) { Object.assign(options, patch); rebuild(); },
        metrics: () => ({ triangles: renderer.info.render.triangles, calls: drawCalls(),
            geometries: renderer.info.memory.geometries, cpuRenderMs, backend: gpu ? 'webgpu' : 'webgl' }),
    };
    const select = document.getElementById('weapon') as HTMLSelectElement;
    for (const id of ['all-melee', 'all-ranged', ...Object.values(WeaponType), ...Object.values(RangedWeaponType)]) {
        const option = document.createElement('option'); option.value = id; option.textContent = id; select.appendChild(option);
    }
    select.value = options.id;
    select.onchange = () => window.weaponPreview.set({ id: select.value });
    for (const key of ['mode', 'quality', 'view'] as const) {
        const element = document.getElementById(key) as HTMLSelectElement;
        element.onchange = () => window.weaponPreview.set({ [key]: element.value });
    }
    (document.getElementById('angle') as HTMLInputElement).oninput = event => window.weaponPreview.set({ angle: Number((event.target as HTMLInputElement).value) });
    (document.getElementById('first-person') as HTMLInputElement).onchange = event => window.weaponPreview.set({ firstPerson: (event.target as HTMLInputElement).checked });
    rebuild();
    // WebGPU canvas contents are transient after presentation. Keep submitting
    // the fixed scene so screenshots and the interactive gallery retain it.
    void renderer.setAnimationLoop(render);
}

void start().catch(error => { document.getElementById('metrics')!.textContent = String(error); throw error; });
