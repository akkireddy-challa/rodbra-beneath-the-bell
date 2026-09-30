import * as THREE from 'three';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS } from 'engine/effects/VisualEffects.js';
import { CustomEffectVisual, DEFAULT_CUSTOM_EFFECT_OPTIONS, type CustomEffectOptions, type CustomEffectDefinition } from 'engine/effects/CustomEffectVisual.js';
import { BURST_PRESETS, burstRecipe } from 'engine/effects/BurstPresets.js';
import { EXPLOSION_PRESETS, explosionRecipe } from 'engine/effects/ExplosionPresets.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
// Execute the copyable docs sample itself; it is outside engine aliases and production bundles.
// eslint-disable-next-line no-restricted-imports
import { runeHalo } from '../../../../agent-docs/samples/custom-visual-effect.js';

const at = new THREE.Vector3();
const options = { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, quality: 'high' as const };
function finish(system: VisualEffects, scene: THREE.Scene): void { system.dispose(); ExplosionVisual.disposeScene(scene); }
function matrices(scene: THREE.Object3D): number[] {
    const values: number[] = [];
    scene.traverseVisible(child => { if (child instanceof THREE.InstancedMesh) values.push(...child.instanceMatrix.array.slice(0, child.count * 16)); });
    return values;
}

test('recipe adaptations are copied, bounded and never mutate shared presets', () => {
    const before = JSON.stringify([BURST_PRESETS, EXPLOSION_PRESETS]);
    const overrides = { count: 9, color: 0x123456, motion: 'float' as const };
    const adapted = burstRecipe('magic', overrides); overrides.count = 100;
    expect(adapted.count).toBe(9); expect(adapted.motion).toBe('float');
    expect(burstRecipe('sparks', { count: 1e5, birthWindow: 4 }).count).toBe(256);
    expect(explosionRecipe('blast', { motion: 'inward', ringColor: 0xabcdef }).motion).toBe('inward');
    expect(JSON.stringify([BURST_PRESETS, EXPLOSION_PRESETS])).toBe(before);
    expect(() => burstRecipe('magic', { speed: NaN })).toThrow('finite');
    expect(() => explosionRecipe('blast', { smokeColor: Infinity })).toThrow('finite');
    expect(() => burstRecipe('bad' as 'sparks', {})).toThrow('Unknown');
    expect(() => burstRecipe('magic', { motion: 'bad' as 'cone' })).toThrow('motion');
    expect(() => explosionRecipe('blast', { motion: 'bad' as 'disk' })).toThrow('motion');
});

test.each(['voxel', 'low-poly'] as const)('adapted primitives seek deterministically and replay the built-in recipe in %s', style => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...options, style });
    const burst = system.burst('magic', at, { recipe: { count: 9, motion: 'fall', duration: 2, endColor: 0x123456 }, seed: 0 });
    const glow = scene.getObjectByName('Burst:glow') as THREE.InstancedMesh;
    expect(glow.count).toBe(9);
    burst.seek(0.3); const first = matrices(scene); burst.seek(0.8); burst.seek(0.3);
    expect(matrices(scene)).toEqual(first); expect(first.every(Number.isFinite)).toBe(true);
    system.update(1); expect(burst.isAlive).toBe(true); system.update(0.5); expect(burst.isAlive).toBe(false);
    system.burst('magic', at); expect(glow.count).toBe(BURST_PRESETS.magic.count);
    const explosion = system.explosion('blast', at, { recipe: { fire: 0, smoke: 3, sparks: 0, debris: 0, duration: 3 }, seed: 0 });
    expect((scene.getObjectByName('Explosion:smoke') as THREE.InstancedMesh).count).toBe(3);
    expect((scene.getObjectByName('Explosion:fire') as THREE.InstancedMesh).count).toBe(0);
    explosion.seek(0.3); const adapted = matrices(scene); explosion.seek(0.8); explosion.seek(0.3);
    expect(matrices(scene)).toEqual(adapted); finish(system, scene);
});

test('top-level color/duration win over recipe defaults and invalid recipes do not evict live effects', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...options, maxActive: 1 });
    const burst = system.burst('magic', at, { recipe: { color: 0xff0000, duration: 3 }, color: 0x00ff00, duration: 1 });
    expect((scene.getObjectByName('Burst:ring') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.getHex()).toBe(0x00ff00);
    expect(() => system.burst('magic', at, { recipe: { count: Infinity } })).toThrow();
    expect(burst.isAlive).toBe(true); system.update(1); expect(burst.isAlive).toBe(false);
    finish(system, scene);
});

test('emitters snapshot adapted recipes and use their duration when catching up', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, options);
    const recipe = { duration: 4, count: 7 };
    system.emit('sparks', at, { interval: 2, burst: { recipe } }); recipe.count = 100;
    system.update(5);
    // Births at 2s and 4s are both alive under the adapted 4s lifetime.
    expect(system.stats.active).toBe(2);
    const counts: number[] = [];
    scene.traverseVisible(child => { if (child.name === 'Burst:glow') counts.push((child as THREE.InstancedMesh).count); });
    expect(counts).toEqual([7, 7]); finish(system, scene);
});

