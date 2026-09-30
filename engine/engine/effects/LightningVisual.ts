import * as THREE from 'three';
import { updateEffectAttribute, effectRandom, effectNumber, effectPosition, effectDensity, EFFECT_UP, type VFXQuality, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type BeamPreset = 'laser' | 'energy-beam' | 'ion' | 'railgun' | 'healing-link' | 'tractor-beam';
export type LightningPreset = 'lightning' | 'tesla' | 'chain' | 'storm' | BeamPreset;
export interface LightningRecipe {
    color: number;
    width: number;
    displacement: number;
    branches: number;
    flicker: number;
    duration: number;
    shape?: 'jagged' | 'straight' | 'helix' | 'wave';
}
export const LIGHTNING_PRESETS: Readonly<Record<LightningPreset, Readonly<LightningRecipe>>> = {
    lightning: { color: 0x88baff, width: 0.035, displacement: 0.12, branches: 3, flicker: 1, duration: 0.45 },
    tesla: { color: 0xc48cff, width: 0.025, displacement: 0.19, branches: 6, flicker: 0.6, duration: 0.85 },
    chain: { color: 0x7cf6ed, width: 0.028, displacement: 0.1, branches: 2, flicker: 0.8, duration: 0.65 },
    laser: { color: 0xff4f68, width: 0.022, displacement: 0, branches: 0, flicker: 0, duration: 0.25, shape: 'straight' },
    'energy-beam': { color: 0x59dfff, width: 0.075, displacement: 0.035, branches: 0, flicker: 0.1, duration: 0.8, shape: 'helix' },
    storm: { color: 0xb8caff, width: 0.06, displacement: 0.23, branches: 6, flicker: 1, duration: 1.1 },
    ion: { color: 0x98ffa9, width: 0.026, displacement: 0.018, branches: 0, flicker: 0.25, duration: 0.55, shape: 'helix' },
    railgun: { color: 0xffbc70, width: 0.045, displacement: 0, branches: 0, flicker: 0, duration: 0.4, shape: 'straight' },
    'healing-link': { color: 0x7affc7, width: 0.035, displacement: 0.085, branches: 0, flicker: 0, duration: 1.3, shape: 'wave' },
    'tractor-beam': { color: 0xa5a0ff, width: 0.045, displacement: 0.13, branches: 0, flicker: 0, duration: 1.4, shape: 'helix' },
};
export interface LightningOptions {
    /** Continuous-beam playback keeps the carrier visible between pulses. */
    sustained?: boolean;
    preset: LightningPreset;
    color: number;
    width: number;
    duration: number;
    amount: number;
    variance: number;
    seed: number;
    style: VFXStyle;
    quality: VFXQuality;
    /** Multiplier on the preset's transverse displacement. */
    roughness: number;
    /** -1 uses the preset; otherwise 0–6 per span. */
    branches: number;
    layers: { core: boolean; glow: boolean; endpoints: boolean };
}
export const DEFAULT_LIGHTNING_OPTIONS: LightningOptions = {
    preset: 'lightning', color: 0x88baff, width: 0.035, duration: 0.45, amount: 1, variance: 0.7,
    seed: 73, style: 'voxel', quality: 'high', roughness: 1, branches: -1, layers: { core: true, glow: true, endpoints: true },
};
const CAPACITY = 1024;

/** Anchored, branching volumetric arcs. No hardware lines, screen-space width or custom shader. */
export class LightningVisual {
    readonly group = new THREE.Group();
    private readonly core: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly glow: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly endpoints: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly bases = new Float32Array(CAPACITY * 3);
    private readonly offsets = new Float32Array(CAPACITY * 3);
    private readonly transverseOffsets = new Float32Array(CAPACITY * 3);
    private readonly positions = new Float32Array(CAPACITY * 3);
    private readonly phases = new Float32Array(CAPACITY);
    private readonly starts = new Uint16Array(CAPACITY);
    private readonly ends = new Uint16Array(CAPACITY);
    private readonly widths = new Float32Array(CAPACITY);
    private readonly distances = new Float32Array(CAPACITY);
    private readonly anchors: THREE.Vector3[] = [];
    private readonly branchOrigin = new THREE.Vector3();
    private readonly direction = new THREE.Vector3();
    private readonly side = new THREE.Vector3();
    private readonly up = new THREE.Vector3();
    private readonly origin = new THREE.Vector3();
    private readonly target = new THREE.Vector3();
    private readonly point = new THREE.Vector3();
    private readonly offset = new THREE.Vector3();
    private readonly a = new THREE.Vector3();
    private readonly b = new THREE.Vector3();
    private readonly dummy = new THREE.Object3D();
    private lastProgress = NaN;
    private pathPointCount = 0;
    private readonly white = new THREE.Color(0xffffff);
    private nodeCount = 0;
    private segmentCount = 0;
    private options = DEFAULT_LIGHTNING_OPTIONS;
    private recipe: Readonly<LightningRecipe> = LIGHTNING_PRESETS.lightning;
    private disposed = false;

    constructor(scene: THREE.Scene, readonly style: VFXStyle) {
        const geometry = style === 'voxel' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, false);
        this.core = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ toneMapped: false }), CAPACITY);
        this.glow = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, toneMapped: false }), CAPACITY);
        this.endpoints = new THREE.InstancedMesh(style === 'voxel' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.IcosahedronGeometry(0.65, 1),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), 9);
        this.core.name = 'Lightning:core'; this.glow.name = 'Lightning:glow'; this.endpoints.name = 'Lightning:endpoints';
        for (const mesh of [this.core, this.glow, this.endpoints]) {
            mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.layers.enable(1);
        }
        this.group.add(this.core, this.glow, this.endpoints);
        this.group.visible = false;
        scene.add(this.group);
    }

    rearm(points: readonly THREE.Vector3[], options: LightningOptions): void {
        if (this.disposed) throw new Error('LightningVisual is disposed');
        if (points.length < 2 || points.length > 9) throw new Error('Lightning needs 2–9 path points');
        points.forEach(effectPosition);
        const recipe = LIGHTNING_PRESETS[options.preset];
        if (!Object.prototype.hasOwnProperty.call(LIGHTNING_PRESETS, options.preset)) throw new Error(`Unknown lightning preset: ${options.preset}`);
        this.recipe = recipe;
        this.options = { ...options, width: effectNumber(options.width, 'width', 0.001, 10),
            amount: effectNumber(options.amount, 'amount', 0, 3), variance: effectNumber(options.variance, 'variance', 0, 1),
            roughness: effectNumber(options.roughness, 'roughness', 0, 3), layers: { ...options.layers } };
        this.core.material.color.set(options.color).lerp(this.white, 0.8).multiplyScalar(1.8);
        this.glow.material.color.set(options.color); this.endpoints.material.color.copy(this.core.material.color);
        this.group.name = `Lightning:${options.preset}`;
        this.buildPath(points); this.setProgress(0);
    }

    /** Retargets existing instance buffers; never creates geometry or materials. */
    moveEndpoints(points: readonly THREE.Vector3[], progress = 0): void {
        if (this.disposed) throw new Error('LightningVisual is disposed');
        if (points.length < 2 || points.length > 9) throw new Error('Lightning needs 2–9 path points');
        let changed = points.length !== this.pathPointCount;
        for (let i = 0; i < points.length; i++) {
            effectPosition(points[i]!);
            if (!this.anchors[i]?.equals(points[i]!)) changed = true;
        }
        if (changed) this.buildPath(points);
        this.setProgress(progress);
    }

    private buildPath(points: readonly THREE.Vector3[]): void {
        const options = this.options, recipe = this.recipe;
        this.lastProgress = NaN; this.pathPointCount = points.length;
        const density = effectDensity(options.quality);
        // Curved beams need enough samples per turn to keep their authored silhouette at close range.
        // 96 steps + 30 branch nodes across eight spans still fits the fixed 1024-node budget.
        const steps = options.preset === 'laser' ? 1 : recipe.shape === 'helix' ? Math.round(32 + 64 * density)
            : recipe.shape === 'wave' ? Math.round(24 + 40 * density) : Math.round(12 + 20 * density);
        const branches = Math.min(6, Math.round((options.branches < 0 ? recipe.branches : effectNumber(options.branches, 'branches', 0, 6)) * density * this.options.amount));
        for (let i = 0; i < points.length; i++) {
            if (!this.anchors[i]) this.anchors[i] = new THREE.Vector3();
            this.anchors[i]!.copy(points[i]!);
        }
        this.nodeCount = 0; this.segmentCount = 0;
        const random = effectRandom(options.seed);
        for (let span = 0; span < points.length - 1; span++) {
            this.origin.copy(points[span]!); this.target.copy(points[span + 1]!);
            this.direction.subVectors(this.target, this.origin);
            const length = this.direction.length();
            if (length < 1e-6) continue;
            this.direction.divideScalar(length);
            this.side.set(Math.abs(this.direction.y) > 0.9 ? 1 : 0, Math.abs(this.direction.y) > 0.9 ? 0 : 1, 0).cross(this.direction).normalize();
            this.up.crossVectors(this.direction, this.side).normalize();
            const first = this.nodeCount;
            const bendPhase = random() * Math.PI * 2, bendPhase2 = random() * Math.PI * 2;
            const displacement = Math.min(length, 12) * recipe.displacement * this.options.roughness;
            for (let i = 0; i <= steps; i++) {
                const u = i / steps;
                this.point.lerpVectors(this.origin, this.target, u);
                const envelope = Math.sin(Math.PI * u);
                this.a.setScalar(0);
                if (recipe.shape === 'helix') {
                    const theta = u * Math.PI * (options.preset === 'ion' ? 12 : 8);
                    const radius = displacement * envelope * (options.preset === 'tractor-beam' ? 0.2 + u * 1.8 : 1);
                    this.offset.copy(this.side).multiplyScalar(Math.cos(theta) * radius).addScaledVector(this.up, Math.sin(theta) * radius);
                    this.a.copy(this.side).multiplyScalar(-Math.sin(theta) * radius).addScaledVector(this.up, Math.cos(theta) * radius);
                } else if (recipe.shape === 'wave') {
                    this.offset.copy(this.side).multiplyScalar(Math.sin(u * Math.PI * 4) * displacement * envelope);
                    this.a.copy(this.side).multiplyScalar(Math.cos(u * Math.PI * 4) * displacement * envelope);
                } else {
                    const lateral = Math.sin(u * 9 + bendPhase) * 0.6 + (random() - 0.5) * this.options.variance * 0.65;
                    const vertical = Math.sin(u * 13 + bendPhase2) * 0.5 + (random() - 0.5) * this.options.variance * 0.65;
                    this.offset.copy(this.side).multiplyScalar(lateral * displacement * envelope)
                        .addScaledVector(this.up, vertical * displacement * envelope);
                }
                // Exact source/target contact; no floating tip or frame-dependent endpoint drift.
                if (i === 0 || i === steps) { this.offset.setScalar(0); this.a.setScalar(0); }
                const node = this.addNode(this.point, this.offset, random() * Math.PI * 2);
                this.a.toArray(this.transverseOffsets, node * 3);
                if (i > 0) this.addSegment(first + i - 1, first + i, options.preset === 'tractor-beam' ? 0.5 + u * 1.5 : 1, (i - 0.5) / steps);
            }
            for (let branch = 0; branch < branches; branch++) {
                const root = first + 1 + Math.floor(random() * Math.max(1, steps - 2));
                this.point.fromArray(this.bases, root * 3).add(this.offset.fromArray(this.offsets, root * 3));
                const angle = random() * Math.PI * 2;
                const branchLength = length * (0.12 + random() * 0.2);
                this.offset.copy(this.side).multiplyScalar(Math.cos(angle)).addScaledVector(this.up, Math.sin(angle))
                    .addScaledVector(this.direction, 0.5).normalize().multiplyScalar(branchLength);
                let previous = root;
                const branchOrigin = this.branchOrigin.copy(this.point);
                for (let j = 1; j <= 5; j++) {
                    this.point.copy(branchOrigin).addScaledVector(this.offset, j / 5);
                    this.a.copy(this.side).multiplyScalar((random() - 0.5) * displacement * 0.5);
                    const index = this.addNode(this.point, this.a, random() * Math.PI * 2);
                    this.addSegment(previous, index, (1 - j / 6) * 0.55); previous = index;
                }
            }
        }
        this.core.count = this.glow.count = this.options.amount === 0 ? 0 : this.segmentCount;
        this.endpoints.count = this.options.amount === 0 || this.segmentCount === 0 ? 0 : points.length;
    }

    private addNode(position: THREE.Vector3, offset: THREE.Vector3, phase: number): number {
        if (this.nodeCount >= CAPACITY) throw new Error('Lightning node budget exceeded');
        const index = this.nodeCount++;
        position.toArray(this.bases, index * 3); offset.toArray(this.offsets, index * 3); this.phases[index] = phase;
        this.transverseOffsets.fill(0, index * 3, index * 3 + 3);
        return index;
    }
    private addSegment(start: number, end: number, width: number, distance = 0): void {
        if (this.segmentCount >= CAPACITY) throw new Error('Lightning segment budget exceeded');
        this.starts[this.segmentCount] = start; this.ends[this.segmentCount] = end;
        this.distances[this.segmentCount] = distance; this.widths[this.segmentCount++] = width;
    }

    setProgress(progress: number): void {
        if (this.disposed) return;
        const o = this.options, value = effectNumber(progress, 'progress', 0, Number.MAX_SAFE_INTEGER);
        const t = o.sustained ? value % 1 : Math.min(1, value);
        if (t === this.lastProgress) return;
        this.lastProgress = t;
        this.group.visible = o.sustained === true || t < 1;
        // Continuous flicker and three return strokes. Never regenerate a random path every frame.
        const strokes = Math.exp(-t * 8) + 0.6 * Math.exp(-Math.pow((t - 0.28) / 0.055, 2)) + 0.35 * Math.exp(-Math.pow((t - 0.56) / 0.065, 2));
        const envelope = (1 - this.recipe.flicker) * Math.sin(Math.PI * Math.min(1, t + 0.08)) + this.recipe.flicker * (0.18 + strokes * 0.65);
        const fade = o.sustained ? 0.85 + Math.sin(t * Math.PI * 2) * 0.15 : (1 - THREE.MathUtils.smoothstep(t, 0.65, 1)) * Math.min(1, envelope);
        const rotating = this.recipe.shape === 'helix' || this.recipe.shape === 'wave', turn = t * Math.PI * 2;
        for (let i = 0; i < this.nodeCount; i++) {
            const pulse = rotating ? Math.cos(turn) : 1 + Math.sin(t * 38 + this.phases[i]!) * o.variance * 0.18;
            for (let axis = 0; axis < 3; axis++) {
                const k = i * 3 + axis;
                this.positions[k] = this.bases[k]! + this.offsets[k]! * pulse + (rotating ? this.transverseOffsets[k]! * Math.sin(turn) : 0);
            }
        }
        const d = this.dummy;
        for (let i = 0; i < this.core.count; i++) {
            this.a.fromArray(this.positions, this.starts[i]! * 3); this.b.fromArray(this.positions, this.ends[i]! * 3);
            this.direction.subVectors(this.b, this.a);
            const length = this.direction.length();
            d.position.copy(this.a).add(this.b).multiplyScalar(0.5);
            d.quaternion.identity();
            if (length > 1e-8) d.quaternion.setFromUnitVectors(EFFECT_UP, this.direction.divideScalar(length));
            const pulseWidth = o.preset === 'railgun' ? 0.35 + 2 * Math.exp(-Math.pow((this.distances[i]! - t * 1.4) / 0.16, 2)) : 1;
            const width = o.width * this.widths[i]! * pulseWidth * (0.3 + fade * 0.7) * (o.sustained ? 1 : 1 - THREE.MathUtils.smoothstep(t, 0.8, 1));
            d.scale.set(width, length * 1.025, width); d.updateMatrix(); this.core.setMatrixAt(i, d.matrix);
            d.scale.set(width * 3.5, length * 1.04, width * 3.5); d.updateMatrix(); this.glow.setMatrixAt(i, d.matrix);
        }
        this.core.visible = o.layers.core; this.glow.visible = o.layers.glow; this.endpoints.visible = o.layers.endpoints;
        this.glow.material.opacity = fade * 0.22;
        this.endpoints.material.opacity = fade * 0.75;
        for (let i = 0; i < this.endpoints.count; i++) {
            d.position.copy(this.anchors[i]!); d.quaternion.identity(); d.scale.setScalar(o.width * (2.5 + 2 * fade));
            d.updateMatrix(); this.endpoints.setMatrixAt(i, d.matrix);
        }
        for (const mesh of [this.core, this.glow, this.endpoints]) updateEffectAttribute(mesh.instanceMatrix, mesh.count);
    }

    retire(): void { this.group.visible = false; this.lastProgress = NaN; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.group.removeFromParent(); this.core.geometry.dispose(); this.endpoints.geometry.dispose();
        for (const mesh of [this.core, this.glow, this.endpoints]) { mesh.material.dispose(); mesh.dispose(); }
    }
}
