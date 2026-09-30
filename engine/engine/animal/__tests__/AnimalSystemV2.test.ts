import * as THREE from 'three';
import {
    BlockAnimalBodyBuilder,
    createBlockAnimalFactory,
    type AnimalBlockConfig,
    type BlockAnimalBodyConfig,
} from 'engine/animal/BlockAnimalBodyBuilder.js';
import { BlockAnimalAnimationController } from 'engine/animal/BlockAnimalAnimationController.js';
import { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';
import { Animal3DMovement, DEFAULT_SWIM_MOVEMENT_OPTIONS } from 'engine/animal/AnimalLocomotion3D.js';
import type { EngineLike } from 'types/game.js';

const BODY: AnimalBlockConfig[] = [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.4, depth: 0.8 }, color: 0x888888 },
];
const HEAD: AnimalBlockConfig[] = [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.2, height: 0.2, depth: 0.2 }, color: 0x888888 },
];
const LEG: AnimalBlockConfig[] = [
    { position: { y: -0.1 }, size: { width: 0.08, height: 0.2, depth: 0.08 }, color: 0x888888 },
];
const TAIL: AnimalBlockConfig[] = [
    { position: { x: 0, y: 0, z: -0.1 }, size: { width: 0.08, height: 0.08, depth: 0.2 }, color: 0x888888 },
];

function quadrupedConfig(): BlockAnimalBodyConfig {
    return {
        bodyBlocks: BODY,
        headBlocks: HEAD,
        frontLeftLegBlocks: LEG,
        frontRightLegBlocks: LEG,
        backLeftLegBlocks: LEG,
        backRightLegBlocks: LEG,
        eyes: { disabled: true },
    };
}

function fishConfig(): BlockAnimalBodyConfig {
    return {
        bodyBlocks: BODY,
        headBlocks: HEAD,
        tailBlocks: TAIL,
        tailFinBlocks: [
            { position: { x: 0, y: 0, z: -0.05 }, size: { width: 0.02, height: 0.2, depth: 0.1 }, color: 0x888888 },
        ],
        leftFinBlocks: [
            { position: { x: -0.08, y: 0, z: 0 }, size: { width: 0.15, height: 0.02, depth: 0.1 }, color: 0x888888 },
        ],
        dorsalFinBlocks: [
            { position: { x: 0, y: 0.08, z: 0 }, size: { width: 0.02, height: 0.15, depth: 0.2 }, color: 0x888888 },
        ],
        eyes: { disabled: true },
    };
}

function birdConfig(): BlockAnimalBodyConfig {
    return {
        bodyPlan: 'bird',
        bodyBlocks: BODY,
        headBlocks: HEAD,
        backLeftLegBlocks: LEG,
        backRightLegBlocks: LEG,
        leftWingBlocks: [
            { position: { x: -0.2, y: 0, z: 0 }, size: { width: 0.4, height: 0.04, depth: 0.3 }, color: 0x888888 },
        ],
        leftWingOuterBlocks: [
            { position: { x: -0.15, y: 0, z: 0 }, size: { width: 0.3, height: 0.03, depth: 0.25 }, color: 0x888888 },
        ],
        eyes: { disabled: true },
    };
}

function build(config: BlockAnimalBodyConfig): THREE.Group {
    const group = new THREE.Group();
    BlockAnimalBodyBuilder.buildAnimal(group, config);
    return group;
}

