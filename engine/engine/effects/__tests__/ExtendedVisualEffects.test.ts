import * as THREE from 'three';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS } from 'engine/effects/VisualEffects.js';
import { DEFAULT_EFFECT_SHAPE_OPTIONS } from 'engine/effects/EffectShapes.js';
import { FireVisual, FIRE_PRESETS, type FirePreset } from 'engine/effects/FireVisual.js';
import { ShieldVisual, SHIELD_PRESETS, type ShieldPreset } from 'engine/effects/ShieldVisual.js';
import { SurfaceVisual, SURFACE_PRESETS, type SurfacePreset } from 'engine/effects/SurfaceVisual.js';
import { RibbonTrailVisual, DEFAULT_TRAIL_OPTIONS } from 'engine/effects/RibbonTrailVisual.js';
import { TransitionVisual, TRANSITION_PRESETS, type TransitionPreset } from 'engine/effects/TransitionVisual.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';

const origin = new THREE.Vector3();
function matrices(group: THREE.Object3D): number[] {
    const result: number[] = [];
    group.traverse(child => { if (child instanceof THREE.InstancedMesh) result.push(...child.instanceMatrix.array.slice(0, child.count * 16)); });
    return result;
}
function target(scene: THREE.Scene): THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial> {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshLambertMaterial({ color: 0x77aaff })); scene.add(mesh); return mesh;
}
test.each(['voxel', 'low-poly'] as const)('new shapes remain finite and seek deterministically in %s', style => {
    const scene = new THREE.Scene(), options = { ...DEFAULT_EFFECT_SHAPE_OPTIONS, style, amount: 3, seed: 0, quality: 'high' as const };
    const fire = new FireVisual(scene, style), shield = new ShieldVisual(scene, style), surface = new SurfaceVisual(scene, style);
    const transition = new TransitionVisual(scene, style), object = target(scene);
    const check = (visual: { group: THREE.Group; setProgress(t: number): void }) => {
        for (const t of [0, 0.2, 0.6, 1]) { visual.setProgress(t); expect(matrices(visual.group).every(Number.isFinite)).toBe(true); }
        visual.setProgress(0.3); const before = matrices(visual.group); visual.setProgress(0.8); visual.setProgress(0.3); expect(matrices(visual.group)).toEqual(before);
    };
    for (const preset of Object.keys(FIRE_PRESETS) as FirePreset[]) { fire.rearm(preset, origin, options); check(fire); }
    for (const preset of Object.keys(SHIELD_PRESETS) as ShieldPreset[]) { shield.rearm(preset, origin, options); check(shield); }
    for (const preset of Object.keys(SURFACE_PRESETS) as SurfacePreset[]) { surface.rearm(preset, origin, options); check(surface); }
    for (const preset of Object.keys(TRANSITION_PRESETS) as TransitionPreset[]) { transition.rearm(preset, object, options); check(transition); transition.retire(); }
    fire.dispose(); shield.dispose(); surface.dispose(); transition.dispose(); object.removeFromParent(); object.geometry.dispose(); object.material.dispose();
    expect(scene.children).toHaveLength(0);
});

test('persistent fire and shields follow world transforms, pause and clean up on scene reset', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const parent = new THREE.Group(), attachment = new THREE.Object3D(); scene.add(parent); parent.add(attachment);
    const fire = system.fire('torch', attachment), shield = system.shield('bubble', attachment);
    parent.position.set(4, 2, -1); system.update(0.2);
    expect(scene.getObjectByName('Fire:torch')!.position.toArray()).toEqual([4, 2, -1]);
    const before = matrices(scene); parent.position.x = 8; system.update(0); expect(matrices(scene)).toEqual(before);
    expect(scene.getObjectByName('Fire:torch')!.position.x).toBe(4);
    system.update(100); expect(fire.isAlive).toBe(true); expect(shield.isAlive).toBe(true);
    expect(scene.getObjectByName('Shield:bubble')!.position.x).toBe(8);
    system.clear(); expect(fire.isAlive).toBe(false); expect(shield.isAlive).toBe(false);
    const next = system.fire('campfire', origin); fire.setDirection(new THREE.Vector3(1, 0, 0)); fire.stop(); expect(next.isAlive).toBe(true);
    system.dispose(); expect(scene.children).toEqual([parent]);
});