test('an adapted flame retains only its opaque hot layer after reusing a solid burst', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, options);
    system.burst('dust', at).stop();
    const flame = system.burst('flame', at, { recipe: { glow: false, count: 7 } });
    flame.seek(0.3);
    const particles: THREE.InstancedMesh[] = [];
    scene.traverseVisible(child => { if (child instanceof THREE.InstancedMesh && child.count > 0) particles.push(child); });
    expect(particles.map(mesh => mesh.name)).toEqual(['Burst:flame']);
    expect(particles[0]!.count).toBe(7);
    expect(matrices(scene).every(Number.isFinite)).toBe(true);
    finish(system, scene);
});

class ProbeVisual extends CustomEffectVisual<CustomEffectOptions> {
    progress = -1;
    received: Readonly<CustomEffectOptions> | null = null;
    constructor(scene: THREE.Scene) { super(scene, 'Probe'); }
    rearm(position: THREE.Vector3, config: Readonly<CustomEffectOptions>): void { this.received = config; this.group.position.copy(position); }
    setProgress(t: number): void { this.progress = t; this.group.visible = t < 1; }
}
function probe(created: ProbeVisual[]): CustomEffectDefinition<CustomEffectOptions> {
    return { defaults: DEFAULT_CUSTOM_EFFECT_OPTIONS, create: scene => { const visual = new ProbeVisual(scene); created.push(visual); return visual; } };
}

test('custom effects follow parented targets, pause, loop, seek and reset on the engine-owned scene lifecycle', () => {
    const scene = new THREE.Scene(), system = VisualEffects.forScene(scene, options), created: ProbeVisual[] = [];
    const parent = new THREE.Group(), target = new THREE.Object3D(); parent.add(target); scene.add(parent);
    const definition = probe(created), handle = system.custom(definition, target, { loop: true, duration: 2 });
    const visual = created[0]!; parent.position.set(3, 2, 1);
    VisualEffects.updateScene(scene, 0); expect(visual.progress).toBe(0); expect(visual.group.position.x).toBe(0);
    VisualEffects.updateScene(scene, 5); expect(visual.progress).toBe(0.5); expect(handle.isAlive).toBe(true);
    expect(visual.group.position.toArray()).toEqual([3, 2, 1]);
    handle.seek(0.25); expect(visual.progress).toBe(0.25);
    handle.moveTo(new THREE.Vector3(9, 8, 7)); expect(visual.group.position.toArray()).toEqual([9, 8, 7]);
    VisualEffects.clearScene(scene); expect(handle.isAlive).toBe(false); expect(visual.group.visible).toBe(false);
    VisualEffects.disposeScene(scene); expect(scene.children).toEqual([parent]);
});

test('custom pool keys include definition and style, and stale handles cannot affect a reused slot', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, options), created: ProbeVisual[] = [];
    const a = probe(created), b = probe(created);
    const old = system.custom(a, at, { seed: 0 }); old.stop();
    const current = system.custom(a, at, { seed: 1 }); old.stop(); old.seek(1); old.moveTo(new THREE.Vector3(9, 9, 9));
    expect(created).toHaveLength(1); expect(current.isAlive).toBe(true); expect(created[0]!.group.position.toArray()).toEqual([0, 0, 0]);
    current.stop(); system.custom(b, at).stop(); system.custom(a, at, { style: 'low-poly' }).stop();
    expect(created).toHaveLength(3); expect(created[0]!.received?.quality).toBe('high');
    finish(system, scene); expect(scene.children).toHaveLength(0);
});

test('custom effects share built-in concurrency/retention limits and clean up failed rearming', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...options, maxActive: 1, maxRetained: 1 });
    const created: ProbeVisual[] = [], a = probe(created), b = probe(created);
    const first = system.custom(a, at); const second = system.custom(b, at);
    expect(first.isAlive).toBe(false); expect(scene.children).toHaveLength(1); expect(system.stats.retained).toBe(1);
    system.burst('magic', at); expect(second.isAlive).toBe(false);
    const broken = { ...a, create: (owner: THREE.Scene) => {
        const visual = new ProbeVisual(owner); visual.rearm = () => { throw new Error('bad custom configuration'); }; return visual;
    } };
    expect(() => system.custom(broken, at)).toThrow('bad custom configuration');
    expect(system.stats.active).toBe(0); expect(scene.children).toHaveLength(0); finish(system, scene);
});

test.each(['voxel', 'low-poly'] as const)('the copyable custom sample is deterministic, bounded and reusable in %s', style => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...options, style });
    const handle = system.custom(runeHalo, at, { seed: 0, amount: 3, turns: -1 });
    for (const t of [0, 0.2, 0.8]) { handle.seek(t); expect(matrices(scene).every(Number.isFinite)).toBe(true); }
    handle.seek(0.2); const before = matrices(scene); handle.seek(0.7); handle.seek(0.2); expect(matrices(scene)).toEqual(before);
    handle.stop(); system.custom(runeHalo, at, { seed: 1, quality: 'low' });
    expect(system.stats.retained).toBe(1); const mesh = scene.getObjectByName('RuneHalo:runes') as THREE.InstancedMesh;
    expect(mesh.count).toBeLessThan(24); finish(system, scene); expect(scene.children).toHaveLength(0);
});