describe('BlockAnimalBodyBuilder.resolveBodyPlan', () => {
    it('infers quadruped from four leg arrays', () => {
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(quadrupedConfig())).toBe('quadruped');
    });

    it('infers biped from back legs only', () => {
        const config = quadrupedConfig();
        delete config.frontLeftLegBlocks;
        delete config.frontRightLegBlocks;
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(config)).toBe('biped');
    });

    it('infers fish from no legs at all', () => {
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(fishConfig())).toBe('fish');
    });

    it('explicit bodyPlan wins over inference', () => {
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(birdConfig())).toBe('bird');
    });

    it('maps plans to locomotion modes', () => {
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('quadruped')).toBe('ground');
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('biped')).toBe('ground');
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('fish')).toBe('swim');
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('bird')).toBe('fly');
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('dragon')).toBe('fly');
    });

    it('dragon: explicit plan makes a winged quadruped fly; without it, wings stay grounded', () => {
        const dragonConfig = quadrupedConfig();
        dragonConfig.leftWingBlocks = [
            { position: { x: -0.3, y: 0, z: 0 }, size: { width: 0.6, height: 0.05, depth: 0.4 }, color: 0x888888 },
        ];
        // Quadruped + wings, no explicit plan → GROUND dragon
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(dragonConfig)).toBe('quadruped');
        // Explicit dragon plan → flying
        dragonConfig.bodyPlan = 'dragon';
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(dragonConfig)).toBe('dragon');

        const dragon = build(dragonConfig);
        expect(dragon.userData.bodyPlan).toBe('dragon');
        expect(dragon.userData.locomotionMode).toBe('fly');
        // Keeps all four legs AND gets mirrored wings
        expect(dragon.getObjectByName('FrontLeftLeg')).toBeDefined();
        expect(dragon.getObjectByName('BackRightLeg')).toBeDefined();
        expect(dragon.getObjectByName('LeftWing')).toBeDefined();
        expect(dragon.getObjectByName('RightWing')).toBeDefined();

        expect(createBlockAnimalFactory(dragonConfig).getLocomotionMode?.()).toBe('fly');
    });
});

describe('BlockAnimalBodyBuilder.buildAnimal', () => {
    it('stamps bodyPlan and locomotionMode on the character group', () => {
        const fish = build(fishConfig());
        expect(fish.userData.bodyPlan).toBe('fish');
        expect(fish.userData.locomotionMode).toBe('swim');

        const bird = build(birdConfig());
        expect(bird.userData.bodyPlan).toBe('bird');
        expect(bird.userData.locomotionMode).toBe('fly');

        const dog = build(quadrupedConfig());
        expect(dog.userData.bodyPlan).toBe('quadruped');
        expect(dog.userData.locomotionMode).toBe('ground');
    });

    it('creates no leg groups for a legless fish', () => {
        const fish = build(fishConfig());
        for (const name of ['FrontLeftLeg', 'FrontRightLeg', 'BackLeftLeg', 'BackRightLeg']) {
            expect(fish.getObjectByName(name)).toBeUndefined();
        }
    });

    it('positions a legless body so its lowest block sits at the group origin', () => {
        const fish = build(fishConfig());
        const body = fish.getObjectByName('AnimalBody');
        expect(body).toBeDefined();
        // Body blocks span y ∈ [−0.2, 0.2] → lifted by 0.2
        expect(body!.position.y).toBeCloseTo(0.2);
    });

    it('attaches the fish tail at mid-height, the quadruped tail above it', () => {
        const fish = build(fishConfig());
        const fishTail = fish.getObjectByName('AnimalTail');
        expect(fishTail).toBeDefined();
        // Body centered at y=0 → fish midline = 0
        expect(fishTail!.position.y).toBeCloseTo(0);

        const dogConfig = quadrupedConfig();
        dogConfig.tailBlocks = TAIL;
        const dog = build(dogConfig);
        const dogTail = dog.getObjectByName('AnimalTail');
        expect(dogTail).toBeDefined();
        // Ground plan keeps the historical top-quartile attachment (maxY * 0.5 = 0.1)
        expect(dogTail!.position.y).toBeCloseTo(0.1);
    });

    it('creates fins for fish: pectoral pair (auto-mirrored), dorsal, tail fin', () => {
        const fish = build(fishConfig());
        const leftFin = fish.getObjectByName('LeftFin');
        const rightFin = fish.getObjectByName('RightFin');
        expect(leftFin).toBeDefined();
        expect(rightFin).toBeDefined();
        // Auto-mirrored: attachments on opposite sides of the body
        expect(leftFin!.position.x).toBeCloseTo(-rightFin!.position.x);
        // Mirrored geometry: block x negated
        const leftBlock = leftFin!.children[0] as THREE.Mesh;
        const rightBlock = rightFin!.children[0] as THREE.Mesh;
        expect(leftBlock.position.x).toBeCloseTo(-rightBlock.position.x);

        expect(fish.getObjectByName('DorsalFin')).toBeDefined();

        const tailFin = fish.getObjectByName('TailFin');
        expect(tailFin).toBeDefined();
        // Child of the tail, pivoted at the tail's rear extent (z = −0.2)
        expect(tailFin!.parent?.name).toBe('AnimalTail');
        expect(tailFin!.position.z).toBeCloseTo(-0.2);
    });

    it('creates two-segment wings with the outer pivot at the inner edge', () => {
        const bird = build(birdConfig());
        const leftWing = bird.getObjectByName('LeftWing');
        const rightWing = bird.getObjectByName('RightWing');
        expect(leftWing).toBeDefined();
        expect(rightWing).toBeDefined();
        // Wings attach to body sides (auto-mirrored)
        expect(leftWing!.position.x).toBeCloseTo(-rightWing!.position.x);

        const leftOuter = bird.getObjectByName('LeftWingOuter');
        const rightOuter = bird.getObjectByName('RightWingOuter');
        expect(leftOuter).toBeDefined();
        expect(rightOuter).toBeDefined();
        expect(leftOuter!.parent?.name).toBe('LeftWing');
        // Inner wing spans x ∈ [−0.4, 0] → outer pivot at −0.4
        expect(leftOuter!.position.x).toBeCloseTo(-0.4);
        expect(rightOuter!.position.x).toBeCloseTo(0.4);
    });

    it('wedge blocks produce a triangular prism (8 faces, box-matching bounds)', () => {
        const config = fishConfig();
        config.headBlocks = [
            { position: { x: 0, y: 0, z: 0 }, size: { width: 0.2, height: 0.1, depth: 0.3 }, color: 0x888888, shape: 'wedge' },
        ];
        const fish = build(config);
        const head = fish.getObjectByName('AnimalHead');
        const wedge = head!.children[0] as THREE.Mesh;
        const positions = wedge.geometry.getAttribute('position');
        // 8 triangles (2 bottom + 2 back + 2 slope + 1 left + 1 right) × 3 vertices
        expect(positions.count).toBe(24);
        wedge.geometry.computeBoundingBox();
        const box = wedge.geometry.boundingBox!;
        expect(box.max.x - box.min.x).toBeCloseTo(0.2);
        expect(box.max.y - box.min.y).toBeCloseTo(0.1);
        expect(box.max.z - box.min.z).toBeCloseTo(0.3);
    });

    it('factory exposes the locomotion mode for spawn-position logic', () => {
        expect(createBlockAnimalFactory(fishConfig()).getLocomotionMode?.()).toBe('swim');
        expect(createBlockAnimalFactory(birdConfig()).getLocomotionMode?.()).toBe('fly');
        expect(createBlockAnimalFactory(quadrupedConfig()).getLocomotionMode?.()).toBe('ground');
    });

    it('legless shoulder-height scaling targets overall body height', () => {
        expect(BlockAnimalBodyBuilder.calculateShoulderHeight(fishConfig())).toBeCloseTo(0.4);
    });
});

