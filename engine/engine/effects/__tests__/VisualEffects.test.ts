import * as THREE from 'three';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS, getVisualEffects } from 'engine/effects/VisualEffects.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { EXPLOSION_PRESETS, type ExplosionPreset } from 'engine/effects/ExplosionPresets.js';
import { BURST_PRESETS, type BurstPreset } from 'engine/effects/BurstPresets.js';
import { BurstVisual, DEFAULT_BURST_OPTIONS } from 'engine/effects/BurstVisual.js';
import { LightningVisual, DEFAULT_LIGHTNING_OPTIONS, LIGHTNING_PRESETS, type LightningPreset } from 'engine/effects/LightningVisual.js';
import { AttackVFX, IMPACT_EFFECT_PRESETS } from 'engine/AttackVFX.js';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';

const origin = new THREE.Vector3();
const path = [new THREE.Vector3(-3, 4, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(3, 2, 1)];
function matrices(group: THREE.Object3D): number[] {
    const values: number[] = [];
    group.traverse(child => { if (child instanceof THREE.InstancedMesh) values.push(...child.instanceMatrix.array.slice(0, child.count * 16)); });
    return values;
}
function instances(group: THREE.Object3D): number {
    let count = 0; group.traverse(child => { if (child instanceof THREE.InstancedMesh) count += child.count; }); return count;
}

test.each(['voxel', 'low-poly'] as const)('every recipe has finite, reproducible geometry in %s, including zero and full age', style => {
    const scene = new THREE.Scene();
    for (const preset of Object.keys(EXPLOSION_PRESETS) as ExplosionPreset[]) {
        const v = ExplosionVisual.acquire(scene, origin, { radius: 3, color: EXPLOSION_PRESETS[preset].color, style, seed: 0, preset, amount: 3 });
        for (const t of [0, 0.05, 0.3, 0.7, 1]) { v.setProgress(t); expect(matrices(v.group).every(Number.isFinite)).toBe(true); }
        v.setProgress(0.3); const first = matrices(v.group); v.setProgress(0.8); v.setProgress(0.3); expect(matrices(v.group)).toEqual(first);
        v.release();
    }
    const burst = new BurstVisual(scene, style);
    for (const preset of Object.keys(BURST_PRESETS) as BurstPreset[]) {
        burst.rearm(origin, { ...DEFAULT_BURST_OPTIONS, preset, style, seed: 0, amount: 3, direction: new THREE.Vector3(1, 0, 0) });
        for (const t of [0, 0.05, 0.3, 0.7, 1]) { burst.setProgress(t); expect(matrices(burst.group).every(Number.isFinite)).toBe(true); }
        burst.setProgress(0.3); const first = matrices(burst.group); burst.setProgress(0.8); burst.setProgress(0.3); expect(matrices(burst.group)).toEqual(first);
    }
    const lightning = new LightningVisual(scene, style);
    for (const preset of Object.keys(LIGHTNING_PRESETS) as LightningPreset[]) {
        lightning.rearm(path, { ...DEFAULT_LIGHTNING_OPTIONS, preset, style, seed: 0, amount: 3 });
        for (const t of [0, 0.05, 0.3, 0.7, 1]) { lightning.setProgress(t); expect(matrices(lightning.group).every(Number.isFinite)).toBe(true); }
        lightning.setProgress(0.3); const first = matrices(lightning.group); lightning.setProgress(0.8); lightning.setProgress(0.3); expect(matrices(lightning.group)).toEqual(first);
    }
    lightning.dispose(); burst.dispose(); ExplosionVisual.disposeScene(scene);
    expect(scene.children).toHaveLength(0);
});

test('seed changes layout, quality and amount change density, presets change composition', () => {
    const scene = new THREE.Scene();
    const v = new BurstVisual(scene, 'voxel');
    v.rearm(origin, DEFAULT_BURST_OPTIONS); v.setProgress(0.3); const first = matrices(v.group), high = instances(v.group);
    v.rearm(origin, { ...DEFAULT_BURST_OPTIONS, seed: 74 }); v.setProgress(0.3); expect(matrices(v.group)).not.toEqual(first);
    v.rearm(origin, { ...DEFAULT_BURST_OPTIONS, quality: 'low' }); expect(instances(v.group)).toBeLessThan(high);
    v.rearm(origin, { ...DEFAULT_BURST_OPTIONS, amount: 0 }); expect(instances(v.group)).toBe(0);
    const blast = ExplosionVisual.acquire(scene, origin, { radius: 3, color: 0xff4400, style: 'voxel', seed: 1 });
    const emp = ExplosionVisual.acquire(scene, origin, { radius: 3, color: 0x44ffff, style: 'voxel', seed: 1, preset: 'emp' });
    const mesh = (group: THREE.Group, name: string) => group.getObjectByName(name) as THREE.InstancedMesh;
    expect(mesh(blast.group, 'Explosion:fire').count).toBeGreaterThan(0);
    expect(mesh(emp.group, 'Explosion:fire').count).toBe(0); expect(mesh(emp.group, 'Explosion:smoke').count).toBe(0);
    v.dispose(); ExplosionVisual.disposeScene(scene);
});

test('lightning endpoints stay anchored, including vertical bolts, while coincident points stay finite', () => {
    const scene = new THREE.Scene(), v = new LightningVisual(scene, 'low-poly');
    const points = [new THREE.Vector3(0, 8, 0), origin, new THREE.Vector3(3, 0, 0)];
    v.rearm(points, DEFAULT_LIGHTNING_OPTIONS);
    const endpoints = v.group.getObjectByName('Lightning:endpoints') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
    for (const t of [0, 0.3, 0.8]) {
        v.setProgress(t);
        points.forEach((point, i) => { endpoints.getMatrixAt(i, matrix); expect(position.setFromMatrixPosition(matrix).distanceTo(point)).toBeLessThan(1e-6); });
    }
    v.rearm([origin, origin], DEFAULT_LIGHTNING_OPTIONS); expect(instances(v.group)).toBe(0);
    v.rearm(Array.from({ length: 9 }, (_, i) => new THREE.Vector3(i, i % 2, i)), { ...DEFAULT_LIGHTNING_OPTIONS, amount: 3, branches: 6 });
    expect(matrices(v.group).every(Number.isFinite)).toBe(true); v.dispose();
});

test('pooled handles cannot cancel a later spawn, and concurrent/retained slots stay bounded', () => {
    const scene = new THREE.Scene();
    const system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, maxActive: 2, maxRetained: 2 });
    const old = system.burst('sparks', origin); old.stop();
    const live = system.burst('smoke', origin); old.stop(); old.seek(1); expect(live.isAlive).toBe(true);
    system.explosion('plasma', origin); system.lightning(path); expect(live.isAlive).toBe(false);
    expect(system.stats.active).toBe(2); expect(system.stats.retained).toBe(2);
    for (let i = 0; i < 100; i++) { system.burst('magic', origin); system.update(10); }
    expect(system.stats.retained).toBeLessThanOrEqual(2);
    system.dispose(); ExplosionVisual.disposeScene(scene); expect(scene.children).toHaveLength(0);
    expect(() => system.burst('sparks', origin)).toThrow('disposed');
});

