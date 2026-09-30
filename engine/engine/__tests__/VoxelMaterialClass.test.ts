/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { buildOctreeMesh, VOXEL_SLOT_HANDLES, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { shadingSmoothedStamp } from 'engine/VoxelSurfaceFinish.js';
import {
    DEFAULT_VOXEL_MATERIAL_CLASS,
    VOXEL_MATERIAL_CLASSES,
    VOXEL_MATERIAL_CLASS_NAMES,
    defaultGlowForVoxelMaterialClass,
    effectiveVoxelMaterialClassName,
    isVoxelMaterialClassName,
    normalizeVoxelMaterialClassName,
    resolveVoxelMaterialClass,
} from 'engine/VoxelMaterialClass.js';
import { EMISSIVE_INTENSITY } from 'engine/VoxelEmissiveMaterial.js';
import { buildSlotTable } from 'engine/VoxelMaterialSlots.js';
import type { VoxelSlotMaterialHandle } from 'engine/VoxelSlotMaterial.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

/**
 * A material class is the join that lets one voxel asset shade as several
 * materials: a sword's blade reflects while its grip does not. The stakes on the
 * regression side are equally specific — every voxel in the engine renders
 * through this code, so the first thing pinned here is that an asset naming no
 * class produces the material it always did.
 */

function leaf(x: number, slot = 0): OctreeLeaf {
    // Spread along X so no face is hidden and every leaf keeps all six faces.
    return { x: x * 0.4, y: 0, z: 0, size: 0.1, r: 1, g: 0, b: 0, slot };
}

function handlesOf(mesh: THREE.Mesh): VoxelSlotMaterialHandle[] {
    return (mesh.userData[VOXEL_SLOT_HANDLES] ?? []) as VoxelSlotMaterialHandle[];
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
    return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

describe('the material-class table', () => {
    it('defaults to matte, which is the plain Lambert path', () => {
        expect(DEFAULT_VOXEL_MATERIAL_CLASS).toBe('matte');
        expect(VOXEL_MATERIAL_CLASSES.matte.lighting).toBe('lambert');
        // Nothing to smooth: matte IS the stock faceted look.
        expect(VOXEL_MATERIAL_CLASSES.matte.smoothness).toBe(0);
    });

    it('resolves an unknown name to the default instead of throwing', () => {
        // This is what lets an asset authored against a NEWER vocabulary load in
        // an older engine: it renders plainly rather than failing.
        expect(normalizeVoxelMaterialClassName('unobtanium')).toBe('matte');
        expect(normalizeVoxelMaterialClassName(undefined)).toBe('matte');
        expect(normalizeVoxelMaterialClassName(null)).toBe('matte');
        expect(resolveVoxelMaterialClass('unobtanium').lighting).toBe('lambert');
        expect(isVoxelMaterialClassName('unobtanium')).toBe(false);
    });

    it('matches names case-insensitively and trims them', () => {
        // Names arrive from GLB material names, hand-written JSON and model output.
        expect(normalizeVoxelMaterialClassName('  Gold ')).toBe('gold');
        expect(normalizeVoxelMaterialClassName('METAL')).toBe('metal');
    });

    it('routes the reflective classes to environment lighting and the rest away from it', () => {
        // The split is the load-bearing decision: only classes whose identity IS
        // a reflection may take the image-based-lighting path, because that path
        // measurably shifts luminance and saturation (see VoxelPaintParams).
        for (const name of ['metal', 'gold', 'chrome', 'gem', 'glass'] as const) {
            expect(VOXEL_MATERIAL_CLASSES[name].lighting).toBe('environment');
        }
        for (const name of ['cloth', 'leather', 'wood', 'stone', 'plastic', 'paint'] as const) {
            expect(VOXEL_MATERIAL_CLASSES[name].lighting).toBe('direct');
        }
        // `fur` is the exception that proves the rule: it takes the tier for the
        // one BRDF only three's Physical has, and then switches the environment
        // itself off, so it reflects nothing and takes none of the tonal shift.
        expect(VOXEL_MATERIAL_CLASSES.fur.lighting).toBe('environment');
        expect(VOXEL_MATERIAL_CLASSES.fur.envMapIntensity).toBe(0);
    });

    it('gives the sheen lobe to fur and to nothing else', () => {
        // Sheen is the one lobe here that is not a reflection, and the only
        // reason fur is on the reflective tier. It is a named exception with a
        // reason, not a general-purpose escape hatch — so what is worth pinning
        // is that it stays confined to the one class, and that every other class
        // keeps three's own default of 0 and therefore its exact old program.
        expect(VOXEL_MATERIAL_CLASSES.fur.sheen).toBeGreaterThan(0);
        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            if (name === 'fur') continue;
            expect(VOXEL_MATERIAL_CLASSES[name].sheen).toBe(0);
        }
    });

    it('keeps fur off image-based lighting despite its tier', () => {
        // envMapIntensity scales both getIBLIrradiance and getIBLRadiance, so
        // zero is what makes this tier safe for a soft material: no environment
        // reaches it, and it goes properly dark in an unlit room. Every other
        // class on the tier is there precisely FOR the environment.
        expect(VOXEL_MATERIAL_CLASSES.fur.envMapIntensity).toBe(0);
        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            const cls = VOXEL_MATERIAL_CLASSES[name];
            if (cls.lighting !== 'environment' || name === 'fur') continue;
            expect(cls.envMapIntensity).toBeGreaterThan(0);
        }
    });

    it('tunes fur as a grazing halo over a surviving albedo', () => {
        // The counter-intuitive half, pinned because a future retune will want to
        // "soften" fur by widening the lobe and that is exactly backwards: a broad
        // sheen lifts the WHOLE surface and strips its saturation, which on a
        // voxel asset costs the thing that identified it. The halo has to stay at
        // grazing angles, and the strength has to stop short of white-out.
        expect(VOXEL_MATERIAL_CLASSES.fur.sheenRoughness).toBeLessThan(0.5);
        expect(VOXEL_MATERIAL_CLASSES.fur.sheen).toBeLessThanOrEqual(0.5);
        expect(VOXEL_MATERIAL_CLASSES.fur.sheenColor).not.toBe(0xffffff);
        // Nothing reflective about the body itself: the GGX lobe must stay out of
        // the way so everything fur-shaped comes from the sheen.
        expect(VOXEL_MATERIAL_CLASSES.fur.metalness).toBe(0);
        expect(VOXEL_MATERIAL_CLASSES.fur.roughness).toBe(1);
        // And the soft form: the roundest shading in the table.
        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            if (name === 'fur') continue;
            expect(VOXEL_MATERIAL_CLASSES.fur.smoothness)
                .toBeGreaterThanOrEqual(VOXEL_MATERIAL_CLASSES[name].smoothness);
        }
    });

    it('falls fur back to cloth when its normals were not smoothed', () => {
        // The same failure chrome has, for the same reason: a sheen lobe is a
        // function of the normal, so across six flat face normals it is six flat
        // halos rather than a rim. It also keeps Physical-plus-sheen off phones.
        expect(effectiveVoxelMaterialClassName('fur', true)).toBe('fur');
        expect(effectiveVoxelMaterialClassName('fur', false)).toBe('cloth');
    });

    it('gives every class a default glow, and only the light classes one', () => {
        // The field the editor reads instead of asking. A surface that shipped a
        // glow would light up the moment someone said their crate was made of
        // wood, which is the failure this invariant exists to make impossible.
        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            const glow = VOXEL_MATERIAL_CLASSES[name].defaultGlow;
            expect(Number.isInteger(glow)).toBe(true);
            expect(glow).toBeGreaterThanOrEqual(0);
            // Same units as `VoxelSlot.emissive`, which is what it is seeded into.
            expect(glow).toBeLessThanOrEqual(255);
        }
        const lights = VOXEL_MATERIAL_CLASS_NAMES.filter(
            (n) => VOXEL_MATERIAL_CLASSES[n].defaultGlow > 0,
        );
        expect(lights).toEqual(['filament', 'neon', 'lava']);
    });

    it('keeps the light classes off the environment tier', () => {
        // What identifies a neon tube is its own light, not the sky in it. The
        // Physical tier's measured luminance/saturation shift would fight the
        // glow and make every lit bulb in a scene pay for image-based lighting.
        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            const cls = VOXEL_MATERIAL_CLASSES[name];
            if (cls.defaultGlow > 0) {
                expect(cls.lighting).toBe('direct');
                // A glow does the work a reflection would, so there is nothing
                // for an unsmoothed light to fall back to.
                expect(cls.mobileFallback).toBeNull();
            }
        }
    });

    it('resolves a default glow for anything, including what it has never heard of', () => {
        expect(defaultGlowForVoxelMaterialClass('neon')).toBe(255);
        expect(defaultGlowForVoxelMaterialClass('wood')).toBe(0);
        // An absent class means matte, and matte does not glow. Same for a name
        // from a newer vocabulary: it renders as the default, so it starts dark
        // rather than at some other class's brightness.
        expect(defaultGlowForVoxelMaterialClass(undefined)).toBe(0);
        expect(defaultGlowForVoxelMaterialClass('unobtanium')).toBe(0);
    });

    it('keeps every collapse chain terminating at matte', () => {
        // The over-budget path walks `collapsesTo` until a class fits, so a cycle
        // or a dangling name would hang or drop a material silently.
        for (const start of VOXEL_MATERIAL_CLASS_NAMES) {
            const seen = new Set<string>();
            let cursor: string | null = start;
            while (cursor !== null) {
                expect(seen.has(cursor)).toBe(false);
                seen.add(cursor);
                expect(isVoxelMaterialClassName(cursor)).toBe(true);
                cursor = VOXEL_MATERIAL_CLASSES[cursor as keyof typeof VOXEL_MATERIAL_CLASSES].collapsesTo;
            }
            expect(seen.has('matte')).toBe(true);
        }
    });

    it('falls a mirror-only class back when its normals were not smoothed', () => {
        // Chrome with six flat face normals is six flat tones — worse than not
        // claiming to be chrome at all.
        expect(effectiveVoxelMaterialClassName('chrome', true)).toBe('chrome');
        expect(effectiveVoxelMaterialClassName('chrome', false)).toBe('plastic');
        // Gold still reads as gold faceted, so it keeps itself.
        expect(effectiveVoxelMaterialClassName('gold', false)).toBe('gold');
    });

    it('leaves the reflection tint of a metal unscaled', () => {
        // At high metalness the colour is the REFLECTION TINT, not an albedo, so
        // scaling it down would not correct a brightness error — it would just
        // make the metal dingy. The dielectric classes are where albedoScale earns
        // its keep.
        expect(VOXEL_MATERIAL_CLASSES.gold.albedoScale).toBe(1);
        expect(VOXEL_MATERIAL_CLASSES.metal.albedoScale).toBe(1);
        expect(VOXEL_MATERIAL_CLASSES.gem.albedoScale).toBeLessThan(1);
    });
});

