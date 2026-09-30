/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PlayerLoader } from 'engine/loaders/PlayerLoader.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { IPlayerAttack } from 'engine/IPlayerAttack.js';
import type { EngineLike } from 'types/game.js';
import { installRangedWeapon } from 'engine/RangedWeaponSystem.js';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { createPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { RangedWeaponType } from 'engine/RangedWeaponRegistry.js';

/**
 * `installRangedWeapon` is the one-step install: the three things that were
 * missing from the "type-clean code but no visible weapon, no projectile and no
 * ammo HUD" report must ALL be true after a single call — whether it happens
 * before or after the character is ready — and a free-mouse (no pointer lock)
 * cursor game must actually fire toward the pointer.
 *
 * The fake host mirrors the real PlayerController seams the install touches:
 * setAttackSystem (which owns setController/setupEventListeners/setMobileControls),
 * onCharacterReady, and the action-handler registration.
 */

const CANVAS_RECT = { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 };

class FakeHud {
	counters = new Map<string, { value: number; format?: (v: number) => string }>();

	createCounter(id: string, opts: { initialValue?: number; format?: (v: number) => string }): void {
		this.counters.set(id, { value: opts.initialValue ?? 0, format: opts.format });
	}
	updateCounter(id: string, value: number): void {
		const counter = this.counters.get(id);
		if (counter) counter.value = value;
	}
	removeElement(id: string): void {
		this.counters.delete(id);
	}
	showControlsTemporarily(): void {}
	showReticle(): void {}
	hideReticle(): void {}
	setReticleOffset(): void {}
	setReticleBlocked(): void {}

	/** What the player actually reads in the corner, or null when there is no counter. */
	text(id: string): string | null {
		const counter = this.counters.get(id);
		if (!counter) return null;
		return counter.format ? counter.format(counter.value) : String(counter.value);
	}
}

class FakeController {
	player = new THREE.Object3D();
	// Null physics world: Projectile skips its rigid body (getRapier() is not
	// initialized under Jest) but is otherwise fully constructed, so a shot is
	// still observable.
	physicsWorld = null as unknown as PhysicsWorld;
	engine: EngineLike;
	playerLoader: PlayerLoader | null;
	animationController = null;
	hud = new FakeHud();
	mobileControls = {};
	threeCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

	attackSystem: IPlayerAttack | null = null;
	actionRegistrations: { actionType: string | null; continuous: boolean }[] = [];
	actionHandler: (() => void) | null = null;
	secondaryActionType: string | null = null;
	rotationCalls: number[] = [];

	private readyCallbacks: (() => void)[] = [];
	private characterReady = false;
	private cameraMode: 'top-down' | 'third-person' = 'top-down';

	constructor(withPlayerLoader = true, sideOn: PhysicsWorld | null = null) {
		const canvas = document.createElement('canvas');
		canvas.getBoundingClientRect = () => CANVAS_RECT as DOMRect;
		this.engine = { scene: new THREE.Scene(), renderer: { domElement: canvas } } as unknown as EngineLike;
		this.playerLoader = withPlayerLoader ? makePlayerLoader() : null;

		if (sideOn) {
			// Sidescroller rig: the camera looks along -Z at the X/Y plane.
			this.physicsWorld = sideOn;
			this.cameraMode = 'third-person';
			this.threeCamera.position.set(0, 2, 20);
			this.threeCamera.lookAt(0, 2, 0);
			this.threeCamera.updateMatrixWorld(true);
			return;
		}
		// Classic top-down rig: overhead camera, world -Z is screen up.
		this.threeCamera.up.set(0, 0, -1);
		this.threeCamera.position.set(0, 20, 0);
		this.threeCamera.lookAt(0, 0, 0);
		this.threeCamera.updateMatrixWorld(true);
	}

	setAttackSystem(attackSystem: IPlayerAttack | null): void {
		if (this.attackSystem) {
			this.attackSystem.removeEventListeners();
			this.attackSystem.dispose();
		}
		this.attackSystem = attackSystem;
		if (attackSystem) {
			attackSystem.setController(this.asController());
			attackSystem.setupEventListeners();
			attackSystem.setMobileControls(this.mobileControls);
		}
	}
	getAttackSystem(): IPlayerAttack | null {
		return this.attackSystem;
	}

	onCharacterReady(callback: () => void): void {
		if (this.characterReady) callback();
		else this.readyCallbacks.push(callback);
	}
	fireCharacterReady(): void {
		this.characterReady = true;
		for (const callback of this.readyCallbacks) callback();
		this.readyCallbacks = [];
	}

	setActionHandler(actionType: string | null, handler: (() => void) | null, options?: { continuous?: boolean }): void {
		this.actionRegistrations.push({ actionType, continuous: options?.continuous === true });
		this.actionHandler = handler;
	}
	setSecondaryActionHandler(actionType: string | null): void {
		this.secondaryActionType = actionType;
	}

	getCameraController(): unknown {
		return { getMode: () => this.cameraMode, getCamera: () => this.threeCamera };
	}
	getMovementSystem(): { setRotation: (yaw: number) => void } {
		return { setRotation: (yaw: number) => this.rotationCalls.push(yaw) };
	}
	getInputLabel(): string {
		return 'R';
	}

	asController(): PlayerController {
		return this as unknown as PlayerController;
	}
}

function makePlayerLoader(): PlayerLoader {
	return {
		// Headless: no block character to wait for, so equip runs immediately.
		isRenderingSkinnedMesh: () => false,
		isHeadlessPlayer: () => true,
		getBlockCharacterRenderer: () => null,
		getSkinnedSkeletonRoot: () => null,
		getCapsuleHeight: () => 1.75,
		setSkinnedArmGrip: () => {},
		clearSkinnedArmGrip: () => {},
	} as unknown as PlayerLoader;
}

/** The private seams the free-mouse cursor path runs through. */
interface CursorInternals {
	cursorClientX: number | null;
	cursorClientY: number | null;
	cursorGroundPointThisFrame: THREE.Vector3 | null;
	getCursorGroundPoint(): THREE.Vector3 | null;
	shootableComponent: { lastShotTime: number } | null;
}

/**
 * Open the weapon's rate-limit window. `ShootableComponent.lastShotTime` starts
 * at 0 and is measured against `performance.now()`, whose origin is process
 * start — in a warm jest worker the first trigger pull can land while
 * `performance.now()` is still inside the first cooldown and silently spawn
 * nothing. Irrelevant in a browser (pages live long past the first 333 ms),
 * decisive here.
 */
function openFireCooldown(internals: CursorInternals): void {
	if (internals.shootableComponent) internals.shootableComponent.lastShotTime = -Infinity;
}

function moveMouseTo(clientX: number, clientY: number): void {
	window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY }));
}