test('registry freezes on pause, catches up on long frames and tears down across world reloads', () => {
    const scene = new THREE.Scene();
    const system = getVisualEffects({ scene, getGameData: () => ({ artStyle: 'low-poly' }) } as Parameters<typeof getVisualEffects>[0]);
    expect(system.options.style).toBe('low-poly');
    const h = system.burst('sparks', origin); const before = matrices(scene);
    VisualEffects.updateScene(scene, 0); expect(matrices(scene)).toEqual(before); expect(h.isAlive).toBe(true);
    VisualEffects.updateScene(scene, 100); expect(h.isAlive).toBe(false);
    VisualEffects.disposeScene(scene); ExplosionVisual.disposeScene(scene); expect(scene.children).toHaveLength(0);
    expect(VisualEffects.forScene(scene)).not.toBe(system); VisualEffects.disposeScene(scene);
});

test('playback is independent of frame partition and invalid input does not consume a live slot', () => {
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const systems = scenes.map(scene => new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS));
    systems.forEach(s => { s.burst('smoke', origin, { seed: 8 }); s.lightning(path, { seed: 5 }); s.explosion('fireball', origin, { seed: 2 }); });
    systems[0]!.update(0.25); for (let i = 0; i < 5; i++) systems[1]!.update(0.05);
    expect(matrices(scenes[0]!)).toEqual(matrices(scenes[1]!));
    const count = systems[0]!.stats.active;
    expect(() => systems[0]!.burst('sparks', origin, { amount: NaN })).toThrow('finite');
    expect(() => systems[0]!.lightning(path, { width: Infinity })).toThrow('finite');
    expect(() => systems[0]!.explosion('blast', origin, { layers: { fire: NaN } })).toThrow('finite');
    expect(systems[0]!.stats.active).toBe(count);
    systems.forEach(s => s.dispose()); scenes.forEach(s => ExplosionVisual.disposeScene(s));
});

