import * as THREE from 'three';
import { AnimalController } from 'engine/animal/AnimalController.js';
import { NpcLodComponent } from 'engine/npc/core/NpcLodComponent.js';
import { HibernationComponent } from 'engine/character/HibernationComponent.js';
import {
    SimClass, ALWAYS_FULL_LOD_STATE,
} from 'engine/character/CharacterLodScheduler.js';

/**
 * LOD integration tests over a bare AnimalController built with
 * Object.create(AnimalController.prototype) (same pattern as
 * NpcControllerLod.test.ts) — the heavy constructor never runs, so only the
 * fields each method touches are stubbed in.
 */

const NOOP_HOOKS = {
    setBodyEnabled: (): void => { /* noop */ },
    snapBodyToVisual: (): void => { /* noop */ },
    setShadowsEnabled: (): void => { /* noop */ },
};

interface NavStub {
    getCurrentWaypoint(): THREE.Vector3 | null;
    advanceWaypoint(): void;
    hasPath(): boolean;
    getCurrentTarget(): THREE.Vector3 | null;
    clearPath(): void;
    setTargetPosition(target: THREE.Vector3 | null): void;
}

interface HealthStub {
    isExploded(): boolean;
    isDead(): boolean;
}

interface ControllerInternals {
    character: THREE.Object3D;
    moveSpeed: number;
    locomotionMode: 'ground' | 'swim' | 'fly';
    lodComp: NpcLodComponent;
    hibernationComp: HibernationComponent;
    healthComp: HealthStub;
    navigationComp: NavStub;
    behavior: null;
    _virtualNullGroundTicks: number;
    updateVirtual(): void;
    updateLocomotion3DLod(deltaTime: number): void;
}

function makeNavStub(waypoints: THREE.Vector3[]): NavStub {
    let index = 0;
    return {
        getCurrentWaypoint: () => waypoints[index]?.clone() ?? null,
        advanceWaypoint: () => { index++; },
        hasPath: () => index < waypoints.length,
        getCurrentTarget: () => null,
        clearPath: () => { waypoints.length = 0; },
        setTargetPosition: () => { /* noop */ },
    };
}

function makeController(locomotionMode: 'ground' | 'swim' | 'fly' = 'ground'): {
    controller: AnimalController;
    internals: ControllerInternals;
} {
    const controller = Object.create(AnimalController.prototype) as AnimalController;
    const internals = controller as unknown as ControllerInternals;
    internals.character = new THREE.Object3D();
    internals.moveSpeed = 2;
    internals.locomotionMode = locomotionMode;
    internals.lodComp = new NpcLodComponent(
        NOOP_HOOKS,
        locomotionMode !== 'ground' ? SimClass.COARSE : undefined,
    );
    internals.hibernationComp = new HibernationComponent({
        onHibernate: () => { /* noop */ },
        onWake: () => { /* noop */ },
    });
    internals.hibernationComp.setAlwaysActive(true); // constructor default
    internals.healthComp = { isExploded: () => false, isDead: () => false };
    internals.behavior = null;
    internals.navigationComp = makeNavStub([]);
    internals._virtualNullGroundTicks = 0;
    return { controller, internals };
}

