import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { AnimalEyeController, type AnimalEyeConfig } from 'engine/animal/AnimalEyeController.js';

/**
 * Configuration for creating a voxel-block snake.
 *
 * Snakes are built from a chain of box-geometry segments. The builder
 * creates a head, N body segments (with optional colour patterns), and
 * a tapered tail. Animation is handled by SnakeAnimationController.
 */
export interface SnakeConfig {
    /** Number of body segments between head and tail (default 12, range 6-30) */
    segmentCount?: number;

    /** Head colour (hex) */
    headColor: number;

    /** Primary body colour (hex) */
    bodyColor: number;

    /** Belly / underside colour (hex, optional) */
    bellyColor?: number;

    /** Pattern accent colour (hex, optional — requires patternType) */
    patternColor?: number;

    /** Pattern style applied along the body (default 'none') */
    patternType?: 'none' | 'stripes' | 'diamonds' | 'zigzag';

    /** Cross-section thickness of the body in metres (default 0.1) */
    bodyThickness?: number;

    /** Total nose-to-tail length in metres (default 1.5) */
    totalLength?: number;

    /** Explicit head dimensions override */
    headSize?: { width: number; height: number; depth: number };

    /** Eye configuration (slit-pupil yellow eyes by default) */
    eyes?: AnimalEyeConfig;

    /** Uniform scale applied after construction (default 1.0) */
    scale?: number;

    /** Movement speed in m/s (default 2.0) */
    moveSpeed?: number;

    /** Exponential smoothing rate for following terrain height (default 14) */
    terrainFollowSmoothing?: number;

    /** Max vertical speed when aligning to terrain in m/s (default 10) */
    terrainFollowMaxSpeed?: number;
}

/** Resolved dimensions returned after building, used by the controller. */
export interface SnakeDimensions {
    width: number;
    height: number;
    depth: number;
    segmentSpacing: number;
    segmentCount: number;
}

export class SnakeBodyBuilder {
    private static blockDepthCounter = 0;