test('legacy impact bursts now accept deterministic seeds, zero particles and bounded counts', () => {
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const systems = scenes.map(scene => new AttackVFX(scene, { seed: 10, drag: 2 }));
    systems.forEach(s => s.createImpactEffect(origin, new THREE.Vector3(0, 1, 0)));
    systems[0]!.update(0.2); systems[1]!.update(0.1); systems[1]!.update(0.1);
    expect(matrices(scenes[0]!)).toEqual(matrices(scenes[1]!));
    systems[0]!.updateImpactConfig({ particleCount: 100000 }); expect(systems[0]!.getImpactConfig().particleCount).toBe(256);
    systems[0]!.updateImpactConfig({ particleCount: 0 }); systems[0]!.createImpactEffect(origin, origin);
    systems.forEach(s => s.dispose()); scenes.forEach(s => ShaderKeepAlive.for(s).dispose());
});

test('sustained emitters follow elapsed time, move future births, stop and survive long hitches with bounded catch-up', () => {
    const scene = new THREE.Scene();
    const system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, maxEmitters: 1, maxActive: 10, maxRetained: 3 });
    const smoke = system.emit('smoke', origin, { interval: 0.2, burst: { seed: 42, duration: 2 } });
    system.update(0); expect(system.stats.active).toBe(1);
    smoke.moveTo(new THREE.Vector3(10, 0, 0)); system.update(0.2); expect(system.stats.active).toBe(2);
    expect(scene.children.some(child => child.position.x === 10 && child.visible)).toBe(true);
    const flame = system.emit('flame', origin, { interval: 0.1, duration: 1 });
    expect(smoke.isAlive).toBe(false); expect(flame.isAlive).toBe(true);
    system.update(0.3); expect(system.stats.emitters).toBe(1);
    system.update(100); expect(flame.isAlive).toBe(false); expect(system.stats.active).toBe(0);
    expect(system.stats.retained).toBeLessThanOrEqual(3);
    const endless = system.emit('embers', origin, { interval: 0.025 });
    system.update(100); expect(system.stats.active).toBeLessThanOrEqual(4);
    endless.stop(); system.update(10); expect(system.stats.emitters).toBe(0); expect(system.stats.active).toBe(0);
    const reset = system.emit('smoke', origin); system.clear(); expect(reset.isAlive).toBe(false);
    system.dispose(); expect(scene.children).toHaveLength(0);
});

