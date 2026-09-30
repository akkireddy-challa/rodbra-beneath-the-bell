import * as THREE from 'three';
import { CustomEffectVisual, type CustomEffectDefinition, type CustomEffectOptions } from 'engine/effects/CustomEffectVisual.js';
import type { EngineLike } from 'types/game.js';
import { activeDeviceQualityTier } from 'engine/DeviceQuality.js';
import { ExplosionVisual, type ExplosionVisualOptions } from 'engine/effects/ExplosionVisual.js';
import { explosionRecipe, type ExplosionPreset } from 'engine/effects/ExplosionPresets.js';
import { BurstVisual, DEFAULT_BURST_OPTIONS, type BurstOptions } from 'engine/effects/BurstVisual.js';
import { burstRecipe, type BurstPreset } from 'engine/effects/BurstPresets.js';
import { LightningVisual, DEFAULT_LIGHTNING_OPTIONS, LIGHTNING_PRESETS, type LightningOptions, type BeamPreset } from 'engine/effects/LightningVisual.js';
import { effectNumber, effectPosition, effectDensity, type VFXStyle, type VFXQuality } from 'engine/effects/VFXUtils.js';
import { EffectShape, DEFAULT_EFFECT_SHAPE_OPTIONS, resolveShape, readEffectTarget, namedRecipe, type EffectTarget, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { FireVisual, FIRE_PRESETS, type FirePreset } from 'engine/effects/FireVisual.js';
import { ShieldVisual, SHIELD_PRESETS, type ShieldPreset } from 'engine/effects/ShieldVisual.js';
import { SurfaceVisual, SURFACE_PRESETS, type SurfacePreset } from 'engine/effects/SurfaceVisual.js';
import { RibbonTrailVisual, TRAIL_PRESETS, DEFAULT_TRAIL_OPTIONS, type TrailPreset, type TrailOptions } from 'engine/effects/RibbonTrailVisual.js';
import { TransitionVisual, TRANSITION_PRESETS, type TransitionPreset } from 'engine/effects/TransitionVisual.js';

export interface VisualEffectsOptions {
    style: VFXStyle;
    quality: VFXQuality;
    maxActive: number;
    maxRetained: number;
    maxEmitters: number;
    seed: number;
}
export const DEFAULT_VISUAL_EFFECTS_OPTIONS: VisualEffectsOptions = { style: 'voxel', quality: 'medium', maxActive: 48, maxRetained: 64, maxEmitters: 16, seed: 73 };
export interface EffectHandle {
    readonly isAlive: boolean;
    stop(): void;
    /** Absolute normalized age; useful for authored timelines and reproducible previews. */
    seek(progress: number): void;
}
export type ExplosionSpawnOptions = Partial<ExplosionVisualOptions> & { duration?: number };
export type BurstSpawnOptions = Partial<BurstOptions>;
export type LightningSpawnOptions = Partial<LightningOptions>;
export interface FollowEffectHandle extends EffectHandle { moveTo(target: EffectTarget): void }
export interface FireEffectHandle extends FollowEffectHandle { setDirection(direction: THREE.Vector3): void }
export interface ShieldEffectHandle extends FollowEffectHandle {
    hit(position: THREE.Vector3, normal?: THREE.Vector3): EffectHandle | null;
    break(): EffectHandle | null;
}
export interface ContinuousBeamHandle extends EffectHandle { setEndpoints(from: EffectTarget, to: EffectTarget): void }
export interface TrailHandle {
    readonly isAlive: boolean;
    /** Stop sampling; the existing tail fades over its lifetime. */
    stop(): void;
    /** Cancel immediately, including the existing tail. */
    clear(): void;
    moveTo(target: EffectTarget): void;
}

export interface EmitterOptions {
    interval: number;
    /** Zero emits until stopped. Positive duration is in seconds. */
    duration: number;
    burst: BurstSpawnOptions;
}
export const DEFAULT_EMITTER_OPTIONS: EmitterOptions = { interval: 0.2, duration: 0, burst: {} };
export interface EmitterHandle {
    readonly isAlive: boolean;
    /** Stops future births; existing particles finish naturally. */
    stop(): void;
    moveTo(position: THREE.Vector3): void;
}
interface Emitter {
    preset: BurstPreset; position: THREE.Vector3; options: EmitterOptions;
    elapsed: number; lastIndex: number; seed: number; active: boolean; lifetime: number;
}

type Visual = BurstVisual | LightningVisual | ExplosionVisual | FireVisual | ShieldVisual | SurfaceVisual | RibbonTrailVisual | TransitionVisual | CustomEffectVisual<CustomEffectOptions>;
interface Slot {
    kind: 'burst' | 'lightning' | 'explosion' | 'fire' | 'shield' | 'surface' | 'trail' | 'transition' | 'custom';
    definition: object | null;
    style: VFXStyle; visual: Visual | null; generation: number; age: number; duration: number; active: boolean; order: number;
    cyclic: boolean; period: number; step: ((dt: number) => void) | null;
}

/** Scene-owned playback with bounded concurrency and stale-handle-safe pooling. All effects are visual only. */
export class VisualEffects {
    private static readonly scenes = new WeakMap<THREE.Scene, VisualEffects>();
    private readonly slots: Slot[] = [];
    private sequence = 0;
    private readonly emitters: Emitter[] = [];
    private disposed = false;
    private prepared = false;
    readonly options: Readonly<VisualEffectsOptions>;

    /** GameEngine owns the returned system's update and teardown. Options apply on first access. */
    static forScene(scene: THREE.Scene, options: Partial<VisualEffectsOptions> = {}): VisualEffects {
        let system = this.scenes.get(scene);
        if (!system) { system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, ...options }); this.scenes.set(scene, system); }
        return system;
    }
    static clearScene(scene: THREE.Scene): void { this.scenes.get(scene)?.clear(); }
    static updateScene(scene: THREE.Scene, deltaTime: number): void { this.scenes.get(scene)?.update(deltaTime); }
    static disposeScene(scene: THREE.Scene): void { this.scenes.get(scene)?.dispose(); this.scenes.delete(scene); }

    /** For standalone previews. Game code should use getVisualEffects(engine), with automatic lifecycle. */
    constructor(private readonly scene: THREE.Scene, options: VisualEffectsOptions) {
        effectDensity(options.quality);
        this.options = Object.freeze({ ...options,
            maxActive: Math.round(effectNumber(options.maxActive, 'maxActive', 1, 256)),
            maxRetained: Math.round(effectNumber(options.maxRetained, 'maxRetained', 1, 256)),
            maxEmitters: Math.round(effectNumber(options.maxEmitters, 'maxEmitters', 1, 64)),
            seed: effectNumber(options.seed, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        });
    }

    /** Build hidden representatives during game load; the engine's normal scene warmup
     * compiles their real materials/instance layouts before the first gameplay trigger. */
    prepare(): void {
        if (this.disposed) throw new Error('VisualEffects is disposed');
        if (this.prepared) return;
        if (this.slots.some(slot => slot.active)) throw new Error('Prepare visual effects before spawning live effects');
        const sequence = this.sequence;
        const origin = new THREE.Vector3();
        for (const preset of ['sparks', 'flame', 'smoke'] as const) this.burst(preset, origin, { seed: 0 }).stop();
        this.lightning([origin, new THREE.Vector3(0, 1, 0)], { seed: 0 }).stop();
        this.explosion('blast', origin, { seed: 0 }).stop();
        this.fire('torch', origin, { seed: 0 }).stop();
        this.shield('bubble', origin, { seed: 0 }).stop();
        this.surface('scorch', origin, { seed: 0 }).stop();
        this.trail('missile', origin, { seed: 0 }).clear();
        this.sequence = sequence;
        this.prepared = true;
    }

    explosion(preset: ExplosionPreset, position: THREE.Vector3, overrides: ExplosionSpawnOptions = {}): EffectHandle {
        const recipe = explosionRecipe(preset, overrides.recipe);
        const options: ExplosionVisualOptions = { radius: 3, color: recipe.color, style: this.options.style, quality: this.options.quality,
            seed: this.nextSeed(), amount: 1, variance: 0.65, ...overrides, preset };
        this.validateCommon(position, options.seed, options.amount ?? 1, options.variance ?? 0.65, options.quality ?? this.options.quality, options.style);
        effectNumber(options.radius, 'radius', 0.01, 1000);
        for (const strength of Object.values(options.layers ?? {})) effectNumber(strength, 'layer strength', 0, 2);
        const duration = effectNumber(overrides.duration ?? recipe.duration, 'duration', 0.01, 120);
        const slot = this.take('explosion', options.style, duration);
        slot.visual = ExplosionVisual.acquire(this.scene, position, options);
        return this.handle(slot);
    }

    burst(preset: BurstPreset, position: THREE.Vector3, overrides: BurstSpawnOptions = {}): EffectHandle {
        const recipe = burstRecipe(preset, overrides.recipe);
        const options: BurstOptions = { ...DEFAULT_BURST_OPTIONS, style: this.options.style, quality: this.options.quality,
            color: recipe.color, duration: recipe.duration, seed: this.nextSeed(), ...overrides, preset };
        this.validateCommon(position, options.seed, options.amount, options.variance, options.quality, options.style);
        effectPosition(options.direction); effectNumber(options.radius, 'radius', 0.01, 1000);
        const duration = effectNumber(options.duration, 'duration', 0.01, 120);
        const slot = this.take('burst', options.style, duration);
        if (!(slot.visual instanceof BurstVisual)) slot.visual = new BurstVisual(this.scene, options.style);
        slot.visual.rearm(position, options);
        return this.handle(slot);
    }

    /** Two points for a bolt/beam; up to nine ordered points for chain lightning. No damage is applied. */
    lightning(points: readonly THREE.Vector3[], overrides: LightningSpawnOptions = {}): EffectHandle {
        const preset = overrides.preset ?? 'lightning', recipe = LIGHTNING_PRESETS[preset];
        if (!Object.prototype.hasOwnProperty.call(LIGHTNING_PRESETS, preset)) throw new Error(`Unknown lightning preset: ${preset}`);
        const options: LightningOptions = { ...DEFAULT_LIGHTNING_OPTIONS, ...recipe, style: this.options.style,
            quality: this.options.quality, seed: this.nextSeed(), ...overrides, preset };
        if (points.length < 2 || points.length > 9) throw new Error('Lightning needs 2–9 path points');
        points.forEach(effectPosition);
        this.validateCommon(points[0]!, options.seed, options.amount, options.variance, options.quality, options.style);
        effectNumber(options.width, 'width', 0.001, 10); effectNumber(options.roughness, 'roughness', 0, 3);
        effectNumber(options.branches, 'branches', -1, 6);
        const duration = effectNumber(options.duration, 'duration', 0.01, 120);
        const slot = this.take('lightning', options.style, duration);
        if (!(slot.visual instanceof LightningVisual)) slot.visual = new LightningVisual(this.scene, options.style);
        slot.visual.rearm(points, options);
        return this.handle(slot);
    }

    beam(from: THREE.Vector3, to: THREE.Vector3, preset: BeamPreset = 'laser', overrides: LightningSpawnOptions = {}): EffectHandle {
        return this.lightning([from, to], { ...overrides, preset });
    }

    /** Object3D endpoints follow world transforms; Vector3 endpoints are read by reference. */
    continuousBeam(from: EffectTarget, to: EffectTarget, preset: BeamPreset = 'laser', overrides: LightningSpawnOptions = {}): ContinuousBeamHandle {
        const points = [readEffectTarget(from, new THREE.Vector3()), readEffectTarget(to, new THREE.Vector3())];
        const duration = effectNumber(overrides.duration ?? 0, 'beam duration', 0, 86400);
        const handle = this.lightning(points, { ...overrides, preset, duration: 1, sustained: true });
        const slot = this.slots.find(s => s.active && s.order === this.sequence)!;
        const visual = slot.visual as LightningVisual;
        slot.duration = duration || Infinity; slot.cyclic = true; slot.period = 4;
        let source = from, target = to;
        slot.step = () => { readEffectTarget(source, points[0]!); readEffectTarget(target, points[1]!); visual.moveEndpoints(points, slot.age / slot.period); };
        return { ...handle, get isAlive() { return handle.isAlive; }, setEndpoints: (nextFrom, nextTo) => {
            if (!handle.isAlive) return;
            readEffectTarget(nextFrom, points[0]!); readEffectTarget(nextTo, points[1]!);
            source = nextFrom; target = nextTo; visual.moveEndpoints(points, slot.age / slot.period);
        } };
    }

    private shapeOptions(overrides: Partial<EffectShapeOptions>, defaults: { color: number; duration: number }): EffectShapeOptions {
        return resolveShape({ ...DEFAULT_EFFECT_SHAPE_OPTIONS, ...defaults, style: this.options.style, quality: this.options.quality,
            seed: this.nextSeed(), ...overrides });
    }
    private follow(slot: Slot, target: EffectTarget, handle: EffectHandle): FollowEffectHandle {
        const point = new THREE.Vector3(); let current = target;
        const visual = slot.visual as EffectShape;
        slot.step = () => visual.moveTo(readEffectTarget(current, point));
        return { ...handle, get isAlive() { return handle.isAlive; }, moveTo: next => {
            if (!handle.isAlive) return;
            readEffectTarget(next, point); current = next; visual.moveTo(point);
        } };
    }
    fire(preset: FirePreset, target: EffectTarget, overrides: Partial<EffectShapeOptions> = {}): FireEffectHandle {
        const recipe = namedRecipe(FIRE_PRESETS, preset), options = this.shapeOptions(overrides, { color: recipe.color, duration: 0 });
        const point = readEffectTarget(target, new THREE.Vector3()), slot = this.take('fire', options.style, options.duration || Infinity);
        if (!(slot.visual instanceof FireVisual)) slot.visual = new FireVisual(this.scene, options.style);
        const visual = slot.visual; visual.rearm(preset, point, options); slot.cyclic = true; slot.period = 4;
        const handle = this.follow(slot, target, this.handle(slot));
        return { ...handle, get isAlive() { return handle.isAlive; }, setDirection: direction => {
            if (!handle.isAlive) return; effectPosition(direction); visual.setDirection(direction); visual.setProgress(slot.age / 4);
        } };
    }
    shield(preset: ShieldPreset, target: EffectTarget, overrides: Partial<EffectShapeOptions> = {}): ShieldEffectHandle {
        const recipe = namedRecipe(SHIELD_PRESETS, preset);
        const options = this.shapeOptions({ direction: new THREE.Vector3(0, 0, 1), ...overrides }, recipe);
        const point = readEffectTarget(target, new THREE.Vector3()), slot = this.take('shield', options.style, options.duration || Infinity);
        if (!(slot.visual instanceof ShieldVisual)) slot.visual = new ShieldVisual(this.scene, options.style);
        slot.visual.rearm(preset, point, options);
        slot.cyclic = preset !== 'hit-ripple' && preset !== 'shield-break'; slot.period = 2;
        const handle = this.follow(slot, target, this.handle(slot));
        return { ...handle, get isAlive() { return handle.isAlive; },
            hit: (position, normal) => {
                if (!handle.isAlive) return null;
                const center = (slot.visual as ShieldVisual).group.position;
                const direction = normal?.clone() ?? position.clone().sub(center);
                return this.shield('hit-ripple', position.clone(), { ...options, direction, radius: options.radius * 0.45, duration: 0.65 });
            },
            break: () => {
                if (!handle.isAlive) return null;
                const position = (slot.visual as ShieldVisual).group.position.clone(); handle.stop();
                return this.shield('shield-break', position, { ...options, duration: 1.1 });
            },
        };
    }
    surface(preset: SurfacePreset, position: THREE.Vector3, overrides: Partial<EffectShapeOptions> = {}): EffectHandle {
        const options = this.shapeOptions(overrides, namedRecipe(SURFACE_PRESETS, preset)); effectPosition(position);
        const slot = this.take('surface', options.style, options.duration || Infinity);
        if (!(slot.visual instanceof SurfaceVisual)) slot.visual = new SurfaceVisual(this.scene, options.style);
        slot.visual.rearm(preset, position, options); return this.handle(slot);
    }
    trail(preset: TrailPreset, target: EffectTarget, overrides: Partial<TrailOptions> = {}): TrailHandle {
        const recipe = namedRecipe(TRAIL_PRESETS, preset);
        const options = { ...DEFAULT_TRAIL_OPTIONS, ...recipe, ...overrides, ...this.shapeOptions(overrides, { color: recipe.color, duration: 0 }) };
        options.width = effectNumber(options.width, 'trail width', 0.001, 100);
        options.lifetime = effectNumber(options.lifetime, 'trail lifetime', 0.05, 10);
        options.teleportDistance = effectNumber(options.teleportDistance, 'teleport distance', 0.01, 10000);
        const point = readEffectTarget(target, new THREE.Vector3()), slot = this.take('trail', options.style, Infinity);
        if (!(slot.visual instanceof RibbonTrailVisual)) slot.visual = new RibbonTrailVisual(this.scene, options.style);
        const visual = slot.visual; visual.rearm(preset, point, options);
        let current = target; const handle = this.handle(slot), nextPoint = new THREE.Vector3(), cutoffPoint = new THREE.Vector3();
        slot.step = dt => {
            readEffectTarget(current, nextPoint);
            const emissionTime = options.duration > 0 ? THREE.MathUtils.clamp(options.duration - (slot.age - dt), 0, dt) : dt;
            if (emissionTime < dt) {
                cutoffPoint.lerpVectors(point, nextPoint, emissionTime / dt);
                visual.advance(emissionTime, cutoffPoint); visual.stopEmission(); visual.advance(dt - emissionTime, nextPoint);
            } else {
                visual.advance(dt, nextPoint);
                if (options.duration > 0 && slot.age >= options.duration) visual.stopEmission();
            }
            point.copy(nextPoint);
            if (visual.isFinished) this.retire(slot);
        };
        return { get isAlive() { return handle.isAlive; }, stop: () => { if (handle.isAlive) visual.stopEmission(); }, clear: handle.stop,
            moveTo: next => { if (handle.isAlive) { readEffectTarget(next, nextPoint); current = next; } } };
    }
    transition(preset: TransitionPreset, target: THREE.Object3D, overrides: Partial<EffectShapeOptions> = {}): EffectHandle {
        const options = this.shapeOptions(overrides, namedRecipe(TRANSITION_PRESETS, preset));
        TransitionVisual.validateTarget(target);
        for (const old of this.slots) if (old.active && old.visual instanceof TransitionVisual && old.visual.overlaps(target)) this.retire(old);
        const slot = this.take('transition', options.style, Math.max(0.01, options.duration));
        if (!(slot.visual instanceof TransitionVisual)) slot.visual = new TransitionVisual(this.scene, options.style);
        slot.visual.rearm(preset, target, options); return this.handle(slot);
    }

    /** A game-local effect with the same clock, limits, pooling and teardown as presets.
     * Keep definition identity stable. duration is positive; loop repeats its cycle. */
    custom<Options extends CustomEffectOptions>(definition: CustomEffectDefinition<Options>, target: EffectTarget,
        overrides: Partial<Options> = {}): FollowEffectHandle {
        const unresolved = { ...definition.defaults, style: this.options.style, quality: this.options.quality,
            seed: this.nextSeed(), ...overrides };
        const options = { ...unresolved, ...resolveShape(unresolved) };
        options.duration = effectNumber(options.duration, 'custom duration', 0.01, 120);
        if (typeof options.loop !== 'boolean') throw new Error('Custom effect loop must be a boolean');
        const point = readEffectTarget(target, new THREE.Vector3());
        const slot = this.take('custom', options.style, options.loop ? Infinity : options.duration, definition);
        try {
            if (!slot.visual) slot.visual = definition.create(this.scene, options.style);
            // A definition's identity is part of the pool key, so its Options type is stable.
            const visual = slot.visual as CustomEffectVisual<Options>;
            visual.rearm(point, options);
            visual.setProgress(0);
        } catch (error) {
            this.destroySlot(slot); this.slots.splice(this.slots.indexOf(slot), 1);
            throw error;
        }
        slot.cyclic = options.loop; slot.period = options.duration;
        return this.follow(slot, target, this.handle(slot));
    }

    /** Sustained fire/smoke/aura using the same bounded burst pool. Positions are world space. */
    emit(preset: BurstPreset, position: THREE.Vector3, overrides: Partial<EmitterOptions> = {}): EmitterHandle {
        const options: EmitterOptions = { ...DEFAULT_EMITTER_OPTIONS, ...overrides, burst: { ...overrides.burst, recipe: overrides.burst?.recipe ? { ...overrides.burst.recipe } : undefined } };
        options.interval = effectNumber(options.interval, 'interval', 0.025, 120);
        options.duration = effectNumber(options.duration, 'emitter duration', 0, 86400);
        const seed = options.burst.seed ?? this.nextSeed();
        const lifetime = effectNumber(options.burst.duration ?? burstRecipe(preset, options.burst.recipe).duration, 'duration', 0.01, 120);
        // Validate the whole burst before evicting an older emitter.
        this.burst(preset, position, { ...options.burst, seed });
        for (let i = this.emitters.length - 1; i >= 0; i--) if (!this.emitters[i]!.active) this.emitters.splice(i, 1);
        if (this.emitters.length >= this.options.maxEmitters) this.emitters.shift()!.active = false;
        const emitter: Emitter = { preset, position: position.clone(), options, elapsed: 0, lastIndex: 0, seed, active: true, lifetime };
        this.emitters.push(emitter);
        return {
            get isAlive() { return emitter.active; },
            stop: () => { emitter.active = false; },
            moveTo: next => { effectPosition(next); if (emitter.active) emitter.position.copy(next); },
        };
    }

    private updateEmitters(deltaTime: number): void {
        for (let i = this.emitters.length - 1; i >= 0; i--) {
            const emitter = this.emitters[i]!;
            if (!emitter.active) { this.emitters.splice(i, 1); continue; }
            emitter.elapsed += deltaTime;
            const end = emitter.options.duration > 0 ? Math.min(emitter.elapsed, emitter.options.duration - 1e-9) : emitter.elapsed;
            const latest = Math.floor((end + 1e-10) / emitter.options.interval);
            // A stalled tab must not recreate minutes of missed particles. Seeds remain indexed
            // by scheduled birth, so skipped old bursts never perturb the visible sequence.
            for (let index = Math.max(emitter.lastIndex + 1, latest - 3); index <= latest; index++) {
                const age = emitter.elapsed - index * emitter.options.interval;
                const lifetime = emitter.lifetime;
                if (age >= lifetime) continue;
                const effect = this.burst(emitter.preset, emitter.position, { ...emitter.options.burst, seed: (emitter.seed + Math.imul(index, 2654435761)) >>> 0 });
                effect.seek(Math.max(0, age / lifetime));
            }
            emitter.lastIndex = latest;
            if (emitter.options.duration > 0 && emitter.elapsed >= emitter.options.duration) {
                emitter.active = false; this.emitters.splice(i, 1);
            }
        }
    }

    private nextSeed(): number {
        if (this.disposed) throw new Error('VisualEffects is disposed');
        return (this.options.seed + Math.imul(++this.sequence, 2654435761)) >>> 0;
    }
    private validateCommon(position: THREE.Vector3, seed: number, amount: number, variance: number, quality: VFXQuality, style: VFXStyle): void {
        effectPosition(position); effectNumber(seed, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        effectNumber(amount, 'amount', 0, 3); effectNumber(variance, 'variance', 0, 1); effectDensity(quality);
        if (style !== 'voxel' && style !== 'low-poly') throw new Error(`Unknown VFX style: ${style}`);
    }
    private take(kind: Slot['kind'], style: VFXStyle, duration: number, definition: object | null = null): Slot {
        const active = this.slots.filter(slot => slot.active);
        if (active.length >= this.options.maxActive) this.retire(active.reduce((a, b) => a.order < b.order ? a : b));
        let slot = this.slots.find(s => !s.active && s.kind === kind && s.style === style && s.definition === definition);
        if (!slot) {
            // Bound retained GPU resources across every preset/style combination.
            const idle = this.slots.find(s => !s.active);
            if (idle && this.slots.length >= this.options.maxRetained) {
                this.destroySlot(idle); this.slots.splice(this.slots.indexOf(idle), 1);
            }
            slot = { kind, style, definition, visual: null, generation: 0, age: 0, duration, active: false, order: 0, cyclic: false, period: duration, step: null };
            this.slots.push(slot);
        }
        slot.generation++; slot.age = 0; slot.duration = duration; slot.active = true; slot.order = this.sequence;
        slot.cyclic = false; slot.period = duration; slot.step = null;
        return slot;
    }
    private handle(slot: Slot): EffectHandle {
        const generation = slot.generation;
        const alive = (): boolean => !this.disposed && slot.active && slot.generation === generation;
        return {
            get isAlive() { return alive(); },
            stop: () => { if (alive()) { this.retire(slot); this.trimIdle(); } },
            seek: progress => {
                if (!alive()) return;
                const period = Number.isFinite(slot.duration) ? slot.duration : Number.isFinite(slot.period) ? slot.period : 1;
                slot.age = effectNumber(progress, 'progress', 0, 1) * period;
                slot.step?.(0); this.sample(slot);
                if (slot.age >= slot.duration) { this.retire(slot, true); this.trimIdle(); }
            },
        };
    }
    private sample(slot: Slot): void {
        const progress = slot.cyclic ? slot.age / slot.period : Math.min(1, slot.age / slot.duration);
        slot.visual?.setProgress(slot.kind === 'custom' && slot.cyclic ? progress % 1 : progress);
    }
    private retire(slot: Slot, completed = false): void {
        if (!slot.active) return;
        slot.active = false; slot.step = null;
        if (slot.visual instanceof ExplosionVisual) { slot.visual.release(); slot.visual = null; }
        else if (slot.visual instanceof TransitionVisual) slot.visual.retire(completed);
        else slot.visual?.retire();
    }
    private trimIdle(): void {
        while (this.slots.length > this.options.maxRetained) {
            const index = this.slots.findIndex(slot => !slot.active);
            if (index < 0) break;
            this.destroySlot(this.slots[index]!); this.slots.splice(index, 1);
        }
    }
    private destroySlot(slot: Slot): void {
        this.retire(slot);
        if (slot.visual instanceof BurstVisual || slot.visual instanceof LightningVisual || slot.visual instanceof EffectShape) slot.visual.dispose();
        slot.visual = null;
    }
    update(deltaTime: number): void {
        if (this.disposed || deltaTime === 0) return;
        const dt = effectNumber(deltaTime, 'deltaTime', 0, Number.MAX_SAFE_INTEGER);
        for (const slot of this.slots) if (slot.active) {
            slot.age += dt; slot.step?.(dt);
            if (!slot.active) continue;
            // Trails already write their buffers once inside advance().
            if (!(slot.visual instanceof RibbonTrailVisual)) this.sample(slot);
            if (slot.age >= slot.duration) this.retire(slot, true);
        }
        this.updateEmitters(dt); this.trimIdle();
    }
    /** Reset active effects while preserving warmed buffers. Existing handles become inactive. */
    clear(): void {
        this.slots.forEach(slot => this.retire(slot));
        this.emitters.forEach(emitter => { emitter.active = false; }); this.emitters.length = 0; this.trimIdle();
    }
    get stats(): { active: number; retained: number; maxActive: number; emitters: number } {
        return { active: this.slots.filter(slot => slot.active).length, retained: this.slots.length, maxActive: this.options.maxActive, emitters: this.emitters.filter(e => e.active).length };
    }
    dispose(): void {
        if (this.disposed) return;
        this.clear();
        this.disposed = true; this.slots.forEach(slot => this.destroySlot(slot)); this.slots.length = 0;
        if (VisualEffects.scenes.get(this.scene) === this) VisualEffects.scenes.delete(this.scene);
    }
}

/** Uses the game's art style. GameEngine ticks this registry with gameplay time and clears it on world teardown. */
export function getVisualEffects(engine: Pick<EngineLike, 'scene' | 'getGameData'>, options: Partial<VisualEffectsOptions> = {}): VisualEffects {
    if (!engine.scene) throw new Error('Visual effects require a loaded scene');
    const tier = activeDeviceQualityTier();
    const quality: VFXQuality = tier === 'minimal' || tier === 'low' ? 'low' : tier === 'medium' ? 'medium' : 'high';
    const system = VisualEffects.forScene(engine.scene, { style: engine.getGameData?.()?.artStyle ?? 'voxel', quality, ...options });
    // Existing callers of forScene may have already started playback; never evict their effects.
    if (system.stats.active === 0) system.prepare();
    return system;
}
