import * as THREE from 'three';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { AnimalController } from 'engine/animal/AnimalController.js';
import { SnakeController } from 'engine/animal/SnakeController.js';
import { NavigationComponent } from 'engine/character/NavigationComponent.js';
import type { NavigationCallbacks } from 'engine/character/NavigationComponent.js';

/**
 * All three controllers navigate through a PRIVATE NavigationComponent and are
 * its only public facade. The generic agent-tuning knobs — arrival radius,
 * agent-to-agent avoidance, straight-line pathing — reached NPCs only, so a game
 * could tune an NPC's approach but not an animal's or a snake's, and could ask an
 * animal its speed but not an NPC.
 *
 * Deliberately NOT pinned here: setOrchestratedFacing (wired by
 * setMovementSystem, not a game knob) and updateNoPathApproach /
 * isNoPathApproachBlocked (an owner-driven frame hook taking an animal radius).
 */

interface NavFacade {
    setArrivalRadius(radius: number): void;
    getArrivalRadius(): number;
    setAvoidanceEnabled(enabled: boolean): void;
    isAvoidanceEnabled(): boolean;
    setStraightLinePath(enabled: boolean): void;
    isStraightLinePath(): boolean;
    getCurrentSpeed(): number;
    isFollowingPath(): boolean;
    hasReachedDestination(): boolean;
    getPath(): THREE.Vector3[];
    getCurrentWaypoint(): THREE.Vector3 | null;
    getCurrentWaypointIndex(): number;
}

const CONTROLLERS: Array<[string, object]> = [
    ['NpcController', NpcController.prototype],
    ['AnimalController', AnimalController.prototype],
    ['SnakeController', SnakeController.prototype],
];

const MOVE_SPEED = 4;

/** A real NavigationComponent plus a `this` that runs the controller's own method bodies. */
function facadeFor(proto: object): {
    nav: NavigationComponent;
    self: NavFacade;
    userData: { avoidanceDisabled?: boolean };
} {
    const userData: { avoidanceDisabled?: boolean } = {};
    const callbacks = {
        getCharacter: () => new THREE.Object3D(),
        getPhysicsBody: () => null,
        getPhysicsWorld: () => ({}),
        getEngine: () => ({}),
        getNavMesh: () => null,
        isGrounded: () => true,
        runMovementSystem: () => {},
        getAgentRadius: () => 0.5,
        getAgentPriority: () => 0,
    } as unknown as NavigationCallbacks;

    const nav = new NavigationComponent(MOVE_SPEED, callbacks);
    const privateFields = {
        navigationComp: nav,
        // setAvoidanceEnabled also flips a live userData flag so OTHER agents'
        // neighbour scans skip this body — without it the toggle is only half
        // applied, so the fixture has to carry the body and world.
        characterBody: {},
        physicsWorld: { getUserData: () => userData },
        // Animals and snakes report the speed they cached last update; NPCs read
        // it live off the component. Both routes must answer.
        currentSpeed: MOVE_SPEED,
    };
    return {
        nav,
        self: Object.create(proto, Object.getOwnPropertyDescriptors(privateFields)),
        userData,
    };
}

describe.each(CONTROLLERS)('%s navigation facade', (_name, proto) => {
    it('delegates the arrival radius through to the navigation component', () => {
        const { nav, self } = facadeFor(proto);

        self.setArrivalRadius(2.5);

        expect(nav.getArrivalRadius()).toBe(2.5);
        expect(self.getArrivalRadius()).toBe(2.5);
    });

    it('delegates agent-to-agent avoidance', () => {
        const { nav, self } = facadeFor(proto);
        expect(self.isAvoidanceEnabled()).toBe(nav.isAvoidanceEnabled());

        self.setAvoidanceEnabled(false);

        expect(nav.isAvoidanceEnabled()).toBe(false);
        expect(self.isAvoidanceEnabled()).toBe(false);
    });

    it('also tells OTHER agents to stop avoiding this one', () => {
        const { self, userData } = facadeFor(proto);

        self.setAvoidanceEnabled(false);
        expect(userData.avoidanceDisabled).toBe(true);

        self.setAvoidanceEnabled(true);
        expect(userData.avoidanceDisabled).toBe(false);
    });

    it('delegates straight-line pathing', () => {
        const { nav, self } = facadeFor(proto);

        self.setStraightLinePath(true);

        expect(nav.isStraightLinePath()).toBe(true);
        expect(self.isStraightLinePath()).toBe(true);
    });

    it('reports the current speed', () => {
        const { self } = facadeFor(proto);

        expect(self.getCurrentSpeed()).toBe(MOVE_SPEED);
    });

    it('reports no route before one is planned', () => {
        const { self } = facadeFor(proto);

        expect(self.isFollowingPath()).toBe(false);
        expect(self.hasReachedDestination()).toBe(true);
        expect(self.getPath()).toEqual([]);
        expect(self.getCurrentWaypoint()).toBeNull();
    });

    it('hands out the planned route', () => {
        const { nav, self } = facadeFor(proto);
        const target = new THREE.Vector3(3, 0, 4);
        // Straight-line mode plans a single-waypoint path with no navmesh, which
        // is the only route that exists in a unit test.
        self.setStraightLinePath(true);
        nav.setTargetPosition(target);

        expect(self.isFollowingPath()).toBe(true);
        expect(self.hasReachedDestination()).toBe(false);
        expect(self.getPath()).toHaveLength(1);
        expect(self.getPath()[0].equals(target)).toBe(true);
        expect(self.getCurrentWaypointIndex()).toBe(0);
        expect(self.getCurrentWaypoint()?.equals(target)).toBe(true);
    });
});