describe('cephalopods (octopus / squid)', () => {
    function octopusConfig(): BlockAnimalBodyConfig {
        return {
            bodyBlocks: BODY,
            headBlocks: HEAD,
            tentacleBlocks: [
                // Extends DOWNWARD from the pivot: y ∈ [−0.3, 0]
                { position: { x: 0, y: -0.15, z: 0 }, size: { width: 0.05, height: 0.3, depth: 0.05 }, color: 0x888888 },
            ],
            eyes: { disabled: true },
        };
    }

    it('legless + tentacles infers the cephalopod plan, which swims', () => {
        expect(BlockAnimalBodyBuilder.resolveBodyPlan(octopusConfig())).toBe('cephalopod');
        expect(BlockAnimalBodyBuilder.locomotionModeForPlan('cephalopod')).toBe('swim');
        expect(createBlockAnimalFactory(octopusConfig()).getLocomotionMode?.()).toBe('swim');
    });

    it('instances a ring of 8 tentacles by default, clamped custom counts', () => {
        const octopus = build(octopusConfig());
        expect(octopus.userData.bodyPlan).toBe('cephalopod');
        expect(octopus.userData.locomotionMode).toBe('swim');
        for (let i = 0; i < 8; i++) {
            expect(octopus.getObjectByName(`Tentacle${i}`)).toBeDefined();
        }
        expect(octopus.getObjectByName('Tentacle8')).toBeUndefined();

        const config = octopusConfig();
        config.tentacleCount = 99; // clamped to 12
        const many = build(config);
        expect(many.getObjectByName('Tentacle11')).toBeDefined();
        expect(many.getObjectByName('Tentacle12')).toBeUndefined();
    });

    it('attaches the ring at the body underside and lifts the body by the tentacle drop', () => {
        const octopus = build(octopusConfig());
        const body = octopus.getObjectByName('AnimalBody');
        // Body blocks span y ∈ [−0.2, 0.2]; tentacles hang 0.3 below the pivot
        // → body lifted to 0.2 + 0.3 so tentacle tips reach the group origin
        expect(body!.position.y).toBeCloseTo(0.5);
        const tentacle = octopus.getObjectByName('Tentacle0');
        // Ring pivot sits at the body's bottom face (local y = −0.2)
        expect(tentacle!.position.y).toBeCloseTo(-0.2);
        // Ring radius: 35% of body width on X for tentacle 0 (angle 0)
        expect(tentacle!.position.x).toBeCloseTo(0.3 * 0.35);
    });

    it('auto-flips tentacles authored upward and adds the squid feeding pair at ±X', () => {
        const config = octopusConfig();
        // Authored UPWARD by mistake: y ∈ [0, 0.3]
        config.tentacleBlocks = [
            { position: { x: 0, y: 0.15, z: 0 }, size: { width: 0.05, height: 0.3, depth: 0.05 }, color: 0x888888 },
        ];
        config.longTentacleBlocks = [
            { position: { x: 0, y: -0.25, z: 0 }, size: { width: 0.04, height: 0.5, depth: 0.04 }, color: 0x888888 },
        ];
        const squid = build(config);
        const tentacle = squid.getObjectByName('Tentacle0');
        const block = tentacle!.children[0] as THREE.Mesh;
        expect(block.position.y).toBeCloseTo(-0.15); // flipped downward

        const left = squid.getObjectByName('LongTentacle0');
        const right = squid.getObjectByName('LongTentacle1');
        expect(left).toBeDefined();
        expect(right).toBeDefined();
        expect(left!.position.x).toBeCloseTo(-right!.position.x);
        // Long pair (0.5 drop) dominates the body lift: 0.2 + 0.5
        expect(squid.getObjectByName('AnimalBody')!.position.y).toBeCloseTo(0.7);
    });
});

