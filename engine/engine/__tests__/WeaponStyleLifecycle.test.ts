/** @jest-environment jsdom */
import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import { FirstPersonMeleeSystem, DEFAULT_FIRST_PERSON_MELEE_OPTIONS } from 'engine/FirstPersonMeleeSystem.js';
import { FirstPersonWeaponSystem, DEFAULT_FIRST_PERSON_WEAPON_OPTIONS } from 'engine/FirstPersonWeaponSystem.js';
import { ViewModelLayer } from 'engine/ViewModelLayer.js';
import { WeaponType } from 'engine/WeaponRegistry.js';
import { RangedWeaponType } from 'engine/RangedWeaponRegistry.js';
import { WeaponPickup, WeaponCategory } from 'engine/WeaponPickup.js';
import { setMaterialQuality, clearMaterialQuality } from 'engine/MaterialQuality.js';
import { GameState, getGameStateManager, resetGameStateManager } from 'engine/GameStateManager.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { createPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

const meleeIds = Object.values(WeaponType).flatMap(id => [id, `${id}_lowpoly`]);
const rangedIds = Object.values(RangedWeaponType).flatMap(id => [id, `${id}_lowpoly`]);

/** Observe actual ownership: every resource in the retiring weapon must be released once. */
function watchDisposal(root: THREE.Object3D): () => void {
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    root.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        resources.add(child.geometry);
        (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => resources.add(m));
    });
    const disposed = [...resources].map(resource => jest.spyOn(resource, 'dispose'));
    expect(disposed.length).toBeGreaterThan(0);
    return () => disposed.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
}

function viewModelHost(): { engine: EngineLike; layer: ViewModelLayer; controller: PlayerController } {
    const layer = new ViewModelLayer();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.position.set(4, 1.7, 5);
    camera.rotation.y = 0.7;
    camera.updateMatrixWorld(true);
    const engine = { scene: new THREE.Scene(), camera, getViewModelLayer: () => layer } as unknown as EngineLike;
    const controller = {
        player: new THREE.Object3D(), isGrounded: true,
        getCameraController: () => ({ getCamera: () => camera }),
    } as unknown as PlayerController;
    return { engine, layer, controller };
}

function assertViewModel(root: THREE.Object3D): void {
    let count = 0;
    root.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        count++;
        expect(child.frustumCulled).toBe(false);
        expect(child.userData.isVisualOnly).toBe(true);
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
            expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
        }
    });
    expect(count).toBeGreaterThan(0);
    root.updateMatrixWorld(true);
    expect(root.matrixWorld.elements.every(Number.isFinite)).toBe(true);
}

beforeAll(async () => { await initRapier(); await initRapier2D(); });
beforeEach(() => {
    setMaterialQuality('high');
    getGameStateManager().setState(GameState.PLAYING);
});
afterEach(() => { clearMaterialQuality(); resetGameStateManager(); jest.restoreAllMocks(); });

