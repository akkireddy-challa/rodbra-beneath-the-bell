import * as THREE from 'three';
import { refreshActiveDeviceQuality } from 'engine/DeviceQuality.js';
import {
    resolveVoxelFinishSettings,
    buildVoxelFinishMaterial,
    smoothShadingNormals,
    applyVoxelFinishToMesh,
    resolveVehicleFinish,
    DEFAULT_PAINT_PARAMS,
    VEHICLE_PAINT_SMOOTHNESS,
} from 'engine/VoxelSurfaceFinish.js';

/**
 * The finish options are opt-in on a code path every existing game already
 * runs, so the first thing these tests pin is that the defaults reproduce the
 * previous look exactly — same material class, same flatShading, untouched
 * normals.
 *
 * The rest cover the two cases the smoothing pass has to get right: a
 * staircase (perpendicular faces MUST average, that IS the curvature) and a
 * thin plate (opposing faces must NOT, or a car roof cancels with its own
 * underside).
 */

/** The three buffers `smoothShadingNormals` reads and writes. */
interface MeshBuffers {
    positions: number[];
    normals: number[];
    indices: number[];
}

/** Append an axis-aligned quad with a fixed normal to `buf`. */
function quad(
    buf: MeshBuffers,
    corners: Array<[number, number, number]>,
    normal: [number, number, number],
): void {
    const base = buf.positions.length / 3;
    for (const c of corners) {
        buf.positions.push(c[0], c[1], c[2]);
        buf.normals.push(normal[0], normal[1], normal[2]);
    }
    buf.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const emptyBuf = (): MeshBuffers => ({ positions: [], normals: [], indices: [] });

/** A two-step staircase in the XY plane: +Y treads and +X risers. */
function staircase(): MeshBuffers {
    const b = emptyBuf();
    quad(b, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, 1, 0]);
    quad(b, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0]);
    quad(b, [[1, 1, 0], [2, 1, 0], [2, 1, 1], [1, 1, 1]], [0, 1, 0]);
    quad(b, [[2, 1, 0], [2, 2, 0], [2, 2, 1], [2, 1, 1]], [1, 0, 0]);
    return b;
}

describe('resolveVoxelFinishSettings', () => {
    it('defaults to the historical faceted matte look', () => {
        const s = resolveVoxelFinishSettings();
        expect(s.surface).toBe('matte');
        expect(s.smoothness).toBe(0);
        expect(s.smoothRadiusVoxels).toBe(2.5);
        expect(s.paint).toEqual(DEFAULT_PAINT_PARAMS);
    });

    it('clamps smoothness into 0…1 and merges partial paint overrides', () => {
        expect(resolveVoxelFinishSettings({ smoothness: 5 }).smoothness).toBe(1);
        expect(resolveVoxelFinishSettings({ smoothness: -2 }).smoothness).toBe(0);
        const s = resolveVoxelFinishSettings({ paint: { metalness: 0.9 } });
        expect(s.paint.metalness).toBe(0.9);
        expect(s.paint.clearcoat).toBe(DEFAULT_PAINT_PARAMS.clearcoat);
    });
});