test('material impacts keep debris opaque and off the bloom layer while reusing matching buffers', () => {
    const scene = new THREE.Scene();
    const system = new AttackVFX(scene, { material: 'debris', seed: 0 });
    system.createImpactEffect(origin, new THREE.Vector3(0, 1, 0));
    const mesh = scene.getObjectByName('AttackParticles') as THREE.InstancedMesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((mesh.material as THREE.Material).transparent).toBe(false);
    expect(mesh.layers.isEnabled(1)).toBe(false);
    system.update(1); system.createImpactEffect(origin, new THREE.Vector3(0, 1, 0));
    expect(scene.getObjectByName('AttackParticles')).toBe(mesh);
    system.dispose(); ShaderKeepAlive.for(scene).dispose();
});

test('load-time preparation retains hidden representatives without advancing the gameplay random sequence', () => {
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const systems = scenes.map(scene => new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS));
    systems[0]!.prepare(); systems[0]!.prepare();
    expect(systems[0]!.stats.active).toBe(0);
    expect(systems[0]!.stats.retained).toBe(7);
    expect(scenes[0]!.children.every(child => !child.visible)).toBe(true);
    systems.forEach(s => s.burst('sparks', origin)); systems.forEach(s => s.update(0.2));
    const active = scenes.map(scene => scene.children.find(child => child.visible)!);
    expect(matrices(active[0]!)).toEqual(matrices(active[1]!));
    systems.forEach(s => s.dispose()); scenes.forEach(s => ExplosionVisual.disposeScene(s));
});

test('inward explosions contract before the delayed flash; column and disk silhouettes stay distinct', () => {
    const scene = new THREE.Scene(), matrix = new THREE.Matrix4(), point = new THREE.Vector3();
    const v = ExplosionVisual.acquire(scene, origin, { radius: 2, color: 0xffffff, style: 'low-poly', seed: 0, preset: 'implosion', variance: 0 });
    const debris = v.group.getObjectByName('Explosion:debris') as THREE.InstancedMesh;
    const meanDistance = () => {
        let distance = 0;
        for (let i = 0; i < debris.count; i++) { debris.getMatrixAt(i, matrix); distance += point.setFromMatrixPosition(matrix).length(); }
        return distance / debris.count;
    };
    v.setProgress(0.15); const outer = meanDistance();
    expect(v.group.getObjectByName('Explosion:flash')!.visible).toBe(false);
    v.setProgress(0.6); expect(meanDistance()).toBeLessThan(outer * 0.3);
    v.setProgress(0.73); expect(v.group.getObjectByName('Explosion:flash')!.visible).toBe(true);
    v.release();
    for (const preset of ['volcanic', 'napalm'] as const) {
        const effect = ExplosionVisual.acquire(scene, origin, { radius: 2, color: 0xffffff, style: 'low-poly', seed: 0, preset });
        effect.setProgress(0.3);
        const fire = effect.group.getObjectByName('Explosion:fire') as THREE.InstancedMesh;
        let horizontal = 0, vertical = 0;
        for (let i = 0; i < fire.count; i++) {
            fire.getMatrixAt(i, matrix); point.setFromMatrixPosition(matrix); horizontal += Math.hypot(point.x, point.z); vertical += point.y;
        }
        if (preset === 'volcanic') expect(vertical).toBeGreaterThan(horizontal * 2);
        else expect(vertical).toBeLessThan(horizontal * 0.3);
        effect.release();
    }
    ExplosionVisual.disposeScene(scene);
});