describe('installRangedWeapon', () => {
    it.each(Object.values(RangedWeaponType).flatMap(id => [id, `${id}_lowpoly`]))('%s installs, fires and switches back from the styled registry', id => {
        const clock = jest.spyOn(performance, 'now').mockReturnValue(10_000);
        const controller = new FakeController();
        controller.fireCharacterReady();
        const weapon = installRangedWeapon(controller.asController(), id, { aim: 'cursor' });
        try {
            expect(weapon.isEquipped()).toBe(true);
            expect(controller.player.getObjectByName(`Weapon_${id}`)).toBeDefined();
            moveMouseTo(100, 20);
            const internals = weapon.system as unknown as CursorInternals;
            internals.cursorGroundPointThisFrame = internals.getCursorGroundPoint();
            openFireCooldown(internals);
            controller.actionHandler!();
            const projectiles = weapon.system.getProjectiles();
            expect(projectiles.length).toBeGreaterThan(0);
            for (const shot of projectiles) {
                expect(shot.getPosition().toArray().every(Number.isFinite)).toBe(true);
                expect(shot.getDirection().z).toBeLessThan(-0.5);
            }
            weapon.switchWeapon(id.endsWith('_lowpoly') ? 'pistol' : 'pistol_lowpoly');
            expect(weapon.isEquipped()).toBe(true);
            expect(controller.player.getObjectByName(`Weapon_${id}`)).toBeUndefined();
        } finally { controller.setAttackSystem(null); clock.mockRestore(); }
    });

	it('installs everything when called BEFORE the character is ready', () => {
		const controller = new FakeController();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		// Nothing to equip onto yet — but the system is already the attack system.
		expect(weapon.isEquipped()).toBe(false);
		expect(controller.getAttackSystem()).toBe(weapon.system);

		controller.fireCharacterReady();

		expect(weapon.isEquipped()).toBe(true);
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeDefined();
		expect(controller.actionRegistrations).toContainEqual({ actionType: 'shoot', continuous: true });
		expect(controller.hud.text('ammo')).toBe('12/12');
	});

	it('fireRate is the cadence knob and survives a weapon switch', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();

		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor', fireRate: 14 });
		const cadence = (): number => (weapon.system as unknown as { shootableComponent: { fireRate: number } }).shootableComponent.fireRate;
		expect(cadence()).toBe(14); // pistol preset is 3/s

		weapon.switchWeapon('assault_rifle');
		expect(cadence()).toBe(14); // re-equip must not fall back to the preset's 8/s

		weapon.system.setFireRate(null);
		expect(cadence()).toBe(8); // null restores the preset cadence

		// The one-shot gate is NOT cadence: it blocks every shot until the delay passes, then is inert.
		weapon.system.suppressFireFor(60_000);
		weapon.system.triggerShoot();
		expect(controller.hud.text('ammo')).toBe('30/30');
	});

	it('installs everything when called AFTER the character is ready', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();

		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		expect(weapon.isEquipped()).toBe(true);
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeDefined();
		expect(controller.actionRegistrations).toContainEqual({ actionType: 'shoot', continuous: true });
		expect(controller.hud.text('ammo')).toBe('12/12');
	});

	it('applies the ammo options to the HUD counter', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();

		installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor', magazineSize: 6 });

		expect(controller.hud.text('ammo')).toBe('6/6');
	});

	it('showAmmoCounter: false keeps the HUD clean', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();

		installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor', showAmmoCounter: false });

		expect(controller.hud.text('ammo')).toBeNull();
	});

	it('a switchWeapon before readiness equips only the final weapon, once', () => {
		const controller = new FakeController();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		weapon.switchWeapon('assault_rifle');
		expect(weapon.getWeaponType()).toBe('assault_rifle');
		expect(weapon.isEquipped()).toBe(false);

		controller.fireCharacterReady();

		expect(controller.player.getObjectByName('Weapon_assault_rifle')).toBeDefined();
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeUndefined();
	});

	it('switchWeapon after readiness swaps in place', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		weapon.switchWeapon('assault_rifle');

		expect(controller.player.getObjectByName('Weapon_assault_rifle')).toBeDefined();
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeUndefined();
	});

	it('remove() detaches the weapon, the shoot action and the ammo counter', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		weapon.remove();

		expect(weapon.isEquipped()).toBe(false);
		expect(controller.getAttackSystem()).toBeNull();
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeUndefined();
		expect(controller.hud.text('ammo')).toBeNull();
		expect(controller.actionRegistrations[controller.actionRegistrations.length - 1])
			.toEqual({ actionType: null, continuous: false });
		// A second call is a no-op, not a double dispose.
		expect(() => weapon.remove()).not.toThrow();
	});

	it('a late readiness callback does not resurrect a removed install', () => {
		const controller = new FakeController();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });

		weapon.remove();
		controller.fireCharacterReady();

		expect(weapon.isEquipped()).toBe(false);
		expect(controller.player.getObjectByName('Weapon_pistol')).toBeUndefined();
	});

	it('reports the missing player loader instead of failing silently', () => {
		const controller = new FakeController(false);
		const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });
		controller.fireCharacterReady();

		expect(weapon.isEquipped()).toBe(false);
		expect(errors).toHaveBeenCalledWith(expect.stringContaining('installRangedWeapon'));
		errors.mockRestore();
	});

	it('free-mouse cursor fire: the shoot action sends a projectile toward the pointer', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', {
			aim: 'cursor',
			showAmmoCounter: true,
		});
		const internals = weapon.system as unknown as CursorInternals;

		// No pointer lock anywhere: the free mouse moves and the install's own
		// listener (wired by setAttackSystem) records it.
		moveMouseTo(180, 100);
		expect(internals.cursorClientX).toBe(180);
		expect(internals.cursorClientY).toBe(100);

		// …which the camera projects onto the ground plane under the pointer.
		const groundPoint = internals.getCursorGroundPoint();
		expect(groundPoint).not.toBeNull();
		const horizontalDistance = Math.hypot(groundPoint!.x, groundPoint!.z);
		expect(horizontalDistance).toBeGreaterThan(1);
		internals.cursorGroundPointThisFrame = groundPoint;

		// Pull the trigger through the handler the install registered.
		openFireCooldown(internals);
		expect(controller.actionHandler).not.toBeNull();
		controller.actionHandler!();

		// The character turned to the pointer…
		const expectedYaw = Math.atan2(groundPoint!.x, groundPoint!.z);
		expect(controller.rotationCalls).toEqual([expectedYaw]);
		expect(controller.player.rotation.y).toBeCloseTo(expectedYaw, 10);

		// …a projectile left the muzzle toward it. Top-down shots fly at muzzle
		// height rather than dipping into the ground, so the expected direction
		// is the cursor's XZ at the spawn's own Y.
		const projectiles = weapon.system.getProjectiles();
		expect(projectiles).toHaveLength(1);
		const spawn = projectiles[0].getPosition();
		const wanted = new THREE.Vector3(groundPoint!.x, spawn.y, groundPoint!.z).sub(spawn).normalize();
		expect(projectiles[0].getDirection().dot(wanted)).toBeGreaterThan(0.999);

		// …and the ammo HUD counted it down.
		expect(weapon.system.getCurrentAmmo()).toBe(11);
		expect(controller.hud.text('ammo')).toBe('11/12');
	});

	it('a second mouse position moves the cursor ground point with it', () => {
		const controller = new FakeController();
		controller.fireCharacterReady();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'cursor' });
		const internals = weapon.system as unknown as CursorInternals;

		moveMouseTo(180, 100);
		const right = internals.getCursorGroundPoint();
		moveMouseTo(20, 100);
		const left = internals.getCursorGroundPoint();

		expect(right).not.toBeNull();
		expect(left).not.toBeNull();
		expect(right!.distanceTo(left!)).toBeGreaterThan(1);
	});
});