describe('buildVoxelFinishMaterial', () => {
    const base = { positions: [], normals: [] as number[], indices: [], voxelSize: 0.5 };

    it('keeps flat-shaded Lambert for the untextured matte default', () => {
        const m = buildVoxelFinishMaterial({
            ...base, settings: resolveVoxelFinishSettings(), map: null,
        });
        expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(m.flatShading).toBe(true);
        expect((m as THREE.MeshLambertMaterial).vertexColors).toBe(true);
    });

    it('never flat-shades the atlas path, which never was', () => {
        const map = new THREE.Texture();
        const m = buildVoxelFinishMaterial({
            ...base, settings: resolveVoxelFinishSettings(), map,
        });
        expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(m.flatShading).toBe(false);
        expect((m as THREE.MeshLambertMaterial).vertexColors).toBe(false);
        expect((m as THREE.MeshLambertMaterial).map).toBe(map);
    });

    /**
     * The default gloss model is 'direct' (Phong) precisely BECAUSE three.js
     * routes `scene.environment` only to Standard/Physical. Picking Phong is
     * the per-material opt-out from diffuse IBL, which is what keeps a car's
     * colour matching the world around it — measured on a real kart, the
     * Physical path lifts luminance 1.26x and cuts saturation to 0.34x.
     */
    it('defaults the paint finish to direct-lit gloss, not an IBL material', () => {
        const m = buildVoxelFinishMaterial({
            ...base,
            settings: resolveVoxelFinishSettings({ surface: 'paint' }),
            map: null,
        });
        expect(m).toBeInstanceOf(THREE.MeshPhongMaterial);
        expect(m).not.toBeInstanceOf(THREE.MeshStandardMaterial);
        const phong = m as THREE.MeshPhongMaterial;
        expect(phong.shininess).toBe(DEFAULT_PAINT_PARAMS.directShininess);
    });

    it('builds a clearcoated physical material when asked for environment gloss', () => {
        const m = buildVoxelFinishMaterial({
            ...base,
            settings: resolveVoxelFinishSettings({ surface: 'paint', paint: { glossModel: 'environment' } }),
            map: null,
        });
        expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        const phys = m as THREE.MeshPhysicalMaterial;
        expect(phys.clearcoat).toBe(DEFAULT_PAINT_PARAMS.clearcoat);
        expect(phys.metalness).toBe(DEFAULT_PAINT_PARAMS.metalness);
    });

    it('drops flatShading once normals are smoothed, or the pass does nothing', () => {
        const b = staircase();
        const m = buildVoxelFinishMaterial({
            positions: b.positions, normals: b.normals, indices: b.indices,
            voxelSize: 1,
            settings: resolveVoxelFinishSettings({ surface: 'paint', smoothness: 1, smoothRadiusVoxels: 1.5 }),
            map: null,
        });
        expect(m.flatShading).toBe(false);
    });
});

describe('smoothShadingNormals', () => {
    it('is a no-op at strength 0', () => {
        const b = staircase();
        const before = [...b.normals];
        expect(smoothShadingNormals({ ...b, radius: 1.5, strength: 0 })).toBe(false);
        expect(b.normals).toEqual(before);
    });

    it('leaves positions and normal count alone', () => {
        const b = staircase();
        const positionsBefore = [...b.positions];
        const count = b.normals.length;
        smoothShadingNormals({ ...b, radius: 1.5, strength: 1 });
        expect(b.positions).toEqual(positionsBefore);
        expect(b.normals).toHaveLength(count);
        for (let i = 0; i < count; i += 3) {
            const len = Math.hypot(b.normals[i]!, b.normals[i + 1]!, b.normals[i + 2]!);
            expect(len).toBeCloseTo(1, 5);
        }
    });

    it('tilts a tread normal toward the riser — perpendicular faces must average', () => {
        const b = staircase();
        smoothShadingNormals({ ...b, radius: 1.5, strength: 1 });
        // Vertex 1 is the tread corner shared with the first riser.
        const nx = b.normals[3]!;
        const ny = b.normals[4]!;
        expect(ny).toBeGreaterThan(0);   // still points up…
        expect(nx).toBeGreaterThan(0.1); // …but has leaned into the riser
        expect(ny).toBeLessThan(0.99);   // and is no longer axis-aligned
    });

    it('does not cancel a thin plate against its own underside', () => {
        const b = emptyBuf();
        quad(b, [[0, 0.1, 0], [1, 0.1, 0], [1, 0.1, 1], [0, 0.1, 1]], [0, 1, 0]);
        quad(b, [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]], [0, -1, 0]);
        smoothShadingNormals({ ...b, radius: 1.0, strength: 1 });
        // Top face keeps pointing up, bottom face keeps pointing down.
        expect(b.normals[1]).toBeCloseTo(1, 5);
        expect(b.normals[13]).toBeCloseTo(-1, 5);
    });

    it('leaves a single flat panel exactly as it was', () => {
        const b = emptyBuf();
        quad(b, [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]], [0, 1, 0]);
        smoothShadingNormals({ ...b, radius: 1.5, strength: 1 });
        expect(b.normals).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    });
});