    /**
     * Populate `characterGroup` with the full snake mesh hierarchy:
     * `SnakeHead` (with snout, tongue and eyes), `SnakeSegment_0..N-1`, `SnakeTail`.
     */
    static buildSnake(characterGroup: THREE.Group, config: SnakeConfig): SnakeDimensions {
        SnakeBodyBuilder.blockDepthCounter = 0;

        const segmentCount = Math.max(4, Math.min(30, config.segmentCount ?? 12));
        const bodyThickness = config.bodyThickness ?? 0.1;
        const totalLength = config.totalLength ?? 1.5;
        const headSize = config.headSize ?? {
            width: bodyThickness * 1.5,
            height: bodyThickness * 1.2,
            depth: bodyThickness * 1.8,
        };

        const headLength = headSize.depth;
        const tailLength = bodyThickness * 2.5;
        const bodyLength = totalLength - headLength - tailLength;
        const segmentSpacing = bodyLength / segmentCount;
        const segmentLength = segmentSpacing * 0.92;

        // ─── HEAD ───────────────────────────────────────────────────────
        const head = new THREE.Group();
        head.name = 'SnakeHead';
        head.position.set(0, bodyThickness * 0.5, 0);

        const headMesh = SnakeBodyBuilder.createBlock(
            headSize.width, headSize.height, headSize.depth, config.headColor,
        );
        headMesh.position.set(0, 0, headSize.depth * 0.5);
        head.add(headMesh);

        // Snout (narrower front)
        const snoutW = headSize.width * 0.65;
        const snoutH = headSize.height * 0.7;
        const snoutD = headSize.depth * 0.35;
        const snout = SnakeBodyBuilder.createBlock(snoutW, snoutH, snoutD, config.headColor);
        snout.position.set(0, -headSize.height * 0.08, headSize.depth * 0.85);
        head.add(snout);

        // Tongue
        const tongue = SnakeBodyBuilder.buildTongue(bodyThickness, headSize);
        head.add(tongue);

        // Eyes
        if (!config.eyes?.disabled) {
            characterGroup.userData.eyeController = SnakeBodyBuilder.addEyes(head, headSize, config);
        }

        characterGroup.add(head);

        // ─── BODY SEGMENTS ──────────────────────────────────────────────
        for (let i = 0; i < segmentCount; i++) {
            const segment = new THREE.Group();
            segment.name = `SnakeSegment_${i}`;

            const t = segmentCount > 1 ? i / (segmentCount - 1) : 0;
            const taper = 1.0 - t * 0.35;
            const segW = bodyThickness * taper;
            const segH = bodyThickness * taper * 0.85;

            const zPos = -(i * segmentSpacing + headLength * 0.25);
            segment.position.set(0, bodyThickness * 0.5, zPos);

            let segColor = config.bodyColor;
            if (config.patternColor && config.patternType && config.patternType !== 'none') {
                const usePattern =
                    (config.patternType === 'stripes' && i % 2 === 0) ||
                    (config.patternType === 'diamonds' && i % 3 === 1) ||
                    (config.patternType === 'zigzag' && i % 2 === 0);
                if (usePattern) segColor = config.patternColor;
            }

            const segMesh = SnakeBodyBuilder.createBlock(segW, segH, segmentLength, segColor);
            segment.add(segMesh);

            if (config.bellyColor) {
                const belly = SnakeBodyBuilder.createBlock(
                    segW * 0.75, segH * 0.28, segmentLength * 0.92, config.bellyColor,
                );
                belly.position.set(0, -segH * 0.42, 0);
                segment.add(belly);
            }

            characterGroup.add(segment);
        }

        // ─── TAIL ───────────────────────────────────────────────────────
        const tail = new THREE.Group();
        tail.name = 'SnakeTail';
        const tailThickness = bodyThickness * 0.35;
        const tailZ = -(segmentCount * segmentSpacing + headLength * 0.25);
        tail.position.set(0, bodyThickness * 0.5, tailZ);

        const tailMesh = SnakeBodyBuilder.createBlock(
            tailThickness, tailThickness * 0.7, tailLength, config.bodyColor,
        );
        tail.add(tailMesh);

        const tipMesh = SnakeBodyBuilder.createBlock(
            tailThickness * 0.3, tailThickness * 0.3, tailLength * 0.45, config.bodyColor,
        );
        tipMesh.position.set(0, 0, -tailLength * 0.55);
        tail.add(tipMesh);

        characterGroup.add(tail);

        // ─── SCALE ──────────────────────────────────────────────────────
        if (config.scale && config.scale !== 1.0) {
            characterGroup.scale.setScalar(config.scale);
        }

        const s = config.scale ?? 1.0;
        return {
            width: headSize.width * s,
            height: (bodyThickness * 1.5) * s,
            depth: totalLength * s,
            segmentSpacing,
            segmentCount,
        };
    }

    // ─── PRIVATE HELPERS ────────────────────────────────────────────────

    private static createBlock(w: number, h: number, d: number, color: number): THREE.Mesh {
        const geo = new THREE.BoxGeometry(w, h, d);
        // 'leather' — scales: the tight Phong lobe the old .55/.15 hand-tune
        // approximated, now on the quality ladder (Lambert on low).
        const mat = createClassedPartMaterial('leather', { color });
        const mesh = new THREE.Mesh(geo, mat);

        const z = 1.0 + SnakeBodyBuilder.blockDepthCounter * 0.001;
        mesh.scale.set(z, z, z);
        SnakeBodyBuilder.blockDepthCounter++;

        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
    }

    private static buildTongue(thickness: number, headSize: { width: number; height: number; depth: number }): THREE.Group {
        const tongue = new THREE.Group();
        tongue.name = 'SnakeTongue';

        const tw = thickness * 0.06;
        const th = thickness * 0.03;
        const td = headSize.depth * 0.45;

        const stem = SnakeBodyBuilder.createBlock(tw, th, td, 0xCC0000);
        stem.position.set(0, -headSize.height * 0.25, headSize.depth + td * 0.5);
        tongue.add(stem);

        const forkLen = td * 0.3;
        const forkOff = headSize.depth + td + forkLen * 0.4;
        for (const side of [-1, 1]) {
            const fork = SnakeBodyBuilder.createBlock(tw * 0.6, th * 0.8, forkLen, 0xCC0000);
            fork.position.set(side * tw * 0.7, -headSize.height * 0.25, forkOff);
            fork.rotation.y = side * 0.25;
            tongue.add(fork);
        }
        return tongue;
    }

