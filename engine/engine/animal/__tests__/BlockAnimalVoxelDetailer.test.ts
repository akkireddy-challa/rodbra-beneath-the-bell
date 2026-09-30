import * as THREE from 'three';
import {
    BlockAnimalBodyBuilder,
    type AnimalBlockConfig,
    type BlockAnimalBodyConfig,
} from 'engine/animal/BlockAnimalBodyBuilder.js';
import {
    buildDetailedPartMesh,
    clearAnimalDetailGeometryCache,
    getAnimalDetailGeometryCacheSize,
    resolveAnimalDetail,
    resolveAnimalVoxelSize,
    DEFAULT_ANIMAL_DETAIL,
    type AnimalDetailConfig,
} from 'engine/animal/BlockAnimalVoxelDetailer.js';

const BODY: AnimalBlockConfig[] = [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.3, depth: 0.6 }, color: 0x808080 },
];
const HEAD: AnimalBlockConfig[] = [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.2, height: 0.2, depth: 0.2 }, color: 0x808080 },
];
const LEG: AnimalBlockConfig[] = [
    { position: { y: -0.1 }, size: { width: 0.08, height: 0.2, depth: 0.08 }, color: 0x808080 },
];

function detailedConfig(detail?: AnimalDetailConfig): BlockAnimalBodyConfig {
    return {
        bodyBlocks: BODY,
        headBlocks: HEAD,
        frontLeftLegBlocks: LEG,
        frontRightLegBlocks: LEG,
        backLeftLegBlocks: LEG,
        backRightLegBlocks: LEG,
        eyes: { disabled: true },
        detail: detail ?? { colorJitter: 0.1, roundness: 0.5, seed: 3 },
    };
}

function build(config: BlockAnimalBodyConfig): THREE.Group {
    const group = new THREE.Group();
    BlockAnimalBodyBuilder.buildAnimal(group, config);
    return group;
}

function meshesOf(part: THREE.Object3D): THREE.Mesh[] {
    return part.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
}

beforeEach(() => {
    clearAnimalDetailGeometryCache();
});

describe('voxel detailer — determinism & cache', () => {
    const detail = resolveAnimalDetail({ colorJitter: 0.1, roundness: 0.4, seed: 5 });

    it('same blocks + detail + seed produce identical geometry, even after a cache clear', () => {
        const first = buildDetailedPartMesh('body', BODY, detail, 0.03);
        const positionsA = Array.from(first.geometry.getAttribute('position').array);
        const colorsA = Array.from(first.geometry.getAttribute('color').array);
        clearAnimalDetailGeometryCache();
        const second = buildDetailedPartMesh('body', BODY, detail, 0.03);
        expect(Array.from(second.geometry.getAttribute('position').array)).toEqual(positionsA);
        expect(Array.from(second.geometry.getAttribute('color').array)).toEqual(colorsA);
    });

    it('different seeds change voxel colors', () => {
        const a = buildDetailedPartMesh('body', BODY, resolveAnimalDetail({ colorJitter: 0.2, seed: 1 }), 0.03);
        const b = buildDetailedPartMesh('body', BODY, resolveAnimalDetail({ colorJitter: 0.2, seed: 2 }), 0.03);
        expect(Array.from(a.geometry.getAttribute('color').array))
            .not.toEqual(Array.from(b.geometry.getAttribute('color').array));
    });

    it('two builds share the SAME cached BufferGeometry (herd instancing)', () => {
        const a = buildDetailedPartMesh('body', BODY, detail, 0.03);
        const b = buildDetailedPartMesh('body', BODY, detail, 0.03);
        expect(b.geometry).toBe(a.geometry);
        expect(getAnimalDetailGeometryCacheSize()).toBe(1);
        // Releasing one reference must not kill the other's geometry
        const releaseA = a.userData.releaseSharedGeometry as () => void;
        releaseA();
        expect(b.geometry.getAttribute('position').count).toBeGreaterThan(0);
    });
});

