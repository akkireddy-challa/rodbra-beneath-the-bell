import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { FireVisual, FIRE_PRESETS, type FirePreset } from 'engine/effects/FireVisual.js';
import { ShieldVisual, SHIELD_PRESETS, type ShieldPreset } from 'engine/effects/ShieldVisual.js';
import { SurfaceVisual, SURFACE_PRESETS, type SurfacePreset } from 'engine/effects/SurfaceVisual.js';
import { RibbonTrailVisual, TRAIL_PRESETS, DEFAULT_TRAIL_OPTIONS, type TrailPreset } from 'engine/effects/RibbonTrailVisual.js';
import { TransitionVisual, TRANSITION_PRESETS, type TransitionPreset } from 'engine/effects/TransitionVisual.js';
import { DEFAULT_EFFECT_SHAPE_OPTIONS } from 'engine/effects/EffectShapes.js';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS } from 'engine/effects/VisualEffects.js';
import { LIGHTNING_PRESETS, type BeamPreset } from 'engine/effects/LightningVisual.js';
import { effectRandom, type VFXStyle, type VFXQuality } from 'engine/effects/VFXUtils.js';
import { MuzzleFlash, DEFAULT_MUZZLE_FLASH_OPTIONS } from 'engine/viewmodel/MuzzleFlash.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { AmbientSnowVFX } from 'engine/effects/AmbientSnowVFX.js';
import { RainVFXWebGl, DEFAULT_RAIN_VFX_WEBGL_OPTIONS } from 'engine/weather/RainVFXWebGl.js';
import { RainVFXGpu, DEFAULT_RAIN_VFX_GPU_OPTIONS } from 'engine/weather/RainVFXGpu.js';
import { RainHeightField } from 'engine/weather/RainHeightField.js';
import { BoatWakeVFX } from 'engine/boat/BoatWakeVFX.js';
import { CircleTelegraph, ConeTelegraph, LineTelegraph, GroundZone, OrbEffect,
    DEFAULT_CIRCLE_TELEGRAPH_CONFIG, DEFAULT_CONE_TELEGRAPH_CONFIG, DEFAULT_LINE_TELEGRAPH_CONFIG,
    DEFAULT_GROUND_ZONE_CONFIG, DEFAULT_ORB_EFFECT_CONFIG } from 'engine/effects/TelegraphVFX.js';

export const FIRE_BURSTS = ['flame', 'embers', 'smoke', 'steam', 'ash'];
export const EXTRA_CATALOG = {
    fire: [...Object.keys(FIRE_PRESETS), ...FIRE_BURSTS],
    beams: ['laser', 'energy-beam', 'ion', 'railgun', 'healing-link', 'tractor-beam'],
    shields: Object.keys(SHIELD_PRESETS), trails: Object.keys(TRAIL_PRESETS), surfaces: Object.keys(SURFACE_PRESETS), transitions: Object.keys(TRANSITION_PRESETS),
    weapons: ['muzzle-flash', 'attack-trail'], environment: ['snow', 'rain', 'boat-wake'], telegraphs: ['circle', 'cone', 'line', 'ground-zone', 'orb'],
};
export interface WorkshopPanel { scene: THREE.Scene; tick: (time: number) => void; dispose: () => void }
export interface WorkshopSettings { style: VFXStyle; quality: VFXQuality; seed: number; amount: number; variance: number; debug: string }

function prop(scene: THREE.Scene, color: number, position: THREE.Vector3, scale: THREE.Vector3): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color }));
    mesh.position.copy(position); mesh.scale.copy(scale); scene.add(mesh); return mesh;
}
/** Only legacy systems that use Math.random need this synchronous inspection scope. */
function seeded<T>(random: () => number, run: () => T): T {
    const previous = Math.random; Math.random = random;
    try { return run(); } finally { Math.random = previous; }
}
interface Replay { update: (dt: number, seconds: number) => void; dispose: () => void }
function replay(panel: WorkshopPanel, seed: number, create: () => Replay): void {
    let random = effectRandom(seed), simulation = seeded(random, create), frame = 0;
    panel.tick = time => {
        const next = Math.floor(time * 240);
        if (next < frame) { simulation.dispose(); random = effectRandom(seed); simulation = seeded(random, create); frame = 0; }
        while (frame < next) { frame++; seeded(random, () => simulation.update(1 / 60, frame / 60)); }
    };
    panel.dispose = () => simulation.dispose();
}