describe('AnimalController LOD integration', () => {
    test('updateVirtual dead-reckons toward the current waypoint by moveSpeed * dt', () => {
        const { internals } = makeController('ground');
        internals.navigationComp = makeNavStub([new THREE.Vector3(10, 0, 0)]);
        // Accumulate 0.5 s and grant an AI tick; skip the anim tick so the
        // animation controller (absent on this bare instance) never runs.
        internals.lodComp.beginFrame(0.5, { ...ALWAYS_FULL_LOD_STATE, tickAnim: false });
        internals.updateVirtual();
        expect(internals.character.position.x).toBeCloseTo(1); // 2 m/s * 0.5 s
        expect(internals.character.position.z).toBeCloseTo(0);
        // Faces the movement direction (+X => yaw pi/2).
        expect(internals.character.rotation.y).toBeCloseTo(Math.PI / 2);
        // No tick granted -> no movement.
        internals.lodComp.beginFrame(0.5, { ...ALWAYS_FULL_LOD_STATE, tickAi: false, tickAnim: false });
        internals.updateVirtual();
        expect(internals.character.position.x).toBeCloseTo(1);
    });

    test('free-volume COARSE extrapolates the visual (incl. Y) between AI ticks', () => {
        const { internals } = makeController('swim');
        // VIRTUAL stamp clamps to COARSE (fish never disembody). The FULL ->
        // COARSE transition resets the extrapolation baseline, so enter COARSE
        // first, then seed the measured step velocity.
        internals.lodComp.beginFrame(1 / 60, {
            ...ALWAYS_FULL_LOD_STATE, simClass: SimClass.VIRTUAL, tickAi: false, tickAnim: false,
        });
        expect(internals.lodComp.state.simClass).toBe(SimClass.COARSE);
        // Seed the measured step velocity: body moved (1, 0.5, 0) over 0.5 s.
        internals.lodComp.noteCoarseStep(0, 0, 0.2, 10, 0);
        internals.lodComp.noteCoarseStep(1, 0, 0.5, 10, 0.5);
        // Stay COARSE (no transition) with no AI tick granted this frame.
        internals.lodComp.beginFrame(1 / 60, {
            ...ALWAYS_FULL_LOD_STATE, simClass: SimClass.VIRTUAL, tickAi: false, tickAnim: false,
        });
        internals.updateLocomotion3DLod(0.1);
        expect(internals.character.position.x).toBeCloseTo(0.2);  // vx 2 * 0.1
        expect(internals.character.position.y).toBeCloseTo(0.1);  // vy 1 * 0.1
        expect(internals.character.position.z).toBeCloseTo(0);
    });

    test('isAlwaysActive: hero always; crowd only while embodied; game-code opt-out respected', () => {
        const { controller, internals } = makeController('ground');

        // Hero: always active regardless of sim class (legacy default).
        controller.setImportance('hero');
        internals.hibernationComp.setSimClass(SimClass.HIBERNATED);
        expect(controller.isAlwaysActive()).toBe(true);

        // Crowd: anchors chunks only while embodied.
        controller.setImportance('crowd');
        const matrix: Array<[SimClass, boolean]> = [
            [SimClass.FULL, true],
            [SimClass.COARSE, true],
            [SimClass.VIRTUAL, false],
            [SimClass.HIBERNATED, false],
        ];
        for (const [simClass, expected] of matrix) {
            internals.hibernationComp.setSimClass(simClass);
            expect(controller.isAlwaysActive()).toBe(expected);
        }

        // Game-code setAlwaysActive(false) wins for every tier and sim class.
        controller.setAlwaysActive(false);
        internals.hibernationComp.setSimClass(SimClass.FULL);
        expect(controller.isAlwaysActive()).toBe(false);
        controller.setImportance('hero');
        expect(controller.isAlwaysActive()).toBe(false);
    });

    test('canHibernate: idle ground crowd only; free-volume always has an active goal', () => {
        const { controller, internals } = makeController('ground');
        controller.setImportance('crowd');

        internals.navigationComp = makeNavStub([new THREE.Vector3(5, 0, 5)]);
        expect(controller.canHibernate()).toBe(false); // has a path

        internals.navigationComp = makeNavStub([]);
        expect(controller.canHibernate()).toBe(true); // idle ground crowd

        controller.setImportance('hero');
        expect(controller.canHibernate()).toBe(false); // heroes never opt in

        // Free-volume (fish/bird): hasActiveGoal is always true, so a crowd
        // fish can never scheduler-hibernate mid-water.
        const fish = makeController('swim');
        fish.controller.setImportance('crowd');
        expect(fish.controller.hasActiveGoal()).toBe(true);
        expect(fish.controller.canHibernate()).toBe(false);
    });

    test('carcasses never chunk-hibernate and dead crowd animals never anchor chunks', () => {
        const { controller, internals } = makeController('ground');
        controller.setImportance('crowd');
        internals.hibernationComp.setSimClass(SimClass.FULL);

        // Alive idle crowd: hibernatable, anchors while embodied.
        expect(controller.canHibernate()).toBe(true);
        expect(controller.isAlwaysActive()).toBe(true);

        // Dead: hibernation would hide the character group while death debris
        // stays visible frozen — must never hibernate; and a carcass must not
        // anchor its terrain chunk forever.
        internals.healthComp = { isExploded: () => false, isDead: () => true };
        expect(controller.canHibernate()).toBe(false);
        expect(controller.isAlwaysActive()).toBe(false);

        // Dead HERO still anchors (legacy always-active default is preserved).
        controller.setImportance('hero');
        expect(controller.isAlwaysActive()).toBe(true);
        expect(controller.canHibernate()).toBe(false);
    });
});