describe('ground wing animation', () => {
    async function maxWingDeviation(config: BlockAnimalBodyConfig, state: string): Promise<number> {
        const group = build(config);
        const controller = new BlockAnimalAnimationController();
        await controller.initializeWithCharacter(group, null, null, []);
        controller.setState(state);
        const wing = group.getObjectByName('LeftWing')!;
        const originalZ = wing.rotation.z;
        let maxDeviation = 0;
        // 2 simulated seconds at 60 fps — covers several flap cycles at any frequency
        for (let i = 0; i < 120; i++) {
            controller.update(1 / 60);
            maxDeviation = Math.max(maxDeviation, Math.abs(wing.rotation.z - originalZ));
        }
        return maxDeviation;
    }

    const WING = [
        { position: { x: -0.2, y: 0, z: 0 }, size: { width: 0.4, height: 0.04, depth: 0.3 }, color: 0x888888 },
    ];

    it('winged QUADRUPEDS keep wings folded at every ground gait (dragons never flap on foot)', async () => {
        for (const state of ['walk', 'trot', 'run']) {
            const config = quadrupedConfig();
            config.leftWingBlocks = WING;
            const deviation = await maxWingDeviation(config, state);
            // Idle settle only (~0.05 rad) — anything bigger reads as flapping
            expect(deviation).toBeLessThan(0.1);
        }
    });

    it('winged QUADRUPEDS tuck wings back against the flanks while grounded', async () => {
        const config = quadrupedConfig();
        config.leftWingBlocks = WING;
        const group = build(config);
        const controller = new BlockAnimalAnimationController();
        await controller.initializeWithCharacter(group, null, null, []);
        controller.setState('walk');
        for (let i = 0; i < 240; i++) controller.update(1 / 60);
        const leftWing = group.getObjectByName('LeftWing')!;
        const rightWing = group.getObjectByName('RightWing')!;
        // Swept back: left wing rotates negative around Y, right mirrors positive
        expect(leftWing.rotation.y).toBeLessThan(-1.0);
        expect(rightWing.rotation.y).toBeGreaterThan(1.0);
    });

    it('winged BIPEDS still flutter when running (chickens keep their charm)', async () => {
        const config = quadrupedConfig();
        delete config.frontLeftLegBlocks;
        delete config.frontRightLegBlocks;
        config.leftWingBlocks = WING;
        const deviation = await maxWingDeviation(config, 'run');
        expect(deviation).toBeGreaterThan(0.3);
    });
});