test('continuous beams stay attached to parented moving targets beyond the original pulse lifetime', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const parent = new THREE.Group(), source = new THREE.Object3D(), end = new THREE.Vector3(5, 1, 0);
    parent.add(source); scene.add(parent);
    const beam = system.continuousBeam(source, end, 'tractor-beam');
    parent.position.set(1, 3, 0); end.set(5, 4, 2); system.update(8.2);
    const mesh = scene.getObjectByName('Lightning:endpoints') as THREE.InstancedMesh, matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix); expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([1, 3, 0]);
    mesh.getMatrixAt(1, matrix); expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([5, 4, 2]);
    expect(beam.isAlive).toBe(true); expect(mesh.parent!.visible).toBe(true);
    beam.setEndpoints(origin, new THREE.Vector3(0, 8, 0));
    mesh.getMatrixAt(1, matrix); expect(new THREE.Vector3().setFromMatrixPosition(matrix).y).toBe(8);
    beam.stop(); const next = system.continuousBeam(origin, end); beam.stop(); beam.setEndpoints(origin, origin); expect(next.isAlive).toBe(true);
    system.dispose();
});

test('shield hits align to contact normals and breaking replaces the shell with expiring fragments', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const shield = system.shield('hex-shield', origin, { radius: 2 });
    const hit = shield.hit(new THREE.Vector3(2, 0, 0));
    const ripple = scene.getObjectByName('Shield:hit-ripple')!;
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(ripple.quaternion).x).toBeCloseTo(1);
    const fragments = shield.break(); expect(shield.isAlive).toBe(false); expect(fragments?.isAlive).toBe(true);
    system.update(2); expect(hit?.isAlive).toBe(false); expect(fragments?.isAlive).toBe(false); system.dispose();
});

test('surface marks sit above their supplied plane, persist on request and expire by gameplay time', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const mark = system.surface('scorch', origin, { direction: new THREE.Vector3(1, 0, 0), duration: 0 });
    const group = scene.getObjectByName('Surface:scorch')!;
    expect(group.position.x).toBeCloseTo(0.012); expect(new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion).x).toBeCloseTo(1);
    const ripple = system.surface('ripples', origin); system.update(100); expect(mark.isAlive).toBe(true); expect(ripple.isAlive).toBe(false);
    system.dispose();
});

test('trails use bounded history, match linear paths across frame partitions, and reset across teleports', () => {
    const scenes = [new THREE.Scene(), new THREE.Scene()], trails = scenes.map(scene => new RibbonTrailVisual(scene));
    trails.forEach(v => v.rearm('ribbon', origin, { ...DEFAULT_TRAIL_OPTIONS, lifetime: 1, teleportDistance: 20 }));
    trails[0]!.advance(0.5, new THREE.Vector3(2, 0, 0));
    for (let i = 1; i <= 5; i++) trails[1]!.advance(0.1, new THREE.Vector3(i * 0.4, 0, 0));
    const positions = trails.map(v => ((v.group.getObjectByName('Trail:mesh') as THREE.Mesh).geometry.getAttribute('position').array));
    expect(trails[0]!.sampleCount).toBe(trails[1]!.sampleCount);
    for (let i = 0; i < trails[0]!.sampleCount * 12; i++) expect(positions[0]![i]).toBeCloseTo(positions[1]![i]!, 5);
    trails[0]!.advance(100, new THREE.Vector3(3, 0, 0)); expect(trails[0]!.sampleCount).toBeLessThanOrEqual(96);
    trails[0]!.advance(0.1, new THREE.Vector3(100, 0, 0)); expect(trails[0]!.sampleCount).toBe(1);
    trails.forEach(v => { v.stopEmission(); v.advance(2, new THREE.Vector3(100, 0, 0)); expect(v.isFinished).toBe(true); v.dispose(); });
});

test('trail handles stop future samples and allow the tail to finish without stale-handle interference', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS), at = new THREE.Vector3();
    const trail = system.trail('missile', at); at.x = 1; system.update(0.2); trail.stop();
    expect(trail.isAlive).toBe(true); system.update(1); expect(trail.isAlive).toBe(false);
    const next = system.trail('ribbon', at); trail.clear(); trail.stop(); expect(next.isAlive).toBe(true);
    system.dispose(); expect(scene.children).toHaveLength(0);
});