/** Real engine effects with deterministic fixtures and repeatable input paths. */
export function populateWorkshopScene(family: string, name: string, panel: WorkshopPanel, settings: WorkshopSettings, gpu: WebGPURenderer | null): void {
    const scene = panel.scene, at = new THREE.Vector3(0, 0.08, 0);
    const shape = { ...DEFAULT_EFFECT_SHAPE_OPTIONS, ...settings, radius: 1.2 };
    if (family === 'fire') {
        const preset = name as FirePreset, recipe = FIRE_PRESETS[preset], visual = new FireVisual(scene, settings.style);
        const direction = name === 'flamethrower' || name === 'engine-exhaust' ? new THREE.Vector3(1, 0.15, 0) : new THREE.Vector3(0, 1, 0);
        if (name === 'torch') { prop(scene, 0x63462f, new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0.13, 1, 0.13)); at.y = 1; }
        else if (name === 'campfire') for (let i = 0; i < 3; i++) {
            const log = prop(scene, 0x4b352b, new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(1.4, 0.2, 0.2)); log.rotation.y = i * Math.PI / 3;
        }
        else if (name !== 'fire-wall') {
            at.set(-recipe.length * shape.radius * 0.5, 0.7, 0);
            prop(scene, 0x414855, new THREE.Vector3(at.x - 0.4, at.y, 0), new THREE.Vector3(0.8, 0.4, 0.4));
        }
        visual.rearm(preset, at, { ...shape, color: recipe.color, direction });
        panel.tick = time => {
            visual.setProgress(time);
            visual.group.getObjectByName('Fire:flame')!.visible = settings.debug !== 'smoke';
            visual.group.getObjectByName('Fire:smoke')!.visible = settings.debug !== 'glow';
            visual.group.getObjectByName('Fire:embers')!.visible = settings.debug === 'all' || settings.debug === 'glow';
        }; panel.dispose = () => visual.dispose(); return;
    }
    if (family === 'beams') {
        const preset = name as BeamPreset;
        const source = prop(scene, 0x485163, new THREE.Vector3(-2, 2.5, 0), new THREE.Vector3(0.3, 0.3, 0.3));
        const target = prop(scene, 0x727f93, new THREE.Vector3(2, 1, 0), new THREE.Vector3(0.45, 0.45, 0.45));
        const system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, ...settings });
        const handle = system.continuousBeam(source, target, preset, { ...settings, width: LIGHTNING_PRESETS[preset].width,
            layers: { core: settings.debug !== 'glow', glow: settings.debug !== 'structure', endpoints: settings.debug !== 'structure' } });
        panel.tick = time => {
            source.position.y = 2.3 + Math.sin(time * Math.PI * 2) * 0.5;
            target.position.set(2, 1.4 + Math.cos(time * Math.PI * 2) * 0.7, Math.sin(time * Math.PI * 2)); handle.seek(time);
        }; panel.dispose = () => system.dispose(); return;
    }
    if (family === 'shields') {
        const preset = name as ShieldPreset, visual = new ShieldVisual(scene, settings.style);
        const position = new THREE.Vector3(0, preset === 'dome' ? 0.08 : 1.4, 0);
        visual.rearm(preset, position, { ...shape, color: SHIELD_PRESETS[preset].color, radius: 1.4, direction: new THREE.Vector3(0, 0, 1) });
        if (preset !== 'hit-ripple' && preset !== 'shield-break') prop(scene, 0x546270, new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(0.5, 1.2, 0.5));
        panel.tick = time => visual.setProgress(time); panel.dispose = () => visual.dispose(); return;
    }
    if (family === 'surfaces') {
        const preset = name as SurfacePreset, visual = new SurfaceVisual(scene, settings.style);
        visual.rearm(preset, at, { ...shape, radius: 1.7, color: SURFACE_PRESETS[preset].color });
        panel.tick = time => visual.setProgress(time); panel.dispose = () => visual.dispose(); return;
    }
    if (family === 'transitions') {
        const target = new THREE.Group(); scene.add(target);
        const body = prop(scene, 0x86adb7, new THREE.Vector3(0, 0.8, 0), new THREE.Vector3(0.8, 1.2, 0.5)); target.attach(body);
        const head = new THREE.Mesh(settings.style === 'voxel' ? new THREE.BoxGeometry(0.55, 0.55, 0.55) : new THREE.IcosahedronGeometry(0.4, 1), body.material);
        head.position.y = 1.7; target.add(head);
        for (const x of [-0.57, 0.57]) target.attach(prop(scene, 0x5a818d, new THREE.Vector3(x, 0.9, 0), new THREE.Vector3(0.23, 0.8, 0.3)));
        const preset = name as TransitionPreset, visual = new TransitionVisual(scene, settings.style);
        visual.rearm(preset, target, { ...shape, color: TRANSITION_PRESETS[preset].color });
        panel.tick = time => {
            visual.setProgress(time);
            if (settings.debug === 'glow') target.visible = false;
            visual.group.visible = settings.debug !== 'structure' && time < 1;
        }; panel.dispose = () => visual.dispose(); return;
    }
    if (family === 'trails') {
        const preset = name as TrailPreset, visual = new RibbonTrailVisual(scene, settings.style), point = new THREE.Vector3();
        const tip = prop(scene, TRAIL_PRESETS[preset].color, point, new THREE.Vector3(0.14, 0.14, 0.14));
        const path = (time: number) => point.set(Math.sin(time * 2.4) * 2, 1.5 + Math.sin(time * 3) * 0.6, Math.cos(time * 2.4));
        let frame = 0;
        const reset = () => { frame = 0; visual.rearm(preset, path(0), { ...DEFAULT_TRAIL_OPTIONS, ...TRAIL_PRESETS[preset], ...settings }); };
        reset(); panel.tick = time => {
            const next = Math.floor(time * 240); if (next < frame) reset();
            while (frame < next) { frame++; const seconds = frame / 60; if (seconds >= 3) visual.stopEmission(); visual.advance(1 / 60, path(Math.min(seconds, 3))); }
            tip.position.copy(point);
        }; panel.dispose = () => visual.dispose(); return;
    }
    if (family === 'weapons' && name === 'muzzle-flash') {
        const weapon = prop(scene, 0x454e59, new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0.28, 0.35, 1.7));
        const light = new THREE.PointLight(0xffbb66, 0, 4); scene.add(light);
        const flash = new MuzzleFlash({ ...DEFAULT_MUZZLE_FLASH_OPTIONS, scale: 2 }, light);
        flash.attachTo(weapon, new THREE.Vector3(0, 0, 0.65));
        panel.tick = time => seeded(effectRandom(settings.seed), () => { flash.trigger(); flash.update(time * DEFAULT_MUZZLE_FLASH_OPTIONS.durationSeconds); });
        panel.dispose = () => flash.dispose(); return;
    }
    if (family === 'weapons') {
        const hand = prop(scene, 0x778596, new THREE.Vector3(), new THREE.Vector3(0.2, 0.2, 0.2)); hand.name = 'RightHand';
        replay(panel, settings.seed, () => {
            const vfx = new AttackVFX(scene); vfx.createAttackTrail(hand, 4, 'right-punch');
            return { update: (dt, time) => { hand.position.set(Math.sin(time * 4) * 1.8, 1.3 + Math.cos(time * 4) * 0.5, Math.cos(time * 4)); hand.updateMatrixWorld(); vfx.update(dt); }, dispose: () => vfx.dispose() };
        }); return;
    }
    if (family === 'telegraphs') {
        replay(panel, settings.seed, () => {
            const effect = name === 'circle' ? new CircleTelegraph(scene, { ...DEFAULT_CIRCLE_TELEGRAPH_CONFIG, position: at, radius: 1.8, chargeDuration: 4 })
                : name === 'cone' ? new ConeTelegraph(scene, { ...DEFAULT_CONE_TELEGRAPH_CONFIG, position: at, length: 3, chargeDuration: 4 })
                    : name === 'line' ? new LineTelegraph(scene, { ...DEFAULT_LINE_TELEGRAPH_CONFIG, position: at, length: 3, chargeDuration: 4 })
                        : name === 'ground-zone' ? new GroundZone(scene, { ...DEFAULT_GROUND_ZONE_CONFIG, position: at, radius: 1.8, duration: 4 })
                            : new OrbEffect(scene, { ...DEFAULT_ORB_EFFECT_CONFIG, position: new THREE.Vector3(0, 1.3, 0), radius: 0.5, auraRadius: 1.5, lifetime: 4 });
            return { update: dt => effect.update(dt), dispose: () => effect.dispose() };
        }); return;
    }
    if (family === 'environment' && name === 'snow') {
        replay(panel, settings.seed, () => {
            const snow = new AmbientSnowVFX(scene, { maxParticles: 350, radius: 4, columnHeight: 5, groundDrop: 0, fallSpeed: 1.8,
                wind: new THREE.Vector3(0.4, 0, 0), flakeSize: 0.08, density: Math.min(1, settings.amount) });
            return { update: dt => snow.update(dt, at), dispose: () => snow.dispose() };
        }); return;
    }
    if (family === 'environment' && name === 'rain') {
        replay(panel, settings.seed, () => {
            if (gpu) {
                const field = new RainHeightField(); field.start({ minX: -6, maxX: 6, minY: 0, maxY: 1, minZ: -6, maxZ: 6 });
                while (!field.isReady) field.step(() => 0);
                const rain = new RainVFXGpu(scene, field, { ...DEFAULT_RAIN_VFX_GPU_OPTIONS, maxDrops: 1500, radius: 5, columnHeight: 6, streakLength: 0.5, splashSize: 0.25, opacity: 0.4 });
                rain.syncField(field); rain.setIntensity(Math.min(1, settings.amount)); rain.setFrameState(at, 0.4, 0);
                return { update: (dt, time) => rain.computeStep(gpu, dt, time), dispose: () => { rain.dispose(); field.dispose(); } };
            }
            const rain = new RainVFXWebGl(scene, { ...DEFAULT_RAIN_VFX_WEBGL_OPTIONS, maxDrops: 800, radius: 5, columnHeight: 6, splashRadius: 4, streakLength: 0.5 });
            rain.setIntensity(Math.min(1, settings.amount));
            return { update: (dt, time) => rain.update(dt, time, at, 0.4, 0, () => 0), dispose: () => rain.dispose() };
        }); return;
    }
    if (family === 'environment' && name === 'boat-wake') {
        prop(scene, 0x396a80, new THREE.Vector3(0, -0.015, 0), new THREE.Vector3(20, 0.02, 20));
        const boat = prop(scene, 0x697381, new THREE.Vector3(), new THREE.Vector3(0.55, 0.35, 1.2));
        const velocity = new THREE.Vector3();
        replay(panel, settings.seed, () => {
            const wake = new BoatWakeVFX(scene, { heightAt: () => 0, normalAt: (_x, _z, out) => out.set(0, 1, 0) },
                { maxParticles: 120, wakeHalfWidth: 0.3, wakeSpread: 1.5, wakeSpacing: 0.1, particleSize: 0.06 });
            return { update: (dt, time) => {
                boat.position.set(Math.sin(time) * 2, 0.2, Math.cos(time) * 2); boat.rotation.y = time + Math.PI / 2;
                velocity.set(Math.cos(time) * 2, 0, -Math.sin(time) * 2);
                wake.update(dt, { forwardSpeed: 2, speed: 2, heading: boat.rotation.y, velocity, onWater: true, airtimeSeconds: 0,
                    drift: 0.3, surfaceY: 0, hullY: 0.2, boosting: false, landingImpact: 0 }, boat.position);
            }, dispose: () => wake.dispose() };
        }); return;
    }
    throw new Error(`Unknown workshop scene: ${family}/${name}`);
}