describe('weapon styles in the real first-person systems', () => {
    it('formats ammunition from the currently equipped magazine after a style/archetype swap', () => {
        const { engine, layer, controller } = viewModelHost();
        let format = (value: number): string => String(value);
        let value = 0;
        Object.assign(controller, { hud: {
            createCounter: (_id: string, options: { format: (value: number) => string }) => { format = options.format; },
            updateCounter: (_id: string, next: number) => { value = next; },
            removeElement: () => {}, showReticle: () => {},
        } });
        const world = new PhysicsWorld();
        const system = new FirstPersonWeaponSystem(engine, world, {
            ...DEFAULT_FIRST_PERSON_WEAPON_OPTIONS, muzzleFlash: null, shellEjection: null,
        });
        system.setController(controller);
        try {
            system.equipWeapon('pistol');
            expect(format(value)).toBe('12/12');
            system.equipWeapon('assault_rifle_lowpoly');
            expect(format(value)).toBe('30/30');
            system.getMagazine()!.tryConsume();
            system.reload();
            expect(format(value)).toContain('30 RELOADING');
            system.equipWeapon('bazooka');
            expect(format(value)).toBe('1/1');
        } finally { system.dispose(); layer.dispose(); world.dispose(); }
    });

    it('keeps the weapon grip in frame when the view-model viewport becomes portrait', () => {
        const layer = new ViewModelLayer();
        const size = new THREE.Vector2(390, 844);
        const renderer = { autoClear: true, clearDepth: () => {}, render: () => {},
            getDrawingBufferSize: (out: THREE.Vector2) => out.copy(size) };
        try {
            layer.syncProjection(renderer);
            // Authored ranged hip pose, in camera space. A narrow vertical-FOV
            // frustum used to put even the centre of the grip off the right edge.
            const grip = new THREE.Vector3(0.17, -0.17, -0.30).project(layer.camera);
            expect(Math.abs(grip.x)).toBeLessThan(1);
            expect(Math.abs(grip.y)).toBeLessThan(1);
            layer.setFovOffset(3.96);
            expect(Math.abs(new THREE.Vector3(0.17, -0.17, -0.30).project(layer.camera).x)).toBeLessThan(1.1);
            size.set(1280, 720);
            layer.syncProjection(renderer);
            layer.setFovOffset(0);
            expect(layer.camera.fov).toBe(60);
            expect(layer.camera.aspect).toBeCloseTo(16 / 9);
        } finally { layer.dispose(); }
    });

    it.each(meleeIds)('%s stays legible, swings and releases resources when swapped', id => {
        const { engine, layer } = viewModelHost();
        const system = new FirstPersonMeleeSystem(engine, { ...DEFAULT_FIRST_PERSON_MELEE_OPTIONS, weaponType: id });
        try {
            const root = layer.scene.getObjectByName('FirstPersonMeleeViewModel')!;
            const weapon = root.children[0]!;
            assertViewModel(weapon);
            const verifyDisposed = watchDisposal(weapon);
            system.update(1 / 60);
            for (let swing = 0; swing < 3; swing++) {
                const rest = weapon.quaternion.clone();
                system.triggerSwing();
                for (let frame = 0; frame < 6; frame++) system.update(1 / 60);
                expect(weapon.quaternion.angleTo(rest)).toBeGreaterThan(0.05);
                for (let frame = 0; frame < 30; frame++) system.update(1 / 60);
            }
            system.equipWeapon(id.endsWith('_lowpoly') ? 'sword' : 'sword_lowpoly');
            verifyDisposed();
            expect(weapon.parent).toBeNull();
            expect(root.children).toHaveLength(1);
        } finally { system.dispose(); layer.dispose(); }
        expect(layer.hasContent()).toBe(false);
        expect(system.update(1 / 60)).toBe(false);
    });

    it.each(rangedIds)('%s fires from its visible muzzle, reloads, swaps and cleans up', id => {
        const { engine, layer, controller } = viewModelHost();
        const world = new PhysicsWorld();
        const now = jest.spyOn(performance, 'now').mockReturnValue(10_000);
        const system = new FirstPersonWeaponSystem(engine, world, {
            ...DEFAULT_FIRST_PERSON_WEAPON_OPTIONS, weaponType: id, muzzleFlash: null, shellEjection: null,
        });
        system.setController(controller);
        try {
            const weapon = layer.scene.getObjectByName(`FirstPersonWeapon_${id}`)!;
            const verifyDisposed = watchDisposal(weapon);
            assertViewModel(weapon);
            const preset = system.getWeaponPreset()!;
            const magazine = system.getMagazine()!;
            system.update(1 / 60);
            layer.scene.updateMatrixWorld(true);
            const expectedMuzzle = preset.muzzleOffset.clone().applyMatrix4(weapon.matrixWorld).applyMatrix4(engine.camera.matrixWorld);
            system.triggerShoot();
            expect(system.getProjectiles()).toHaveLength(preset.pelletCount ?? 1);
            expect(magazine.getCurrentAmmo()).toBe(magazine.getMagazineSize() - 1);
            for (const projectile of system.getProjectiles()) {
                expect(projectile.getPosition().distanceTo(expectedMuzzle)).toBeLessThan(1e-5);
            }
            world.step(1 / 60);
            system.update(1 / 60);
            for (const projectile of system.getProjectiles()) {
                expect(projectile.getPosition().distanceTo(expectedMuzzle)).toBeGreaterThan(0.01);
            }
            system.setAimDownSights(true);
            for (let frame = 0; frame < 30; frame++) system.update(1 / 60);
            expect(layer.camera.fov).toBeLessThan(60);
            system.reload();
            expect(magazine.getIsReloading()).toBe(true);
            now.mockReturnValue(20_000);
            system.update(1 / 60);
            expect(magazine.getCurrentAmmo()).toBe(magazine.getMagazineSize());
            for (const projectile of [...system.getProjectiles()]) system.removeProjectile(projectile);
            world.step(1 / 60); // PhysicsWorld queues body removal until the next safe step.
            expect(world.getRapierWorld().bodies.len()).toBe(0);
            system.equipWeapon(id.endsWith('_lowpoly') ? 'pistol' : 'pistol_lowpoly');
            verifyDisposed();
            expect(weapon.parent).toBeNull();
        } finally { system.dispose(); layer.dispose(); world.dispose(); }
        expect(layer.hasContent()).toBe(false);
        expect(system.getProjectiles()).toHaveLength(0);
    });
});

describe.each(['3d', '2d'] as const)('%s weapon pickups', lane => {
    it.each([
        ...meleeIds.map(id => [WeaponCategory.MELEE, id] as const),
        ...rangedIds.map(id => [WeaponCategory.RANGED, id] as const),
    ])('%s %s preserves the style and can be collected exactly once', (category, id) => {
        const world2d = lane === '2d' ? new PhysicsWorld2D() : null;
        const world = world2d ? createPlaneLockedPhysics(world2d, 0) as unknown as PhysicsWorld : new PhysicsWorld();
        const engine = { scene: new THREE.Scene() } as unknown as EngineLike;
        const pickup = new WeaponPickup(engine, world, category, id, new THREE.Vector3(2, 0, 3));
        try {
            const root = engine.scene.getObjectByName(`WeaponPickup_${id}`)!;
            const verifyDisposed = watchDisposal(root);
            const callback = jest.fn();
            pickup.setOnPickupCallback(callback);
            expect(pickup.getWeaponType()).toBe(id);
            expect(pickup.getWeaponMeshClone()!.userData.weaponVisualStyle).toBe(id.endsWith('_lowpoly') ? 'lowpoly' : 'block');
            const initialY = pickup.getPosition().y;
            pickup.update(0.25);
            expect(pickup.getPosition().y).not.toBe(initialY);
            expect(pickup.onInteractStart()).toBe(true);
            expect(pickup.onInteractStart()).toBe(false);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(pickup.isCollected()).toBe(true);
            expect(pickup.interactionEnabled()).toBe(false);
            expect(root.parent).toBeNull();
            pickup.dispose();
            verifyDisposed();
            (world2d ?? world).step(1 / 60);
            expect(engine.scene.children).toHaveLength(0);
            expect((world2d ?? world).getRapierWorld().bodies.len()).toBe(0);
            expect((world2d ?? world).getRapierWorld().colliders.len()).toBe(0);
        } finally { if (world2d) world2d.dispose(); else world.dispose(); }
    });
});
