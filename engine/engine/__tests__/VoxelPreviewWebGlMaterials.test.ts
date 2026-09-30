import * as THREE from 'three';
import { VoxelPreviewRenderer } from 'engine/VoxelPreviewRenderer.js';
import { EMISSIVE_INTENSITY, isVoxelEmissiveMaterial, VOXEL_EMISSIVE_FLAG } from 'engine/VoxelEmissiveMaterial.js';
import {
    slotInfoFromMaterial,
    VOXEL_SLOT_CLASS,
    VOXEL_SLOT_FLAG,
    VOXEL_SLOT_LEVEL,
    VOXEL_SLOT_SMOOTHED,
} from 'engine/VoxelSlotMaterial.js';

/**
 * Asset thumbnails render through this class's own THREE.WebGLRenderer, but the
 * meshes are built by the engine's backend-aware material factory — a TSL node
 * material whenever the engine runs WebGPU (the default). WebGLRenderer cannot
 * compile one: it falls back to `material.vertexShader` (undefined) and throws
 * "Cannot read properties of undefined (reading 'replace')", once per asset,
 * with no preview ever cached.
 *
 * The real `MeshLambertNodeMaterial` is stubbed out under Jest (three/webgpu is
 * ESM-only), so a stand-in carries three's own `isNodeMaterial` marker — the
 * property the conversion keys on.
 */

interface Convertible {
    useWebGlMaterials(root: THREE.Object3D): void;
}

function nodeMaterialStandIn(over: Record<string, unknown> = {}): THREE.Material {
    const material = new THREE.Material();
    Object.assign(material, {
        isNodeMaterial: true,
        vertexColors: true,
        flatShading: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 5,
    }, over);
    return material;
}

/** Run the conversion over a one-mesh scene and hand back the resulting material. */
function convert(material: THREE.Material): THREE.Material {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    (new VoxelPreviewRenderer() as unknown as Convertible).useWebGlMaterials(mesh);
    return mesh.material as THREE.Material;
}

describe('VoxelPreviewRenderer WebGL material conversion', () => {
    it('replaces a node material with a WebGL one', () => {
        const material = convert(nodeMaterialStandIn()) as THREE.Material & { isNodeMaterial?: boolean };

        expect(material.isNodeMaterial).not.toBe(true);
        expect(material).toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it('carries the visual parameters across', () => {
        const map = new THREE.Texture();
        const source = nodeMaterialStandIn({ map, vertexColors: false, flatShading: false });

        const material = convert(source) as THREE.MeshLambertMaterial;

        expect(material.map).toBe(map);
        expect(material.vertexColors).toBe(false);
        expect(material.flatShading).toBe(false);
        // Dropping the offset would z-fight the preview against itself.
        expect(material.polygonOffsetFactor).toBe(3);
        expect(material.polygonOffsetUnits).toBe(5);
    });

    it('keeps an emissive asset glowing', () => {
        const source = nodeMaterialStandIn();
        source.userData[VOXEL_EMISSIVE_FLAG] = true;

        const material = convert(source) as THREE.MeshLambertMaterial;

        expect(isVoxelEmissiveMaterial(material)).toBe(true);
        // The 0..1 control; the hue-preserving gain is applied per fragment.
        expect(material.emissiveIntensity).toBe(1);
    });

    it('leaves an already-WebGL material untouched', () => {
        const source = new THREE.MeshLambertMaterial();

        expect(convert(source)).toBe(source);
    });
});

/**
 * A mesh with material SLOTS carries an ARRAY of materials, and the conversion
 * used to bail on an array outright.
 *
 * That was survivable only while slotted assets were rare: every entry is a node
 * material under WebGPU, so such an asset hit the throw described above and
 * simply never got a thumbnail. Material CLASSES put most assets on that path, so
 * the array has to be converted entry by entry — and slot entries have to go back
 * through the SLOT factory, or a gold slot previews as flat paint.
 */
describe('VoxelPreviewRenderer converts a material ARRAY', () => {
    /** Run the conversion over a one-mesh scene carrying a material array. */
    function convertArray(materials: THREE.Material[]): THREE.Material[] {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials);
        (new VoxelPreviewRenderer() as unknown as Convertible).useWebGlMaterials(mesh);
        return mesh.material as THREE.Material[];
    }

    /** A node-material stand-in that also describes itself as a slot. */
    function slotStandIn(materialClass: string | undefined, smoothed = true): THREE.Material {
        const material = nodeMaterialStandIn();
        material.userData[VOXEL_SLOT_FLAG] = 'trim';
        material.userData[VOXEL_SLOT_LEVEL] = 0;
        material.userData[VOXEL_SLOT_SMOOTHED] = smoothed;
        if (materialClass !== undefined) material.userData[VOXEL_SLOT_CLASS] = materialClass;
        return material;
    }

    it('converts every entry instead of skipping the whole array', () => {
        const converted = convertArray([nodeMaterialStandIn(), nodeMaterialStandIn()]);

        expect(converted).toHaveLength(2);
        for (const material of converted) {
            expect((material as THREE.Material & { isNodeMaterial?: boolean }).isNodeMaterial)
                .not.toBe(true);
        }
    });

    it('rebuilds a slot entry as a slot material, keeping its class', () => {
        const converted = convertArray([nodeMaterialStandIn(), slotStandIn('gold')]);

        // A gold slot must preview as gold, not as the generic voxel Lambert.
        expect(converted[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(converted[1]).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(slotInfoFromMaterial(converted[1]!)!.materialClass).toBe('gold');
        expect(slotInfoFromMaterial(converted[1]!)!.name).toBe('trim');
    });

    it('rebuilds a class-free slot entry as the plain slot material', () => {
        const converted = convertArray([slotStandIn(undefined)]);

        expect(converted[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(slotInfoFromMaterial(converted[0]!)!.materialClass).toBe('matte');
    });

    it('leaves an array of already-WebGL materials untouched', () => {
        const a = new THREE.MeshLambertMaterial();
        const b = new THREE.MeshLambertMaterial();

        expect(convertArray([a, b])).toEqual([a, b]);
    });
});