describe('voxel detailer — budgets', () => {
    it('auto voxel size scales with body size and respects the floor', () => {
        const detail = DEFAULT_ANIMAL_DETAIL;
        // Tiny animal: floor at 0.02
        expect(resolveAnimalVoxelSize(detail, 0.3, BODY)).toBeGreaterThanOrEqual(0.02);
        // Big animal: dim/24
        const big = resolveAnimalVoxelSize(detail, 2.4, BODY);
        expect(big).toBeCloseTo(0.1);
    });

    it('coarsens the voxel size when the face budget would be exceeded', () => {
        // A huge surface area at a tiny authored voxel size must be clamped up
        const hugeBlocks: AnimalBlockConfig[] = [
            { position: { x: 0, y: 0, z: 0 }, size: { width: 3, height: 3, depth: 3 }, color: 0x808080 },
        ];
        const detail = resolveAnimalDetail({ voxelSize: 0.075 }); // clamp floor = dim/40 = 0.075
        const vs = resolveAnimalVoxelSize(detail, 3, hugeBlocks);
        // 54 m² / vs² at 0.075 = 9600 faces < 12000 OK; add more blocks to bust it
        const manyBlocks = Array.from({ length: 4 }, () => hugeBlocks[0]!);
        const vsBusted = resolveAnimalVoxelSize(detail, 3, manyBlocks);
        expect(vsBusted).toBeGreaterThan(vs);
    });

    it('per-part budget keeps a giant part under the face cap', () => {
        const giant: AnimalBlockConfig[] = [
            { position: { x: 0, y: 0, z: 0 }, size: { width: 2, height: 2, depth: 2 }, color: 0x808080 },
        ];
        const mesh = buildDetailedPartMesh('body', giant, resolveAnimalDetail({ roundness: 0 }), 0.02);
        const faceCount = mesh.geometry.getAttribute('position').count / 4;
        // 4000-face budget with some tolerance for surface quantization
        expect(faceCount).toBeLessThan(4000 * 1.3);
    });
});

describe('voxel detailer — voxelization correctness', () => {
    it('later blocks overwrite earlier ones (marking priority)', () => {
        const blocks: AnimalBlockConfig[] = [
            { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.3, depth: 0.3 }, color: 0xFF0000 },
            // Marking slab covering the +X face region
            { position: { x: 0.15, y: 0, z: 0 }, size: { width: 0.02, height: 0.3, depth: 0.3 }, color: 0x0000FF },
        ];
        const mesh = buildDetailedPartMesh('body', blocks, resolveAnimalDetail({ colorJitter: 0, roundness: 0 }), 0.03);
        const positions = mesh.geometry.getAttribute('position');
        const colors = mesh.geometry.getAttribute('color');
        // Find a vertex on the far +X side: it must be blue-dominant (b > r)
        let foundBlue = false;
        for (let i = 0; i < positions.count; i++) {
            if (positions.getX(i) > 0.14 && colors.getZ(i) > colors.getX(i)) {
                foundBlue = true;
                break;
            }
        }
        expect(foundBlue).toBe(true);
    });

    it('thin blocks never vanish (center-voxel fallback)', () => {
        const blocks: AnimalBlockConfig[] = [
            // Far thinner than any voxel — would miss every cell center without the fallback
            { position: { x: 0, y: 0.5, z: 0 }, size: { width: 0.005, height: 0.005, depth: 0.005 }, color: 0x00FF00 },
            { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.3, depth: 0.3 }, color: 0xFF0000 },
        ];
        const mesh = buildDetailedPartMesh('body', blocks, resolveAnimalDetail({ colorJitter: 0, roundness: 0 }), 0.05);
        const colors = mesh.geometry.getAttribute('color');
        let foundGreen = false;
        for (let i = 0; i < colors.count; i++) {
            if (colors.getY(i) > 0.9 && colors.getX(i) < 0.1) {
                foundGreen = true;
                break;
            }
        }
        expect(foundGreen).toBe(true);
    });

    it('roundness carves corners (fewer voxels than the hard box)', () => {
        const sharp = buildDetailedPartMesh('body', BODY, resolveAnimalDetail({ roundness: 0, colorJitter: 0 }), 0.03);
        clearAnimalDetailGeometryCache();
        const round = buildDetailedPartMesh('body', BODY, resolveAnimalDetail({ roundness: 1, colorJitter: 0 }), 0.03);
        // Rounded silhouette = corners removed = different (and not larger) geometry
        expect(round.geometry.getAttribute('position').count)
            .toBeLessThanOrEqual(sharp.geometry.getAttribute('position').count + 1);
        expect(Array.from(round.geometry.getAttribute('position').array))
            .not.toEqual(Array.from(sharp.geometry.getAttribute('position').array));
    });

    it('belly pattern recolors the lower body only', () => {
        const detail = resolveAnimalDetail({
            colorJitter: 0,
            roundness: 0,
            pattern: { type: 'belly', color: 0xFFFFFF },
        });
        const mesh = buildDetailedPartMesh('body', BODY, detail, 0.03);
        const positions = mesh.geometry.getAttribute('position');
        const colors = mesh.geometry.getAttribute('color');
        let lowWhite = 0, highWhite = 0;
        for (let i = 0; i < positions.count; i++) {
            const isWhite = colors.getX(i) > 0.9;
            if (positions.getY(i) < -0.1 && isWhite) lowWhite++;
            if (positions.getY(i) > 0.1 && isWhite) highWhite++;
        }
        expect(lowWhite).toBeGreaterThan(0);
        expect(highWhite).toBe(0);
    });

    it('belly pattern skips legs by default', () => {
        const detail = resolveAnimalDetail({
            colorJitter: 0,
            roundness: 0,
            pattern: { type: 'belly', color: 0xFFFFFF },
        });
        const mesh = buildDetailedPartMesh('leg', LEG, detail, 0.03);
        const colors = mesh.geometry.getAttribute('color');
        for (let i = 0; i < colors.count; i++) {
            expect(colors.getX(i)).toBeLessThan(0.9);
        }
    });
});