describe('buildSlotTable carries a material class', () => {
    it('omits the field entirely for an absent or explicitly-matte class', () => {
        // Not cosmetic: "no class" must be shaped exactly as it was before classes
        // existed, so the encoder's write gate and the byte-identity guarantee for
        // existing assets both stay honest.
        const { slots } = buildSlotTable([
            { name: 'a', emissive: 0 },
            { name: 'b', emissive: 0, materialClass: 'matte' },
            { name: 'c', emissive: 0, materialClass: '   ' },
        ]);
        for (const slot of slots) {
            expect(Object.hasOwnProperty.call(slot, 'materialClass')).toBe(false);
        }
    });

    it('normalises and keeps a real class', () => {
        const { slots } = buildSlotTable([{ name: 'trim', emissive: 0, materialClass: ' GOLD ' }]);
        expect(slots[0]!.materialClass).toBe('gold');
    });

    it('keeps an unknown class name rather than stripping it', () => {
        // Stored identity and rendered identity are separate: the file keeps what
        // it was authored with, and only the render lookup falls back.
        const { slots } = buildSlotTable([{ name: 'x', emissive: 0, materialClass: 'unobtanium' }]);
        expect(slots[0]!.materialClass).toBe('unobtanium');
        expect(resolveVoxelMaterialClass(slots[0]!.materialClass).lighting).toBe('lambert');
    });

    it('keeps the first class when one slot name is declared twice', () => {
        // Emissive resolves a duplicate with Math.max; a class has no natural max,
        // so first-wins and the conflict is reported rather than averaged.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { slots } = buildSlotTable([
            { name: 'trim', emissive: 10, materialClass: 'gold' },
            { name: 'trim', emissive: 90, materialClass: 'wood' },
        ]);
        expect(slots).toHaveLength(1);
        expect(slots[0]!.materialClass).toBe('gold');
        expect(slots[0]!.emissive).toBe(90);       // brightest still wins
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('material classes become real materials on a voxel mesh', () => {
    const MATTE_SLOTS: VoxelSlot[] = [{ name: 'headlights', emissive: 255 }];
    const SHINY_SLOTS: VoxelSlot[] = [
        { name: 'blade', emissive: 0, materialClass: 'metal' },
        { name: 'grip', emissive: 0, materialClass: 'leather' },
    ];

    it('REGRESSION FENCE: a class-free slot still builds the Lambert material', () => {
        const mesh = buildOctreeMesh([leaf(0), leaf(1, 1)], 0, 0, 0, false, 'mc-plain', null, MATTE_SLOTS);
        const materials = materialsOf(mesh);
        expect(materials[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(materials[1]).toBeInstanceOf(THREE.MeshLambertMaterial);
        // And no smoothing ran, so nothing downstream thinks the normals moved.
        expect(shadingSmoothedStamp(mesh.geometry)).toBeNull();
    });

    it('gives each tier its own material type, and never touches the base', () => {
        const mesh = buildOctreeMesh(
            [leaf(0), leaf(1, 1), leaf(2, 2)], 0, 0, 0, false, 'mc-tiers', null, SHINY_SLOTS,
        );
        const materials = materialsOf(mesh);
        // The BASE slot keeps Lambert. Promoting it to "match" a shiny slot would
        // apply the image-based-lighting shift to 100% of the asset's voxels in
        // service of the few per cent that are shiny.
        expect(materials[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(materials[1]).toBeInstanceOf(THREE.MeshPhysicalMaterial);   // metal
        expect(materials[2]).toBeInstanceOf(THREE.MeshPhongMaterial);      // leather
        // Phong is not incidental — it is the deliberate opt-out from
        // scene.environment, so a leather slot cannot tonally seam against the base.
        expect(materials[2]).not.toBeInstanceOf(THREE.MeshStandardMaterial);
    });

    it('carries the class parameters onto the material', () => {
        const mesh = buildOctreeMesh([leaf(0), leaf(1, 1)], 0, 0, 0, false, 'mc-params', null, [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]);
        const gold = materialsOf(mesh)[1] as THREE.MeshPhysicalMaterial;
        expect(gold.metalness).toBe(VOXEL_MATERIAL_CLASSES.gold.metalness);
        expect(gold.roughness).toBe(VOXEL_MATERIAL_CLASSES.gold.roughness);
    });

    it('builds fur as a sheened Physical that reflects nothing', () => {
        // The whole design in one material: Physical (so the sheen lobe exists),
        // sheen on, environment off. Gold beside it shows the tier's normal
        // shape, and that sheen did not leak onto it.
        const mesh = buildOctreeMesh(
            [leaf(0), leaf(1, 1), leaf(2, 2)], 0, 0, 0, false, 'mc-fur', null, [
                { name: 'pelt', emissive: 0, materialClass: 'fur' },
                { name: 'trim', emissive: 0, materialClass: 'gold' },
            ],
        );
        const [, fur, gold] = materialsOf(mesh) as THREE.MeshPhysicalMaterial[];
        expect(fur).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(fur!.sheen).toBe(VOXEL_MATERIAL_CLASSES.fur.sheen);
        expect(fur!.sheenRoughness).toBe(VOXEL_MATERIAL_CLASSES.fur.sheenRoughness);
        expect(fur!.sheenColor.getHex()).toBe(VOXEL_MATERIAL_CLASSES.fur.sheenColor);
        expect(fur!.envMapIntensity).toBe(0);
        // three keys its own program cache on `sheen > 0`, so these two Physical
        // materials on one mesh cannot share a compiled program — which is why
        // this file's own cache key does not have to mention sheen at all.
        expect(gold!.sheen).toBe(0);
        expect(gold!.envMapIntensity).toBeGreaterThan(0);
    });

    it('renders an unknown class as the plain default', () => {
        const mesh = buildOctreeMesh([leaf(0), leaf(1, 1)], 0, 0, 0, false, 'mc-unknown', null, [
            { name: 'x', emissive: 0, materialClass: 'unobtanium' },
        ]);
        expect(materialsOf(mesh)[1]).toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it('keeps the live emissive control working on a PBR class', () => {
        // A slot must not have to choose between being made of metal and being a
        // light: a gold beacon is both.
        const mesh = buildOctreeMesh([leaf(0, 1), leaf(1, 2)], 0, 0, 0, false, 'mc-emissive', null, [
            { name: 'beacon', emissive: 0, materialClass: 'gold' },
            { name: 'lamp', emissive: 255, materialClass: 'glass' },
        ]);
        const [beacon, lamp] = handlesOf(mesh);
        expect(beacon!.getEmissive()).toBeCloseTo(0);
        expect(lamp!.getEmissive()).toBeCloseTo(1);
        beacon!.setEmissive(1);
        expect(beacon!.getEmissive()).toBeCloseTo(1);
        expect(lamp!.getEmissive()).toBeCloseTo(1);
        lamp!.setEmissive(0);
        expect(beacon!.getEmissive()).toBeCloseTo(1);   // only the one slot moved
        expect(lamp!.getEmissive()).toBeCloseTo(0);
    });

    it('keeps every slot material off the base material\'s program', () => {
        // three's own cache key covers the shaderID and a bitmask of material
        // FEATURES — and nothing about `emissive`/`emissiveIntensity` is in it. So
        // a plain base `MeshLambertMaterial` and a slot one that injects
        // `totalEmissiveRadiance` hash identically, and they sit on the same mesh.
        // Without an explicit key the first to compile wins for both: either a
        // slot stops glowing or the base group starts.
        const mesh = buildOctreeMesh(
            [leaf(0), leaf(1, 1), leaf(2, 2)], 0, 0, 0, false, 'mc-cache', null, SHINY_SLOTS,
        );
        const materials = materialsOf(mesh);
        const keyOf = (m: THREE.Material): string => m.customProgramCacheKey();
        const baseKey = keyOf(materials[0]!);
        expect(keyOf(materials[1]!)).not.toBe(baseKey);
        expect(keyOf(materials[2]!)).not.toBe(baseKey);
        // …and the two shiny tiers stay distinct from each other.
        expect(keyOf(materials[1]!)).not.toBe(keyOf(materials[2]!));
    });

    it('separates a matte SLOT from the plain base material too', () => {
        // The collision above predates material classes: a class-free slot has
        // the same three type and the same features as the base material.
        const mesh = buildOctreeMesh([leaf(0), leaf(1, 1)], 0, 0, 0, false, 'mc-cache-matte', null, [
            { name: 'plain', emissive: 255 },
        ]);
        const materials = materialsOf(mesh);
        expect(materials[1]!.customProgramCacheKey())
            .not.toBe(materials[0]!.customProgramCacheKey());
    });

    it('draws no base group when a class owns every voxel', () => {
        // The all-one-material case needs no special handling: an empty range is
        // never added as a group, so an all-gold asset costs no extra draw call
        // and has no Lambert group for the shiny one to seam against.
        const mesh = buildOctreeMesh([leaf(0, 1), leaf(1, 1)], 0, 0, 0, false, 'mc-allgold', null, [
            { name: 'body', emissive: 0, materialClass: 'gold' },
        ]);
        const groups = mesh.geometry.groups;
        expect(groups.map((g) => g.materialIndex)).toEqual([1]);
        expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(mesh.geometry.getIndex()!.count);
    });
});

describe('shading normals for shiny slots', () => {
    /** Two leaves in a stair step, so a smoothing pass has something to average. */
    const step = (slot: number): OctreeLeaf[] => [
        { x: 0, y: 0, z: 0, size: 0.1, r: 1, g: 1, b: 1, slot },
        { x: 0.1, y: 0.1, z: 0, size: 0.1, r: 1, g: 1, b: 1, slot },
    ];

    const normalsOf = (mesh: THREE.Mesh): number[] =>
        Array.from(mesh.geometry.getAttribute('normal').array as ArrayLike<number>);

    it('does not run at all for an all-matte asset', () => {
        const mesh = buildOctreeMesh(step(1), 0, 0, 0, false, 'sn-matte', null, [
            { name: 'plain', emissive: 0 },
        ]);
        expect(shadingSmoothedStamp(mesh.geometry)).toBeNull();
        // Every normal is still an exact axis direction.
        for (const n of normalsOf(mesh)) expect([-1, 0, 1]).toContain(n);
    });

    it('smooths a shiny slot and records that it did', () => {
        const mesh = buildOctreeMesh(step(1), 0, 0, 0, false, 'sn-metal', null, [
            { name: 'blade', emissive: 0, materialClass: 'metal' },
        ]);
        const stamp = shadingSmoothedStamp(mesh.geometry);
        expect(stamp).not.toBeNull();
        expect(stamp!.strength).toBe(VOXEL_MATERIAL_CLASSES.metal.smoothness);
        // At least one normal has left its axis — which is the whole point: a
        // reflection off six axis-aligned normals is six flat tones.
        expect(normalsOf(mesh).some((n) => n !== 0 && Math.abs(n) !== 1)).toBe(true);
    });

    it('shades a smoothed slot smoothly and an unsmoothed one flat', () => {
        const shiny = buildOctreeMesh(step(1), 0, 0, 0, false, 'sn-flat-a', null, [
            { name: 'blade', emissive: 0, materialClass: 'metal' },
        ]);
        const plain = buildOctreeMesh(step(1), 0, 0, 0, false, 'sn-flat-b', null, [
            { name: 'plain', emissive: 0 },
        ]);
        // With flat shading three re-derives a face normal per fragment and the
        // smoothed attribute is simply ignored, so this flag is what makes the
        // pass visible at all.
        expect((materialsOf(shiny)[1] as THREE.MeshPhysicalMaterial).flatShading).toBe(false);
        expect((materialsOf(plain)[1] as THREE.MeshLambertMaterial).flatShading).toBe(true);
    });

    it('leaves the base slot vertices untouched', () => {
        // One shiny leaf, one base leaf. The base leaf's normals must come back
        // exactly as authored — the mask restricts WRITING, so the base group
        // still contributes to the shiny group's average but never moves itself.
        const leaves: OctreeLeaf[] = [
            { x: 0, y: 0, z: 0, size: 0.1, r: 1, g: 1, b: 1, slot: 0 },
            { x: 0.1, y: 0.1, z: 0, size: 0.1, r: 1, g: 1, b: 1, slot: 1 },
        ];
        const shiny = buildOctreeMesh(leaves, 0, 0, 0, false, 'sn-mask-a', null, [
            { name: 'blade', emissive: 0, materialClass: 'metal' },
        ]);
        const plain = buildOctreeMesh(leaves, 0, 0, 0, false, 'sn-mask-b', null, [
            { name: 'blade', emissive: 0 },
        ]);

        const shinyNormals = normalsOf(shiny);
        const plainNormals = normalsOf(plain);
        const baseGroup = shiny.geometry.groups.find((g) => g.materialIndex === 0)!;
        const indices = shiny.geometry.getIndex()!.array as ArrayLike<number>;
        let checked = 0;
        for (let k = baseGroup.start; k < baseGroup.start + baseGroup.count; k++) {
            const v = indices[k]!;
            for (let c = 0; c < 3; c++) {
                expect(shinyNormals[v * 3 + c]).toBe(plainNormals[v * 3 + c]);
            }
            checked++;
        }
        expect(checked).toBeGreaterThan(0);
        // …while the mesh as a whole DID change, so this is not a vacuous pass.
        expect(shinyNormals).not.toEqual(plainNormals);
    });

    it('skips the pass on rounded geometry, which already has curved normals', () => {
        // Rounded arcs carry analytic curved normals — the exact thing the pass
        // approximates — so averaging them would only flatten what the emitter
        // computed exactly. The slot still counts as smoothed.
        const mesh = buildOctreeMesh(
            step(1), 0, 0, 0, false, 'sn-rounded',
            { radiusVoxels: 0.25, segments: 2 },
            [{ name: 'blade', emissive: 0, materialClass: 'chrome' }],
        );
        expect(shadingSmoothedStamp(mesh.geometry)).toBeNull();
        // chrome, not its unsmoothed fallback — the normals really are curved.
        const chrome = materialsOf(mesh)[1] as THREE.MeshPhysicalMaterial;
        expect(chrome).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(chrome.roughness).toBe(VOXEL_MATERIAL_CLASSES.chrome.roughness);
    });
});
