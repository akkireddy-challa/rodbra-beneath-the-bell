import * as THREE from 'three';
import { effectNumber, effectDensity, effectPosition, type VFXStyle, type VFXQuality } from 'engine/effects/VFXUtils.js';

export type EffectTarget = THREE.Vector3 | THREE.Object3D;
export interface EffectShapeOptions {
    radius: number;
    color: number;
    amount: number;
    variance: number;
    seed: number;
    style: VFXStyle;
    quality: VFXQuality;
    direction: THREE.Vector3;
    /** Seconds; zero keeps a persistent effect alive until stopped. */
    duration: number;
}
export const DEFAULT_EFFECT_SHAPE_OPTIONS: EffectShapeOptions = {
    radius: 1, color: 0x68bfff, amount: 1, variance: 0.7, seed: 73,
    style: 'voxel', quality: 'medium', direction: new THREE.Vector3(0, 1, 0), duration: 0,
};
export function resolveShape(options: EffectShapeOptions): EffectShapeOptions {
    effectDensity(options.quality); effectPosition(options.direction);
    if (options.style !== 'voxel' && options.style !== 'low-poly') throw new Error(`Unknown VFX style: ${options.style}`);
    return { ...options, radius: effectNumber(options.radius, 'radius', 0.01, 1000),
        amount: effectNumber(options.amount, 'amount', 0, 3), variance: effectNumber(options.variance, 'variance', 0, 1),
        seed: effectNumber(options.seed, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        duration: effectNumber(options.duration, 'duration', 0, 86400), direction: options.direction.clone() };
}
export function readEffectTarget(target: EffectTarget, out: THREE.Vector3): THREE.Vector3 {
    if (target instanceof THREE.Object3D) { target.updateWorldMatrix(true, false); target.getWorldPosition(out); }
    else out.copy(target);
    effectPosition(out); return out;
}
export function namedRecipe<K extends string, T>(catalog: Readonly<Record<K, T>>, preset: K): T {
    if (!Object.prototype.hasOwnProperty.call(catalog, preset)) throw new Error(`Unknown VFX preset: ${preset}`);
    return catalog[preset];
}
export function effectInstances<M extends THREE.Material>(geometry: THREE.BufferGeometry, material: M, capacity: number, name: string): THREE.InstancedMesh<THREE.BufferGeometry, M> {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = 0;
    return mesh;
}
/** All children are effect-owned. Game targets are never parented here. */
export abstract class EffectShape {
    readonly group = new THREE.Group();
    protected disposed = false;
    protected readonly dummy = new THREE.Object3D();
    protected readonly color = new THREE.Color();
    constructor(scene: THREE.Scene, name: string) { this.group.name = name; this.group.visible = false; scene.add(this.group); }
    protected assertLive(): void { if (this.disposed) throw new Error(`${this.group.name} is disposed`); }
    moveTo(position: THREE.Vector3): void { effectPosition(position); this.group.position.copy(position); }
    abstract setProgress(progress: number): void;
    retire(): void { this.group.visible = false; }
    dispose(): void {
        if (this.disposed) return;
        this.retire(); this.disposed = true; this.group.removeFromParent();
        const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
        this.group.traverse(child => {
            if (!(child instanceof THREE.Mesh)) return;
            geometries.add(child.geometry);
            for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
            if (child instanceof THREE.InstancedMesh) child.dispose();
        });
        geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    }
}
