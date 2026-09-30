import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { EngineLike } from 'types/game.js';

const EXCLUDED_NAME_PREFIXES = [
    'PlayerGroup',
    'HeadlessPlayer',
    'BlockCharacter',
    'NpcController',
    'AnimalController_',
    'BoxVehicle',
    'VoxelVehicle',
    'VehiclePlatform',
    'AttackTrailMesh',
    'AttackParticles',
    '__highlight',
    'Projectile',
    'SkeletonAnimal_',
    '__transformControlsPivot__',
    'SpawnPointMarker_',
    'DecalSystem',
    'SlidingParticles',
    'BoxWheel',
    'VoxelWheel',
];

const EXCLUDED_TYPES = [
    'TransformControlsPlane',
    'TransformControlsGizmo',
    'GridHelper',
    'AxesHelper',
];

function isExcludedObject(obj: THREE.Object3D): boolean {
    if ((obj as any).isTransformControls || (obj as any).isTransformControlsRoot) return true;
    if (obj.userData?.isSpawnPointMarker) return true;
    for (const t of EXCLUDED_TYPES) {
        if (obj.type === t) return true;
    }
    if (obj.name) {
        for (const prefix of EXCLUDED_NAME_PREFIXES) {
            if (obj.name.startsWith(prefix)) return true;
        }
    }
    return false;
}

function isDynamic(obj: THREE.Object3D): boolean {
    if ((obj as any).userData?.isDynamic) return true;
    if ((obj as any).userData?.isVehicle) return true;
    return false;
}

function isSplatMesh(obj: THREE.Object3D): boolean {
    const ctor = (obj as any).constructor?.name;
    return ctor === 'SplatMesh';
}

function isDebugOrLayer1(obj: THREE.Object3D): boolean {
    return obj.layers.mask === 2;
}

function collectStaticObjects(scene: THREE.Scene): THREE.Object3D[] {
    const roots: THREE.Object3D[] = [];

    for (const child of scene.children) {
        if (isExcludedObject(child)) continue;
        if (isDynamic(child)) continue;
        if (isSplatMesh(child)) continue;
        if (isDebugOrLayer1(child)) continue;

        if (containsMesh(child)) {
            roots.push(child);
        }
    }

    return roots;
}

function containsMesh(obj: THREE.Object3D): boolean {
    if ((obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) return true;
    for (const child of obj.children) {
        if (containsMesh(child)) return true;
    }
    return false;
}

/**
 * Remove Points and Line objects from a cloned tree.
 * These are particle/VFX systems that render as lines-to-origin in Blender.
 */
function removeNonMeshObjects(root: THREE.Object3D): void {
    const toRemove: THREE.Object3D[] = [];
    root.traverse(obj => {
        if ((obj as THREE.Points).isPoints ||
            (obj as THREE.Line).isLine ||
            (obj as THREE.LineSegments).isLineSegments) {
            toRemove.push(obj);
        }
    });
    for (const obj of toRemove) {
        obj.removeFromParent();
    }
}

function stripUserData(root: THREE.Object3D): () => void {
    const saved = new Map<THREE.Object3D, Record<string, unknown>>();
    root.traverse(obj => {
        if (obj.userData && Object.keys(obj.userData).length > 0) {
            saved.set(obj, obj.userData);
            obj.userData = {};
        }
    });
    return () => {
        for (const [obj, data] of saved) {
            obj.userData = data;
        }
    };
}

/**
 * Export the current scene's static geometry to a GLB blob.
 */
export async function exportSceneAsGLB(engine: EngineLike): Promise<Blob> {
    if (!engine.scene) {
        throw new Error('No scene available for export');
    }

    const staticObjects = collectStaticObjects(engine.scene);
    if (staticObjects.length === 0) {
        throw new Error('No exportable static objects found in scene');
    }

    console.log(`[SceneExporter] Exporting ${staticObjects.length} static root objects as GLB...`);

    const exportScene = new THREE.Scene();
    exportScene.name = 'ExportedScene';

    if (engine.scene.environment) {
        exportScene.environment = engine.scene.environment;
    }

    for (const obj of staticObjects) {
        const restore = stripUserData(obj);
        try {
            const clone = obj.clone(true);
            removeNonMeshObjects(clone);
            exportScene.add(clone);
        } finally {
            restore();
        }
    }

    const exporter = new GLTFExporter();
    const glb = await exporter.parseAsync(exportScene, { binary: true, onlyVisible: false });
    const blob = new Blob([glb as ArrayBuffer], { type: 'model/gltf-binary' });

    console.log(`[SceneExporter] GLB export complete: ${(blob.size / (1024 * 1024)).toFixed(1)} MB`);
    return blob;
}

/**
 * Export the scene and trigger a browser download.
 */
export async function downloadSceneGLB(engine: EngineLike): Promise<void> {
    const blob = await exportSceneAsGLB(engine);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scene-export-${Date.now()}.glb`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