/**
 * The write mask is what makes a PER-MATERIAL-CLASS smoothing pass affordable:
 * only the shiny slot's vertices are rewritten, so the cost tracks the shiny
 * fraction of the mesh rather than the mesh. Its correctness rests on one
 * asymmetry — reading is NOT masked — because a gold trim strip needs the stone
 * beside it inside its average or its normals collapse back to its own few faces
 * and the highlight steps instead of rolling.
 */
describe('smoothShadingNormals write mask', () => {
    /** Mask covering the LAST quad of the staircase (vertices 12..15) only. */
    const lastQuadMask = (vertexCount: number): Uint8Array => {
        const mask = new Uint8Array(vertexCount);
        for (let i = 12; i < 16; i++) mask[i] = 1;
        return mask;
    };

    it('rewrites only the masked vertices and leaves the rest bit-identical', () => {
        const masked = staircase();
        const unmasked = staircase();
        const before = [...masked.normals];

        smoothShadingNormals({ ...unmasked, radius: 1.5, strength: 1 });
        const ran = smoothShadingNormals({
            ...masked, radius: 1.5, strength: 1,
            writeMask: lastQuadMask(masked.normals.length / 3),
        });

        expect(ran).toBe(true);
        // Vertices 0..11 must be untouched — not merely close, EXACTLY as authored.
        expect(masked.normals.slice(0, 36)).toEqual(before.slice(0, 36));
        // The masked quad must have moved, and to the same place the unmasked pass
        // put it: the mask changes who is written, never what is read.
        expect(masked.normals.slice(36)).not.toEqual(before.slice(36));
        expect(masked.normals.slice(36)).toEqual(unmasked.normals.slice(36));
    });

    it("includes unmasked neighbours in a masked vertex's average", () => {
        // The last riser (masked) is perpendicular to the tread before it
        // (unmasked). If reads were masked too, the riser would have only its own
        // +X faces to average and would come back unchanged.
        const b = staircase();
        smoothShadingNormals({
            ...b, radius: 1.5, strength: 1,
            writeMask: lastQuadMask(b.normals.length / 3),
        });
        // Vertex 12 is the riser corner touching the tread below it.
        const nx = b.normals[36]!;
        const ny = b.normals[37]!;
        expect(nx).toBeGreaterThan(0);    // still faces +X…
        expect(ny).toBeGreaterThan(0.1);  // …but has leaned onto the tread
        expect(nx).toBeLessThan(0.99);
    });

    it('is a no-op for an all-zero mask rather than zeroing every normal', () => {
        const b = staircase();
        const before = [...b.normals];
        const ran = smoothShadingNormals({
            ...b, radius: 1.5, strength: 1,
            writeMask: new Uint8Array(b.normals.length / 3),
        });
        expect(ran).toBe(false);
        expect(b.normals).toEqual(before);
    });

    it('treats a null mask as "write everything"', () => {
        const withNull = staircase();
        const without = staircase();
        smoothShadingNormals({ ...withNull, radius: 1.5, strength: 1, writeMask: null });
        smoothShadingNormals({ ...without, radius: 1.5, strength: 1 });
        expect(withNull.normals).toEqual(without.normals);
    });
});