test('new burst motions fall, rise, and keep a directed shockwave aligned with its surface', () => {
    const scene = new THREE.Scene(), v = new BurstVisual(scene, 'low-poly');
    const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
    for (const preset of ['leaves', 'snowflakes', 'tornado', 'bubbles'] as const) {
        v.rearm(origin, { ...DEFAULT_BURST_OPTIONS, preset, variance: 0 });
        const mesh = v.group.getObjectByName('Burst:solid') as THREE.InstancedMesh;
        v.setProgress(0.2); mesh.getMatrixAt(0, matrix); const start = point.setFromMatrixPosition(matrix).y;
        v.setProgress(0.5); mesh.getMatrixAt(0, matrix); const end = point.setFromMatrixPosition(matrix).y;
        if (preset === 'leaves' || preset === 'snowflakes') expect(end).toBeLessThan(start);
        else expect(end).toBeGreaterThan(start);
    }
    v.rearm(origin, { ...DEFAULT_BURST_OPTIONS, preset: 'shockwave', direction: new THREE.Vector3(1, 0, 0) });
    v.setProgress(0.35);
    const ring = v.group.getObjectByName('Burst:ring')!;
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-6);
    expect(ring.position.x).toBeCloseTo(0.025); expect(ring.position.y).toBeCloseTo(0);
    v.dispose();
});

test('animated beam trunks stay attached and the railgun pulse travels toward the target', () => {
    const scene = new THREE.Scene(), v = new LightningVisual(scene, 'low-poly'), matrix = new THREE.Matrix4();
    const points = [new THREE.Vector3(0, 6, 0), new THREE.Vector3(0, 0, 0)];
    for (const preset of Object.keys(LIGHTNING_PRESETS) as LightningPreset[]) {
        v.rearm(points, { ...DEFAULT_LIGHTNING_OPTIONS, preset, branches: 0 });
        const core = v.group.getObjectByName('Lightning:core') as THREE.InstancedMesh;
        for (const t of [0.1, 0.4, 0.75]) {
            v.setProgress(t);
            core.getMatrixAt(0, matrix);
            expect(new THREE.Vector3(0, -0.5 / 1.025, 0).applyMatrix4(matrix).distanceTo(points[0]!)).toBeLessThan(1e-5);
            core.getMatrixAt(core.count - 1, matrix);
            expect(new THREE.Vector3(0, 0.5 / 1.025, 0).applyMatrix4(matrix).distanceTo(points[1]!)).toBeLessThan(1e-5);
        }
    }
    v.rearm(points, { ...DEFAULT_LIGHTNING_OPTIONS, preset: 'railgun' });
    const core = v.group.getObjectByName('Lightning:core') as THREE.InstancedMesh, scale = new THREE.Vector3();
    const widestSegment = (t: number) => {
        v.setProgress(t); let widest = 0, index = 0;
        for (let i = 0; i < core.count; i++) {
            core.getMatrixAt(i, matrix); scale.setFromMatrixScale(matrix);
            if (scale.x > widest) { widest = scale.x; index = i; }
        }
        return index;
    };
    expect(widestSegment(0.45)).toBeGreaterThan(widestSegment(0.15) + 8);
    for (const preset of Object.keys(LIGHTNING_PRESETS) as LightningPreset[]) {
        v.rearm(Array.from({ length: 9 }, (_, i) => new THREE.Vector3(i, i % 2, i)), { ...DEFAULT_LIGHTNING_OPTIONS, preset, amount: 3, branches: 6 });
        expect(matrices(v.group).every(Number.isFinite)).toBe(true);
    }
    v.dispose();
});

test.each(Object.entries(IMPACT_EFFECT_PRESETS))('%s impacts remain finite, use the intended material and retire', (_name, config) => {
    const scene = new THREE.Scene(), system = new AttackVFX(scene, { ...config, seed: 0 });
    system.createImpactEffect(origin, new THREE.Vector3(0, 1, 0));
    const mesh = scene.getObjectByName('AttackParticles') as THREE.InstancedMesh;
    expect(mesh.count).toBe(config.particleCount);
    expect((mesh.material as THREE.Material).transparent).toBe(config.material === 'spark');
    for (let i = 0; i < 4; i++) { system.update(config.duration * 0.2); expect(matrices(scene).every(Number.isFinite)).toBe(true); }
    system.update(config.duration); expect(mesh.visible).toBe(false);
    system.dispose(); ShaderKeepAlive.for(scene).dispose(); expect(scene.children).toHaveLength(0);
});
