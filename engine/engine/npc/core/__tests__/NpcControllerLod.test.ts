import * as THREE from 'three';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { NpcLodComponent } from 'engine/npc/core/NpcLodComponent.js';
import { HibernationComponent } from 'engine/character/HibernationComponent.js';
import {
    SimClass, ALWAYS_FULL_LOD_STATE,
} from 'engine/character/CharacterLodScheduler.js';

/**
 * LOD integration tests over a bare NpcController built with
 * Object.create(NpcController.prototype) (same pattern as
 * NpcController.update.test.ts) — the heavy constructor never runs, so only the
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
    isRagdolled(): boolean;
}

interface ControllerInternals {
    character: THREE.Object3D;
    moveSpeed: number;
    lodComp: NpcLodComponent;
    hibernationComp: HibernationComponent;
    healthComp: HealthStub;
    navigationComp: NavStub;
    behavior: null;
    _hasFallenOffWorld: boolean;
    _virtualNullGroundTicks: number;
    updateVirtual(): void;
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

function makeController(): { controller: NpcController; internals: ControllerInternals } {
    const controller = Object.create(NpcController.prototype) as NpcController;
    const internals = controller as unknown as ControllerInternals;
    internals.character = new THREE.Object3D();
    internals.moveSpeed = 2;
    internals.lodComp = new NpcLodComponent(NOOP_HOOKS);
    internals.hibernationComp = new HibernationComponent({
        onHibernate: () => { /* noop */ },
        onWake: () => { /* noop */ },
    });
    internals.hibernationComp.setAlwaysActive(true); // constructor default
    internals.healthComp = { isExploded: () => false, isRagdolled: () => false };
    internals.behavior = null;
    internals.navigationComp = makeNavStub([]);
    internals._hasFallenOffWorld = false;
    internals._virtualNullGroundTicks = 0;
    return { controller, internals };
}

describe('NpcController LOD integration', () => {
    test('updateVirtual dead-reckons toward the current waypoint by moveSpeed * dt', () => {
        const { internals } = makeController();
        internals.navigationComp = makeNavStub([new THREE.Vector3(10, 0, 0)]);
        // Accumulate 0.5 s and grant an AI tick; skip the anim tick so
        // poseCharacter (and its CharacterLoader dependency) never runs on this
        // bare-prototype instance.
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

    test('isAlwaysActive: hero always; crowd only while embodied; game-code opt-out respected', () => {
        const { controller, internals } = makeController();

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

    test('canHibernate: false with an active goal, true only for idle crowd NPCs', () => {
        const { controller, internals } = makeController();
        controller.setImportance('crowd');

        internals.navigationComp = makeNavStub([new THREE.Vector3(5, 0, 5)]);
        expect(controller.canHibernate()).toBe(false); // has a path

        internals.navigationComp = makeNavStub([]);
        expect(controller.canHibernate()).toBe(true); // idle crowd

        controller.setImportance('hero');
        expect(controller.canHibernate()).toBe(false); // heroes never opt in
    });

    test('corpses never chunk-hibernate and dead crowd NPCs never anchor chunks', () => {
        const { controller, internals } = makeController();
        controller.setImportance('crowd');
        internals.hibernationComp.setSimClass(SimClass.FULL);

        // Alive idle crowd: hibernatable, anchors while embodied.
        expect(controller.canHibernate()).toBe(true);
        expect(controller.isAlwaysActive()).toBe(true);

        // Dead/ragdolled: hibernation would hide the character group while
        // ragdoll limb meshes stay visible frozen — must never hibernate.
        internals.healthComp = { isExploded: () => false, isRagdolled: () => true };
        expect(controller.canHibernate()).toBe(false);
        // And a corpse must not anchor its terrain chunk forever.
        expect(controller.isAlwaysActive()).toBe(false);

        // Dead HERO still anchors (legacy always-active default is preserved).
        controller.setImportance('hero');
        expect(controller.isAlwaysActive()).toBe(true);
        expect(controller.canHibernate()).toBe(false);
    });
});
