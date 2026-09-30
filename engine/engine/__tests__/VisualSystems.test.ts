import * as THREE from 'three';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';
import { addCoastalDepthAttribute } from 'engine/water/CoastalDepthField.js';
import { createCoastalGroundSampler } from 'engine/water/CoastalGroundSampler.js';
import { bakeGroundMask } from 'engine/vxlscene/GroundMaskBaker.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import { resolveAtmosphereFog, resolveLightingConfig } from 'engine/LightingPresets.js';

test('explosion seeking is repeatable and released buffers are reused in the same scene', () => {
    const scene = new THREE.Scene();
    const options = { radius: 4, color: 0xff5a12, style: 'voxel' as const, seed: 73 };
    const first = ExplosionVisual.acquire(scene, new THREE.Vector3(), options);
    const matrices = (): number[] => first.group.children.flatMap(child => child instanceof THREE.InstancedMesh ? [...child.instanceMatrix.array] : []);
    first.setProgress(0.3); const snapshot = matrices();
    first.setProgress(0.9); first.setProgress(0.3);
    expect(matrices()).toEqual(snapshot);
    first.setProgress(1); expect(first.group.visible).toBe(false);
    first.setProgress(0.3); expect(first.group.visible).toBe(true);
    expect(matrices()).toEqual(snapshot);
    for (const kind of ['fire', 'smoke', 'debris']) {
        const mesh = first.group.getObjectByName(`Explosion:${kind}`) as THREE.InstancedMesh;
        expect((mesh.material as THREE.Material).transparent).toBe(false);
        expect((mesh.material as THREE.Material).depthWrite).toBe(true);
    }
    first.release();
    const second = ExplosionVisual.acquire(scene, new THREE.Vector3(), options);
    expect(second).toBe(first);
    second.setProgress(0.3); expect(matrices()).toEqual(snapshot);
    ExplosionVisual.disposeScene(scene);
    expect(scene.children).toHaveLength(0);
    second.release(); // an old projectile may be disposed after the world
});

test('impact particles have world-sized geometry and analytic motion independent of frame partition', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.37);
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const systems = scenes.map(scene => new AttackVFX(scene));
    try {
        systems.forEach(system => system.createImpactEffect(new THREE.Vector3(4, 2, 3), new THREE.Vector3(0, 1, 0)));
        systems[0]!.update(0.25);
        for (let i = 0; i < 5; i++) systems[1]!.update(0.05);
        const meshes = scenes.map(scene => scene.getObjectByName('AttackParticles') as THREE.InstancedMesh);
        expect(meshes[0]).toBeInstanceOf(THREE.InstancedMesh);
        expect([...meshes[0]!.instanceMatrix.array]).toEqual([...meshes[1]!.instanceMatrix.array]);
        systems[0]!.update(0.5);
        expect(meshes[0]!.visible).toBe(false);
        systems[0]!.createImpactEffect(new THREE.Vector3(), new THREE.Vector3());
        expect(scenes[0]!.getObjectByName('AttackParticles')).toBe(meshes[0]);
        expect([...meshes[0]!.instanceMatrix.array].every(Number.isFinite)).toBe(true);
    } finally {
        systems.forEach(system => system.dispose());
        scenes.forEach(scene => ShaderKeepAlive.for(scene).dispose());
        random.mockRestore();
    }
});

test('coastal depth respects translated worlds and the rotated plane orientation with bounded sampling', () => {
    const geometry = new THREE.PlaneGeometry(1000, 800, 160, 160);
    let queries = 0;
    addCoastalDepthAttribute(geometry, 300, 700, 12, (x, z) => { queries++; return 8 + (x - 300) * 0.001 + (z - 700) * 0.002; });
    expect(queries).toBe(161 * 161);
    const p = geometry.getAttribute('position'), depth = geometry.getAttribute('waterDepth');
    for (let i = 0; i < p.count; i++) expect(depth.getX(i)).toBeCloseTo(4 - p.getX(i) * 0.001 + p.getY(i) * 0.002, 4);
    geometry.dispose();
});

test('negative seabeds bypass the legacy saturated height mask instead of becoming dry land', () => {
    const triangle: RasterTriangle = { v0: [0, -5, 0], v1: [2, -5, 0], v2: [0, -5, 2],
        normal: [0, 1, 0], nodeName: 'seabed', sampleColor: () => ({ r: 1, g: 1, b: 1 }) };
    const bounds = { minX: 0, maxX: 2, minZ: 0, maxZ: 2, minY: -6, maxY: 1 };
    const mask = bakeGroundMask([triangle], { seabed: 1 }, bounds)!;
    const fallback = jest.fn(() => -5);
    const sampler = createCoastalGroundSampler(mask, bounds, fallback);
    expect(mask.topY[0]).toBe(1); // clipped unsigned data, not a real +0.05m surface
    expect(sampler(0.25, 0.25)).toBe(-5);
    expect(fallback).toHaveBeenCalledTimes(1);
    mask.topY[0] = 120;
    expect(sampler(0.25, 0.25)).toBe(6);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(sampler(-1, -1)).toBeNull();
});

test('a narrow channel on a large map keeps the depth resolved by the water mesh', () => {
    const geometry = new THREE.PlaneGeometry(1024, 128, 160, 32);
    addCoastalDepthAttribute(geometry, 0, 0, 0, x => x > 3 && x < 7 ? -3 : 3);
    const positions = geometry.getAttribute('position'), depth = geometry.getAttribute('waterDepth');
    let channelVertices = 0;
    for (let i = 0; i < positions.count; i++) if (positions.getX(i) > 3 && positions.getX(i) < 7) {
        expect(depth.getX(i)).toBe(3); channelVertices++;
    }
    expect(channelVertices).toBeGreaterThan(0);
    geometry.dispose();
});

test('a lighting preset preserves explicit zeroes and fog overrides, and clearing it restores legacy defaults', () => {
    const cfg = { preset: 'golden-hour' as const, sunIntensity: 0, ambientFloor: 0 };
    expect(resolveLightingConfig(cfg)?.sunIntensity).toBe(0);
    expect(resolveLightingConfig(cfg)?.ambientFloor).toBe(0);
    expect(resolveLightingConfig(cfg)?.sunElevationDeg).toBe(14);
    expect(resolveAtmosphereFog(cfg, { enabled: false, far: 100 })?.far).toBe(100);
    expect(resolveAtmosphereFog(cfg, { enabled: false })?.enabled).toBe(false);
    expect(resolveLightingConfig(null)).toBeNull();
    expect(resolveAtmosphereFog(null, null)).toBeNull();
    expect(cfg).toEqual({ preset: 'golden-hour', sunIntensity: 0, ambientFloor: 0 });
});
