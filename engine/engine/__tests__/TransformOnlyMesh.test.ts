/** @jest-environment jsdom */
import * as THREE from 'three';
import { createTransformOnlyMesh, TRANSFORM_ONLY_GEOMETRY } from 'engine/TransformOnlyMesh.js';
import { buildParametricWheelMesh } from 'engine/renderers/VehicleWheelBuilder.js';

/**
 * Regression guard for a total-blackout bug: `new THREE.Mesh()` yields a
 * geometry with NO attributes, WebGPU cannot build a pipeline for it, and the
 * resulting `setPipeline(null)` throws inside `renderer.render()` — aborting
 * the ENTIRE frame, skybox included. A mesh used purely as a transform parent
 * must therefore still declare the vertex layout, just with zero-length data.
 */
describe('createTransformOnlyMesh', () => {
    test('declares the attributes a WebGPU pipeline needs', () => {
        const mesh = createTransformOnlyMesh();
        for (const name of ['position', 'normal', 'uv']) {
            const attr = mesh.geometry.getAttribute(name);
            expect(attr).toBeDefined();
            expect(attr.itemSize).toBeGreaterThan(0);
        }
    });

    test('draws nothing — every attribute is zero-length', () => {
        const mesh = createTransformOnlyMesh();
        for (const name of ['position', 'normal', 'uv']) {
            const attr = mesh.geometry.getAttribute(name);
            expect(attr.array.length).toBe(0);
            expect(attr.count).toBe(0);
        }
    });

    test('has finite bounds and skips culling', () => {
        const mesh = createTransformOnlyMesh();
        expect(mesh.frustumCulled).toBe(false);
        expect(Number.isFinite(mesh.geometry.boundingSphere!.radius)).toBe(true);
        expect(Number.isFinite(mesh.geometry.boundingBox!.min.x)).toBe(true);
    });

    test('carries children, which keep their own geometry', () => {
        const mesh = createTransformOnlyMesh('wheel');
        const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.add(child);
        expect(mesh.name).toBe('wheel');
        expect(mesh.children).toContain(child);
        expect(child.geometry.getAttribute('position').count).toBeGreaterThan(0);
    });

    test('shares one immutable geometry across instances', () => {
        expect(createTransformOnlyMesh().geometry).toBe(TRANSFORM_ONLY_GEOMETRY);
        expect(createTransformOnlyMesh().geometry).toBe(createTransformOnlyMesh().geometry);
    });
});

describe('parametric dual wheels', () => {
    // The dual-wheel root is the other transform-only parent in the engine; it
    // reached WebGPU as a bare `new THREE.Mesh()` too.
    test('the dual root is drawable-safe and keeps both tyres', () => {
        const root = buildParametricWheelMesh({
            radius: 0.4, width: 0.3, style: 'steel', dual: true,
        });
        expect(root.geometry.getAttribute('position')).toBeDefined();
        expect(root.geometry.getAttribute('position').count).toBe(0);
        expect(root.children).toHaveLength(2);
        for (const tyre of root.children) {
            expect((tyre as THREE.Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
        }
    });

    test('a single wheel still has real geometry', () => {
        const wheel = buildParametricWheelMesh({
            radius: 0.4, width: 0.3, style: 'steel', dual: false,
        });
        expect(wheel.geometry.getAttribute('position').count).toBeGreaterThan(0);
    });
});