/**
 * The side-on (2D) lane. A sidescroller's camera looks along -Z, so the two 3D
 * aim regimes both point out of the gameplay plane — camera aim down the view
 * axis, cursor aim onto a horizontal plane the side view barely meets. A shot
 * aimed there cannot travel at all (the lane projects the off-plane component
 * away), which is what "the bullets just hang in the air" looks like.
 */
describe('installRangedWeapon on the side-on 2D lane', () => {
	let world2D: PhysicsWorld2D;
	let facade: PhysicsWorld;

	beforeAll(async () => { await initRapier2D(); });
	beforeEach(() => {
		world2D = new PhysicsWorld2D({ x: 0, y: -30 });
		facade = createPlaneLockedPhysics(world2D, 0) as unknown as PhysicsWorld;
	});

	it('aims at the cursor IN the plane, and the shot flies there', () => {
		const controller = new FakeController(true, facade);
		controller.fireCharacterReady();
		// 'camera' is what a sidescroller resolves to by default; the lane overrides it.
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'camera' });
		const internals = weapon.system as unknown as CursorInternals & { effectiveAimMode: string };
		expect(internals.effectiveAimMode).toBe('cursor');

		// Cursor high and to the right: an up-forward shot.
		moveMouseTo(180, 40);
		weapon.system.update(1 / 60);
		// The top-down cursor drivers stay out of it — facing is the movement's job side-on.
		expect(internals.cursorGroundPointThisFrame).toBeNull();
		expect(controller.rotationCalls).toEqual([]);

		openFireCooldown(internals);
		controller.actionHandler!();

		const projectiles = weapon.system.getProjectiles();
		expect(projectiles).toHaveLength(1);
		const shot = projectiles[0]!;
		const dir = shot.getDirection();
		expect(Math.abs(dir.z)).toBeLessThan(1e-6);   // nothing points out of the plane
		expect(dir.x).toBeGreaterThan(0.5);           // to the right
		expect(dir.y).toBeGreaterThan(0.05);          // and upward, at the cursor

		// It has a real 2D body and it moves along the plane.
		expect(shot.getRigidBody()).not.toBeNull();
		const from = shot.getPosition().clone();
		for (let i = 0; i < 10; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
		const to = shot.getPosition();
		expect(to.x - from.x).toBeGreaterThan(1);
		expect(to.z).toBe(0);
	});

	it('with no cursor yet, the shot follows the barrel instead of stalling', () => {
		const controller = new FakeController(true, facade);
		// Facing +X, the way a sidescroller's movement turns the character
		// (+Z gameplay forward, so yaw pi/2 points the barrel along +X).
		controller.player.rotation.y = Math.PI / 2;
		controller.fireCharacterReady();
		const weapon = installRangedWeapon(controller.asController(), 'pistol', { aim: 'camera' });
		const internals = weapon.system as unknown as CursorInternals;
		internals.cursorClientX = null;
		internals.cursorClientY = null;

		openFireCooldown(internals);
		controller.actionHandler!();

		const shot = weapon.system.getProjectiles()[0]!;
		expect(shot.getRigidBody()).not.toBeNull();
		const from = shot.getPosition().clone();
		for (let i = 0; i < 10; i++) world2D.step(1 / 60);
		expect(shot.getPosition().distanceTo(from)).toBeGreaterThan(1);
	});
});