describe('applyVoxelFinishToMesh', () => {
    /**
     * Build a mesh the way VoxelOctreeRenderer does for a baked .vxl asset:
     * either a `uv` attribute + a textured material (atlas), or a `color`
     * attribute and no texture. Never both.
     */
    const octreeMesh = (mode: 'atlas' | 'vertexColor', material: THREE.Material): THREE.Mesh => {
        const b = staircase();
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
        geom.setIndex(b.indices);
        const vertexCount = b.positions.length / 3;
        if (mode === 'atlas') {
            geom.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(vertexCount * 2).fill(0), 2));
        } else {
            geom.setAttribute('color', new THREE.Float32BufferAttribute(new Array(vertexCount * 3).fill(1), 3));
        }
        return new THREE.Mesh(geom, material);
    };

    const paint = resolveVoxelFinishSettings({ surface: 'paint', smoothness: 0.75, smoothRadiusVoxels: 1.5 });

    /**
     * REGRESSION: under WebGPU the octree path supplies a
     * MeshLambertNodeMaterial, which is not `instanceof` any THREE.Mesh*Material.
     * Reading the atlas texture via instanceof dropped it and set vertexColors
     * on geometry that has no `color` attribute — every car rendered pure white.
     * MeshBasicMaterial stands in: it carries `map` and is not one of the
     * classes the old check tested for.
     */
    it('keeps the atlas texture when the previous material is not a known class', () => {
        const map = new THREE.Texture();
        const mesh = octreeMesh('atlas', new THREE.MeshBasicMaterial({ map }));
        applyVoxelFinishToMesh(mesh, paint, 1);
        const m = mesh.material as THREE.MeshPhongMaterial;
        expect(m).toBeInstanceOf(THREE.MeshPhongMaterial);
        expect(m.map).toBe(map);
        expect(m.vertexColors).toBe(false);
    });

    it('uses vertex colours only when the geometry actually has them', () => {
        const mesh = octreeMesh('vertexColor', new THREE.MeshBasicMaterial());
        applyVoxelFinishToMesh(mesh, paint, 1);
        const m = mesh.material as THREE.MeshPhysicalMaterial;
        expect(m.vertexColors).toBe(true);
        expect(m.map).toBeNull();
    });

    it('never sets vertexColors on geometry without a color attribute', () => {
        for (const material of [new THREE.MeshBasicMaterial({ map: new THREE.Texture() }), new THREE.MeshBasicMaterial()]) {
            const mesh = octreeMesh('atlas', material);
            applyVoxelFinishToMesh(mesh, paint, 1);
            expect((mesh.material as THREE.MeshPhysicalMaterial).vertexColors).toBe(false);
        }
    });

    /**
     * A vehicle with lights is a MULTI-material mesh: group 0 is the paintable
     * bodywork, groups 1..N are the light slots. The paint finish used to bail
     * out of any material array (and of anything emissive), so turning on
     * headlights would have silently stripped car paint from every vehicle.
     * Paint group 0, leave the lights glowing.
     */
    it('paints the base material of a slotted mesh and leaves the light materials alone', () => {
        const map = new THREE.Texture();
        const base = new THREE.MeshBasicMaterial({ map });
        const headlights = new THREE.MeshBasicMaterial({ map });
        const beacon = new THREE.MeshBasicMaterial({ map });
        const mesh = octreeMesh('atlas', base);
        mesh.material = [base, headlights, beacon];

        applyVoxelFinishToMesh(mesh, paint, 1);

        const materials = mesh.material as THREE.Material[];
        expect(materials.length).toBe(3);
        expect(materials[0]).toBeInstanceOf(THREE.MeshPhongMaterial);
        expect((materials[0] as THREE.MeshPhongMaterial).map).toBe(map);
        expect(materials[1]).toBe(headlights);
        expect(materials[2]).toBe(beacon);
    });

    it('leaves the mesh alone for the flat finish', () => {
        const original = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
        const mesh = octreeMesh('atlas', original);
        applyVoxelFinishToMesh(mesh, resolveVoxelFinishSettings(), 1);
        expect(mesh.material).toBe(original);
    });
});