describe('voxel detailer — builder integration', () => {
    it('config WITHOUT detail renders classic per-block boxes (back-compat)', () => {
        const config = detailedConfig();
        delete config.detail;
        const animal = build(config);
        const body = animal.getObjectByName('AnimalBody')!;
        const bodyMeshes = meshesOf(body);
        expect(bodyMeshes).toHaveLength(BODY.length);
        expect(bodyMeshes[0]!.geometry).toBeInstanceOf(THREE.BoxGeometry);
        // z-fight scale offsets still applied
        expect(bodyMeshes[0]!.scale.x).toBeCloseTo(1.0, 5);
    });

    it('config WITH detail renders ONE merged vertex-color Lambert mesh per part', () => {
        const animal = build(detailedConfig());
        for (const partName of ['AnimalBody', 'AnimalHead', 'FrontLeftLeg', 'BackRightLeg']) {
            const part = animal.getObjectByName(partName)!;
            const meshes = meshesOf(part);
            expect(meshes).toHaveLength(1);
            const mesh = meshes[0]!;
            expect(mesh.geometry.getAttribute('color')).toBeDefined();
            const material = mesh.material as THREE.MeshLambertMaterial;
            expect(material.vertexColors).toBe(true);
            expect(mesh.userData.sharedDetailGeometry).toBe(true);
        }
    });

    it('all four identical legs share one cached geometry', () => {
        const animal = build(detailedConfig());
        const legMeshes = ['FrontLeftLeg', 'FrontRightLeg', 'BackLeftLeg', 'BackRightLeg']
            .map(name => meshesOf(animal.getObjectByName(name)!)[0]!);
        expect(legMeshes[1]!.geometry).toBe(legMeshes[0]!.geometry);
        expect(legMeshes[3]!.geometry).toBe(legMeshes[0]!.geometry);
    });

    it('eyes sit beyond the voxel surface when detail is active', () => {
        const config = detailedConfig();
        config.eyes = { placement: 'front' };
        const withDetail = build(config);
        const eyeWith = withDetail.getObjectByName('LeftEye')!;

        const plainConfig = detailedConfig();
        delete plainConfig.detail;
        plainConfig.eyes = { placement: 'front' };
        const plain = build(plainConfig);
        const eyePlain = plain.getObjectByName('LeftEye')!;

        expect(eyeWith.position.z).toBeGreaterThan(eyePlain.position.z);
    });
});