test('a finite trail emits up to its duration even when a frame crosses the stopping time', () => {
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const systems = scenes.map(scene => new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS));
    const points = [new THREE.Vector3(), new THREE.Vector3()];
    systems.forEach((system, i) => system.trail('ribbon', points[i]!, { duration: 0.3, lifetime: 1, seed: 0 }));
    points[0]!.x = 2; systems[0]!.update(0.5);
    for (let i = 1; i <= 5; i++) { points[1]!.x = i * 0.4; systems[1]!.update(0.1); }
    const meshes = scenes.map(scene => scene.getObjectByName('Trail:mesh') as THREE.Mesh);
    expect(meshes[0]!.geometry.drawRange.count).toBeGreaterThan(0);
    expect(meshes[0]!.geometry.drawRange.count).toBe(meshes[1]!.geometry.drawRange.count);
    const positions = meshes.map(mesh => mesh.geometry.getAttribute('position').array);
    for (let i = 0; i < positions[0]!.length; i++) expect(positions[0]![i]).toBeCloseTo(positions[1]![i]!, 5);
    systems.forEach(system => system.dispose());
});

test('invalid transition targets do not evict live effects or change game materials', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, maxActive: 1 });
    const fire = system.fire('torch', origin), object = target(scene), original = object.material;
    object.position.x = NaN;
    expect(() => system.transition('dissolve', object)).toThrow(/finite/);
    expect(fire.isAlive).toBe(true); expect(object.material).toBe(original);
    object.position.x = 0;
    const first = system.transition('spawn', object); first.stop(); original.color.setHex(0xff3322);
    system.transition('spawn', object); expect(object.material.color.getHex()).toBe(0xff3322);
    system.dispose(); object.geometry.dispose(); original.dispose();
});

test('transitions isolate shared materials, restore on cancellation and leave only the requested final visibility', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const object = target(scene), original = object.material, sibling = new THREE.Mesh(object.geometry, original); scene.add(sibling);
    const handle = system.transition('dissolve', object); system.update(0.75);
    expect(object.material).not.toBe(original); expect(object.material.alphaHash).toBe(true); expect(object.material.opacity).toBeLessThan(1);
    expect(sibling.material.opacity).toBe(1); expect(original.alphaHash).toBe(false);
    handle.stop(); expect(object.material).toBe(original); expect(object.visible).toBe(true);
    system.transition('dissolve', object); system.update(2); expect(object.visible).toBe(false); expect(object.material).toBe(original);
    system.transition('spawn', object); system.update(2); expect(object.visible).toBe(true); expect(object.material).toBe(original);
    const old = system.transition('teleport-out', object), incoming = system.transition('teleport-in', object);
    expect(old.isAlive).toBe(false); expect(incoming.isAlive).toBe(true); system.clear(); expect(object.material).toBe(original);
    system.dispose(); object.geometry.dispose(); original.dispose();
});

test('mixed persistent effects obey pool limits and world teardown restores transition targets', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, { ...DEFAULT_VISUAL_EFFECTS_OPTIONS, maxActive: 4, maxRetained: 4 }), object = target(scene);
    for (let i = 0; i < 30; i++) {
        system.fire('campfire', origin); system.shield('dome', origin); system.surface('puddle', origin);
        system.trail('magic-trail', origin); system.transition('despawn', object); system.continuousBeam(origin, new THREE.Vector3(0, 2, 0));
        system.update(0.2); expect(system.stats.active).toBeLessThanOrEqual(4); expect(system.stats.retained).toBeLessThanOrEqual(4);
    }
    system.dispose(); ExplosionVisual.disposeScene(scene); expect(object.visible).toBe(true); expect(object.material.alphaHash).toBe(false);
    expect(scene.children).toEqual([object]); object.geometry.dispose(); object.material.dispose();
});

test('legacy weapon trails use gameplay time and freeze when updates are paused', () => {
    const scene = new THREE.Scene(), hand = new THREE.Object3D(); hand.name = 'RightHand'; scene.add(hand);
    const system = new AttackVFX(scene); system.createAttackTrail(hand, 1, 'right-punch');
    for (let i = 0; i < 4; i++) { hand.position.x = i * 0.2; system.update(0.05); }
    const trail = scene.getObjectByName('AttackTrailMesh') as THREE.Mesh;
    const position = trail.geometry.getAttribute('position'), before = Array.from(position.array);
    jest.spyOn(Date, 'now').mockReturnValue(9999999999999); system.update(0); expect(Array.from(position.array)).toEqual(before);
    expect(trail.visible).toBe(true); system.update(2); expect(trail.visible).toBe(false); jest.restoreAllMocks();
    system.dispose(); ShaderKeepAlive.for(scene).dispose();
});