describe('quadruped gait phase tables', () => {
    it('walk is a 4-beat gait — every foot lands at a distinct quarter phase', () => {
        const gait = BlockAnimalAnimationController.GAIT_WALK;
        const phases = [gait.frontLeft, gait.frontRight, gait.backLeft, gait.backRight].sort();
        expect(phases).toEqual([0.0, 0.25, 0.5, 0.75]);
    });

    it('trot keeps diagonal pairs in sync, half a cycle apart', () => {
        const gait = BlockAnimalAnimationController.GAIT_TROT;
        expect(gait.frontLeft).toBe(gait.backRight);
        expect(gait.frontRight).toBe(gait.backLeft);
        expect(Math.abs(gait.frontLeft - gait.frontRight)).toBeCloseTo(0.5);
    });

    it('gallop groups front and hind pairs with a small intra-pair lag', () => {
        const gait = BlockAnimalAnimationController.GAIT_GALLOP;
        const frontLag = Math.abs(gait.frontRight - gait.frontLeft);
        const hindLag = Math.abs(gait.backRight - gait.backLeft);
        expect(frontLag).toBeGreaterThan(0);
        expect(frontLag).toBeLessThan(0.25);
        expect(hindLag).toBeGreaterThan(0);
        expect(hindLag).toBeLessThan(0.25);
        // Pairs land roughly opposite each other in the cycle
        expect(Math.abs(gait.backLeft - gait.frontLeft)).toBeCloseTo(0.5);
    });
});

describe('AnimalMediumSensor without a voxel world', () => {
    const engineStub = {
        getDynamicObjectManager: () => null,
        getWorldHeightAt: (_x: number, _z: number) => 7.5,
    } as unknown as EngineLike;

    it('degrades gracefully: water queries are false/null, terrain passes through', () => {
        const sensor = new AnimalMediumSensor(engineStub);
        expect(sensor.hasVoxelWorld()).toBe(false);
        expect(sensor.isWaterAt(0, 0, 0)).toBe(false);
        expect(sensor.findWaterSurfaceY(0, 0, 0)).toBeNull();
        expect(sensor.findSubmergedY(0, 0)).toBeNull();
        expect(sensor.getTerrainHeightAt(3, 4)).toBe(7.5);
    });

    it('returns null terrain height when the engine cannot answer', () => {
        const bare = { getDynamicObjectManager: () => null } as unknown as EngineLike;
        const sensor = new AnimalMediumSensor(bare);
        expect(sensor.getTerrainHeightAt(0, 0)).toBeNull();
    });
});

describe('Animal3DMovement', () => {
    it('tracks medium state and resets cleanly', () => {
        const movement = new Animal3DMovement(3.0, DEFAULT_SWIM_MOVEMENT_OPTIONS);
        expect(movement.isInMedium()).toBe(true);
        movement.setInMedium(false);
        expect(movement.isInMedium()).toBe(false);
        movement.setInMedium(true);
        expect(movement.isInMedium()).toBe(true);

        movement.setRotation(1.2);
        expect(movement.getRotation()).toBe(1.2);
        movement.reset();
        expect(movement.getCurrentSpeed()).toBe(0);
        expect(movement.getVelocity().length()).toBe(0);
    });

    it('supports continuous ascend/descend (3D volume controls)', () => {
        const movement = new Animal3DMovement(3.0, DEFAULT_SWIM_MOVEMENT_OPTIONS);
        expect(movement.getSupportedKeys()).toEqual({ ascend: true, descend: true });
        expect(movement.getKeyBehavior()).toEqual({ ascend: 'continuous', descend: 'continuous' });
    });
});