describe('resolveVehicleFinish', () => {
    const withSearch = (search: string, fn: () => void): void => {
        const had = 'location' in globalThis;
        Object.defineProperty(globalThis, 'location', {
            value: { search } as unknown as Location,
            configurable: true,
            writable: true,
        });
        try {
            fn();
        } finally {
            if (!had) delete (globalThis as { location?: unknown }).location;
        }
    };

    it('keeps the flat look unless the game config asks for paint', () => {
        expect(resolveVehicleFinish(undefined)).toBeNull();
        expect(resolveVehicleFinish('flat')).toBeNull();
    });

    /**
     * `withSearch` fakes `location` only; the platform override reads
     * `window.location.search`, so a mobile-path test needs a window too. This file
     * runs in the node environment, where neither exists by default.
     */
    const withPlatform = (search: string, fn: () => void): void => {
        const hadWindow = 'window' in globalThis;
        Object.defineProperty(globalThis, 'window', {
            value: { location: { search } }, configurable: true, writable: true,
        });
        // The quality tier is resolved once per session and memoised (it sits on the
        // per-material construction path), so a test that swaps the platform underneath it
        // has to say so. A real load never changes platform mid-session.
        refreshActiveDeviceQuality();
        try {
            withSearch(search, fn);
        } finally {
            if (!hadWindow) delete (globalThis as { window?: unknown }).window;
            refreshActiveDeviceQuality();
        }
    };

    it('skips paint on mobile — the smoothing pass is half a chassis load', () => {
        // Not a look preference: `applyVoxelFinishToMesh` smooths shading normals across
        // every vertex, and a voxel kart meshes to tens of thousands of them. Measured at
        // 53.7ms of a 105.6ms load on a desktop, per chassis, for every kart on the grid.
        withPlatform('?platform=mobile', () => {
            expect(resolveVehicleFinish('paint')).toBeNull();
            expect(resolveVehicleFinish(undefined)).toBeNull();
        });
    });

    it('still paints on desktop', () => {
        withPlatform('?platform=desktop', () => {
            expect(resolveVehicleFinish('paint')).toEqual({
                surface: 'paint',
                smoothness: VEHICLE_PAINT_SMOOTHNESS,
            });
        });
    });

    it('lets the carpaint override re-enable paint ON a mobile device', () => {
        // The override exists to compare the two looks on a real scene — including on the
        // device where the default now says no. A skip that could not be lifted would make
        // the finish untestable exactly where its cost was measured.
        withPlatform('?platform=mobile&carpaint=1', () => {
            expect(resolveVehicleFinish('flat')).not.toBeNull();
        });
    });

    it('turns on paint from the game config', () => {
        expect(resolveVehicleFinish('paint')).toEqual({
            surface: 'paint',
            smoothness: VEHICLE_PAINT_SMOOTHNESS,
        });
    });

    it('ignores an unrelated query string', () => {
        withSearch('?other=1', () => expect(resolveVehicleFinish('paint')).toEqual({
            surface: 'paint',
            smoothness: VEHICLE_PAINT_SMOOTHNESS,
        }));
        withSearch('?other=1', () => expect(resolveVehicleFinish(undefined)).toBeNull());
    });

    it('lets the dev URL override turn paint ON over a flat config', () => {
        withSearch('?carpaint=0.6', () => {
            expect(resolveVehicleFinish('flat')).toMatchObject({ surface: 'paint', smoothness: 0.6 });
        });
        withSearch('?carpaint=', () => {
            expect(resolveVehicleFinish(undefined)).toMatchObject({ surface: 'paint', smoothness: 1 });
        });
    });

    it('carries dev tuning params through to the paint settings', () => {
        withSearch('?carpaint=1&gloss=environment&albedo=0.8', () => {
            const resolved = resolveVoxelFinishSettings(resolveVehicleFinish('flat') ?? {});
            expect(resolved.paint.glossModel).toBe('environment');
            expect(resolved.paint.albedoScale).toBe(0.8);
        });
        // Params that were NOT supplied must leave every default intact — a
        // bare ?carpaint=1 is "the shipping paint look", not "paint with the
        // gloss zeroed out".
        withSearch('?carpaint=1', () => {
            const resolved = resolveVoxelFinishSettings(resolveVehicleFinish('flat') ?? {});
            expect(resolved.paint).toEqual(DEFAULT_PAINT_PARAMS);
        });
    });

    it('lets the dev URL override turn paint OFF over a paint config', () => {
        withSearch('?carpaint=0', () => expect(resolveVehicleFinish('paint')).toBeNull());
        withSearch('?carpaint=nope', () => expect(resolveVehicleFinish('paint')).toBeNull());
    });
});
