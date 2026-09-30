import * as THREE from 'three';
import { EffectShape, effectInstances, namedRecipe, resolveShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { updateEffectAttribute, effectGeometry, effectNumber, effectPosition, effectDensity, EFFECT_UP, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type TrailPreset = 'missile' | 'smoke-trail' | 'sword' | 'magic-trail' | 'ribbon';
export const TRAIL_PRESETS = {
    missile: { color: 0xffb25c, width: 0.12, lifetime: 0.45 },
    'smoke-trail': { color: 0x899099, width: 0.5, lifetime: 1.8 },
    sword: { color: 0xc5edff, width: 0.28, lifetime: 0.3 },
    'magic-trail': { color: 0xbd81ff, width: 0.22, lifetime: 0.85 },
    ribbon: { color: 0xff6f9f, width: 0.35, lifetime: 1.5 },
} satisfies Record<TrailPreset, { color: number; width: number; lifetime: number }>;
export interface TrailOptions extends EffectShapeOptions { width: number; lifetime: number; teleportDistance: number }
export const DEFAULT_TRAIL_OPTIONS: TrailOptions = { ...DEFAULT_EFFECT_SHAPE_OPTIONS, width: 0.12, lifetime: 0.8, teleportDistance: 8 };
const CAPACITY = 96;

/** Two crossing ribbons keep a moving trail visible from arbitrary camera directions. */
export class RibbonTrailVisual extends EffectShape {
    private readonly geometry = new THREE.BufferGeometry();
    private readonly mesh;
    private readonly baseColor = new THREE.Color();
    private readonly smoke;
    private preset: TrailPreset = 'missile';
    private readonly positions = new Float32Array(CAPACITY * 4 * 3);
    private readonly colors = new Float32Array(CAPACITY * 4 * 4);
    private readonly history = new Float32Array(CAPACITY * 3);
    private readonly births = new Float64Array(CAPACITY);
    private readonly lastInput = new THREE.Vector3();
    private readonly point = new THREE.Vector3();
    private readonly tangent = new THREE.Vector3();
    private readonly side = new THREE.Vector3();
    private readonly across = new THREE.Vector3();
    private options = DEFAULT_TRAIL_OPTIONS;
    private count = 0;
    private time = 0;
    private lastIndex = 0;
    private emitting = true;
    private interval = 1 / 40;
    constructor(scene: THREE.Scene, style: VFXStyle = 'voxel') {
        super(scene, 'Trail');
        this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
        const indices: number[] = [];
        for (let i = 0; i < CAPACITY - 1; i++) for (let plane = 0; plane < 2; plane++) {
            const a = i * 4 + plane * 2, b = a + 4; indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
        this.geometry.setIndex(indices); this.geometry.setDrawRange(0, 0);
        this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
            transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
        this.mesh.name = 'Trail:mesh'; this.mesh.frustumCulled = false; this.group.add(this.mesh);
        this.smoke = effectInstances(effectGeometry(style), new THREE.MeshLambertMaterial({ color: 0x899099, flatShading: true }), CAPACITY, 'Trail:smoke');
        this.group.add(this.smoke);
    }
    rearm(preset: TrailPreset, position: THREE.Vector3, options: TrailOptions): void {
        this.assertLive(); namedRecipe(TRAIL_PRESETS, preset); effectPosition(position); this.preset = preset;
        this.options = { ...resolveShape(options), width: effectNumber(options.width, 'trail width', 0.001, 100),
            lifetime: effectNumber(options.lifetime, 'trail lifetime', 0.05, 10), teleportDistance: effectNumber(options.teleportDistance, 'teleport distance', 0.01, 10000) };
        this.interval = this.options.lifetime / Math.round(32 + 60 * effectDensity(options.quality));
        this.time = 0; this.count = 0; this.lastIndex = 0; this.emitting = true; this.lastInput.copy(position);
        this.group.name = `Trail:${preset}`; this.mesh.layers.set(0); if (preset !== 'smoke-trail') this.mesh.layers.enable(1);
        this.mesh.visible = preset !== 'smoke-trail'; this.smoke.visible = preset === 'smoke-trail'; this.smoke.material.color.set(options.color); this.baseColor.set(options.color);
        this.push(position, 0); this.setProgress(0);
    }
    private push(point: THREE.Vector3, birth: number): void {
        if (this.count === CAPACITY) { this.history.copyWithin(0, 3); this.births.copyWithin(0, 1); this.count--; }
        point.toArray(this.history, this.count * 3); this.births[this.count++] = birth;
    }
    advance(dt: number, position: THREE.Vector3): void {
        effectPosition(position); const before = this.time;
        this.time += effectNumber(dt, 'deltaTime', 0, Number.MAX_SAFE_INTEGER);
        const latest = Math.floor((this.time + 1e-10) / this.interval);
        if (position.distanceTo(this.lastInput) > this.options.teleportDistance) {
            this.count = 0; this.lastIndex = latest;
            if (this.emitting) this.push(position, this.time);
        } else if (this.emitting && dt > 0) {
            for (let i = Math.max(this.lastIndex + 1, latest - CAPACITY + 2); i <= latest; i++) {
                const birth = i * this.interval;
                this.point.lerpVectors(this.lastInput, position, THREE.MathUtils.clamp((birth - before) / dt, 0, 1));
                this.push(this.point, birth);
            }
        }
        this.lastIndex = latest; this.lastInput.copy(position);
        let expired = 0;
        while (expired < this.count && this.time - this.births[expired]! >= this.options.lifetime) expired++;
        if (expired) { this.history.copyWithin(0, expired * 3); this.births.copyWithin(0, expired); this.count -= expired; }
        this.setProgress(0);
    }
    stopEmission(): void { this.emitting = false; }
    get isFinished(): boolean { return !this.emitting && this.count < 2; }
    get sampleCount(): number { return this.count; }
    setProgress(_progress: number): void {
        if (this.disposed) return;
        this.group.visible = this.count >= 2;
        for (let i = 0; i < this.count; i++) {
            this.point.fromArray(this.history, i * 3);
            const remaining = THREE.MathUtils.clamp(1 - (this.time - this.births[i]!) / this.options.lifetime, 0, 1);
            const variation = 1 + 0.18 * this.options.variance * Math.sin(this.births[i]! * 19 + this.options.seed);
            if (this.preset === 'smoke-trail') {
                const age = 1 - remaining, phase = this.births[i]! * 19 + this.options.seed;
                this.dummy.position.copy(this.point);
                this.dummy.position.y += age * this.options.width * 0.8;
                this.dummy.scale.setScalar(this.options.width * (0.2 + age * 0.7) * Math.sin(Math.PI * remaining) * variation * this.options.amount);
                this.dummy.rotation.set(phase, phase * 0.3, phase * 0.7); this.dummy.updateMatrix(); this.smoke.setMatrixAt(i, this.dummy.matrix);
                continue;
            }
            const next = i + 1 < this.count ? i + 1 : Math.max(0, i - 1);
            this.tangent.fromArray(this.history, next * 3).sub(this.point);
            if (i === this.count - 1) this.tangent.negate();
            if (this.tangent.lengthSq() < 1e-10) this.tangent.set(0, 0, 1); else this.tangent.normalize();
            this.side.crossVectors(this.tangent, EFFECT_UP);
            if (this.side.lengthSq() < 1e-8) this.side.set(1, 0, 0); else this.side.normalize();
            this.across.crossVectors(this.tangent, this.side).normalize();
            const width = this.options.width * Math.pow(remaining, 0.7) * this.options.amount * variation;
            this.color.copy(this.baseColor).multiplyScalar(0.4 + remaining * 0.6);
            for (let v = 0; v < 4; v++) {
                const axis = v < 2 ? this.side : this.across, sign = v % 2 === 0 ? -1 : 1, k = (i * 4 + v) * 3;
                this.positions[k] = this.point.x + axis.x * width * sign;
                this.positions[k + 1] = this.point.y + axis.y * width * sign;
                this.positions[k + 2] = this.point.z + axis.z * width * sign;
                const c = (i * 4 + v) * 4;
                this.color.toArray(this.colors, c); this.colors[c + 3] = remaining;
            }
        }
        this.smoke.count = this.preset === 'smoke-trail' ? this.count : 0;
        if (this.preset === 'smoke-trail') updateEffectAttribute(this.smoke.instanceMatrix, this.smoke.count);
        else {
            updateEffectAttribute(this.geometry.getAttribute('position') as THREE.BufferAttribute, this.count * 4);
            updateEffectAttribute(this.geometry.getAttribute('color') as THREE.BufferAttribute, this.count * 4);
        }
        this.geometry.setDrawRange(0, Math.max(0, this.count - 1) * 12);
    }
}
