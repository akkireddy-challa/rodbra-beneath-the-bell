/**
 * Driver pickup probe routing in the InteractionManager.
 *
 * The probe is the PLAYER-group stand-in for the capsule that vehicle entry
 * disables (see engine/DriverPickupProbe.ts). These tests drive the manager's
 * sensor-event entry points directly with collider handles — no Rapier world is
 * needed, since the manager only ever deals in handles.
 */
import * as THREE from 'three';
import { getInteractionManager, resetInteractionManager } from 'engine/InteractionManager.js';
import type { CollectibleComponent } from 'engine/CollectibleComponent.js';
import type { InteractableComponent } from 'engine/InteractableComponent.js';
import type { Interactable } from 'types/interactable.js';

const COLLECTIBLE_SENSOR = 10;
const INTERACTABLE_SENSOR = 11;
const CAPSULE = 20;
const PROBE = 21;

function stubCollectible(onCollect: jest.Mock): CollectibleComponent {
	const object3D = new THREE.Object3D();
	let disposed = false;
	return {
		getCollectible: () => ({ onCollect }),
		getObject3D: () => object3D,
		isDisposed: () => disposed,
		dispose: () => { disposed = true; },
	} as unknown as CollectibleComponent;
}

function stubInteractable(): InteractableComponent {
	const object3D = new THREE.Object3D();
	const interactable = { interact: jest.fn() } as unknown as Interactable;
	return {
		getInteractable: () => interactable,
		getObject3D: () => object3D,
		isDisposed: () => false,
	} as unknown as InteractableComponent;
}

describe('InteractionManager — driver pickup probe', () => {
	afterEach(() => resetInteractionManager());

	it('collects a collectible when the probe (not the capsule) enters the sensor', () => {
		const manager = getInteractionManager();
		const onCollect = jest.fn();
		manager.registerCollectible(COLLECTIBLE_SENSOR, stubCollectible(onCollect), {
			objectId: 'coin_1',
			name: 'Coin',
		});
		manager.registerPickupProbe(PROBE);

		manager.onIntersectionStart(COLLECTIBLE_SENSOR, PROBE);

		expect(onCollect).toHaveBeenCalledTimes(1);
	});

	it('notifies collection listeners for a probe pickup', () => {
		const manager = getInteractionManager();
		const listener = jest.fn();
		manager.onCollected(listener);
		manager.registerCollectible(COLLECTIBLE_SENSOR, stubCollectible(jest.fn()), {
			objectId: 'coin_1',
			name: 'Coin',
		});
		manager.registerPickupProbe(PROBE);

		manager.onIntersectionStart(PROBE, COLLECTIBLE_SENSOR);

		expect(listener).toHaveBeenCalledWith('coin_1', 'Coin', expect.anything());
	});

	it('does not open E-key interactable prompts from the driver seat', () => {
		const manager = getInteractionManager();
		manager.register(INTERACTABLE_SENSOR, stubInteractable());
		manager.registerPickupProbe(PROBE);

		manager.onIntersectionStart(INTERACTABLE_SENSOR, PROBE);

		expect(manager.getNearestInteractable(new THREE.Vector3())).toBeNull();
	});

	it('still opens E-key prompts for the on-foot player capsule', () => {
		const manager = getInteractionManager();
		manager.register(INTERACTABLE_SENSOR, stubInteractable());
		manager.registerPickupProbe(PROBE);

		manager.onIntersectionStart(INTERACTABLE_SENSOR, CAPSULE);

		expect(manager.getNearestInteractable(new THREE.Vector3())).not.toBeNull();
	});

	it('stops collecting once the probe is unregistered (player left the vehicle)', () => {
		const manager = getInteractionManager();
		manager.registerPickupProbe(PROBE);
		manager.unregisterPickupProbe(PROBE);

		manager.register(INTERACTABLE_SENSOR, stubInteractable());
		manager.onIntersectionStart(INTERACTABLE_SENSOR, PROBE);

		// With the probe gone the handle is just another PLAYER-group collider,
		// so the overlap is tracked normally again.
		expect(manager.getNearestInteractable(new THREE.Vector3())).not.toBeNull();
	});
});