    private static addEyes(
        head: THREE.Group,
        headSize: { width: number; height: number; depth: number },
        config: SnakeConfig,
    ): AnimalEyeController {
        const eyeCfg: AnimalEyeConfig = config.eyes ?? {};
        const eyeSize = eyeCfg.size ?? Math.min(headSize.width, headSize.height) * 0.28;

        const scleraW = eyeSize * 1.4;
        const scleraH = eyeSize * 1.2;
        const pupilW = eyeSize * 0.3;
        const pupilH = eyeSize * 1.0;
        const border = eyeSize * 0.05;
        const flat = 0.005;
        const pupilMaxOff = (scleraW - pupilW) * 0.25;

        const scleraColor = eyeCfg.scleraColor ?? 0xCCCC00;
        const pupilColor = eyeCfg.color ?? 0x111100;

        // Same glossy-eye triple as BlockAnimalBodyBuilder: matte rim,
        // soft-gloss sclera, wet-highlight pupil.
        const borderMat = createClassedPartMaterial('matte', { color: 0x000000 });
        const scleraMat = createClassedPartMaterial('plastic', { color: scleraColor });
        const pupilMat = createClassedPartMaterial('gem', { color: pupilColor });

        const borderGeo = new THREE.BoxGeometry(scleraW + border * 2, scleraH + border * 2, flat);
        const scleraGeo = new THREE.BoxGeometry(scleraW, scleraH, flat);
        const pupilGeo = new THREE.BoxGeometry(pupilW, pupilH, flat);

        const eyeX = headSize.width * 0.48;
        const eyeY = headSize.height * 0.2;
        const eyeZ = headSize.depth * 0.55;

        const controller = new AnimalEyeController(eyeCfg);

        // The left eye owns the geometries above; the right eye gets clones so
        // every mesh keeps its own disposable geometry.
        const makeEye = (
            prefix: 'Left' | 'Right',
            sign: -1 | 1,
            geos: { border: THREE.BufferGeometry; sclera: THREE.BufferGeometry; pupil: THREE.BufferGeometry },
        ) => {
            const grp = new THREE.Group();
            grp.name = `${prefix}Eye`;
            grp.position.set(sign * eyeX, eyeY, eyeZ);
            grp.rotation.y = sign * Math.PI / 2;

            const b = new THREE.Mesh(geos.border, borderMat);
            b.name = `${prefix}Border`;
            grp.add(b);

            const s = new THREE.Mesh(geos.sclera, scleraMat);
            s.name = `${prefix}Sclera`;
            s.position.z = 0.003;
            grp.add(s);

            const p = new THREE.Mesh(geos.pupil, pupilMat);
            p.name = `${prefix}Pupil`;
            p.position.z = 0.006;
            grp.add(p);

            head.add(grp);
            return { group: grp, sclera: s, pupil: p };
        };

        const left = makeEye('Left', -1, { border: borderGeo, sclera: scleraGeo, pupil: pupilGeo });
        const right = makeEye('Right', 1, { border: borderGeo.clone(), sclera: scleraGeo.clone(), pupil: pupilGeo.clone() });

        controller.setEyeReferences(
            head,
            left.group, right.group,
            left.pupil, right.pupil,
            left.sclera, right.sclera,
            pupilMaxOff,
        );

        return controller;
    }
}

/**
 * Create an IBlockCharacterFactory that builds a snake from the given config.
 * The returned factory also exposes `snakeDimensions` after `createBlockCharacter`
 * is called, which SnakeController uses for physics sizing.
 */
export function createSnakeFactory(config: SnakeConfig): IBlockCharacterFactory & { snakeDimensions?: SnakeDimensions } {
    const factory: IBlockCharacterFactory & { snakeDimensions?: SnakeDimensions } = {
        snakeDimensions: undefined,

        createBlockCharacter(characterGroup: THREE.Group): void {
            factory.snakeDimensions = SnakeBodyBuilder.buildSnake(characterGroup, config);
        },

        getCharacterDimensions(): { width: number; height: number; depth: number } {
            const built = factory.snakeDimensions;
            if (built) return { width: built.width, height: built.height, depth: built.depth };
            // Not built yet — estimate from the config's own defaults.
            const t = config.bodyThickness ?? 0.1;
            const s = config.scale ?? 1.0;
            return { width: t * 1.5 * s, height: t * 1.5 * s, depth: (config.totalLength ?? 1.5) * s };
        },
    };
    return factory;
}
