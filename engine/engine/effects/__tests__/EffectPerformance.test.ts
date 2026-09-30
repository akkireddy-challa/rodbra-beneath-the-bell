import * as THREE from 'three';
import { VisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS } from 'engine/effects/VisualEffects.js';
import { DEFAULT_EFFECT_SHAPE_OPTIONS } from 'engine/effects/EffectShapes.js';
import { ShieldVisual } from 'engine/effects/ShieldVisual.js';
import { SurfaceVisual } from 'engine/effects/SurfaceVisual.js';
import { RibbonTrailVisual, DEFAULT_TRAIL_OPTIONS } from 'engine/effects/RibbonTrailVisual.js';

test('tracked beams upload one frame of matrices and still follow moving endpoints', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS);
    const source = new THREE.Vector3(), target = new THREE.Vector3(4, 2, 0);
    const handle = system.continuousBeam(source, target, 'tractor-beam');
    const core = scene.getObjectByName('Lightning:core') as THREE.InstancedMesh;
    const endpoints = scene.getObjectByName('Lightning:endpoints') as THREE.InstancedMesh;
    const version = core.instanceMatrix.version;
    target.set(2, 5, 1); system.update(1 / 60);
    expect(core.instanceMatrix.version).toBe(version + 1);
    expect(core.instanceMatrix.updateRanges).toEqual([{ start: 0, count: core.count * 16 }]);
    const matrix = new THREE.Matrix4(); endpoints.getMatrixAt(1, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual(target.toArray());
    const moved = Array.from(core.instanceMatrix.array); handle.seek(0.5);
    expect(Array.from(core.instanceMatrix.array)).not.toEqual(moved);
    handle.stop(); system.continuousBeam(source, target, 'laser', { width: 0.3 });
    expect(core.visible).toBe(true); expect(core.count).toBe(1);
    expect(core.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]); system.dispose();
});

test('managed trails upload once per step and smoke skips the hidden ribbon', () => {
    const scene = new THREE.Scene(), system = new VisualEffects(scene, DEFAULT_VISUAL_EFFECTS_OPTIONS), at = new THREE.Vector3();
    system.trail('ribbon', at);
    const ribbon = scene.getObjectByName('Trail:mesh') as THREE.Mesh;
    const position = ribbon.geometry.getAttribute('position') as THREE.BufferAttribute, version = position.version;
    at.x = 2; system.update(0.2); expect(position.version).toBe(version + 1); expect(ribbon.geometry.drawRange.count).toBeGreaterThan(0);
    system.dispose();
    const smoke = new RibbonTrailVisual(scene);
    smoke.rearm('smoke-trail', at, DEFAULT_TRAIL_OPTIONS);
    const hidden = smoke.group.getObjectByName('Trail:mesh') as THREE.Mesh;
    const puffs = smoke.group.getObjectByName('Trail:smoke') as THREE.InstancedMesh;
    const hiddenVersion = (hidden.geometry.getAttribute('position') as THREE.BufferAttribute).version;
    smoke.advance(0.2, new THREE.Vector3(3, 0, 0));
    expect((hidden.geometry.getAttribute('position') as THREE.BufferAttribute).version).toBe(hiddenVersion);
    expect(puffs.visible).toBe(true); expect(puffs.count).toBeGreaterThan(1); smoke.dispose();
});

test('shield panels stay cached while opacity animates and rearming refreshes their size', () => {
    const scene = new THREE.Scene(), shield = new ShieldVisual(scene, 'low-poly');
    shield.rearm('hex-shield', new THREE.Vector3(), DEFAULT_EFFECT_SHAPE_OPTIONS);
    const panels = shield.group.getObjectByName('Shield:panels') as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const version = panels.instanceMatrix.version, opacity = panels.material.opacity, before = Array.from(panels.instanceMatrix.array);
    shield.setProgress(0.25); expect(panels.material.opacity).not.toBe(opacity); expect(panels.instanceMatrix.version).toBe(version);
    shield.rearm('hex-shield', new THREE.Vector3(), { ...DEFAULT_EFFECT_SHAPE_OPTIONS, radius: 3 });
    expect(Array.from(panels.instanceMatrix.array)).not.toEqual(before);
    shield.rearm('shield-break', new THREE.Vector3(), DEFAULT_EFFECT_SHAPE_OPTIONS);
    const breakingVersion = panels.instanceMatrix.version; shield.setProgress(0.25);
    expect(panels.instanceMatrix.version).toBe(breakingVersion + 1); shield.dispose();
});

test('surface caches retain fading, splash growth, scrubbing and pooled reseeding', () => {
    const scene = new THREE.Scene(), mark = new SurfaceVisual(scene, 'low-poly');
    mark.rearm('scorch', new THREE.Vector3(), DEFAULT_EFFECT_SHAPE_OPTIONS);
    const patches = mark.group.getObjectByName('Surface:patches') as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const version = patches.instanceMatrix.version, opacity = patches.material.opacity, before = Array.from(patches.instanceMatrix.array);
    mark.setProgress(0.9); expect(patches.material.opacity).toBeLessThan(opacity); expect(patches.instanceMatrix.version).toBe(version);
    mark.rearm('scorch', new THREE.Vector3(), { ...DEFAULT_EFFECT_SHAPE_OPTIONS, seed: 41 });
    expect(Array.from(patches.instanceMatrix.array)).not.toEqual(before);
    mark.rearm('wet-splash', new THREE.Vector3(), DEFAULT_EFFECT_SHAPE_OPTIONS);
    const small = Array.from(patches.instanceMatrix.array); mark.setProgress(0.2);
    expect(Array.from(patches.instanceMatrix.array)).not.toEqual(small);
    mark.setProgress(0); expect(Array.from(patches.instanceMatrix.array)).toEqual(small); mark.dispose();
});
